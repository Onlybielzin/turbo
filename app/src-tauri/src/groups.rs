//! Group registry — maps group_id → cwd. Used by the MCP handler to write
//! `.mcp.json` into the group's cwd AFTER the server is confirmed listening
//! (D-02 ordering contract from 04-CONTEXT.md).
//!
//! `.mcp.json` format: Streamable HTTP, type "http" (SSE is deprecated per Claude docs).
//! The group_id is embedded in the server URL as a query param so the handler can
//! map each connection back to the correct GroupFrame (GRP-03).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde_json::json;

/// Runtime entry for one group.
#[derive(Debug, Clone)]
pub struct GroupEntry {
    #[allow(dead_code)] // used by get_cwd(), which is called by future MCP routing
    pub cwd: PathBuf,
}

/// Registry: group_id → GroupEntry.
#[derive(Default)]
pub struct GroupRegistry {
    entries: Mutex<HashMap<String, GroupEntry>>,
}

impl GroupRegistry {
    /// Register a group and write `.mcp.json` into its cwd.
    ///
    /// Precondition: the MCP server is already listening on `mcp_port`.
    /// This is guaranteed by the caller (create_group command) which only runs
    /// after `McpState` is populated (D-02).
    pub fn register(
        &self,
        group_id: &str,
        cwd: &Path,
        mcp_port: u16,
    ) -> Result<()> {
        // Write `.mcp.json` — the parent claude reads this on startup to find the tool.
        // `group_id` is included in the URL so the MCP handler knows which frame to use.
        let mcp_json_path = cwd.join(".mcp.json");
        let config = json!({
            "mcpServers": {
                "turbo": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp?group_id={}", mcp_port, group_id)
                }
            }
        });
        let content = serde_json::to_string_pretty(&config)
            .context("failed to serialise .mcp.json")?;
        std::fs::write(&mcp_json_path, content)
            .with_context(|| format!("failed to write {}", mcp_json_path.display()))?;

        tracing::info!(
            group_id = %group_id,
            cwd = %cwd.display(),
            port = mcp_port,
            ".mcp.json written"
        );

        let mut map = self.entries.lock().unwrap();
        map.insert(
            group_id.to_string(),
            GroupEntry { cwd: cwd.to_path_buf() },
        );

        Ok(())
    }

    /// Look up the cwd for a group.
    #[allow(dead_code)] // used by future MCP connection-to-group routing
    pub fn get_cwd(&self, group_id: &str) -> Option<PathBuf> {
        self.entries.lock().unwrap().get(group_id).map(|e| e.cwd.clone())
    }

    /// Remove a group entry (e.g. when the group is closed).
    #[allow(dead_code)] // called when frontend closes a group (future)
    pub fn remove(&self, group_id: &str) {
        self.entries.lock().unwrap().remove(group_id);
    }
}
