//! Additive, fixed-cardinality attribution for `--storage-files-stdin` only.
//!
//! The phases measure stale-manifest removal, bounded stdin read, envelope
//! framing, manifest JSON parsing, decoded-file construction **and validation**,
//! and mount-binding validation. `decode_validate` does not isolate copying from
//! validation. Every attempted decoded input emits one zero-duration
//! `input_payload_bytes_*` classification: the actual binary payload length
//! after a valid frame, or `unavailable_or_inconsistent` if cleanup, read or
//! framing failed. No input content, path, URL, user ID or error is emitted.
//!
//! Older Guest versions have no rows; missing rows are not zero durations or
//! zero-byte payloads. Telemetry is best-effort and durations are whole
//! milliseconds. These phases do not cover the post-plan tail or every part of
//! `download_total`, and separately aggregated phase percentiles cannot be
//! added to estimate a critical-path saving. Action names and buckets are an
//! additive compatibility contract guarded by unit and binary logging tests.

use guest_telemetry::telemetry::record_sandbox_op;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub enum InputPhase {
    StaleCleanup,
    Read,
    Frame,
    Parse,
    DecodeValidate,
    Bindings,
}

impl InputPhase {
    fn action(self) -> &'static str {
        match self {
            Self::StaleCleanup => "guest_storage_apply_input_stale_cleanup",
            Self::Read => "guest_storage_apply_input_read",
            Self::Frame => "guest_storage_apply_input_frame",
            Self::Parse => "guest_storage_apply_input_parse",
            Self::DecodeValidate => "guest_storage_apply_input_decode_validate",
            Self::Bindings => "guest_storage_apply_input_bindings",
        }
    }
}

/// Record a phase result without propagating log failures or input details.
pub fn record_phase(phase: InputPhase, started: Instant, success: bool) {
    record_sandbox_op(phase.action(), started.elapsed(), success, None);
}

/// Time a fallible pre-write operation without changing its return value.
pub fn measure_phase<T, E>(
    phase: InputPhase,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let started = Instant::now();
    let result = operation();
    record_phase(phase, started, result.is_ok());
    result
}

/// Record exactly one payload-size class per decoded-input attempt. `None`
/// means that no trustworthy payload slice was available, not zero bytes.
/// This zero-duration row's `success: true` means the classification was
/// recorded, even when an earlier input phase failed; use `download_total`
/// and the individual phase flags to determine application success.
pub fn record_payload_size(bytes: Option<usize>) {
    record_sandbox_op(payload_size_action(bytes), Duration::ZERO, true, None);
}

fn payload_size_action(bytes: Option<usize>) -> &'static str {
    match bytes {
        None => "guest_storage_apply_input_payload_bytes_unavailable_or_inconsistent",
        Some(0) => "guest_storage_apply_input_payload_bytes_zero",
        Some(1..65_536) => "guest_storage_apply_input_payload_bytes_lt_64_kib",
        Some(65_536..262_144) => "guest_storage_apply_input_payload_bytes_64_kib_to_256_kib",
        Some(262_144..1_048_576) => "guest_storage_apply_input_payload_bytes_256_kib_to_1_mib",
        Some(1_048_576..4_194_304) => "guest_storage_apply_input_payload_bytes_1_mib_to_4_mib",
        Some(4_194_304..16_777_216) => "guest_storage_apply_input_payload_bytes_4_mib_to_16_mib",
        Some(16_777_216..67_108_864) => "guest_storage_apply_input_payload_bytes_16_mib_to_64_mib",
        Some(_) => "guest_storage_apply_input_payload_bytes_64_mib_plus",
    }
}

#[cfg(test)]
mod tests;
