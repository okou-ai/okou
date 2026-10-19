use std::io;
mod cancellation;
mod deadline;
mod timing;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    ExecTermination, MSG_EXEC_START, MSG_MEMORY_SNAPSHOT, MSG_MEMORY_SNAPSHOT_RESULT,
    MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PING, MSG_QUIESCE_OPERATIONS, MSG_READY,
    MSG_RESUME_OPERATIONS, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE, MemorySnapshot,
};
use nix::sys::socket::{Shutdown, setsockopt, shutdown, sockopt};
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;

use super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, captured_output_bytes,
    exec_capture_default, fence_normal_operations, host_from_stream, is_connected, make_pair,
    mock_handshake, normal_operation_readiness, pending_request_count, poison_connection,
    set_next_route_id, setup_host_and_mock_guest, wait_for_pending_request_count,
};
use crate::{
    GuestControlClient, NormalOperationFenceRejection, RequestWriteError, RequestWriteStage,
    operation_tracker::NormalOperationReadiness,
};

fn unique_vsock_paths(label: &str) -> (String, PathBuf) {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "guest-control-client-{label}-{}-{unique}",
        std::process::id()
    ));
    let listener = PathBuf::from(format!(
        "{}_{}",
        base.display(),
        guest_control_proto::VSOCK_PORT
    ));

    (base.display().to_string(), listener)
}

#[tokio::test]
async fn wait_for_connection_oversized_timeout_returns_invalid_input() {
    let (base, listener) = unique_vsock_paths("timeout-overflow");

    let result = GuestControlClient::wait_for_connection(&base, Duration::MAX).await;
    let error_kind = match result {
        Ok(_) => panic!("oversized timeout should return InvalidInput"),
        Err(error) => error.kind(),
    };

    assert_eq!(error_kind, io::ErrorKind::InvalidInput);
    assert!(
        !listener.exists(),
        "invalid timeout should not create listener socket"
    );
}

#[tokio::test(start_paused = true)]
async fn wait_for_connection_times_out_without_client_and_removes_listener_socket() {
    let (base, listener) = unique_vsock_paths("accept-timeout");
    let timeout = Duration::from_secs(10);
    let started_at = tokio::time::Instant::now();
    let handle =
        tokio::spawn(async move { GuestControlClient::wait_for_connection(&base, timeout).await });

    tokio::task::yield_now().await;
    assert!(listener.exists(), "listener socket should be bound");

    let error = match handle.await.unwrap() {
        Ok(_) => panic!("listener without a client should time out"),
        Err(error) => error,
    };

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(started_at.elapsed(), timeout);
    assert!(
        !listener.exists(),
        "timed-out listener should remove its socket path"
    );
}

#[tokio::test(start_paused = true)]
async fn wait_for_connection_shares_deadline_with_handshake() {
    let (base, listener) = unique_vsock_paths("shared-deadline");
    let timeout = Duration::from_secs(10);
    let started_at = tokio::time::Instant::now();
    let handle =
        tokio::spawn(async move { GuestControlClient::wait_for_connection(&base, timeout).await });

    tokio::task::yield_now().await;
    assert!(listener.exists(), "listener socket should be bound");

    tokio::time::advance(Duration::from_secs(4)).await;
    let guest_stream = UnixStream::connect(&listener).await.unwrap();
    let mut guest = MockGuest::new(guest_stream);
    guest.send_empty_response(MSG_READY, 0).await;
    let ping = guest.expect_message(MSG_PING).await;
    assert!(ping.payload.is_empty());
    assert!(
        !listener.exists(),
        "accepted listener should remove its socket path"
    );

    let error = match handle.await.unwrap() {
        Ok(_) => panic!("handshake without pong should time out"),
        Err(error) => error,
    };

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        started_at.elapsed(),
        timeout,
        "handshake should receive only the original deadline's remaining budget"
    );
    assert!(
        !listener.exists(),
        "timed-out handshake should leave no listener socket"
    );
}

