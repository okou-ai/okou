use crate::ProtocolError;
use crate::frame::encode_into;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, expect_consumed,
    read_slice, read_str, read_u8, read_u16, read_u32, read_u64,
};
use crate::wire::{MSG_GUEST_STATE_RESTORE, MSG_GUEST_STATE_RESTORE_RESULT};
use crate::{DecodedExecResult, ExecCapturedOutput, ExecTermination};

/// Exact entropy byte count required by snapshot-sensitive guest restore.
pub const GUEST_STATE_RESTORE_ENTROPY_BYTES: usize = 256;

/// Maximum encoded timezone name accepted by the fixed restore operation.
pub const GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES: usize = 255;

/// Fixed stderr capture bound for the guest-state helper.
pub const GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

const TIMEZONE_NONE: u8 = 0;
const TIMEZONE_BEST_EFFORT: u8 = 1;
const TIMEZONE_REQUIRED: u8 = 2;

/// Typed timezone behavior for the fixed guest-state restore operation.
///
/// Named modes require a non-empty name containing only ASCII letters, digits,
/// `/`, `_`, `-`, and `+`, bounded by [`GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestStateRestoreTimezone<'a> {
    /// Do not change timezone state.
    None,
    /// Apply the timezone when available without failing the restore.
    BestEffort(&'a str),
    /// Require the timezone to exist and apply successfully.
    Required(&'a str),
}

/// Decoded fixed guest-state restore request.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct DecodedGuestStateRestoreRequest<'a> {
    /// Positive child-process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Host realtime seconds since the Unix epoch.
    pub unix_seconds: u64,
    /// Fractional host realtime nanoseconds.
    pub unix_nanoseconds: u32,
    /// Exactly 256 host entropy bytes.
    pub entropy: &'a [u8],
    /// Optional timezone behavior.
    pub timezone: GuestStateRestoreTimezone<'a>,
}

impl std::fmt::Debug for DecodedGuestStateRestoreRequest<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DecodedGuestStateRestoreRequest")
            .field("timeout_ms", &self.timeout_ms)
            .field("unix_seconds", &self.unix_seconds)
            .field("unix_nanoseconds", &self.unix_nanoseconds)
            .field("entropy_len", &self.entropy.len())
            .field("timezone", &self.timezone)
            .finish()
    }
}

/// Encode a fixed guest-state restore request payload.
pub fn encode_guest_state_restore_request(
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<Vec<u8>, ProtocolError> {
    let timezone_length = validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    let payload_len = request_payload_len(timezone)?;
    let mut payload = Vec::with_capacity(payload_len);
    append_request_payload(
        &mut payload,
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
        timezone_length,
    );
    Ok(payload)
}

/// Encode a full fixed guest-state restore request frame into `frame`.
pub fn encode_guest_state_restore_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<(), ProtocolError> {
    let timezone_length = validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    let payload_len = request_payload_len(timezone)?;
    encode_into(frame, MSG_GUEST_STATE_RESTORE, seq, payload_len, |frame| {
        append_request_payload(
            frame,
            timeout_ms,
            unix_seconds,
            unix_nanoseconds,
            entropy,
            timezone,
            timezone_length,
        )
    })
}

/// Decode a fixed guest-state restore request payload.
pub fn decode_guest_state_restore_request(
    payload: &[u8],
) -> Result<DecodedGuestStateRestoreRequest<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(
        payload,
        &mut offset,
        "guest_state_restore timeout_ms truncated",
    )?;
    let unix_seconds = read_u64(
        payload,
        &mut offset,
        "guest_state_restore unix_seconds truncated",
    )?;
    let unix_nanoseconds = read_u32(
        payload,
        &mut offset,
        "guest_state_restore unix_nanoseconds truncated",
    )?;
    let timezone_mode = read_u8(
        payload,
        &mut offset,
        "guest_state_restore timezone_mode truncated",
    )?;
    let timezone_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_state_restore timezone_len truncated",
    )?);
    let timezone_name = read_str(
        payload,
        &mut offset,
        timezone_len,
        "guest_state_restore timezone truncated",
        "guest_state_restore timezone invalid UTF-8",
    )?;
    let entropy = read_slice(
        payload,
        &mut offset,
        GUEST_STATE_RESTORE_ENTROPY_BYTES,
        "guest_state_restore entropy truncated",
    )?;
    expect_consumed(payload, offset, "guest_state_restore trailing bytes")?;
    let timezone = decode_timezone(timezone_mode, timezone_name)?;
    validate_request(
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    )?;
    Ok(DecodedGuestStateRestoreRequest {
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
    })
}

/// Encode a fixed guest-state restore terminal result payload.
pub fn encode_guest_state_restore_result(
    termination: ExecTermination,
    duration_ms: u32,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    validate_stderr(stderr)?;
    crate::encode_exec_result(
        termination,
        duration_ms,
        ExecCapturedOutput::Captured {
            bytes: &[],
            truncated: false,
        },
        stderr,
        diagnostic,
    )
}

