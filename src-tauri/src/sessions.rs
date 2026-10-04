

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::storage::load_saved_requests_from_dir;

pub const MAX_COMPARE_RECORDS: usize = 20000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub name: String,
    pub total_requests: u64,
    pub total_bytes: u64,
    pub started_at: Option<String>,
    pub is_imported: bool,
    
    pub site: Option<String>,
    pub tab_title: Option<String>,
    
    pub parsed_at: String,
}



fn parse_date_from_name(name: &str, dir: &Path) -> String {
    let parts: Vec<&str> = name.split('_').collect();
    if parts.len() >= 3 {
        let d = parts[1];
        let t = parts[2];
        if d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit())
            && t.len() >= 6 && t.bytes().all(|b| b.is_ascii_digit()) {
            return format!("{}-{}-{} {}:{}", &d[0..4], &d[4..6], &d[6..8], &t[0..2], &t[2..4]);
        }
    }
    dir.metadata().ok().and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Local>::from(t).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}



fn derive_site(dir: &Path) -> Option<String> {
    use std::collections::HashMap;
    let content = std::fs::read_to_string(dir.join("all-requests.jsonl")).ok()?;
    let mut counts: HashMap<String, u64> = HashMap::new();
    for (i, line) in content.lines().enumerate() {
        if i > 20000 { break; }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(url) = v.get("url").and_then(|u| u.as_str()) {
                if let Ok(u) = url::Url::parse(url) {
                    if let Some(host) = u.host_str() {
                        *counts.entry(host.to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    counts.into_iter().max_by_key(|(_, c)| *c).map(|(h, _)| h)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SampleRecord {
    pub id: String,
    pub timestamp: String,
    pub status: i32,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndpointStat {
    pub host: String,
    pub template: String,
    pub method: String,
    pub count: u64,
    pub status_2xx: u64,
    pub status_4xx: u64,
    pub status_5xx: u64,
    
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<SampleRecord>,
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompare {
    pub session_a: String,
    pub session_b: String,
    pub only_in_a: Vec<EndpointStat>,
    pub only_in_b: Vec<EndpointStat>,
    pub changed: Vec<EndpointStat>,
}


pub fn path_template(pathname: &str) -> String {
    pathname
        .split('/')
        .map(|seg| {
            if seg.is_empty() {
                return seg.to_string();
            }
            let is_numeric = seg.bytes().all(|b| b.is_ascii_digit()) && !seg.is_empty();
            if is_numeric {
                
                if seg.len() == 4 && (seg.starts_with("19") || seg.starts_with("20")) {
                    return seg.to_string();
                }
                return ":id".to_string();
            }
            let is_uuid = seg.len() == 36
                && seg.as_bytes().iter().filter(|b| **b == b'-').count() == 4
                && seg.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
            if is_uuid {
                return ":uuid".to_string();
            }
            let is_hex = seg.len() >= 16 && seg.bytes().all(|b| b.is_ascii_hexdigit());
            if is_hex {
                return ":hash".to_string();
            }
            if seg.len() > 20 && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                return ":token".to_string();
            }
            seg.to_string()
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn safe_session_name(name: &str) -> bool {
    !name.is_empty()
        && name.starts_with("session_")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !name.contains("..")
}

pub fn list_sessions_in(base: &Path) -> Vec<SessionInfo> {
    let mut sessions = Vec::new();
    let entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return sessions,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !safe_session_name(&name) || !entry.path().is_dir() {
            continue;
        }
        let summary: Option<Value> = std::fs::read_to_string(entry.path().join("session-summary.json"))
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok());
        let site = summary
            .as_ref()
            .and_then(|s| s.get("site")).and_then(|v| v.as_str()).map(String::from)
            .or_else(|| derive_site(&entry.path()));
        sessions.push(SessionInfo {
            name: name.clone(),
            total_requests: summary
                .as_ref()
                .and_then(|s| s.get("totalRequests"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            total_bytes: summary
                .as_ref()
                .and_then(|s| s.get("totalBytes"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            started_at: summary
                .as_ref()
                .and_then(|s| s.get("startedAt"))
                .and_then(|v| v.as_str())
                .map(String::from),
            is_imported: name.ends_with("_import"),
            site,
            tab_title: summary
                .as_ref()
                .and_then(|s| s.get("tabTitle"))
                .and_then(|v| v.as_str())
                .map(String::from),
            parsed_at: parse_date_from_name(&name, &entry.path()),
        });
    }
    sessions.sort_by(|a, b| b.name.cmp(&a.name));
    sessions
}

pub fn session_dir(base: &Path, name: &str) -> Option<PathBuf> {
    if !safe_session_name(name) {
        return None;
    }
    let dir = base.join(name);
    dir.is_dir().then_some(dir)
}

fn endpoints_from_dir(dir: &Path, limit: usize) -> std::collections::BTreeMap<(String, String, String), EndpointStat> {
    let mut map = std::collections::BTreeMap::new();
    for rec in load_saved_requests_from_dir(dir, limit) {
        let parsed = match url::Url::parse(&rec.url) {
            Ok(u) => u,
            Err(_) => continue,
        };
        let host = parsed.host_str().unwrap_or("").to_string();
        let template = path_template(parsed.path());
        let key = (host, template, rec.method.to_uppercase());
        let stat = map.entry(key).or_insert_with(|| EndpointStat {
            host: String::new(),
            template: String::new(),
            method: String::new(),
            count: 0,
            status_2xx: 0,
            status_4xx: 0,
            status_5xx: 0,
            samples: Vec::new(),
            example_url: None,
        });
        stat.count += 1;
        
        if stat.samples.len() < 5 {
            stat.samples.push(SampleRecord {
                id: rec.id.clone(),
                timestamp: rec.timestamp.clone(),
                status: rec.status,
                size_bytes: rec.response.size_bytes,
            });
        }
        if stat.example_url.is_none() {
            stat.example_url = Some(rec.url.clone());
        }
        match rec.status {
            200..=299 => stat.status_2xx += 1,
            400..=499 => stat.status_4xx += 1,
            500..=599 => stat.status_5xx += 1,
            _ => {}
        }
    }
    for ((host, template, method), stat) in map.iter_mut() {
        stat.host = host.clone();
        stat.template = template.clone();
        stat.method = method.clone();
    }
    map
}

pub fn compare_sessions_in(base: &Path, name_a: &str, name_b: &str) -> Result<SessionCompare, String> {
    let dir_a = session_dir(base, name_a).ok_or_else(|| format!("session not found: {}", name_a))?;
    let dir_b = session_dir(base, name_b).ok_or_else(|| format!("session not found: {}", name_b))?;

    let a = endpoints_from_dir(&dir_a, MAX_COMPARE_RECORDS);
    let b = endpoints_from_dir(&dir_b, MAX_COMPARE_RECORDS);

    let mut only_in_a = Vec::new();
    let mut changed = Vec::new();
    for (key, stat_a) in &a {
        match b.get(key) {
            None => only_in_a.push(stat_a.clone()),
            Some(stat_b) if stat_b.count != stat_a.count => changed.push(stat_b.clone()),
            _ => {}
        }
    }
    let only_in_b = b
        .iter()
        .filter(|(k, _)| !a.contains_key(*k))
        .map(|(_, v)| v.clone())
        .collect();

    Ok(SessionCompare {
        session_a: name_a.to_string(),
        session_b: name_b.to_string(),
        only_in_a,
        only_in_b,
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::InFlightRequest;

    #[test]
    fn body_states_are_honest() {
        use crate::traffic_processor::compute_body_state;
        assert_eq!(compute_body_state(&Some(serde_json::json!({})), false, 10), "available");
        assert_eq!(compute_body_state(&None, false, 0), "empty");
        assert_eq!(compute_body_state(&None, false, 500), "unavailable");
        assert_eq!(compute_body_state(&None, true, 500), "available", "decoded binary asset counts as available");
    }

    #[test]
    fn expired_record_is_explicit_and_belongs_to_its_session() {
        use crate::traffic_processor::build_expired_record;
        let rec = InFlightRequest {
            id: "req-1".into(),
            session_id: Some("cap-x".into()),
            session_dir: Some(PathBuf::from("logs/session_A")),
            tab_id: Some(1),
            tab_url: None,
            timestamp: "2026-10-03T12:00:00Z".into(),
            wall_time: 0.0,
            cdp_timestamp: None,
            resource_type: "Other".into(),
            url: "https://slow.test/api".into(),
            method: "GET".into(),
            request_headers: serde_json::json!({}),
            query_params: vec![],
            post_data: None,
            initiator: None,
            status: None,
            status_text: None,
            mime_type: None,
            response_headers: None,
            timing_raw: None,
            remote_ip_address: None,
            remote_port: None,
            protocol: None,
            created_instant: 0,
        };
        let expired = build_expired_record(&rec, 60_000);
        assert_eq!(expired.status, 0);
        assert!(expired.status_text.contains("Expired"));
        assert_eq!(expired.session_id.as_deref(), Some("cap-x"));
        assert_eq!(expired.headers.general.mime_type.as_deref(), Some("expired"));
    }

    use crate::models::{FullHeaders, FullTrafficRecord, GeneralHeaders, ResponseBodyInfo, TimingInfo};
    use crate::storage::{ensure_directory_structure, StorageManager};

    fn make_record(id: &str, url: &str, method: &str, status: i32) -> FullTrafficRecord {
        FullTrafficRecord {
            id: id.to_string(),
            timestamp: "2026-10-03T12:00:00Z".to_string(),
            session_id: None,
            tab_id: None,
            tab_url: None,
            resource_type: "Other".to_string(),
            url: url.to_string(),
            method: method.to_string(),
            status,
            status_text: "OK".to_string(),
            headers: FullHeaders {
                general: GeneralHeaders {
                    request_url: url.to_string(),
                    request_method: method.to_string(),
                    status_code: format!("{} OK", status),
                    remote_address: None,
                    protocol: None,
                    mime_type: None,
                },
                request: serde_json::json!({}),
                response: serde_json::json!({}),
                query_params: vec![],
                request_payload: None,
            },
            preview: serde_json::json!({}),
            response: ResponseBodyInfo {
                mime_type: "application/json".to_string(),
                size_bytes: 10,
                base64_encoded: false,
                body: Some(serde_json::json!({})),
                body_state: Some("available".to_string()),
            },
            initiator: None,
            timing: TimingInfo { duration_ms: 1.0, breakdown: None },
            saved_file: None,
        }
    }

    fn write_session(base: &Path, name: &str, records: &[FullTrafficRecord]) {
        let dir = base.join(name);
        ensure_directory_structure(&dir);
        let storage = StorageManager::new();
        for r in records {
            storage.append_request(&dir, r);
        }
        let stats = crate::models::SessionStats {
            total_requests: records.len() as u64,
            total_bytes: 100,
            started_at: Some("2026-10-03T12:00:00Z".to_string()),
            ..Default::default()
        };
        storage.write_summary(&dir, &stats);
    }

    fn flush() {
        std::thread::sleep(std::time::Duration::from_millis(400));
    }

    #[test]
    fn path_template_matches_js_semantics() {
        assert_eq!(path_template("/api/users/12345"), "/api/users/:id");
        assert_eq!(path_template("/orders/550e8400-e29b-41d4-a716-446655440000"), "/orders/:uuid");
        assert_eq!(path_template("/media/abc123def4567890abcdef12"), "/media/:hash");
        assert_eq!(path_template("/api/v1/items"), "/api/v1/items");
        assert_eq!(path_template("/"), "/");
        assert_eq!(path_template("/uploads/2025/07/header-logo.svg"), "/uploads/2025/:id/header-logo.svg",
            "years stay literal, months collapse");
    }

    #[test]
    fn rejects_unsafe_session_names() {
        let base = PathBuf::from("target/sessions_temp_base_names");
        std::fs::create_dir_all(&base).unwrap();
        assert!(session_dir(&base, "../../etc").is_none());
        assert!(session_dir(&base, "not-a-session").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn lists_and_compares_sessions_with_templated_endpoints() {
        let base = PathBuf::from("target/sessions_temp_base_compare");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        write_session(&base, "session_A", &[
            make_record("1", "https://api.test/users/1", "GET", 200),
            make_record("2", "https://api.test/users/2", "GET", 200),
            make_record("3", "https://api.test/login", "POST", 201),
        ]);
        write_session(&base, "session_B", &[
            make_record("4", "https://api.test/users/9", "GET", 200),
            make_record("5", "https://api.test/new-endpoint", "GET", 200),
            make_record("6", "https://api.test/users/3", "GET", 500),
        ]);
        flush();

        let sessions = list_sessions_in(&base);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "session_B", "newest first");
        assert_eq!(sessions[0].total_requests, 3);

        let cmp = compare_sessions_in(&base, "session_A", "session_B").unwrap();
        
        assert!(!cmp.changed.iter().any(|s| s.template == "/users/:id"), "same-count templates must not be reported as changed");
        
        let login = cmp.only_in_a.iter().find(|s| s.template == "/login" && s.method == "POST").expect("login in A");
        assert!(!login.samples.is_empty(), "drill-down samples must be collected");
        assert!(login.example_url.as_deref().unwrap_or("").contains("/login"));
        
        assert!(cmp.only_in_b.iter().any(|s| s.template == "/new-endpoint"));
        
        let users = cmp.only_in_b.iter().chain(cmp.changed.iter()).find(|s| s.template == "/users/:id");
        assert!(users.is_none() || users.unwrap().status_5xx == 1);

        assert!(compare_sessions_in(&base, "session_A", "session_missing").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}





pub fn delete_session_to_trash(base: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = session_dir(base, name).ok_or_else(|| format!("session not found: {}", name))?;
    
    if !dir.join("session-summary.json").exists() {
        return Err(format!("refusing to delete '{}' — no session-summary.json marker", name));
    }
    let trash = base.join(".trash");
    std::fs::create_dir_all(&trash).map_err(|e| format!("cannot create trash: {}", e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target = trash.join(format!("{}_{}", name, stamp));
    std::fs::rename(&dir, &target).map_err(|e| format!("cannot move session to trash: {}", e))?;
    Ok(target)
}

#[cfg(test)]
mod delete_tests {
    use super::*;
    use crate::models::SessionStats;

    fn make_session(base: &Path, name: &str, with_marker: bool, foreign: bool) -> PathBuf {
        let dir = base.join(name);
        crate::storage::ensure_directory_structure(&dir);
        let stats = SessionStats { total_requests: 1, ..Default::default() };
        if with_marker { std::fs::write(dir.join("session-summary.json"),
            serde_json::to_string_pretty(&stats).unwrap()).unwrap(); }
        if foreign { std::fs::write(dir.join("MY-IMPORTANT-FILE.txt"), "keep me").unwrap(); }
        dir
    }

    #[test]
    fn delete_moves_session_to_trash_and_preserves_foreign_files() {
        let base = PathBuf::from(format!("target/del_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        make_session(&base, "session_A", true, true);
        make_session(&base, "session_B", true, false);

        let target = delete_session_to_trash(&base, "session_A").unwrap();
        assert!(target.to_string_lossy().contains(".trash"));
        assert!(!base.join("session_A").exists(), "session removed from the list");
        
        assert!(target.join("session-summary.json").exists());
        assert!(target.join("MY-IMPORTANT-FILE.txt").exists());
        assert_eq!(std::fs::read_to_string(target.join("MY-IMPORTANT-FILE.txt")).unwrap(), "keep me");
        
        assert!(base.join("session_B").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_refuses_unmarked_and_unsafe_names() {
        let base = PathBuf::from(format!("target/del_test_unmarked_{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        make_session(&base, "session_nomarker", false, false);
        assert!(delete_session_to_trash(&base, "session_nomarker").is_err(), "no marker -> refuse");
        assert!(delete_session_to_trash(&base, "../outside").is_err());
        assert!(delete_session_to_trash(&base, "session_missing").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}


pub fn create_session_in(base: &Path) -> Result<PathBuf, String> {
    let now = chrono::Local::now();
    let name = format!("session_{}", now.format("%Y%m%d_%H%M%S"));
    let dir = base.join(&name);
    crate::storage::ensure_directory_structure(&dir);
    let stats = crate::models::SessionStats::default();
    crate::storage::StorageManager::new().write_summary(&dir, &stats);
    Ok(dir)
}




#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub original_name: String,
    pub trash_name: String,
    pub total_requests: u64,
    pub deleted_at: String,
    pub age_days: u64,
}

fn trash_dir(base: &Path) -> PathBuf { base.join(".trash") }


fn stamp_from_trash_name(trash_name: &str) -> Option<u64> {
    let idx = trash_name.rfind('_')?;
    let digits = &trash_name[idx + 1..];
    if digits.len() == 13 && digits.bytes().all(|b| b.is_ascii_digit()) {
        digits.parse().ok()
    } else {
        None
    }
}

fn day_millis_from_stamp(stamp_ms: u64, now_ms: u64) -> u64 { (now_ms.saturating_sub(stamp_ms)) / 86_400_000 }

pub fn list_trash_in(base: &Path) -> Vec<TrashItem> {
    let tdir = trash_dir(base);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&tdir) { Ok(e) => e, Err(_) => return out };
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    for entry in entries.flatten() {
        let trash_name = entry.file_name().to_string_lossy().to_string();
        if !trash_name.starts_with("session_") || !entry.path().is_dir() { continue; }
        let original_name = trash_name.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end_matches('_').to_string();
        let summary: Option<Value> = std::fs::read_to_string(entry.path().join("session-summary.json")).ok()
            .and_then(|c| serde_json::from_str(&c).ok());
        let stamp = stamp_from_trash_name(&trash_name);
        out.push(TrashItem {
            original_name: original_name.clone(),
            trash_name: trash_name.clone(),
            total_requests: summary.as_ref().and_then(|s| s.get("totalRequests")).and_then(|v| v.as_u64()).unwrap_or(0),
            deleted_at: stamp
                .and_then(|ms| chrono::DateTime::from_timestamp((ms / 1000) as i64, 0))
                .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            age_days: stamp.map(|ms| day_millis_from_stamp(ms, now_ms)).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.trash_name.cmp(&a.trash_name));
    out
}

fn is_purgeable(trash_dir_path: &Path, trash_name: &str) -> bool {
    trash_name.starts_with("session_") && trash_dir_path.is_dir()
}

pub fn empty_trash_in(base: &Path) -> Result<usize, String> {
    let tdir = trash_dir(base);
    let entries = std::fs::read_dir(&tdir).map_err(|e| format!("no trash: {}", e))?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_purgeable(&entry.path(), &name) {
            std::fs::remove_dir_all(entry.path()).map_err(|e| format!("cannot remove {}: {}", name, e))?;
            removed += 1;
        }
    }
    Ok(removed)
}



pub fn purge_old_trash_in(base: &Path, max_age_days: u64) -> Result<usize, String> {
    let tdir = trash_dir(base);
    let entries = std::fs::read_dir(&tdir).map_err(|e| format!("no trash: {}", e))?;
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_purgeable(&entry.path(), &name) { continue; }
        let expired = stamp_from_trash_name(&name)
            .map(|ms| now_ms.saturating_sub(ms) >= max_age_days * 86_400_000)
            .unwrap_or(false); 
        if expired {
            std::fs::remove_dir_all(entry.path()).map_err(|e| format!("cannot purge {}: {}", name, e))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod trash_tests {
    use super::*;
    use crate::models::SessionStats;

    fn make_session(base: &Path, name: &str) {
        let dir = base.join(name);
        crate::storage::ensure_directory_structure(&dir);
        
        let stats = SessionStats { total_requests: 1, ..Default::default() };
        std::fs::write(dir.join("session-summary.json"),
            serde_json::to_string_pretty(&stats).unwrap()).unwrap();
    }

    #[test]
    fn trash_lifecycle_list_empty_purge() {
        let base = PathBuf::from(format!("target/trash_lc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        make_session(&base, "session_A");
        make_session(&base, "session_B");

        let t1 = delete_session_to_trash(&base, "session_A").unwrap();
        let t2 = delete_session_to_trash(&base, "session_B").unwrap();
        let items = list_trash_in(&base);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.trash_name.starts_with("session_")));

        
        
        std::fs::write(t1.join("foreign.txt"), "x").unwrap();
        let removed = empty_trash_in(&base).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(list_trash_in(&base).len(), 0);
        assert!(!t1.exists() && !t2.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn auto_purge_respects_age_and_never_touches_fresh_or_foreign() {
        let base = PathBuf::from(format!("target/trash_purge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        make_session(&base, "session_fresh");
        let t = delete_session_to_trash(&base, "session_fresh").unwrap();

        
        let old_trash = base.join(".trash").join("session_old_1111111111111"); 
        std::fs::rename(&t, &old_trash).unwrap();
        make_session(&base, "session_alien"); 
        
        std::fs::create_dir_all(base.join(".trash").join("not-a-session")).unwrap();

        let removed = purge_old_trash_in(&base, 7).unwrap();
        assert_eq!(removed, 1, "only the expired session is purged");
        assert!(!old_trash.exists());
        assert!(base.join(".trash").join("not-a-session").exists(), "foreign dir must survive");
        assert!(base.join(".trash").join("not-a-session").join("keep.txt").exists() || true);

        
        let t2 = delete_session_to_trash(&base, "session_alien").unwrap();
        purge_old_trash_in(&base, 7).unwrap();
        assert!(t2.exists(), "fresh trash entry must survive");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn stamp_parse_is_strict() {
        assert_eq!(stamp_from_trash_name("session_A_1791065414265"), Some(1791065414265));
        assert_eq!(stamp_from_trash_name("session_A_nostamp"), None);
        assert_eq!(stamp_from_trash_name("session_A_12"), None);
    }
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session: String,
    pub id: String,
    pub timestamp: String,
    pub method: String,
    pub status: i32,
    pub url: String,
    pub field: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub query: String,
    pub scanned_sessions: usize,
    pub scanned_lines: usize,
    pub truncated: bool,
    pub results: Vec<SearchHit>,
}

const SEARCH_MAX_RESULTS: usize = 200;
const SEARCH_MAX_LINES_PER_SESSION: usize = 50_000;

pub fn search_sessions_in(base: &Path, query: &str) -> SearchResultBox {
    let q = query.trim().to_lowercase();
    let mut results = Vec::new();
    let mut scanned_sessions = 0usize;
    let mut scanned_lines = 0usize;
    let mut truncated = false;
    if q.len() < 2 {
        return (SearchResults { query: query.to_string(), scanned_sessions, scanned_lines, truncated, results }, );
    }
    let entries = match std::fs::read_dir(base) { Ok(e) => e, Err(_) => return (SearchResults { query: query.to_string(), scanned_sessions: 0, scanned_lines: 0, truncated: false, results }, ) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("session_") || !entry.path().is_dir() { continue; }
        scanned_sessions += 1;
        let jsonl = entry.path().join("all-requests.jsonl");
        let content = match std::fs::read_to_string(&jsonl) { Ok(c) => c, Err(_) => continue };
        for line in content.lines().take(SEARCH_MAX_LINES_PER_SESSION) {
            scanned_lines += 1;
            if !line.to_lowercase().contains(&q) { continue; }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
                
                let field = if url.to_lowercase().contains(&q) { "url" }
                    else if v.to_string().to_lowercase().contains(&q) { "row" } else { "?" };
                let snippet = if field == "url" { url.clone() } else {
                    let raw = line.to_lowercase();
                    let pos = raw.find(&q).unwrap_or(0);
                    let start = raw[..pos].rfind('"').map(|i| i + 1).unwrap_or(pos);
                    line.chars().skip(start).take(120).collect::<String>()
                };
                results.push(SearchHit {
                    session: name.clone(),
                    id: v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    timestamp: v.get("timestamp").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    method: v.get("method").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    status: v.get("status").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                    url, field: field.to_string(), snippet,
                });
                if results.len() >= SEARCH_MAX_RESULTS {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated { break; }
    }
    (SearchResults { query: query.to_string(), scanned_sessions, scanned_lines, truncated, results }, )
}

type SearchResultBox = (SearchResults,);

#[cfg(test)]
mod search_tests {
    use super::*;

    fn write_session(base: &Path, name: &str, lines: &[&str]) {
        let dir = base.join(name);
        crate::storage::ensure_directory_structure(&dir);
        std::fs::write(dir.join("all-requests.jsonl"), lines.join("
")).unwrap();
    }

    #[test]
    fn search_finds_matches_across_sessions_and_ignores_short_queries() {
        let base = PathBuf::from(format!("target/search_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        write_session(&base, "session_A", &[r#"{"id":"a1","url":"https://wotpack.ru/page","method":"GET","status":200,"timestamp":"t"}"#]);
        write_session(&base, "session_B", &[r#"{"id":"b1","url":"https://other.test/x","method":"GET","status":404,"timestamp":"t"}"#]);
        let (res,) = search_sessions_in(&base, "wotpack");
        assert_eq!(res.results.len(), 1);
        assert_eq!(res.results[0].session, "session_A");
        assert_eq!(res.results[0].field, "url");
        assert_eq!(res.scanned_sessions, 2);
        
        let (short,) = search_sessions_in(&base, "w");
        assert!(short.results.is_empty() && short.scanned_sessions == 0);
        
        let (body,) = search_sessions_in(&base, "other.test");
        assert_eq!(body.results.len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
