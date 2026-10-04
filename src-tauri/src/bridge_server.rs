use std::path::PathBuf;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server};

use crate::models::{CaptureProgress, MockRule, TabSummary, WebSocketSendCommand};
use crate::traffic_processor::TrafficProcessor;

pub const HTTP_BRIDGE_PORT: u16 = 8765;




pub fn generate_bridge_token() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let pid = std::process::id();
    format!("npt-{pid:08x}-{nanos:016x}-{:08x}", (nanos as u64).wrapping_mul(0x9E3779B97F4A7C15) >> 32)
}

fn token_ok(expected: Option<&str>, got: Option<&str>) -> bool {
    match (expected, got) {
        (Some(exp), Some(got)) => exp == got,
        _ => false,
    }
}

const MAX_MOCK_RULES_BODY: usize = 1 * 1024 * 1024;
const MAX_LAUNCH_BODY: usize = 4096;
const MAX_TRAFFIC_BODY: usize = 48 * 1024 * 1024;




fn allowed_origin(origin: &str) -> Option<&str> {
    if origin.starts_with("chrome-extension://") || origin == "null" {
        return Some(origin);
    }
    for base in ["http://127.0.0.1", "http://localhost"] {
        if origin == base || origin.starts_with(&format!("{}:", base)) {
            return Some(origin);
        }
    }
    None
}


fn host_allowed(headers: &[tiny_http::Header]) -> bool {
    headers.iter().any(|h| {
        h.field.as_str().as_bytes().eq_ignore_ascii_case(b"Host")
            && {
                let v = h.value.as_str();
                v.eq_ignore_ascii_case(&format!("127.0.0.1:{}", HTTP_BRIDGE_PORT))
                    || v.eq_ignore_ascii_case(&format!("localhost:{}", HTTP_BRIDGE_PORT))
            }
    })
}


