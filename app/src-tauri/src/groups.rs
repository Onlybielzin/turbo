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

use anyhow::Result;
use serde_json::json;

use crate::agent::AgentBackend;

/// Write `.mcp.json` into `cwd` for the given group and MCP port.
///
/// This is the single source of truth for the `.mcp.json` format used by the
/// embedded MCP server (Streamable HTTP, type "http", SSE is deprecated).
/// Both `GroupRegistry::register` and `worktrees::ensure_worktree_mcp` call
/// this function so the format is never duplicated.
///
/// Returns the MCP URL that was written.
pub fn write_mcp_json(cwd: &Path, group_id: &str, mcp_port: u16) -> Result<String, String> {
    let mcp_url = format!("http://127.0.0.1:{}/mcp?group_id={}", mcp_port, group_id);
    let mcp_json_path = cwd.join(".mcp.json");
    let config = json!({
        "mcpServers": {
            "turbo": {
                "type": "http",
                "url": mcp_url.clone()
            }
        }
    });
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("failed to serialise .mcp.json: {e}"))?;
    std::fs::write(&mcp_json_path, content)
        .map_err(|e| format!("failed to write {}: {e}", mcp_json_path.display()))?;
    tracing::info!(
        group_id = %group_id,
        cwd = %cwd.display(),
        port = mcp_port,
        ".mcp.json written"
    );
    Ok(mcp_url)
}

/// Runtime entry for one group.
#[derive(Debug, Clone)]
pub struct GroupEntry {
    #[allow(dead_code)] // used by get_cwd(), which is called by future MCP routing
    pub cwd: PathBuf,
    /// The backend the group's orchestrator runs on. Reserved for routing
    /// spawn_agent children to the parent's default backend.
    #[allow(dead_code)]
    pub backend: AgentBackend,
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
    /// Returns the MCP server URL for this group (used by Codex-backed parents,
    /// which wire the server inline via `-c` instead of a `.mcp.json` file).
    pub fn register(
        &self,
        group_id: &str,
        cwd: &Path,
        mcp_port: u16,
        backend: &AgentBackend,
    ) -> Result<String> {
        // Claude discovers the tool via `.mcp.json`; Codex takes the URL inline,
        // so only write the file when the parent is Claude-backed.
        // `write_mcp_json` is the single source of truth for the .mcp.json format.
        let mcp_url = if backend.uses_mcp_json() {
            write_mcp_json(cwd, group_id, mcp_port)
                .map_err(|e| anyhow::anyhow!("{e}"))?
        } else {
            format!("http://127.0.0.1:{}/mcp?group_id={}", mcp_port, group_id)
        };

        let mut map = self.entries.lock().unwrap();
        map.insert(
            group_id.to_string(),
            GroupEntry {
                cwd: cwd.to_path_buf(),
                backend: backend.clone(),
            },
        );

        Ok(mcp_url)
    }

    /// Look up the cwd for a group.
    #[allow(dead_code)] // used by future MCP connection-to-group routing
    pub fn get_cwd(&self, group_id: &str) -> Option<PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .get(group_id)
            .map(|e| e.cwd.clone())
    }

    /// Remove a group entry (e.g. when the group is closed).
    #[allow(dead_code)] // called when frontend closes a group (future)
    pub fn remove(&self, group_id: &str) {
        self.entries.lock().unwrap().remove(group_id);
    }
}
