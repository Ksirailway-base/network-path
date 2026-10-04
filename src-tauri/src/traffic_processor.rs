use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

use crate::models::{
    FullHeaders, FullTrafficRecord, GeneralHeaders, InitiatorInfo, InFlightRequest,
    QueryParam, ResponseBodyInfo, SessionStats, TimingBreakdown, TimingInfo, WebSocketFrameRecord,
};
use crate::storage::{sanitize_filename, save_detailed_record, save_raw_asset, StorageManager};

pub const KNOWN_TRACKERS: &[&str] = &[
    "tiktok.com",
    "clarity.ms",
    "bat.bing.com",
    "doubleclick.net",
    "googleads.g.doubleclick.net",
    "google-analytics.com",
    "googletagmanager.com",
    "posthog.cdndate.net",
    "helpcrunch.com",
    "rdtds.net",
];

pub fn normalize_resource_type(raw: &str) -> &'static str {
    match raw {
        "Document" => "Doc",
        "Stylesheet" => "CSS",
        "Script" => "JS",
        "Font" => "Font",
        "Image" => "Img",
        "Media" => "Media",
        "Manifest" => "Manifest",
        "WebSocket" => "Socket",
        "SignedExchange" | "Wasm" => "Wasm",
        "XHR" | "Fetch" | "Other" => "Other",
        _ => "Other",
    }
}



pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars).collect();
    out.push_str("... (truncated)");
    out
}

pub fn is_tracker_url(url_str: &str) -> bool {    let lower = url_str.to_lowercase();
    if KNOWN_TRACKERS.iter().any(|&d| lower.contains(d)) {
        return true;
    }
    if lower.contains("google.")
        && (lower.contains("/ccm/") || lower.contains("/rmkt/") || lower.contains("/pagead/"))
    {
        return true;
    }
    false
}

pub fn matches_site_filter(url_str: &str, filter: &str, tab_url: &str, exclude_trackers: bool) -> bool {
    if exclude_trackers && is_tracker_url(url_str) {
        let clean_f = filter.trim().to_lowercase();
        if clean_f.is_empty() || clean_f == "*" || !url_str.to_lowercase().contains(&clean_f) {
            return false;
        }
    }

    let clean_filter = filter.trim().to_lowercase();
    if clean_filter.is_empty() || clean_filter == "*" {
        return true;
    }

    
    if !tab_url.is_empty() {
        if let Ok(tu) = Url::parse(tab_url) {
            if let Some(host) = tu.host_str() {
                let h = host.to_lowercase();
                if h == clean_filter || h.ends_with(&format!(".{}", clean_filter)) || tu.as_str().to_lowercase().contains(&clean_filter) {
                    return true;
                }
            }
        } else if tab_url.to_lowercase().contains(&clean_filter) {
            return true;
        }
    }

    
    if let Ok(u) = Url::parse(url_str) {
        if let Some(host) = u.host_str() {
            let h = host.to_lowercase();
            if h == clean_filter || h.ends_with(&format!(".{}", clean_filter)) || u.as_str().to_lowercase().contains(&clean_filter) {
                return true;
            }
        }
    }
    url_str.to_lowercase().contains(&clean_filter)
}

pub struct TrafficProcessor {
    in_flight: Arc<Mutex<HashMap<String, InFlightRequest>>>,
    stats: Arc<Mutex<SessionStats>>,
    storage: StorageManager,
    app_handle: AppHandle,
    
    fallback_dir: std::path::PathBuf,
}

