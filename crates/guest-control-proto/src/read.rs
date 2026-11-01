use crate::error::ProtocolError;
use crate::wire::{MAX_MESSAGE_SIZE, MAX_PAYLOAD_SIZE, MIN_BODY_SIZE};

/// Read a `u8` from `data` at `offset`. Returns `None` if out of bounds.
pub(crate) fn read_u8_at(data: &[u8], offset: usize) -> Option<u8> {
    data.get(offset).copied()
}

/// Read a `u16` from `data` at `offset`. Returns `None` if out of bounds.
pub(crate) fn read_u16_at(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let bytes: [u8; 2] = data.get(offset..end)?.try_into().ok()?;
    Some(u16::from_be_bytes(bytes))
}

/// Read a `u32` from `data` at `offset`. Returns `None` if out of bounds.
pub(crate) fn read_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = data.get(offset..end)?.try_into().ok()?;
    Some(u32::from_be_bytes(bytes))
}

/// Read a `u64` from `data` at `offset`. Returns `None` if out of bounds.
pub(crate) fn read_u64_at(data: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    let bytes: [u8; 8] = data.get(offset..end)?.try_into().ok()?;
    Some(u64::from_be_bytes(bytes))
}

/// Read an `i32` from `data` at `offset`. Returns `None` if out of bounds.
pub(crate) fn read_i32_at(data: &[u8], offset: usize) -> Option<i32> {
    let end = offset.checked_add(4)?;
    let bytes: [u8; 4] = data.get(offset..end)?.try_into().ok()?;
    Some(i32::from_be_bytes(bytes))
}

pub(crate) fn ensure_payload_fits_message(payload_len: usize) -> Result<(), ProtocolError> {
    let body_len = MIN_BODY_SIZE
        .checked_add(payload_len)
        .ok_or(ProtocolError::MessageTooLarge(usize::MAX))?;
    if payload_len > MAX_PAYLOAD_SIZE || body_len > MAX_MESSAGE_SIZE {
        return Err(ProtocolError::MessageTooLarge(body_len));
    }
    Ok(())
}

pub(crate) fn checked_payload_len_add(total: usize, add: usize) -> Result<usize, ProtocolError> {
    total
        .checked_add(add)
        .ok_or(ProtocolError::MessageTooLarge(usize::MAX))
}

pub(crate) fn ensure_u16_len(field: &'static str, len: usize) -> Result<u16, ProtocolError> {
    if len > u16::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge(field, len));
    }
    Ok(len as u16)
}

pub(crate) fn ensure_u32_len(field: &'static str, len: usize) -> Result<u32, ProtocolError> {
    if len > u32::MAX as usize {
        return Err(ProtocolError::PayloadTooLarge(field, len));
    }
    Ok(len as u32)
}

pub(crate) fn ensure_u16_count(field: &'static str, count: usize) -> Result<u16, ProtocolError> {
    if count > u16::MAX as usize {
        return Err(ProtocolError::PayloadCountTooLarge(field, count));
    }
    Ok(count as u16)
}

pub(crate) fn ensure_u32_count(field: &'static str, count: usize) -> Result<u32, ProtocolError> {
    if count > u32::MAX as usize {
        return Err(ProtocolError::PayloadCountTooLarge(field, count));
    }
    Ok(count as u32)
}

pub(crate) fn read_u8(
    payload: &[u8],
    offset: &mut usize,
    err: &'static str,
) -> Result<u8, ProtocolError> {
    let value = read_u8_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 1;
    Ok(value)
}

pub(crate) fn read_u16(
    payload: &[u8],
    offset: &mut usize,
    err: &'static str,
) -> Result<u16, ProtocolError> {
    let value = read_u16_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 2;
    Ok(value)
}

pub(crate) fn read_u32(
    payload: &[u8],
    offset: &mut usize,
    err: &'static str,
) -> Result<u32, ProtocolError> {
    let value = read_u32_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 4;
    Ok(value)
}

pub(crate) fn read_u64(
    payload: &[u8],
    offset: &mut usize,
    err: &'static str,
) -> Result<u64, ProtocolError> {
    let value = read_u64_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 8;
    Ok(value)
}

pub(crate) fn read_i32(
    payload: &[u8],
    offset: &mut usize,
    err: &'static str,
) -> Result<i32, ProtocolError> {
    let value = read_i32_at(payload, *offset).ok_or(ProtocolError::InvalidPayload(err))?;
    *offset += 4;
    Ok(value)
}

pub(crate) fn read_slice<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    err: &'static str,
) -> Result<&'a [u8], ProtocolError> {
    let end = (*offset)
        .checked_add(len)
        .ok_or(ProtocolError::InvalidPayload(err))?;
    let slice = payload
        .get(*offset..end)
        .ok_or(ProtocolError::InvalidPayload(err))?;
    *offset = end;
    Ok(slice)
}

pub(crate) fn read_str<'a>(
    payload: &'a [u8],
    offset: &mut usize,
    len: usize,
    truncated_err: &'static str,
    utf8_err: &'static str,
) -> Result<&'a str, ProtocolError> {
    std::str::from_utf8(read_slice(payload, offset, len, truncated_err)?)
        .map_err(|_| ProtocolError::InvalidPayload(utf8_err))
}

pub(crate) fn expect_consumed(
    payload: &[u8],
    offset: usize,
    err: &'static str,
) -> Result<(), ProtocolError> {
    if offset != payload.len() {
        return Err(ProtocolError::InvalidPayload(err));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
