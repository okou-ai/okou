use super::{
    harness::{CONNECTION, Harness, PARTIAL_PASSWORD, PASSWORD, Reply, key, params},
    output, terminal,
};
use russh::keys::{Algorithm, HashAlg};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

fn credential(h: &Harness, pinned: bool, password: &str) -> Value {
    json!({
        "outcome": "resolved_password", "host": "ssh.example.com", "port": 22,
        "username": "test-user", "generation": 7, "password": password,
        "learnedHostKey": pinned.then(|| json!({
            "algorithm": h.host_key.algorithm().as_str(),
            "fingerprint": h.host_key.fingerprint(HashAlg::Sha256).to_string(),
        })),
    })
}

#[tokio::test]
async fn password_preserves_whitespace_and_binary_output_with_nonzero_exit() {
    let h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(credential(&h, true, PASSWORD)).await;
    let frames = h.request(params()).await;
    assert_eq!(
        frames[0],
        json!({"type":"event","data":{"type":"accepted"}})
    );
    assert_eq!(terminal(&frames)["type"], "finished");
    assert_eq!(terminal(&frames)["exit"], json!({"type":"status","code":7}));
    assert_eq!(terminal(&frames)["effects"], "completed");
    assert_eq!(output(&frames, "stdout"), b"hello\0\xff");
    assert_eq!(output(&frames, "stderr"), b"warning\n");
    assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    assert_eq!(
        *h.observed.commands.lock().unwrap(),
        vec![b"printf test-command".to_vec()]
    );
    resolve.assert_calls_async(1).await;
}

#[tokio::test]
async fn rejected_or_partial_password_never_falls_back_and_reports_recovery() {
    for password in ["wrong-password-canary", PARTIAL_PASSWORD] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        h.runtime.ably_connected(true);
        let resolve = h.resolve(credential(&h, true, password)).await;
        let failure = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":7,"failureReason":"authentication_failed"})
                            .to_string(),
                    )
                    .body_excludes("canary")
                    .body_excludes("password");
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        let recovered = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":7,"failureReason":null}).to_string(),
                    )
                    .body_excludes("canary")
                    .body_excludes("password");
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        let frames = h.request(params()).await;
        assert_eq!(terminal(&frames)["failure_reason"], "authentication_failed");
        assert_eq!(terminal(&frames)["effects"], "not_started");
        assert!(!serde_json::to_string(&frames).unwrap().contains("canary"));
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
        assert!(h.observed.commands.lock().unwrap().is_empty());
        resolve.assert_calls_async(1).await;
        resolve.delete_async().await;
        let resolve = h.resolve(credential(&h, true, PASSWORD)).await;
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
        dispatcher.shutdown().await;
        failure.assert_calls_async(1).await;
        recovered.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn password_is_not_sent_to_a_mismatched_host() {
    let h = Harness::new(Reply::default()).await;
    let mut body = credential(&h, true, PASSWORD);
    body["learnedHostKey"]["fingerprint"] = json!(
        key(Algorithm::Ed25519)
            .fingerprint(HashAlg::Sha256)
            .to_string()
    );
    let _resolve = h.resolve(body).await;
    let frames = h.request(params()).await;
    assert_eq!(terminal(&frames)["failure_reason"], "host_key_mismatch");
    assert_eq!(terminal(&frames)["effects"], "not_started");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn password_waits_for_confirmed_tofu_and_reports_its_generation() {
    for outcome in ["pinned", "configuration_changed"] {
        let mut h = Harness::new(Reply::default()).await;
        let dispatcher = h.take_dispatcher();
        let _resolve = h.resolve(credential(&h, false, PASSWORD)).await;
        let pin = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/pin", h.run))
                    .json_body_includes(json!({"expectedGeneration":7}).to_string());
                then.status(200).json_body(if outcome == "pinned" {
                    json!({"outcome":outcome,"generation":8})
                } else {
                    json!({"outcome":outcome})
                });
            })
            .await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path(format!("/api/runners/runs/{}/ssh/observations", h.run))
                    .json_body_includes(
                        json!({"expectedGeneration":8,"failureReason":null}).to_string(),
                    )
                    .body_excludes("canary");
                then.status(200).json_body(json!({"outcome":"recorded"}));
            })
            .await;
        let frames = h.request(params()).await;
        dispatcher.shutdown().await;
        pin.assert_calls_async(1).await;
        if outcome == "pinned" {
            assert_eq!(terminal(&frames)["type"], "finished");
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
            report.assert_calls_async(1).await;
        } else {
            assert_eq!(terminal(&frames)["failure_reason"], outcome);
            assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
            assert!(h.observed.commands.lock().unwrap().is_empty());
            report.assert_calls_async(0).await;
        }
    }
}

#[tokio::test]
async fn invalidation_replaces_cached_key_with_password_and_disconnect_evicts_it() {
    let h = Harness::new(Reply::default()).await;
    h.runtime.ably_connected(true);
    let resolve = h.resolve(h.credential(true)).await;
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    resolve.assert_calls_async(1).await;
    resolve.delete_async().await;
    let resolve = h.resolve(credential(&h, true, PASSWORD)).await;
    assert!(h.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    }));
    for _ in 0..2 {
        assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    }
    resolve.assert_calls_async(1).await;
    resolve.delete_async().await;
    h.runtime.ably_connected(false);
    let resolve = h
        .resolve(credential(&h, true, "rotated-password-canary"))
        .await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authentication_failed"
    );
    resolve.assert_calls_async(1).await;
    assert_eq!(h.observed.commands.lock().unwrap().len(), 3);
}