#[tokio::test]
async fn wait_for_connection_removes_listener_socket_on_abort() {
    let (base, listener) = unique_vsock_paths("abort");

    let handle = tokio::spawn(async move {
        GuestControlClient::wait_for_connection(&base, Duration::from_secs(30)).await
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        while !listener.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    handle.abort();
    let _ = handle.await;

    assert!(
        !listener.exists(),
        "aborted listener should remove its socket path"
    );
}

#[tokio::test]
async fn shutdown_accepts_empty_ack() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
        assert!(shutdown.payload.is_empty());
        guest
            .send_empty_response(MSG_SHUTDOWN_ACK, shutdown.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.shutdown(Duration::from_secs(2)).await.unwrap();
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn shutdown_times_out_without_ack() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let shutdown_task = tokio::spawn(async move { host.shutdown(Duration::from_millis(50)).await });

    let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
    assert!(shutdown.payload.is_empty());

    let error = tokio::time::timeout(Duration::from_secs(2), shutdown_task)
        .await
        .expect("shutdown should respect its timeout")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_eq!(error.to_string(), "request timeout");
}

#[tokio::test]
async fn shutdown_preserves_connection_failure() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let shutdown_task = tokio::spawn(async move { host.shutdown(Duration::from_secs(2)).await });

    let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
    assert!(shutdown.payload.is_empty());
    drop(guest);

    let error = tokio::time::timeout(Duration::from_secs(2), shutdown_task)
        .await
        .expect("shutdown should observe the closed connection")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(error.to_string(), "connection closed");
    assert!(crate::ConnectionClosedAtAdmission::from_error(&error).is_none());
}

#[tokio::test]
async fn shutdown_surfaces_guest_error() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
        guest
            .send_error_response(shutdown.seq, "guest refused shutdown")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let error = host.shutdown(Duration::from_secs(2)).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(error.to_string(), "guest refused shutdown");
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn shutdown_rejects_wrong_ack_type() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, shutdown.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let error = host.shutdown(Duration::from_secs(2)).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("unexpected lifecycle response type")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn shutdown_rejects_non_empty_ack_payload() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
        guest
            .send_response(MSG_SHUTDOWN_ACK, shutdown.seq, b"x")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let error = host.shutdown(Duration::from_secs(2)).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("shutdown_ack payload must be empty")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        assert!(quiesce.payload.is_empty());

        guest
            .send_empty_response(MSG_OPERATIONS_QUIESCED, quiesce.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap();
    await_mock_guest(guest_task).await;
}

fn memory_snapshot() -> MemorySnapshot {
    MemorySnapshot {
        mem_total_bytes: 1,
        mem_free_bytes: 2,
        mem_available_bytes: 3,
        buffers_bytes: 4,
        cached_bytes: 5,
        anon_pages_bytes: 6,
        mapped_bytes: 7,
        dirty_bytes: 8,
        writeback_bytes: 9,
        shmem_bytes: 10,
        slab_bytes: 11,
        slab_reclaimable_bytes: 12,
        slab_unreclaimable_bytes: 13,
        unevictable_bytes: 14,
        kernel_stack_bytes: 15,
        page_tables_bytes: 16,
        swap_total_bytes: 17,
        swap_free_bytes: 18,
    }
}

#[tokio::test]
async fn memory_snapshot_sends_empty_request_and_decodes_fixed_response() {
    let (host_stream, guest) = make_pair();
    let expected = memory_snapshot();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let request = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
        assert!(request.payload.is_empty());
        guest
            .send_response(
                MSG_MEMORY_SNAPSHOT_RESULT,
                request.seq,
                &expected.encode_payload(),
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    assert_eq!(
        host.memory_snapshot(Duration::from_secs(2)).await.unwrap(),
        expected
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn memory_snapshot_surfaces_guest_error() {
    let (host_stream, guest) = make_pair();
    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let request = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
        guest
            .send_error_response(request.seq, "guest operations are not fully quiesced")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let error = host
        .memory_snapshot(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert_eq!(error.to_string(), "guest operations are not fully quiesced");
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn memory_snapshot_rejects_wrong_response_type() {
    let (host_stream, guest) = make_pair();
    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let request = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
        guest
            .send_empty_response(MSG_OPERATIONS_QUIESCED, request.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let error = host
        .memory_snapshot(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("unexpected lifecycle response type")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn memory_snapshot_rejects_truncated_and_trailing_responses() {
    let payload = memory_snapshot().encode_payload();
    for malformed in [payload[..143].to_vec(), [&payload[..], &[0]].concat()] {
        let (host_stream, guest) = make_pair();
        let guest_task = tokio::spawn(async move {
            let mut guest = MockGuest::new(guest);
            guest.complete_handshake().await;

            let request = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
            guest
                .send_response(MSG_MEMORY_SNAPSHOT_RESULT, request.seq, &malformed)
                .await;
        });

        let host = host_from_stream(host_stream).await.unwrap();
        let error = host
            .memory_snapshot(Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("exactly 144 bytes"));
        await_mock_guest(guest_task).await;
    }
}

#[tokio::test]
async fn memory_snapshot_timeout_removes_pending_and_ignores_late_response() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.memory_snapshot(Duration::from_millis(100)).await })
    };

    let first = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
    let error = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("memory snapshot should respect its response timeout")
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);

    guest
        .send_response(
            MSG_MEMORY_SNAPSHOT_RESULT,
            first.seq,
            &memory_snapshot().encode_payload(),
        )
        .await;
    let second_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.memory_snapshot(Duration::from_secs(2)).await })
    };
    let second = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
    guest
        .send_response(
            MSG_MEMORY_SNAPSHOT_RESULT,
            second.seq,
            &memory_snapshot().encode_payload(),
        )
        .await;
    assert_eq!(second_task.await.unwrap().unwrap(), memory_snapshot());
}

#[tokio::test]
async fn stale_request_cleanup_does_not_remove_reused_wire_sequence() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let expected = memory_snapshot();
    let wire_seq = 17;
    set_next_route_id(&host, wire_seq.into());

    let mut first = Box::pin(host.memory_snapshot(Duration::from_secs(5)));
    let first_request = tokio::select! {
        result = &mut first => panic!("first request completed before guest response: {result:?}"),
        request = guest.expect_message(MSG_MEMORY_SNAPSHOT) => request,
    };
    assert_eq!(first_request.seq, wire_seq);
    guest
        .send_response(
            MSG_MEMORY_SNAPSHOT_RESULT,
            first_request.seq,
            &expected.encode_payload(),
        )
        .await;
    wait_for_pending_request_count(&host, 0).await;

    set_next_route_id(&host, (1_u64 << 32) + u64::from(wire_seq));
    let mut second = Box::pin(host.memory_snapshot(Duration::from_secs(5)));
    let second_request = tokio::select! {
        result = &mut second => panic!("second request completed before guest response: {result:?}"),
        request = guest.expect_message(MSG_MEMORY_SNAPSHOT) => request,
    };
    assert_eq!(second_request.seq, first_request.seq);

    drop(first);
    assert_eq!(pending_request_count(&host), 1);
    guest
        .send_response(
            MSG_MEMORY_SNAPSHOT_RESULT,
            second_request.seq,
            &expected.encode_payload(),
        )
        .await;
    assert_eq!(second.await.unwrap(), expected);
}