/// Encode a full fixed guest-state restore terminal result frame.
pub fn encode_guest_state_restore_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stderr: ExecCapturedOutput<'_>,
    diagnostic: &str,
) -> Result<(), ProtocolError> {
    let payload = encode_guest_state_restore_result(termination, duration_ms, stderr, diagnostic)?;
    encode_into(
        frame,
        MSG_GUEST_STATE_RESTORE_RESULT,
        seq,
        payload.len(),
        |frame| frame.extend_from_slice(&payload),
    )
}

/// Decode a fixed guest-state restore terminal result payload.
pub fn decode_guest_state_restore_result(
    payload: &[u8],
) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let decoded = crate::decode_exec_result(payload)?;
    match decoded.stdout {
        ExecCapturedOutput::Captured {
            bytes: [],
            truncated: false,
        } => {}
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "guest_state_restore_result stdout must be empty captured output",
            ));
        }
    }
    validate_stderr(decoded.stderr)?;
    Ok(decoded)
}

fn validate_request(
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
) -> Result<u16, ProtocolError> {
    if timeout_ms == 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore timeout_ms must be positive",
        ));
    }
    if unix_seconds > i64::MAX as u64 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore unix_seconds exceed signed time range",
        ));
    }
    if unix_nanoseconds >= 1_000_000_000 {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore unix_nanoseconds must be below one second",
        ));
    }
    if entropy.len() != GUEST_STATE_RESTORE_ENTROPY_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore entropy must contain exactly 256 bytes",
        ));
    }
    let timezone_name = timezone_name(timezone);
    if timezone_name.is_empty() && !matches!(timezone, GuestStateRestoreTimezone::None) {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone must not be empty",
        ));
    }
    if timezone_name.len() > GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "timezone",
            timezone_name.len(),
        ));
    }
    if !timezone_name.is_empty() && !is_safe_timezone_name(timezone_name) {
        return Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone contains unsafe characters",
        ));
    }
    let length = ensure_u16_len("timezone", timezone_name.len())?;
    ensure_payload_fits_message(request_payload_len(timezone)?)?;
    Ok(length)
}

fn request_payload_len(timezone: GuestStateRestoreTimezone<'_>) -> Result<usize, ProtocolError> {
    let fixed = 4usize + 8 + 4 + 1 + 2 + GUEST_STATE_RESTORE_ENTROPY_BYTES;
    checked_payload_len_add(fixed, timezone_name(timezone).len())
}

fn append_request_payload(
    payload: &mut Vec<u8>,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: &[u8],
    timezone: GuestStateRestoreTimezone<'_>,
    timezone_length: u16,
) {
    payload.extend_from_slice(&timeout_ms.to_be_bytes());
    payload.extend_from_slice(&unix_seconds.to_be_bytes());
    payload.extend_from_slice(&unix_nanoseconds.to_be_bytes());
    payload.push(timezone_tag(timezone));
    payload.extend_from_slice(&timezone_length.to_be_bytes());
    payload.extend_from_slice(timezone_name(timezone).as_bytes());
    payload.extend_from_slice(entropy);
}

fn timezone_tag(timezone: GuestStateRestoreTimezone<'_>) -> u8 {
    match timezone {
        GuestStateRestoreTimezone::None => TIMEZONE_NONE,
        GuestStateRestoreTimezone::BestEffort(_) => TIMEZONE_BEST_EFFORT,
        GuestStateRestoreTimezone::Required(_) => TIMEZONE_REQUIRED,
    }
}

fn timezone_name(timezone: GuestStateRestoreTimezone<'_>) -> &str {
    match timezone {
        GuestStateRestoreTimezone::None => "",
        GuestStateRestoreTimezone::BestEffort(name) | GuestStateRestoreTimezone::Required(name) => {
            name
        }
    }
}

fn decode_timezone(mode: u8, name: &str) -> Result<GuestStateRestoreTimezone<'_>, ProtocolError> {
    match (mode, name) {
        (TIMEZONE_NONE, "") => Ok(GuestStateRestoreTimezone::None),
        (TIMEZONE_BEST_EFFORT, name) => Ok(GuestStateRestoreTimezone::BestEffort(name)),
        (TIMEZONE_REQUIRED, name) => Ok(GuestStateRestoreTimezone::Required(name)),
        (TIMEZONE_NONE, _) => Err(ProtocolError::InvalidPayload(
            "guest_state_restore none timezone mode requires an empty name",
        )),
        _ => Err(ProtocolError::InvalidPayload(
            "guest_state_restore timezone mode is invalid",
        )),
    }
}

fn is_safe_timezone_name(timezone: &str) -> bool {
    timezone.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || byte == b'/' || byte == b'_' || byte == b'-' || byte == b'+'
    })
}

fn validate_stderr(stderr: ExecCapturedOutput<'_>) -> Result<(), ProtocolError> {
    match stderr {
        ExecCapturedOutput::Captured { bytes, .. }
            if bytes.len() <= GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES =>
        {
            Ok(())
        }
        ExecCapturedOutput::Captured { bytes, .. } => {
            Err(ProtocolError::PayloadTooLarge("stderr", bytes.len()))
        }
        ExecCapturedOutput::Discarded => Err(ProtocolError::InvalidPayload(
            "guest_state_restore_result stderr must be captured",
        )),
    }
}

#[cfg(test)]
mod tests;
