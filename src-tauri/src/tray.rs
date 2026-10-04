
use tauri::{menu::{Menu, MenuItem}, tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState}, Manager};

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()) {
            log::warn!("Could not restore main window: {error}");
        }
    }
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open Network-path", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Network-path", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    #[cfg(target_os = "macos")]
    let pixels = include_bytes!("../icons/tray-template.rgba");
    #[cfg(not(target_os = "macos"))]
    let pixels = include_bytes!("../icons/tray.rgba");
    TrayIconBuilder::with_id("network-path")
        .icon(tauri::image::Image::new_owned(pixels.to_vec(), 32, 32))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Network-path")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_main(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
