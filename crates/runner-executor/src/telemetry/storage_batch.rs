use std::time::Duration;

use sandbox::StorageManifestTiming;
use serde::Serialize;

/// Fixed batch labels, distinct from content and actual Host observations.
pub(crate) struct StorageBatchDimensions {
    pub transport_position: &'static str,
    pub manifest_size_bucket: &'static str,
    pub payload_size_bucket: &'static str,
}

/// Additive optional fields on the existing capped storage-batch operation.
/// Old API readers can strip these fields; their absence is not a zero sample.
/// Each duration is truncated to milliseconds and omitted if it cannot fit u32.
/// Complete means all nine Host phases were observed, not that they explain the
/// entire outer residual or exclude the Guest work in response wait.
#[derive(Clone, Serialize)]
pub(super) struct HostTimingFields {
    storage_batch_host_timing: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_admission_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_request_setup_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_frame_builder_wait_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_frame_encode_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_writer_wait_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_frame_write_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_response_wait_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_result_decode_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_resource_log_ms: Option<u32>,
}

impl HostTimingFields {
    pub(super) fn new(timing: &StorageManifestTiming) -> Self {
        let phases = [
            timing.admission,
            timing.request.setup,
            timing.request.frame_builder_wait,
            timing.request.frame_encode,
            timing.request.writer_wait,
            timing.request.frame_write,
            timing.request.response_wait,
            timing.request.result_decode,
            timing.resource_log,
        ]
        .map(milliseconds);
        let coverage = match phases.iter().flatten().count() {
            0 => "unavailable",
            9 => "complete",
            _ => "partial",
        };
        let [
            admission,
            setup,
            builder_wait,
            encode,
            writer_wait,
            write,
            response,
            decode,
            resource_log,
        ] = phases;
        Self {
            storage_batch_host_timing: coverage,
            storage_batch_admission_ms: admission,
            storage_batch_request_setup_ms: setup,
            storage_batch_frame_builder_wait_ms: builder_wait,
            storage_batch_frame_encode_ms: encode,
            storage_batch_writer_wait_ms: writer_wait,
            storage_batch_frame_write_ms: write,
            storage_batch_response_wait_ms: response,
            storage_batch_result_decode_ms: decode,
            storage_batch_resource_log_ms: resource_log,
        }
    }
}

fn milliseconds(duration: Option<Duration>) -> Option<u32> {
    duration.and_then(|duration| u32::try_from(duration.as_millis()).ok())
}