impl TrafficProcessor {
    pub fn new(
        in_flight: Arc<Mutex<HashMap<String, InFlightRequest>>>,
        stats: Arc<Mutex<SessionStats>>,
        storage: StorageManager,
        app_handle: AppHandle,
    ) -> Self {
        Self {
            in_flight,
            stats,
            storage,
            app_handle,
            fallback_dir: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("logs")),
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn process_event(
        &self,
        method: &str,
        params: &Value,
        output_dir: &Path,
        session_id: &str,
        filter: &str,
        exclude_trackers: bool,
        extra_tab_id: Option<i64>,
        extra_tab_url: Option<String>,
        extra_body: Option<String>,
        extra_base64: bool,
    ) {
        
        self.cleanup_stale_in_flight(60_000);

        match method {
            "Network.requestWillBeSent" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => return,
                };
                let request = match params.get("request") {
                    Some(r) => r,
                    None => return,
                };
                let url = request.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let tab_url_str = extra_tab_url.as_deref().unwrap_or("");

                if !matches_site_filter(&url, filter, tab_url_str, exclude_trackers) {
                    return;
                }

                
                if let Some(redir) = params.get("redirectResponse") {
                    self.handle_redirect_response(&req_id, redir, output_dir);
                }

                let req_method = request.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string();
                let raw_type = params.get("type").and_then(|v| v.as_str()).unwrap_or("Other");
                let normalized_type = normalize_resource_type(raw_type).to_string();
                let wall_time = params.get("wallTime").and_then(|v| v.as_f64()).unwrap_or_else(|| {
                    Self::current_time_ms() as f64 / 1000.0
                });
                let cdp_timestamp = params.get("timestamp").and_then(|v| v.as_f64());
                let timestamp_iso = chrono::Utc::now().to_rfc3339();

                let mut query_params = Vec::new();
                if let Ok(parsed_u) = Url::parse(&url) {
                    for (k, v) in parsed_u.query_pairs() {
                        query_params.push(QueryParam {
                            key: k.to_string(),
                            value: v.to_string(),
                        });
                    }
                }

                let post_data = request.get("postData").and_then(|v| {
                    if let Some(s) = v.as_str() {
                        serde_json::from_str::<Value>(s).ok().or_else(|| Some(Value::String(s.to_string())))
                    } else {
                        Some(v.clone())
                    }
                });

                let initiator = params.get("initiator").map(|init| InitiatorInfo {
                    initiator_type: init.get("type").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                    url: init.get("url").and_then(|v| v.as_str()).map(String::from),
                    line_number: init.get("lineNumber").and_then(|v| v.as_i64()),
                    column_number: init.get("columnNumber").and_then(|v| v.as_i64()),
                    stack: init.get("stack").cloned(),
                });

                let req_record = InFlightRequest {
                    id: req_id.clone(),
                    
                    session_id: Some(session_id.to_string()),
                    session_dir: Some(output_dir.to_path_buf()),
                    tab_id: extra_tab_id,
                    tab_url: extra_tab_url.clone(),
                    timestamp: timestamp_iso.clone(),
                    wall_time,
                    cdp_timestamp,
                    resource_type: normalized_type.clone(),
                    url: url.clone(),
                    method: req_method.clone(),
                    request_headers: request.get("headers").cloned().unwrap_or(json!({})),
                    query_params,
                    post_data,
                    initiator: initiator.clone(),
                    status: None,
                    status_text: None,
                    mime_type: None,
                    response_headers: None,
                    timing_raw: None,
                    remote_ip_address: None,
                    remote_port: None,
                    protocol: None,
                    created_instant: Self::current_time_ms(),
                };

                if let Ok(mut map) = self.in_flight.lock() {
                    map.insert(req_id.clone(), req_record);
                }

                let _ = self.app_handle.emit("request-started", json!({
                    "id": req_id,
                    "timestamp": timestamp_iso,
                    "url": url,
                    "method": req_method,
                    "resourceType": normalized_type,
                    "initiator": initiator,
                    "tabUrl": extra_tab_url
                }));
            }

            "Network.responseReceived" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id,
                    None => return,
                };
                let resp = match params.get("response") {
                    Some(r) => r,
                    None => return,
                };

