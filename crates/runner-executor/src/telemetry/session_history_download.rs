//! Content-free, optional measurements for bounded session-history attempts.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionHistoryObservationStage {
    Restore,
    CancelDrain,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionHistoryHttpVersion {
    Http09,
    Http10,
    Http11,
    Http2,
    Http3,
    Other,
}

impl From<reqwest::Version> for SessionHistoryHttpVersion {
    fn from(version: reqwest::Version) -> Self {
        match version {
            reqwest::Version::HTTP_09 => Self::Http09,
            reqwest::Version::HTTP_10 => Self::Http10,
            reqwest::Version::HTTP_11 => Self::Http11,
            reqwest::Version::HTTP_2 => Self::Http2,
            reqwest::Version::HTTP_3 => Self::Http3,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionHistoryPollCounterState {
    Exact,
    Saturated,
}

/// Offsets share one materializer-local monotonic origin. The UTC calibration
/// permits cross-operation joins; it does not turn summed legacy phase walls
/// into contiguous intervals or chunk await wall into pure network time.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub(crate) struct SessionHistoryDownloadFields {
    pub session_history_timing_origin_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_observation_stage: Option<SessionHistoryObservationStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_download_attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_attempt_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_failed_attempt_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_interrupted_attempt_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_retry_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_retry_backoff_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_request_start_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_request_end_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_start_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_end_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_chunk_wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_chunk_wait_max_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_chunk_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_copy_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_allocation_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_http_version: Option<SessionHistoryHttpVersion>,
    /// Bytes yielded by the body Future, including chunks rejected before copy.
    /// This is not a physical wire-byte observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_poll_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_pending_poll_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_incomplete_poll_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_poll_wall_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_wake_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_wake_to_poll_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_wake_to_poll_wall_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_wake_to_poll_max_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_poll_without_wake_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_unconsumed_wake_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_body_poll_counter_state: Option<SessionHistoryPollCounterState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_cpu_admission_start_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_cpu_admission_end_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_cpu_queue_start_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_cpu_queue_end_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_restore_wait_start_offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_history_restore_wait_end_offset_ms: Option<u64>,
}

pub(crate) struct SessionHistoryDownloadRecord {
    pub action_type: &'static str,
    pub duration: Duration,
    pub success: bool,
    pub outcome: &'static str,
    pub completed_at: DateTime<Utc>,
    pub fields: SessionHistoryDownloadFields,
}
