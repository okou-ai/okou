use crate::error::ProtocolError;

/// Decode an empty control-plane payload.
pub fn decode_empty_payload(
    payload_name: &'static str,
    payload: &[u8],
) -> Result<(), ProtocolError> {
    if payload.is_empty() {
        Ok(())
    } else {
        Err(ProtocolError::InvalidPayload(payload_name))
    }
}

#[cfg(test)]
mod tests;
