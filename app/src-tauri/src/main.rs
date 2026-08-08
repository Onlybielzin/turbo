// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Wayland/Hyprland fix: WebKitGTK renders a blank window under the DMABUF
    // renderer on many Wayland + NVIDIA setups. Force it off before Tauri boots.
    // Must run before the Tauri builder — env must be set before WebKit init.
    //
    // NOTE (perf): this flag disables GPU-accelerated compositing, so WebKit
    // paints on the CPU — that is the root of the canvas paint cost. We tried
    // dropping it (keeping only __NV_DISABLE_EXPLICIT_SYNC=1) to get the GPU
    // path, but on this NVIDIA/Wayland box GBM buffer allocation fails
    // ("Failed to create GBM buffer ... Invalid argument") → blank window.
    // Re-enabling the GPU here needs system-level changes (nvidia_drm.modeset=1
    // + reboot, possibly GBM_BACKEND), not an app-side env tweak. Until then we
    // keep software rendering and reduce paint another way.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    app_lib::run()
}
