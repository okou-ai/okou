use super::{
    closed,
    harness::{CONNECTION, CREATED_AT, Harness},
    mode,
};
use crate::test_fixtures::{diagnostic_text, remote_inventory};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn active_check_initializes_each_mode_closes_only_itself_and_preserves_failure() {
    let mut h = Harness::new().await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let _resolve = h.resolve().await;
    let _authority = h.check("valid", 200).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
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
    let before = h.run.passive("vnc.diagnose", json!({})).await;
    h.peer.refuse.store(false, Ordering::SeqCst);
    let foreground = h.start("shared").await.session();
    mode(&h, 1).await;
    for (sharing, flag) in [("shared", 1), ("exclusive", 0)] {
        let result = h
            .run
            .active_check(json!({"connectionId":CONNECTION,"mode":sharing}))
            .await;
        assert_eq!(result["status"], "passed", "{result}");
        assert!(diagnostic_text(&result).contains("Check-owned cleanup: passed."));
        // Any screenshot/input would appear here instead of the expected close.
        mode(&h, flag).await;
        closed(&h).await;
        assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    let second_foreground = h.start("shared").await.session();
    mode(&h, 1).await;
    let attempts = h.network.attempts.lock().unwrap().len();
    let blocked = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
        .await;
    assert_eq!(blocked["status"], "blocked", "{blocked}");
    assert_eq!(h.network.attempts.lock().unwrap().len(), attempts);
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    h.run
        .request("vnc.session.close", json!({"sessionId":second_foreground}))
        .await;
    closed(&h).await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    let failed = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
        .await;
    assert_eq!(failed["status"], "failed", "{failed}");
    closed(&h).await;
    assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
    h.run
        .request("vnc.session.close", json!({"sessionId":foreground}))
        .await;
    closed(&h).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn active_check_missing_mode_or_read_only_authority_never_opens_target() {
    let mut h = Harness::new().await;
    h.run.enable_checks(&h.runtime, &["vnc:read"]).await;
    let _resolve = h.resolve().await;
    // Error envelopes have no data; diagnostic_rpc returns null.
    assert!(
        h.run
            .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
            .await
            .is_null()
    );
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    assert!(
        h.run
            .active_check(json!({"connectionId":CONNECTION}))
            .await
            .is_null()
    );
    assert!(h.network.attempts.lock().unwrap().is_empty());
    h.run.shutdown().await;
}

#[tokio::test]
async fn active_check_timeout_retains_physical_dns_capacity_and_does_not_publish_observations() {
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    let mut h = Harness::new().await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let _resolve = h.resolve().await;
    let _authority = h.check("valid", 200).await;
    let observation = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path(format!("/api/runners/runs/{}/vnc/observations", h.run.id));
            then.status(200).json_body(json!({"outcome":"recorded"}));
        })
        .await;
    let gate = Arc::new(Semaphore::new(0));
    *h.network.resolve_gate.lock().unwrap() = Some(Arc::clone(&gate));
    for _ in 0..2 {
        let result = h
            .run
            .active_check_budget(json!({"connectionId":CONNECTION,"mode":"shared"}), 2000)
            .await;
        assert_eq!(result["status"], "failed", "{result}");
        assert!(diagnostic_text(&result).contains("timed out"));
        assert!(diagnostic_text(&result).contains("Check-owned cleanup: unknown."));
        assert!(diagnostic_text(&result).contains("VNC destination: unknown.\n  Elapsed:"));
        assert!(diagnostic_text(&result).contains("VNC retirement: not reached."));
    }
    let full = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
        .await;
    assert_eq!(full["status"], "blocked", "{full}");
    assert!(diagnostic_text(&full).contains("resource exhausted"));
    assert!(h.network.attempts.lock().unwrap().is_empty());
    // DNS descendants still own both session slots despite both RPC terminals.
    *h.network.resolve_gate.lock().unwrap() = None;
    gate.add_permits(2);
    h.run.shutdown().await;
    assert!(h.network.attempts.lock().unwrap().is_empty());
    observation.assert_calls_async(0).await;
}
