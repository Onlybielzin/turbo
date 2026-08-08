// Turbo — Phase 4: PTY bridge + embedded MCP server (rmcp Streamable HTTP).
//
// PtyManager is now Arc<PtyManager> so the MCP handler and Tauri commands share
// the same instance. The MCP server starts as a tokio task before any group is
// created; `.mcp.json` is written ONLY after the health-check (D-02 contract).

mod agent;
mod artifacts;
mod groups;
mod mcp;
mod platform;
mod usage;
mod worktrees;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use agent::AgentBackend;
use groups::GroupRegistry;
use mcp::McpState;

/// Command + args the frontend should spawn for a group's interactive parent
/// terminal. Computed server-side from the chosen backend so the frontend never
/// duplicates the CLI/flag logic.
#[derive(serde::Serialize)]
pub struct ParentSpawn {
    command: String,
    args: Vec<String>,
}

// ─── PTY layer ────────────────────────────────────────────────────────────────

/// Payload for the `child_output` event: a chunk of a spawned child agent's PTY
/// output, streamed live to the canvas so the subagent is visible working. Keyed
/// by `pty_id` so each child node renders only its own stream.
#[derive(Clone, serde::Serialize)]
struct ChildOutput {
    pty_id: u32,
    data: String,
}

/// One live PTY: the write side, the master (for resize) and a killer handle.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Accumulates all PTY output for MCP spawn_agent return path.
    #[allow(dead_code)]
    stdout_buf: Arc<Mutex<Vec<u8>>>,
    /// Timestamp of the last byte read from this PTY. Used by `send_message` to
    /// deliver a message only when the target agent is idle (no recent output),
    /// so it isn't clobbered mid-generation.
    last_activity: Arc<Mutex<Instant>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
    /// Write UTF-8 bytes to a live PTY's stdin (used by the MCP `send_message`
    /// tool to deliver a message into another agent's terminal). Returns an error
    /// string if the pty id is unknown or the write fails.
    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut map = self.sessions.lock().map_err(|_| "pty lock poisoned")?;
        let session = map.get_mut(&id).ok_or("pty not found")?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Spawn a child agent in a real PTY registered in this manager, streaming its
    /// output live to the canvas via the `child_output` event (so the subagent is
    /// visible working) while ALSO accumulating every byte into a buffer that the
    /// MCP `spawn_agent` tool returns to the parent when the child exits.
    ///
    /// Returns `(pty_id, stdout_buf, exit_rx)`. `exit_rx` resolves when the child
    /// closes its PTY (EOF), letting the async caller await completion without
    /// blocking. The session stays in the table (writable by `send_message`) until
    /// explicitly killed.
    pub fn spawn_child_streaming(
        &self,
        app: AppHandle,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        extra_env: Vec<(String, String)>,
    ) -> Result<(u32, Arc<Mutex<Vec<u8>>>, tokio::sync::oneshot::Receiver<()>), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let (program, prefix_args) = platform::resolve_command(&command);
        let mut cmd = CommandBuilder::new(program);
        for a in prefix_args {
            cmd.arg(a);
        }
        cmd.args(&args);
        if let Some(dir) = &cwd {
            cmd.cwd(dir);
        }
        // Fresh top-level session: drop inherited Claude Code env (see pty_spawn).
        for (k, _) in std::env::vars() {
            if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
                cmd.env_remove(&k);
            }
        }
        cmd.env("TERM", "xterm-256color");
        platform::sanitize_appimage_env(&mut cmd);
        for (k, v) in &extra_env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let master = pair.master;
        let killer = child.clone_killer();
        let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let stdout_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let stdout_buf_reader = Arc::clone(&stdout_buf);
        let last_activity: Arc<Mutex<Instant>> = Arc::new(Mutex::new(Instant::now()));
        let last_activity_reader = Arc::clone(&last_activity);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<()>();

        let app_reader = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if let Ok(mut acc) = stdout_buf_reader.lock() {
                            acc.extend_from_slice(chunk);
                        }
                        if let Ok(mut la) = last_activity_reader.lock() {
                            *la = Instant::now();
                        }
                        let _ = app_reader.emit(
                            "child_output",
                            ChildOutput {
                                pty_id: id,
                                data: String::from_utf8_lossy(chunk).into_owned(),
                            },
                        );
                    }
                }
            }
            let _ = app_reader.emit("pty_exit", id);
            let _ = exit_tx.send(());
        });

        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });

        self.sessions.lock().unwrap().insert(
            id,
            PtySession {
                writer,
                master,
                killer,
                stdout_buf: Arc::clone(&stdout_buf),
                last_activity,
            },
        );

        Ok((id, stdout_buf, exit_rx))
    }

    /// Milliseconds since the target PTY last produced output. `None` if the pty
    /// is unknown. Used to gate `send_message` delivery until the agent is idle.
    pub fn idle_ms(&self, id: u32) -> Option<u128> {
        let map = self.sessions.lock().ok()?;
        let session = map.get(&id)?;
        let last = session.last_activity.lock().ok()?;
        Some(last.elapsed().as_millis())
    }

    /// Kill every live child and clear the table. Idempotent.
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

