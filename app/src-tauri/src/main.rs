// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Wayland/Hyprland fix: WebKitGTK renders a blank window under the DMABUF
    // renderer on many Wayland + NVIDIA setups. Force it off before Tauri boots.
    // Must run before the Tauri builder — env must be set before WebKit init.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run()
}
