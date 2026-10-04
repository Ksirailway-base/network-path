use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureState {
    pub epoch: String,
    pub enabled: bool,
    pub selected_tab_id: Option<i64>,
    pub revision: u64,
    
    pub intercept_enabled: bool,
    
    
    pub session_id: String,
}

pub fn new_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    format!("cap-{}-{}-{}", pid, nanos, nanos.wrapping_mul(2654435761) % 1_000_000_007)
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            enabled: false, selected_tab_id: None, revision: 0, intercept_enabled: false,
            session_id: new_session_id(),
            epoch: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().to_string(),
        }
    }
}

impl CaptureState {
    pub fn update(&mut self, enabled: bool, tab_id: Option<i64>) -> Result<Self, String> {
        if tab_id.map(|id| id <= 0).unwrap_or(false) || (enabled && tab_id.is_none()) {
            return Err("Select a valid Chrome tab before starting capture".into());
        }
        self.enabled = enabled;
        self.selected_tab_id = tab_id;
        self.revision += 1;
        Ok(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_ids_are_unique() {
        let a = new_session_id();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_session_id();
        assert_ne!(a, b);
        assert!(a.starts_with("cap-"));
    }
    #[test]
    fn invalid_start_does_not_change_state() {
        let mut state = CaptureState::default();
        assert!(state.update(true, None).is_err());
        assert_eq!(state.revision, 0);
        assert!(!state.enabled);
    }
    #[test]
    fn stop_preserves_explicit_target_and_advances_revision() {
        let mut state = CaptureState::default();
        state.update(true, Some(17)).unwrap();
        let stopped = state.update(false, Some(17)).unwrap();
        assert!(!stopped.enabled);
        assert_eq!(stopped.selected_tab_id, Some(17));
        assert_eq!(stopped.revision, 2);
    }
}
