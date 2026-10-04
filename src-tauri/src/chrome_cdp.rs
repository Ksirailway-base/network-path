use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;
use serde_json::Value;

use crate::models::TabSummary;

pub const CHROME_DEBUG_PORT: u16 = 9222;

pub struct BrowserCandidate {
    pub name: &'static str,
    pub path: PathBuf,
}



const CHROMIUM_BROWSER_PATHS: &[(&str, &[&str])] = &[
    ("Google Chrome", &[
        "Google\\Chrome\\Application\\chrome.exe",
    ]),
    ("Microsoft Edge", &[
        "Microsoft\\Edge\\Application\\msedge.exe",
    ]),
    ("Brave", &[
        "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ]),
    ("Vivaldi", &[
        "Vivaldi\\Application\\vivaldi.exe",
    ]),
    ("Opera", &[
        "Opera\\Application\\opera.exe",
        "Programs\\Opera\\opera.exe",
        "Opera\\launcher.exe",
    ]),
    ("Yandex Browser", &[
        "Yandex\\YandexBrowser\\Application\\browser.exe",
    ]),
];


pub fn find_chromium_browsers() -> Vec<BrowserCandidate> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(var) {
            roots.push(PathBuf::from(v));
        }
    }
    roots.push(PathBuf::from("C:\\Program Files"));
    roots.push(PathBuf::from("C:\\Program Files (x86)"));

    let mut found: Vec<BrowserCandidate> = Vec::new();
    for (name, relative_paths) in CHROMIUM_BROWSER_PATHS {
        'browser: for rel in *relative_paths {
            for root in &roots {
                let candidate = root.join(rel);
                if candidate.exists() {
                    found.push(BrowserCandidate { name, path: candidate });
                    break 'browser;
                }
            }
        }
    }
    found
}

pub fn find_chrome_executable() -> Option<PathBuf> {
    find_chromium_browsers().into_iter().next().map(|b| b.path)
}

pub fn primary_browser_name() -> &'static str {
    find_chromium_browsers().first().map(|b| b.name).unwrap_or("Chromium browser")
}

pub fn get_chrome_profile_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("TEMP"))
        .unwrap_or_else(|_| "C:\\Temp".to_string());
    let dir = PathBuf::from(base).join("Google\\Chrome\\NetworkPathProfile");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn find_extension_dir() -> Option<PathBuf> {
    
    if let Ok(cur) = std::env::current_dir() {
        let p = cur.join("extension");
        if p.join("manifest.json").exists() {
            return Some(p);
        }
    }
    
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        for _ in 0..4 {
            if let Some(parent) = cur {
                for candidate in [parent.join("extension"), parent.join("_up_").join("extension")] {
                    if candidate.join("manifest.json").exists() {
                        return Some(candidate);
                    }
                }
                cur = parent.parent();
            } else {
                break;
            }
        }
    }
    None
}

pub fn launch_chrome(target_url: &str) -> Result<bool, String> {
    let browser = find_chromium_browsers()
        .into_iter()
        .next()
        .ok_or_else(|| "No Chromium-based browser found. Install Chrome, Edge, Brave, Vivaldi or Opera (Firefox/Safari are not supported: the capture extension needs the chrome.debugger API).".to_string())?;
    let chrome_exe = browser.path;
    log::info!("Launching {} ({})", browser.name, chrome_exe.display());

    let profile_dir = get_chrome_profile_dir();
    let port_arg = format!("--remote-debugging-port={}", CHROME_DEBUG_PORT);
    let profile_arg = format!("--user-data-dir={}", profile_dir.to_string_lossy());

    let mut cmd = Command::new(chrome_exe);
    cmd.arg(&port_arg)
        .arg(&profile_arg)
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check");

    
    if let Some(ext_path) = find_extension_dir() {
        let ext_str = ext_path.to_string_lossy().to_string();
        cmd.arg(format!("--load-extension={}", ext_str));
        cmd.arg(format!("--disable-extensions-except={}", ext_str));
    }

    let trimmed = target_url.trim();
    if !trimmed.is_empty() {
        cmd.arg(trimmed);
    }

    cmd.spawn().map_err(|e| format!("Failed to spawn Chrome process: {}", e))?;

    
    thread::sleep(Duration::from_millis(500));
    Ok(true)
}

pub fn is_debug_port_open() -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from(([127, 0, 0, 1], CHROME_DEBUG_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(35)).is_ok()
}

pub fn check_chrome_endpoint() -> Option<Value> {
    if !is_debug_port_open() {
        return None;
    }
    let url = format!("http://127.0.0.1:{}/json/version", CHROME_DEBUG_PORT);
    let res = ureq::get(&url)
        .timeout(Duration::from_millis(800))
        .call()
        .ok()?;

    res.into_json::<Value>().ok()
}

pub fn fetch_open_tabs() -> Vec<TabSummary> {    if !is_debug_port_open() {
        return Vec::new();
    }
    let url = format!("http://127.0.0.1:{}/json/list", CHROME_DEBUG_PORT);
    let res = match ureq::get(&url).timeout(Duration::from_millis(800)).call() {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let list: Vec<Value> = match res.into_json() {
        Ok(l) => l,
        Err(_) => return Vec::new(),
    };

    let mut result = Vec::new();
    for (idx, item) in list.iter().enumerate() {
        if item.get("type").and_then(|v| v.as_str()) == Some("page") {
            let id = idx as i64 + 1;
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
            let url_str = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            result.push(TabSummary {
                id,
                title,
                url: url_str,
                active: idx == 0,
                
                
                
                is_attached: false,
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{find_chromium_browsers, CHROMIUM_BROWSER_PATHS};

    #[test]
    fn candidate_table_is_chromium_only_and_ordered() {
        
        assert!(!CHROMIUM_BROWSER_PATHS.iter().any(|(n, _)| n.contains("Firefox") || n.contains("Safari")));
        
        assert_eq!(CHROMIUM_BROWSER_PATHS[0].0, "Google Chrome");
        assert_eq!(CHROMIUM_BROWSER_PATHS[1].0, "Microsoft Edge");
        for (name, paths) in CHROMIUM_BROWSER_PATHS {
            assert!(!paths.is_empty(), "{} must list at least one relative path", name);
            for p in *paths {
                assert!(p.ends_with(".exe"), "windows executable expected: {}", p);
            }
        }
    }

    #[test]
    fn detection_never_panics_and_names_are_known() {
        let browsers = find_chromium_browsers();
        let known = ["Google Chrome", "Microsoft Edge", "Brave", "Vivaldi", "Opera", "Yandex Browser"];
        for b in &browsers {
            assert!(known.contains(&b.name), "unexpected browser name {}", b.name);
        }
    }
}