                if let Ok(mut map) = self.in_flight.lock() {
                    if let Some(rec) = map.get_mut(req_id) {
                        rec.status = resp.get("status").and_then(|v| v.as_i64()).map(|s| s as i32);
                        rec.status_text = resp.get("statusText").and_then(|v| v.as_str()).map(String::from);
                        rec.mime_type = resp.get("mimeType").and_then(|v| v.as_str()).map(String::from);
                        rec.response_headers = resp.get("headers").cloned();
                        rec.timing_raw = resp.get("timing").cloned();
                        rec.protocol = resp.get("protocol").and_then(|v| v.as_str()).map(String::from);
                        rec.remote_ip_address = resp.get("remoteIPAddress").and_then(|v| v.as_str()).map(String::from);
                        rec.remote_port = resp.get("remotePort").and_then(|v| v.as_i64()).map(|p| p as i32);

                        if let Some(t) = params.get("type").and_then(|v| v.as_str()) {
                            rec.resource_type = normalize_resource_type(t).to_string();
                        }
                    }
                }
            }

            "Network.webSocketCreated" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => return,
                };
                let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let tab_url_str = extra_tab_url.as_deref().unwrap_or("");

                if !matches_site_filter(&url, filter, tab_url_str, exclude_trackers) {
                    return;
                }

                let ws_record = FullTrafficRecord {
                    id: req_id.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    session_id: Some(session_id.to_string()),
                    tab_id: extra_tab_id,
                    tab_url: extra_tab_url,
                    resource_type: "Socket".to_string(),
                    url: url.clone(),
                    method: "WS".to_string(),
                    status: 101,
                    status_text: "Switching Protocols".to_string(),
                    headers: FullHeaders {
                        general: GeneralHeaders {
                            request_url: url.clone(),
                            request_method: "WS".to_string(),
                            status_code: "101 Switching Protocols".to_string(),
                            remote_address: None,
                            protocol: Some("websocket".to_string()),
                            mime_type: Some("websocket".to_string()),
                        },
                        request: json!({}),
                        response: json!({}),
                        query_params: Vec::new(),
                        request_payload: None,
                    },
                    preview: json!("WebSocket connection opened"),
                    response: ResponseBodyInfo {
                        mime_type: "websocket".to_string(),
                        size_bytes: 0,
                        base64_encoded: false,
                        body: Some(json!("WebSocket active")),
                        body_state: Some("available".to_string()),
                    },
                    initiator: params.get("initiator").map(|init| InitiatorInfo {
                        initiator_type: init.get("type").and_then(|v| v.as_str()).unwrap_or("script").to_string(),
                        url: init.get("url").and_then(|v| v.as_str()).map(String::from),
                        line_number: init.get("lineNumber").and_then(|v| v.as_i64()),
                        column_number: init.get("columnNumber").and_then(|v| v.as_i64()),
                        stack: init.get("stack").cloned(),
                    }),
                    timing: TimingInfo {
                        duration_ms: 0.0,
                        breakdown: None,
                    },
                    saved_file: None,
                };

                self.storage.append_request(output_dir, &ws_record);

                if let Ok(mut st) = self.stats.lock() {
                    st.total_requests += 1;
                    *st.by_type.entry("Socket".to_string()).or_insert(0) += 1;
                    self.storage.write_summary(output_dir, &st);
                    let _ = self.app_handle.emit("summary-updated", st.clone());
                }

                let _ = self.app_handle.emit("request-finished", ws_record);
            }

            "Network.webSocketFrameSent" | "Network.webSocketFrameReceived" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => return,
                };
                let resp = params.get("response");
                let is_sent = method == "Network.webSocketFrameSent";
                let payload_data = resp
                    .and_then(|r| r.get("payloadData"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let preview = truncate_chars(&payload_data, 300);

                let frame_record = WebSocketFrameRecord {
                    socket_id: req_id,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    session_id: Some(session_id.to_string()),
                    direction: if is_sent { "SENT".to_string() } else { "RECEIVED".to_string() },
                    opcode: resp.and_then(|r| r.get("opcode")).and_then(|v| v.as_i64()).map(|o| o as i32),
                    preview,
                    payload_data,
                };

                self.storage.append_socket_frame(output_dir, &frame_record);
                let _ = self.app_handle.emit("socket-event", frame_record);
            }

            "Network.webSocketClosed" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => return,
                };
                let frame_record = WebSocketFrameRecord {
                    socket_id: req_id,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    session_id: Some(session_id.to_string()),
                    direction: "CLOSED".to_string(),
                    opcode: None,
                    preview: "WebSocket connection closed".to_string(),
                    payload_data: "WebSocket closed".to_string(),
                };
                self.storage.append_socket_frame(output_dir, &frame_record);
                let _ = self.app_handle.emit("socket-event", frame_record);
            }

            "Network.loadingFinished" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id,
                    None => return,
                };

                let in_flight_rec = {
                    let mut map = match self.in_flight.lock() {
                        Ok(m) => m,
                        Err(_) => return,
                    };
                    map.remove(req_id)
                };

                let rec = match in_flight_rec {
                    Some(r) => r,
                    None => return,
                };

                let timestamp = params.get("timestamp").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let duration_ms = if let Some(start_ts) = rec.cdp_timestamp {
                    if timestamp > start_ts {
                        ((timestamp - start_ts) * 1000.0).round()
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };

                let encoded_data_len = params.get("encodedDataLength").and_then(|v| v.as_u64()).unwrap_or(0);
                let body_str = extra_body;
                let size_bytes = if encoded_data_len > 0 {
                    encoded_data_len
                } else {
                    body_str.as_ref().map(|b| b.len() as u64).unwrap_or(0)
                };

                
                let parsed_body = body_str.as_ref().and_then(|s| {
                    if !extra_base64 {
                        serde_json::from_str::<Value>(s).ok().or_else(|| Some(Value::String(s.clone())))
                    } else {
                        None
                    }
                });

                let preview_val = if let Some(ref pb) = parsed_body {
                    pb.clone()
                } else if extra_base64 {
                    json!(format!("[Binary Data / Base64 ({} bytes)]", size_bytes))
                } else {
                    json!(format!("HTTP {} {}", rec.status.unwrap_or(200), rec.status_text.as_deref().unwrap_or("OK")))
                };

                
                let timing_breakdown = rec.timing_raw.as_ref().map(|t| {
                    let dns_start = t.get("dnsStart").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let dns_end = t.get("dnsEnd").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let dns = if dns_end > 0.0 && dns_start >= 0.0 { Some((dns_end - dns_start).max(0.0)) } else { None };

                    let connect_start = t.get("connectStart").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let connect_end = t.get("connectEnd").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let connect = if connect_end > 0.0 && connect_start >= 0.0 { Some((connect_end - connect_start).max(0.0)) } else { None };

                    let ssl_start = t.get("sslStart").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let ssl_end = t.get("sslEnd").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let ssl = if ssl_end > 0.0 && ssl_start >= 0.0 { Some((ssl_end - ssl_start).max(0.0)) } else { None };

                    let send_start = t.get("sendStart").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let send_end = t.get("sendEnd").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let send = if send_end > 0.0 && send_start >= 0.0 { Some((send_end - send_start).max(0.0)) } else { None };

                    let recv_headers = t.get("receiveHeadersEnd").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                    let ttfb = if recv_headers > 0.0 && send_end >= 0.0 { Some((recv_headers - send_end).max(0.0)) } else { None };

                    let download = if recv_headers > 0.0 && duration_ms > recv_headers {
                        Some((duration_ms - recv_headers).max(0.0))
                    } else {
                        Some(0.0)
                    };

                    TimingBreakdown {
                        dns,
                        connect,
                        ssl,
                        send,
                        ttfb,
                        download,
                        total: duration_ms,
                    }
                });

                let status_val = rec.status.unwrap_or(200);
                let status_text_val = rec.status_text.unwrap_or_else(|| "OK".to_string());
                let category = rec.resource_type.clone();
                
                
                let write_dir = rec.session_dir.clone().unwrap_or_else(|| output_dir.to_path_buf());

                let mut full_record = FullTrafficRecord {
                    id: rec.id.clone(),
                    timestamp: rec.timestamp,
                    session_id: rec.session_id.clone(),
                    tab_id: rec.tab_id,
                    tab_url: rec.tab_url,
                    resource_type: category.clone(),
                    url: rec.url.clone(),
                    method: rec.method.clone(),
                    status: status_val,
                    status_text: status_text_val.clone(),
                    headers: FullHeaders {
                        general: GeneralHeaders {
                            request_url: rec.url.clone(),
                            request_method: rec.method.clone(),
                            status_code: format!("{} {}", status_val, status_text_val),
                            remote_address: rec.remote_ip_address.map(|ip| {
                                if let Some(port) = rec.remote_port {
                                    format!("{}:{}", ip, port)
                                } else {
                                    ip
                                }
                            }),
                            protocol: rec.protocol,
                            mime_type: rec.mime_type.clone(),
                        },
                        request: rec.request_headers,
                        response: rec.response_headers.unwrap_or(json!({})),
                        query_params: rec.query_params,
                        request_payload: rec.post_data,
                    },
                    preview: preview_val,
                    response: ResponseBodyInfo {
                        mime_type: rec.mime_type.unwrap_or_else(|| "unknown".to_string()),
                        size_bytes,
                        base64_encoded: extra_base64,
                        body: parsed_body.clone(),
                        body_state: Some(compute_body_state(&parsed_body, extra_base64, size_bytes).to_string()),
                    },
                    initiator: rec.initiator,
                    timing: TimingInfo {
                        duration_ms,
                        breakdown: timing_breakdown,
                    },
                    saved_file: None,
                };

                
                let url_slug = Url::parse(&rec.url)
                    .ok()
                    .map(|u| {
                        let path = u.path().trim_start_matches('/');
                        if path.is_empty() {
                            u.host_str().unwrap_or("req").to_string()
                        } else {
                            path.replace('/', "_")
                        }
                    })
                    .unwrap_or_else(|| "req".to_string());
                let clean_slug = sanitize_filename(&url_slug);
                let clean_req_id = sanitize_filename(&rec.id);
                let file_name = format!("{}_{}_{}_{}_{}.json", Self::current_time_ms(), clean_req_id, rec.method, status_val, clean_slug);

                full_record.saved_file = save_detailed_record(&write_dir, &category, &file_name, &full_record);

                
                if extra_base64 {
                    if let Some(ref raw_b64) = body_str {
                        use base64::Engine as _;
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                            let ext = match category.as_str() {
                                "Img" => "png",
                                "Media" => "mp4",
                                "Font" => "woff2",
                                _ => "bin",
                            };
                            let raw_name = format!("{}_{}_{}.{}", Self::current_time_ms(), clean_req_id, clean_slug, ext);
                            save_raw_asset(&write_dir, &category, &raw_name, &bytes);
                        }
                    }
                }

                
                self.storage.append_request(&write_dir, &full_record);
                
                
                if let Ok(mut st) = self.stats.lock() {
                    if st.site.is_none() && !is_tracker_url(&rec.url) {
                        if let Ok(u) = url::Url::parse(&rec.url) {
                            if let Some(host) = u.host_str() {
                                st.site = Some(host.to_string());
                            }
                        }
                    }
                }

                
                if let Ok(mut st) = self.stats.lock() {
                    st.total_requests += 1;
                    st.total_bytes += size_bytes;
                    *st.by_type.entry(category).or_insert(0) += 1;

                    let status_group = if (200..300).contains(&status_val) {
                        "2xx"
                    } else if (300..400).contains(&status_val) {
                        "3xx"
                    } else if (400..500).contains(&status_val) {
                        "4xx"
                    } else if (500..600).contains(&status_val) {
                        "5xx"
                    } else {
                        "other"
                    };
                    *st.by_status.entry(status_group.to_string()).or_insert(0) += 1;

                    self.storage.write_summary(output_dir, &st);
                    let _ = self.app_handle.emit("summary-updated", st.clone());
                }

                let _ = self.app_handle.emit("request-finished", full_record);
            }

            "Network.loadingFailed" => {
                let req_id = match params.get("requestId").and_then(|v| v.as_str()) {
                    Some(id) => id,
                    None => return,
                };

                let in_flight_rec = {
                    let mut map = match self.in_flight.lock() {
                        Ok(m) => m,
                        Err(_) => return,
                    };
                    map.remove(req_id)
                };

                let rec = match in_flight_rec {
                    Some(r) => r,
                    None => return,
                };

                let canceled = params.get("canceled").and_then(|v| v.as_bool()).unwrap_or(false);
                let error_text = params.get("errorText").and_then(|v| v.as_str()).unwrap_or("Unknown");
                let status_val = if canceled { 0 } else { 499 };
                let status_text = if canceled { "(Canceled)".to_string() } else { format!("(Failed: {})", error_text) };

                let failed_record = FullTrafficRecord {
                    id: rec.id.clone(),
                    timestamp: rec.timestamp,
                    session_id: rec.session_id.clone(),
                    tab_id: rec.tab_id,
                    tab_url: rec.tab_url,
                    resource_type: rec.resource_type,
                    url: rec.url.clone(),
                    method: rec.method.clone(),
                    status: status_val,
                    status_text: status_text.clone(),
                    headers: FullHeaders {
                        general: GeneralHeaders {
                            request_url: rec.url,
                            request_method: rec.method,
                            status_code: status_text.clone(),
                            remote_address: None,
                            protocol: None,
                            mime_type: Some("error".to_string()),
                        },
                        request: rec.request_headers,
                        response: json!({}),
                        query_params: rec.query_params,
                        request_payload: rec.post_data,
                    },
                    preview: json!(format!("Request failed: {}", error_text)),
                    response: ResponseBodyInfo {
                        mime_type: "error".to_string(),
                        size_bytes: 0,
                        base64_encoded: false,
                        body: None,
                        body_state: Some("unavailable".to_string()),
                    },
                    initiator: rec.initiator,
                    timing: TimingInfo {
                        duration_ms: 0.0,
                        breakdown: None,
                    },
                    saved_file: None,
                };

                self.storage.append_request(output_dir, &failed_record);
                let _ = self.app_handle.emit("request-finished", failed_record);
            }

            _ => {}
        }
    }

    fn handle_redirect_response(&self, req_id: &str, redir: &Value, output_dir: &Path) {
        let status = redir.get("status").and_then(|v| v.as_i64()).unwrap_or(302) as i32;
        let status_text = redir.get("statusText").and_then(|v| v.as_str()).unwrap_or("Found").to_string();
        let url = redir.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();

        let in_flight_clone = {
            let map = match self.in_flight.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.get(req_id).cloned()
        };

        if let Some(rec) = in_flight_clone {
            let redirect_record = FullTrafficRecord {
                id: format!("{}_redir_{}", rec.id, Self::current_time_ms()),
                timestamp: rec.timestamp,
                session_id: rec.session_id.clone(),
                tab_id: rec.tab_id,
                tab_url: rec.tab_url,
                resource_type: rec.resource_type,
                url: if url.is_empty() { rec.url.clone() } else { url },
                method: rec.method.clone(),
                status,
                status_text: status_text.clone(),
                headers: FullHeaders {
                    general: GeneralHeaders {
                        request_url: rec.url,
                        request_method: rec.method,
                        status_code: format!("{} {}", status, status_text),
                        remote_address: None,
                        protocol: None,
                        mime_type: None,
                    },
                    request: rec.request_headers,
                    response: redir.get("headers").cloned().unwrap_or(json!({})),
                    query_params: rec.query_params,
                    request_payload: rec.post_data,
                },
                preview: json!(format!("Redirected to: {}", redir.get("headers").and_then(|h| h.get("location")).and_then(|v| v.as_str()).unwrap_or("(unknown)"))),
                response: ResponseBodyInfo {
                    mime_type: "redirect".to_string(),
                    size_bytes: 0,
                    base64_encoded: false,
                    body: None,
                    body_state: Some("empty".to_string()),
                },
                initiator: rec.initiator,
                timing: TimingInfo { duration_ms: 0.0, breakdown: None },
                saved_file: None,
            };

            let redirect_dir = rec.session_dir.clone().unwrap_or_else(|| output_dir.to_path_buf());
            self.storage.append_request(&redirect_dir, &redirect_record);
            if let Ok(mut st) = self.stats.lock() {
                st.total_requests += 1;
                *st.by_status.entry("3xx".to_string()).or_insert(0) += 1;
                self.storage.write_summary(output_dir, &st);
                let _ = self.app_handle.emit("summary-updated", st.clone());
            }
            let _ = self.app_handle.emit("request-finished", redirect_record);
        }
    }

    fn cleanup_stale_in_flight(&self, ttl_ms: u64) {
        let now = Self::current_time_ms();
        let expired: Vec<InFlightRequest> = {
            let mut map = match self.in_flight.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            let stale: Vec<String> = map
                .iter()
                .filter(|(_, v)| now.saturating_sub(v.created_instant) >= ttl_ms)
                .map(|(k, _)| k.clone())
                .collect();
            stale.iter().filter_map(|k| map.remove(k)).collect()
        };
        for rec in expired {
            let expired_record = build_expired_record(&rec, ttl_ms);
            let write_dir = rec.session_dir.clone().unwrap_or_else(|| self.fallback_dir.clone());
            self.storage.append_request(&write_dir, &expired_record);
            let _ = self.app_handle.emit("request-finished", expired_record);
        }
    }
}



