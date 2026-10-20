//! Public lifecycle and real Unix peers; native data proof is a separate corpus.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::AtomicUsize;

use crate::api_request_gate::{
    RequestOutcome, RequestRoute, ResponseDisposition, Transition,
    gate_request_with_response_control,
};

use super::*;

#[tokio::test]
async fn endpoint_bind_failure_before_resume_keeps_terminal_retry_available() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
    let mut api = MockFirecrackerApi::with_handler(|_| async { MockResponse::no_content() });
    std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
    park_rpc_sandbox(&mut sandbox, &mut peer).await;
    api.drain_requests();
    sandbox.bind_run_control("run-b").unwrap();
    let path = sandbox.sock_paths.guest_duplex();
    let existing = tokio::net::UnixListener::bind(&path).unwrap();
    assert!(sandbox.unpark().await.is_err());
    assert!(sandbox.unpark_attempt.is_none());
    assert_eq!(sandbox.park_coordinator.state(), CoordinatorState::Parked);
    assert!(api.drain_requests().is_empty());
    drop(existing);
    std::fs::remove_file(&path).unwrap();
    let (result, ()) = tokio::join!(
        sandbox.unpark_for_terminal_operations(),
        acknowledge_lifecycle(
            &mut peer,
            guest_control_proto::MSG_RESUME_OPERATIONS,
            guest_control_proto::MSG_OPERATIONS_RESUMED
        )
    );
    result.unwrap();
    assert!(!sandbox.is_parked);
}

#[tokio::test]
async fn cancelled_unpark_rejoins_original_request_for_terminal_operations_only() {
    for fault in 0..4 {
        let dir = tempfile::tempdir().unwrap();
        let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
        let resumes = Arc::new(AtomicUsize::new(0));
        let api = MockFirecrackerApi::with_handler({
            let resumes = resumes.clone();
            move |request| {
                if mock_request_body_json(&request)["state"] == "Resumed" {
                    resumes.fetch_add(1, Ordering::SeqCst);
                }
                async { MockResponse::no_content() }
            }
        });
        let backend = sandbox.sock_paths.api_sock();
        std::os::unix::fs::symlink(api.socket_path(), &backend).unwrap();
        park_rpc_sandbox(&mut sandbox, &mut peer).await;
        sandbox.bind_run_control("run-b").unwrap();
        let old_control = sandbox.guest_operation_start_gate();
        let front = dir.path().join("response-gate.sock");
        let (mut request, mut response, mut producer) = gate_request_with_response_control(
            tokio::net::UnixListener::bind(&front).unwrap(),
            backend.clone(),
            Transition::Resume,
        );
        let mut unpark = Box::pin(
            RequestRoute::new(backend, front)
                .unwrap()
                .scope(sandbox.unpark()),
        );
        let captured = tokio::select! {
            result = &mut unpark => panic!("unpark passed capture: {result:?}"),
            captured = &mut request.arrived => captured.unwrap(),
        };
        request.release.send(()).unwrap();
        let accepted = tokio::select! {
            result = &mut unpark => panic!("unpark passed held response: {result:?}"),
            accepted = &mut response.arrived => accepted.unwrap(),
        };
        assert_eq!(accepted.request, captured);
        assert_eq!(accepted.status, 204);
        assert!(futures_util::poll!(unpark.as_mut()).is_pending());
        if fault == 1 {
            assert!(
                std::panic::catch_unwind(AssertUnwindSafe(move || {
                    let _observation = unpark;
                    std::panic::resume_unwind(Box::new("unpark observer unwind"));
                }))
                .is_err()
            );
        } else {
            drop(unpark);
        }
        assert!(sandbox.unpark().await.is_err());
        assert!(sandbox.park().await.is_err());
        assert!(sandbox.guest_rpc("run-b").is_none());
        assert!(sandbox.bind_run_control("run-c").is_err());
        if fault == 3 {
            sandbox
                .park_coordinator
                .mark_dirty(DirtyReason::new("unrelated uncertainty"));
            assert!(sandbox.unpark_for_terminal_operations().await.is_err());
            response.release.send(ResponseDisposition::Deliver).unwrap();
            producer.join().await.unwrap();
            assert!(sandbox.unpark_for_terminal_operations().await.is_err());
            assert!(sandbox.park_fence.is_some());
            assert!(sandbox.terminal_unpark.is_none());
            continue;
        }
        // Cancelling terminal observation also retains the very same producer.
        if fault == 1 {
            let mut kill = Box::pin(sandbox.kill());
            assert!(futures_util::poll!(kill.as_mut()).is_pending());
            drop(kill);
            assert_eq!(sandbox.current_state(), SandboxState::Running);
        } else {
            let mut terminal = Box::pin(sandbox.unpark_for_terminal_operations());
            assert!(futures_util::poll!(terminal.as_mut()).is_pending());
            drop(terminal);
        }
        assert!(sandbox.is_parked);
        assert!(sandbox.park_fence.is_some());
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
        assert_eq!(resumes.load(Ordering::SeqCst), 1);
        assert!(!sandbox.is_parked);
        assert!(sandbox.park_fence.is_none());
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
        assert!(sandbox.unpark().await.is_err());
        assert!(sandbox.guest_rpc("run-b").is_none());
        assert!(sandbox.bind_run_control("run-c").is_err());
        sandbox
            .park_coordinator
            .mark_dirty(DirtyReason::new("subsequent uncertainty"));
        assert!(sandbox.unpark_for_terminal_operations().await.is_err());
        assert!(
            sandbox
                .guest_operation_start_gate()
                .begin_sandbox_operation(|| SandboxState::Running)
                .await
                .is_err()
        );
    }
}
