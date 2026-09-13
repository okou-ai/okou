use super::harness::{CONNECTION, Harness, Reply, TOKEN, params};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};

#[tokio::test]
async fn connection_evidence_reports_actual_authentication_and_skips_reused_transports() {
    for (reply, failure) in [
        (Reply::default(), None),
        (Reply::Reject, Some("exec_rejected")),
        (Reply::Disconnect, Some("disconnected")),
        (Reply::Hold, Some("timed_out")),
    ] {
        let mut h = Harness::new(reply).await;
        let dispatcher = h.take_dispatcher();
        h.runtime.ably_connected(true);
        let resolve = h.resolve(h.credential(true)).await;
        let report = h.api.mock_async(|when, then| {
            when.method("POST").path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                .header("authorization", format!("Bearer {TOKEN}"))
                .json_body_includes(json!({"connectionId":CONNECTION,"runnerIdentity":{"runnerId":h.identity.runner_id(),"heartbeatGeneration":h.identity.heartbeat_generation()},"expectedGeneration":7,"failureReason":null}).to_string());
            then.status(200).json_body(json!({"outcome":"recorded"}));
        }).await;
        for _ in 0..2 {
            let frames = h
                .raw(
                    json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":params()})
                        .to_string(),
                )
                .await;
            let terminal = super::terminal(&frames);
            if let Some(failure) = failure {
                assert_eq!(terminal["failure_reason"], failure);
            } else {
                assert_eq!(terminal["type"], "finished");
                assert_eq!(terminal["exit"]["code"], 7);
            }
        }
        dispatcher.shutdown().await;
        // Failed commands retire the transport; a normal exit reuses it without
        // inventing authentication evidence for the second command.
        let authentications = if failure.is_some() { 2 } else { 1 };
        report.assert_calls_async(authentications).await;
        resolve.assert_calls_async(1).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), authentications);
    }
}

#[tokio::test]
async fn credential_and_host_identity_failures_report_only_structured_codes() {
    for reason in [
        "unsupported_credential",
        "host_key_mismatch",
        "authentication_failed",
        "unsafe_destination",
    ] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        let mut credential = h.credential(true);
        match reason {
            "unsupported_credential" => credential["privateKey"] = json!("secret-invalid-key"),
            "host_key_mismatch" => {
                credential["learnedHostKey"]["fingerprint"] = json!(
                    super::harness::key(russh::keys::Algorithm::Ed25519)
                        .fingerprint(russh::keys::HashAlg::Sha256)
                        .to_string()
                )
            }
            "authentication_failed" => {
                credential["privateKey"] = json!(
                    super::harness::key(russh::keys::Algorithm::Ed25519)
                        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                        .unwrap()
                        .as_str()
                );
            }
            "unsafe_destination" => {
                *h.network.answers.lock().unwrap() = vec!["127.0.0.1:22".parse().unwrap()]
            }
            _ => panic!("Unknown observation fixture reason: {reason}"),
        }
        let _resolve = h.resolve(credential).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":7,"failureReason":reason}).to_string(),
                    )
                    .body_excludes("privateKey")
                    .body_excludes("passphrase")
                    .body_excludes("command")
                    .body_excludes("secret-invalid-key");
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        let frames = h.request(params()).await;
        assert_eq!(super::terminal(&frames)["failure_reason"], reason);
        dispatcher.shutdown().await;
        report.assert_calls_async(1).await;
        assert!(h.observed.commands.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn first_authentication_reports_the_generation_returned_by_tofu() {
    let mut h = Harness::new(Reply::default()).await;
    let dispatcher = h.take_dispatcher();
    let _resolve = h.resolve(h.credential(false)).await;
    let _pin = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/pin", h.run));
            then.status(200)
                .json_body(json!({"outcome":"pinned","generation":8}));
        })
        .await;
    let report = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                .json_body_includes(
                    json!({"expectedGeneration":8,"failureReason":null}).to_string(),
                );
            then.status(200).json_body(json!({"outcome":"recorded"}));
        })
        .await;
    assert_eq!(
        super::terminal(&h.request(params()).await)["type"],
        "finished"
    );
    dispatcher.shutdown().await;
    report.assert_calls_async(1).await;
}

