use super::*;

use crate::control::protocol::write_frame;

const OUTPUT_LEN: usize = 1024 * 1024;

async fn response_fixture() -> (
    VsockExecFixture,
    mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) {
    let (exec_tx, exec_rx) = mpsc::unbounded_channel();
    let fixture =
        VsockExecFixture::connect(move |vsock_base| mock_guest_responses(vsock_base, exec_tx))
            .await;
    (fixture, exec_rx)
}

async fn mock_guest_responses(
    vsock_base: PathBuf,
    exec_tx: mpsc::UnboundedSender<oneshot::Sender<()>>,
) {
    let listener_path = PathBuf::from(format!(
        "{}_{}",
        vsock_base.display(),
        guest_control_proto::VSOCK_PORT
    ));
    wait_for_socket_exists(&listener_path).await;
    let mut stream = UnixStream::connect(&listener_path).await.unwrap();
    let mut decoder = Decoder::new();
    mock_vsock_handshake(&mut stream, &mut decoder).await;
    let stdout = vec![b'o'; OUTPUT_LEN];
    let stderr = vec![b'e'; OUTPUT_LEN];
    let mut frame = Vec::new();

    loop {
        let message = read_vsock_message(&mut stream, &mut decoder).await;
        if message.msg_type != MSG_EXEC_START {
            continue;
        }
        let (complete_tx, complete_rx) = oneshot::channel();
        exec_tx.send(complete_tx).unwrap();
        complete_rx.await.unwrap();
        frame.clear();
        guest_control_proto::encode_exec_result_frame_into(
            &mut frame,
            message.seq,
            guest_control_proto::ExecTermination::Exited { exit_code: 0 },
            10,
            ExecCapturedOutput::Captured {
                bytes: &stdout,
                truncated: false,
            },
            ExecCapturedOutput::Captured {
                bytes: &stderr,
                truncated: false,
            },
            "",
        )
        .unwrap();
        stream.write_all(&frame).await.unwrap();
    }
}

async fn complete_next_exec(exec_rx: &mut mpsc::UnboundedReceiver<oneshot::Sender<()>>) {
    tokio::time::timeout(Duration::from_secs(1), exec_rx.recv())
        .await
        .unwrap()
        .unwrap()
        .send(())
        .unwrap();
}

async fn stalled_response(
    sock_path: &Path,
    exec_rx: &mut mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) -> (UnixStream, usize) {
    let mut stream = UnixStream::connect(sock_path).await.unwrap();
    write_frame(
        &mut stream,
        &serde_json::to_vec(&exec_request("produce-output")).unwrap(),
    )
    .await
    .unwrap();
    complete_next_exec(exec_rx).await;
    // Receiving the prefix proves execution finished and the real server is
    // writing its response. Leave the payload larger than socket buffering unread.
    let len = tokio::time::timeout(Duration::from_secs(1), stream.read_u32())
        .await
        .unwrap()
        .unwrap() as usize;
    assert!(len > 2 * OUTPUT_LEN);
    (stream, len)
}

async fn expect_incomplete_response(stream: &mut UnixStream, remaining: usize) {
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut bytes))
        .await
        .expect("server must close the stalled response")
        .unwrap();
    assert!(
        bytes.len() < remaining,
        "the response must have expired before the peer resumed reading"
    );
}

async fn elapse_response_time(duration: Duration) {
    tokio::time::pause();
    // A paused-clock sleep lets the timer driver process due deadlines before
    // real socket I/O resumes; advance alone does not provide that guarantee.
    tokio::time::sleep(duration).await;
    tokio::time::resume();
}

