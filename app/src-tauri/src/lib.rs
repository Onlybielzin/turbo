// Turbo — Phase 1 Foundation: PTY bridge.
//
// A minimal, non-blocking PTY manager exposed to the webview via Tauri commands.
// Output streams to the frontend through a per-spawn `Channel<Vec<u8>>` (raw bytes
// so xterm.js decodes UTF-8 across chunk boundaries); input, resize and kill are
// commands. All child processes are killed on window close (no orphans).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

/// One live PTY: the write side, the master (for resize) and a killer handle.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyManager {
    /// Kill every live child and clear the table. Idempotent.
    fn kill_all(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            for (_, mut session) in map.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Spawn a PTY-backed process and stream its output to `on_data`.
/// Returns the pty id used by the other commands.
#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    manager: State<PtyManager>,
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_data: Channel<Vec<u8>>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let shell = command
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
    let mut cmd = CommandBuilder::new(shell);
    if let Some(a) = args {
        cmd.args(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is not needed once the child owns it; dropping it lets the
    // master see EOF when the child exits.
    drop(pair.slave);

    let master = pair.master;
    let killer = child.clone_killer();
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    let id = manager.next_id.fetch_add(1, Ordering::SeqCst);

    // portable-pty's reader is blocking, so it runs on a dedicated OS thread
    // (never on the async runtime). Raw bytes go straight to the frontend.
    let app_reader = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_reader.emit("pty_exit", id);
    });

    // Reap the child so it never becomes a zombie.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });

    manager.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master,
            killer,
        },
    );

    Ok(id)
}

/// Write keyboard input (UTF-8) to a pty.
#[tauri::command]
fn pty_write(manager: State<PtyManager>, id: u32, data: String) -> Result<(), String> {
    let mut map = manager.sessions.lock().unwrap();
    let session = map.get_mut(&id).ok_or("pty not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a pty (sends SIGWINCH to the child).
#[tauri::command]
fn pty_resize(manager: State<PtyManager>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = manager.sessions.lock().unwrap();
    let session = map.get(&id).ok_or("pty not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill a pty's child and drop the session.
#[tauri::command]
fn pty_kill(manager: State<PtyManager>, id: u32) -> Result<(), String> {
    let mut map = manager.sessions.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.state::<PtyManager>().kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