// ─── App state wrappers ───────────────────────────────────────────────────────

/// Newtype wrapper so Tauri can manage Arc<PtyManager> as app state.
pub struct PtyManagerState(pub Arc<PtyManager>);

/// Newtype wrapper so Tauri can manage the shared live-agent registry. The same
/// `Arc` is handed to the MCP server so `list_agents` / `send_message` read the
/// list the frontend keeps up to date via the `sync_agents` command.
pub struct AgentRegistryState(pub mcp::AgentRegistry);

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Spawn a PTY-backed process and stream its output to `on_data`.
/// Returns the pty id used by the other commands.
///
/// `env` is an optional list of `["KEY", "VALUE"]` pairs injected into the
/// child's environment — used to pass TURBO_GROUP_ID / TURBO_MCP_DEPTH to
/// the parent claude agent without a separate create_group spawn.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManagerState>,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env: Option<Vec<[String; 2]>>,
    on_data: Channel<Vec<u8>>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let shell = command.unwrap_or_else(platform::default_shell);
    // Resolve the program the way the OS actually would. On Windows this finds
    // `.cmd`/`.exe` shims (portable-pty's CreateProcess only auto-appends `.exe`)
    // and, for `.cmd`/`.bat` scripts, returns `cmd.exe /C <path>` as the real
    // spawn target so the shim is actually runnable. On Unix it's an unchanged
    // passthrough.
    let (program, prefix_args) = platform::resolve_command(&shell);
    let mut cmd = CommandBuilder::new(program);
    for a in prefix_args {
        cmd.arg(a);
    }
    if let Some(a) = args {
        cmd.args(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // Strip any inherited Claude Code session env so the `claude` we launch is a
    // fresh top-level session. If Turbo itself is started from inside a Claude
    // session (CLAUDECODE / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_CHILD_SESSION),
    // the child claude would treat itself as a nested subagent and skip writing
    // its usage transcript — making token/cost accounting read zero.
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&k);
        }
    }
    cmd.env("TERM", "xterm-256color");
    // Drop AppImage-injected library paths so `cargo`/`git`/`npm` run in this
    // terminal use system libs, not the ones bundled in Turbo's AppImage mount.
    platform::sanitize_appimage_env(&mut cmd);
    if let Some(pairs) = env {
        for [k, v] in pairs {
            cmd.env(k, v);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let master = pair.master;
    let killer = child.clone_killer();
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let id = manager.0.next_id.fetch_add(1, Ordering::SeqCst);

    let stdout_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stdout_buf_reader = Arc::clone(&stdout_buf);
    let last_activity: Arc<Mutex<Instant>> = Arc::new(Mutex::new(Instant::now()));
    let last_activity_reader = Arc::clone(&last_activity);

    // bounded channel: read thread -> forwarder thread -> Channel (frontend).
    let (tx, rx) = sync_channel::<Vec<u8>>(64);

    let app_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if let Ok(mut acc) = stdout_buf_reader.lock() {
                        acc.extend_from_slice(chunk);
                    }
                    if let Ok(mut la) = last_activity_reader.lock() {
                        *la = Instant::now();
                    }
                    let _ = tx.try_send(chunk.to_vec());
                }
            }
        }
        let _ = app_reader.emit("pty_exit", id);
    });

    std::thread::spawn(move || {
        for chunk in rx {
            if on_data.send(chunk).is_err() {
                break;
            }
        }
    });

    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });

    manager.0.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master,
            killer,
            stdout_buf,
            last_activity,
        },
    );

    Ok(id)
}

