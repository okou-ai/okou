use std::time::Duration;

use sandbox::FileWriteTiming;
use serde::Serialize;

/// Fixed numeric projection on one existing staging attempt, never its content.
/// Counts describe the actual batch, not mounts or manifest size hints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct StorageStageWrite {
    file_count: usize,
    content_bytes: usize,
    /// Stage path-lock setup/acquisition before backend admission.
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_wait_us: Option<u64>,
    /// Coverage of the eleven backend/client phases, independent of stage locks.
    host_timing: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    admission_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_lock_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_gate_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_setup_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_builder_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_encode_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    writer_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame_write_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_wait_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_decode_us: Option<u64>,
}

impl StorageStageWrite {
    /// Counts describe bytes/files in the attempted batch, not confirmed writes.
    /// Keep completed measurements; omit unavailable/unrepresentable phases.
    /// Response wait includes Guest work and Host scheduling, not pure transport.
    pub fn new(
        file_count: usize,
        content_bytes: usize,
        lock_wait: Duration,
        timing: &FileWriteTiming,
    ) -> Self {
        let request = &timing.request;
        let host = &request.host;
        let phases = [
            timing.admission,
            request.validation,
            request.path_lock_wait,
            request.file_gate_wait,
            host.setup,
            host.frame_builder_wait,
            host.frame_encode,
            host.writer_wait,
            host.frame_write,
            host.response_wait,
            host.result_decode,
        ]
        .map(microseconds);
        let host_timing = match phases.iter().flatten().count() {
            0 => "unavailable",
            11 => "complete",
            _ => "partial",
        };
        let [
            admission,
            validation,
            paths,
            gate,
            setup,
            builder,
            encode,
            writer,
            write,
            response,
            decode,
        ] = phases;
        Self {
            file_count,
            content_bytes,
            lock_wait_us: microseconds(Some(lock_wait)),
            host_timing,
            admission_us: admission,
            validation_us: validation,
            path_lock_wait_us: paths,
            file_gate_wait_us: gate,
            request_setup_us: setup,
            frame_builder_wait_us: builder,
            frame_encode_us: encode,
            writer_wait_us: writer,
            frame_write_us: write,
            response_wait_us: response,
            result_decode_us: decode,
        }
    }
}

fn microseconds(duration: Option<Duration>) -> Option<u64> {
    duration
        .and_then(|value| u64::try_from(value.as_micros()).ok())
        .filter(|value| *value <= 9_007_199_254_740_991)
}
