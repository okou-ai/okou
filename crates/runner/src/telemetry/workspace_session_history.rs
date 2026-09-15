use guest_contracts::env::CliFramework;
use guest_contracts::session_history_identity::SessionHistorySidecarRepresentation;
use serde::Serialize;

/// Validated local history sizes and the materializer's actual representation.
/// Byte counts measure history payloads, excluding guest-control framing.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct WorkspaceSessionHistoryTelemetry {
    session_history_framework: &'static str,
    session_history_raw_bytes: u64,
    session_history_source_bytes: u64,
    session_history_source_representation: &'static str,
    session_history_restore_representation: &'static str,
    session_history_restore_reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_history_guest_bytes: Option<u64>,
}

impl WorkspaceSessionHistoryTelemetry {
    pub(crate) fn new(
        framework: CliFramework,
        raw_bytes: u64,
        source_bytes: u64,
        source: SessionHistorySidecarRepresentation,
        restored_zstd: bool,
        guest_bytes: u64,
    ) -> Self {
        let (source_representation, reason) = match source {
            SessionHistorySidecarRepresentation::Raw => ("raw", "raw_source"),
            SessionHistorySidecarRepresentation::CodexZstd if restored_zstd => {
                ("codex_zstd", "retained_zstd")
            }
            SessionHistorySidecarRepresentation::CodexZstd => ("codex_zstd", "codex_pruning_guard"),
        };
        Self {
            session_history_framework: framework.as_cli_agent_type(),
            session_history_raw_bytes: raw_bytes,
            session_history_source_bytes: source_bytes,
            session_history_source_representation: source_representation,
            session_history_restore_representation: if restored_zstd {
                "codex_zstd"
            } else {
                "raw"
            },
            session_history_restore_reason: reason,
            session_history_guest_bytes: Some(guest_bytes),
        }
    }

    pub(super) fn with_restore_outcome(mut self, success: bool) -> Self {
        // A failed write may have transferred only part of the payload. The
        // restore API does not expose that count, so do not claim completion.
        if !success {
            self.session_history_guest_bytes = None;
        }
        self
    }
}
