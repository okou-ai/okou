use crate::frame::encode_into;
use crate::payloads::exec_operation::encode_exec_result_frame_into_with_type;
use crate::wire::{MSG_HOME_DRIVE_MOUNT, MSG_HOME_DRIVE_MOUNT_RESULT};
use crate::{DecodedExecResult, ExecCapturedOutput, ExecTermination, ProtocolError};

use guest_contracts::home_mount::HOME_DRIVE_LAYOUT;

/// Fixed Home filesystem operation. Paths and commands remain Guest-owned.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HomeDriveOperation {
    /// Mount and validate the fixed Home filesystem.
    Mount,
    /// Normally unmount the fixed filesystem before replacing its backend.
    Unmount,
}

/// Encode a fixed Home operation without caller-selected paths or commands.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the frame exceeds the protocol limit.
pub fn encode_home_drive_operation_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    operation: HomeDriveOperation,
) -> Result<(), ProtocolError> {
    let suffix: &[u8] = match operation {
        HomeDriveOperation::Mount => b"",
        HomeDriveOperation::Unmount => b":unmount",
    };
    encode_into(
        frame,
        MSG_HOME_DRIVE_MOUNT,
        seq,
        HOME_DRIVE_LAYOUT.len() + suffix.len(),
        |out| {
            out.extend_from_slice(HOME_DRIVE_LAYOUT.as_bytes());
            out.extend_from_slice(suffix);
        },
    )
}

/// Fixed stdout/stderr capture bound for the home mount helper.
pub const HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

/// Encode a full fixed home-drive mount request frame.
///
/// The only payload is the immutable paired-layout discriminator, never
/// caller-selected paths or commands. The guest accepts only the exact current
/// paired layout; empty or incompatible payloads fail validation.
/// The guest owns paths, identity, timeout, output policy, and containment.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the encoded frame exceeds the protocol limit.
pub fn encode_home_drive_mount_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
) -> Result<(), ProtocolError> {
    encode_home_drive_operation_frame_into(frame, seq, HomeDriveOperation::Mount)
}

/// Decode the fixed home-drive mount request payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] unless the payload names a fixed operation in
/// the exact current paired layout.
pub fn decode_home_drive_mount_request(
    payload: &[u8],
) -> Result<HomeDriveOperation, ProtocolError> {
    if payload == HOME_DRIVE_LAYOUT.as_bytes() {
        Ok(HomeDriveOperation::Mount)
    } else if payload.strip_prefix(HOME_DRIVE_LAYOUT.as_bytes()) == Some(b":unmount".as_slice()) {
        Ok(HomeDriveOperation::Unmount)
    } else {
        Err(ProtocolError::InvalidPayload(
            "home_drive_mount requires the paired home-drive-v1 layout",
        ))
    }
}

/// Encode a fixed home-drive mount terminal result payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if stdout or stderr was discarded or exceeds the
/// fixed capture bound, or if the result exceeds protocol field limits.
pub fn encode_home_drive_mount_result(
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    validate_result_output(stdout, "stdout")?;
    validate_result_output(stderr, "stderr")?;
    crate::encode_exec_result(termination, duration_ms, stdout, stderr, diagnostic)
}

/// Encode a full fixed home-drive mount terminal result frame.
///
/// # Errors
///
/// Returns [`ProtocolError`] if stdout or stderr was discarded or exceeds the
/// fixed capture bound, or if the result exceeds protocol field limits.
pub fn encode_home_drive_mount_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'_>,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    validate_result_output(stdout, "stdout")?;
    validate_result_output(stderr, "stderr")?;
    encode_exec_result_frame_into_with_type::<MSG_HOME_DRIVE_MOUNT_RESULT>(
        frame,
        seq,
        termination,
        duration_ms,
        stdout,
        stderr,
        diagnostic,
    )
}

/// Decode a fixed home-drive mount terminal result payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the shared terminal result is malformed or
/// either output stream violates the fixed capture contract.
pub fn decode_home_drive_mount_result(
    payload: &[u8],
) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let decoded = crate::decode_exec_result(payload)?;
    validate_result_output(decoded.stdout, "stdout")?;
    validate_result_output(decoded.stderr, "stderr")?;
    Ok(decoded)
}

fn validate_result_output(
    output: ExecCapturedOutput<'_>,
    field: &'static str,
) -> Result<(), ProtocolError> {
    super::validate_bounded_capture(
        output,
        HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES,
        field,
        "home_drive_mount_result output must be captured",
    )
}

#[cfg(test)]
mod tests;
