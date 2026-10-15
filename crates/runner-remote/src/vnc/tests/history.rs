use super::harness::CREATED_AT;
use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
};
use crate::test_fixtures::remote_inventory;
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Semaphore;

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
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "invalid_credential"
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
    assert_eq!(
        history["report"]["cause"],
        json!({"source":"vnc","code":"invalid_credential"})
    );
    assert_eq!(history["report"]["configuration_created_at"], CREATED_AT);
    assert_eq!(history["report"]["configuration_generation"], 7);
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
            json!({"attemptId":history["report"]["attempt_id"]}),
        )
        .await;
    assert_eq!(hidden["status"], "authority_unavailable");
    assert!(hidden["report"].is_null());
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
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "authentication_failed"
    );
    closed(&h).await;
    let original = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(
        original["report"]["cause"],
        json!({"source":"vnc","code":"authentication_failed"})
    );
    assert_eq!(original["report"]["configuration_generation"], 7);
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
    assert_eq!(latest["report"], original["report"]);
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":original["report"]["attempt_id"]}),
        )
        .await;
    assert_eq!(retained["report"], original["report"]);
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
    closed(&h).await;
    let history = h
        .run
        .passive("vnc.diagnose", json!({"sessionId":session}))
        .await;
    assert_eq!(history["status"], "found");
    assert_eq!(
        history["report"]["cause"],
        json!({"source":"vnc","code":"disconnected"})
    );
    assert_eq!(history["report"]["session_id"], session);
    resolve.assert_calls_async(1).await;
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    h.run.shutdown().await;
}
