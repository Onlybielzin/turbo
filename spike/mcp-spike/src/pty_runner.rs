//! Run a command inside a PTY and capture its full output until exit.
//!
//! `portable-pty`'s reader is blocking, so the whole thing runs on a dedicated
//! OS thread and hands the result back through a oneshot — the caller `.await`s
//! without ever blocking the tokio runtime.

use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;

/// Spawn `command args` in a PTY (optionally in `cwd`, with `extra_env`),
/// collect everything it writes, and return it as a lossy-UTF-8 string once the
/// child exits. The child is reaped (no zombies).
pub async fn run_to_completion(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    extra_env: Vec<(String, String)>,
) -> Result<String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String>>();

    std::thread::spawn(move || {
        let result = (|| -> Result<String> {
            let pty_system = native_pty_system();
            let pair = pty_system.openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })?;

            let mut cmd = CommandBuilder::new(command);
            cmd.args(args);
            if let Some(dir) = cwd {
                cmd.cwd(dir);
            }
            for (k, v) in extra_env {
                cmd.env(k, v);
            }
            cmd.env("TERM", "xterm-256color");

            let mut child = pair.slave.spawn_command(cmd)?;
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
        })();
        let _ = tx.send(result);
    });

    rx.await?
}
