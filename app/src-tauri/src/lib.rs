// Turbo — Phase 4: PTY bridge + embedded MCP server (rmcp Streamable HTTP).
//
// PtyManager is now Arc<PtyManager> so the MCP handler and Tauri commands share
// the same instance. The MCP server starts as a tokio task before any group is
// created; `.mcp.json` is written ONLY after the health-check (D-02 contract).

mod agent;
mod artifacts;
mod groups;
mod mcp;
mod usage;
mod worktrees;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::sync::Mutex;

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

/// One live PTY: the write side, the master (for resize) and a killer handle.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Accumulates all PTY output for MCP spawn_agent return path.
    #[allow(dead_code)]
    stdout_buf: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
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

    let shell = command
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
    let mut cmd = CommandBuilder::new(shell);
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
) -> Result<ParentSpawn, String> {
    let cwd_path = Path::new(&cwd);
    let backend = AgentBackend::parse(backend.as_deref().unwrap_or(""));

    // Register the group + wire the MCP server (writes `.mcp.json` for Claude,
    // returns the URL for Codex). Server is already listening (D-02 guaranteed).
    // The parent agent starts AFTER this returns and the Toolbar calls
    // addTerminalNode (which triggers usePty on mount).
    let mcp_url = registry
        .register(&group_id, cwd_path, mcp_state.port, &backend)
        .map_err(|e| format!("failed to register group: {e}"))?;

    let (command, args) =
        backend.parent_command(&mcp_url, prompt.as_deref(), session_id.as_deref());
    Ok(ParentSpawn { command, args })
}

/// Read token + estimated cost usage for one agent terminal, by its pinned
/// Claude session id. Returns zeros (found=false) when no transcript exists yet
/// (e.g. a Codex terminal or a session that hasn't produced output).
#[tauri::command]
fn session_usage(session_id: String) -> usage::UsageReport {
    usage::session_usage(&session_id)
}

/// Whether the `claude` and `codex` CLIs are available on this machine (present
/// on the app's PATH). Shown in the top menu so the user knows what's usable.
#[derive(serde::Serialize)]
pub struct CliStatus {
    claude: bool,
    codex: bool,
}

/// Search PATH for an executable file named `bin`.
fn which(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file())
}

#[tauri::command]
fn cli_status() -> CliStatus {
    CliStatus {
        claude: which("claude"),
        codex: which("codex"),
    }
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_manager = Arc::new(PtyManager::default());
    let pty_manager_for_mcp = Arc::clone(&pty_manager);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManagerState(pty_manager))
        .manage(GroupRegistry::default())
        // McpState is inserted after the server starts (see setup hook below).
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pm = Arc::clone(&pty_manager_for_mcp);

            // Start the MCP server inside the Tauri tokio runtime.
            // The server binds to an ephemeral port; we store it in McpState
            // so create_group can write `.mcp.json` with the correct URL.
            tauri::async_runtime::block_on(async move {
                match mcp::start(pm, app_handle.clone(), 3).await {
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
            create_group,
            session_usage,
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
