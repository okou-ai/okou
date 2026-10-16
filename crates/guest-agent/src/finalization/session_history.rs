//! Bounded local history evidence published only after completion acknowledgement.

use super::LOG_TAG;
use crate::error::AgentError;
use crate::session_history as history;
use crate::session_history_identity::SessionHistoryIdentityBuildError;
use crate::session_metadata::CapturedSessionMetadata;
use guest_contracts::session_history_identity::{
    SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use guest_telemetry::telemetry::record_sandbox_op;
use guest_telemetry::{log_info, log_warn};
use std::time::Duration;

pub(super) struct RetainedSessionHistory {
    pub(super) cli_agent_session_id: String,
    pub(super) history_source: SessionHistorySourceRef,
    pub(super) history_hash: String,
    pub(super) history_size: u64,
}

pub(super) async fn prepare_retained_session_history(
    metadata: &CapturedSessionMetadata,
) -> Result<Option<RetainedSessionHistory>, AgentError> {
    let session_id = metadata.cli_agent_session_id().to_string();
    let source = metadata.history_source().cloned();
    tokio::task::spawn_blocking(move || {
        source.and_then(|source| {
            let file = history::resolve_session_history_from_source(&source).ok()?;
            let digest = file.digest_retained_home(64 * 1024 * 1024).ok()?;
            Some(RetainedSessionHistory {
                cli_agent_session_id: session_id,
                history_source: source,
                history_hash: digest.sha256_hex,
                history_size: digest.size_bytes,
            })
        })
    })
    .await
    .map_err(|error| AgentError::Execution(format!("native history blocking task failed: {error}")))
}

pub(super) fn write_final_session_history_identity(
    identity: Result<SessionHistoryIdentity, SessionHistoryIdentityBuildError>,
    final_session_history_identity_file: &str,
) {
    let mut identity = match identity {
        Ok(identity) => identity,
        Err(error) => {
            match error {
                SessionHistoryIdentityBuildError::InvalidSessionId => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_session_id",
                    Duration::ZERO,
                    true,
                    None,
                ),
                SessionHistoryIdentityBuildError::InvalidMetadata(_) => record_sandbox_op(
                    "session_history_identity_write_skipped_invalid_metadata",
                    Duration::ZERO,
                    true,
                    None,
                ),
            }
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    identity.history_ref_kind = SessionHistoryRefKind::LocalHome;
    let bytes = match identity.to_json_vec() {
        Ok(bytes) => bytes,
        Err(error) => {
            record_sandbox_op(
                "session_history_identity_write_skipped_invalid_metadata",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity skipped: {error}");
            return;
        }
    };
    match crate::paths::write_private(final_session_history_identity_file, bytes) {
        Ok(()) => {
            record_sandbox_op(
                "session_history_identity_written",
                Duration::ZERO,
                true,
                None,
            );
            log_info!(LOG_TAG, "Final session history identity written");
        }
        Err(_) => {
            record_sandbox_op(
                "session_history_identity_write_failed",
                Duration::ZERO,
                false,
                None,
            );
            log_warn!(LOG_TAG, "Failed to write final session history identity");
        }
    }
}