fn read_capped(request: &mut tiny_http::Request, max: usize, out: &mut String) -> Result<(), ()> {
    let mut taken = request.as_reader().take(max as u64 + 1);
    let _ = taken.read_to_string(out);
    if out.len() > max {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{allowed_origin, host_allowed};
    use tiny_http::Header;

    fn header(name: &str, value: &str) -> Header {
        Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
    }

    #[test]
    fn origin_allowlist_is_exact_not_prefix() {
        assert!(allowed_origin("chrome-extension://abcdefg").is_some());
        assert!(allowed_origin("http://127.0.0.1").is_some());
        assert!(allowed_origin("http://127.0.0.1:3000").is_some());
        assert!(allowed_origin("http://localhost:5173").is_some());
        assert!(allowed_origin("null").is_some());
        
        assert!(allowed_origin("http://127.0.0.1.evil.com").is_none());
        assert!(allowed_origin("http://localhost.attacker.io").is_none());
        assert!(allowed_origin("https://example.com").is_none());
    }

    #[test]
    fn host_header_must_match_bridge_port() {
        let ok = vec![header("Host", "127.0.0.1:8765")];
        let ok_localhost = vec![header("host", "localhost:8765")];
        let rebound = vec![header("Host", "evil.com:8765")];
        let wrong_port = vec![header("Host", "127.0.0.1:9999")];
        assert!(host_allowed(&ok));
        assert!(host_allowed(&ok_localhost));
        assert!(!host_allowed(&rebound));
        assert!(!host_allowed(&wrong_port));
        assert!(!host_allowed(&[]));
    }
}

#[allow(dead_code)]
pub struct BridgeServer {
    server: Arc<Server>,
    is_running: Arc<AtomicBool>,
}

impl BridgeServer {
    pub fn start(
        capture: Arc<Mutex<crate::capture::CaptureState>>,
        output_dir: Arc<Mutex<PathBuf>>,
        target_site_filter: Arc<Mutex<String>>,
        exclude_trackers: Arc<Mutex<bool>>,
        open_tabs: Arc<Mutex<Vec<TabSummary>>>,
        is_extension_connected: Arc<AtomicBool>,
        last_extension_heartbeat: Arc<AtomicU64>,
        mock_rules: Arc<Mutex<Vec<MockRule>>>,
        pending_ws_commands: Arc<Mutex<Vec<WebSocketSendCommand>>>,
        capture_progress: Arc<Mutex<CaptureProgress>>,
        delivery_stats: Arc<Mutex<serde_json::Value>>,
        intercept_paused: Arc<Mutex<Vec<serde_json::Value>>>,
        intercept_commands: Arc<Mutex<Vec<serde_json::Value>>>,
        throttle_command: Arc<Mutex<Option<serde_json::Value>>>,
        throttle_ack: Arc<Mutex<Option<serde_json::Value>>>,
        bridge_token: Arc<Mutex<String>>,
        last_seq: Arc<Mutex<std::collections::HashMap<i64, u64>>>,
        cdp_running: Arc<AtomicBool>,
        stats: Arc<Mutex<crate::models::SessionStats>>,
        processor: Arc<TrafficProcessor>,
        app_handle: AppHandle,
    ) -> Result<Self, String> {
        let addr = format!("127.0.0.1:{}", HTTP_BRIDGE_PORT);
        let server = Server::http(&addr).map_err(|e| format!("Failed to bind bridge server to {}: {}", addr, e))?;
        let server = Arc::new(server);
        let is_running = Arc::new(AtomicBool::new(true));

        let srv = Arc::clone(&server);
        let running = Arc::clone(&is_running);

        thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                let mut request = match srv.recv() {
                    Ok(r) => r,
                    Err(_) => break,
                };

                if !host_allowed(request.headers()) {
                    let _ = request.respond(Response::from_string("{\"error\":\"invalid host\"}").with_status_code(403));
                    continue;
                }
                let header_token = request.headers().iter()
                    .find(|h| h.field.as_str().as_bytes().eq_ignore_ascii_case(b"X-Bridge-Token"))
                    .map(|h| h.value.as_str().to_string());
                let token_valid = {
                    let expected = bridge_token.lock().ok().map(|t| t.clone());
                    token_ok(expected.as_deref(), header_token.as_deref())
                };

                let origin_header = request
                    .headers()
                    .iter()
                    .find(|h| h.field.as_str().as_bytes().eq_ignore_ascii_case(b"Origin"))
                    .map(|h| h.value.as_str().to_string())
                    .unwrap_or_else(|| "*".to_string());

                let allowed_origin = allowed_origin(&origin_header)
                    .unwrap_or("http://127.0.0.1")
                    .to_string();

                
                if request.method() == &Method::Options {
                    let response = Response::empty(204)
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..]).unwrap())
                        .with_header(Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"Content-Type, X-Bridge-Token"[..]).unwrap());
                    let _ = request.respond(response);
                    continue;
                }

                let url_path = request.url().split('?').next().unwrap_or("/");

                match (request.method(), url_path) {
                    (&Method::Get, "/api/capture") => {
                        let snapshot = capture.lock().map(|c| c.clone()).unwrap_or_default();
                        let response = Response::from_string(serde_json::to_string(&snapshot).unwrap())
                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                            .with_header(Header::from_bytes("Access-Control-Allow-Origin", allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }
                    (&Method::Post, "/api/capture") => {
                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Change { enabled: bool, selected_tab_id: Option<i64> }
                        let mut body = String::new();
                        let _ = request.as_reader().take(4097).read_to_string(&mut body);
                        let result = if body.len() > 4096 {
                            Err("Capture command too large".to_string())
                        } else {
                            serde_json::from_str::<Change>(&body).map_err(|e| e.to_string()).and_then(|change| {
                                capture.lock().map_err(|e| e.to_string())?.update(change.enabled, change.selected_tab_id)
                            })
                        };
                        if result.is_ok() {
                            
                            if let Ok(mut p) = capture_progress.lock() {
                                *p = CaptureProgress::default();
                            }
                        }
                        let (status, payload) = match result {
                            Ok(snapshot) => {
                                let _ = app_handle.emit("capture-state", &snapshot);
                                (200, serde_json::to_value(snapshot).unwrap())
                            }
                            Err(error) => (400, json!({"error": error})),
                        };
                        let response = Response::from_string(payload.to_string()).with_status_code(status)
                            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                            .with_header(Header::from_bytes("Access-Control-Allow-Origin", allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }
                    (&Method::Get, "/api/config") => {
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);

                        let filter = target_site_filter.lock().map(|f| f.clone()).unwrap_or_default();
                        let excl = exclude_trackers.lock().map(|e| *e).unwrap_or(true);
                        let dir = output_dir.lock().map(|d| crate::storage::display_path(&d)).unwrap_or_default();
                        let active_mock_rules = mock_rules.lock().map(|r| r.clone()).unwrap_or_default();
                        let ws_cmds = {
                            let mut pending = Vec::new();
                            if let Ok(mut original) = pending_ws_commands.lock() {
                                pending = original.drain(..).collect();
                            }
                            pending
                        };
                        let intercept_cmds = {
                            let mut pending = Vec::new();
                            if let Ok(mut original) = intercept_commands.lock() {
                                pending = original.drain(..).collect();
                            }
                            pending
                        };
                        let throttle_cmd = throttle_command.lock().map(|mut t| t.take()).unwrap_or(None);

                        let capture_state = capture.lock().map(|c| c.clone()).unwrap_or_default();
                        let payload = json!({
                            "bridgeToken": bridge_token.lock().map(|t| t.clone()).unwrap_or_default(),
                            "targetSiteFilter": filter,
                            "excludeTrackers": excl,
                            "isCapturing": capture_state.enabled,
                            "selectedTabId": capture_state.selected_tab_id,
                            "captureRevision": capture_state.revision,
                            "captureEpoch": capture_state.epoch,
                            "outputDir": dir,
                            "mockRules": active_mock_rules,
                            "pendingWsCommands": ws_cmds,
                            "interceptEnabled": capture_state.intercept_enabled,
                            "pendingInterceptCommands": intercept_cmds,
                            "pendingThrottleCommand": throttle_cmd,
                        });

                        let body = serde_json::to_string(&payload).unwrap_or_default();
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Get, "/api/mock-rules") => {
                        let rules = mock_rules.lock().map(|r| r.clone()).unwrap_or_default();
                        let body = serde_json::to_string(&rules).unwrap_or_else(|_| "[]".to_string());
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/mock-rules") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        let capped = read_capped(&mut request, MAX_MOCK_RULES_BODY, &mut body_str);
                        if capped.is_err() {
                            let _ = request.respond(Response::from_string("{\"error\":\"mock rules body too large\"}").with_status_code(413)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        if let Ok(new_rules) = serde_json::from_str::<Vec<MockRule>>(&body_str) {
                            if let Ok(mut rules) = mock_rules.lock() {
                                *rules = new_rules.clone();
                            }
                            if let Err(e) = crate::storage::save_mock_rules_to(&crate::storage::mock_rules_file(), &new_rules) {
                                log::error!("mock rules persistence failed: {}", e);
                            }
                            let _ = app_handle.emit("mock-rules-updated", new_rules);
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/tabs") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);

                        let mut body_str = String::new();
                        let capped = read_capped(&mut request, 256 * 1024, &mut body_str);
                        if capped.is_ok() {
                            if let Ok(val) = serde_json::from_str::<Value>(&body_str) {
                                if let Some(tabs_val) = val.get("tabs") {
                                    if let Ok(parsed_tabs) = serde_json::from_value::<Vec<TabSummary>>(tabs_val.clone()) {
                                        if let Ok(mut tabs) = open_tabs.lock() {
                                            *tabs = parsed_tabs.clone();
                                        }
                                        let _ = app_handle.emit("tabs-updated", parsed_tabs);
                                    }
                                }
                                if let Some(delivery_val) = val.get("delivery") {
                                    if let Ok(mut slot) = delivery_stats.lock() {
                                        *slot = delivery_val.clone();
                                    }
                                }
                                
                                if let Some(selected) = capture.lock().ok().and_then(|c| c.selected_tab_id) {
                                    if let Ok(mut st) = stats.lock() {
                                        if let Some(t) = val.get("tabs").and_then(|t| t.as_array()).and_then(|arr| arr.iter()
                                            .find(|t| t.get("id").and_then(|v| v.as_i64()) == Some(selected)))
                                            .and_then(|t| t.get("title")).and_then(|v| v.as_str()) {
                                            if !t.is_empty() { st.tab_title = Some(t.to_string()); }
                                        }
                                    }
                                }
                            }
                        }

                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/traffic") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);

                        let mut body_str = String::new();
                        if read_capped(&mut request, MAX_TRAFFIC_BODY, &mut body_str).is_err() {
                            let _ = request.respond(Response::from_string("{\"error\":\"traffic batch too large\"}").with_status_code(413)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }

                        let cur_dir = output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
                        let session_id = capture.lock().map(|c| c.session_id.clone()).unwrap_or_default();
                        let filter = String::new();
                        let excl = exclude_trackers.lock().map(|e| *e).unwrap_or(true);
                        let mut ack_seq: Option<u64> = None;

                        if let Ok(payload) = serde_json::from_str::<Value>(&body_str) {
                            let items: Vec<Value> = match payload.as_array() {
                                Some(a) => a.clone(),
                                None => vec![payload],
                            };
                            for item in items {
                                
                                let tab_id = item.get("tabId").and_then(|v| v.as_i64()).unwrap_or(0);
                                let seq = item.get("_seq").and_then(|v| v.as_u64());
                                if let Some(seq) = seq {
                                    let accept = match last_seq.lock() {
                                        Ok(mut m) => {
                                            let last = m.entry(tab_id).or_insert(0);
                                            if seq > *last { *last = seq; true } else { false }
                                        }
                                        Err(_) => true,
                                    };
                                    if !accept { continue; }
                                    ack_seq = Some(ack_seq.map_or(seq, |a| a.max(seq)));
                                }
                                Self::dispatch_traffic_item(&processor, &item, &cur_dir, &session_id, &filter, excl);
                            }
                        }

                        let response = Response::from_string(json!({ "ok": true, "ackSeq": ack_seq }).to_string())
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/mock-status") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);

                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct MockStatus { rule_id: String, ok: bool, error: Option<String> }
                        let mut body_str = String::new();
                        if read_capped(&mut request, 8192, &mut body_str).is_ok() {
                            if let Ok(ms) = serde_json::from_str::<MockStatus>(&body_str) {
                                let mut snapshot: Option<Vec<MockRule>> = None;
                                if let Ok(mut rules) = mock_rules.lock() {
                                    if crate::models::apply_mock_status(&mut rules, &ms.rule_id, ms.ok, ms.error, now) {
                                        snapshot = Some(rules.clone());
                                        let _ = crate::storage::save_mock_rules_to(&crate::storage::mock_rules_file(), snapshot.as_ref().unwrap());
                                    }
                                }
                                if let Some(snap) = snapshot {
                                    let _ = app_handle.emit("mock-rules-updated", snap);
                                }
                            }
                        }

                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/throttle") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        if read_capped(&mut request, 1024, &mut body_str).is_ok() {
                            if let Ok(v) = serde_json::from_str::<Value>(&body_str) {
                                if let Ok(mut slot) = throttle_command.lock() {
                                    *slot = Some(v);
                                }
                            }
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Get, "/api/trash") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let base = crate::storage::get_default_logs_base();
                        let list = crate::sessions::list_trash_in(&base);
                        let body = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/cdp-direct") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        let _ = request.as_reader().read_to_string(&mut body_str);
                        let target_url = serde_json::from_str::<Value>(&body_str).ok()
                            .and_then(|v| v.get("targetUrl").and_then(|u| u.as_str()).map(String::from))
                            .unwrap_or_default();
                        let shared = crate::cdp_direct::CdpShared {
                            capture: Arc::clone(&capture),
                            output_dir: Arc::clone(&output_dir),
                            stats: Arc::clone(&stats),
                            mock_rules: Arc::clone(&mock_rules),
                            intercept_paused: Arc::clone(&intercept_paused),
                            intercept_commands: Arc::clone(&intercept_commands),
                            throttle_command: Arc::clone(&throttle_command),
                            processor: Arc::clone(&processor),
                            app: app_handle.clone(),
                            is_running: Arc::clone(&cdp_running),
                        };
                        let body = match crate::cdp_direct::start(target_url, shared) {
                            Ok(v) => v.to_string(),
                            Err(e) => json!({"error": e}).to_string(),
                        };
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/trash-empty") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let base = crate::storage::get_default_logs_base();
                        match crate::sessions::empty_trash_in(&base) {
                            Ok(n) => {
                                let body = json!({"ok": true, "removed": n}).to_string();
                                let response = Response::from_string(body)
                                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                                let _ = request.respond(response);
                            }
                            Err(e) => {
                                let _ = request.respond(Response::from_string(json!({"error": e}).to_string()).with_status_code(500));
                            }
                        }
                    }

                    (&Method::Get, "/api/search") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()));
                            continue;
                        }
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401));
                            continue;
                        }
                        let query = request.url().split("q=").nth(1).unwrap_or("").split('&').next().unwrap_or("");
                        let decoded = urlencoding_decode(query);
                        let base = crate::storage::get_default_logs_base();
                        let (res,) = crate::sessions::search_sessions_in(&base, &decoded);
                        let body = serde_json::to_string(&res).unwrap_or_else(|_| "{}".to_string());
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Get, "/api/sessions") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let base = crate::storage::get_default_logs_base();
                        let list = crate::sessions::list_sessions_in(&base);
                        let body = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/session-new") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        
                        let base = crate::storage::get_default_logs_base();
                        let result = crate::sessions::create_session_in(&base);
                        match result {
                            Ok(dir) => {
                                if let Ok(mut d) = output_dir.lock() { *d = dir.clone(); }
                                if let Ok(mut st) = stats.lock() { *st = crate::models::SessionStats::default(); }
                                if let Ok(mut c) = capture.lock() { c.session_id = crate::capture::new_session_id(); }
                                let _ = app_handle.emit("load-saved-requests", json!({
                                    "requests": [], "stats": crate::models::SessionStats::default(),
                                    "outputDir": crate::storage::display_path(&dir)
                                }));
                                let body = json!({"ok": true, "outputDir": crate::storage::display_path(&dir)}).to_string();
                                let response = Response::from_string(body)
                                    .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                                let _ = request.respond(response);
                            }
                            Err(e) => {
                                let _ = request.respond(Response::from_string(json!({"error": e}).to_string()).with_status_code(500));
                            }
                        }
                    }

                    (&Method::Post, "/api/session-open") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        let _ = request.as_reader().read_to_string(&mut body_str);
                        let name = serde_json::from_str::<Value>(&body_str).ok()
                            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from));
                        match name {
                            Some(name) if !capture.lock().map(|c| c.enabled).unwrap_or(false) => {
                                let base = crate::storage::get_default_logs_base();
                                match crate::sessions::session_dir(&base, &name) {
                                    Some(dir) => {
                                        if let Ok(mut d) = output_dir.lock() { *d = dir.clone(); }
                                        let loaded = crate::storage::load_saved_requests_from_dir(&dir, 500);
                                        let loaded_stats = crate::storage::load_summary_from_dir(&dir).unwrap_or_default();
                                        if let Ok(mut st) = stats.lock() { *st = loaded_stats.clone(); }
                                        let _ = app_handle.emit("load-saved-requests", json!({
                                            "requests": loaded, "stats": loaded_stats,
                                            "outputDir": crate::storage::display_path(&dir)
                                        }));
                                        let body = json!({"ok": true, "outputDir": crate::storage::display_path(&dir)}).to_string();
                                        let response = Response::from_string(body)
                                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                                        let _ = request.respond(response);
                                    }
                                    None => {
                                        let _ = request.respond(Response::from_string(json!({"error": "session not found"}).to_string()).with_status_code(404));
                                    }
                                }
                            }
                            Some(_) => {
                                let _ = request.respond(Response::from_string(json!({"error": "stop capture before switching sessions"}).to_string()).with_status_code(409));
                            }
                            None => {
                                let _ = request.respond(Response::from_string(json!({"error": "name required"}).to_string()).with_status_code(400));
                            }
                        }
                    }

                    (&Method::Post, "/api/session-delete") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        let _ = request.as_reader().read_to_string(&mut body_str);
                        let name = serde_json::from_str::<Value>(&body_str).ok()
                            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from));
                        match name {
                            Some(name) if !capture.lock().map(|c| c.enabled).unwrap_or(false) => {
                                let base = crate::storage::get_default_logs_base();
                                match crate::sessions::delete_session_to_trash(&base, &name) {
                                    Ok(target) => {
                                        let body = json!({"ok": true, "trashPath": target.to_string_lossy().to_string()}).to_string();
                                        let response = Response::from_string(body)
                                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                                        let _ = request.respond(response);
                                    }
                                    Err(e) => {
                                        let _ = request.respond(Response::from_string(json!({"error": e}).to_string()).with_status_code(400));
                                    }
                                }
                            }
                            Some(_) => {
                                let _ = request.respond(Response::from_string(json!({"error": "stop capture before deleting a session"}).to_string()).with_status_code(409));
                            }
                            None => {
                                let _ = request.respond(Response::from_string(json!({"error": "name required"}).to_string()).with_status_code(400));
                            }
                        }
                    }

                    (&Method::Post, "/api/throttle-ack") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        if read_capped(&mut request, 1024, &mut body_str).is_ok() {
                            if let Ok(v) = serde_json::from_str::<Value>(&body_str) {
                                if let Ok(mut slot) = throttle_ack.lock() {
                                    *slot = Some(v);
                                }
                            }
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/intercept") => {
                        let mut body_str = String::new();
                        if read_capped(&mut request, 256, &mut body_str).is_ok() {
                            if let Ok(v) = serde_json::from_str::<Value>(&body_str) {
                                let enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
                                if let Ok(mut c) = capture.lock() {
                                    c.intercept_enabled = enabled;
                                    c.revision += 1;
                                }
                                
                                if let Ok(mut paused) = intercept_paused.lock() {
                                    paused.clear();
                                }
                            }
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/intercept-resolve") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let mut body_str = String::new();
                        if read_capped(&mut request, 64 * 1024, &mut body_str).is_ok() {
                            if let Ok(cmd) = serde_json::from_str::<Value>(&body_str) {
                                let request_id = cmd.get("requestId").and_then(|v| v.as_str()).map(String::from);
                                if let Some(rid) = request_id {
                                    if let Ok(mut paused) = intercept_paused.lock() {
                                        paused.retain(|p| p.get("requestId").and_then(|v| v.as_str()) != Some(rid.as_str()));
                                    }
                                    if let Ok(mut commands) = intercept_commands.lock() {
                                        commands.push(cmd);
                                    }
                                }
                            }
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/intercept-paused") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);
                        let mut body_str = String::new();
                        if read_capped(&mut request, 64 * 1024, &mut body_str).is_ok() {
                            if let Ok(pause) = serde_json::from_str::<Value>(&body_str) {
                                let request_id = pause.get("requestId").and_then(|v| v.as_str()).map(String::from);
                                if let (Some(rid), Ok(mut paused)) = (request_id, intercept_paused.lock()) {
                                    if !paused.iter().any(|p| p.get("requestId").and_then(|v| v.as_str()) == Some(rid.as_str())) {
                                        let mut item = pause.clone();
                                        item["pausedAtMs"] = json!(now);
                                        paused.push(item.clone());
                                        if paused.len() > 200 { paused.remove(0); }
                                        let _ = app_handle.emit("intercept-paused", item);
                                    }
                                }
                            }
                        }
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Get, "/api/intercept-paused") => {
                        let paused = intercept_paused.lock().map(|p| p.clone()).unwrap_or_default();
                        let body = serde_json::to_string(&paused).unwrap_or_else(|_| "[]".to_string());
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/capture-progress") => {
                        if !token_valid {
                            let _ = request.respond(Response::from_string("{\"error\":\"missing or invalid bridge token\"}").with_status_code(401)
                                .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap()));
                            continue;
                        }
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        last_extension_heartbeat.store(now, Ordering::Relaxed);
                        is_extension_connected.store(true, Ordering::Relaxed);

                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Progress {
                            tab_id: Option<i64>,
                            attached: bool,
                            network_enabled: bool,
                            error: Option<String>,
                        }
                        let mut body_str = String::new();
                        if read_capped(&mut request, 8192, &mut body_str).is_ok() {
                            if let Ok(p) = serde_json::from_str::<Progress>(&body_str) {
                                let emit_payload = json!({
                                    "tabId": p.tab_id,
                                    "attached": p.attached,
                                    "networkEnabled": p.network_enabled,
                                    "error": p.error,
                                });
                                let last_error = emit_payload
                                    .get("error")
                                    .and_then(|v| if v.is_null() { None } else { v.as_str().map(String::from) });
                                if let Ok(mut slot) = capture_progress.lock() {
                                    
                                    *slot = CaptureProgress {
                                        tab_id: p.tab_id,
                                        attached: p.attached,
                                        network_enabled: p.network_enabled,
                                        last_error,
                                        updated_at_ms: now,
                                    };
                                }
                                let _ = app_handle.emit("capture-progress", emit_payload);
                            }
                        }

                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Get, "/api/status") => {
                        let filter = target_site_filter.lock().map(|f| f.clone()).unwrap_or_default();
                        let is_ext = is_extension_connected.load(Ordering::Relaxed);
                        let tabs_list = open_tabs.lock().map(|t| t.clone()).unwrap_or_default();

                        let (capture_enabled, selected_tab) = capture
                            .lock()
                            .map(|c| (c.enabled, c.selected_tab_id))
                            .unwrap_or((false, None));
                        let progress = capture_progress.lock().map(|p| p.clone()).unwrap_or_default();
                        let matches_target = selected_tab.is_some() && progress.tab_id == selected_tab;
                        let attached = is_ext && capture_enabled && progress.attached && matches_target;
                        let network_enabled = attached && progress.network_enabled;
                        let stage = crate::models::compute_capture_stage(is_ext, capture_enabled, attached, network_enabled);

                        let payload = json!({
                            "isConnected": is_ext,
                            "isExtensionConnected": is_ext,
                            "isPortConnected": false,
                            "isCapturing": capture_enabled,
                            "outputDir": output_dir.lock().map(|d| crate::storage::display_path(&d)).unwrap_or_default(),
                            "selectedTabId": selected_tab,
                            "captureStage": stage,
                            "targetAttached": attached,
                            "networkEnabled": network_enabled,
                            "targetSiteFilter": filter,
                            "targetError": progress.last_error,
                            "throttleAck": throttle_ack.lock().ok().and_then(|a| a.clone()),
                            "delivery": delivery_stats.lock().map(|d| d.clone()).unwrap_or_default(),
                            "tabs": tabs_list
                        });

                        let body = serde_json::to_string(&payload).unwrap_or_default();
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/launch-chrome") => {
                        let mut body_str = String::new();
                        let _ = request.as_reader().take((MAX_LAUNCH_BODY + 1) as u64).read_to_string(&mut body_str);
                        let target_url = serde_json::from_str::<Value>(&body_str)
                            .ok()
                            .and_then(|v| v.get("targetUrl").and_then(|u| u.as_str()).map(String::from))
                            .unwrap_or_default();
                        let res = crate::chrome_cdp::launch_chrome(&target_url);
                        let ok = res.is_ok();
                        let err_msg = res.err().unwrap_or_default();
                        let body = json!({ "ok": ok, "error": err_msg }).to_string();
                        let response = Response::from_string(body)
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/open-folder") => {
                        let cur = output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| crate::storage::get_default_logs_base());
                        let abs_dir = std::fs::canonicalize(&cur).unwrap_or(cur);
                        let _ = std::fs::create_dir_all(&abs_dir);
                        let _ = std::process::Command::new("explorer.exe").arg(abs_dir.to_string_lossy().to_string()).spawn();
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    (&Method::Post, "/api/open-extension-folder") => {
                        let ext_dir = crate::chrome_cdp::find_extension_dir().unwrap_or_else(|| PathBuf::from("extension"));
                        let _ = std::process::Command::new("explorer.exe").arg(ext_dir.to_string_lossy().to_string()).spawn();
                        let response = Response::from_string("{\"ok\":true}")
                            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }

                    _ => {
                        let response = Response::empty(404)
                            .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], allowed_origin.as_bytes()).unwrap());
                        let _ = request.respond(response);
                    }
                }
            }
        });

        Ok(Self { server, is_running })
    }

    fn dispatch_traffic_item(
        processor: &TrafficProcessor,
        item: &Value,
        output_dir: &std::path::Path,
        session_id: &str,
        filter: &str,
        exclude_trackers: bool,
    ) {
        let method = match item.get("method").and_then(|v| v.as_str()) {
            Some(m) => m,
            None => return,
        };
        let params = match item.get("params") {
            Some(p) => p,
            None => return,
        };

        let tab_id = item.get("tabId").and_then(|v| v.as_i64());
        let tab_url = item.get("tabUrl").and_then(|v| v.as_str()).map(String::from);
        let body = item.get("responseBody").and_then(|v| v.as_str()).map(String::from);
        let base64 = item.get("base64Encoded").and_then(|v| v.as_bool()).unwrap_or(false);

        processor.process_event(
            method,
            params,
            output_dir,
            session_id,
            filter,
            exclude_trackers,
            tab_id,
            tab_url,
            body,
            base64,
        );
    }
}

#[cfg(test)]
mod seq_tests {
    #[test]
    fn seq_dedup_semantics() {
        
        let mut last: std::collections::HashMap<i64, u64> = std::collections::HashMap::new();
        let accept = |m: &mut std::collections::HashMap<i64, u64>, tab: i64, seq: u64| -> bool {
            let e = m.entry(tab).or_insert(0);
            if seq > *e { *e = seq; true } else { false }
        };
        assert!(accept(&mut last, 1, 1));
        assert!(accept(&mut last, 1, 2));
        assert!(!accept(&mut last, 1, 2), "duplicate seq must be dropped");
        assert!(!accept(&mut last, 1, 1), "replayed seq must be dropped");
        assert!(accept(&mut last, 1, 10), "gaps are allowed (lost seq is a loss, not a dupe)");
        assert!(accept(&mut last, 2, 1), "another tab has an independent sequence");
    }
}

fn urlencoding_decode(s: &str) -> String {
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => { out.push(' '); i += 1; }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) { out.push(b as char); i += 3; } else { out.push('%'); i += 1; }
            }
            b => { out.push(b as char); i += 1; }
        }
    }
    out
}
