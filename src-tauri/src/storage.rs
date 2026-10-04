use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use crate::models::{FullTrafficRecord, SessionStats, WebSocketFrameRecord};

pub const SUBDIRS: &[&str] = &[
    "Doc", "CSS", "JS", "Font", "Img", "Media", "Manifest", "Socket", "Wasm", "Other",
];

pub enum StorageCommand {
    AppendRequest(PathBuf, FullTrafficRecord),
    AppendSocketFrame(PathBuf, WebSocketFrameRecord),
    WriteSummary(PathBuf, SessionStats),
}

#[derive(Clone)]
pub struct StorageManager {
    tx: Sender<StorageCommand>,
}

impl StorageManager {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<StorageCommand>();
        thread::spawn(move || {
            Self::worker_loop(rx);
        });
        Self { tx }
    }

    fn worker_loop(rx: Receiver<StorageCommand>) {
        while let Ok(cmd) = rx.recv() {
            match cmd {
                StorageCommand::AppendRequest(dir, record) => {
                    let jsonl_path = dir.join("all-requests.jsonl");
                    if let Ok(line) = serde_json::to_string(&record) {
                        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&jsonl_path) {
                            let _ = writeln!(f, "{}", line);
                        }
                    }
                }
                StorageCommand::AppendSocketFrame(dir, frame) => {
                    let socket_dir = dir.join("Socket");
                    let _ = fs::create_dir_all(&socket_dir);
                    let frames_path = socket_dir.join("websocket_frames.jsonl");
                    if let Ok(line) = serde_json::to_string(&frame) {
                        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&frames_path) {
                            let _ = writeln!(f, "{}", line);
                        }
                    }
                }
                StorageCommand::WriteSummary(dir, stats) => {
                    let summary_path = dir.join("session-summary.json");
                    if let Ok(data) = serde_json::to_string_pretty(&stats) {
                        let _ = fs::write(summary_path, data);
                    }
                }
            }
        }
    }

    pub fn append_request(&self, dir: &Path, record: &FullTrafficRecord) {
        let _ = self.tx.send(StorageCommand::AppendRequest(dir.to_path_buf(), record.clone()));
    }

    pub fn append_socket_frame(&self, dir: &Path, frame: &WebSocketFrameRecord) {
        let _ = self.tx.send(StorageCommand::AppendSocketFrame(dir.to_path_buf(), frame.clone()));
    }

    pub fn write_summary(&self, dir: &Path, stats: &SessionStats) {
        let _ = self.tx.send(StorageCommand::WriteSummary(dir.to_path_buf(), stats.clone()));
    }

}

pub fn ensure_directory_structure(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    for sub in SUBDIRS {
        let _ = fs::create_dir_all(dir.join(sub));
    }
}


pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix("\\\\?\\").map(|r| r.to_string()).unwrap_or(s)
}

pub fn get_timestamp_slug() -> String {
    let now = chrono::Local::now();
    now.format("%Y%m%d_%H%M%S").to_string()
}

pub fn get_default_logs_base() -> PathBuf {
    
    let local = PathBuf::from("logs");
    if local.exists() && local.is_dir() {
        return std::fs::canonicalize(&local).unwrap_or(local);
    }
    
    let parent = PathBuf::from("..").join("logs");
    if parent.exists() && parent.is_dir() {
        return std::fs::canonicalize(&parent).unwrap_or(parent);
    }
    
    let _ = std::fs::create_dir_all(&local);
    std::fs::canonicalize(&local).unwrap_or(local)
}

pub fn get_latest_session_dir() -> PathBuf {
    let base = get_default_logs_base();
    let _ = fs::create_dir_all(&base);
    if let Ok(entries) = fs::read_dir(&base) {
        let mut dirs: Vec<String> = entries
            .flatten()
            .filter(|e| {
                e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                    && e.file_name().to_string_lossy().starts_with("session_")
            })
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        dirs.sort();
        dirs.reverse();
        if let Some(first) = dirs.first() {
            return base.join(first);
        }
    }
    base.join(format!("session_{}", get_timestamp_slug()))
}