#[tokio::test]
async fn stalled_responses_expire_and_restore_exec_and_terminate_admission() {
    let (fixture, mut exec_rx) = response_fixture().await;
    let (kill_tx, mut kill_rx) = mpsc::channel(1);
    let mut handle = bind_server(
        fixture.sock_path.clone(),
        fixture.gate.clone(),
        ProcessTerminationHandle::with_park_coordinator(kill_tx, fixture.coordinator.clone()),
    )
    .unwrap()
    .spawn(CancellationToken::new());

    let mut stalled = Vec::new();
    for _ in 0..32 {
        stalled.push(stalled_response(&fixture.sock_path, &mut exec_rx).await);
    }
    let mut excess = UnixStream::connect(&fixture.sock_path).await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), excess.read_u8())
        .await
        .expect("all connection slots must be occupied by stalled responses")
        .unwrap_err();
    assert!(matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
    ));

    // Keep all peers connected and unread through the server's five-second
    // deadline. A missing timer would complete every frame when drained below.
    elapse_response_time(Duration::from_secs(5)).await;
    for (stream, len) in &mut stalled {
        expect_incomplete_response(stream, *len).await;
    }

    let request = exec_request("after-expiry");
    let (response, ()) = tokio::join!(
        send_exec(&fixture.sock_path, &request, Duration::from_secs(1)),
        complete_next_exec(&mut exec_rx),
    );
    let (termination, stdout, stderr, ..) = expect_exec_success(response.unwrap());
    assert_eq!(termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout, vec![b'o'; OUTPUT_LEN]);
    assert_eq!(stderr, vec![b'e'; OUTPUT_LEN]);

    let request = TerminateRequest {
        action: TerminateAction::Terminate,
        expected_run_id: None,
    };
    let (response, ()) = tokio::join!(
        send_terminate(&fixture.sock_path, &request, Duration::from_secs(1)),
        async {
            tokio::time::timeout(Duration::from_secs(1), kill_rx.recv())
                .await
                .unwrap()
                .unwrap()
                .acknowledge();
        },
    );
    assert_eq!(
        response.unwrap(),
        TerminateResponse::Status {
            status: TerminateStatus::Accepted,
        }
    );

    handle.shutdown().await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn response_write_progress_does_not_restart_deadline() {
    let (fixture, mut exec_rx) = response_fixture().await;
    let mut handle = fixture.spawn_server();
    let (mut stream, len) = stalled_response(&fixture.sock_path, &mut exec_rx).await;

    elapse_response_time(Duration::from_secs(3)).await;
    // Consume more than the initial socket buffer so the writer must make new
    // progress, but leave most of the response blocked before the original deadline.
    let mut progress = vec![0; OUTPUT_LEN / 2];
    tokio::time::timeout(Duration::from_secs(1), stream.read_exact(&mut progress))
        .await
        .unwrap()
        .unwrap();
    elapse_response_time(Duration::from_secs(2)).await;
    expect_incomplete_response(&mut stream, len - progress.len()).await;

    handle.shutdown().await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn response_deadline_starts_after_guest_execution() {
    let (fixture, mut exec_rx) = response_fixture().await;
    let mut handle = fixture.spawn_server();
    let client = tokio::spawn({
        let sock_path = fixture.sock_path.clone();
        async move {
            let mut request = exec_request("long-running-output");
            request.timeout_secs = 30;
            send_exec(&sock_path, &request, Duration::from_secs(40)).await
        }
    });
    let complete = tokio::time::timeout(Duration::from_secs(1), exec_rx.recv())
        .await
        .unwrap()
        .unwrap();
    elapse_response_time(Duration::from_secs(6)).await;
    assert!(!client.is_finished());
    complete.send(()).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(1), client)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (termination, stdout, stderr, ..) = expect_exec_success(response);
    assert_eq!(termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout, vec![b'o'; OUTPUT_LEN]);
    assert_eq!(stderr, vec![b'e'; OUTPUT_LEN]);

    handle.shutdown().await;
    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}

#[tokio::test]
async fn shutdown_cancels_stalled_response_without_waiting_for_deadline() {
    let (fixture, mut exec_rx) = response_fixture().await;
    let mut handle = fixture.spawn_server();
    let (mut stream, len) = stalled_response(&fixture.sock_path, &mut exec_rx).await;
    tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
        .await
        .unwrap();
    expect_incomplete_response(&mut stream, len).await;

    fixture.guest_task.abort();
    let _ = fixture.guest_task.await;
}
