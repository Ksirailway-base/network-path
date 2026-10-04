pub mod bridge_server;
pub mod cdp_direct;
pub mod capture;
pub mod chrome_cdp;
pub mod har_import;
pub mod models;
pub mod repeater;
pub mod sessions;
pub mod storage;
pub mod traffic_processor;
mod tray;
#[cfg(windows)]
mod window_icons;

use serde_json::{json, Value};

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::bridge_server::BridgeServer;
use crate::chrome_cdp::{
    check_chrome_endpoint, fetch_open_tabs, find_chrome_executable, launch_chrome, CHROME_DEBUG_PORT,
};
use crate::models::{
    AppInitialState, CaptureProgress, ChromeStatusPayload, InFlightRequest, MockRule,
    SessionStats, TabSummary, WebSocketSendCommand, compute_capture_stage,
};
use crate::storage::{
    ensure_directory_structure, get_latest_session_dir, get_timestamp_slug,
    load_saved_requests_from_dir, load_summary_from_dir, StorageManager,
};
use crate::traffic_processor::TrafficProcessor;

pub static APP_HANDLE: once_cell::sync::OnceCell<AppHandle> = once_cell::sync::OnceCell::new();

pub struct AppState {
    pub capture: Arc<Mutex<capture::CaptureState>>,
    pub output_dir: Arc<Mutex<PathBuf>>,
    pub target_site_filter: Arc<Mutex<String>>,
    pub exclude_trackers: Arc<Mutex<bool>>,
    pub open_tabs: Arc<Mutex<Vec<TabSummary>>>,
    pub is_chrome_connected: Arc<AtomicBool>,
    pub is_extension_connected: Arc<AtomicBool>,
    pub last_extension_heartbeat: Arc<AtomicU64>,
    pub in_flight: Arc<Mutex<HashMap<String, InFlightRequest>>>,
    pub stats: Arc<Mutex<SessionStats>>,
    pub mock_rules: Arc<Mutex<Vec<MockRule>>>,
    pub pending_ws_commands: Arc<Mutex<Vec<WebSocketSendCommand>>>,
    pub bridge_error: Arc<Mutex<Option<String>>>,
    pub capture_progress: Arc<Mutex<CaptureProgress>>,
    pub delivery_stats: Arc<Mutex<serde_json::Value>>,
    pub intercept_paused: Arc<Mutex<Vec<serde_json::Value>>>,
    pub intercept_commands: Arc<Mutex<Vec<serde_json::Value>>>,
    pub throttle_command: Arc<Mutex<Option<serde_json::Value>>>,
    pub throttle_ack: Arc<Mutex<Option<serde_json::Value>>>,
    pub cdp_running: Arc<AtomicBool>,
    pub storage: StorageManager,
    pub processor: Arc<TrafficProcessor>,
}



fn stage_info(
    capture_enabled: bool,
    selected_tab: Option<i64>,
    is_ext: bool,
    progress: &CaptureProgress,
) -> (String, bool, bool) {
    let matches_target = selected_tab.is_some() && progress.tab_id == selected_tab;
    let attached = is_ext && capture_enabled && progress.attached && matches_target;
    let net = attached && progress.network_enabled;
    let stage = compute_capture_stage(is_ext, capture_enabled, attached, net);
    (stage.to_string(), attached, net)
}

