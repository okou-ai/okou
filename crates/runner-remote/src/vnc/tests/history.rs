use super::harness::CREATED_AT;
use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
};
use crate::test_fixtures::remote_inventory;
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Semaphore;

#[tokio::test]
async fn installation_requires_trusted_agent_token_without_disrupting_vnc() {
    let mut h = Harness::new().await;
    let token = crate::test_fixtures::check_token(h.run.id, &["vnc:read", "vnc:write"]);
    let mut context =
        crate::test_fixtures::execution_context::diagnostic_context_for_test(h.run.id, &token);
    context.sandbox_token = token.clone();
    context
        .environment
        .as_mut()
        .unwrap()
        .insert("OKOU_TOKEN".into(), token);
    context.platform_environment.remove("OKOU_TOKEN");
    h.run.install_context(&h.runtime, &context).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let resolve = h.resolve().await;
    let recheck = h.check("valid", 200).await;
    assert_eq!(
        h.run.passive("vnc.diagnose", json!({})).await["status"],
        "unavailable"
    );
    let denied = h
        .run
        .request(
            "vnc.check",
            json!({"connectionId":CONNECTION,"mode":"shared"}),
        )
        .await;
    assert_eq!(
        denied.controls,
        vec![json!({"type":"error","code":"unavailable","delivery":"not_dispatched"})]
    );
    inventory.assert_calls_async(0).await;
    resolve.assert_calls_async(0).await;
    recheck.assert_calls_async(0).await;
    assert!(h.network.attempts.lock().unwrap().is_empty());
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    h.run
        .request("vnc.session.close", json!({"sessionId":session}))
        .await;
    closed(&h).await;
    resolve.assert_calls_async(1).await;
    recheck.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn vnc_credential_parse_failure_retains_identity_and_recreated_hosts_cannot_read_it() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let resolve = h
        .resolve_response(json!({
            "outcome":"resolved_transport", "host":"vnc.example.test", "port":5900,
            "generation":7, "serverName":"vnc.example.test", "transport":{"type":"direct"},
            "authentication":{"method":"none"},
            "security":{"type":"x509_none","trust":{"mode":"custom_ca","caBundle":"invalid-ca-canary"}}
        }))
        .await;
    let failed = h.start("shared").await;
    assert_eq!(failed.result()["reason"], "invalid_credential");
    let automatic = diagnostic_text(failed.result());
    assert!(automatic.contains("VNC credential: failed."), "{automatic}");
    assert!(
        automatic.contains("VNC authentication: not reached."),
        "{automatic}"
    );
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let history = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(history["status"], "found");
    assert_eq!(diagnostic_text(&history), automatic);
    assert!(diagnostic_text(&history).starts_with("Failure: VNC invalid credential during start."));
    assert!(diagnostic_text(&history).contains(&format!(
        "Configuration: created at {CREATED_AT}; generation 7."
    )));
    assert!(!history.to_string().contains("invalid-ca-canary"));
    assert!(h.network.attempts.lock().unwrap().is_empty());
    inventory.assert_calls_async(1).await;
    inventory.delete_async().await;
    let recreated = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200).json_body(remote_inventory(
                &[(CONNECTION, 7)],
                "2026-09-01T00:00:00.123457Z",
            ));
        })
        .await;
    let hidden = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":diagnostic_attempt(&history)}),
        )
        .await;
    assert_eq!(hidden["status"], "authority_unavailable");
    assert!(!diagnostic_text(&hidden).contains(CONNECTION));
    recreated.assert_calls_async(1).await;
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn vnc_failed_start_remains_queryable_after_success_and_session_removal() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET")
                .path("/api/vnc/hosts")
                .header("authorization", "Bearer diagnostic-vnc-agent");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    let failed = h.start("shared").await;
    assert_eq!(failed.result()["reason"], "authentication_failed");
    let automatic = diagnostic_text(failed.result());
    assert!(
        automatic.contains("VNC authentication: failed."),
        "{automatic}"
    );
    assert!(
        automatic.contains("VNC RFB error: authentication_failed;"),
        "{automatic}"
    );
    closed(&h).await;
    let original = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&original), automatic);
    assert!(
        diagnostic_text(&original).starts_with("Failure: VNC authentication failed during start.")
    );
    assert!(diagnostic_text(&original).contains(&format!(
        "Configuration: created at {CREATED_AT}; generation 7."
    )));
    h.peer.refuse.store(false, Ordering::SeqCst);
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    *h.peer.capture_gate.lock().await = Some(Arc::new(Semaphore::new(0)));
    let capture = h.run.request("vnc.capture", json!({"sessionId":session}));
    let close = async {
        assert!(matches!(h.peer.event().await, super::peer::Event::Capture));
        h.run
            .request("vnc.session.close", json!({"sessionId":session}))
            .await
    };
    let (capture, close) = tokio::join!(capture, close);
    assert_eq!(capture.result()["reason"], "cancelled");
    assert_eq!(close.result()["outcome"], "closed");
    closed(&h).await;
    let latest = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&latest), diagnostic_text(&original));
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":diagnostic_attempt(&original)}),
        )
        .await;
    assert_eq!(diagnostic_text(&retained), diagnostic_text(&original));
    resolve.assert_calls_async(2).await;
    inventory.assert_calls_async(3).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn vnc_retained_session_disconnect_is_recorded_before_cleanup_and_query_does_not_capture() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    h.peer.disconnect.cancel();
    let capture = h
        .run
        .request("vnc.capture", json!({"sessionId":session}))
        .await;
    assert_eq!(capture.result()["reason"], "disconnected");
    let automatic = diagnostic_text(capture.result());
    assert!(automatic.contains("VNC capture: failed."), "{automatic}");
    assert!(
        automatic.contains("VNC authentication: reused."),
        "{automatic}"
    );
    closed(&h).await;
    let history = h
        .run
        .passive("vnc.diagnose", json!({"sessionId":session}))
        .await;
    assert_eq!(history["status"], "found");
    assert_eq!(diagnostic_text(&history), automatic);
    assert!(diagnostic_text(&history).starts_with("Failure: VNC disconnected during capture."));
    assert!(diagnostic_text(&history).contains(&format!("Session: {session}\n")));
    resolve.assert_calls_async(1).await;
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    h.run.shutdown().await;
}

#[tokio::test]
async fn simultaneous_vnc_failures_return_their_own_exact_retained_attempt() {
    let mut h = Harness::new().await;
    h.run.enable_diagnostics(&h.runtime).await;
    let resolve = h.resolve().await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    let (a, b) = tokio::join!(h.start("shared"), h.start("exclusive"));
    assert_eq!(a.result()["reason"], "authentication_failed");
    assert_eq!(b.result()["reason"], "authentication_failed");
    let a_id = diagnostic_attempt(a.result());
    let b_id = diagnostic_attempt(b.result());
    assert_ne!(a_id, b_id);
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    for failure in [&a, &b] {
        let retained = h
            .run
            .passive(
                "vnc.diagnose",
                json!({"attemptId": diagnostic_attempt(failure.result())}),
            )
            .await;
        assert_eq!(retained["status"], "found");
        assert_eq!(
            diagnostic_text(&retained),
            diagnostic_text(failure.result())
        );
    }
    inventory.assert_calls_async(2).await;
    resolve.assert_calls_async(2).await;
    h.run.shutdown().await;
}
