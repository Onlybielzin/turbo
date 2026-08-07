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

/// Whether `program` is runnable from the current `PATH`.
///
/// - Unix: a file with that exact name exists in some `PATH` directory (the
///   original behaviour — a Unix executable is a bare-named file).
/// - Windows: resolves the way the OS does — trying the bare name and every
///   `PATHEXT` suffix (`.EXE`, `.CMD`, `.BAT`, …) in each `PATH` directory. This
///   is why the old bare-name check never saw a CLI installed as `claude.cmd`
///   (npm) or `claude.exe` (WinGet).
pub(crate) fn command_exists(program: &str) -> bool {
    #[cfg(windows)]
    {
        find_on_path(program).is_some()
    }
    #[cfg(not(windows))]
    {
        let Some(paths) = std::env::var_os("PATH") else {
            return false;
        };
        std::env::split_paths(&paths).any(|dir| dir.join(program).is_file())
    }
}

/// Resolve `program` into the actual `(program, prefix_args)` to hand to
/// `CommandBuilder`.
///
/// `CreateProcess` (what portable-pty calls on Windows) only auto-appends `.exe`
/// — it never finds `.cmd`/`.bat` shims and cannot execute them directly. So on
/// Windows we resolve the real file via `PATH` + `PATHEXT`; if it turns out to be
/// a script (`.cmd`/`.bat`), we spawn it through `cmd.exe /C <path>`, which is
/// what knows how to run those. Everything else — a resolved `.exe`, or any Unix
/// command — is passed straight through unchanged.
pub(crate) fn resolve_command(program: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        match find_on_path(program) {
            Some(path) => spawn_parts_for(&path),
            None => (program.to_string(), Vec::new()),
        }
    }
    #[cfg(not(windows))]
    {
        (program.to_string(), Vec::new())
    }
}

/// Locate `program` on `PATH`, honouring `PATHEXT`. Windows-only.
#[cfg(windows)]
fn find_on_path(program: &str) -> Option<PathBuf> {
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let candidates = command_candidates(program, &pathext);

    // Already a path (absolute or containing separators): probe the candidates
    // directly instead of walking `PATH`.
    let p = std::path::Path::new(program);
    if p.is_absolute() || p.components().count() > 1 {
        return candidates.into_iter().map(PathBuf::from).find(|c| c.is_file());
    }

    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        for cand in &candidates {
            let full = dir.join(cand);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// The filenames to probe for `program`, in priority order. If `program` already
/// carries an extension it is used as-is; otherwise each `PATHEXT` suffix is
/// appended after the bare name (the OS tries the bare name first).
#[cfg(any(windows, test))]
fn command_candidates(program: &str, pathext: &str) -> Vec<String> {
    if std::path::Path::new(program).extension().is_some() {
        return vec![program.to_string()];
    }
    let mut out = vec![program.to_string()];
    for ext in pathext.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        let dotted = if ext.starts_with('.') {
            ext.to_string()
        } else {
            format!(".{ext}")
        };
        out.push(format!("{program}{dotted}"));
    }
    out
}

/// Given a resolved executable path, produce the `(program, prefix_args)` to
/// spawn. `.cmd`/`.bat` scripts must run through `cmd.exe /C`; anything else runs
/// directly.
#[cfg(any(windows, test))]
fn spawn_parts_for(resolved: &std::path::Path) -> (String, Vec<String>) {
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if matches!(ext.as_deref(), Some("cmd") | Some("bat")) {
        (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), resolved.to_string_lossy().into_owned()],
        )
    } else {
        (resolved.to_string_lossy().into_owned(), Vec::new())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // ── command_candidates: how the OS name is expanded via PATHEXT ──────────

    #[test]
    fn candidates_append_every_pathext_suffix() {
        assert_eq!(
            command_candidates("claude", ".COM;.EXE;.BAT;.CMD"),
            vec![
                "claude".to_string(),
                "claude.COM".to_string(),
                "claude.EXE".to_string(),
                "claude.BAT".to_string(),
                "claude.CMD".to_string(),
            ]
        );
    }

    #[test]
    fn candidates_probe_bare_name_first() {
        // The bare name must be first so an extensionless binary still wins.
        let c = command_candidates("codex", ".EXE;.CMD");
        assert_eq!(c.first().map(String::as_str), Some("codex"));
    }

    #[test]
    fn candidates_keep_an_explicit_extension() {
        assert_eq!(
            command_candidates("claude.exe", ".EXE;.CMD"),
            vec!["claude.exe".to_string()]
        );
        assert_eq!(
            command_candidates("run.bat", ".EXE;.CMD"),
            vec!["run.bat".to_string()]
        );
    }

    #[test]
    fn candidates_skip_empty_pathext_entries() {
        assert_eq!(
            command_candidates("x", ".EXE;;.CMD;"),
            vec!["x".to_string(), "x.EXE".to_string(), "x.CMD".to_string()]
        );
    }

    #[test]
    fn candidates_normalize_pathext_without_leading_dot() {
        // Defensive: tolerate a PATHEXT whose entries lack the leading dot.
        assert_eq!(
            command_candidates("x", "EXE;CMD"),
            vec!["x".to_string(), "x.EXE".to_string(), "x.CMD".to_string()]
        );
    }

    // ── spawn_parts_for: scripts go through cmd.exe, exes run direct ─────────

    #[test]
    fn cmd_shim_runs_through_cmd_exe() {
        let (prog, args) =
            spawn_parts_for(Path::new(r"C:\Users\v\AppData\Roaming\npm\claude.cmd"));
        assert_eq!(prog, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/C".to_string(),
                r"C:\Users\v\AppData\Roaming\npm\claude.cmd".to_string(),
            ]
        );
    }

    #[test]
    fn bat_shim_runs_through_cmd_exe() {
        let (prog, args) = spawn_parts_for(Path::new(r"C:\tools\thing.BAT"));
        assert_eq!(prog, "cmd.exe");
        assert_eq!(args.first().map(String::as_str), Some("/C"));
    }

    #[test]
    fn exe_runs_directly_without_wrapper() {
        let (prog, args) =
            spawn_parts_for(Path::new(r"C:\Program Files\claude\claude.exe"));
        assert_eq!(prog, r"C:\Program Files\claude\claude.exe");
        assert!(args.is_empty());
    }

    // ── resolve_command: Unix must remain a pure passthrough ─────────────────

    #[test]
    #[cfg(not(windows))]
    fn unix_resolve_command_is_passthrough() {
        let (prog, args) = resolve_command("claude");
        assert_eq!(prog, "claude");
        assert!(args.is_empty());
    }
}
