



use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tungstenite::{connect, Message};

use crate::capture::CaptureState;
use crate::models::{MockRule, SessionStats};
use crate::traffic_processor::TrafficProcessor;

pub const CDP_PORT: u16 = 9222;
const INTERCEPT_DEADLINE_MS: u64 = 10_000;

#[derive(Clone)]
pub struct CdpShared {
    pub capture: Arc<Mutex<CaptureState>>,
    pub output_dir: Arc<Mutex<PathBuf>>,
    pub stats: Arc<Mutex<SessionStats>>,
    pub mock_rules: Arc<Mutex<Vec<MockRule>>>,
    pub intercept_paused: Arc<Mutex<Vec<Value>>>,
    pub intercept_commands: Arc<Mutex<Vec<Value>>>,
    pub throttle_command: Arc<Mutex<Option<Value>>>,
    pub processor: Arc<TrafficProcessor>,
    pub app: AppHandle,
    pub is_running: Arc<AtomicBool>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}


pub fn list_page_targets(port: u16) -> Result<Vec<Value>, String> {
    let url = format!("http://127.0.0.1:{}/json", port);
    let res = ureq::get(&url).timeout(Duration::from_millis(1500)).call()
        .map_err(|e| format!("CDP endpoint unreachable: {}", e))?;
    let list: Vec<Value> = res.into_json().map_err(|e| e.to_string())?;
    Ok(list.into_iter().filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page")).collect())
}

fn trims(url: &str) -> String { url.split('?').next().unwrap_or(url).to_string() }


pub fn pick_target(targets: &[Value], target_url: &str) -> Option<Value> {
    let want = trims(target_url);
    if !want.is_empty() {
        if let Some(t) = targets.iter().find(|t| {
            t.get("url").and_then(|u| u.as_str()).map(|u| trims(u).starts_with(&want) || want.starts_with(&trims(u))).unwrap_or(false)
        }) {
            return Some(t.clone());
        }
    }
    targets.first().cloned()
}


pub fn start(target_url: String, shared: CdpShared) -> Result<Value, String> {
    let targets = list_page_targets(CDP_PORT)?;
    let target = pick_target(&targets, &target_url).ok_or("no page target found in the debug browser")?;
    let ws_url = target.get("webSocketDebuggerUrl").and_then(|v| v.as_str()).ok_or("target has no webSocketDebuggerUrl")?.to_string();
    let tab_url = target.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let target_id = target.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();

    shared.is_running.store(true, Ordering::Relaxed);
    let running = Arc::clone(&shared.is_running);
    let shared_thread = shared.clone();
    let ws_url_thread = ws_url.clone();
    let tab_url_thread = tab_url.clone();

    std::thread::spawn(move || {
        if let Err(e) = run_loop(&ws_url_thread, &tab_url_thread, shared_thread, running) {
            log::error!("CDP-direct session ended: {}", e);
        }
    });

    Ok(json!({ "ok": true, "targetId": target_id, "tabUrl": tab_url, "wsUrl": ws_url }))
}

pub fn stop(shared: &CdpShared) { shared.is_running.store(false, Ordering::Relaxed); }

fn run_loop(ws_url: &str, tab_url: &str, shared: CdpShared, running: Arc<AtomicBool>) -> Result<(), String> {
    let (mut socket, _resp) = connect(ws_url).map_err(|e| format!("CDP websocket connect failed: {}", e))?;
    
    if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = socket.get_ref() {
        let _ = tcp.set_read_timeout(Some(Duration::from_millis(80)));
    }

    let mut next_id: u64 = 1;
    let send = |socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, id: u64, method: &str, params: Value| -> Result<(), String> {
        let text: tungstenite::Utf8Bytes = json!({ "id": id, "method": method, "params": params }).to_string().into();
        socket.send(Message::Text(text)).map_err(|e| e.to_string())
    };

    
    send(&mut socket, next_id, "Network.enable", json!({
        "maxTotalBufferSize": 50000000,
        "maxResourceBufferSize": 25000000,
        "maxPostDataSize": 10000000
    }))?;
    next_id += 1;

    
    let mut body_requests: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
    
    let mut fetch_enabled = false;
    let mut held: std::collections::HashMap<String, Instant> = std::collections::HashMap::new();
    let mut last_throttle: Option<Value> = None;

    while running.load(Ordering::Relaxed) {
        
        let intercept_on = shared.capture.lock().map(|c| c.intercept_enabled).unwrap_or(false);
        if intercept_on != fetch_enabled {
            let patterns = if intercept_on {
                json!([{ "urlPattern": "*", "requestStage": "Request" }, { "urlPattern": "*", "responseStage": "Response" }])
            } else {
                json!([{ "urlPattern": "*", "requestStage": "Request" }])
            };
            let _ = send(&mut socket, next_id, if intercept_on { "Fetch.enable" } else { "Fetch.disable" }, if intercept_on { json!({ "patterns": patterns }) } else { json!({}) });
            next_id += 1;
            fetch_enabled = intercept_on;
            if !intercept_on {
                held.clear();
                if let Ok(mut paused) = shared.intercept_paused.lock() { paused.clear(); }
            }
        }
        
        if let Ok(mut slot) = shared.throttle_command.lock() {
            if let Some(cmd) = slot.take() {
                last_throttle = Some(cmd.clone());
            }
        }
        if let Some(cmd) = last_throttle.clone() {
            let enabled = cmd.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let _ = send(&mut socket, next_id, "Network.emulateNetworkConditions", json!({
                "offline": false,
                "latency": if enabled { cmd.get("latency").and_then(|v| v.as_u64()).unwrap_or(0) } else { 0 },
                "downloadThroughput": if enabled { cmd.get("downloadThroughput").and_then(|v| v.as_i64()).unwrap_or(-1) } else { -1 },
                "uploadThroughput": if enabled { cmd.get("uploadThroughput").and_then(|v| v.as_i64()).unwrap_or(-1) } else { -1 }
            }));
            next_id += 1;
            last_throttle = None;
        }
        
        if let Ok(mut cmds) = shared.intercept_commands.lock() {
            while let Some(cmd) = cmds.pop() {
                let request_id = cmd.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("forward").to_string();
                held.remove(&request_id);
                if let Ok(mut paused) = shared.intercept_paused.lock() {
                    paused.retain(|p| p.get("requestId").and_then(|v| v.as_str()) != Some(request_id.as_str()));
                }
                let _ = match action.as_str() {
                    "drop" | "fail" => send(&mut socket, next_id, "Fetch.failRequest", json!({
                        "requestId": request_id,
                        "errorReason": if action == "fail" { cmd.get("errorReason").and_then(|v| v.as_str()).unwrap_or("Failed") } else { "Aborted" }
                    })),
                    "fulfill" => {
                        let headers = cmd.get("headers").cloned().unwrap_or(json!({}));
                        let header_list: Vec<Value> = headers.as_object().map(|o| o.iter().map(|(k, v)| json!({"name": k, "value": v.as_str().unwrap_or("")})).collect()).unwrap_or_default();
                        let body_b64 = cmd.get("body").and_then(|v| v.as_str()).unwrap_or("");
                        send(&mut socket, next_id, "Fetch.fulfillRequest", json!({
                            "requestId": request_id,
                            "responseCode": cmd.get("status").and_then(|v| v.as_u64()).unwrap_or(200),
                            "responseHeaders": header_list,
                            "body": body_b64
                        }))
                    }
                    _ => {
                        let mut params = json!({ "requestId": request_id, "interceptResponse": cmd.get("interceptResponse").and_then(|v| v.as_bool()).unwrap_or(false) });
                        if let Some(u) = cmd.get("url").and_then(|v| v.as_str()) { params["url"] = json!(u); }
                        if let Some(h) = cmd.get("headers").and_then(|v| v.as_object()) {
                            let list: Vec<Value> = h.iter().map(|(k, v)| json!({"name": k, "value": v.as_str().unwrap_or("")})).collect();
                            if !list.is_empty() { params["headers"] = json!(list); }
                        }
                        send(&mut socket, next_id, "Fetch.continueRequest", params)
                    }
                };
                next_id += 1;
            }
        }
        
        let stale: Vec<String> = held.iter().filter(|(_, at)| at.elapsed().as_millis() as u64 > INTERCEPT_DEADLINE_MS).map(|(k, _)| k.clone()).collect();
        for rid in stale {
            held.remove(&rid);
            if let Ok(mut paused) = shared.intercept_paused.lock() {
                paused.retain(|p| p.get("requestId").and_then(|v| v.as_str()) != Some(rid.as_str()));
            }
            let _ = send(&mut socket, next_id, "Fetch.continueRequest", json!({ "requestId": rid }));
            next_id += 1;
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                let msg: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };
                
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    if let Some(rid) = body_requests.remove(&id) {
                        let body = msg.get("result").and_then(|r| r.get("body")).and_then(|v| v.as_str()).map(String::from);
                        let is_b64 = msg.get("result").and_then(|r| r.get("base64Encoded")).and_then(|v| v.as_bool()).unwrap_or(false);
                        dispatch(&shared, "Network.loadingFinished.body", &json!({}), &rid, body, is_b64, tab_url);
                    }
                    continue;
                }
                let method = match msg.get("method").and_then(|v| v.as_str()) { Some(m) => m, None => continue };
                let params = msg.get("params").cloned().unwrap_or(json!({}));
                match method {
                    "Network.loadingFinished" => {
                        let rid = params.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        
                        body_requests.insert(next_id, rid);
                        let _ = send(&mut socket, next_id, "Network.getResponseBody", json!({ "requestId": params.get("requestId").cloned().unwrap_or(json!("")) }));
                        next_id += 1;
                    }
                    "Network.requestWillBeSent" | "Network.responseReceived" | "Network.loadingFailed"
                    | "Network.webSocketCreated" | "Network.webSocketFrameSent" | "Network.webSocketFrameReceived" | "Network.webSocketClosed" => {
                        dispatch(&shared, method, &params, "", None, false, tab_url);
                    }
                    "Fetch.requestPaused" => {
                        let request_id = params.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let url = params.get("request").and_then(|r| r.get("url")).and_then(|v| v.as_str())
                            .or_else(|| params.get("url").and_then(|v| v.as_str())).unwrap_or("").to_string();
                        let is_response = params.get("responseStatusCode").is_some();
                        
                        let matched_rule = shared.mock_rules.lock().ok().and_then(|rules| {
                            rules.iter().find(|r| r.enabled && mock_matches(&r.url_pattern, &url)).cloned()
                        });
                        if let Some(rule) = matched_rule {
                            use base64::Engine as _;
                            let body_b64 = base64::engine::general_purpose::STANDARD.encode(rule.response_body.as_bytes());
                            let headers = vec![
                                json!({"name": "Content-Type", "value": rule.content_type}),
                                json!({"name": "Access-Control-Allow-Origin", "value": "*"}),
                            ];
                            let _ = send(&mut socket, next_id, "Fetch.fulfillRequest", json!({
                                "requestId": request_id, "responseCode": rule.status_code,
                                "responseHeaders": headers, "body": body_b64
                            }));
                            next_id += 1;
                            continue;
                        }
                        if is_response {
                            
                            
                            let headers: Value = params.get("responseHeaders").and_then(|h| h.as_array()).map(|arr| {
                                let mut o = serde_json::Map::new();
                                for h in arr { if let (Some(n), Some(v)) = (h.get("name").and_then(|x| x.as_str()), h.get("value").and_then(|x| x.as_str())) { o.insert(n.to_string(), json!(v)); } }
                                Value::Object(o)
                            }).unwrap_or(json!({}));
                            held.insert(request_id.clone(), Instant::now());
                            let item = json!({
                                "requestId": request_id, "tabId": 1, "url": url, "method": params.get("request").and_then(|r| r.get("method")).and_then(|v| v.as_str()).unwrap_or("GET"),
                                "stage": "Response", "statusCode": params.get("responseStatusCode"), "responseHeaders": headers,
                                "responseBody": "", "pausedAtMs": now_ms()
                            });
                            if let Ok(mut paused) = shared.intercept_paused.lock() { paused.push(item.clone()); }
                            let _ = shared.app.emit("intercept-paused", item);
                        } else {
                            held.insert(request_id.clone(), Instant::now());
                            let item = json!({
                                "requestId": request_id, "tabId": 1, "url": url,
                                "method": params.get("request").and_then(|r| r.get("method")).and_then(|v| v.as_str()).unwrap_or("GET"),
                                "stage": "Request", "pausedAtMs": now_ms()
                            });
                            if let Ok(mut paused) = shared.intercept_paused.lock() { paused.push(item.clone()); }
                            let _ = shared.app.emit("intercept-paused", item);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return Err("CDP socket closed".to_string()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("CDP read failed: {}", e)),
        }
    }
    let _ = socket.close(None);
    Ok(())
}


pub fn mock_matches(pattern: &str, url: &str) -> bool {
    let pat = pattern.trim();
    if pat.is_empty() || pat == "*" || pat == ".*" { return true; }
    if !pat.contains('*') { return url.eq_ignore_ascii_case(pat); }
    let parts: Vec<&str> = pat.split('*').collect();
    let mut rest = url;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() { continue; }
        let lower_rest = rest.to_lowercase();
        let lower_part = part.to_lowercase();
        match lower_rest.find(&lower_part) {
            Some(pos) => {
                if i == 0 && pos != 0 { return false; }
                rest = &rest[pos + part.len()..];
            }
            None => return false,
        }
    }
    if let Some(last) = parts.last() {
        if !last.is_empty() && !url.to_lowercase().ends_with(&last.to_lowercase()) { return false; }
    }
    true
}

fn dispatch(shared: &CdpShared, method: &str, params: &Value, req_id_hint: &str, body: Option<String>, base64: bool, tab_url: &str) {
    let capture_enabled = shared.capture.lock().map(|c| c.enabled).unwrap_or(false);
    if !capture_enabled { return; }
    let session_id = shared.capture.lock().map(|c| c.session_id.clone()).unwrap_or_default();
    let out_dir = shared.output_dir.lock().map(|d| d.clone()).unwrap_or_else(|_| PathBuf::from("logs"));
    let excl = true;
    let eff_method = if method == "Network.loadingFinished.body" { "Network.loadingFinished" } else { method };
    let mut eff_params = params.clone();
    if method == "Network.loadingFinished.body" {
        eff_params = json!({ "requestId": req_id_hint, "encodedDataLength": body.as_ref().map(|b| b.len() as u64).unwrap_or(0) });
    }
    shared.processor.process_event(
        eff_method,
        &eff_params,
        &out_dir,
        &session_id,
        "",
        excl,
        Some(1),
        Some(tab_url.to_string()),
        body,
        base64,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_matcher_matches_extension_semantics() {
        assert!(mock_matches("*", "https://x.test/api"));
        assert!(mock_matches("", "https://x.test/api"));
        assert!(mock_matches("*/probe*", "https://x.test/probe?i=1"));
        assert!(mock_matches("https://x.test/probe", "https://x.test/probe"));
        assert!(!mock_matches("https://x.test/probe", "https://x.test/other"));
        assert!(mock_matches("*/uploads/*", "https://wotpack.ru/wp-content/uploads/2025/07/a.jpg"));
        assert!(!mock_matches("*/uploads/*", "https://wotpack.ru/wp-content/themes/x.css"));
    }

    #[test]
    fn target_picker_prefers_matching_url() {
        let targets = vec![
            json!({"id": "a", "type": "page", "url": "https://other.test/"}),
            json!({"id": "b", "type": "page", "url": "https://wotpack.ru/page/?x=1"}),
        ];
        let picked = pick_target(&targets, "https://wotpack.ru/page/").unwrap();
        assert_eq!(picked.get("id").and_then(|v| v.as_str()), Some("b"));
        let fallback = pick_target(&targets, "https://unknown.test/").unwrap();
        assert_eq!(fallback.get("id").and_then(|v| v.as_str()), Some("a"));
    }
}
