//! Fixed, content-free observations for one storage apply call.

use std::time::Duration;

/// Caller-owned observations, separate from the operation's result or authority.
///
/// A missing phase was not observed, rather than taking zero time. Completed
/// attempts can be retained when the call returns an error. Dropping an ongoing
/// future does not manufacture a completed phase or terminal result.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestTiming {
    /// Policy checks and guest-client acquisition before the accepted call.
    pub admission: Option<Duration>,
    /// The fixed request/response phases on the existing connection.
    pub request: StorageManifestRequestTiming,
    /// Existing resource evidence serialization/logging after result decoding.
    pub resource_log: Option<Duration>,
}

/// Host wall durations and optional terminal evidence from one storage request.
///
/// These include Host scheduling. Response wait includes Guest execution and
/// response work plus Host reader framing, copying, dispatch and wake-up; it
/// can overlap Guest execution that began while the request was still writing.
/// It is not pure transport and must not alone be reduced by the Guest duration.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestRequestTiming {
    /// Normal-operation reservation and pending-response registration.
    pub setup: Option<Duration>,
    /// Wait for the shared frame-builder gate before encoding.
    pub frame_builder_wait: Option<Duration>,
    /// Existing bounded request validation and frame construction.
    pub frame_encode: Option<Duration>,
    /// Canonical writer-lock wait, excluding write admission.
    pub writer_wait: Option<Duration>,
    /// Canonical frame write, excluding unlock/observation and write admission.
    pub frame_write: Option<Duration>,
    /// Complete request write through the original terminal-result wait.
    pub response_wait: Option<Duration>,
    /// Core result/resource validation and owned output construction.
    pub result_decode: Option<Duration>,
    /// Completed Guest phases from bounded terminal metadata, independently
    /// available from the Host phases and original Guest-server duration.
    pub guest: StorageManifestGuestTiming,
    /// Fixed scalars from request-bound resource evidence; never raw peer JSON.
    pub resources: StorageManifestResources,
}

/// Optional Guest wall observations in microseconds.
/// These can overlap Host writing/response wait; they do not form a serial
/// partition of the call or identify pure transport latency.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestGuestTiming {
    /// Submit entry through ownership construction, before enqueue.
    pub request_ownership_us: Option<u64>,
    /// Enqueue-ready ownership through worker handler entry.
    pub worker_wait_us: Option<u64>,
    /// Output/resource preparation through the timing serialization point.
    /// Final metadata/frame encoding and future response writes are excluded.
    pub response_prepare_us: Option<u64>,
}

/// Minimal optional resource scalars from one validated terminal snapshot.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StorageManifestResources {
    /// Containment activation through snapshot start, in microseconds.
    pub containment_wall_us: Option<u64>,
    /// Snapshot collection wall time, in microseconds.
    pub collection_us: Option<u64>,
    /// Workload CPU usage, in microseconds.
    pub cpu_usage_us: Option<u64>,
    /// Workload CPU throttled time, in microseconds.
    pub cpu_throttled_us: Option<u64>,
    /// Workload peak charged bytes.
    pub memory_peak_bytes: Option<u64>,
    /// Workload OOM events.
    pub memory_events_oom: Option<u64>,
    /// Workload OOM-kill events.
    pub memory_events_oom_kill: Option<u64>,
    /// Workload group OOM-kill events.
    pub memory_events_oom_group_kill: Option<u64>,
    /// Workload pids-limit events.
    pub pids_events_max: Option<u64>,
}
