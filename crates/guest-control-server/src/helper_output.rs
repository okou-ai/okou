//! Captured-output and diagnostic projection for guest process results.

use std::time::Instant;

use guest_control_proto::{ExecCapturedOutput, ExecTermination};

use crate::drain::BoundedDrainResult;

const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

/// Owned terminal output for fixed helpers that capture both output streams.
pub(crate) struct CapturedHelperOutput {
    pub(crate) termination: ExecTermination,
    pub(crate) duration_ms: u32,
    pub(crate) stdout: BoundedDrainResult,
    pub(crate) stderr: BoundedDrainResult,
    pub(crate) diagnostic: String,
}

impl CapturedHelperOutput {
    pub(crate) fn new(
        termination: ExecTermination,
        started: Instant,
        stdout: BoundedDrainResult,
        stderr: BoundedDrainResult,
        diagnostic: String,
    ) -> Self {
        Self {
            termination,
            duration_ms: elapsed_ms(started),
            stdout,
            stderr,
            diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
        }
    }

    pub(crate) fn failed(
        termination: ExecTermination,
        started: Instant,
        diagnostic: String,
    ) -> Self {
        Self::new(
            termination,
            started,
            empty_capture(),
            empty_capture(),
            diagnostic,
        )
    }
}

fn empty_capture() -> BoundedDrainResult {
    BoundedDrainResult {
        captured: Some(Vec::new()),
        capture_truncated: false,
        stream_truncated: false,
    }
}

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

/// Bound an owned diagnostic to its caller's byte budget without a suffix.
pub(crate) fn truncate_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let end = value.floor_char_boundary(limit);
    value.truncate(end);
    value
}

/// Project fixed-helper output, treating a missing capture as empty bytes.
///
/// Present bytes are borrowed, and the original capture-truncation flag is
/// retained independently of stream truncation or capture presence.
pub(crate) fn captured_or_empty(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    ExecCapturedOutput::Captured {
        bytes: result.captured.as_deref().unwrap_or_default(),
        truncated: result.capture_truncated,
    }
}

/// Project exec output, retaining discarded output when capture is absent.
///
/// A present empty capture remains captured, with its original truncation flag.
pub(crate) fn captured_or_discarded(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    match result.captured.as_deref() {
        Some(bytes) => ExecCapturedOutput::Captured {
            bytes,
            truncated: result.capture_truncated,
        },
        None => ExecCapturedOutput::Discarded,
    }
}
