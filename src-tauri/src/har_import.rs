



use serde_json::{json, Value};
use url::Url;

use crate::models::{
    FullHeaders, FullTrafficRecord, GeneralHeaders, InitiatorInfo, QueryParam, ResponseBodyInfo,
    SessionStats, TimingBreakdown, TimingInfo,
};
use crate::storage::sanitize_filename;
use crate::traffic_processor::normalize_resource_type;

pub const MAX_HAR_BYTES: usize = 256 * 1024 * 1024;

pub struct HarImport {
    pub records: Vec<FullTrafficRecord>,
    pub skipped: usize,
}

fn extension_category(url: &str, mime: &str) -> &'static str {
    let lower_mime = mime.to_lowercase();
    let path = Url::parse(url).map(|u| u.path().to_lowercase()).unwrap_or_default();
    let ext = path.rsplit('.').next().unwrap_or("").to_string();

    if lower_mime.starts_with("image/") || matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "avif") {
        return "Img";
    }
    if lower_mime.starts_with("video/") || lower_mime.starts_with("audio/") || matches!(ext.as_str(), "mp4" | "webm" | "mp3" | "ogg" | "m4a") {
        return "Media";
    }
    if lower_mime.contains("css") || ext == "css" {
        return "CSS";
    }
    if lower_mime.contains("javascript") || lower_mime.contains("ecmascript") || matches!(ext.as_str(), "js" | "mjs" | "cjs") {
        return "JS";
    }
    if lower_mime.starts_with("font/") || lower_mime.contains("woff") || matches!(ext.as_str(), "woff" | "woff2" | "ttf" | "otf") {
        return "Font";
    }
    if lower_mime == "text/html" || ext == "html" || ext == "htm" {
        return "Doc";
    }
    if lower_mime.contains("manifest") || ext == "webmanifest" {
        return "Manifest";
    }
    if lower_mime.contains("wasm") || ext == "wasm" {
        return "Wasm";
    }
    "Other"
}

fn headers_to_value(list: Option<&Vec<Value>>) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(items) = list {
        for h in items {
            let name = h.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let value = h.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            match map.get_mut(&name) {
                
                Some(Value::Array(arr)) => arr.push(Value::String(value)),
                Some(existing) => {
                    let prev = existing.take();
                    map.insert(name.clone(), json!([prev, value]));
                }
                None => {
                    map.insert(name, Value::String(value));
                }
            }
        }
    }
    Value::Object(map)
}