#[tokio::test]
async fn resume_operations_sends_request_and_accepts_empty_ack() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let resume = guest.expect_message(MSG_RESUME_OPERATIONS).await;
        assert!(resume.payload.is_empty());

        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, resume.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.resume_operations(Duration::from_secs(2))
        .await
        .unwrap();
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn lifecycle_request_bypasses_normal_operation_fence() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let _fence = fence_normal_operations(&host);

    let err = exec_capture_default(&host, "blocked", 5000, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(2)).await })
    };

    let msg = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
    guest
        .send_empty_response(MSG_OPERATIONS_QUIESCED, msg.seq)
        .await;

    quiesce_task.await.unwrap().unwrap();

    let expected = memory_snapshot();
    let snapshot_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.memory_snapshot(Duration::from_secs(2)).await })
    };
    let msg = guest.expect_message(MSG_MEMORY_SNAPSHOT).await;
    guest
        .send_response(
            MSG_MEMORY_SNAPSHOT_RESULT,
            msg.seq,
            &expected.encode_payload(),
        )
        .await;
    assert_eq!(snapshot_task.await.unwrap().unwrap(), expected);
}

#[tokio::test]
async fn normal_operation_fence_rejects_new_normal_operations_until_dropped() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let fence = host
        .try_fence_normal_operations()
        .expect("idle host should fence normal operations");
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::AlreadyFenced
    );

    let err = exec_capture_default(&host, "blocked", 5000, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::WouldBlock);

    drop(fence);
    let exec_task =
        tokio::spawn(async move { exec_capture_default(&host, "echo ok", 5000, &[], false).await });
    let request = guest.expect_message(MSG_EXEC_START).await;
    guest
        .send_exec_result(
            request.seq,
            ExecTermination::Exited { exit_code: 0 },
            b"ok",
            b"",
        )
        .await;

    let result = exec_task.await.unwrap().unwrap();
    assert_eq!(captured_output_bytes(&result.stdout), b"ok");
}

