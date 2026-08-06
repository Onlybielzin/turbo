//! Worktree management — list, create, and ensure `.mcp.json` inside git worktrees.
//!
//! All git operations run via `std::process::Command` calling `git` directly — never
//! via the frontend. The three Tauri commands here implement WT-01, WT-02, and WT-04.

use std::path::Path;

use crate::groups::write_mcp_json;

// ─── Public types ─────────────────────────────────────────────────────────────

/// One git worktree belonging to a group's repo.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Worktree {
    /// Absolute path to the worktree root on disk.
    pub path: String,
    /// Active branch name (or abbreviated HEAD sha for detached HEAD).
    pub branch: String,
    /// True for the repo's main worktree (always the first in `git worktree list`).
    pub is_root: bool,
}

// ─── Validation helpers ────────────────────────────────────────────────────────

/// Accept only `[A-Za-z0-9._-]` — no slashes, dots-as-path-traversal, or spaces.
fn validate_worktree_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("worktree name must not be empty".to_string());
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !valid {
        return Err(format!(
            "worktree name '{name}' contains invalid characters — use only [A-Za-z0-9._-]"
        ));
    }
    // Extra guard: reject names that could traverse when joined
    if name.contains("..") {
        return Err(format!("worktree name '{name}' contains '..' — path traversal rejected"));
    }
    Ok(())
}

// ─── Tauri commands ────────────────────────────────────────────────────────────

