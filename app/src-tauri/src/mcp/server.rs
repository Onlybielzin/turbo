//! Embedded MCP server (rmcp 3.x, Streamable HTTP) — Task 1, Phase 4.
//!
//! Shares `Arc<PtyManager>` with Tauri commands.  Handler `spawn_agent`:
//!   1. Reads `depth` from the *call's extra_env* (not the Tauri process env —
//!      Phase 2 review fix: the Tauri process env is not reliable for depth tracking).
//!      Depth is passed explicitly via `TURBO_MCP_DEPTH` in the child's env and
//!      read from the *request context* (`SpawnParams.depth`).
//!   2. Creates a child PTY via `run_in_pty_blocking` (spawn_blocking — no thread leak).
//!   3. Emits `node_created` Tauri event so the frontend adds the node to the canvas.
//!   4. Blocks until the child exits, returns its full stdout.
//!   5. Emits progress every ~10 s to prevent the parent claude's idle timeout.
//!
//! Concurrency: each MCP call runs in its own tokio task → 3 concurrent callers
//! yield 3 independent spawn_blocking threads, all isolated.
//!
//! Depth guard: reads `TURBO_MCP_DEPTH` from the *request* SpawnParams (explicit,
//! not from the ambient Tauri process env).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, ErrorData, Extensions, ProgressNotification,
    ProgressNotificationParam, ProgressToken, RequestMetaObject,
};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_router, Peer, RoleServer};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::agent::AgentBackend;
use crate::PtyManager;

// ─── State exposed to Tauri app state ────────────────────────────────────────

/// Holds the port the MCP server is listening on.
/// Written once at startup; read by `create_group` to build `.mcp.json`.
#[derive(Clone, Debug)]
pub struct McpState {
    pub port: u16,
}

// ─── Payload for the node_created Tauri event ────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct NodeCreatedPayload {
    pub group_id: String,
    pub parent_pty_id: u32,
    pub child_pty_id: u32, // real PtyManager id — the child streams live via child_output
    pub label: String,
}

/// Payload for the `agent_created` event — the orchestrator saved an agent into
/// the project's side menu (via the create_agent tool). The frontend adds it as
/// an AgentDef; `color` is chosen frontend-side when absent.
#[derive(Clone, serde::Serialize)]
pub struct AgentCreatedPayload {
    pub group_id: String,
    pub name: String,
    pub model: String,
    pub prompt: String,
    pub color: Option<String>,
}

// ─── Agent registry (live agents, shared with Tauri `sync_agents` command) ─────

/// One live agent/terminal, as mirrored from the frontend Zustand store. The
/// frontend is the source of truth (it owns node label/group/status/ptyId) and
/// pushes the current list into this registry via the `sync_agents` Tauri command
/// whenever nodes change. The MCP tools `list_agents` / `send_message` read it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct AgentInfo {
    /// Canvas node id (stable within a session).
    pub node_id: String,
    /// Display name shown on the terminal node.
    #[serde(default)]
    pub label: String,
    /// Group/project id the agent belongs to.
    #[serde(default)]
    pub group_id: String,
    /// Backend/model token (e.g. "opus", "codex", "sonnet").
    #[serde(default)]
    pub model: String,
    /// "running" | "ok" | "error".
    #[serde(default)]
    pub status: String,
    /// PtyManager id, when this agent has a live PTY we can write to. `None` for
    /// display-only nodes.
    #[serde(default)]
    pub pty_id: Option<u32>,
    /// "parent" (interactive orchestrator terminal) or "child" (spawned agent).
    #[serde(default)]
    pub kind: String,
}

/// Shared, mutable list of live agents. Cloned into both the Tauri command layer
/// (writer) and every MCP `SpawnServer` connection (reader).
pub type AgentRegistry = Arc<Mutex<Vec<AgentInfo>>>;