#[tokio::test]
async fn normal_operation_fence_reports_busy_closed_and_not_parkable() {
    let (host_stream, guest) = make_pair();
    let release_exec = Arc::new(tokio::sync::Notify::new());
    let (request_seen_tx, request_seen_rx) = tokio::sync::oneshot::channel();
    let mut guest_task = {
        let release_exec = Arc::clone(&release_exec);
        tokio::spawn(async move {
            let mut guest = MockGuest::new(guest);
            guest.complete_handshake().await;
            let request = guest.expect_message(MSG_EXEC_START).await;
            let _ = request_seen_tx.send(());
            release_exec.notified().await;
            guest
                .send_exec_result(
                    request.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    b"done",
                    b"",
                )
                .await;
            drop(guest);
        })
    };

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { exec_capture_default(&host, "sleep", 5000, &[], false).await })
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(2), request_seen_rx) => {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    match (&mut guest_task).await {
                        Ok(()) => panic!("mock guest finished before exec request"),
                        Err(err) => panic!("mock guest task panicked before exec request: {err}"),
                    }
                }
                Err(_) => panic!("guest should receive exec start before busy assertion"),
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before exec request");
            panic!("mock guest finished before exec request");
        }
    }
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::Busy
    );

    release_exec.notify_one();
    exec_task.await.unwrap().unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::Closed
    );
    await_mock_guest(guest_task).await;

    let (poisoned_host, _guest) = setup_host_and_mock_guest().await;
    poison_connection(&poisoned_host);
    assert_eq!(
        poisoned_host.try_fence_normal_operations().unwrap_err(),
        NormalOperationFenceRejection::NotParkable
    );
}

#[tokio::test]
async fn quiesce_operations_surfaces_guest_error() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_error_response(quiesce.seq, "guest operations still pending: 1")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "guest operations still pending: 1");
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_rejects_wrong_ack_type() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_empty_response(MSG_OPERATIONS_RESUMED, quiesce.seq)
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        err.to_string()
            .contains("unexpected lifecycle response type")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_rejects_non_empty_ack_payload() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
        guest
            .send_response(MSG_OPERATIONS_QUIESCED, quiesce.seq, b"x")
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .quiesce_operations(Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        err.to_string()
            .contains("operations_quiesced payload must be empty")
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn quiesce_operations_times_out_and_late_ack_is_ignored() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_millis(100)).await })
    };

    let quiesce = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
    let err = tokio::time::timeout(Duration::from_secs(2), quiesce_task)
        .await
        .expect("quiesce should respect its response timeout")
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);

    guest
        .send_empty_response(MSG_OPERATIONS_QUIESCED, quiesce.seq)
        .await;
    let resume_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.resume_operations(Duration::from_secs(2)).await })
    };
    let resume = guest.expect_message(MSG_RESUME_OPERATIONS).await;
    guest
        .send_empty_response(MSG_OPERATIONS_RESUMED, resume.seq)
        .await;
    resume_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn lifecycle_request_zero_timeout_does_not_send_frame() {
    let (host, mut guest) = setup_host_and_mock_guest().await;

    let err = host.quiesce_operations(Duration::ZERO).await.unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(pending_request_count(&host), 0);
    assert!(is_connected(&host));
    match guest.stream_mut().try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("zero-timeout lifecycle request must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after zero-timeout request: {err}"),
    }
}

