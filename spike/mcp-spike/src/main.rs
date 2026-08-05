//! Turbo MCP spike — isolated de-risking binary (Phase 2).
//!
//! Proves the blocking `spawn_agent` loop over Streamable HTTP with a depth
//! guard, outside of Tauri, before porting it into the app in Phase 4.

mod pty_runner;
mod server;

use std::net::SocketAddr;

use clap::Parser;

#[derive(Parser)]
#[command(
    name = "turbo-mcp-spike",
    about = "Isolated MCP spike: blocking spawn_agent over Streamable HTTP (127.0.0.1)"
)]
struct Cli {
    /// Port to bind the MCP server on (127.0.0.1).
    #[arg(long, default_value_t = 7717)]
    port: u16,

    /// Use the zero-cost fake agent (fake-agent.sh) instead of `claude -p`.
    #[arg(long, default_value_t = false)]
    fake: bool,

    /// Refuse spawn_agent calls at this depth or deeper (recursion guard).
    #[arg(long = "depth-limit", default_value_t = 2)]
    depth_limit: u32,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let addr: SocketAddr = ([127, 0, 0, 1], cli.port).into();

    tracing::info!(
        port = cli.port,
        fake = cli.fake,
        depth_limit = cli.depth_limit,
        "starting turbo-mcp-spike"
    );

    server::serve(addr, cli.fake, cli.depth_limit).await
}
