//! MCP server (rmcp 3.x, Streamable HTTP) exposing the `spawn_agent` tool.
//!
//! The tool is blocking: it runs a `claude -p` subagent (or, in `--fake` mode, a
//! zero-cost stand-in) in a PTY and returns its final output. A depth guard reads
//! `TURBO_MCP_DEPTH` (which each child inherits, incremented) and refuses to spawn
//! grandchildren past the limit.

use std::net::SocketAddr;
use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ErrorData};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{schemars, tool, tool_router};
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

    #[tool(
        name = "spawn_agent",
        description = "Run a claude subagent on a task and return its final output (blocking)."
    )]
    async fn spawn_agent(
        &self,
        Parameters(p): Parameters<SpawnParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let depth: u32 = std::env::var("TURBO_MCP_DEPTH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // Depth guard: children inherit the .mcp.json and could recurse.
        if depth >= self.depth_limit {
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
        match run_to_completion(command, args, None, extra_env).await {
            Ok(out) => {
                tracing::info!(label = %p.label, "spawn_agent done");
                Ok(CallToolResult::success(vec![ContentBlock::text(out)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "spawn_agent failed: {e}"
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
