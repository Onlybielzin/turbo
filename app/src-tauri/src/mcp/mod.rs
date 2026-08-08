//! MCP subsystem — embeds a Streamable HTTP rmcp server in the Tauri tokio runtime.
//!
//! Entry point: `start(app_handle, pty_manager)` — call once from `run()`.
//! Returns the bound port so callers can write `.mcp.json` only after the server
//! is confirmed listening (D-02 ordering contract from 04-CONTEXT.md).

pub mod server;
pub mod spawn_agent;

pub use server::start;
pub use server::AgentInfo;
pub use server::AgentRegistry;
pub use server::McpState;