#[tauri::command]
fn get_capture_state(state: State<'_, AppState>) -> Result<capture::CaptureState, String> {
    state.capture.lock().map(|c| c.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_capture_state(enabled: bool, tab_id: Option<i64>, state: State<'_, AppState>, app: AppHandle) -> Result<capture::CaptureState, String> {
    let updated = state.capture.lock().map_err(|e| e.to_string())?.update(enabled, tab_id)?;
    
    
    if let Ok(mut p) = state.capture_progress.lock() {
        *p = CaptureProgress::default();
    }
    let _ = app.emit("capture-state", &updated);
    Ok(updated)
}

#[tauri::command]
fn get_initial_state(state: State<'_, AppState>) -> AppInitialState {
    let output_dir = state.output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
    let target_site_filter = state.target_site_filter.lock().map(|f| f.clone()).unwrap_or_default();
    let exclude_trackers = state.exclude_trackers.lock().map(|e| *e).unwrap_or(true);
    let open_tabs = state.open_tabs.lock().map(|t| t.clone()).unwrap_or_default();
    let bridge_error = state.bridge_error.lock().map(|e| e.clone()).unwrap_or_default();

    let is_ext = state.is_extension_connected.load(Ordering::Relaxed);
    let is_port = state.is_chrome_connected.load(Ordering::Relaxed);

    let capture_enabled = state.capture.lock().map(|c| c.enabled).unwrap_or(false);
    let selected_tab = state.capture.lock().map(|c| c.selected_tab_id).unwrap_or(None);
    let progress = state.capture_progress.lock().map(|p| p.clone()).unwrap_or_default();
    let (capture_stage, target_attached, network_enabled) =
        stage_info(capture_enabled, selected_tab, is_ext, &progress);
    let delivery = state.delivery_stats.lock().map(|d| d.clone()).ok();

    let saved_requests = load_saved_requests_from_dir(&output_dir, 80);
    let loaded_stats = load_summary_from_dir(&output_dir).unwrap_or_else(|| {
        state.stats.lock().map(|s| s.clone()).unwrap_or_default()
    });

    AppInitialState {
        is_connected: is_ext || is_port,
        is_extension_connected: is_ext,
        is_port_connected: is_port,
        chrome_port: CHROME_DEBUG_PORT,
        current_output_dir: storage::display_path(&output_dir),
        target_site_filter,
        exclude_trackers,
        open_tabs,
        chrome_found: find_chrome_executable().is_some(),
        saved_requests,
        session_stats: loaded_stats,
        bridge_error,
        capture_stage,
        target_attached,
        network_enabled,
        delivery,
        browser_name: crate::chrome_cdp::primary_browser_name().to_string(),
    }
}

#[tauri::command]
fn check_connection(state: State<'_, AppState>) -> ChromeStatusPayload {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let last_hb = state.last_extension_heartbeat.load(Ordering::Relaxed);
    let is_ext = now.saturating_sub(last_hb) < 4000;
    state.is_extension_connected.store(is_ext, Ordering::Relaxed);

    
    let is_port = if is_ext {
        state.is_chrome_connected.load(Ordering::Relaxed)
    } else {
        check_chrome_endpoint().is_some()
    };
    state.is_chrome_connected.store(is_port, Ordering::Relaxed);

    if is_port && !is_ext {
        let tabs = fetch_open_tabs();
        if let Ok(mut ot) = state.open_tabs.lock() {
            if !tabs.is_empty() {
                *ot = tabs;
            }
        }
    }

    let output_dir = state.output_dir.lock().map(|d| storage::display_path(&d)).unwrap_or_default();
    let target_site_filter = state.target_site_filter.lock().map(|f| f.clone()).unwrap_or_default();
    let open_tabs = state.open_tabs.lock().map(|t| t.clone()).unwrap_or_default();
    let bridge_error = state.bridge_error.lock().map(|e| e.clone()).unwrap_or_default();

    let capture_enabled = state.capture.lock().map(|c| c.enabled).unwrap_or(false);
    let selected_tab = state.capture.lock().map(|c| c.selected_tab_id).unwrap_or(None);
    let progress = state.capture_progress.lock().map(|p| p.clone()).unwrap_or_default();
    let (capture_stage, target_attached, network_enabled) =
        stage_info(capture_enabled, selected_tab, is_ext, &progress);

    ChromeStatusPayload {
        is_connected: is_ext || is_port,
        is_extension_connected: is_ext,
        is_port_connected: is_port,
        chrome_port: CHROME_DEBUG_PORT,
        current_output_dir: output_dir,
        target_site_filter,
        open_tabs,
        bridge_error,
        capture_stage,
        target_attached,
        network_enabled,
        delivery: state.delivery_stats.lock().map(|d| d.clone()).ok(),
    }
}

#[tauri::command]
fn start_new_session(state: State<'_, AppState>, app: AppHandle) -> serde_json::Value {
    let base = storage::get_default_logs_base();
    let new_dir = base.join(format!("session_{}", get_timestamp_slug()));
    ensure_directory_structure(&new_dir);

    if let Ok(mut d) = state.output_dir.lock() {
        *d = new_dir.clone();
    }

    let new_stats = SessionStats {
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        ..SessionStats::default()
    };

    if let Ok(mut s) = state.stats.lock() {
        *s = new_stats.clone();
    }

    
    if let Ok(mut c) = state.capture.lock() {
        c.session_id = capture::new_session_id();
    }

    state.storage.write_summary(&new_dir, &new_stats);

    let _ = app.emit("load-saved-requests", serde_json::json!({
        "requests": [],
        "stats": new_stats,
        "outputDir": new_dir.to_string_lossy().to_string()
    }));
    let _ = app.emit("summary-updated", new_stats.clone());

    serde_json::json!({
        "currentOutputDir": storage::display_path(&new_dir),
        "sessionStats": new_stats
    })
}

#[tauri::command]
fn launch_chrome_app(target_url: Option<String>) -> Result<bool, String> {
    launch_chrome(&target_url.unwrap_or_default())
}

#[tauri::command]
fn reconnect_chrome(state: State<'_, AppState>) -> bool {
    let is_port = check_chrome_endpoint().is_some();
    state.is_chrome_connected.store(is_port, Ordering::Relaxed);
    is_port
}

#[tauri::command]
fn disconnect_chrome(state: State<'_, AppState>) -> bool {
    if let Ok(mut capture) = state.capture.lock() {
        let target = capture.selected_tab_id;
        let _ = capture.update(false, target);
    }
    if let Ok(mut p) = state.capture_progress.lock() {
        *p = CaptureProgress::default();
    }
    state.is_chrome_connected.store(false, Ordering::Relaxed);
    true
}

#[tauri::command]
fn set_site_filter(filter: String, state: State<'_, AppState>) -> bool {
    if let Ok(mut f) = state.target_site_filter.lock() {
        *f = filter;
    }
    true
}

#[tauri::command]
fn set_exclude_trackers(enabled: bool, state: State<'_, AppState>) -> bool {
    if let Ok(mut e) = state.exclude_trackers.lock() {
        *e = enabled;
    }
    true
}

#[tauri::command]
fn open_extension_folder(_app: AppHandle) -> bool {
    let ext_dir = crate::chrome_cdp::find_extension_dir()
        .unwrap_or_else(|| PathBuf::from("extension"));
    let _ = Command::new("explorer.exe").arg(ext_dir.to_string_lossy().to_string()).spawn();
    true
}

#[tauri::command]
async fn select_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let cur = state.output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog().file().set_directory(cur).pick_folder(move |dir_opt| {
        let _ = tx.send(dir_opt);
    });

    let chosen = rx.await.map_err(|e| e.to_string())?;
    if let Some(path_buf) = chosen {
        let path = path_buf.into_path().map_err(|e| format!("{:?}", e))?;
        ensure_directory_structure(&path);

        if let Ok(mut d) = state.output_dir.lock() {
            *d = path.clone();
        }

        let saved = load_saved_requests_from_dir(&path, 500);
        let loaded_stats = load_summary_from_dir(&path).unwrap_or_default();

        let path_str = storage::display_path(&path);
        let _ = app.emit("load-saved-requests", serde_json::json!({
            "requests": saved,
            "stats": loaded_stats,
            "outputDir": path_str
        }));

        return Ok(Some(path_str));
    }
    Ok(None)
}

#[tauri::command]
fn open_folder(folder_path: Option<String>, state: State<'_, AppState>) -> bool {
    let target = folder_path
        .map(PathBuf::from)
        .or_else(|| state.output_dir.lock().map(|d| d.clone()).ok())
        .unwrap_or_else(|| PathBuf::from("logs"));

    if target.is_file() {
        
        let abs_file = std::fs::canonicalize(&target).unwrap_or(target);
        let _ = Command::new("explorer.exe")
            .arg(format!("/select,{}", abs_file.to_string_lossy()))
            .spawn();
    } else {
        ensure_directory_structure(&target);
        let abs_dir = std::fs::canonicalize(&target).unwrap_or(target);
        let _ = Command::new("explorer.exe")
            .arg(abs_dir.to_string_lossy().to_string())
            .spawn();
    }
    true
}

#[tauri::command]
fn clear_logs() -> Result<(), String> {
    Err("Deleting saved sessions is disabled until file ownership can be verified. Use Clear view to clear the screen without deleting files.".to_string())
}

#[tauri::command]
fn export_summary(state: State<'_, AppState>) -> SessionStats {
    let output_dir = state.output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
    let st = state.stats.lock().map(|s| s.clone()).unwrap_or_default();
    state.storage.write_summary(&output_dir, &st);
    st
}



#[tauri::command]
fn import_har(json: String, state: State<'_, AppState>, app: AppHandle) -> Result<models::HarImportResult, String> {
    let parsed = har_import::parse_har(&json)?;
    if parsed.records.is_empty() {
        return Err("HAR contains no usable entries".to_string());
    }

    let base = storage::get_default_logs_base();
    let new_dir = base.join(format!("session_{}_import", get_timestamp_slug()));
    ensure_directory_structure(&new_dir);

    let stats = har_import::stats_for(&parsed.records);
    let import_session_id = format!("import-{}", get_timestamp_slug());
    for rec in &parsed.records {
        let url_slug = url::Url::parse(&rec.url)
            .ok()
            .map(|u| {
                let path = u.path().trim_start_matches('/');
                if path.is_empty() { u.host_str().unwrap_or("req").to_string() } else { path.replace('/', "_") }
            })
            .unwrap_or_else(|| "req".to_string());
        let file_name = format!(
            "{}_{}_{}_{}_{}.json",
            chrono::Utc::now().timestamp_millis(),
            storage::sanitize_filename(&rec.id),
            rec.method,
            rec.status,
            storage::sanitize_filename(&url_slug)
        );
        let mut stored = rec.clone();
        stored.session_id = Some(import_session_id.clone());
        stored.saved_file = storage::save_detailed_record(&new_dir, &rec.resource_type, &file_name, &stored);
        state.storage.append_request(&new_dir, &stored);
    }
    state.storage.write_summary(&new_dir, &stats);

    if let Ok(mut d) = state.output_dir.lock() {
        *d = new_dir.clone();
    }
    if let Ok(mut s) = state.stats.lock() {
        *s = stats.clone();
    }

    let dir_str = storage::display_path(&new_dir);
    let _ = app.emit("load-saved-requests", serde_json::json!({
        "requests": parsed.records,
        "stats": stats,
        "outputDir": dir_str
    }));

    Ok(models::HarImportResult {
        output_dir: dir_str,
        imported: parsed.records.len(),
        skipped: parsed.skipped,
        session_stats: stats,
    })
}

#[tauri::command]
fn save_export_file(state: State<'_, AppState>, filename: String, content: String) -> Result<String, String> {
    let output_dir = state.output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
    match storage::save_export_sync(&output_dir, &filename, &content) {
        Ok(path) => Ok(path.to_string_lossy().to_string()),
        Err(e) => Err(format!("Failed to write export file: {}", e)),
    }
}

#[tauri::command]
fn send_repeater_request(request: models::RepeaterRequest) -> models::RepeaterResponse {
    repeater::execute_repeater_request(request)
}

#[tauri::command]
fn get_mock_rules(state: State<'_, AppState>) -> Vec<MockRule> {
    state.mock_rules.lock().map(|r| r.clone()).unwrap_or_default()
}

#[tauri::command]
fn save_mock_rules(rules: Vec<MockRule>, state: State<'_, AppState>, app: AppHandle) -> Result<bool, String> {
    if let Err(e) = storage::save_mock_rules_to(&storage::mock_rules_file(), &rules) {
        log::error!("mock rules persistence failed: {}", e);
        return Err(e);
    }
    if let Ok(mut r) = state.mock_rules.lock() {
        *r = rules.clone();
    }
    let _ = app.emit("mock-rules-updated", rules);
    Ok(true)
}

#[tauri::command]
fn send_websocket_message() -> Result<(), String> {
    Err("WebSocket sending is unsupported; observed frames are read-only.".to_string())
}

#[tauri::command]
fn set_intercept(enabled: bool, state: State<'_, AppState>, app: AppHandle) -> Result<capture::CaptureState, String> {
    let updated = {
        let mut c = state.capture.lock().map_err(|e| e.to_string())?;
        c.intercept_enabled = enabled;
        c.revision += 1;
        c.clone()
    };
    let _ = app.emit("capture-state", &updated);
    Ok(updated)
}

#[tauri::command]
fn intercept_resolve(request: Value, state: State<'_, AppState>, app: AppHandle) -> Result<bool, String> {
    let request_id = request.get("requestId").and_then(|v| v.as_str()).ok_or("requestId required")?.to_string();
    let action = request.get("action").and_then(|v| v.as_str()).ok_or("action required")?.to_string();
    match action.as_str() {
        "forward" | "forward-edited" | "drop" | "fulfill" => {}
        other => return Err(format!("unknown intercept action: {}", other)),
    }
    
    if let Ok(mut paused) = state.intercept_paused.lock() {
        paused.retain(|p| p.get("requestId").and_then(|v| v.as_str()) != Some(request_id.as_str()));
    }
    if let Ok(mut commands) = state.intercept_commands.lock() {
        commands.push(request);
    }
    let _ = app.emit("intercept-resolved", json!({ "requestId": request_id }));
    Ok(true)
}



fn read_fulfill_file_inner(path: &str) -> Result<Value, String> {
    let p = std::path::PathBuf::from(path);
    if !p.is_file() {
        return Err("not a file".to_string());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("file too large for fulfill (10 MB limit)".to_string());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "json" => "application/json", "css" => "text/css", "js" | "mjs" => "application/javascript",
        "html" | "htm" => "text/html", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif", "webp" => "image/webp", "svg" => "image/svg+xml", "txt" => "text/plain",
        _ => "application/octet-stream",
    };
    Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes), "size": bytes.len(), "mime": mime }))
}