/// Write keyboard input (UTF-8) to a pty.
#[tauri::command]
fn pty_write(manager: State<PtyManagerState>, id: u32, data: String) -> Result<(), String> {
    let mut map = manager.0.sessions.lock().unwrap();
    let session = map.get_mut(&id).ok_or("pty not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a pty (sends SIGWINCH to the child).
#[tauri::command]
fn pty_resize(
    manager: State<PtyManagerState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = manager.0.sessions.lock().unwrap();
    let session = map.get(&id).ok_or("pty not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill a pty's child and drop the session.
#[tauri::command]
fn pty_kill(manager: State<PtyManagerState>, id: u32) -> Result<(), String> {
    let mut map = manager.0.sessions.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

/// Replace the live-agent registry with the frontend's current view. The
/// frontend (Zustand store) is the source of truth for agent label/group/status/
/// pty id and calls this whenever nodes change, so the MCP tools `list_agents`
/// and `send_message` always see the current canvas.
#[tauri::command]
fn sync_agents(
    registry: State<AgentRegistryState>,
    agents: Vec<mcp::AgentInfo>,
) -> Result<(), String> {
    let mut guard = registry.0.lock().map_err(|_| "agent registry poisoned")?;
    *guard = agents;
    Ok(())
}

/// Create a group: register it and write `.mcp.json` (after health-check).
///
/// Only writes `.mcp.json` — does NOT spawn claude. The TerminalNode's `usePty`
/// hook will spawn claude once this command returns (D-02 ordering: `.mcp.json`
/// is written before claude starts because the Toolbar awaits this command and
/// only then calls `addTerminalNode`, triggering usePty on mount).
///
/// The MCP server must already be running — `McpState` is populated in `run()` before
/// any window is shown, so this command is always safe to call (D-02 ordering).
#[tauri::command]
async fn create_group(
    _app: AppHandle,
    _manager: State<'_, PtyManagerState>,
    registry: State<'_, GroupRegistry>,
    mcp_state: State<'_, McpState>,
    group_id: String,
    cwd: String,
    backend: Option<String>,
    prompt: Option<String>,
    session_id: Option<String>,
    resume: Option<bool>,
) -> Result<ParentSpawn, String> {
    let cwd_path = Path::new(&cwd);
    let backend = AgentBackend::parse(backend.as_deref().unwrap_or(""));

    // Register the group + wire the MCP server (writes `.mcp.json` for Claude,
    // returns the URL for Codex) with THIS session's port. Server is already
    // listening (D-02 guaranteed). Called both on fresh open (resume=false) and
    // on restore (resume=true) — the command is composed fresh at spawn time so
    // the port is always current and the conversation continues instead of
    // starting over (or crashing on a dead port / already-used session id).
    let mcp_url = registry
        .register(&group_id, cwd_path, mcp_state.port, &backend)
        .map_err(|e| format!("failed to register group: {e}"))?;

    let (command, args) = backend.parent_command(
        &mcp_url,
        prompt.as_deref(),
        session_id.as_deref(),
        resume.unwrap_or(false),
    );
    Ok(ParentSpawn { command, args })
}

/// Read token + estimated cost usage for one agent terminal, by its pinned
/// Claude session id. Returns zeros (found=false) when no transcript exists yet
/// (e.g. a Codex terminal or a session that hasn't produced output).
#[tauri::command]
fn session_usage(session_id: String) -> usage::UsageReport {
    usage::session_usage(&session_id)
}

/// Token/cost usage for a Codex terminal — read from the newest
/// ~/.codex/sessions/**/rollout-*.jsonl whose session cwd matches `cwd`.
#[tauri::command]
fn codex_usage(cwd: String) -> usage::UsageReport {
    usage::codex_usage(&cwd)
}

/// The port the embedded MCP server is listening on THIS session (0 if it
/// failed to start). The server binds an ephemeral port that changes every
/// launch; the frontend needs it to rewrite a restored Codex terminal's baked
/// MCP URL (Codex wires the URL inline via `-c`, unlike Claude's `.mcp.json`).
#[tauri::command]
fn mcp_port(mcp_state: State<'_, McpState>) -> u16 {
    mcp_state.port
}

/// A selectable agent model for the "create agent" dropdown.
#[derive(serde::Serialize)]
pub struct AgentModelOption {
    /// Backend token consumed by `AgentBackend::parse` (e.g. "codex:gpt-5.6-sol").
    value: String,
    /// Human label shown in the UI (the model's display name).
    label: String,
    /// One-line model description (shown as a tooltip).
    description: String,
}

/// The Codex models offered in its `/model` picker, read from the CLI's own
/// on-disk cache (`~/.codex/models_cache.json`, refreshed by codex). Returned so
/// the UI lists every selectable model instead of a single generic "codex" — and
/// stays current automatically. Filters to `visibility == "list"`, matching the
/// picker exactly (drops hidden routing aliases like `-wm` and `codex-auto-review`).
/// Empty if the cache is absent/unreadable (the UI keeps the plain "Codex" default).
#[tauri::command]
fn codex_models() -> Vec<AgentModelOption> {
    let Some(home) = platform::home_dir() else {
        return Vec::new();
    };
    let path = home.join(".codex").join("models_cache.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    json.get("models")
        .and_then(|m| m.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let slug = m.get("slug").and_then(|v| v.as_str())?;
                    // Only user-selectable models (same set as codex's `/model`
                    // picker); hidden aliases and review-only models are excluded.
                    if m.get("visibility").and_then(|v| v.as_str()) != Some("list") {
                        return None;
                    }
                    let label = m
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(slug);
                    let description = m
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some(AgentModelOption {
                        value: format!("codex:{slug}"),
                        label: label.to_string(),
                        description,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the `claude` and `codex` CLIs are available on this machine (present
/// on the app's PATH). Shown in the top menu so the user knows what's usable.
#[derive(serde::Serialize)]
pub struct CliStatus {
    claude: bool,
    codex: bool,
}

#[tauri::command]
fn cli_status() -> CliStatus {
    CliStatus {
        claude: platform::command_exists("claude"),
        codex: platform::command_exists("codex"),
    }
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_manager = Arc::new(PtyManager::default());
    let pty_manager_for_mcp = Arc::clone(&pty_manager);

    // Shared live-agent registry: written by the `sync_agents` command (frontend)
    // and read by the MCP server's list_agents / send_message tools.
    let agents: mcp::AgentRegistry = Arc::new(Mutex::new(Vec::new()));
    let agents_for_mcp = Arc::clone(&agents);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManagerState(pty_manager))
        .manage(AgentRegistryState(agents))
        .manage(GroupRegistry::default())
        // McpState is inserted after the server starts (see setup hook below).
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pm = Arc::clone(&pty_manager_for_mcp);

            // Start the MCP server inside the Tauri tokio runtime.
            // The server binds to an ephemeral port; we store it in McpState
            // so create_group can write `.mcp.json` with the correct URL.
            tauri::async_runtime::block_on(async move {
                match mcp::start(pm, app_handle.clone(), 3, agents_for_mcp).await {
                    Ok(port) => {
                        tracing::info!(port, "MCP server started");
                        app_handle.manage(McpState { port });
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "failed to start MCP server");
                        // App continues without MCP — spawn_agent will be unavailable.
                        app_handle.manage(McpState { port: 0 });
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            sync_agents,
            create_group,
            session_usage,
            codex_usage,
            mcp_port,
            codex_models,
            cli_status,
            worktrees::list_worktrees,
            worktrees::create_worktree,
            worktrees::ensure_worktree_mcp,
            artifacts::git_changes,
            artifacts::git_file_view,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.state::<PtyManagerState>().0.kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
