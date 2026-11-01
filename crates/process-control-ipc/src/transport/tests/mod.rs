use super::*;
use std::os::fd::AsFd;
use std::os::unix::fs::MetadataExt;

fn bind_test_listener(case: &str) -> (String, UnixListener) {
    let name = format!("vm0-test-{case}-{}", std::process::id());
    let listener = bind_abstract_listener(&name).unwrap();
    (name, listener)
}

fn accept_error_with_watchdog(case: &str, timeout: Duration) -> io::ErrorKind {
    let (_name, listener) = bind_test_listener(case);
    let (result_tx, result_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = accept_with_timeout(&listener, timeout)
            .map(|_| ())
            .map_err(|error| error.kind());
        result_tx.send(result).unwrap();
    });

    let result = result_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("accept should complete within the test watchdog");
    worker.join().expect("accept worker should not panic");
    result.expect_err("accept should not succeed without a client")
}

#[test]
fn endpoint_name_includes_seq_and_nonce() {
    let nonce = *b"0123456789abcdef";
    assert_eq!(
        endpoint_name(7, &nonce),
        "vm0-process-control-7-30313233343536373839616263646566"
    );
}

#[test]
fn endpoint_name_zero_pads_lowercase_nonce_hex() {
    let nonce = [
        0x00, 0x0f, 0x10, 0xff, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x02, 0x03, 0x04,
        0x05,
    ];
    assert_eq!(
        endpoint_name(u32::MAX, &nonce),
        "vm0-process-control-4294967295-000f10ffabcdef012345678902030405"
    );

    let zero_nonce = [0_u8; 16];
    assert_eq!(
        endpoint_name(0, &zero_nonce),
        "vm0-process-control-0-00000000000000000000000000000000"
    );
}

#[test]
fn abstract_socket_rejects_invalid_names() {
    for name in ["", "bad\0name"] {
        let err = bind_abstract_listener(name).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let err = connect_abstract(name).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

        let err = connect_abstract_with_timeout(name, Duration::from_secs(1)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    let too_long = "x".repeat(sockaddr_un_path_len());
    let err = bind_abstract_listener(&too_long).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

    let err = connect_abstract(&too_long).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);

    let err = connect_abstract_with_timeout(&too_long, Duration::from_secs(1)).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn abstract_socket_connects() {
    let (name, listener) = bind_test_listener("connects");
    let client = std::thread::spawn({
        let name = name.clone();
        move || connect_abstract(&name).unwrap()
    });
    let server = accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();
    let _client = client.join().unwrap();
    drop(server);
}

#[test]
fn timed_connect_returns_blocking_close_on_exec_stream_without_io_timeouts() {
    let (name, listener) = bind_test_listener("timed-connect");
    let mut client = connect_abstract_with_timeout(&name, Duration::from_secs(1)).unwrap();
    let mut server = accept_with_timeout(&listener, Duration::from_secs(1)).unwrap();

    assert_eq!(client.read_timeout().unwrap(), None);
    assert_eq!(client.write_timeout().unwrap(), None);
    // SAFETY: both getters only inspect the live client descriptor.
    let descriptor_flags = unsafe { libc::fcntl(client.as_raw_fd(), libc::F_GETFD) };
    let status_flags = unsafe { libc::fcntl(client.as_raw_fd(), libc::F_GETFL) };
    assert!(descriptor_flags >= 0);
    assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
    assert!(status_flags >= 0);
    assert_eq!(status_flags & libc::O_NONBLOCK, 0);

    server
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    client.write_all(b"hello").unwrap();
    let mut received = [0; 5];
    server.read_exact(&mut received).unwrap();
    assert_eq!(&received, b"hello");
}

#[test]
fn timed_connect_rejects_invalid_budgets_and_preserves_connection_errors() {
    let name = format!("vm0-test-missing-connect-{}", std::process::id());
    for (timeout, expected) in [
        (Duration::ZERO, io::ErrorKind::TimedOut),
        (Duration::MAX, io::ErrorKind::InvalidInput),
        (Duration::from_secs(1), io::ErrorKind::ConnectionRefused),
    ] {
        let error = connect_abstract_with_timeout(&name, timeout).unwrap_err();
        assert_eq!(error.kind(), expected);
    }
}

#[test]
fn workload_placement_descriptor_round_trips_close_on_exec() {
    let (sender, receiver) = UnixStream::pair().unwrap();
    let placement = std::fs::File::open("/dev/null").unwrap();
    let expected = placement.metadata().unwrap();
    let send = std::thread::spawn(move || {
        send_workload_placement(&sender, placement.as_fd()).unwrap();
        read_workload_placement_confirmation(&sender).unwrap();
    });

    let received = receive_workload_placement(&receiver).unwrap();
    write_workload_placement_confirmation(&receiver).unwrap();
    send.join().unwrap();
    let received = std::fs::File::from(received);
    let actual = received.metadata().unwrap();
    assert_eq!(actual.dev(), expected.dev());
    assert_eq!(actual.ino(), expected.ino());
    // SAFETY: F_GETFD only inspects the valid received descriptor.
    let flags = unsafe { libc::fcntl(received.as_raw_fd(), libc::F_GETFD) };
    assert!(flags >= 0);
    assert_ne!(flags & libc::FD_CLOEXEC, 0);
}

#[test]
fn workload_placement_confirmation_rejects_wrong_marker() {
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    sender.write_all(&[TOOL_PLACEMENT_ACK_MARKER]).unwrap();

    let error = read_workload_placement_confirmation(&receiver).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn tool_placement_descriptor_and_handshake_round_trip() {
    let (server, client) = UnixStream::pair().unwrap();
    let placement = std::fs::File::open("/dev/null").unwrap();
    let expected = placement.metadata().unwrap();
    let server = std::thread::spawn(move || {
        send_tool_placement(&server, placement.as_fd()).unwrap();
        read_tool_placement_confirmation(&server).unwrap();
        write_tool_placement_ack(&server).unwrap();
    });

    let received = receive_tool_placement(&client).unwrap();
    let actual = std::fs::File::from(received).metadata().unwrap();
    assert_eq!(actual.dev(), expected.dev());
    assert_eq!(actual.ino(), expected.ino());
    write_tool_placement_confirmation(&client).unwrap();
    read_tool_placement_ack(&client).unwrap();
    server.join().unwrap();
}

#[test]
fn workload_placement_descriptor_requires_ancillary_rights() {
    let (mut sender, receiver) = UnixStream::pair().unwrap();
    std::thread::spawn(move || {
        use std::io::Write;
        sender.write_all(&[WORKLOAD_PLACEMENT_MARKER]).unwrap();
    });

    let error = receive_workload_placement(&receiver).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[test]
fn abstract_socket_accept_times_out_without_client() {
    assert_eq!(
        accept_error_with_watchdog("timeout", Duration::from_millis(10)),
        io::ErrorKind::TimedOut
    );
}

#[test]
fn abstract_socket_accept_zero_timeout() {
    assert_eq!(
        accept_error_with_watchdog("zero-timeout", Duration::ZERO),
        io::ErrorKind::TimedOut
    );
}

#[test]
fn abstract_socket_accept_rejects_deadline_overflow() {
    assert_eq!(
        accept_error_with_watchdog("timeout-overflow", Duration::MAX),
        io::ErrorKind::InvalidInput
    );
}
