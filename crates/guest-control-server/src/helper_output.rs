//! Captured-output and diagnostic projection for guest process results.

use guest_control_proto::ExecCapturedOutput;

use crate::drain::BoundedDrainResult;

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
