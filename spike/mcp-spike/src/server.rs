//! MCP server (rmcp 3.x, Streamable HTTP) exposing the `spawn_agent` tool.
//!
//! The tool is blocking: it runs a `claude -p` subagent (or, in `--fake` mode, a
//! zero-cost stand-in) in a PTY and returns its final output. A depth guard reads
//! `TURBO_MCP_DEPTH` (which each child inherits, incremented) and refuses to spawn
//! grandchildren past the limit. Progress notifications are emitted every ~10s so
//! the parent claude's 60s idle timeout is never hit (ORCH-05).

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
use rmcp::{Peer, RoleServer, schemars, tool, tool_router};
use serde::Deserialize;

use crate::pty_runner::run_to_completion;

#[derive(Clone)]
pub struct SpawnServer {
    fake: bool,
    depth_limit: u32,
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SpawnParams {
    /// The task/prompt to hand to the child agent.
    pub task: String,
    /// A short label shown on the child terminal node.
    #[serde(default)]
    pub label: String,
}

#[tool_router(server_handler)]
impl SpawnServer {
    pub fn new(fake: bool, depth_limit: u32) -> Self {
        Self {
            fake,
            depth_limit,
            tool_router: Self::tool_router(),
        }
    }

    /// Run a child agent in a PTY, emit progress every 10s (avoids MCP idle timeout),
    /// and return the full stdout when the child exits (ORCH-01, ORCH-04, ORCH-05).
    ///
    /// Depth guard (ORCH-06): reads `TURBO_MCP_DEPTH` from the environment; refuses
    /// to spawn when the depth is already at or above `depth_limit`. Children inherit
    /// the env var incremented by 1.
    #[tool(
        name = "spawn_agent",
        description = "Run a claude subagent on a task and return its final output (blocking)."
    )]
    async fn spawn_agent(
        &self,
        Parameters(p): Parameters<SpawnParams>,
        peer: Peer<RoleServer>,
        meta: RequestMetaObject,
        _extensions: Extensions,
    ) -> Result<CallToolResult, ErrorData> {
        let depth: u32 = std::env::var("TURBO_MCP_DEPTH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // Depth guard: children inherit the .mcp.json and could recurse.
        if depth >= self.depth_limit {
            tracing::warn!(depth, depth_limit = self.depth_limit, "depth guard triggered");
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "depth guard: refusing spawn_agent at depth {} (limit {})",
                depth, self.depth_limit
            ))]));
        }

        let (command, args) = if self.fake {
            (
                "bash".to_string(),
                vec!["fake-agent.sh".to_string(), p.task.clone()],
            )
        } else {
            (
                "claude".to_string(),
                vec![
                    "-p".to_string(),
                    p.task.clone(),
                    "--output-format".to_string(),
                    "text".to_string(),
                    "--dangerously-skip-permissions".to_string(),
                ],
            )
        };

        let extra_env = vec![("TURBO_MCP_DEPTH".to_string(), (depth + 1).to_string())];

        tracing::info!(label = %p.label, depth, "spawn_agent start");

        // Get the progress token from the request metadata (may be absent if the
        // client did not include _meta.progressToken in its tool call).
        let progress_token: Option<ProgressToken> = meta.get_progress_token();

        // Run the child in a separate tokio task so we can concurrently drive the
        // 10-second heartbeat loop below (ORCH-05).
        let pty_task = tokio::spawn(run_to_completion(command, args, None, extra_env));
        tokio::pin!(pty_task);

        // Emit a progress notification every ~10s while the child is alive.
        // This prevents the parent claude's 60s MCP idle timeout from killing the call.
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        // The first tick fires immediately; skip it so we don't emit before work starts.
        interval.tick().await;

        let mut elapsed_ticks: u64 = 0;
        let result = loop {
            tokio::select! {
                biased;
                result = &mut pty_task => {
                    // Child exited (or task panicked).
                    break result;
                }
                _ = interval.tick() => {
                    elapsed_ticks += 1;
                    tracing::info!(
                        label = %p.label,
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
                                p.label,
                                elapsed_ticks * 10
                            )),
                        );
                        if let Err(e) = peer.send_notification(notif.into()).await {
                            tracing::warn!(error = %e, "failed to send progress notification");
                        }
                    } else {
                        // No progress token in request — still log heartbeat but cannot
                        // send a notification (spec requires a token). This is fine for
                        // testing; real claude always sends a token.
                        tracing::debug!(
                            label = %p.label,
                            "heartbeat: no progress_token in request meta, skipping notification"
                        );
                    }
                }
            }
        };

        match result {
            Ok(Ok(out)) => {
                tracing::info!(label = %p.label, "spawn_agent done");
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

/// Start the Streamable HTTP MCP server on `addr` and serve until shutdown.
pub async fn serve(addr: SocketAddr, fake: bool, depth_limit: u32) -> anyhow::Result<()> {
    let service = StreamableHttpService::new(
        move || Ok(SpawnServer::new(fake, depth_limit)),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    let app = axum::Router::new().route_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("MCP Streamable HTTP server listening on http://{addr}/mcp");
    axum::serve(listener, app).await?;
    Ok(())
}
