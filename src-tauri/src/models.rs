use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSummary {
    pub id: i64,
    pub title: String,
    pub url: String,
    pub active: bool,
    pub is_attached: bool,
}




#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureProgress {
    pub tab_id: Option<i64>,
    pub attached: bool,
    pub network_enabled: bool,
    pub last_error: Option<String>,
    pub updated_at_ms: u64,
}



pub fn compute_capture_stage(
    extension_connected: bool,
    capture_enabled: bool,
    target_attached: bool,
    network_enabled: bool,
) -> &'static str {
    if !extension_connected {
        return "waiting_extension";
    }
    if !capture_enabled {
        return "ready";
    }
    if !target_attached {
        return "target_pending";
    }
    if !network_enabled {
        return "network_pending";
    }
    "recording"
}

#[cfg(test)]
mod tests {
    use super::compute_capture_stage;

    #[test]
    fn mock_status_updates_only_on_change() {
        use super::{apply_mock_status, MockRule};
        let mut rules = vec![MockRule {
            id: "m".into(), name: "r".into(), url_pattern: "*".into(), method: "ALL".into(),
            status_code: 200, content_type: "application/json".into(), headers: Default::default(),
            response_body: "{}".into(), enabled: true, last_status: None,
        }];
        assert!(apply_mock_status(&mut rules, "m", true, None, 100), "first ACK must mark changed");
        assert_eq!(rules[0].last_status.as_ref().unwrap().ok, true);
        assert!(!apply_mock_status(&mut rules, "m", true, None, 200), "same ACK must not mark changed");
        assert!(apply_mock_status(&mut rules, "m", false, Some("blocked".into()), 300), "failure ACK must be recorded");
        assert_eq!(rules[0].last_status.as_ref().unwrap().error.as_deref(), Some("blocked"));
        assert!(!apply_mock_status(&mut rules, "unknown", true, None, 400), "unknown rule id is a no-op");
    }