pub fn sanitize_filename(str_val: &str) -> String {
    let sanitized: String = str_val
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if sanitized.len() > 60 {
        sanitized[..60].to_string()
    } else if sanitized.is_empty() {
        "req".to_string()
    } else {
        sanitized
    }
}

pub fn save_detailed_record(dir: &Path, category: &str, filename: &str, record: &FullTrafficRecord) -> Option<String> {
    let cat_dir = dir.join(category);
    let _ = fs::create_dir_all(&cat_dir);
    let full_path = cat_dir.join(filename);
    if let Ok(json_str) = serde_json::to_string_pretty(record) {
        if fs::write(&full_path, json_str).is_ok() {
            return Some(full_path.to_string_lossy().to_string());
        }
    }
    None
}

pub fn save_raw_asset(dir: &Path, category: &str, filename: &str, buffer: &[u8]) -> Option<String> {
    let cat_dir = dir.join(category);
    let _ = fs::create_dir_all(&cat_dir);
    let full_path = cat_dir.join(filename);
    if fs::write(&full_path, buffer).is_ok() {
        Some(full_path.to_string_lossy().to_string())
    } else {
        None
    }
}

pub fn load_saved_requests_from_dir(dir: &Path, limit: usize) -> Vec<FullTrafficRecord> {
    let jsonl_path = dir.join("all-requests.jsonl");
    if !jsonl_path.exists() {
        return Vec::new();
    }

    let file = match File::open(&jsonl_path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().flatten().filter(|l| !l.trim().is_empty()).collect();
    let start_idx = if lines.len() > limit { lines.len() - limit } else { 0 };

    let mut records = Vec::new();
    for line in &lines[start_idx..] {
        if let Ok(rec) = serde_json::from_str::<FullTrafficRecord>(line) {
            records.push(rec);
        }
    }
    records
}

pub fn load_summary_from_dir(dir: &Path) -> Option<SessionStats> {
    let summary_path = dir.join("session-summary.json");
    if summary_path.exists() {
        if let Ok(content) = fs::read_to_string(summary_path) {
            if let Ok(stats) = serde_json::from_str::<SessionStats>(&content) {
                return Some(stats);
            }
        }
    }
    None
}


pub fn mock_rules_file() -> PathBuf {
    std::env::var("APPDATA")
        .map(|base| PathBuf::from(base).join("network-path").join("mock-rules.json"))
        .unwrap_or_else(|_| PathBuf::from("mock-rules.json"))
}

pub fn load_mock_rules_from(path: &Path) -> Vec<crate::models::MockRule> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save_mock_rules_to(path: &Path, rules: &[crate::models::MockRule]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create config dir: {}", e))?;
    }
    let data = serde_json::to_string_pretty(rules).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| format!("cannot write mock rules: {}", e))
}

pub fn save_export_sync(dir: &Path, filename: &str, content: &str) -> std::io::Result<PathBuf> {
    let exports_dir = dir.join("exports");
    fs::create_dir_all(&exports_dir)?;
    let clean_name = Path::new(filename)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let file_path = exports_dir.join(clean_name.as_ref());
    fs::write(&file_path, content)?;
    Ok(file_path)
}


#[cfg(test)]
mod tests {
    use super::{load_mock_rules_from, save_mock_rules_to};
    use crate::models::{MockRule, MockRuleStatus};

    #[test]
    fn mock_rules_round_trip_with_last_status() {
        
        
        let dir = std::path::PathBuf::from(format!("target/mock_rules_temp_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mock-rules.json");
        let rules = vec![MockRule {
            id: "m1".into(), name: "stub auth".into(), url_pattern: "*/api/auth*".into(),
            method: "POST".into(), status_code: 401, content_type: "application/json".into(),
            headers: Default::default(), response_body: "{\"error\":\"mocked\"}".into(),
            enabled: true,
            last_status: Some(MockRuleStatus { ok: false, error: Some("fulfill failed".into()), at_ms: 42 }),
        }];
        save_mock_rules_to(&file, &rules).expect("save");
        let back = load_mock_rules_from(&file);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "m1");
        assert_eq!(back[0].last_status.as_ref().unwrap().ok, false);
        assert_eq!(back[0].last_status.as_ref().unwrap().error.as_deref(), Some("fulfill failed"));
    }
}