#[tokio::test]
async fn failed_authentication_after_tofu_reports_the_new_generation_for_exec_and_sessions() {
    for managed in [false, true] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        h.runtime.ably_connected(true);
        let mut credential = h.credential(false);
        credential["privateKey"] = json!(
            super::harness::key(russh::keys::Algorithm::Ed25519)
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap()
                .as_str()
        );
        let _resolve = h.resolve(credential).await;
        let pin = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/pin", h.run));
                then.status(200)
                    .json_body(json!({"outcome":"pinned","generation":8}));
            })
            .await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":8,"failureReason":"authentication_failed"})
                            .to_string(),
                    );
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        if managed {
            let id =
                super::sessions::start(&h, json!({"type":"exec","command":"true"}), false).await;
            let failed = super::sessions::state(&h, &id, "failed").await;
            assert_eq!(failed["state"]["failure_reason"], "authentication_failed");
            assert_eq!(failed["effects"], "not_started");
            assert_eq!(failed["generation"], 8);
        } else {
            let frames = h.request(params()).await;
            assert_eq!(
                super::terminal(&frames)["failure_reason"],
                "authentication_failed"
            );
            assert_eq!(super::terminal(&frames)["effects"], "not_started");
        }
        dispatcher.shutdown().await;
        pin.assert_calls_async(1).await;
        report.assert_calls_async(1).await;
        assert!(h.observed.commands.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn first_use_authority_timeout_does_not_report_a_target_connection_failure() {
    let mut h = Harness::new(Reply::default()).await;
    let dispatcher = h.take_dispatcher();
    let _resolve = h.resolve(h.credential(false)).await;
    let pin = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/pin", h.run));
            then.status(200)
                .json_body(json!({"outcome":"pinned","generation":8}))
                .delay(Duration::from_secs(10));
        })
        .await;
    let report = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/observations", h.run));
            then.status(200);
        })
        .await;
    let frames = h
        .raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":params()})
                .to_string(),
        )
        .await;
    assert_eq!(super::terminal(&frames)["failure_reason"], "timed_out");
    dispatcher.shutdown().await;
    pin.assert_calls_async(1).await;
    report.assert_calls_async(0).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn report_failure_or_timeout_cannot_hold_the_guest_stream_or_replay_commands() {
    for (status, delay) in [
        (404, Duration::ZERO),
        (500, Duration::ZERO),
        (200, Duration::from_secs(10)),
    ] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        let resolve = h.resolve(h.credential(true)).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run));
                then.status(status).delay(delay);
            })
            .await;
        let frames = tokio::time::timeout(Duration::from_secs(5), h.request(params()))
            .await
            .unwrap();
        assert_eq!(super::terminal(&frames)["type"], "finished");
        assert_eq!(h.observed.reservations.load(Ordering::SeqCst), 0);
        drop(h.control.try_fence_normal_operations().unwrap());
        tokio::time::timeout(Duration::from_secs(3), dispatcher.shutdown())
            .await
            .unwrap();
        report.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn report_saturation_drops_diagnostics_without_blocking_execution() {
    let mut h = Harness::new(Reply::default()).await;
    let dispatcher = h.take_dispatcher();
    let _resolve = h.resolve(h.credential(true)).await;
    // Inject process-wide capacity pressure; RPC callers cannot directly saturate
    // four reporting slots deterministically within the one-second I/O deadline.
    let _held = h.runtime.reports.acquire_many(4).await.unwrap();
    let report = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/ssh/observations", h.run));
            then.status(200);
        })
        .await;
    assert_eq!(
        super::terminal(&h.request(params()).await)["type"],
        "finished"
    );
    drop(_held);
    dispatcher.shutdown().await;
    report.assert_calls_async(0).await;
}

#[tokio::test]
async fn pre_authentication_timeout_is_a_failure_but_cancellation_is_not() {
    for cancel in [false, true] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        *h.network.target.lock().unwrap() = listener.local_addr().unwrap();
        let _resolve = h.resolve(h.credential(true)).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(json!({"failureReason":"timed_out"}).to_string());
                then.status(200);
            })
            .await;
        let frames = {
            let request = h.raw(
                json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":params()})
                    .to_string(),
            );
            tokio::pin!(request);
            tokio::select! {
                result = &mut request => panic!("SSH greeting must wait for the silent peer: {result:?}"),
                accepted = listener.accept() => {
                    let (_peer, _) = accepted.unwrap();
                    if cancel { h.cancel.cancel(); }
                    request.await
                }
            }
        };
        assert_eq!(
            super::terminal(&frames)["failure_reason"],
            if cancel { "cancelled" } else { "timed_out" }
        );
        dispatcher.shutdown().await;
        report.assert_calls_async(usize::from(!cancel)).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    }
}
