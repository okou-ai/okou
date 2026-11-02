use super::*;

use nix::fcntl::{FcntlArg, FdFlag, fcntl};

fn raw_nla_header(nla_len: u16, nla_type: u16) -> Vec<u8> {
    let mut attr = Vec::new();
    attr.extend_from_slice(&nla_len.to_ne_bytes());
    attr.extend_from_slice(&nla_type.to_ne_bytes());
    attr
}

fn assert_close_on_exec(fd: &OwnedFd) {
    let flags = fcntl(fd, FcntlArg::F_GETFD).unwrap();
    assert!(FdFlag::from_bits_truncate(flags).contains(FdFlag::FD_CLOEXEC));
}

fn test_connection_id() -> Uuid {
    Uuid::from_u128(1234)
}

#[test]
fn create_socketpair_sets_close_on_exec() {
    let (client_fd, server_fd) = create_socketpair().unwrap();

    assert_close_on_exec(&client_fd);
    assert_close_on_exec(&server_fd);
}

#[test]
fn random_offset_zero_max() {
    assert_eq!(random_offset(0), 0);
}

#[test]
fn random_offset_within_range() {
    for max in [1, 2, 16, 256, 4096] {
        for _ in 0..100 {
            assert!(random_offset(max) < max, "offset >= max for max={max}");
        }
    }
}

#[test]
fn nbds_max_reads_configured_value() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nbds_max");
    std::fs::write(&path, "4096\n").expect("write nbds_max");

    assert_eq!(nbds_max_from_path(&path), 4096);
}

#[test]
fn nbds_max_returns_exact_default_for_missing_or_invalid_value() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nbds_max");

    assert_eq!(nbds_max_from_path(&path), 256);

    std::fs::write(&path, "invalid\n").expect("write invalid nbds_max");
    assert_eq!(nbds_max_from_path(&path), 256);
}

#[test]
fn device_appears_free_accepts_free_pid_values() {
    for contents in ["-1", "0", "", " 0\n"] {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_path = dir.path().join("pid");
        std::fs::write(&pid_path, contents).expect("write pid");

        assert!(
            device_pid_appears_free(&pid_path, || {
                panic!("device path should not be checked when pid is readable")
            }),
            "pid contents {contents:?} should be free"
        );
    }
}

#[test]
fn device_appears_free_rejects_busy_pid_value() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pid_path = dir.path().join("pid");
    std::fs::write(&pid_path, "1234\n").expect("write pid");

    assert!(!device_pid_appears_free(&pid_path, || {
        panic!("device path should not be checked when pid is readable")
    }));
}

#[test]
fn device_appears_free_falls_back_to_device_path_when_pid_is_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pid_path = dir.path().join("pid");
    let device_path = dir.path().join("nbd0");
    std::fs::write(&device_path, b"").expect("create device placeholder");

    assert!(device_pid_appears_free(&pid_path, || device_path.exists()));
}

#[test]
fn device_appears_free_rejects_missing_pid_without_device_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pid_path = dir.path().join("pid");
    let device_path = dir.path().join("nbd0");

    assert!(!device_pid_appears_free(&pid_path, || device_path.exists()));
}

#[test]
fn device_appears_free_rejects_unreadable_pid_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pid_path = dir.path().join("pid");
    std::fs::create_dir(&pid_path).expect("create pid directory");

    assert!(!device_pid_appears_free(&pid_path, || {
        panic!("device path should not be checked when pid read fails")
    }));
}

#[test]
fn parse_genl_completion_accepts_reply() {
    let msg = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 44, false);
    let result = parse_genl_completion(&msg, msg.len());

    assert!(result.is_ok());
}

#[test]
fn resolve_nbd_family_reads_family_id_attr() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let attrs = wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes());
    let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert_eq!(result.unwrap(), 123);
}

#[test]
fn resolve_nbd_family_skips_padded_non_target_attr_before_family_id() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let mut attrs = wire::build_nla(999, &[0x01]);
    attrs.extend_from_slice(&wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes()));
    let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert_eq!(result.unwrap(), 123);
}

#[test]
fn resolve_nbd_family_ignores_family_id_after_declared_length() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let mut reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &[], 1, false);
    reply.extend_from_slice(&wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes()));
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert!(
        matches!(result, Err(NbdCowError::Netlink(message)) if message == "NBD family ID not found in response")
    );
}

#[test]
fn resolve_nbd_family_rejects_short_non_target_attr_before_family_id() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let mut attrs = raw_nla_header(3, 999);
    attrs.extend_from_slice(&wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes()));
    let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert!(
        matches!(result, Err(NbdCowError::Netlink(message)) if message == "invalid nla length")
    );
}

#[test]
fn resolve_nbd_family_rejects_overlong_non_target_attr_before_family_id() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let mut attrs = raw_nla_header(128, 999);
    attrs.extend_from_slice(&wire::build_nla(CTRL_ATTR_FAMILY_ID, &123u16.to_ne_bytes()));
    let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert!(matches!(result, Err(NbdCowError::Netlink(message)) if message == "truncated nla"));
}

#[test]
fn resolve_nbd_family_rejects_truncated_family_id_payload() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let attrs = wire::build_nla(CTRL_ATTR_FAMILY_ID, &[0x7b]);
    let reply = wire::build_genl_msg(GENL_ID_CTRL, CTRL_CMD_GETFAMILY, 1, &attrs, 1, false);
    socket::send_test_nl(&peer, &reply);

    let result = resolve_nbd_family(&sock);

    assert!(
        matches!(result, Err(NbdCowError::Netlink(message)) if message == "truncated family id")
    );
}

