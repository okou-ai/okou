use super::harness::CREATED_AT;
use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
};
use crate::test_fixtures::remote_inventory;
use serde_json::json;
use std::sync::atomic::Ordering;

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
    assert_eq!(
        h.run
            .request("vnc.session.close", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "closed"
    );
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":original["report"]["attempt_id"]}),
        )
        .await;
    assert_eq!(retained["report"], original["report"]);
    resolve.assert_calls_async(2).await;
    inventory.assert_calls_async(2).await;
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
