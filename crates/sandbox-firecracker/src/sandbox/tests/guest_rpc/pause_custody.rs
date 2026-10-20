//! Actual physical pause retains original readiness and fencing across observation loss.

use std::panic::AssertUnwindSafe;

use crate::api_request_gate::{
    RequestOutcome, RequestRoute, ResponseDisposition, Transition,
    gate_request_with_response_control,
};

use super::*;

async fn acknowledge_final_exec(peer: &mut UnixStream) {
    let request = read_vsock_message(peer).await;
    assert_eq!(request.msg_type, guest_control_proto::MSG_EXEC_START);
    let output = guest_control_proto::ExecCapturedOutput::Captured {
        bytes: b"",
        truncated: false,
    };
    let payload = guest_control_proto::encode_exec_result(
        guest_control_proto::ExecTermination::Exited { exit_code: 0 },
        1,
        output,
        output,
        "",
    )
    .unwrap();
    peer.write_all(
        &guest_control_proto::encode(guest_control_proto::MSG_EXEC_RESULT, request.seq, &payload)
            .unwrap(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelled_physical_pause_rejoins_before_terminal_readiness() {
    for final_exec in [false, true] {
        for fault in 0..4 {
            let dir = tempfile::tempdir().unwrap();
            let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
            let mut api =
                MockFirecrackerApi::with_handler(|_| async { MockResponse::no_content() });
            let backend = sandbox.sock_paths.api_sock();
            std::os::unix::fs::symlink(api.socket_path(), &backend).unwrap();
            let old_control = sandbox.guest_operation_start_gate();
            let old_rpc = sandbox.guest_rpc("run-a").unwrap();
            let front = dir.path().join("pause-response.sock");
            let (mut request, mut response, mut producer) = gate_request_with_response_control(
                tokio::net::UnixListener::bind(&front).unwrap(),
                backend.clone(),
                Transition::Pause,
            );
            let operation = async {
                if final_exec {
                    sandbox
                        .final_exec_and_park(
                            &ExecRequest {
                                cmd: "true",
                                timeout: Duration::from_secs(1),
                                env: &[],
                                sudo: false,
                                expected_exit_codes: &[],
                                stdin_bytes: None,
                                output_limits: sandbox::ExecOutputLimits::same(1024),
                            },
                            "pause-custody-final-exec",
                        )
                        .await
                        .map(|outcome| outcome.park_outcome)
                } else {
                    sandbox.park().await
                }
            };
            let mut park = Box::pin(RequestRoute::new(backend, front).unwrap().scope(operation));
            let (captured, ()) = tokio::join!(
                async {
                    tokio::select! {
                        captured = &mut request.arrived => captured.unwrap(),
                        result = &mut park => panic!("park passed capture: {result:?}"),
                    }
                },
                async {
                    if final_exec {
                        acknowledge_final_exec(&mut peer).await;
                    }
                    acknowledge_lifecycle(
                        &mut peer,
                        guest_control_proto::MSG_QUIESCE_OPERATIONS,
                        guest_control_proto::MSG_OPERATIONS_QUIESCED,
                    )
                    .await;
                },
            );
            request.release.send(()).unwrap();
            let accepted = tokio::select! {
                accepted = &mut response.arrived => accepted.unwrap(),
                result = &mut park => panic!("park passed held response: {result:?}"),
            };
            assert_eq!(accepted.request, captured);
            assert_eq!(accepted.status, 204);
            assert!(futures_util::poll!(park.as_mut()).is_pending());
            if fault == 1 {
                assert!(
                    std::panic::catch_unwind(AssertUnwindSafe(move || {
                        let _observation = park;
                        std::panic::resume_unwind(Box::new(
                            "borrowed physical park observer unwound",
                        ));
                    }))
                    .is_err()
                );
            } else {
                drop(park);
            }
            assert!(sandbox.park().await.is_err());
            assert!(sandbox.unpark().await.is_err());
            assert!(old_control.begin_control_operation().await.is_err());
            assert!(old_rpc.accept().await.is_err());
            assert!(sandbox.bind_run_control("other-run").is_err());
            assert!(
                sandbox
                    .park_coordinator
                    .ensure_terminal_unpark_allowed(uuid::Uuid::new_v4())
                    .is_err()
            );
            if fault == 3 {
                sandbox
                    .park_coordinator
                    .mark_dirty(DirtyReason::new("unrelated physical uncertainty"));
                assert!(sandbox.unpark_for_terminal_operations().await.is_err());
                response.release.send(ResponseDisposition::Deliver).unwrap();
                producer.join().await.unwrap();
                assert!(sandbox.unpark_for_terminal_operations().await.is_err());
                assert!(sandbox.terminal_unpark.is_none());
                continue;
            }
            for terminal in [false, true] {
                let mut waiting: std::pin::Pin<
                    Box<dyn Future<Output = sandbox::Result<()>> + Send + '_>,
                > = if terminal {
                    Box::pin(sandbox.unpark_for_terminal_operations())
                } else {
                    Box::pin(sandbox.kill())
                };
                let observed = futures_util::poll!(waiting.as_mut());
                assert!(
                    observed.is_pending(),
                    "terminal join lost accepted pause: {observed:?}"
                );
            }
            assert_eq!(sandbox.current_state(), SandboxState::Running);
            response
                .release
                .send(if fault == 2 {
                    ResponseDisposition::UnwindAfterDelivery
                } else {
                    ResponseDisposition::Deliver
                })
                .unwrap();
            if fault == 2 {
                assert!(producer.join().await.unwrap_err().producer_panicked());
            } else {
                assert!(matches!(
                    producer.join().await.unwrap(),
                    RequestOutcome::ResponseDrained {
                        status: 204,
                        delivery: Ok(()),
                        ..
                    }
                ));
            }
            let (ready, ()) = tokio::join!(
                sandbox.unpark_for_terminal_operations(),
                acknowledge_lifecycle(
                    &mut peer,
                    guest_control_proto::MSG_RESUME_OPERATIONS,
                    guest_control_proto::MSG_OPERATIONS_RESUMED
                ),
            );
            ready.unwrap();
            sandbox.unpark_for_terminal_operations().await.unwrap();
            assert!(!sandbox.is_parked);
            assert!(sandbox.park_fence.is_none());
            assert!(sandbox.park_attempt.is_none());
            assert!(sandbox.guest_rpc("run-a").is_none());
            assert!(matches!(
                sandbox.park_coordinator.state(),
                CoordinatorState::Dirty { .. }
            ));
            assert!(old_control.begin_control_operation().await.is_err());
            assert!(
                sandbox
                    .guest_operation_start_gate()
                    .begin_sandbox_operation(|| SandboxState::Running)
                    .await
                    .is_ok()
            );
            sandbox
                .park_coordinator
                .mark_dirty(DirtyReason::new("later terminal uncertainty"));
            assert!(sandbox.unpark_for_terminal_operations().await.is_err());
            assert!(
                sandbox
                    .guest_operation_start_gate()
                    .begin_sandbox_operation(|| SandboxState::Running)
                    .await
                    .is_err()
            );
            let requests = api.drain_requests();
            for state in ["Paused", "Resumed"] {
                assert_eq!(
                    requests
                        .iter()
                        .filter(|r| mock_request_body_json(r)["state"] == state)
                        .count(),
                    1
                );
            }
        }
    }
}

#[tokio::test]
async fn failed_original_pause_is_cached_and_never_grants_terminal_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
    let mut api = MockFirecrackerApi::with_handler(|_| async {
        MockResponse::bad_request_fault("original pause rejected")
    });
    std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
    let (failed, ()) = tokio::join!(
        sandbox.park(),
        acknowledge_lifecycle(
            &mut peer,
            guest_control_proto::MSG_QUIESCE_OPERATIONS,
            guest_control_proto::MSG_OPERATIONS_QUIESCED
        )
    );
    assert!(failed.is_err());
    for _ in 0..2 {
        assert!(sandbox.unpark_for_terminal_operations().await.is_err());
        assert!(sandbox.kill().await.is_err());
    }
    assert!(sandbox.terminal_unpark.is_none());
    assert_eq!(api.drain_requests().len(), 1);
}

#[tokio::test]
async fn cancelled_quiesce_cannot_acquire_pause_recovery_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
    let mut api = MockFirecrackerApi::with_handler(|_| async { MockResponse::no_content() });
    std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
    let mut park = Box::pin(sandbox.park());
    let request = tokio::select! {
        request = read_vsock_message(&mut peer) => request,
        result = &mut park => panic!("park passed quiesce: {result:?}"),
    };
    assert_eq!(
        request.msg_type,
        guest_control_proto::MSG_QUIESCE_OPERATIONS
    );
    drop(park);
    assert!(sandbox.unpark_for_terminal_operations().await.is_err());
    assert!(sandbox.terminal_unpark.is_none());
    assert!(api.drain_requests().is_empty());
}