#[tokio::test]
async fn lifecycle_request_times_out_while_waiting_for_writer() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_millis(50)).await })
    };

    let err = tokio::time::timeout(Duration::from_secs(2), quiesce_task)
        .await
        .expect("quiesce should time out while waiting for the writer")
        .unwrap()
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(pending_request_count(&host), 0);
    assert!(is_connected(&host));

    drop(writer_guard);
    match guest.stream_mut().try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out lifecycle request must not send later; read {n} bytes"),
        Err(err) => panic!("unexpected read error after writer timeout: {err}"),
    }

    let resume_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.resume_operations(Duration::from_secs(2)).await })
    };
    let resume = guest.expect_message(MSG_RESUME_OPERATIONS).await;
    guest
        .send_empty_response(MSG_OPERATIONS_RESUMED, resume.seq)
        .await;
    resume_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_connection_closed_returns_error() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the exec request then close the connection.
        let _request = guest.expect_message(MSG_EXEC_START).await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = exec_capture_default(&host, "echo hi", 5000, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    await_mock_guest(guest_task).await;
}

/// Request made after connection is already closed returns ConnectionReset
/// immediately (not after timeout).
#[tokio::test]
async fn test_request_after_close_returns_immediately() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        // Close immediately after handshake.
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();

    // Deterministically wait for reader to detect EOF and transition state
    // to Closed — no wall-clock sleep, driven by `close_notify`.
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    // This should return from the closed-state path, not hang until the exec
    // timeout.
    let err = tokio::time::timeout(
        Duration::from_secs(5),
        exec_capture_default(&host, "echo hi", 5000, &[], false),
    )
    .await
    .expect("exec should return when the connection is already closed")
    .unwrap_err();
    assert!(
        matches!(
            err.kind(),
            io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
        ),
        "expected ConnectionReset or BrokenPipe, got {:?}",
        err.kind()
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn lifecycle_request_after_connection_close_returns_immediately() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.quiesce_operations(Duration::from_secs(60)),
    )
    .await
    .expect("lifecycle request should return when the connection is already closed")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn connection_close_marks_normal_operations_closed() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn late_poison_after_connection_close_does_not_reclassify_readiness() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );

    poison_connection(&host);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn connection_poison_marks_normal_operations_not_parkable() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        guest.expect_eof().await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    poison_connection(&host);

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn cancelled_request_before_frame_write_does_not_poison_connection() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let writer = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(5)).await })
    };
    wait_for_pending_request_count(&host, 1).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    assert!(is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer);
    assert_connection_accepts_exec_operation(&host, guest.stream_mut()).await;
}

#[tokio::test]
async fn cancelled_request_frame_write_poisons_connection() {
    let (host_stream, mut guest) = make_pair();
    setsockopt(&host_stream, sockopt::SndBuf, &4096usize).unwrap();
    let (host, ()) = tokio::join!(host_from_stream(host_stream), mock_handshake(&mut guest));
    let host = Arc::new(host.unwrap());
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let payload = guest_control_proto::encode_write_file(
                "/tmp/partial.bin",
                &vec![0xAB; 1024 * 1024],
                false,
                false,
            )
            .unwrap();
            crate::request_on_shared(
                &host.shared,
                MSG_WRITE_FILE,
                &payload,
                Duration::from_secs(5),
            )
            .await
        })
    };
    // Read only the header: the large payload cannot fit in the send buffer.
    tokio::time::timeout(
        Duration::from_secs(5),
        guest.read_exact(&mut [0u8; guest_control_proto::HEADER_SIZE]),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!task.is_finished());
    assert!(host.shared.writer.try_lock().is_err());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    assert!(!is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert!(host.shared.writer.try_lock().is_ok());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn cancelled_request_after_complete_frame_preserves_connection() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(5)).await })
    };
    guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
    drop(host.shared.writer.lock().await);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    assert!(is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert_connection_accepts_exec_operation(&host, guest.stream_mut()).await;
}