fn parse_maybe_json(text: &str) -> Value {
    if text.is_empty() {
        return Value::Null;
    }
    serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

fn timing_value(entry: &Value, key: &str) -> Option<f64> {
    entry
        .get("timings")
        .and_then(|t| t.get(key))
        .and_then(|v| v.as_f64())
        .filter(|v| *v >= 0.0)
}

pub fn parse_har(json_str: &str) -> Result<HarImport, String> {
    if json_str.len() > MAX_HAR_BYTES {
        return Err(format!("HAR file too large ({} bytes; limit {} bytes)", json_str.len(), MAX_HAR_BYTES));
    }
    let root: Value = serde_json::from_str(json_str).map_err(|e| format!("Invalid HAR JSON: {}", e))?;
    let entries = root
        .get("log")
        .and_then(|l| l.get("entries"))
        .and_then(|e| e.as_array())
        .ok_or_else(|| "Not a HAR 1.2 document: log.entries is missing".to_string())?;

    let mut records = Vec::new();
    let mut skipped = 0usize;
    for (idx, entry) in entries.iter().enumerate() {
        match map_entry(entry, idx) {
            Some(rec) => records.push(rec),
            None => skipped += 1,
        }
    }
    Ok(HarImport { records, skipped })
}

fn map_entry(entry: &Value, idx: usize) -> Option<FullTrafficRecord> {
    let request = entry.get("request")?;
    let response = entry.get("response")?;
    let url = request.get("url").and_then(|v| v.as_str())?;
    if url.is_empty() {
        return None;
    }
    let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string();
    let status = response.get("status").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let status_text = response.get("statusText").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let http_version = response
        .get("httpVersion")
        .or_else(|| request.get("httpVersion"))
        .and_then(|v| v.as_str())
        .unwrap_or("HTTP/1.1")
        .to_string();
    let mime = response
        .get("content")
        .and_then(|c| c.get("mimeType"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut resource_type = extension_category(url, &mime);
    if resource_type == "Other" {
        
        if let Some(explicit) = entry
            .get("_resourceType")
            .or_else(|| entry.get("_type"))
            .and_then(|v| v.as_str())
        {
            resource_type = normalize_resource_type(explicit);
        }
    }
    if mime.to_lowercase().contains("websocket") {
        resource_type = "Socket";
    }

    let query_params = request
        .get("queryString")
        .and_then(|q| q.as_array())
        .map(|items| {
            items
                .iter()
                .map(|p| QueryParam {
                            key: p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    value: p.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let post_text = request
        .get("postData")
        .and_then(|p| p.get("text"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let request_payload = post_text.as_deref().map(parse_maybe_json);

    let content = response.get("content");
    let body_text = content.and_then(|c| c.get("text")).and_then(|v| v.as_str());
    let is_base64 = content
        .and_then(|c| c.get("encoding"))
        .and_then(|v| v.as_str())
        .map(|e| e.eq_ignore_ascii_case("base64"))
        .unwrap_or(false);
    let size_bytes = content
        .and_then(|c| c.get("size"))
        .and_then(|v| v.as_u64())
        .or_else(|| response.get("bodySize").and_then(|v| v.as_i64()).filter(|v| *v >= 0).map(|v| v as u64))
        .unwrap_or_else(|| body_text.map(|b| b.len() as u64).unwrap_or(0));

    let body = if is_base64 {
        None
    } else {
        body_text.map(parse_maybe_json)
    };
    let preview = body
        .clone()
        .unwrap_or_else(|| json!(format!("[Binary Data / Base64 ({} bytes)]", size_bytes)));
    if size_bytes == 0 && body_text.unwrap_or("").is_empty() {
        
    }

    let initiator = entry
        .get("_initiator")
        .or_else(|| entry.get("initiator"))
        .and_then(|i| {
            let t = i.get("type").and_then(|v| v.as_str())?;
            Some(InitiatorInfo {
                initiator_type: t.to_string(),
                url: i.get("url").and_then(|v| v.as_str()).map(String::from),
                line_number: i.get("lineNumber").and_then(|v| v.as_i64()),
                column_number: i.get("columnNumber").and_then(|v| v.as_i64()),
                stack: i.get("stack").cloned(),
            })
        });

    let duration_ms = entry.get("time").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let breakdown = if entry.get("timings").is_some() {
        Some(TimingBreakdown {
            dns: timing_value(entry, "dns"),
            connect: timing_value(entry, "connect"),
            ssl: timing_value(entry, "ssl"),
            send: timing_value(entry, "send"),
            ttfb: timing_value(entry, "wait"),
            download: timing_value(entry, "receive"),
            total: duration_ms,
        })
    } else {
        None
    };

    let timestamp = entry
        .get("startedDateTime")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

    let remote = response
        .get("_remoteAddress")
        .and_then(|v| v.as_str())
        .map(String::from);

    let request_headers = headers_to_value(request.get("headers").and_then(|h| h.as_array()));
    let response_headers = headers_to_value(response.get("headers").and_then(|h| h.as_array()));

    Some(FullTrafficRecord {
        id: entry
            .get("_id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("har-{}-{}", idx, sanitize_filename(&url))),
        timestamp,
        session_id: None,
        tab_id: None,
        tab_url: entry.get("_tabUrl").and_then(|v| v.as_str()).map(String::from),
        resource_type: resource_type.to_string(),
        url: url.to_string(),
        method,
        status,
        status_text: status_text.clone(),
        headers: FullHeaders {
            general: GeneralHeaders {
                request_url: url.to_string(),
                request_method: request.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string(),
                status_code: format!("{} {}", status, status_text),
                remote_address: remote,
                protocol: Some(http_version),
                mime_type: if mime.is_empty() { None } else { Some(mime.clone()) },
            },
            request: request_headers,
            response: response_headers,
            query_params,
            request_payload,
        },
        preview,
        response: ResponseBodyInfo {
            mime_type: if mime.is_empty() { "unknown".to_string() } else { mime },
            size_bytes,
            base64_encoded: is_base64,
            body_state: Some(crate::traffic_processor::compute_body_state(&body, is_base64, size_bytes).to_string()),
            body,
        },
        initiator,
        timing: TimingInfo { duration_ms, breakdown },
        saved_file: None,
    })
}


pub fn stats_for(records: &[FullTrafficRecord]) -> SessionStats {
    let mut stats = SessionStats {
        started_at: Some(chrono::Utc::now().to_rfc3339()),
        ..SessionStats::default()
    };
    for rec in records {
        stats.total_requests += 1;
        stats.total_bytes += rec.response.size_bytes;
        *stats.by_type.entry(rec.resource_type.clone()).or_insert(0) += 1;
        let group = if (200..300).contains(&rec.status) {
            "2xx"
        } else if (300..400).contains(&rec.status) {
            "3xx"
        } else if (400..500).contains(&rec.status) {
            "4xx"
        } else if (500..600).contains(&rec.status) {
            "5xx"
        } else {
            "other"
        };
        *stats.by_status.entry(group.to_string()).or_insert(0) += 1;
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "log": {
        "version": "1.2",
        "creator": {"name": "test", "version": "1"},
        "entries": [
          {
            "startedDateTime": "2026-10-03T12:00:00.000Z",
            "time": 42.5,
            "request": {
              "method": "POST",
              "url": "https://api.example.test/v1/items?page=2",
              "httpVersion": "HTTP/2",
              "headers": [{"name": "Accept", "value": "application/json"}, {"name": "Cookie", "value": "sid=1"}],
              "queryString": [{"name": "page", "value": "2"}],
              "postData": {"mimeType": "application/json", "text": "{\"name\":\"x\"}"}
            },
            "response": {
              "status": 201,
              "statusText": "Created",
              "httpVersion": "HTTP/2",
              "headers": [
                {"name": "content-type", "value": "application/json"},
                {"name": "set-cookie", "value": "a=1"},
                {"name": "set-cookie", "value": "b=2"}
              ],
              "content": {"size": 3, "mimeType": "application/json", "text": "{\"ok\":true}"},
              "bodySize": 11,
              "_remoteAddress": "10.0.0.1:443"
            },
            "timings": {"dns": 1.1, "connect": 2.2, "ssl": 3.3, "send": 0.4, "wait": 30.0, "receive": 5.0, "blocked": -1},
            "_resourceType": "XHR",
            "_initiator": {"type": "script", "url": "https://example.test/app.js", "lineNumber": 10}
          },
          {
            "startedDateTime": "2026-10-03T12:00:01.000Z",
            "time": 8,
            "request": {"method": "GET", "url": "https://example.test/static/logo.woff2", "headers": []},
            "response": {"status": 200, "statusText": "OK", "headers": [], "content": {"size": 100, "mimeType": "font/woff2", "encoding": "base64", "text": "AAAA"}},
            "timings": {"send": 0, "wait": 5, "receive": 3}
          },
          {"startedDateTime": "2026-10-03T12:00:02.000Z", "request": {}, "response": {}}
        ]
      }
    }"#;

    #[test]
    fn parses_har_into_records_and_stats() {
        let import = parse_har(SAMPLE).expect("valid HAR");
        assert_eq!(import.records.len(), 2, "entry without request.url is skipped");
        assert_eq!(import.skipped, 1);

        let api = &import.records[0];
        assert_eq!(api.method, "POST");
        assert_eq!(api.status, 201);
        assert_eq!(api.resource_type, "Other", "explicit XHR maps to Other");
        assert_eq!(api.headers.general.protocol.as_deref(), Some("HTTP/2"));
        assert_eq!(api.headers.general.remote_address.as_deref(), Some("10.0.0.1:443"));
        assert_eq!(api.headers.query_params.len(), 1);
        assert_eq!(api.headers.request_payload.as_ref().unwrap()["name"], "x");
        assert_eq!(api.response.body.as_ref().unwrap()["ok"], true);
        
        assert!(api.headers.response["set-cookie"].is_array());
        assert_eq!(api.timing.breakdown.as_ref().unwrap().ttfb, Some(30.0));
        assert_eq!(api.initiator.as_ref().unwrap().initiator_type, "script");

        let font = &import.records[1];
        assert_eq!(font.resource_type, "Font");
        assert!(font.response.base64_encoded);
        assert!(font.response.body.is_none(), "base64 content is not decoded into the record");

        let stats = stats_for(&import.records);
        assert_eq!(stats.total_requests, 2);
        assert_eq!(stats.by_status.get("2xx"), Some(&2));
        assert_eq!(stats.by_type.get("Font"), Some(&1));
    }

    #[test]
    fn rejects_non_har_documents() {
        assert!(parse_har("{\"foo\":1}").is_err());
        assert!(parse_har("not json").is_err());
    }

    #[test]
    fn imported_records_round_trip_through_real_storage() {
        use crate::storage::{ensure_directory_structure, load_saved_requests_from_dir, save_detailed_record, StorageManager};
        let dir = std::path::PathBuf::from("target/har_import_temp_session");
        let _ = std::fs::remove_dir_all(&dir);
        ensure_directory_structure(&dir);

        let import = parse_har(SAMPLE).unwrap();
        let storage = StorageManager::new();
        let stats = stats_for(&import.records);
        for rec in &import.records {
            let fname = format!("{}_{}.json", std::process::id(), crate::storage::sanitize_filename(&rec.id));
            let mut stored = rec.clone();
            stored.saved_file = save_detailed_record(&dir, &rec.resource_type, &fname, &stored);
            storage.append_request(&dir, &stored);
        }
        storage.write_summary(&dir, &stats);
        
        std::thread::sleep(std::time::Duration::from_millis(300));

        let back = load_saved_requests_from_dir(&dir, 10);
        assert_eq!(back.len(), 2, "both imported records must be readable from the session");
        assert!(back.iter().any(|r| r.url.contains("/v1/items?page=2") && r.status == 201));
        assert!(back.iter().all(|r| r.saved_file.is_some()), "per-category detail files must exist");
        for r in &back {
            assert!(std::path::Path::new(r.saved_file.as_ref().unwrap()).exists());
        }
        let summary = crate::storage::load_summary_from_dir(&dir).expect("summary written");
        assert_eq!(summary.total_requests, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
