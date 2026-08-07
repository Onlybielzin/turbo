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

/// Strip AppImage runtime pollution from a child command's environment.
///
/// When Turbo runs as an AppImage, its `AppRun` launcher prepends the mount's
/// bundled libraries to `LD_LIBRARY_PATH` (and sets `LD_PRELOAD`, GTK/GIO module
/// paths, etc.) so Turbo's own binary finds the libs it was built against. Any
/// process we spawn into a PTY — a login shell, then `cargo`, `git`, `npm` — would
/// inherit that and load the AppImage's `libcurl` / `libpcre2` / ... instead of the
/// system ones, failing with `undefined symbol` or `no version information
/// available`. We drop every search-path segment that points inside the AppImage
/// mount so terminals see a clean, system environment.
///
/// No-op when not launched from an AppImage (the `APPDIR` env var is absent), and
/// on Windows where AppImages don't exist.
#[cfg(not(windows))]
pub(crate) fn sanitize_appimage_env(cmd: &mut portable_pty::CommandBuilder) {
    // Only act when we were launched from an AppImage. `APPDIR` is set by AppRun.
    if std::env::var_os("APPDIR").is_none() && std::env::var_os("APPIMAGE").is_none() {
        return;
    }

    // A path segment belongs to an AppImage mount if it lives under one. AppImage
    // runtimes mount at `/tmp/.mount_<name>` — matching `/.mount_` catches every
    // mount at once, including the nested second mount seen when Turbo is launched
    // from inside another AppImage (`$APPDIR` alone would miss it).
    let in_mount = |seg: &str| seg.contains("/.mount_");

    // Colon-separated search paths: keep only segments outside any AppImage mount.
    const LIST_VARS: &[&str] = &[
        "LD_LIBRARY_PATH",
        "PATH",
        "XDG_DATA_DIRS",
        "GTK_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GIO_MODULE_DIR",
        "GIO_EXTRA_MODULES",
        "GSETTINGS_SCHEMA_DIR",
        "PYTHONPATH",
        "PERLLIB",
        "PERL5LIB",
        "QT_PLUGIN_PATH",
    ];
    for var in LIST_VARS {
        let Ok(val) = std::env::var(var) else { continue };
        let cleaned: Vec<&str> = val
            .split(':')
            .filter(|seg| !seg.is_empty() && !in_mount(seg))
            .collect();
        if cleaned.is_empty() {
            cmd.env_remove(var);
        } else {
            cmd.env(var, cleaned.join(":"));
        }
    }

    // Single-value vars pointing into a mount: drop them entirely.
    const DROP_IF_IN_MOUNT: &[&str] = &[
        "LD_PRELOAD",
        "PYTHONHOME",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_PIXBUF_MODULEDIR",
        "GTK_IM_MODULE_FILE",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "FONTCONFIG_FILE",
        "FONTCONFIG_PATH",
    ];
    for var in DROP_IF_IN_MOUNT {
        if let Ok(val) = std::env::var(var) {
            if in_mount(&val) {
                cmd.env_remove(var);
            }
        }
    }

    // AppImage self-identification vars — safe to drop, and stops appimage-aware
    // child tools from re-deriving the polluted paths.
    for var in ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] {
        cmd.env_remove(var);
    }
}

/// Windows has no AppImage runtime — nothing to sanitize.
#[cfg(windows)]
pub(crate) fn sanitize_appimage_env(_cmd: &mut portable_pty::CommandBuilder) {}
