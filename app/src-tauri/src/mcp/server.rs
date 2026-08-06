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
use std::sync::Arc;

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

use super::spawn_agent::run_in_pty_blocking;
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
    pub child_pty_id: String, // UUID string — the PTY hasn't been registered in PtyManager for child agents
    pub label: String,
}

// ─── MCP server handler ───────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SpawnServer {
    depth_limit: u32,
    #[allow(dead_code)] // reserved: will use for child PTY registration
    pty_manager: Arc<PtyManager>,
    app: AppHandle,
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
}

#[tool_router(server_handler)]
impl SpawnServer {
    pub fn new(depth_limit: u32, pty_manager: Arc<PtyManager>, app: AppHandle) -> Self {
        Self {
            depth_limit,
            pty_manager,
            app,
            tool_router: Self::tool_router(),
        }
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
            Provide group_id and parent_pty_id so the child appears in the correct canvas frame."
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

        let child_id = uuid::Uuid::new_v4().to_string();
        let label = if p.label.is_empty() {
            format!("agent-{}", &child_id[..8])
        } else {
            p.label.clone()
        };

        // Parse parent_pty_id — default 0 if absent/invalid.
        let parent_pty_id: u32 = p.parent_pty_id.parse().unwrap_or(0);

        // Emit `node_created` to the frontend BEFORE the blocking call so the
        // canvas shows the child node immediately.
        let payload = NodeCreatedPayload {
            group_id: p.group_id.clone(),
            parent_pty_id,
            child_pty_id: child_id.clone(),
            label: label.clone(),
        };
        if let Err(e) = self.app.emit("node_created", payload) {
            tracing::warn!(error = %e, "failed to emit node_created event");
        }

        tracing::info!(label = %label, depth = p.depth, group_id = %p.group_id, "spawn_agent start");

        // Build the child command from the requested backend (claude/model or codex).
        let backend = AgentBackend::parse(&p.agent);
        let role = if p.prompt.trim().is_empty() {
            None
        } else {
            Some(p.prompt.as_str())
        };
        let (command, args) = backend.child_command(&p.task, role);

        // Pass depth+1 explicitly so the child's spawn_agent calls include correct depth,
        // and propagate the agent token so a child that itself orchestrates knows its kind.
        let next_depth = p.depth + 1;
        let extra_env = vec![
            ("TURBO_MCP_DEPTH".to_string(), next_depth.to_string()),
            ("TURBO_AGENT".to_string(), p.agent.clone()),
        ];

        let progress_token: Option<ProgressToken> = meta.get_progress_token();

        // Run PTY in spawn_blocking — no thread leak on task cancellation;
        // the OS thread finishes naturally and the JoinHandle is owned by tokio.
        let pty_task = tokio::task::spawn_blocking(move || {
            run_in_pty_blocking(command, args, None, extra_env)
        });
        tokio::pin!(pty_task);

        // Heartbeat every 10 s to keep the parent claude's MCP idle timer alive (ORCH-05).
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        interval.tick().await; // skip the immediate first tick

        let mut elapsed_ticks: u64 = 0;
        let result = loop {
            tokio::select! {
                biased;
                result = &mut pty_task => break result,
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
        };

        match result {
            Ok(Ok(out)) => {
                tracing::info!(label = %label, "spawn_agent done");
                Ok(CallToolResult::success(vec![ContentBlock::text(out)]))
            }
            Ok(Err(e)) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "spawn_agent failed: {e}"
            ))])),
            Err(join_err) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "spawn_agent task panicked: {join_err}"
            ))])),
        }
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
