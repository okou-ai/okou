use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{ExecTermination, MSG_ERROR, MSG_EXEC_START};
use tokio::io::AsyncWriteExt;

use guest_contracts::session_history_identity::{
    SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
    SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES, SessionHistoryIdentityVerifyRequest,
};

use super::super::support::{
    MockGuest, await_mock_guest, captured_output_bytes, exec_capture_default, host_from_stream,
    make_pair, normal_operation_readiness, operation_count, read_guest_message, send_exec_result,
    set_next_route_id, setup_host_and_guest, wait_for_operation_count,
};
use super::start_capture_operation;
use crate::SessionHistoryIdentityVerifyRequest as HostSessionHistoryIdentityVerifyRequest;
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn test_exec() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let msg = guest.expect_message(MSG_EXEC_START).await;

        let d = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
        assert_eq!(d.command, "echo hello");
        assert_eq!(
            d.timeout,
            guest_control_proto::ExecTimeoutPolicy::Duration { timeout_ms: 5000 }
        );
        assert_eq!(
            d.lifecycle,
            guest_control_proto::ExecLifecyclePolicy::OneShot
        );
        assert_eq!(d.role, guest_control_proto::ExecProcessRole::Workload);
        assert_eq!(d.control, guest_control_proto::ExecControlPolicy::Disabled);
        assert!(d.env.is_empty());
        assert!(!d.sudo);
        assert_eq!(d.label, "exec");

        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"hello\n",
                b"",
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = exec_capture_default(&host, "echo hello", 5000, &[], false)
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(captured_output_bytes(&result.stdout), b"hello\n");
    assert!(captured_output_bytes(&result.stderr).is_empty());
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn session_history_identity_verifier_encodes_fixed_process_contract() {
    let (host_stream, guest) = make_pair();
    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        let msg = guest.expect_message(MSG_EXEC_START).await;
        let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();

        assert_eq!(
            decoded.role,
            guest_control_proto::ExecProcessRole::SessionHistoryIdentityVerifier
        );
        assert_eq!(
            decoded.lifecycle,
            guest_control_proto::ExecLifecyclePolicy::OneShot
        );
        assert_eq!(
            decoded.control,
            guest_control_proto::ExecControlPolicy::Disabled
        );
        assert!(decoded.env.is_empty());
        assert!(!decoded.sudo);
        assert!(decoded.stdin_bytes.is_none());
        assert!(decoded.expected_exit_codes.is_empty());
        assert_eq!(
            decoded.label,
            SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL
        );
        assert_eq!(
            decoded.stdout,
            guest_control_proto::ExecOutputPolicy::Capture {
                limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
            }
        );
        assert_eq!(decoded.stdout, decoded.stderr);
        let request: SessionHistoryIdentityVerifyRequest =
            serde_json::from_str(decoded.command).unwrap();
        assert_eq!(request.metadata_path, "/runtime/final.json");
        assert_eq!(request.runtime_dir, "/runtime");
        assert_eq!(request.expectation.framework.as_str(), "claude-code");
        assert_eq!(request.expectation.session_id_hash, "a".repeat(64));
        assert_eq!(request.expectation.history_ref_kind.as_str(), "blob");
        assert_eq!(request.expectation.history_hash, "b".repeat(64));
        assert_eq!(request.expectation.history_size_bytes, 42);

        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 8 },
                b"",
                b"mismatch",
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host
        .verify_session_history_identity(HostSessionHistoryIdentityVerifyRequest {
            metadata_path: "/runtime/final.json",
            runtime_dir: "/runtime",
            framework: "claude-code",
            session_id_hash: &"a".repeat(64),
            history_ref_kind: "blob",
            history_hash: &"b".repeat(64),
            history_size_bytes: 42,
            timeout_ms: 5000,
            wait_timeout: Duration::from_secs(5),
        })
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 8 });
    assert_eq!(captured_output_bytes(&result.stderr), b"mismatch");
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn exec_operation_tracks_until_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(
            async move { exec_capture_default(&host, "echo tracked", 5000, &[], false).await },
        )
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"tracked\n",
        b"",
    )
    .await;

    let result = exec_task.await.unwrap().unwrap();
    assert_eq!(captured_output_bytes(&result.stdout), b"tracked\n");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn stale_exec_handle_cleanup_does_not_remove_reused_wire_sequence() {
    let (host, mut guest) = setup_host_and_guest().await;
    let wire_seq = 23;
    set_next_route_id(&host, wire_seq.into());

    let first_handle = start_capture_operation(&host, "first generation").await;
    let first_start = read_guest_message(&mut guest).await;
    assert_eq!(first_start.msg_type, MSG_EXEC_START);
    assert_eq!(first_start.seq, wire_seq);
    send_exec_result(
        &mut guest,
        first_start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"first",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    set_next_route_id(&host, (1_u64 << 32) + u64::from(wire_seq));
    let second_handle = start_capture_operation(&host, "second generation").await;
    let second_start = read_guest_message(&mut guest).await;
    assert_eq!(second_start.msg_type, MSG_EXEC_START);
    assert_eq!(second_start.seq, first_start.seq);

    drop(first_handle);
    assert_eq!(operation_count(&host), 1);
    send_exec_result(
        &mut guest,
        second_start.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"second",
        b"",
    )
    .await;
    let result = second_handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(captured_output_bytes(&result.stdout), b"second");
}

/// `host.exec` with `timeout_ms == 0` must reject at the boundary rather
/// than send the request to the guest — an unbounded exec would leak a
/// guest-side orphan when the host's outer timeout fires.
#[tokio::test]
async fn test_exec_rejects_zero_timeout() {
    let (host, _guest) = setup_host_and_guest().await;

    let err = exec_capture_default(&host, "echo hi", 0, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn test_exec_error_response() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let msg = guest.expect_message(MSG_EXEC_START).await;
        guest
            .send_error_response(msg.seq, "command not found")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = exec_capture_default(&host, "badcmd", 5000, &[], false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("command not found"));
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn exec_operation_error_response_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { exec_capture_default(&host, "badcmd", 5000, &[], false).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = guest_control_proto::encode_error("command not found");
    let resp = guest_control_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
    guest.write_all(&resp).await.unwrap();

    let err = exec_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("command not found"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn dropping_exec_handle_after_start_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "drop-after-start").await;
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(handle);
    wait_for_operation_count(&host, 0).await;

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = host
        .exec_operation_capture_default(
            "blocked-after-drop",
            5000,
            &[],
            false,
            "exec",
            std::time::Duration::from_secs(10),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}
