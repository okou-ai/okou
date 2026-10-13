use std::io;
use std::sync::Arc;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, MSG_GUEST_STORAGE_MANIFEST,
    MSG_GUEST_STORAGE_MANIFEST_RESULT,
};
use sandbox::StorageManifestRequestTiming;
use tokio::sync::oneshot;

use crate::operation_tracker::NormalOperationReadiness;
use crate::tests::support::{
    MockGuest, host_from_stream, make_pair, normal_operation_readiness, pending_request_count,
};

fn success_payload() -> Vec<u8> {
    guest_control_proto::encode_guest_storage_manifest_result(
        guest_control_proto::DecodedExecResult {
            termination: ExecTermination::Exited { exit_code: 0 },
            duration_ms: 17,
            stdout: ExecCapturedOutput::Captured {
                bytes: b"out",
                truncated: false,
            },
            stderr: ExecCapturedOutput::Captured {
                bytes: b"err",
                truncated: true,
            },
            diagnostic: "",
        },
        &[],
    )
    .unwrap()
}

#[tokio::test]
async fn storage_timing_retains_only_observed_phases_when_input_validation_fails() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();
    let mut timing = StorageManifestRequestTiming {
        frame_write: Some(Duration::from_secs(9)),
        response_wait: Some(Duration::from_secs(9)),
        result_decode: Some(Duration::from_secs(9)),
        ..StorageManifestRequestTiming::default()
    };
    let error = host
        .guest_storage_manifest_with_timing(
            b"{}",
            "",
            "/run",
            1,
            Duration::from_secs(1),
            &mut timing,
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert!(timing.setup.is_some());
    assert!(timing.frame_builder_wait.is_some());
    assert!(timing.frame_encode.is_some());
    assert!(timing.writer_wait.is_none());
    assert!(timing.frame_write.is_none());
    assert!(timing.response_wait.is_none());
    assert!(timing.result_decode.is_none());
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn storage_timing_observes_frame_builder_contention_with_the_original_request() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        guest
            .send_response(
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();
    let gate = host.shared.frame_builder.lock().await;
    let mut timing = StorageManifestRequestTiming::default();
    {
        // Complete real handshake I/O before pausing only this blocked phase.
        tokio::time::pause();
        let request = host.guest_storage_manifest_with_timing(
            b"{}",
            "run",
            "/run",
            1,
            Duration::from_secs(1),
            &mut timing,
        );
        tokio::pin!(request);
        assert!(matches!(
            request
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        tokio::time::advance(Duration::from_millis(25)).await;
        tokio::time::resume();
        drop(gate);
        let result = request.await.unwrap();
        assert_eq!(result.stdout, b"out");
    }
    assert!(timing.frame_builder_wait.unwrap() >= Duration::from_millis(25));
    assert!(timing.frame_write.is_some());
    assert!(timing.result_decode.is_some());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_sends_request_and_decodes_result() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        let decoded =
            guest_control_proto::decode_guest_storage_manifest_request(&request.payload).unwrap();
        assert_eq!(decoded.timeout_ms, 300_000);
        assert_eq!(decoded.run_id, "run-1");
        assert_eq!(decoded.runtime_dir, "/run/vm0/runs/run-1");
        assert_eq!(decoded.manifest_json, b"{}");
        guest
            .send_response(
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let mut timing = StorageManifestRequestTiming::default();
    let result = host
        .guest_storage_manifest_with_timing(
            b"{}",
            "run-1",
            "/run/vm0/runs/run-1",
            300_000,
            Duration::from_secs(1),
            &mut timing,
        )
        .await
        .unwrap();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.duration_ms, 17);
    assert_eq!(result.stdout, b"out");
    assert_eq!(result.stderr, b"err");
    assert!(!result.stdout_truncated);
    assert!(result.stderr_truncated);
    assert!(result.resources.is_none());
    assert!(timing.setup.is_some());
    assert!(timing.frame_builder_wait.is_some());
    assert!(timing.frame_encode.is_some());
    assert!(timing.writer_wait.is_some());
    assert!(timing.frame_write.is_some());
    assert!(timing.response_wait.is_some());
    assert!(timing.result_decode.is_some());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn storage_resources_are_bound_to_the_request_without_changing_core_results() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        for case in 0..6 {
            let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
            let mut resource = serde_json::json!({
                "run_id": "8d7a07c8-15b2-446f-9f47-36d32028baa6",
                "request_seq": request.seq,
                "group": format!("exec-7-{}-1", request.seq),
                "cleanup_mode": "Graceful",
                "containment_wall_us": 1000,
                "collection_us": 170,
                "cpu_usage_usec": 0,
                "unknown_peer_field": "never logged"
            });
            match case {
                1 => resource["run_id"] = serde_json::json!("ffffffff-ffff-ffff-ffff-ffffffffffff"),
                2 => resource["request_seq"] = serde_json::json!(request.seq + 1),
                3 => resource["group"] = serde_json::json!("secret-group\nforged"),
                4 => resource["cpu_usage_usec"] = serde_json::json!(-1),
                _ => {}
            }
            let resources = if case == 5 {
                vec![0xff]
            } else {
                serde_json::to_vec(&resource).unwrap()
            };
            let original = success_payload();
            let result = guest_control_proto::decode_guest_storage_manifest_result(&original)
                .unwrap()
                .result;
            let payload =
                guest_control_proto::encode_guest_storage_manifest_result(result, &resources)
                    .unwrap();
            guest
                .send_response(MSG_GUEST_STORAGE_MANIFEST_RESULT, request.seq, &payload)
                .await;
        }
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();
    for case in 0..6 {
        let result = host
            .guest_storage_manifest(
                b"{}",
                "8d7a07c8-15b2-446f-9f47-36d32028baa6",
                "/run",
                1000,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert!(result.stderr_truncated);
        assert!(result.diagnostic.is_empty());
        if case == 0 {
            let resources = result.resources.unwrap();
            assert_eq!(resources.cpu_usage_usec, Some(0));
            assert_eq!(resources.memory_peak_bytes, None);
            assert!(
                !serde_json::to_string(&resources)
                    .unwrap()
                    .contains("never logged")
            );
        } else {
            assert!(result.resources.is_none());
        }
        assert_eq!(
            normal_operation_readiness(&host),
            NormalOperationReadiness::Idle
        );
    }
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn storage_terminal_timing_and_resources_are_independently_optional() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        for case in 0..8 {
            let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
            let mut metadata = serde_json::json!({
                "run_id": "8d7a07c8-15b2-446f-9f47-36d32028baa6",
                "request_seq": request.seq,
                "group": format!("exec-7-{}-1", request.seq),
                "cleanup_mode": "Graceful",
                "containment_wall_us": 1000,
                "collection_us": 0,
                "cpu_usage_usec": 0,
                "storage_resource_available": true,
                "storage_control_timing": {
                    "request_ownership_us": 0,
                    "worker_wait_us": 7,
                    "response_prepare_us": 11
                }
            });
            match case {
                1 => {
                    metadata
                        .as_object_mut()
                        .unwrap()
                        .remove("storage_control_timing");
                }
                2 => metadata["storage_control_timing"]["worker_wait_us"] = serde_json::json!(-1),
                3 => {
                    metadata["storage_control_timing"] = serde_json::json!({ "worker_wait_us": 0 })
                }
                4 => {
                    metadata = serde_json::json!({
                        "storage_resource_available": false,
                        "storage_control_timing": {
                            "request_ownership_us": 0, "worker_wait_us": 7, "response_prepare_us": 11
                        }
                    })
                }
                5 => metadata["request_seq"] = serde_json::json!(request.seq + 1),
                _ => {}
            }
            let bytes = match case {
                6 => vec![0xff],
                7 => Vec::new(),
                _ => serde_json::to_vec(&metadata).unwrap(),
            };
            let original = success_payload();
            let mut result = guest_control_proto::decode_guest_storage_manifest_result(&original)
                .unwrap()
                .result;
            if case == 4 {
                result.termination = ExecTermination::StartFailed;
            }
            let payload =
                guest_control_proto::encode_guest_storage_manifest_result(result, &bytes).unwrap();
            guest
                .send_response(MSG_GUEST_STORAGE_MANIFEST_RESULT, request.seq, &payload)
                .await;
        }
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();
    let mut timing = StorageManifestRequestTiming::default();
    for case in 0..8 {
        let result = host
            .guest_storage_manifest_with_timing(
                b"{}",
                "8d7a07c8-15b2-446f-9f47-36d32028baa6",
                "/run",
                1000,
                Duration::from_secs(5),
                &mut timing,
            )
            .await
            .unwrap();
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.duration_ms, 17);
        assert_eq!(
            result.termination,
            if case == 4 {
                ExecTermination::StartFailed
            } else {
                ExecTermination::Exited { exit_code: 0 }
            }
        );
        assert_eq!(result.resources.is_some(), case < 4);
        if case < 4 {
            assert_eq!(timing.resources.cpu_usage_us, Some(0));
            assert_eq!(timing.resources.collection_us, Some(0));
        } else {
            assert_eq!(
                timing.resources,
                sandbox::StorageManifestResources::default()
            );
        }
        match case {
            0 | 4 | 5 => {
                assert_eq!(timing.guest.request_ownership_us, Some(0));
                assert_eq!(timing.guest.worker_wait_us, Some(7));
                assert_eq!(timing.guest.response_prepare_us, Some(11));
            }
            3 => {
                assert_eq!(timing.guest.request_ownership_us, None);
                assert_eq!(timing.guest.worker_wait_us, Some(0));
                assert_eq!(timing.guest.response_prepare_us, None);
            }
            _ => assert_eq!(timing.guest, sandbox::StorageManifestGuestTiming::default()),
        }
        assert_eq!(
            normal_operation_readiness(&host),
            NormalOperationReadiness::Idle
        );
    }
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_surfaces_guest_error_and_completes_operation() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        guest
            .send_error_response(request.seq, "guest operations are quiescing")
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_secs(1))
        .await
        .unwrap_err();

    assert!(error.to_string().contains("guest operations are quiescing"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_rejects_malformed_terminal_payload_after_completion() {
    let (host_stream, guest_stream) = make_pair();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        guest
            .send_response(MSG_GUEST_STORAGE_MANIFEST_RESULT, request.seq, &[0xFF])
            .await;
        release_rx.await.unwrap();
    });
    let host = host_from_stream(host_stream).await.unwrap();

    let error = host
        .guest_storage_manifest(b"{}", "run", "/run", 1, Duration::from_secs(1))
        .await
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}

#[tokio::test]
async fn guest_storage_manifest_timeout_abandons_connection_and_ignores_late_result() {
    let (host_stream, guest_stream) = make_pair();
    let (request_tx, request_rx) = oneshot::channel();
    let (late_tx, late_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        request_tx.send(request.seq).unwrap();
        late_rx.await.unwrap();
        guest
            .send_response(
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                request.seq,
                &success_payload(),
            )
            .await;
        tokio::task::yield_now().await;
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let request = tokio::spawn(async move {
        let mut timing = StorageManifestRequestTiming {
            result_decode: Some(Duration::from_secs(9)),
            ..StorageManifestRequestTiming::default()
        };
        let result = request_host
            .guest_storage_manifest_with_timing(
                b"{}",
                "run",
                "/run",
                1,
                Duration::from_millis(20),
                &mut timing,
            )
            .await;
        (result, timing)
    });
    request_rx.await.unwrap();

    let (result, timing) = request.await.unwrap();
    let error = result.unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(timing.frame_write.is_some());
    assert!(timing.response_wait.is_some());
    assert!(timing.result_decode.is_none());
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    late_tx.send(()).unwrap();
    guest.await.unwrap();
    assert_eq!(pending_request_count(&host), 0);
}

#[tokio::test]
async fn dropping_guest_storage_manifest_after_write_abandons_connection_for_parking() {
    let (host_stream, guest_stream) = make_pair();
    let (request_tx, request_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let guest = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest_stream);
        guest.complete_handshake().await;
        let _request = guest.expect_message(MSG_GUEST_STORAGE_MANIFEST).await;
        request_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    let host = Arc::new(host_from_stream(host_stream).await.unwrap());
    let request_host = Arc::clone(&host);
    let request = tokio::spawn(async move {
        let mut timing = StorageManifestRequestTiming::default();
        request_host
            .guest_storage_manifest_with_timing(
                b"{}",
                "run",
                "/run",
                1,
                Duration::from_secs(1),
                &mut timing,
            )
            .await
    });
    request_rx.await.unwrap();

    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    tokio::task::yield_now().await;

    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    release_tx.send(()).unwrap();
    guest.await.unwrap();
}
