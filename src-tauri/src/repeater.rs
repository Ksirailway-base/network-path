use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant};

use crate::models::{RepeaterRequest, RepeaterResponse};

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024; 

pub fn execute_repeater_request(req: RepeaterRequest) -> RepeaterResponse {
    let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(20));
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(5)
        .build();

    let method = req.method.to_uppercase();
    let mut http_req = agent.request(&method, &req.url);

    for (k, v) in &req.headers {
        if k.starts_with(':') {
            continue; 
        }
        http_req = http_req.set(k, v);
    }

    let start = Instant::now();
    let result = if let Some(ref body_str) = req.body {
        if method != "GET" && method != "HEAD" {
            http_req.send_string(body_str)
        } else {
            http_req.call()
        }
    } else {
        http_req.call()
    };
    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) => process_ureq_response(resp, duration_ms),
        Err(ureq::Error::Status(_code, resp)) => {
            
            process_ureq_response(resp, duration_ms)
        }
        Err(ureq::Error::Transport(transport_err)) => RepeaterResponse {
            status: 0,
            status_text: "Connection Failed".to_string(),
            duration_ms,
            size_bytes: 0,
            headers: HashMap::new(),
            body: String::new(),
            is_json: false,
            error: Some(transport_err.to_string()),
        },
    }
}

fn process_ureq_response(resp: ureq::Response, duration_ms: u64) -> RepeaterResponse {
    let status = resp.status();
    let status_text = resp.status_text().to_string();

    let mut headers = HashMap::new();
    for name in resp.headers_names() {
        if let Some(val) = resp.header(&name) {
            headers.insert(name, val.to_string());
        }
    }

    let mut reader = resp.into_reader().take(MAX_BODY_BYTES as u64);
    let mut bytes = Vec::new();
    let _ = reader.read_to_end(&mut bytes);
    let size_bytes = bytes.len();

    let body = String::from_utf8_lossy(&bytes).to_string();
    let is_json = serde_json::from_str::<serde_json::Value>(&body).is_ok();

    RepeaterResponse {
        status,
        status_text,
        duration_ms,
        size_bytes,
        headers,
        body,
        is_json,
        error: None,
    }
}
