use super::truncate_utf8_to_u16_bytes;
use crate::error::ProtocolError;
use crate::read::{expect_consumed, read_str, read_u16};

/// Encode error payload: `[2B error_len][error]`.
///
/// Error message is truncated to at most 65535 bytes at a UTF-8 boundary.
pub fn encode_error(message: &str) -> Vec<u8> {
    let (msg, msg_len) = truncate_utf8_to_u16_bytes(message);
    let mut p = Vec::with_capacity(2 + msg_len as usize);
    p.extend_from_slice(&msg_len.to_be_bytes());
    p.extend_from_slice(msg);
    p
}

/// Decode error payload. Returns the error message.
pub fn decode_error(payload: &[u8]) -> Result<&str, ProtocolError> {
    let mut offset = 0;
    let msg_len = read_u16(payload, &mut offset, "error payload too short")? as usize;
    let message = read_str(
        payload,
        &mut offset,
        msg_len,
        "error message truncated",
        "invalid UTF-8 in error",
    )?;
    expect_consumed(payload, offset, "error trailing bytes")?;
    Ok(message)
}

#[cfg(test)]
mod tests;
