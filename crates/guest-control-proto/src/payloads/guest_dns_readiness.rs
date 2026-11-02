use super::process_termination::{
    TerminationDecodeErrors, append_termination, decode_termination as decode_process_termination,
    termination_encoded_len,
};
use crate::ProtocolError;
use crate::frame::encode_into;
use crate::read::{expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32};
use crate::wire::MSG_GUEST_DNS_READINESS;

const RESULT_FLAG_OUTPUT_TRUNCATED: u8 = 0x01;

/// Backward-compatible name for the shared guest process terminal state.
///
/// For DNS readiness, `TimedOut` means the request timeout elapsed, `Cancelled`
/// means the owning connection was cancelled, and `WaitFailed` includes process
/// wait or cleanup failures.
pub use super::process_termination::ExecTermination as GuestDnsReadinessTermination;

/// Maximum encoded hostname length accepted by a guest DNS readiness request.
pub const GUEST_DNS_READINESS_MAX_HOSTNAME_BYTES: usize = 253;

/// Maximum retained answer bytes in a guest DNS readiness result.
pub const GUEST_DNS_READINESS_MAX_ANSWER_BYTES: usize = 1_024;

/// Maximum retained diagnostic bytes in a guest DNS readiness result.
pub const GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES: usize = 512;

/// Decoded guest DNS readiness request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestDnsReadinessRequest<'a> {
    /// Positive child-process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Hostname passed as one argument to the fixed guest resolver command.
    pub hostname: &'a str,
}

/// Decoded result of the fixed guest DNS readiness process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestDnsReadinessResult<'a> {
    /// Terminal process state.
    pub termination: GuestDnsReadinessTermination,
    /// Guest-observed operation duration in milliseconds.
    pub duration_ms: u32,
    /// Retained raw stdout containing resolver answers.
    pub answer: &'a [u8],
    /// Whether resolver stdout or stderr exceeded its retained byte bound, or
    /// output-drain completion could not be confirmed.
    ///
    /// Completion is unproven when either drain's completion notification is not
    /// received before the drain deadline or either drain worker's result cannot
    /// be obtained. Retained output may therefore be incomplete even when `answer`
    /// is short or empty. This flag does not report every cancellation or read
    /// failure.
    pub output_truncated: bool,
    /// Bounded UTF-8 process or internal diagnostic.
    pub diagnostic: &'a str,
}

/// Encode a guest DNS readiness request payload.
pub fn encode_guest_dns_readiness_request(
    timeout_ms: u32,
    hostname: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let hostname_len = validate_request(timeout_ms, hostname)?;
    let mut payload = Vec::with_capacity(6 + hostname.len());
    append_request_payload(&mut payload, timeout_ms, hostname_len, hostname);
    Ok(payload)
}

/// Encode a full guest DNS readiness request frame into `frame`.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `timeout_ms` is zero, `hostname` is empty,
/// exceeds the configured hostname limit, contains a NUL byte, or cannot fit
/// the hostname wire-length field.
///
/// Request validation runs before the shared frame encoder clears `frame`, so
/// validation errors leave the destination unchanged. After validation
/// succeeds, frame construction follows the shared clear-and-write behavior.
pub fn encode_guest_dns_readiness_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    timeout_ms: u32,
    hostname: &str,
) -> Result<(), ProtocolError> {
    let hostname_len = validate_request(timeout_ms, hostname)?;
    let payload_len = 6 + hostname.len();
    encode_into(frame, MSG_GUEST_DNS_READINESS, seq, payload_len, |frame| {
        append_request_payload(frame, timeout_ms, hostname_len, hostname)
    })
}

/// Decode a guest DNS readiness request payload.
pub fn decode_guest_dns_readiness_request(
    payload: &[u8],
) -> Result<DecodedGuestDnsReadinessRequest<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(
        payload,
        &mut offset,
        "guest_dns_readiness timeout_ms truncated",
    )?;
    let hostname_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness hostname_len truncated",
    )?);
    let hostname = read_str(
        payload,
        &mut offset,
        hostname_len,
        "guest_dns_readiness hostname truncated",
        "guest_dns_readiness hostname invalid UTF-8",
    )?;
    expect_consumed(payload, offset, "guest_dns_readiness trailing bytes")?;
    validate_request(timeout_ms, hostname)?;
    Ok(DecodedGuestDnsReadinessRequest {
        timeout_ms,
        hostname,
    })
}

/// Encode a guest DNS readiness result payload.
pub fn encode_guest_dns_readiness_result(
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: &[u8],
    output_truncated: bool,
    diagnostic: &str,
) -> Result<Vec<u8>, ProtocolError> {
    let encoded = validate_result(answer, diagnostic)?;
    let mut payload = Vec::with_capacity(result_payload_len(termination, answer, diagnostic));
    append_result_payload(
        &mut payload,
        termination,
        duration_ms,
        answer,
        output_truncated,
        diagnostic,
        encoded,
    );
    Ok(payload)
}