/// List all git worktrees for the repo rooted at `cwd`.
///
/// Parses the `git worktree list --porcelain` output.  If `cwd` is not inside a
/// git repo (git exits non-zero) the function returns `Ok(vec![])` — the caller
/// treats this as "group has only its root directory, no extra raias".
#[tauri::command]
pub fn list_worktrees(cwd: String) -> Result<Vec<Worktree>, String> {
    let output = std::process::Command::new("git")
        .args(["-C", &cwd, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        // Not a git repo (or git not installed) — return empty list, not an error.
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktrees = parse_porcelain(&stdout, &cwd);
    Ok(worktrees)
}

/// Parse `git worktree list --porcelain` output into `Vec<Worktree>`.
///
/// Each worktree block is separated by a blank line and looks like:
/// ```text
/// worktree /abs/path
/// HEAD <sha>
/// branch refs/heads/<name>   ← or "detached" if in detached HEAD state
/// ```
fn parse_porcelain(output: &str, _root_cwd: &str) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let mut current_head: Option<String> = None;
    let mut is_detached = false;
    // The FIRST block in `git worktree list --porcelain` output is always the
    // main (root) worktree. Track whether we have flushed any block yet.
    let mut flushed_any = false;

    let flush = |path: String,
                 branch: Option<String>,
                 head: Option<String>,
                 detached: bool,
                 first: bool,
                 out: &mut Vec<Worktree>| {
        let branch_name = if detached {
            head.as_deref()
                .map(|h| h.chars().take(8).collect::<String>())
                .unwrap_or_else(|| "detached".to_string())
        } else {
            branch.unwrap_or_else(|| "?".to_string())
        };
        out.push(Worktree {
            path,
            branch: branch_name,
            is_root: first,
        });
    };

    for line in output.lines() {
        if line.is_empty() {
            if let Some(path) = current_path.take() {
                let is_first = !flushed_any;
                flush(
                    path,
                    current_branch.take(),
                    current_head.take(),
                    is_detached,
                    is_first,
                    &mut worktrees,
                );
                flushed_any = true;
            }
            is_detached = false;
        } else if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(sha) = line.strip_prefix("HEAD ") {
            current_head = Some(sha.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(branch_ref.to_string());
        } else if line == "detached" {
            is_detached = true;
        }
    }

    // Flush last block (no trailing blank line in some git versions)
    if let Some(path) = current_path {
        let is_first = !flushed_any;
        flush(
            path,
            current_branch,
            current_head,
            is_detached,
            is_first,
            &mut worktrees,
        );
    }

    worktrees
}

/// Create a new git worktree at `.claude/worktrees/<name>` under the repo `cwd`.
///
/// When `new_branch` is `true` the worktree is created with a new branch named
/// `branch` (`git worktree add <path> -b <branch>`).  When `false` the branch
/// must already exist (`git worktree add <path> <branch>`).
///
/// The `name` parameter must pass `validate_worktree_name` — only `[A-Za-z0-9._-]`.
#[tauri::command]
pub fn create_worktree(
    cwd: String,
    name: String,
    branch: String,
    new_branch: bool,
) -> Result<Worktree, String> {
    validate_worktree_name(&name)?;

    let base = Path::new(&cwd);
    let worktrees_dir = base.join(".claude").join("worktrees");
    let worktree_path = worktrees_dir.join(&name);

    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("failed to create .claude/worktrees: {e}"))?;

    let path_str = worktree_path
        .to_str()
        .ok_or("worktree path contains non-UTF-8 characters")?;

    // Build the git command
    let mut git_args = vec!["worktree", "add"];
    if new_branch {
        git_args.push("-b");
        git_args.push(&branch);
    }
    git_args.push(path_str);
    if !new_branch {
        git_args.push(&branch);
    }

    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(&cwd)
        .args(&git_args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    tracing::info!(
        cwd = %cwd,
        name = %name,
        branch = %branch,
        new_branch,
        path = %path_str,
        "worktree created"
    );

    Ok(Worktree {
        path: path_str.to_string(),
        branch,
        is_root: false,
    })
}

/// Idempotent: ensure `.mcp.json` exists inside the given worktree `cwd` with
/// the same MCP server URL as the group.
///
/// Calls `groups::write_mcp_json` — single source of truth for the `.mcp.json`
/// format (`type: "http"`, `url: http://127.0.0.1:{port}/mcp?group_id={id}`).
#[tauri::command]
pub fn ensure_worktree_mcp(
    cwd: String,
    group_id: String,
    mcp_port: u16,
) -> Result<(), String> {
    let path = Path::new(&cwd);
    write_mcp_json(path, &group_id, mcp_port)?;
    tracing::info!(
        cwd = %cwd,
        group_id = %group_id,
        port = mcp_port,
        "ensure_worktree_mcp: .mcp.json written"
    );
    Ok(())
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_good_names() {
        assert!(validate_worktree_name("feature-x").is_ok());
        assert!(validate_worktree_name("v1.2_alpha").is_ok());
        assert!(validate_worktree_name("zorinpay").is_ok());
    }

    #[test]
    fn rejects_empty_name() {
        assert!(validate_worktree_name("").is_err());
    }

    #[test]
    fn rejects_slash_in_name() {
        assert!(validate_worktree_name("foo/bar").is_err());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_worktree_name("..").is_err());
        assert!(validate_worktree_name("a..b").is_err());
    }

    #[test]
    fn rejects_space_in_name() {
        assert!(validate_worktree_name("foo bar").is_err());
    }

    #[test]
    fn parses_porcelain_two_worktrees() {
        let input = "\
worktree /home/user/myrepo
HEAD abc1234567890
branch refs/heads/main

worktree /home/user/myrepo/.claude/worktrees/feature-x
HEAD def9876543210
branch refs/heads/feature-x

";
        let wts = parse_porcelain(input, "/home/user/myrepo");
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].branch, "main");
        assert!(wts[0].is_root);
        assert_eq!(wts[1].branch, "feature-x");
        assert!(!wts[1].is_root);
    }

    #[test]
    fn parses_porcelain_detached_head() {
        let input = "\
worktree /home/user/myrepo
HEAD abcdef12345678
branch refs/heads/main

worktree /home/user/myrepo/.claude/worktrees/hotfix
HEAD deadbeef1234
detached

";
        let wts = parse_porcelain(input, "/home/user/myrepo");
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[1].branch, "deadbeef");
    }
}
