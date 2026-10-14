use super::*;
use guest_control_proto::{MSG_WRITE_FILE, MSG_WRITE_FILE_STREAM_BEGIN};
use sandbox::{FileCompression, OperationCancellationContext};

#[tokio::test]
async fn stop_after_owned_transfer_cancellation_is_quiet_and_confirms_process_exit() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut peer = attach_mock_shutdown_guest(&sandbox).await;
    let guest = sandbox.guest.lock().await.as_ref().cloned().unwrap();
    let connection_id = guest.connection_id().to_string();
    let owner = OperationCancellationContext::new("cancelled-run", sandbox.id(), "history_restore");
    let mut write = Box::pin(owner.scope(guest.write_file_with_compression(
        "/tmp/history",
        b"history",
        false,
        FileCompression::Zstd,
    )));
    tokio::select! {
        result = &mut write => panic!("write completed before transfer admission: {result:?}"),
        begin = read_vsock_message(&mut peer) => assert_eq!(begin.msg_type, MSG_WRITE_FILE_STREAM_BEGIN),
    }
    let child = tokio::process::Command::new("cat")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let process = monitor_process(
        &sandbox.id,
        child.into(),
        Arc::clone(&sandbox.state),
        Arc::clone(&sandbox.state_publish_lock),
        sandbox.state_tx.clone(),
        Arc::clone(&sandbox.guest),
        CancellationToken::new(),
    );
    sandbox.runtime.set_process(process);
    let (result, events) = capture_async_log_events(async {
        owner.mark_cancelled();
        drop(write);
        let mut byte = [0u8; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), peer.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        sandbox.stop().await
    })
    .await;
    result.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(
        sandbox.terminate_process_for_cleanup().await,
        "exit must be physically confirmed"
    );
    assert!(!pid_is_running(pid));
    assert!(!has_captured_event(&events, "graceful shutdown failed"));
    let closed = captured_event(
        &events,
        "closing guest-control connection after owner cancellation",
    );
    let skipped = captured_event(
        &events,
        "graceful shutdown skipped for cancelled guest connection",
    );
    assert_eq!(closed.level, Level::INFO);
    assert_eq!(skipped.level, Level::INFO);
    for event in [closed, skipped] {
        assert_event_field(event, "connection_id", &connection_id);
        assert_event_field(event, "run_id", "cancelled-run");
        assert_event_field(event, "close_origin", "file_transfer_abandoned");
    }
}

#[tokio::test]
async fn stop_keeps_warning_for_unattributed_pre_existing_close() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let peer = attach_mock_shutdown_guest(&sandbox).await;
    let guest = sandbox.guest.lock().await.as_ref().cloned().unwrap();
    drop(peer);
    // Observe the peer failure through a real request; its transport is now Closed.
    guest.shutdown(Duration::from_secs(5)).await.unwrap_err();
    let (result, events) = capture_async_log_events(sandbox.stop()).await;
    result.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    let event = assert_shutdown_failure_event(&events, sandbox.id(), "already_closed_at_admission");
    assert_eq!(event.level, Level::WARN);
    assert_event_field(event, "connection_id", &guest.connection_id().to_string());
    assert!(!has_captured_event(
        &events,
        "graceful shutdown skipped for cancelled guest connection"
    ));
}

#[tokio::test]
async fn stop_still_sends_shutdown_after_an_open_unparkable_write() {
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    let mut peer = attach_mock_shutdown_guest(&sandbox).await;
    let guest = sandbox.guest.lock().await.as_ref().cloned().unwrap();
    let mut write = Box::pin(guest.write_file("/tmp/history", b"history", false));
    tokio::select! {
        result = &mut write => panic!("write completed without a response: {result:?}"),
        frame = read_vsock_message(&mut peer) => assert_eq!(frame.msg_type, MSG_WRITE_FILE),
    }
    // The complete frame is safe on the wire, while its result is unproven.
    drop(write);
    let response = async {
        let request = read_vsock_message(&mut peer).await;
        assert_eq!(request.msg_type, MSG_SHUTDOWN);
        let ack = guest_control_proto::encode(MSG_SHUTDOWN_ACK, request.seq, &[]).unwrap();
        peer.write_all(&ack).await.unwrap();
    };
    let ((result, events), ()) = tokio::join!(capture_async_log_events(sandbox.stop()), response);
    result.unwrap();
    assert_eq!(sandbox.current_state(), SandboxState::Stopped);
    assert!(!has_captured_event(&events, "graceful shutdown failed"));
    assert!(!has_captured_event(
        &events,
        "graceful shutdown skipped for cancelled guest connection"
    ));
}
