use tauri::{Manager, WindowEvent};
use std::sync::Mutex;
use windows_sys::Win32::{
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi}, WindowsAndMessaging::{
        DestroyIcon, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        SM_CXICON, SM_CYICON, SM_CXSMICON, SM_CYSMICON, WM_SETICON,
    }},
};

static ICON_HANDLES: Mutex<[usize; 2]> = Mutex::new([0; 2]);

fn apply(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?.0;
    let mut handles = ICON_HANDLES.lock().map_err(|_| std::io::Error::other("icon lock poisoned"))?;
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let dpi = GetDpiForWindow(hwnd).max(96);
        for (kind, x, y) in [(ICON_SMALL, SM_CXSMICON, SM_CYSMICON), (ICON_BIG, SM_CXICON, SM_CYICON)] {
            let width = GetSystemMetricsForDpi(x, dpi);
            let height = GetSystemMetricsForDpi(y, dpi);
            let icon = LoadImageW(module, 32512usize as *const u16, IMAGE_ICON, width, height, 0);
            if icon.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            let previous = std::mem::replace(&mut handles[kind as usize], icon as usize);
            if previous != 0 {
                DestroyIcon(previous as _);
            }
        }
    }
    Ok(())
}

pub fn install(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = apply(&window) {
            log::warn!("Could not load native window icons: {error}");
        }
        let dpi_window = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
                if let Err(error) = apply(&dpi_window) {
                    log::warn!("Could not refresh window icons for DPI: {error}");
                }
            }
        });
    }
}
