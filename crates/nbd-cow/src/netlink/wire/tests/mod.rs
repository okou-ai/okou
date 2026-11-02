use super::*;

const NLMSG_FLAGS_OFFSET: usize = 6;
const NLMSG_PID_OFFSET: usize = 12;
const GENL_CMD_OFFSET: usize = NLMSG_HEADER_LEN;
const GENL_VERSION_OFFSET: usize = NLMSG_HEADER_LEN + 1;
const GENL_RESERVED_OFFSET: usize = NLMSG_HEADER_LEN + U16_LEN;

fn nlmsg_flags(msg: &[u8]) -> u16 {
    read_u16_at(msg, NLMSG_FLAGS_OFFSET, "flags slice", "flags conversion").unwrap()
}

#[test]
fn build_nla_basic() {
    let payload: &[u8] = &[0xAA, 0xBB];
    let nla = build_nla(42, payload);

    assert_eq!(
        read_u16_at(&nla, 0, "len slice", "len conversion").unwrap(),
        6
    );
    assert_eq!(
        read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap(),
        42
    );
    assert_eq!(
        nla.get(NLA_HEADER_LEN..NLA_HEADER_LEN + payload.len()),
        Some(payload)
    );
}

#[test]
fn build_nla_padding_to_4byte_alignment() {
    let payload: &[u8] = &[1, 2, 3];
    let nla = build_nla(1, payload);

    assert_eq!(nla.len(), 8);
    assert_eq!(
        nla.get(NLA_HEADER_LEN..NLA_HEADER_LEN + payload.len()),
        Some(payload)
    );
    assert_eq!(nla.get(7), Some(&0));
}

#[test]
fn build_nla_no_padding_when_aligned() {
    let payload: &[u8] = &[1, 2, 3, 4];
    let nla = build_nla(1, payload);

    assert_eq!(nla.len(), 8);
}

#[test]
fn build_nla_empty_payload() {
    let nla = build_nla(99, &[]);

    assert_eq!(nla.len(), NLA_HEADER_LEN);
    assert_eq!(
        read_u16_at(&nla, 0, "len slice", "len conversion").unwrap(),
        NLA_HEADER_LEN as u16
    );
}

#[test]
fn build_nested_nla_sets_nested_flag() {
    let payload: &[u8] = &[0xDE, 0xAD];
    let nla = build_nested_nla(7, payload);

    assert_eq!(
        read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap(),
        7 | NLA_F_NESTED
    );
    assert_eq!(nla.len(), 8);
}

#[test]
fn build_nested_nla_matches_regular_payload_and_padding() {
    let payload: &[u8] = &[1, 2, 3];
    let nla = build_nla(7, payload);
    let nested_nla = build_nested_nla(7, payload);

    assert_eq!(nested_nla.len(), nla.len());
    assert_eq!(
        read_u16_at(&nested_nla, 0, "nested len slice", "nested len conversion").unwrap(),
        read_u16_at(&nla, 0, "len slice", "len conversion").unwrap()
    );
    assert_eq!(
        read_u16_at(
            &nested_nla,
            U16_LEN,
            "nested type slice",
            "nested type conversion"
        )
        .unwrap(),
        read_u16_at(&nla, U16_LEN, "type slice", "type conversion").unwrap() | NLA_F_NESTED
    );
    assert_eq!(nested_nla.get(NLA_HEADER_LEN..), nla.get(NLA_HEADER_LEN..));
}

#[test]
fn build_genl_msg_can_omit_ack_for_family_lookup() {
    let attrs = build_nla(2, b"nbd\0");
    let msg = build_genl_msg(0x10, 3, 1, &attrs, 42, false);
    let header = parse_nl_header(&msg, msg.len()).unwrap();

    assert_eq!(msg.len(), GENL_ATTR_OFFSET + attrs.len());
    assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST);
    assert_eq!(header.seq, 42);
    assert_eq!(
        read_u32_at(&msg, NLMSG_PID_OFFSET, "pid slice", "pid conversion").unwrap(),
        0
    );
    assert_eq!(msg.get(GENL_CMD_OFFSET), Some(&3));
    assert_eq!(msg.get(GENL_VERSION_OFFSET), Some(&1));
    assert_eq!(
        read_u16_at(
            &msg,
            GENL_RESERVED_OFFSET,
            "genl reserved slice",
            "genl reserved conversion"
        )
        .unwrap(),
        0
    );
    assert_eq!(msg.get(GENL_ATTR_OFFSET..), Some(attrs.as_slice()));
}

