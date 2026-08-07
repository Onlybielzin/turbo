//! Cross-platform helpers so Turbo runs on both Linux and Windows.
//!
//! The rest of the backend was written Unix-first (`$HOME`, `/bin/bash`). These
//! helpers isolate the two OS-specific lookups — the home directory and the
//! default interactive shell — so every call site stays portable.

use std::path::PathBuf;

/// The user's home directory.
///
/// - Unix: `$HOME`.
/// - Windows: `%USERPROFILE%`, falling back to `%HOMEDRIVE%%HOMEPATH%`, then
///   `%HOME%` (some shells set it). Used to locate the agent CLIs' on-disk data
///   (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/models_cache.json`).
pub(crate) fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("USERPROFILE") {
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            let mut joined = std::ffi::OsString::from(drive);
            joined.push(path);
            return Some(PathBuf::from(joined));
        }
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The default interactive shell to spawn when a plain terminal is opened
/// without an explicit command.
///
/// - Unix: `$SHELL`, falling back to `/bin/bash`.
/// - Windows: `%COMSPEC%` (normally `cmd.exe`), falling back to `cmd.exe`.
pub(crate) fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}
