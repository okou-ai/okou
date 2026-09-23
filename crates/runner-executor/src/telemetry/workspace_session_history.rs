use guest_contracts::env::CliFramework;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistorySidecarRepresentation,
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum HistoryRepresentation {
    Raw,
    CodexZstd,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum HistoryRestoreReason {
    RawSource,
    RetainedZstd,
    CodexPruningGuard,
}

/// Validated local history sizes and the materializer's actual representation.
/// Byte counts measure history payloads, excluding guest-control framing.
/// Compact enums keep this metadata small enough for inline materializer state.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct WorkspaceSessionHistoryTelemetry {
    session_history_framework: SessionHistoryFramework,
    session_history_raw_bytes: u64,
    session_history_source_bytes: u64,
    session_history_source_representation: HistoryRepresentation,
    session_history_restore_representation: HistoryRepresentation,
    session_history_restore_reason: HistoryRestoreReason,
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
            SessionHistorySidecarRepresentation::Raw => {
                (HistoryRepresentation::Raw, HistoryRestoreReason::RawSource)
            }
            SessionHistorySidecarRepresentation::CodexZstd if restored_zstd => (
                HistoryRepresentation::CodexZstd,
                HistoryRestoreReason::RetainedZstd,
            ),
            SessionHistorySidecarRepresentation::CodexZstd => (
                HistoryRepresentation::CodexZstd,
                HistoryRestoreReason::CodexPruningGuard,
            ),
        };
        Self {
            session_history_framework: framework.into(),
            session_history_raw_bytes: raw_bytes,
            session_history_source_bytes: source_bytes,
            session_history_source_representation: source_representation,
            session_history_restore_representation: if restored_zstd {
                HistoryRepresentation::CodexZstd
            } else {
                HistoryRepresentation::Raw
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