#[tauri::command]
fn read_fulfill_file(path: String) -> Result<Value, String> {
    read_fulfill_file_inner(&path)
}

#[tauri::command]
fn list_intercept_paused(state: State<'_, AppState>) -> Vec<Value> {
    state.intercept_paused.lock().map(|p| p.clone()).unwrap_or_default()
}

#[tauri::command]
fn list_sessions() -> Vec<sessions::SessionInfo> {
    let base = storage::get_default_logs_base();
    sessions::list_sessions_in(&base)
}

#[tauri::command]
fn open_session(name: String, state: State<'_, AppState>, app: AppHandle) -> Result<String, String> {
    
    if state.capture.lock().map(|c| c.enabled).unwrap_or(false) {
        return Err("Stop capture before switching sessions".to_string());
    }
    let base = storage::get_default_logs_base();
    let dir = sessions::session_dir(&base, &name).ok_or_else(|| format!("session not found: {}", name))?;

    if let Ok(mut d) = state.output_dir.lock() {
        *d = dir.clone();
    }
    let saved = load_saved_requests_from_dir(&dir, 500);
    let loaded_stats = load_summary_from_dir(&dir).unwrap_or_default();
    if let Ok(mut s) = state.stats.lock() {
        *s = loaded_stats.clone();
    }
    let dir_str = storage::display_path(&dir);
    let _ = app.emit("load-saved-requests", serde_json::json!({
        "requests": saved,
        "stats": loaded_stats,
        "outputDir": dir_str
    }));
    Ok(dir_str)
}