/// Decode a guest DNS readiness result payload.
pub fn decode_guest_dns_readiness_result(
    payload: &[u8],
) -> Result<DecodedGuestDnsReadinessResult<'_>, ProtocolError> {
    let mut offset = 0;
    let termination = decode_termination(payload, &mut offset)?;
    let duration_ms = read_u32(
        payload,
        &mut offset,
        "guest_dns_readiness_result duration_ms truncated",
    )?;
    let flags = read_u8(
        payload,
        &mut offset,
        "guest_dns_readiness_result flags truncated",
    )?;
    if flags & !RESULT_FLAG_OUTPUT_TRUNCATED != 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result unknown flags",
        ));
    }
    let answer_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness_result answer_len truncated",
    )?);
    if answer_len > GUEST_DNS_READINESS_MAX_ANSWER_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result answer exceeds limit",
        ));
    }
    let answer = read_slice(
        payload,
        &mut offset,
        answer_len,
        "guest_dns_readiness_result answer truncated",
    )?;
    let diagnostic_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_dns_readiness_result diagnostic_len truncated",
    )?);
    if diagnostic_len > GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness_result diagnostic exceeds limit",
        ));
    }
    let diagnostic = read_str(
        payload,
        &mut offset,
        diagnostic_len,
        "guest_dns_readiness_result diagnostic truncated",
        "guest_dns_readiness_result diagnostic invalid UTF-8",
    )?;
    expect_consumed(payload, offset, "guest_dns_readiness_result trailing bytes")?;
    Ok(DecodedGuestDnsReadinessResult {
        termination,
        duration_ms,
        answer,
        output_truncated: flags & RESULT_FLAG_OUTPUT_TRUNCATED != 0,
        diagnostic,
    })
}

fn validate_request(timeout_ms: u32, hostname: &str) -> Result<u16, ProtocolError> {
    if timeout_ms == 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness timeout_ms must be positive",
        ));
    }
    if hostname.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness hostname must not be empty",
        ));
    }
    if hostname.len() > GUEST_DNS_READINESS_MAX_HOSTNAME_BYTES {
        return Err(ProtocolError::PayloadTooLarge("hostname", hostname.len()));
    }
    if hostname.as_bytes().contains(&0) {
        return Err(ProtocolError::InvalidPayload(
            "guest_dns_readiness hostname contains NUL",
        ));
    }
    u16::try_from(hostname.len())
        .map_err(|_| ProtocolError::PayloadTooLarge("hostname", hostname.len()))
}

fn append_request_payload(
    payload: &mut Vec<u8>,
    timeout_ms: u32,
    hostname_len: u16,
    hostname: &str,
) {
    payload.extend_from_slice(&timeout_ms.to_be_bytes());
    payload.extend_from_slice(&hostname_len.to_be_bytes());
    payload.extend_from_slice(hostname.as_bytes());
}

#[derive(Clone, Copy)]
struct EncodedResultLengths {
    answer_len: u16,
    diagnostic_len: u16,
}

fn validate_result(answer: &[u8], diagnostic: &str) -> Result<EncodedResultLengths, ProtocolError> {
    if answer.len() > GUEST_DNS_READINESS_MAX_ANSWER_BYTES {
        return Err(ProtocolError::PayloadTooLarge("answer", answer.len()));
    }
    if diagnostic.len() > GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "diagnostic",
            diagnostic.len(),
        ));
    }
    Ok(EncodedResultLengths {
        answer_len: u16::try_from(answer.len())
            .map_err(|_| ProtocolError::PayloadTooLarge("answer", answer.len()))?,
        diagnostic_len: u16::try_from(diagnostic.len())
            .map_err(|_| ProtocolError::PayloadTooLarge("diagnostic", diagnostic.len()))?,
    })
}

fn result_payload_len(
    termination: GuestDnsReadinessTermination,
    answer: &[u8],
    diagnostic: &str,
) -> usize {
    termination_encoded_len(termination) + 4 + 1 + 2 + answer.len() + 2 + diagnostic.len()
}

fn append_result_payload(
    payload: &mut Vec<u8>,
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: &[u8],
    output_truncated: bool,
    diagnostic: &str,
    encoded: EncodedResultLengths,
) {
    append_termination(payload, termination);
    payload.extend_from_slice(&duration_ms.to_be_bytes());
    payload.push(u8::from(output_truncated) * RESULT_FLAG_OUTPUT_TRUNCATED);
    payload.extend_from_slice(&encoded.answer_len.to_be_bytes());
    payload.extend_from_slice(answer);
    payload.extend_from_slice(&encoded.diagnostic_len.to_be_bytes());
    payload.extend_from_slice(diagnostic.as_bytes());
}

fn decode_termination(
    payload: &[u8],
    offset: &mut usize,
) -> Result<GuestDnsReadinessTermination, ProtocolError> {
    decode_process_termination(
        payload,
        offset,
        TerminationDecodeErrors {
            termination_truncated: "guest_dns_readiness_result termination truncated",
            exit_code_truncated: "guest_dns_readiness_result exit_code truncated",
            invalid_tag: "guest_dns_readiness_result unknown termination",
        },
    )
}

#[cfg(test)]
mod tests;