#[test]
fn resolve_nbd_family_rejects_ack() {
    let (sock, peer) = socket::test_genl_socket_pair();
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, 0));

    let result = resolve_nbd_family(&sock);

    assert!(
        matches!(result, Err(NbdCowError::Netlink(message)) if message == "unexpected ACK while resolving NBD family")
    );
}

#[test]
fn validate_connect_socket_count_accepts_max_nla_payload() {
    let socket_item_len = sockets_payload_len(1).unwrap();
    let max_socket_count = wire::MAX_NLA_PAYLOAD_LEN / socket_item_len;

    assert_eq!(
        validate_connect_socket_count(max_socket_count).unwrap(),
        max_socket_count * socket_item_len
    );
}

#[test]
fn validate_connect_socket_count_rejects_oversized_as_not_sent() {
    let socket_item_len = sockets_payload_len(1).unwrap();
    let max_socket_count = wire::MAX_NLA_PAYLOAD_LEN / socket_item_len;

    let result = validate_connect_socket_count(max_socket_count + 1);

    assert!(matches!(
        result,
        Err(ConnectDeviceError::NotSent {
            source: NbdCowError::Netlink(message),
        }) if message == "NBD socket list too large"
    ));
}

#[test]
fn finish_connect_after_send_success_returns_connection_id() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
    socket::send_test_nl(&peer, &reply);

    let connection_id = test_connection_id();
    let result = finish_connect_after_send(&sock, 2, connection_id);

    assert_eq!(result.unwrap().connection_id, connection_id);
}

#[test]
fn finish_connect_after_send_errno_is_definite_failure() {
    let (sock, peer) = socket::test_genl_socket_pair();
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

    let result = finish_connect_after_send(&sock, 2, test_connection_id());

    assert!(matches!(
        result,
        Err(ConnectDeviceError::DefiniteAfterSend {
            source: NbdCowError::NetlinkErrno { errno, .. },
        }) if errno == libc::EBUSY
    ));
}

#[test]
fn finish_connect_after_send_non_ebusy_errno_is_definite_failure() {
    let (sock, peer) = socket::test_genl_socket_pair();
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EINVAL));

    let result = finish_connect_after_send(&sock, 2, test_connection_id());

    assert!(matches!(
        result,
        Err(ConnectDeviceError::DefiniteAfterSend {
            source: NbdCowError::NetlinkErrno { errno, .. },
        }) if errno == libc::EINVAL
    ));
}

#[test]
fn finish_connect_after_send_ignores_stale_error_before_success() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
    socket::send_test_nl(&peer, &reply);

    let connection_id = test_connection_id();
    let result = finish_connect_after_send(&sock, 2, connection_id);

    assert_eq!(result.unwrap().connection_id, connection_id);
}

#[test]
fn classify_connect_completion_io_error_is_ambiguous() {
    let result = classify_connect_completion(
        test_connection_id(),
        Err(NbdCowError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "completion timed out",
        ))),
    );

    assert!(matches!(
        result,
        Err(ConnectDeviceError::AmbiguousAfterSend {
            connection_id,
            ..
        }) if connection_id == test_connection_id()
    ));
}

#[test]
fn finish_connect_after_send_malformed_matching_completion_is_ambiguous() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let mut malformed = wire::build_nlmsg_error_for_test(2, 0);
    wire::set_nlmsg_len_for_test(&mut malformed, 15);
    socket::send_test_nl(&peer, &malformed);

    let result = finish_connect_after_send(&sock, 2, test_connection_id());

    assert!(matches!(
        result,
        Err(ConnectDeviceError::AmbiguousAfterSend {
            connection_id,
            ..
        }) if connection_id == test_connection_id()
    ));
}

#[test]
fn recv_genl_completion_ignores_stale_sequence() {
    let (sock, peer) = socket::test_genl_socket_pair();
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, 0));
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

    let result = recv_genl_completion(&sock, 2);

    assert!(matches!(
        result,
        Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
    ));
}

#[test]
fn recv_genl_completion_ignores_stale_error_sequence() {
    let (sock, peer) = socket::test_genl_socket_pair();
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, 0));

    let result = recv_genl_completion(&sock, 2);

    assert!(result.is_ok());
}

#[test]
fn recv_genl_completion_accepts_reply_after_stale_error_sequence() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 2, false);
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(1, -libc::EBUSY));
    socket::send_test_nl(&peer, &reply);

    let result = recv_genl_completion(&sock, 2);

    assert!(result.is_ok());
}

#[test]
fn recv_genl_completion_ignores_stale_reply_sequence() {
    let (sock, peer) = socket::test_genl_socket_pair();
    let stale_reply = wire::build_genl_msg(0x19, NBD_CMD_CONNECT, NBD_GENL_VERSION, &[], 1, false);
    socket::send_test_nl(&peer, &stale_reply);
    socket::send_test_nl(&peer, &wire::build_nlmsg_error_for_test(2, -libc::EBUSY));

    let result = recv_genl_completion(&sock, 2);

    assert!(matches!(
        result,
        Err(NbdCowError::NetlinkErrno { errno, .. }) if errno == libc::EBUSY
    ));
}
