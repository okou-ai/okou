use crate::error::{NbdCowError, Result};

const NLMSG_HEADER_LEN: usize = 16;
const GENL_HEADER_LEN: usize = 4;
const GENL_ATTR_OFFSET: usize = NLMSG_HEADER_LEN + GENL_HEADER_LEN;

const NLMSG_LEN_OFFSET: usize = 0;
const NLMSG_TYPE_OFFSET: usize = 4;
const NLMSG_SEQ_OFFSET: usize = 8;
const NLMSG_ERROR_CODE_OFFSET: usize = NLMSG_HEADER_LEN;

const U16_LEN: usize = 2;
const U32_LEN: usize = 4;

// Linux kernel error returns are constrained to the ERR_PTR errno range.
const MAX_NETLINK_ERRNO: i32 = 4095;

const NLM_F_REQUEST: u16 = 1;
const NLM_F_ACK: u16 = 4;
const NLMSG_ERROR: u16 = 2;

const NLA_HEADER_LEN: usize = 4;
const NLA_ALIGNTO: usize = 4;
const NLA_F_NESTED: u16 = 1 << 15;
pub(super) const MAX_NLA_PAYLOAD_LEN: usize = u16::MAX as usize - NLA_HEADER_LEN;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NlHeader {
    pub(super) len: usize,
    pub(super) msg_type: u16,
    pub(super) seq: u32,
}

/// Result of parsing a single generic-netlink response.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GenlResponse<'a> {
    /// NLMSG_ERROR with error=0 (ACK).
    Ack,
    /// Non-error generic-netlink reply.
    Reply { attrs: &'a [u8] },
}

pub(super) fn build_genl_msg(
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    seq: u32,
    request_ack: bool,
) -> Vec<u8> {
    assert!(
        attrs.len() <= u32::MAX as usize - GENL_ATTR_OFFSET,
        "netlink message too large"
    );
    let total_len = GENL_ATTR_OFFSET + attrs.len();
    let mut msg = Vec::with_capacity(total_len);

    let mut flags = NLM_F_REQUEST;
    if request_ack {
        flags |= NLM_F_ACK;
    }

    msg.extend_from_slice(&(total_len as u32).to_ne_bytes());
    msg.extend_from_slice(&msg_type.to_ne_bytes());
    msg.extend_from_slice(&flags.to_ne_bytes());
    msg.extend_from_slice(&seq.to_ne_bytes());
    msg.extend_from_slice(&0u32.to_ne_bytes());
    msg.push(cmd);
    msg.push(version);
    msg.extend_from_slice(&0u16.to_ne_bytes());
    msg.extend_from_slice(attrs);

    debug_assert_eq!(msg.len(), total_len);
    msg
}

pub(super) fn parse_nl_header(buf: &[u8], n: usize) -> Result<NlHeader> {
    let received = received_slice(buf, n)?;
    if received.len() < NLMSG_HEADER_LEN {
        return Err(NbdCowError::Netlink("message too short".into()));
    }

    Ok(NlHeader {
        len: read_u32_at(
            received,
            NLMSG_LEN_OFFSET,
            "msg_len slice",
            "msg_len conversion",
        )? as usize,
        msg_type: read_u16_at(
            received,
            NLMSG_TYPE_OFFSET,
            "msg_type slice",
            "msg_type conversion",
        )?,
        seq: read_u32_at(received, NLMSG_SEQ_OFFSET, "seq slice", "seq conversion")?,
    })
}

/// Parse a single generic-netlink response from the buffer. Returns
/// `GenlResponse` on success, or an error for NLMSG_ERROR with a non-zero or
/// malformed error code.
pub(super) fn parse_genl_response(buf: &[u8], n: usize) -> Result<GenlResponse<'_>> {
    let received = received_slice(buf, n)?;
    let header = parse_nl_header(buf, n)?;
    if header.len < NLMSG_HEADER_LEN {
        return Err(NbdCowError::Netlink("message too short".into()));
    }

    let msg = received
        .get(..header.len)
        .ok_or_else(|| NbdCowError::Netlink("truncated netlink message".into()))?;

    if header.msg_type == NLMSG_ERROR {
        let error = read_i32_at(
            msg,
            NLMSG_ERROR_CODE_OFFSET,
            "error response too short",
            "error code conversion",
        )?;
        if error == 0 {
            return Ok(GenlResponse::Ack);
        }
        if error > 0 {
            return Err(NbdCowError::Netlink(
                "invalid positive netlink error code".into(),
            ));
        }
        let errno = error
            .checked_neg()
            .ok_or_else(|| NbdCowError::Netlink("invalid netlink error code".into()))?;
        if errno > MAX_NETLINK_ERRNO {
            return Err(NbdCowError::Netlink("invalid netlink error code".into()));
        }
        return Err(NbdCowError::NetlinkErrno {
            errno,
            message: std::io::Error::from_raw_os_error(errno).to_string(),
        });
    }

    let attrs = msg
        .get(GENL_ATTR_OFFSET..)
        .ok_or_else(|| NbdCowError::Netlink("response too short".into()))?;

    Ok(GenlResponse::Reply { attrs })
}