    #[test]
    fn stages_are_monotonic_and_honest() {
        
        assert_eq!(compute_capture_stage(false, true, true, true), "waiting_extension");
        
        assert_eq!(compute_capture_stage(true, false, false, false), "ready");
        
        assert_eq!(compute_capture_stage(true, true, false, false), "target_pending");
        
        assert_eq!(compute_capture_stage(true, true, true, false), "network_pending");
        
        assert_eq!(compute_capture_stage(true, true, true, true), "recording");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub started_at: Option<String>,
    pub total_requests: u64,
    pub total_bytes: u64,
    pub by_type: HashMap<String, u64>,
    pub by_status: HashMap<String, u64>,
    
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_title: Option<String>,
}

impl Default for SessionStats {
    fn default() -> Self {
        let mut by_type = HashMap::new();
        for cat in &["Doc", "CSS", "JS", "Font", "Img", "Media", "Manifest", "Socket", "Wasm", "Other"] {
            by_type.insert(cat.to_string(), 0);
        }
        let mut by_status = HashMap::new();
        for st in &["2xx", "3xx", "4xx", "5xx", "other"] {
            by_status.insert(st.to_string(), 0);
        }
        Self {
            started_at: None,
            total_requests: 0,
            total_bytes: 0,
            by_type,
            by_status,
            site: None,
            tab_title: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParam {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitiatorInfo {
    #[serde(rename = "type")]
    pub initiator_type: String,
    pub url: Option<String>,
    pub line_number: Option<i64>,
    pub column_number: Option<i64>,
    pub stack: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralHeaders {
    pub request_url: String,
    pub request_method: String,
    pub status_code: String,
    pub remote_address: Option<String>,
    pub protocol: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullHeaders {
    pub general: GeneralHeaders,
    pub request: serde_json::Value,
    pub response: serde_json::Value,
    pub query_params: Vec<QueryParam>,
    pub request_payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingBreakdown {
    pub dns: Option<f64>,
    pub connect: Option<f64>,
    pub ssl: Option<f64>,
    pub send: Option<f64>,
    pub ttfb: Option<f64>,
    pub download: Option<f64>,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingInfo {
    pub duration_ms: f64,
    pub breakdown: Option<TimingBreakdown>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseBodyInfo {
    pub mime_type: String,
    pub size_bytes: u64,
    pub base64_encoded: bool,
    pub body: Option<serde_json::Value>,
    
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullTrafficRecord {
    pub id: String,
    pub timestamp: String,
    
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub tab_id: Option<i64>,
    pub tab_url: Option<String>,
    pub resource_type: String,
    pub url: String,
    pub method: String,
    pub status: i32,
    pub status_text: String,
    pub headers: FullHeaders,
    pub preview: serde_json::Value,
    pub response: ResponseBodyInfo,
    pub initiator: Option<InitiatorInfo>,
    pub timing: TimingInfo,
    pub saved_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketFrameRecord {
    pub socket_id: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub direction: String,
    pub opcode: Option<i32>,
    pub preview: String,
    pub payload_data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightRequest {
    pub id: String,
    pub session_id: Option<String>,
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<std::path::PathBuf>,
    pub tab_id: Option<i64>,
    pub tab_url: Option<String>,
    pub timestamp: String,
    pub wall_time: f64,
    pub cdp_timestamp: Option<f64>,
    pub resource_type: String,
    pub url: String,
    pub method: String,
    pub request_headers: serde_json::Value,
    pub query_params: Vec<QueryParam>,
    pub post_data: Option<serde_json::Value>,
    pub initiator: Option<InitiatorInfo>,
    pub status: Option<i32>,
    pub status_text: Option<String>,
    pub mime_type: Option<String>,
    pub response_headers: Option<serde_json::Value>,
    pub timing_raw: Option<serde_json::Value>,
    pub remote_ip_address: Option<String>,
    pub remote_port: Option<i32>,
    pub protocol: Option<String>,
    pub created_instant: u64, 
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInitialState {
    pub is_connected: bool,
    pub is_extension_connected: bool,
    pub is_port_connected: bool,
    pub chrome_port: u16,
    pub current_output_dir: String,
    pub target_site_filter: String,
    pub exclude_trackers: bool,
    pub open_tabs: Vec<TabSummary>,
    pub chrome_found: bool,
    pub saved_requests: Vec<FullTrafficRecord>,
    pub session_stats: SessionStats,
    #[serde(default)]
    pub bridge_error: Option<String>,
    #[serde(default)]
    pub capture_stage: String,
    #[serde(default)]
    pub target_attached: bool,
    #[serde(default)]
    pub network_enabled: bool,
    
    #[serde(default)]
    pub delivery: Option<serde_json::Value>,
    
    #[serde(default)]
    pub browser_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeStatusPayload {
    pub is_connected: bool,
    pub is_extension_connected: bool,
    pub is_port_connected: bool,
    pub chrome_port: u16,
    pub current_output_dir: String,
    pub target_site_filter: String,
    pub open_tabs: Vec<TabSummary>,
    #[serde(default)]
    pub bridge_error: Option<String>,
    #[serde(default)]
    pub capture_stage: String,
    #[serde(default)]
    pub target_attached: bool,
    #[serde(default)]
    pub network_enabled: bool,
    
    #[serde(default)]
    pub delivery: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeaterRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeaterResponse {
    pub status: u16,
    pub status_text: String,
    pub duration_ms: u64,
    pub size_bytes: usize,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub is_json: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockRule {
    pub id: String,
    pub name: String,
    pub url_pattern: String,
    pub method: String,
    pub status_code: u16,
    pub content_type: String,
    pub headers: HashMap<String, String>,
    pub response_body: String,
    pub enabled: bool,
    
    #[serde(default)]
    pub last_status: Option<MockRuleStatus>,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MockRuleStatus {
    pub ok: bool,
    pub error: Option<String>,
    pub at_ms: u64,
}




pub fn apply_mock_status(rules: &mut [MockRule], rule_id: &str, ok: bool, error: Option<String>, now_ms: u64) -> bool {
    let mut changed = false;
    for rule in rules.iter_mut() {
        if rule.id == rule_id {
            let differs = match &rule.last_status {
                Some(prev) => prev.ok != ok || prev.error != error,
                None => true,
            };
            if differs {
                rule.last_status = Some(MockRuleStatus { ok, error, at_ms: now_ms });
                changed = true;
            }
            break;
        }
    }
    changed
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSocketSendCommand {
    pub socket_id: String,
    pub message: String,
    pub opcode: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarImportResult {
    pub output_dir: String,
    pub imported: usize,
    pub skipped: usize,
    pub session_stats: SessionStats,
}

