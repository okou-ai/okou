use super::*;

use crate::control::protocol::MAX_FRAME_PAYLOAD_SIZE;

async fn expect_closed(stream: &mut UnixStream, within: Duration) {
    let result = tokio::time::timeout(within, stream.read_u8())
        .await
        .expect("server should close the connection before the deadline");
    let error = result.expect_err("rejected/incomplete requests must not receive a response");
    assert!(
        matches!(
            error.kind(),
            io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
        ),
        "unexpected socket error: {error}"
    );
}

async fn expect_terminate_available(sock_path: &Path) {
    assert_eq!(
        send_terminate(
            sock_path,
            &TerminateRequest {
                action: TerminateAction::Terminate,
                expected_run_id: None,
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap(),
        TerminateResponse::Status {
            status: TerminateStatus::AlreadyStopped,
        }
    );
}

/// Writing more than the socket's send buffer proves that the real server has
/// consumed body bytes, rather than merely queueing the connection or prefix.
async fn partial_body(sock_path: &Path, declared_len: u32) -> UnixStream {
    let mut stream = UnixStream::connect(sock_path).await.unwrap();
    stream.write_u32(declared_len).await.unwrap();
    let body = vec![b' '; 1024 * 1024];
    tokio::time::timeout(Duration::from_secs(1), stream.write_all(&body))
        .await
        .unwrap()
        .unwrap();
    stream
}

#[tokio::test]
async fn incomplete_headers_and_bodies_expire() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let mut streams = Vec::new();
    for prefix_and_body in [
        Vec::new(),
        vec![0, 0],
        vec![0, 0, 4, 0],
        vec![0, 0, 4, 0, b'{'],
    ] {
        let mut stream = UnixStream::connect(&fixture.sock_path).await.unwrap();
        stream.write_all(&prefix_and_body).await.unwrap();
        streams.push(stream);
    }
    // The listener assigns each deadline before spawning its handler. A later
    // request's response proves all earlier FIFO connections were accepted.
    expect_terminate_available(&fixture.sock_path).await;
    let closed = futures_util::future::join_all(
        streams
            .iter_mut()
            .map(|stream| expect_closed(stream, Duration::from_secs(6))),
    );
    tokio::pin!(closed);
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    // Arm the unchanged six-second observers first, then expire only the
    // server's five-second receive timers. Resume before any real socket I/O.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::time::resume();
    closed.await;
    expect_terminate_available(&fixture.sock_path).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn receive_deadline_spans_header_and_body() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let stream = UnixStream::connect(&fixture.sock_path).await.unwrap();
    let (mut reader, mut writer) = stream.into_split();
    writer.write_all(&[0, 0]).await.unwrap();
    expect_terminate_available(&fixture.sock_path).await;
    let receive = async {
        let error = tokio::time::timeout(Duration::from_secs(6), reader.read_u8())
            .await
            .expect("body progress must not restart the receive deadline")
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    };
    tokio::pin!(receive);
    assert!(futures_util::poll!(receive.as_mut()).is_pending());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
    tokio::time::resume();
    writer.write_all(&[4, 0, b'{']).await.unwrap();
    expect_terminate_available(&fixture.sock_path).await;
    assert!(
        futures_util::poll!(receive.as_mut()).is_pending(),
        "the incomplete request must stay open before its receive deadline"
    );
    // Keep the observer armed from the header phase: restarting the server's
    // deadline after body progress must still miss the six-second bound.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    receive.await;
    expect_terminate_available(&fixture.sock_path).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn connection_limit_rejects_excess_and_recovers_after_eof() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let mut streams = Vec::new();
    for _ in 0..32 {
        streams.push(UnixStream::connect(&fixture.sock_path).await.unwrap());
    }
    let mut excess = UnixStream::connect(&fixture.sock_path).await.unwrap();
    expect_closed(&mut excess, Duration::from_secs(1)).await;

    for stream in &streams {
        assert_eq!(
            stream.try_read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock,
            "admitted incomplete connections should remain open before timeout"
        );
    }

    let mut released = streams.pop().unwrap();
    released.shutdown().await.unwrap();
    expect_closed(&mut released, Duration::from_secs(1)).await;
    expect_terminate_available(&fixture.sock_path).await;
    handle.shutdown().await;
    for mut stream in streams {
        expect_closed(&mut stream, Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn aggregate_byte_limit_rejects_before_body_and_recovers_after_eof() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let mut first = partial_body(&fixture.sock_path, MAX_FRAME_PAYLOAD_SIZE / 2).await;
    let mut second = partial_body(&fixture.sock_path, MAX_FRAME_PAYLOAD_SIZE / 2).await;
    let mut excess = UnixStream::connect(&fixture.sock_path).await.unwrap();
    excess.write_u32(1).await.unwrap();
    expect_closed(&mut excess, Duration::from_secs(1)).await;

    first.shutdown().await.unwrap();
    expect_closed(&mut first, Duration::from_secs(1)).await;
    expect_terminate_available(&fixture.sock_path).await;
    handle.shutdown().await;
    expect_closed(&mut second, Duration::from_secs(1)).await;
}

#[tokio::test]
async fn maximum_frame_expires_and_releases_entire_byte_budget() {
    let fixture = ControlServerFixture::new();
    let mut handle = fixture.spawn_default(CancellationToken::new());
    let mut stream = partial_body(&fixture.sock_path, MAX_FRAME_PAYLOAD_SIZE).await;
    // partial_body proves the handler consumed real bytes and armed its timer.
    let closed = expect_closed(&mut stream, Duration::from_secs(6));
    tokio::pin!(closed);
    assert!(futures_util::poll!(closed.as_mut()).is_pending());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::time::resume();
    closed.await;

    let mut replacement = partial_body(&fixture.sock_path, MAX_FRAME_PAYLOAD_SIZE).await;
    handle.shutdown().await;
    expect_closed(&mut replacement, Duration::from_secs(1)).await;
}

#[tokio::test]
async fn complete_frame_releases_budget_before_exec() {
    let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
    let fixture = VsockExecFixture::connect(|vsock_base| {
        mock_guest_holds_first_exec_and_completes_second(vsock_base, exec_seen_tx)
    })
    .await;
    let mut handle = fixture.spawn_server();
    let mut pending = partial_body(&fixture.sock_path, MAX_FRAME_PAYLOAD_SIZE - 1024).await;
    let mut first = UnixStream::connect(&fixture.sock_path).await.unwrap();
    let mut request = exec_request("hold-first");
    request.timeout_secs = 30;
    let mut frame = serde_json::to_vec(&request).unwrap();
    // Fill the remaining budget without coupling this test to a 64 MiB transfer.
    frame.resize(1024, b' ');
    tokio::time::timeout(Duration::from_secs(1), write_frame(&mut first, &frame))
        .await
        .unwrap()
        .unwrap();
    drop(frame);
    tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
        .await
        .unwrap()
        .unwrap();

    let second = send_exec(
        &fixture.sock_path,
        &exec_request("complete-second"),
        Duration::from_secs(1),
    )
    .await
    .expect("an executing request must release its receive-byte admission");
    let (termination, stdout, ..) = expect_exec_success(second);
    assert_eq!(termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout, b"second");
    assert_eq!(
        pending.try_read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "the incomplete frame must still occupy the rest of the byte budget"
    );
    assert_eq!(
        first.try_read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "the first exec must still be in flight when the second completes"
    );

    handle.shutdown().await;
    expect_closed(&mut first, Duration::from_secs(1)).await;
    expect_closed(&mut pending, Duration::from_secs(1)).await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn receive_deadline_does_not_cancel_admitted_exec() {
    let (exec_seen_tx, exec_seen_rx) = oneshot::channel();
    let fixture = VsockExecFixture::connect(|vsock_base| {
        mock_guest_holds_first_exec_and_completes_second(vsock_base, exec_seen_tx)
    })
    .await;
    let mut handle = fixture.spawn_server();
    let mut first = UnixStream::connect(&fixture.sock_path).await.unwrap();
    let mut request = exec_request("hold-first");
    request.timeout_secs = 30;
    write_frame(&mut first, &serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), exec_seen_rx)
        .await
        .unwrap()
        .unwrap();

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::time::resume();
    let second = send_exec(
        &fixture.sock_path,
        &exec_request("complete-second"),
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    let (termination, stdout, ..) = expect_exec_success(second);
    assert_eq!(termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout, b"second");
    assert_eq!(
        first.try_read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "the receive deadline must not cancel an admitted exec"
    );

    handle.shutdown().await;
    expect_closed(&mut first, Duration::from_secs(1)).await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}