#[test]
fn build_genl_msg_requests_ack_for_nbd_command() {
    let attrs = build_nla(1, &7u32.to_ne_bytes());
    let msg = build_genl_msg(0x19, 1, 1, &attrs, 43, true);
    let header = parse_nl_header(&msg, msg.len()).unwrap();

    assert_eq!(nlmsg_flags(&msg), NLM_F_REQUEST | NLM_F_ACK);
    assert_eq!(header.seq, 43);
}

#[test]
fn parse_genl_response_ack() {
    let msg = build_nlmsg_error_for_test(42, 0);

    assert!(matches!(
        parse_genl_response(&msg, msg.len()),
        Ok(GenlResponse::Ack)
    ));
    assert_eq!(parse_nl_header(&msg, msg.len()).unwrap().seq, 42);
}

#[test]
fn parse_genl_response_reply() {
    let msg = build_genl_msg(0x0019, 1, 1, &[], 43, false);

    assert!(matches!(
        parse_genl_response(&msg, msg.len()),
        Ok(GenlResponse::Reply { attrs }) if attrs.is_empty()
    ));
    assert_eq!(parse_nl_header(&msg, msg.len()).unwrap().seq, 43);
}

#[test]
fn parse_genl_response_reply_requires_genl_header() {
    let mut buf = vec![0u8; NLMSG_HEADER_LEN];
    write_u32_for_test(&mut buf, NLMSG_LEN_OFFSET, NLMSG_HEADER_LEN as u32);
    write_u16_for_test(&mut buf, NLMSG_TYPE_OFFSET, 0x19);

    let result = parse_genl_response(&buf, buf.len());

    assert!(
        matches!(result, Err(NbdCowError::Netlink(message)) if message == "response too short")
    );
}

#[test]
fn parse_genl_response_reply_attrs_are_bounded_by_declared_length() {
    let mut msg = build_genl_msg(0x0019, 1, 1, &[], 43, false);
    msg.extend_from_slice(&build_nla(1, &123u16.to_ne_bytes()));

    let result = parse_genl_response(&msg, msg.len());

    assert!(matches!(
        result,
        Ok(GenlResponse::Reply { attrs }) if attrs.is_empty()
    ));
}

#[test]
fn parse_genl_response_error_errno() {
    let msg = build_nlmsg_error_for_test(2, -libc::EBUSY);

    let result = parse_genl_response(&msg, msg.len());
    assert!(matches!(
        result,
        Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
    ));
}

#[test]
fn parse_genl_response_error_rejects_i32_min() {
    let msg = build_nlmsg_error_for_test(2, i32::MIN);

    let result = parse_genl_response(&msg, msg.len());
    assert!(matches!(result, Err(NbdCowError::Netlink(_))));
}

#[test]
fn parse_genl_response_error_rejects_positive_code() {
    let msg = build_nlmsg_error_for_test(2, 5);

    let result = parse_genl_response(&msg, msg.len());
    assert!(matches!(result, Err(NbdCowError::Netlink(_))));
}

#[test]
fn parse_genl_response_error_rejects_out_of_range_negative_code() {
    let msg = build_nlmsg_error_for_test(2, -(MAX_NETLINK_ERRNO + 1));

    let result = parse_genl_response(&msg, msg.len());
    assert!(matches!(result, Err(NbdCowError::Netlink(_))));
}

#[test]
fn parse_genl_response_error_accepts_max_errno() {
    let msg = build_nlmsg_error_for_test(2, -MAX_NETLINK_ERRNO);

    let result = parse_genl_response(&msg, msg.len());
    assert!(matches!(
        result,
        Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == MAX_NETLINK_ERRNO
    ));
}

#[test]
fn parse_genl_response_too_short() {
    let buf = [0u8; NLMSG_HEADER_LEN - 1];
    let result = parse_genl_response(&buf, buf.len());

    assert!(result.is_err());
}

#[test]
fn parse_genl_response_error_response_truncated() {
    let mut buf = vec![0u8; 4096];
    write_u32_for_test(&mut buf, NLMSG_LEN_OFFSET, 20);
    write_u16_for_test(&mut buf, NLMSG_TYPE_OFFSET, NLMSG_ERROR);

    let result = parse_genl_response(&buf, 18);

    assert!(result.is_err());
}

#[test]
fn parse_genl_response_declared_length_too_short() {
    let mut buf = vec![0u8; NLMSG_HEADER_LEN + U32_LEN + U32_LEN];
    write_u32_for_test(&mut buf, NLMSG_LEN_OFFSET, 15);

    let result = parse_genl_response(&buf, buf.len());

    assert!(result.is_err());
}

#[test]
fn parse_genl_response_error_body_bounded_by_declared_length() {
    let mut buf = build_nlmsg_error_for_test(2, 0);
    write_u32_for_test(&mut buf, NLMSG_LEN_OFFSET, 18);

    let result = parse_genl_response(&buf, buf.len());

    assert!(result.is_err());
}
