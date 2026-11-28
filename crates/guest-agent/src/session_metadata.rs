//! Guest-owned session metadata captured from CLI events.

use crate::env::Framework;
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_telemetry::{log_info, log_warn};
use std::sync::{Arc, OnceLock};

const LOG_TAG: &str = "sandbox:guest-agent";

fn capture_metadata(framework: Framework, raw_session_id: &str) -> Option<CapturedSessionMetadata> {
    let cli_agent_session_id = match framework {
        Framework::Codex => canonical_codex_thread_id(raw_session_id)?,
        Framework::ClaudeCode | Framework::Pi | Framework::Antigravity => {
            if !is_valid_cli_agent_session_id(raw_session_id) {
                return None;
            }
            raw_session_id.to_string()
        }
    };
    Some(CapturedSessionMetadata {
        cli_agent_session_id,
    })
}

/// First valid CLI session identity observed during execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedSessionMetadata {
    cli_agent_session_id: String,
}

impl CapturedSessionMetadata {
    /// Return the normalized CLI agent session identity.
    pub fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
    }

    /// Build captured metadata for integration tests that exercise finalization entry points.
    #[doc(hidden)]
    pub fn for_test(cli_agent_session_id: impl Into<String>) -> Self {
        Self {
            cli_agent_session_id: cli_agent_session_id.into(),
        }
    }
}

/// Shared first-write-wins metadata store for one guest-agent execution.
#[derive(Clone, Default)]
pub struct SessionMetadataStore(Arc<OnceLock<CapturedSessionMetadata>>);

impl SessionMetadataStore {
    /// Return the captured metadata, if a valid identity event was observed.
    pub fn captured(&self) -> Option<&CapturedSessionMetadata> {
        self.0.get()
    }

    fn capture(&self, metadata: CapturedSessionMetadata) -> bool {
        self.0.set(metadata).is_ok()
    }

    /// Preload metadata for integration tests that call finalization directly.
    #[doc(hidden)]
    pub fn capture_for_test(&self, metadata: CapturedSessionMetadata) -> bool {
        self.capture(metadata)
    }
}

/// Capture first-event-wins metadata and retain it outside workload-writable files.
pub(crate) struct SessionMetadataCapture {
    framework: Framework,
    store: SessionMetadataStore,
    session_id_file: String,
}

impl SessionMetadataCapture {
    pub(crate) fn new(
        framework: Framework,
        store: SessionMetadataStore,
        session_id_file: &str,
    ) -> Self {
        Self {
            framework,
            store,
            session_id_file: session_id_file.to_string(),
        }
    }

    pub(crate) fn capture_session_id(&self, raw_session_id: &str) {
        let Some(metadata) = capture_metadata(self.framework, raw_session_id) else {
            return;
        };
        if !self.store.capture(metadata.clone()) {
            return;
        }

        log_info!(LOG_TAG, "Captured session ID");
        match guest_contracts::runtime_paths::write_private_new(
            &self.session_id_file,
            metadata.cli_agent_session_id(),
        ) {
            Ok(()) => log_info!(LOG_TAG, "Session ID written to {}", self.session_id_file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => log_info!(
                LOG_TAG,
                "Session ID file already exists; keeping its first observed value"
            ),
            Err(error) => log_warn!(
                LOG_TAG,
                "Failed to write non-authoritative session ID to {}: {error}",
                self.session_id_file
            ),
        }
    }
}

#[cfg(test)]
mod tests;