// ─── MCP server handler ───────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SpawnServer {
    depth_limit: u32,
    pty_manager: Arc<PtyManager>,
    app: AppHandle,
    /// Live agents mirrored from the frontend (read by list_agents/send_message).
    agents: AgentRegistry,
    #[allow(dead_code)] // used internally by rmcp #[tool_router] macro dispatch
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SpawnParams {
    /// The task/prompt to hand to the child agent.
    pub task: String,
    /// Short label shown on the child terminal node in the canvas.
    #[serde(default)]
    pub label: String,
    /// ID of the group (GroupFrame) that the calling parent belongs to.
    /// The frontend uses this to attach the child node to the right frame.
    #[serde(default)]
    pub group_id: String,
    /// Pty id of the parent agent terminal (u32 as string to avoid JSON precision loss).
    #[serde(default)]
    pub parent_pty_id: String,
    /// Recursion depth passed explicitly by the parent (not read from Tauri env).
    /// The server sets `TURBO_MCP_DEPTH=(depth+1)` in the child's env.
    #[serde(default)]
    pub depth: u32,
    /// Which backend/model the child runs on: "codex", "fable", "opus",
    /// "sonnet", "haiku", or "claude"/"" for the default. Lets the orchestrator
    /// pick per-agent — e.g. spawn a security agent on Codex, a backend worker
    /// on Opus.
    #[serde(default)]
    pub agent: String,
    /// Optional ROLE / system prompt for the child (injected as
    /// --append-system-prompt for Claude, -c developer_instructions for Codex).
    /// The child's actual TASK is `task` (the one-shot user message).
    #[serde(default)]
    pub prompt: String,
    /// Absolute path of the worktree where the child agent should run.
    /// Empty string (the default) means: use the same worktree as the parent,
    /// which is passed explicitly via TURBO_WORKTREE_CWD in the parent's env
    /// and forwarded here by the orchestrator. Pass a different worktree path
    /// to redirect the child to another worktree of the same group.
    /// Explicit, not inherited from the Tauri process env — same discipline as
    /// `depth` (Phase 4 review fix: Tauri process env is not reliable for this).
    #[serde(default)]
    pub worktree: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct CreateAgentParams {
    /// Project id the agent belongs to — pass your own TURBO_GROUP_ID.
    #[serde(default)]
    pub group_id: String,
    /// Display name of the agent (e.g. "Backend").
    pub name: String,
    /// Backend/model token: "codex", "opus", "sonnet", "haiku", or "fable".
    pub model: String,
    /// Optional role / system prompt for the agent.
    #[serde(default)]
    pub prompt: String,
    /// Optional accent color (hex like "#6ea8fe"); the UI picks one if empty.
    #[serde(default)]
    pub color: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct ListAgentsParams {
    /// Optional group id to filter by — pass your own TURBO_GROUP_ID to see only
    /// the agents in your project. Empty (default) lists agents from every group.
    #[serde(default)]
    pub group_id: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SendMessageParams {
    /// Who to message: the agent's label/name (e.g. "backend"), its node_id, or
    /// its pty id as a string. Matched case-insensitively; label match wins.
    pub target: String,
    /// The message text to deliver into the target agent's terminal (submitted as
    /// if typed + Enter).
    pub message: String,
    /// Optional: your own name/label as the sender, so the recipient knows who
    /// asked. Shown in the "[Turbo]" header prepended to the message. Empty →
    /// the header just says it came from another agent.
    #[serde(default)]
    pub from: String,
}

#[tool_router(server_handler)]
impl SpawnServer {
    pub fn new(
        depth_limit: u32,
        pty_manager: Arc<PtyManager>,
        app: AppHandle,
        agents: AgentRegistry,
    ) -> Self {
        Self {
            depth_limit,
            pty_manager,
            app,
            agents,
            tool_router: Self::tool_router(),
        }
    }

    /// Create (save) an agent in the project's side menu. Does NOT run it — the
    /// user opens its terminal from the menu. Use this to add team members.
    #[tool(
        name = "create_agent",
        description = "Create and SAVE an agent in the project's side menu so the user can open its \
            terminal. Use this to add team members (e.g. a backend agent on opus, a frontend agent \
            on sonnet). Pass group_id (your TURBO_GROUP_ID), name, model (opus|sonnet|haiku|fable|codex) \
            and an optional prompt/role. This does not start the agent — the user opens it."
    )]
    async fn create_agent(
        &self,
        Parameters(p): Parameters<CreateAgentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let color = if p.color.trim().is_empty() {
            None
        } else {
            Some(p.color.clone())
        };
        let payload = AgentCreatedPayload {
            group_id: p.group_id.clone(),
            name: p.name.clone(),
            model: p.model.clone(),
            prompt: p.prompt.clone(),
            color,
        };
        if let Err(e) = self.app.emit("agent_created", payload) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "failed to create agent: {e}"
            ))]));
        }
        tracing::info!(name = %p.name, model = %p.model, group_id = %p.group_id, "create_agent");
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "agent '{}' ({}) saved to the project side menu — the user can open its terminal there",
            p.name, p.model
        ))]))
    }

    /// List the agents currently alive on the canvas (parents + spawned children),
    /// so an orchestrator can see who is available to delegate to or message.
    #[tool(
        name = "list_agents",
        description = "List the agents currently active on the canvas — their name, model, status, \
            group and ids. Use this to see who you can delegate to (spawn_agent) or message \
            (send_message). Pass group_id (your TURBO_GROUP_ID) to filter to your own project; \
            omit to list every group."
    )]
    async fn list_agents(
        &self,
        Parameters(p): Parameters<ListAgentsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let filter = p.group_id.trim();
        let snapshot: Vec<AgentInfo> = {
            let guard = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .iter()
                .filter(|a| filter.is_empty() || a.group_id == filter)
                .cloned()
                .collect()
        };

        if snapshot.is_empty() {
            return Ok(CallToolResult::success(vec![ContentBlock::text(
                "no active agents".to_string(),
            )]));
        }

        let mut lines = vec![format!("{} active agent(s):", snapshot.len())];
        for a in &snapshot {
            let pty = a
                .pty_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "-".to_string());
            lines.push(format!(
                "- {label} [{kind}] model={model} status={status} pty={pty} group={group} id={id}",
                label = if a.label.is_empty() { "(unnamed)" } else { &a.label },
                kind = if a.kind.is_empty() { "?" } else { &a.kind },
                model = if a.model.is_empty() { "?" } else { &a.model },
                status = if a.status.is_empty() { "?" } else { &a.status },
                pty = pty,
                group = a.group_id,
                id = a.node_id,
            ));
        }
        Ok(CallToolResult::success(vec![ContentBlock::text(
            lines.join("\n"),
        )]))
    }

    /// Deliver a message into another agent's live terminal (chat → chat). Resolves
    /// the target from the agent registry and writes the text (plus Enter) to its PTY.
    #[tool(
        name = "send_message",
        description = "Send a message to another active agent's terminal (chat to chat). The text is \
            typed into the target's terminal and submitted. Identify the target by its label/name, \
            node_id, or pty id (see list_agents). Only agents with a live PTY can receive messages."
    )]
    async fn send_message(
        &self,
        Parameters(p): Parameters<SendMessageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let target = p.target.trim();
        if target.is_empty() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "send_message: target is required".to_string(),
            )]));
        }

        // Resolve target → pty_id. Priority: exact node_id, then case-insensitive
        // label, then a numeric pty id. Only agents with a live PTY are eligible.
        let resolved: Option<(String, u32)> = {
            let guard = self.agents.lock().unwrap_or_else(|e| e.into_inner());
            let target_lower = target.to_ascii_lowercase();
            let by_node = guard.iter().find(|a| a.node_id == target);
            let by_label = guard
                .iter()
                .find(|a| a.label.to_ascii_lowercase() == target_lower);
            let by_pty = target
                .parse::<u32>()
                .ok()
                .and_then(|id| guard.iter().find(|a| a.pty_id == Some(id)));
            by_node
                .or(by_label)
                .or(by_pty)
                .and_then(|a| a.pty_id.map(|id| (a.label.clone(), id)))
        };

        let Some((label, pty_id)) = resolved else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "send_message: no live agent matches target '{target}' (use list_agents to see who's available)"
            ))]));
        };

        // Prepend a one-line header so the recipient knows this arrived from
        // another agent (not the human) and should act on it + reply back. Kept
        // on a single line so the target CLI submits it as exactly one turn.
        let from = p.from.trim();
        let sender = if from.is_empty() {
            "outro agente".to_string()
        } else {
            format!("o agente '{from}'")
        };
        // Round-trip: if we know the sender, tell the recipient to reply via
        // send_message back to it; otherwise just answer in its own terminal.
        let reply_hint = if from.is_empty() {
            "Faça o que for pedido e responda aqui com o resultado.".to_string()
        } else {
            format!(
                "Faça o que for pedido e RESPONDA de volta usando a tool send_message com target=\"{from}\" e sua resposta em message."
            )
        };
        let text = format!(
            "[Turbo] Mensagem automática de {sender} (não é o usuário). {reply_hint} Mensagem: {}",
            p.message
        );

        // Write the message body first, then send Enter as a SEPARATE keystroke
        // after a short delay. Ink-based TUIs (claude/codex) treat a burst of
        // bytes ending in \r as a paste and keep the newline INSIDE the input
        // instead of submitting — so the message showed up typed but unsent. A
        // standalone, delayed carriage return registers as a real Enter.
        // Deliver when the target is idle: enqueue a background task that waits
        // until the target PTY has been quiet (~1.2s of no output) before writing,
        // so the message isn't injected mid-generation (which the CLI would
        // clobber or interleave). Falls back to delivering after a max wait.
        // Returns immediately so the calling agent isn't blocked.
        let pm = Arc::clone(&self.pty_manager);
        let deliver_text = text;
        tokio::spawn(async move {
            const IDLE_MS: u128 = 1200;
            const POLL_MS: u64 = 300;
            const MAX_WAIT_MS: u128 = 20_000;
            let mut waited: u128 = 0;
            loop {
                let idle = pm.idle_ms(pty_id).unwrap_or(u128::MAX);
                if idle >= IDLE_MS || waited >= MAX_WAIT_MS {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(POLL_MS)).await;
                waited += POLL_MS as u128;
            }
            if let Err(e) = pm.write(pty_id, &deliver_text) {
                tracing::warn!(pty_id, error = %e, "send_message delivery write failed");
                return;
            }
            // Separate, delayed Enter so the CLI submits it (see the write() note
            // about Ink TUIs treating a trailing \r in a burst as paste content).
            tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;
            if let Err(e) = pm.write(pty_id, "\r") {
                tracing::warn!(pty_id, error = %e, "send_message submit failed");
            }
        });
        tracing::info!(target = %label, pty_id, "send_message queued (deliver when idle)");
        Ok(CallToolResult::success(vec![ContentBlock::text(format!(
            "message queued for '{label}' (pty {pty_id}) — será entregue quando o agente estiver ocioso"
        ))]))
    }

    /// Spawn a child claude agent in a PTY, emit a canvas `node_created` event,
    /// stream progress every 10 s, and return the child's full stdout when done.
    ///
    /// Depth guard: refuses to spawn when `params.depth >= depth_limit`.
    /// Each child receives `TURBO_MCP_DEPTH=(depth+1)` in its env so the next
    /// level can read the correct depth from its own spawn_agent call params.
    #[tool(
        name = "spawn_agent",
        description = "Spawn a claude subagent on a task and return its final output (blocking). \
            Provide group_id and parent_pty_id so the child appears in the correct canvas frame. \
            Optional: pass worktree (absolute path) to run the child in a specific git worktree \
            of the same group; omit to run without a worktree override."
    )]
    async fn spawn_agent(
        &self,
        Parameters(p): Parameters<SpawnParams>,
        peer: Peer<RoleServer>,
        meta: RequestMetaObject,
        _extensions: Extensions,
    ) -> Result<CallToolResult, ErrorData> {
        // Depth guard — uses explicit depth from params, not ambient env.
        if p.depth >= self.depth_limit {
            tracing::warn!(
                depth = p.depth,
                depth_limit = self.depth_limit,
                "spawn_agent depth guard triggered"
            );
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "depth guard: refusing spawn_agent at depth {} (limit {})",
                p.depth, self.depth_limit
            ))]));
        }

        let label = if p.label.is_empty() {
            format!("agent-{}", &uuid::Uuid::new_v4().to_string()[..8])
        } else {
            p.label.clone()
        };

        // Parse parent_pty_id — default 0 if absent/invalid.
        let parent_pty_id: u32 = p.parent_pty_id.parse().unwrap_or(0);

        tracing::info!(label = %label, depth = p.depth, group_id = %p.group_id, "spawn_agent start");

        // Build the child command from the requested backend (claude/model or codex).
        let backend = AgentBackend::parse(&p.agent);
        let role = if p.prompt.trim().is_empty() {
            None
        } else {
            Some(p.prompt.as_str())
        };
        let (command, args) = backend.child_command(&p.task, role);

        // Derive the cwd for the child: explicit worktree param takes priority;
        // empty string means the orchestrator did not specify a worktree override
        // (the child will inherit whatever TURBO_WORKTREE_CWD the parent passed in).
        let cwd: Option<String> = if p.worktree.trim().is_empty() {
            None
        } else {
            Some(p.worktree.clone())
        };

        // Pass depth+1 explicitly so the child's spawn_agent calls include correct depth,
        // and propagate the agent token so a child that itself orchestrates knows its kind.
        // Also propagate the worktree path so a child that itself orchestrates knows its
        // worktree context and can pass it in its own spawn_agent calls.
        let next_depth = p.depth + 1;
        let mut extra_env = vec![
            ("TURBO_MCP_DEPTH".to_string(), next_depth.to_string()),
            ("TURBO_AGENT".to_string(), p.agent.clone()),
        ];
        if !p.worktree.trim().is_empty() {
            extra_env.push(("TURBO_WORKTREE_CWD".to_string(), p.worktree.clone()));
        }

        // Spawn the child as a REAL PTY registered in the manager: it streams live
        // to the canvas (via the `child_output` event) so the subagent is visible
        // working, while every byte is buffered for the blocking return to the parent.
        let (child_pty_id, stdout_buf, exit_rx) = match self
            .pty_manager
            .spawn_child_streaming(self.app.clone(), command, args, cwd, extra_env)
        {
            Ok(t) => t,
            Err(e) => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "spawn_agent failed to start child pty: {e}"
                ))]))
            }
        };

        // Now that we have the real pty id, tell the canvas to add the child node
        // and attach to this pty's live output stream.
        let payload = NodeCreatedPayload {
            group_id: p.group_id.clone(),
            parent_pty_id,
            child_pty_id,
            label: label.clone(),
        };
        if let Err(e) = self.app.emit("node_created", payload) {
            tracing::warn!(error = %e, "failed to emit node_created event");
        }

        let progress_token: Option<ProgressToken> = meta.get_progress_token();

        // Await the child's exit with a 10s heartbeat to keep the parent claude's
        // MCP idle timer alive (ORCH-05). The child streams live in the meantime.
        tokio::pin!(exit_rx);
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        interval.tick().await; // skip the immediate first tick

        let mut elapsed_ticks: u64 = 0;
        loop {
            tokio::select! {
                biased;
                _ = &mut exit_rx => break,
                _ = interval.tick() => {
                    elapsed_ticks += 1;
                    tracing::info!(
                        label = %label,
                        elapsed_secs = elapsed_ticks * 10,
                        "spawn_agent heartbeat"
                    );
                    if let Some(ref token) = progress_token {
                        let notif = ProgressNotification::new(
                            ProgressNotificationParam::new(
                                token.clone(),
                                (elapsed_ticks * 10) as f64,
                            )
                            .with_message(format!(
                                "agent '{}' running — {}s elapsed",
                                label,
                                elapsed_ticks * 10
                            )),
                        );
                        if let Err(e) = peer.send_notification(notif.into()).await {
                            tracing::warn!(error = %e, "progress notification failed");
                        }
                    }
                }
            }
        }

        tracing::info!(label = %label, "spawn_agent done");
        let out = stdout_buf
            .lock()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        Ok(CallToolResult::success(vec![ContentBlock::text(out)]))
    }
}