pub(super) fn find_nla_u16(
    attrs: &[u8],
    target_type: u16,
    truncated_value_message: &'static str,
) -> Result<Option<u16>> {
    let mut offset = 0usize;
    while offset < attrs.len() {
        let remaining = attrs.len() - offset;
        if remaining < NLA_HEADER_LEN {
            return Err(NbdCowError::Netlink("truncated nla".into()));
        }

        let nla_len = read_u16_at(attrs, offset, "truncated nla", "nla len conversion")? as usize;
        let nla_type = read_u16_at(
            attrs,
            offset + U16_LEN,
            "truncated nla",
            "nla type conversion",
        )?;

        if nla_len < NLA_HEADER_LEN {
            return Err(NbdCowError::Netlink("invalid nla length".into()));
        }
        if nla_len > remaining {
            return Err(NbdCowError::Netlink("truncated nla".into()));
        }

        if nla_type == target_type {
            if nla_len < NLA_HEADER_LEN + U16_LEN {
                return Err(NbdCowError::Netlink(truncated_value_message.into()));
            }
            return read_u16_at(
                attrs,
                offset + NLA_HEADER_LEN,
                truncated_value_message,
                "id conversion",
            )
            .map(Some);
        }

        let aligned = align_nla_len(nla_len);
        offset = offset
            .checked_add(aligned)
            .ok_or_else(|| NbdCowError::Netlink("nla offset overflow".into()))?;
    }

    Ok(None)
}

/// Build a netlink attribute (NLA).
pub(super) fn build_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    build_nla_with_encoded_type(nla_type, payload, "NLA payload too large")
}

/// Build a nested netlink attribute.
pub(super) fn build_nested_nla(nla_type: u16, payload: &[u8]) -> Vec<u8> {
    build_nla_with_encoded_type(
        nla_type | NLA_F_NESTED,
        payload,
        "nested NLA payload too large",
    )
}

fn build_nla_with_encoded_type(
    encoded_type: u16,
    payload: &[u8],
    too_large_message: &'static str,
) -> Vec<u8> {
    assert!(payload.len() <= MAX_NLA_PAYLOAD_LEN, "{too_large_message}");
    let nla_len = NLA_HEADER_LEN + payload.len();
    let aligned_len = align_nla_len(nla_len);
    let mut buf = Vec::with_capacity(aligned_len);

    buf.extend_from_slice(&(nla_len as u16).to_ne_bytes());
    buf.extend_from_slice(&encoded_type.to_ne_bytes());
    buf.extend_from_slice(payload);
    buf.resize(aligned_len, 0);

    debug_assert_eq!(buf.len(), aligned_len);
    buf
}

pub(super) fn aligned_nla_len_for_payload(payload_len: usize) -> Option<usize> {
    if payload_len > MAX_NLA_PAYLOAD_LEN {
        return None;
    }
    Some(align_nla_len(NLA_HEADER_LEN + payload_len))
}

fn received_slice(buf: &[u8], n: usize) -> Result<&[u8]> {
    buf.get(..n)
        .ok_or_else(|| NbdCowError::Netlink("recv length exceeds buffer".into()))
}

fn read_u16_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<u16> {
    let bytes: [u8; U16_LEN] = buf
        .get(offset..offset + U16_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(u16::from_ne_bytes(bytes))
}

fn read_u32_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<u32> {
    let bytes: [u8; U32_LEN] = buf
        .get(offset..offset + U32_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(u32::from_ne_bytes(bytes))
}

fn read_i32_at(
    buf: &[u8],
    offset: usize,
    slice_message: &'static str,
    conversion_message: &'static str,
) -> Result<i32> {
    let bytes: [u8; U32_LEN] = buf
        .get(offset..offset + U32_LEN)
        .ok_or_else(|| NbdCowError::Netlink(slice_message.into()))?
        .try_into()
        .map_err(|_| NbdCowError::Netlink(conversion_message.into()))?;
    Ok(i32::from_ne_bytes(bytes))
}

fn align_nla_len(len: usize) -> usize {
    (len + NLA_ALIGNTO - 1) & !(NLA_ALIGNTO - 1)
}

#[cfg(test)]
pub(super) fn build_nlmsg_error_for_test(seq: u32, error: i32) -> Vec<u8> {
    let len = (NLMSG_HEADER_LEN + U32_LEN + U32_LEN) as u32;
    let mut buf = Vec::with_capacity(len as usize);
    buf.extend_from_slice(&len.to_ne_bytes());
    buf.extend_from_slice(&NLMSG_ERROR.to_ne_bytes());
    buf.extend_from_slice(&0u16.to_ne_bytes());
    buf.extend_from_slice(&seq.to_ne_bytes());
    buf.extend_from_slice(&0u32.to_ne_bytes());
    buf.extend_from_slice(&error.to_ne_bytes());
    buf.extend_from_slice(&0u32.to_ne_bytes());
    buf
}

#[cfg(test)]
pub(super) fn set_nlmsg_len_for_test(buf: &mut [u8], len: u32) {
    write_u32_for_test(buf, NLMSG_LEN_OFFSET, len);
}

#[cfg(test)]
fn write_u16_for_test(buf: &mut [u8], offset: usize, value: u16) {
    buf[offset..offset + U16_LEN].copy_from_slice(&value.to_ne_bytes());
}

#[cfg(test)]
fn write_u32_for_test(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + U32_LEN].copy_from_slice(&value.to_ne_bytes());
}

#[cfg(test)]
mod tests;
