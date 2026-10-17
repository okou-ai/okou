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
/// An absent field is not a zero sample.
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

/// Fixed numeric projection only; no resource identity or raw JSON is uploaded.
/// Coverage describes this allowlist, independently of the nine Host phases.
#[derive(Clone, Serialize)]
pub(super) struct GuestEvidenceFields {
    storage_batch_guest_timing: &'static str,
    storage_batch_resources: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_guest_request_ownership_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_guest_worker_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_guest_response_prepare_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_containment_wall_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_resource_collection_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_cpu_usage_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_cpu_throttled_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_memory_peak_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_memory_events_oom: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_memory_events_oom_kill: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_memory_events_oom_group_kill: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_batch_pids_events_max: Option<u64>,
}

impl GuestEvidenceFields {
    pub(super) fn new(timing: &StorageManifestTiming) -> Self {
        let guest = &timing.request.guest;
        let phases = [
            guest.request_ownership_us,
            guest.worker_wait_us,
            guest.response_prepare_us,
        ]
        .map(safe_integer);
        let resources = &timing.request.resources;
        let scalars = [
            resources.containment_wall_us,
            resources.collection_us,
            resources.cpu_usage_us,
            resources.cpu_throttled_us,
            resources.memory_peak_bytes,
            resources.memory_events_oom,
            resources.memory_events_oom_kill,
            resources.memory_events_oom_group_kill,
            resources.pids_events_max,
        ]
        .map(safe_integer);
        let [ownership, wait, prepare] = phases;
        let [
            containment,
            collection,
            cpu,
            throttled,
            peak,
            oom,
            kill,
            group_kill,
            pids,
        ] = scalars;
        Self {
            storage_batch_guest_timing: coverage(&phases),
            storage_batch_resources: coverage(&scalars),
            storage_batch_guest_request_ownership_us: ownership,
            storage_batch_guest_worker_wait_us: wait,
            storage_batch_guest_response_prepare_us: prepare,
            storage_batch_containment_wall_us: containment,
            storage_batch_resource_collection_us: collection,
            storage_batch_cpu_usage_us: cpu,
            storage_batch_cpu_throttled_us: throttled,
            storage_batch_memory_peak_bytes: peak,
            storage_batch_memory_events_oom: oom,
            storage_batch_memory_events_oom_kill: kill,
            storage_batch_memory_events_oom_group_kill: group_kill,
            storage_batch_pids_events_max: pids,
        }
    }
}

fn safe_integer(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value <= 9_007_199_254_740_991)
}

fn coverage<const N: usize>(values: &[Option<u64>; N]) -> &'static str {
    match values.iter().flatten().count() {
        0 => "unavailable",
        count if count == N => "complete",
        _ => "partial",
    }
}
