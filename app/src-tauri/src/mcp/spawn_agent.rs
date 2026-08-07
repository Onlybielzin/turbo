//! spawn_agent PTY runner — runs a command in a PTY, captures all output, returns it.
//!
//! Phase 2 review fix: drive the PTY read loop via `tokio::task::spawn_blocking`
//! (not `std::thread::spawn`) so the JoinHandle is owned and can be aborted on
//! cancellation — no orphaned OS threads when the tokio task is dropped.
//!
//! The function is intentionally sync inside spawn_blocking to keep portable-pty's
//! blocking Read calls off the async runtime thread pool.

use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;

/// Run `command args` in a PTY (optionally in `cwd`, with `extra_env`),
/// collect every byte written to the PTY master, and return it as a
/// lossy-UTF-8 string once the child exits and is reaped.
///
/// This is meant to be called inside `tokio::task::spawn_blocking`.
/// It is synchronous and must not be called directly from an async context.
pub fn run_in_pty_blocking(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    extra_env: Vec<(String, String)>,
) -> Result<String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    if let Some(dir) = &cwd {
        cmd.cwd(dir);
    }
    // Fresh top-level Claude session: drop any inherited Claude Code env so the
    // spawned agent writes its own usage transcript (see pty_spawn in lib.rs).
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&k);
        }
    }
    for (k, v) in &extra_env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    // Use system libs, not the ones bundled in Turbo's AppImage mount (see
    // platform::sanitize_appimage_env) — otherwise the spawned `claude`/`codex`
    // and any tool it runs inherit a broken LD_LIBRARY_PATH.
    crate::platform::sanitize_appimage_env(&mut cmd);

    let mut child = pair.slave.spawn_command(cmd)?;
    // Drop slave so the master sees EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    let _ = child.wait();
    Ok(String::from_utf8_lossy(&buf).into_owned())
}
