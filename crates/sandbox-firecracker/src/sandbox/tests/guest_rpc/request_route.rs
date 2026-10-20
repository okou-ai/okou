//! Real lifecycle/Unix peers, without a Firecracker/KVM cleanup claim.

use crate::api_request_gate::{RequestOutcome, RequestRoute, Transition, gate_request};

use super::*;

#[tokio::test]
async fn internal_unpark_client_routes_without_relaxing_cancellation_fences() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let api = MockFirecrackerApi::with_handler({
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        move |request| {
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            async move {
                assert_eq!(request.path, "/vm");
                if mock_request_body_json(&request)["state"] == "Resumed" {
                    entered.notify_one();
                    release.notified().await;
                    MockResponse::bad_request_fault("late resume failure")
                } else {
                    assert_eq!(mock_request_body_json(&request)["state"], "Paused");
                    MockResponse::no_content()
                }
            }
        }
    });
    let backend = sandbox.sock_paths.api_sock();
    std::os::unix::fs::symlink(api.socket_path(), &backend).unwrap();
    park_rpc_sandbox(&mut sandbox, &mut peer).await;
    sandbox.bind_run_control("run-b").unwrap();

    let front = dir.path().join("resume-gate.sock");
    let listener = tokio::net::UnixListener::bind(&front).unwrap();
    let (mut control, mut producer) = gate_request(listener, backend.clone(), Transition::Resume);
    let route = RequestRoute::new(backend, front).unwrap();
    let mut unpark = Box::pin(route.scope(sandbox.unpark()));
    let captured = tokio::select! {
        result = &mut unpark => panic!("unpark passed the unreleased gate: {result:?}"),
        captured = &mut control.arrived => captured.unwrap(),
    };
    assert_eq!(captured.transition, Transition::Resume);
    // The internally constructed ApiClient actually entered the front gate.
    // Backend receipt is a separate event, not implied by capture.
    let backend_arrival = entered.notified();
    tokio::pin!(backend_arrival);
    assert!(futures_util::poll!(backend_arrival.as_mut()).is_pending());
    control.release.send(()).unwrap();
    backend_arrival.await;
    drop(unpark);

    assert!(matches!(
        sandbox.park_coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(sandbox.is_parked);
    assert!(sandbox.park_fence.is_some());
    assert!(sandbox.guest_rpc("run-b").is_none());
    assert!(
        sandbox.unpark().await.is_err(),
        "cancelled unpark became reusable"
    );
    let mut byte = [0];
    assert_eq!(
        peer.try_read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );

    release.notify_one();
    match producer.join().await.unwrap() {
        RequestOutcome::ResponseDrained {
            request,
            status,
            response,
            ..
        } => {
            assert_eq!(request, captured);
            assert_eq!(status, 400);
            assert!(
                String::from_utf8(response)
                    .unwrap()
                    .contains("late resume failure")
            );
        }
        outcome => panic!("late backend result lost: {outcome:?}"),
    }
    // Dirty remains authoritative even after the independent response drain.
    assert!(sandbox.unpark().await.is_err());
}
