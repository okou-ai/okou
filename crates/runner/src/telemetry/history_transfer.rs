use std::time::Duration;

use sandbox::{FileCompression, FileWriteMeasurements};
use serde::Serialize;

use crate::duration::duration_ms;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HistoryCodecReason {
    NativeZstd,
    BelowThreshold,
    SampleRejected,
    SampleAccepted,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HistoryTransferSource {
    WorkspaceCache,
    Downloaded,
    Inline,
}

/// Successful caller measurements. No field contains history identity or content.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct HistoryTransferMeasurements {
    session_history_wire_codec: &'static str,
    session_history_codec_reason: HistoryCodecReason,
    session_history_selection_ms: u64,
    session_history_transfer_bytes: u64,
    session_history_restore_representation: &'static str,
    #[serde(flatten)]
    wire: Option<HistoryWireMeasurements>,
}

impl HistoryTransferMeasurements {
    pub(crate) fn new(
        codec: FileCompression,
        reason: HistoryCodecReason,
        selection: Duration,
        logical_bytes: usize,
        native_zstd: bool,
        wire: Option<FileWriteMeasurements>,
    ) -> Self {
        Self {
            session_history_wire_codec: match codec {
                FileCompression::None => "none",
                FileCompression::Zstd => "zstd",
            },
            session_history_codec_reason: reason,
            session_history_selection_ms: duration_ms(selection),
            session_history_transfer_bytes: logical_bytes as u64,
            session_history_restore_representation: if native_zstd { "codex_zstd" } else { "raw" },
            wire: wire.map(HistoryWireMeasurements::from),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct HistoryWireMeasurements {
    session_history_wire_bytes: u64,
    session_history_write_requests: u64,
    session_history_file_gate_wait_ms: u64,
    session_history_requests_ms: u64,
    session_history_encoder_pipeline_ms: u64,
    session_history_publication_ms: u64,
}

impl From<FileWriteMeasurements> for HistoryWireMeasurements {
    fn from(value: FileWriteMeasurements) -> Self {
        Self {
            session_history_wire_bytes: value.wire_payload_bytes,
            session_history_write_requests: value.requests,
            session_history_file_gate_wait_ms: duration_ms(value.file_gate_wait),
            session_history_requests_ms: duration_ms(value.requests_elapsed),
            session_history_encoder_pipeline_ms: duration_ms(value.encoder_pipeline_elapsed),
            session_history_publication_ms: duration_ms(value.publication_elapsed),
        }
    }
}

#[derive(Clone, Serialize)]
pub(super) struct HistoryTransferTelemetry {
    pub(super) session_history_transfer_source: HistoryTransferSource,
    pub(super) session_history_framework: &'static str,
    #[serde(flatten)]
    pub(super) measurements: Option<HistoryTransferMeasurements>,
}