// ─── Server startup ───────────────────────────────────────────────────────────

/// Start the MCP Streamable HTTP server on an ephemeral port bound to 127.0.0.1.
/// Returns the bound port after confirming the server is listening (health-check
/// implicit: if `bind` succeeds, the port is open).
///
/// Must be called from inside the Tauri async runtime (tauri::async_runtime::spawn).
pub async fn start(
    pty_manager: Arc<PtyManager>,
    app: AppHandle,
    depth_limit: u32,
    agents: AgentRegistry,
) -> anyhow::Result<u16> {
    let addr: SocketAddr = "127.0.0.1:0".parse()?; // port 0 → OS picks a free port
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let port = listener.local_addr()?.port();

    let pm = Arc::clone(&pty_manager);
    let app_clone = app.clone();

    let service = StreamableHttpService::new(
        move || {
            Ok(SpawnServer::new(
                depth_limit,
                Arc::clone(&pm),
                app_clone.clone(),
                Arc::clone(&agents),
            ))
        },
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new().route_service("/mcp", service);

    tracing::info!("MCP Streamable HTTP server listening on http://127.0.0.1:{port}/mcp");

    // Spawn the server as a background tokio task — it runs until the Tauri app exits.
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!(error = %e, "MCP server exited with error");
        }
    });

    Ok(port)
}