#[tauri::command]
fn start_cdp_direct(target_url: Option<String>) -> Result<Value, String> {
    let shared = cdp_shared()?;
    cdp_direct::start(target_url.unwrap_or_default(), shared)
}

#[tauri::command]
fn stop_cdp_direct() -> Result<bool, String> {
    let shared = cdp_shared()?;
    cdp_direct::stop(&shared);
    Ok(true)
}

fn cdp_shared() -> Result<cdp_direct::CdpShared, String> {
    let handle = APP_HANDLE.get().ok_or("app not initialized")?;
    let state = handle.state::<AppState>();
    Ok(cdp_direct::CdpShared {
        capture: Arc::clone(&state.capture),
        output_dir: Arc::clone(&state.output_dir),
        stats: Arc::clone(&state.stats),
        mock_rules: Arc::clone(&state.mock_rules),
        intercept_paused: Arc::clone(&state.intercept_paused),
        intercept_commands: Arc::clone(&state.intercept_commands),
        throttle_command: Arc::clone(&state.throttle_command),
        processor: Arc::clone(&state.processor),
        app: handle.clone(),
        is_running: Arc::clone(&state.cdp_running),
    })
}



#[tauri::command]
fn delete_session(name: String, state: State<'_, AppState>) -> Result<String, String> {
    if state.capture.lock().map(|c| c.enabled).unwrap_or(false) {
        return Err("Stop capture before deleting a session".to_string());
    }
    let base = storage::get_default_logs_base();
    let target = sessions::delete_session_to_trash(&base, &name)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn list_trash() -> Vec<sessions::TrashItem> {
    sessions::list_trash_in(&storage::get_default_logs_base())
}

#[tauri::command]
fn search_sessions(query: String) -> sessions::SearchResults {
    let (res,) = sessions::search_sessions_in(&storage::get_default_logs_base(), &query);
    res
}

#[tauri::command]
fn empty_trash(state: State<'_, AppState>) -> Result<usize, String> {
    if state.capture.lock().map(|c| c.enabled).unwrap_or(false) {
        return Err("Stop capture before emptying the trash".to_string());
    }
    sessions::empty_trash_in(&storage::get_default_logs_base())
}

#[tauri::command]
fn compare_sessions(session_a: String, session_b: String) -> Result<sessions::SessionCompare, String> {
    let base = storage::get_default_logs_base();
    sessions::compare_sessions_in(&base, &session_a, &session_b)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let capture = Arc::new(Mutex::new(capture::CaptureState::default()));
    let output_dir = Arc::new(Mutex::new(get_latest_session_dir()));
    let target_site_filter = Arc::new(Mutex::new(String::new()));
    let exclude_trackers = Arc::new(Mutex::new(true));
    let open_tabs = Arc::new(Mutex::new(Vec::new()));
    let is_chrome_connected = Arc::new(AtomicBool::new(false));
    let is_extension_connected = Arc::new(AtomicBool::new(false));
    let last_extension_heartbeat = Arc::new(AtomicU64::new(0));
    let in_flight = Arc::new(Mutex::new(HashMap::new()));
    let stats = Arc::new(Mutex::new(SessionStats::default()));
    let mock_rules = Arc::new(Mutex::new(storage::load_mock_rules_from(&storage::mock_rules_file())));
    let pending_ws_commands = Arc::new(Mutex::new(Vec::new()));
    let bridge_error = Arc::new(Mutex::new(None));
    let capture_progress = Arc::new(Mutex::new(CaptureProgress::default()));
    let delivery_stats = Arc::new(Mutex::new(serde_json::json!({"queued":0,"backlogBytes":0,"dropped":0,"sent":0})));
    let intercept_paused = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let intercept_commands = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let throttle_command = Arc::new(Mutex::new(None));
    let throttle_ack = Arc::new(Mutex::new(None));
    let last_seq: Arc<Mutex<std::collections::HashMap<i64, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let cdp_running = Arc::new(AtomicBool::new(false));
    let bridge_token = Arc::new(Mutex::new(bridge_server::generate_bridge_token()));
    let storage = StorageManager::new();

    
    if let Ok(d) = output_dir.lock() {
        ensure_directory_structure(&d);
    }

    
    match sessions::purge_old_trash_in(&storage::get_default_logs_base(), 7) {
        Ok(n) if n > 0 => log::info!("startup: purged {} expired trash session(s)", n),
        Ok(_) => {}
        Err(e) => log::warn!("startup trash purge: {}", e),
    }

    let out_dir_clone = Arc::clone(&output_dir);
    let filter_clone = Arc::clone(&target_site_filter);
    let trackers_clone = Arc::clone(&exclude_trackers);
    let tabs_clone = Arc::clone(&open_tabs);
    let is_ext_clone = Arc::clone(&is_extension_connected);
    let last_hb_clone = Arc::clone(&last_extension_heartbeat);
    let in_flight_clone = Arc::clone(&in_flight);
    let stats_clone = Arc::clone(&stats);
    let mock_rules_clone = Arc::clone(&mock_rules);
    let pending_ws_clone = Arc::clone(&pending_ws_commands);
    let bridge_error_clone = Arc::clone(&bridge_error);
    let progress_bridge_clone = Arc::clone(&capture_progress);
    let delivery_bridge_clone = Arc::clone(&delivery_stats);
    let intercept_paused_bridge = Arc::clone(&intercept_paused);
    let intercept_commands_bridge = Arc::clone(&intercept_commands);
    let throttle_bridge = Arc::clone(&throttle_command);
    let throttle_ack_bridge = Arc::clone(&throttle_ack);
    let last_seq_bridge = Arc::clone(&last_seq);
    let stats_bridge = Arc::clone(&stats);
    let cdp_running_bridge = Arc::clone(&cdp_running);
    let bridge_token_bridge = Arc::clone(&bridge_token);
    let storage_clone = storage.clone();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            #[cfg(windows)]
            window_icons::install(app);
            
            if let Err(error) = tray::install(app) {
                log::warn!("System tray unavailable: {error}");
            }
            let handle = app.handle().clone();

            let processor = Arc::new(TrafficProcessor::new(
                Arc::clone(&in_flight_clone),
                Arc::clone(&stats_clone),
                storage_clone.clone(),
                handle.clone(),
            ));

            
            let bridge_res = BridgeServer::start(
                Arc::clone(&capture),
                Arc::clone(&out_dir_clone),
                Arc::clone(&filter_clone),
                Arc::clone(&trackers_clone),
                Arc::clone(&tabs_clone),
                Arc::clone(&is_ext_clone),
                Arc::clone(&last_hb_clone),
                Arc::clone(&mock_rules_clone),
                Arc::clone(&pending_ws_clone),
                Arc::clone(&progress_bridge_clone),
                Arc::clone(&delivery_bridge_clone),
                Arc::clone(&intercept_paused_bridge),
                Arc::clone(&intercept_commands_bridge),
                Arc::clone(&throttle_bridge),
                Arc::clone(&throttle_ack_bridge),
                Arc::clone(&bridge_token_bridge),
                Arc::clone(&last_seq_bridge),
                Arc::clone(&cdp_running_bridge),
                Arc::clone(&stats_bridge),
                Arc::clone(&processor),
                handle.clone(),
            );

            let _ = APP_HANDLE.set(handle.clone());
            if let Err(ref e) = bridge_res {
                log::error!("CRITICAL: {}", e);
                if let Ok(mut be) = bridge_error_clone.lock() {
                    *be = Some(e.clone());
                }
            }

            
            app.manage(AppState {
                capture: Arc::clone(&capture),
                output_dir: Arc::clone(&out_dir_clone),
                target_site_filter: Arc::clone(&filter_clone),
                exclude_trackers: Arc::clone(&trackers_clone),
                open_tabs: Arc::clone(&tabs_clone),
                is_chrome_connected: Arc::clone(&is_chrome_connected),
                is_extension_connected: Arc::clone(&is_ext_clone),
                last_extension_heartbeat: Arc::clone(&last_hb_clone),
                in_flight: in_flight_clone,
                stats: stats_clone,
                mock_rules,
                pending_ws_commands,
                bridge_error: Arc::clone(&bridge_error),
                capture_progress: Arc::clone(&capture_progress),
                delivery_stats: Arc::clone(&delivery_stats),
                intercept_paused: Arc::clone(&intercept_paused),
                intercept_commands: Arc::clone(&intercept_commands),
                cdp_running: Arc::clone(&cdp_running),
                throttle_command: Arc::clone(&throttle_command),
                throttle_ack: Arc::clone(&throttle_ack),
                storage: storage_clone,
                processor,
            });

            
            let handle_clone = handle.clone();
            let out_dir_wd = Arc::clone(&out_dir_clone);
            let filter_wd = Arc::clone(&filter_clone);
            let tabs_wd = Arc::clone(&tabs_clone);
            let is_ext_wd = Arc::clone(&is_ext_clone);
            let last_hb_wd = Arc::clone(&last_hb_clone);
            let is_port_wd = Arc::clone(&is_chrome_connected);
            let bridge_error_wd = Arc::clone(&bridge_error);
            let capture_wd = Arc::clone(&capture);
            let progress_wd = Arc::clone(&capture_progress);
            let delivery_wd = Arc::clone(&delivery_stats);

            thread::spawn(move || loop {
                if let Ok(capture_state) = capture_wd.lock() {
                    let _ = handle_clone.emit("capture-state", capture_state.clone());
                }
                thread::sleep(Duration::from_millis(1000));
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                let last_hb = last_hb_wd.load(Ordering::Relaxed);
                let ext_active = now.saturating_sub(last_hb) < 4000;
                is_ext_wd.store(ext_active, Ordering::Relaxed);

                let port_active = is_port_wd.load(Ordering::Relaxed);
                let cur_dir = out_dir_wd.lock().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
                let cur_filter = filter_wd.lock().map(|f| f.clone()).unwrap_or_default();
                let cur_tabs = tabs_wd.lock().map(|t| t.clone()).unwrap_or_default();
                let cur_bridge_err = bridge_error_wd.lock().map(|e| e.clone()).unwrap_or_default();

                let (capture_enabled, selected_tab) = capture_wd.lock().map(|c| (c.enabled, c.selected_tab_id)).unwrap_or((false, None));
                let progress = progress_wd.lock().map(|p| p.clone()).unwrap_or_default();
                let (capture_stage, target_attached, network_enabled) =
                    stage_info(capture_enabled, selected_tab, ext_active, &progress);
                let delivery = delivery_wd.lock().map(|d| d.clone()).unwrap_or_default();

                let _ = handle_clone.emit(
                    "chrome-status",
                    ChromeStatusPayload {
                        is_connected: ext_active || port_active,
                        is_extension_connected: ext_active,
                        is_port_connected: port_active,
                        chrome_port: CHROME_DEBUG_PORT,
                        current_output_dir: cur_dir,
                        target_site_filter: cur_filter,
                        open_tabs: cur_tabs,
                        bridge_error: cur_bridge_err,
                        capture_stage,
                        target_attached,
                        network_enabled,
                        delivery: Some(delivery),
                    },
                );
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_capture_state,
            set_capture_state,
            get_initial_state,
            check_connection,
            start_new_session,
            launch_chrome_app,
            reconnect_chrome,
            disconnect_chrome,
            set_site_filter,
            set_exclude_trackers,
            open_extension_folder,
            select_folder,
            open_folder,
            clear_logs,
            export_summary,
            import_har,
            save_export_file,
            send_repeater_request,
            set_intercept,
            intercept_resolve,
            list_intercept_paused,
            read_fulfill_file,
            list_sessions,
            open_session,
            delete_session,
            list_trash,
            search_sessions,
            start_cdp_direct,
            stop_cdp_direct,
            empty_trash,
            compare_sessions,
            get_mock_rules,
            save_mock_rules,
            send_websocket_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::stage_info;
    use crate::models::CaptureProgress;

    fn progress(tab_id: Option<i64>, attached: bool, network: bool) -> CaptureProgress {
        CaptureProgress { tab_id, attached, network_enabled: network, last_error: None, updated_at_ms: 0 }
    }

    #[test]
    fn stage_requires_progress_for_the_selected_target() {
        
        let (stage, attached, net) = stage_info(true, Some(7), true, &progress(Some(9), true, true));
        assert_eq!(stage, "target_pending");
        assert!(!attached);
        assert!(!net);

        
        let (stage, attached, net) = stage_info(true, Some(7), true, &progress(Some(7), true, true));
        assert_eq!(stage, "recording");
        assert!(attached && net);

        
        let (stage, _, _) = stage_info(true, Some(7), false, &progress(Some(7), true, true));
        assert_eq!(stage, "waiting_extension");

        
        let (stage, _, _) = stage_info(false, Some(7), true, &progress(Some(7), true, true));
        assert_eq!(stage, "ready");
    }
}


#[cfg(test)]
mod fulfill_file_tests {
    #[test]
    fn read_fulfill_file_validates_paths_and_sizes() {
        let dir = std::path::PathBuf::from(format!("target/fulfill_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("style.css");
        std::fs::write(&file, "body{}").unwrap();
        
        assert!(super::read_fulfill_file_inner(dir.to_str().unwrap()).is_err());
        
        let res = super::read_fulfill_file_inner(file.to_str().unwrap()).unwrap();
        assert_eq!(res["mime"], "text/css");
        assert_eq!(res["size"], 6);
        
        assert!(super::read_fulfill_file_inner("target/does-not-exist-xyz.css").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