#[tokio::test]
async fn request_write_failure_poisons_connection_and_cleans_pending() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    // Fail the write without first closing the host's reader/registration state.
    shutdown(host.shared.fd, Shutdown::Write).unwrap();
    assert!(is_connected(&host));
    let err = host
        .quiesce_operations(Duration::from_secs(5))
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    assert_eq!(
        err.get_ref()
            .unwrap()
            .downcast_ref::<RequestWriteError>()
            .unwrap()
            .stage(),
        RequestWriteStage::FrameWrite,
    );
    assert!(!is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(host.shared.writer.try_lock().is_ok());
    guest.expect_eof().await;
}

/// Two concurrent exec calls get the correct response matched by seq.
#[tokio::test]
async fn test_concurrent_execs() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let all_msgs = guest.read_messages(2).await;
        assert_eq!(all_msgs.len(), 2);
        assert!(all_msgs.iter().all(|m| m.msg_type == MSG_EXEC_START));

        // Reply in reverse order to exercise seq-based dispatching.
        for msg in all_msgs.iter().rev() {
            let d = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
            let out = format!("reply:{}", d.command);
            guest
                .send_exec_result(
                    msg.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    out.as_bytes(),
                    b"",
                )
                .await;
        }

        guest.expect_eof().await;
    });

    let host = Arc::new(host_from_stream(host_stream).await.unwrap());

    let h1 = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { exec_capture_default(&host, "cmd-a", 5000, &[], false).await })
    };
    let h2 = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { exec_capture_default(&host, "cmd-b", 5000, &[], false).await })
    };

    let r1 = h1.await.unwrap().unwrap();
    let r2 = h2.await.unwrap().unwrap();

    // Each response matches its own command, regardless of reply order.
    let out1 = String::from_utf8_lossy(captured_output_bytes(&r1.stdout));
    let out2 = String::from_utf8_lossy(captured_output_bytes(&r2.stdout));
    assert_eq!(out1, "reply:cmd-a");
    assert_eq!(out2, "reply:cmd-b");
    drop(host);
    await_mock_guest(guest_task).await;
}

/// Verify that post-handshake request seq starts at 2 (seq=1 is used by handshake ping).
#[tokio::test]
async fn test_seq_starts_at_2() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the first exec request and verify its seq.
        let msg = guest.expect_message(MSG_EXEC_START).await;
        // Handshake used seq=1, so first request must be seq=2.
        assert_eq!(msg.seq, 2, "first post-handshake seq should be 2");

        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"ok",
                b"",
            )
            .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = exec_capture_default(&host, "test", 5000, &[], false)
        .await
        .unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    await_mock_guest(guest_task).await;
}

/// Regression for #10076: the guest writes the exec response and then
/// immediately closes the socket. The reader dispatches the response,
/// then observes EOF and transitions state to `Closed`. Before the fix,
/// `request_raw` would observe `is_closed=true` after `write_all` and
/// return `ConnectionReset`, discarding the already-delivered response
/// sitting in `rx`. Under the new `ConnectionState` refactor the
/// `is_closed` early-exit no longer exists — the response must be
/// returned via the biased `rx` arm of `select!`.
#[tokio::test]
async fn test_response_then_close_returns_ok() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        // Read the exec request.
        let msg = guest.expect_message(MSG_EXEC_START).await;

        // Write the response and close the socket. The response must
        // race with EOF such that reader_loop processes both before the
        // host's `request_raw` returns from its select!.
        guest
            .send_exec_result(
                msg.seq,
                ExecTermination::Exited { exit_code: 0 },
                b"race-survived",
                b"",
            )
            .await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = exec_capture_default(&host, "echo race", 5000, &[], false).await;

    // The response was delivered before close; the refactor guarantees
    // it is returned via `rx` rather than being shadowed by a close
    // observation.
    let result = result.expect("response delivered before close must not be lost");
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(captured_output_bytes(&result.stdout), b"race-survived");
    await_mock_guest(guest_task).await;
}
