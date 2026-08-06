//! Git artifact detection — list changed files and read file content + diff.
//!
//! These Tauri commands are called periodically by TerminalNode to surface the
//! files that an agent has created or modified in its working directory.

use std::path::Path;

// ─── Public types ─────────────────────────────────────────────────────────────

/// One changed file as reported by `git status --porcelain=v1`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Change {
    /// Repo-relative path to the file.
    pub path: String,
    /// Simplified single-character status code:
    /// "M" modified, "A" added/new, "D" deleted, "R" renamed, "?" untracked.
    pub status: String,
    /// Whether the change is in the staging area (index).
    pub staged: bool,
}

/// File content + unified diff for display in the ViewerNode.
#[derive(Debug, serde::Serialize)]
pub struct FileView {
    /// UTF-8 text content of the file. Empty when `is_binary` is true.
    pub content: String,
    /// Output of `git diff -- <path>`. Empty for untracked files.
    pub diff: String,
    /// True when the file could not be decoded as UTF-8.
    pub is_binary: bool,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Map the two-character XY porcelain status to a single code character.
fn simplify_status(xy: &str) -> (&'static str, bool) {
    let x = xy.chars().next().unwrap_or(' ');
    let y = xy.chars().nth(1).unwrap_or(' ');

    // Untracked
    if x == '?' && y == '?' {
        return ("?", false);
    }

    // Determine staged/unstaged from position
    let (code, staged) = match (x, y) {
        ('A', _) => ("A", true),
        ('M', ' ') => ("M", true),
        ('D', ' ') | ('D', 'D') => ("D", true),
        ('R', _) => ("R", true),
        (' ', 'M') => ("M", false),
        (' ', 'D') => ("D", false),
        (' ', 'A') => ("A", false),
        ('M', 'M') => ("M", true),
        _ => ("M", x != ' '),
    };

    (code, staged)
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// List files changed in the git repo at `cwd` (via `git status --porcelain=v1`).
///
/// Returns `Ok(vec![])` when `cwd` is not a git repository. Ignores paths
/// inside `.git/`. Limits output to 200 entries.
#[tauri::command]
pub fn git_changes(cwd: String) -> Result<Vec<Change>, String> {
    let output = std::process::Command::new("git")
        .args(["-C", &cwd, "status", "--porcelain=v1"])
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if !output.status.success() {
        // Not a git repo — return empty list, not an error.
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut changes: Vec<Change> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let rest = &line[3..]; // skip the space separator

        // Handle renames: "R  old -> new" or "R  old\0new" (porcelain v1 uses "->")
        let path = if xy.starts_with('R') {
            // "R  old-path -> new-path" — we want the new path (after "->")
            if let Some(pos) = rest.find(" -> ") {
                rest[pos + 4..].to_string()
            } else {
                rest.to_string()
            }
        } else {
            rest.to_string()
        };

        // Ignore .git/ internals
        if path.starts_with(".git/") || path == ".git" {
            continue;
        }

        let (status_code, staged) = simplify_status(xy);
        changes.push(Change {
            path,
            status: status_code.to_string(),
            staged,
        });

        if changes.len() >= 200 {
            break;
        }
    }

    Ok(changes)
}

/// Read the current content and unified diff of a file in a git repo.
///
/// **Security:** `path` is validated — rejected if empty, contains `..`, or is
/// absolute (starts with `/`). The resolved path must stay inside `cwd`.
#[tauri::command]
pub fn git_file_view(cwd: String, path: String) -> Result<FileView, String> {
    // ── Input validation ──────────────────────────────────────────────────────
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if path.contains("..") {
        return Err("path must not contain '..' (path traversal rejected)".to_string());
    }
    if path.starts_with('/') {
        return Err("path must be relative, not absolute".to_string());
    }

    let cwd_path = Path::new(&cwd);
    let abs_path = cwd_path.join(&path);

    // Double-check the resolved path is still inside cwd (handles edge cases).
    let canonical_cwd = cwd_path
        .canonicalize()
        .map_err(|e| format!("failed to resolve cwd: {e}"))?;
    let canonical_abs = abs_path
        .canonicalize()
        .unwrap_or_else(|_| abs_path.clone()); // file may be untracked / not yet created
    if !canonical_abs.starts_with(&canonical_cwd) {
        return Err("path escapes the working directory".to_string());
    }

    // ── Read file content ─────────────────────────────────────────────────────
    let (content, is_binary) = match std::fs::read(&abs_path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (text, false),
            Err(_) => (String::new(), true),
        },
        Err(e) => {
            // File might be deleted (tracked by git but gone on disk).
            // Return empty content rather than failing so the diff can still show.
            tracing::debug!(path = %path, error = %e, "git_file_view: could not read file");
            (String::new(), false)
        }
    };

    // ── Git diff ──────────────────────────────────────────────────────────────
    let diff_output = std::process::Command::new("git")
        .args(["-C", &cwd, "diff", "--", &path])
        .output()
        .map_err(|e| format!("failed to run git diff: {e}"))?;

    // git diff exits 0 on success; exit ≠ 0 is not fatal — fall back to empty diff.
    let diff = if diff_output.status.success() {
        String::from_utf8_lossy(&diff_output.stdout).into_owned()
    } else {
        String::new()
    };

    Ok(FileView {
        content,
        diff,
        is_binary,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplify_untracked() {
        let (code, staged) = simplify_status("??");
        assert_eq!(code, "?");
        assert!(!staged);
    }

    #[test]
    fn simplify_staged_add() {
        let (code, staged) = simplify_status("A ");
        assert_eq!(code, "A");
        assert!(staged);
    }

    #[test]
    fn simplify_unstaged_modify() {
        let (code, staged) = simplify_status(" M");
        assert_eq!(code, "M");
        assert!(!staged);
    }

    #[test]
    fn simplify_staged_modify() {
        let (code, staged) = simplify_status("M ");
        assert_eq!(code, "M");
        assert!(staged);
    }

    #[test]
    fn git_file_view_rejects_traversal() {
        let result = git_file_view("/tmp".to_string(), "../etc/passwd".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains(".."));
    }

    #[test]
    fn git_file_view_rejects_absolute_path() {
        let result = git_file_view("/tmp".to_string(), "/etc/passwd".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute"));
    }

    #[test]
    fn git_file_view_rejects_empty_path() {
        let result = git_file_view("/tmp".to_string(), String::new());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }
}