pub fn build_expired_record(rec: &InFlightRequest, ttl_ms: u64) -> FullTrafficRecord {
    let status_text = format!("(Expired: no response within {} s)", ttl_ms / 1000);
    FullTrafficRecord {
        id: rec.id.clone(),
        timestamp: rec.timestamp.clone(),
        session_id: rec.session_id.clone(),
        tab_id: rec.tab_id,
        tab_url: rec.tab_url.clone(),
        resource_type: rec.resource_type.clone(),
        url: rec.url.clone(),
        method: rec.method.clone(),
        status: 0,
        status_text: status_text.clone(),
        headers: FullHeaders {
            general: GeneralHeaders {
                request_url: rec.url.clone(),
                request_method: rec.method.clone(),
                status_code: status_text,
                remote_address: None,
                protocol: None,
                mime_type: Some("expired".to_string()),
            },
            request: rec.request_headers.clone(),
            response: json!({}),
            query_params: rec.query_params.clone(),
            request_payload: rec.post_data.clone(),
        },
        preview: json!("(Expired: the response never arrived; the request was abandoned by TTL cleanup)"),
        response: ResponseBodyInfo {
            mime_type: "expired".to_string(),
            size_bytes: 0,
            base64_encoded: false,
            body: None,
            body_state: Some("unavailable".to_string()),
        },
        initiator: rec.initiator.clone(),
        timing: TimingInfo { duration_ms: 0.0, breakdown: None },
        saved_file: None,
    }
}


pub fn compute_body_state(body: &Option<Value>, base64: bool, size: u64) -> &'static str {
    if body.is_some() {
        return "available";
    }
    if size == 0 {
        return "empty";
    }
    if base64 {
        
        return "available";
    }
    "unavailable"
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn truncation_is_char_boundary_safe() {
        
        
        let payload = "ж".repeat(400);
        let truncated = truncate_chars(&payload, 300);
        assert_eq!(truncated.chars().count(), 300 + "... (truncated)".chars().count());
        assert!(truncated.ends_with("... (truncated)"));

        assert_eq!(truncate_chars("short", 300), "short");
        let ascii = "a".repeat(500);
        assert_eq!(truncate_chars(&ascii, 300).chars().count(), 300 + 15);
    }
}
