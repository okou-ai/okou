use super::*;

use nix::fcntl::{FcntlArg, FdFlag, fcntl};

fn assert_close_on_exec(fd: &OwnedFd) {
    let flags = fcntl(fd, FcntlArg::F_GETFD).unwrap();
    assert!(FdFlag::from_bits_truncate(flags).contains(FdFlag::FD_CLOEXEC));
}

#[test]
fn open_genl_socket_sets_close_on_exec() {
    let sock = open_genl_socket().unwrap();

    assert_close_on_exec(&sock.fd);
}

#[test]
fn next_seq_wraps_without_returning_zero() {
    let (sock, _peer) = test_genl_socket_pair();
    sock.next_seq.set(u32::MAX);

    assert_eq!(sock.next_seq(), u32::MAX);
    assert_eq!(sock.next_seq(), 1);
}

#[test]
fn recv_for_seq_ignores_stale_family_reply() {
    let (sock, peer) = test_genl_socket_pair();
    let expected_seq = 42;

    let stale_attrs = wire::build_nla(1, &999u16.to_ne_bytes());
    let stale_reply = wire::build_genl_msg(0x10, 3, 1, &stale_attrs, expected_seq + 1, false);
    let matching_attrs = wire::build_nla(1, &123u16.to_ne_bytes());
    let matching_reply = wire::build_genl_msg(0x10, 3, 1, &matching_attrs, expected_seq, false);

    send_test_nl(&peer, &stale_reply);
    send_test_nl(&peer, &matching_reply);

    let mut buf = vec![0u8; 4096];
    let n = recv_for_seq(&sock, &mut buf, expected_seq).unwrap();
    assert!(matches!(
        wire::parse_genl_response(&buf, n),
        Ok(wire::GenlResponse::Reply { .. })
    ));
    assert_eq!(wire::parse_nl_header(&buf, n).unwrap().seq, expected_seq);
}

#[test]
fn recv_for_seq_ignores_stale_malformed_payload_after_header_parse() {
    let (sock, peer) = test_genl_socket_pair();
    let mut stale = wire::build_nlmsg_error_for_test(1, -libc::EBUSY);
    wire::set_nlmsg_len_for_test(&mut stale, 15);
    let matching = wire::build_nlmsg_error_for_test(2, 0);

    send_test_nl(&peer, &stale);
    send_test_nl(&peer, &matching);

    let mut buf = vec![0u8; 4096];
    let n = recv_for_seq(&sock, &mut buf, 2).unwrap();
    assert_eq!(wire::parse_nl_header(&buf, n).unwrap().seq, 2);
}
