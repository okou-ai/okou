use super::{
    closed,
    harness::{CONNECTION, CREATED_AT, Harness},
    mode,
};
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn active_check_initializes_each_mode_closes_only_itself_and_preserves_failure() {
    let mut h = Harness::new().await;
    h.run
        .enable_checks(&h.runtime, &["vnc:read", "vnc:write"])
        .await;
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
        let retained = h
            .run
            .passive(
                "vnc.diagnose",
                json!({"checks":true,"attemptId":diagnostic_attempt(&result)}),
            )
            .await;
        assert_eq!(retained["status"], "found");
        assert_eq!(retained["message"], result["message"]);
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
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&blocked)}),
        )
        .await;
    assert_eq!(retained["status"], "found");
    assert_eq!(retained["message"], blocked["message"]);
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
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&failed)}),
        )
        .await;
    assert_eq!(retained["status"], "found");
    assert_eq!(retained["message"], failed["message"]);
    closed(&h).await;
    assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
    h.run
        .request("vnc.session.close", json!({"sessionId":foreground}))
        .await;
    closed(&h).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn check_history_survives_failed_vnc_delivery_without_replay() {
    use super::harness::bounded;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut h = Harness::new().await;
    h.run
        .enable_checks(&h.runtime, &["vnc:read", "vnc:write"])
        .await;
    let resolve = h.resolve().await;
    let _authority = h.check("valid", 200).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    let mut guest = h.run.open_failing_output().await;
    let request = json!({"version":1,"method":"vnc.check","remaining_ms":10000,
        "params":{"connectionId":CONNECTION,"mode":"shared"}})
    .to_string();
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    // The production response writer fails after Runner has finished the check.
    let mut bytes = Vec::new();
    assert_eq!(bounded(guest.read_to_end(&mut bytes)).await.unwrap(), 0);
    mode(&h, 1).await;
    closed(&h).await;
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"checks":true,"connectionId":CONNECTION}),
        )
        .await;
    assert_eq!(retained["status"], "found", "{retained}");
    assert!(diagnostic_text(&retained).starts_with("Active check (VNC): passed. Checked at:"));
    assert!(diagnostic_text(&retained).contains("Helper delivery is unconfirmed"));
    let attempt = diagnostic_attempt(&retained);
    assert_eq!(
        h.run
            .passive("vnc.diagnose", json!({"checks":true,"attemptId":attempt}))
            .await,
        retained
    );
    assert_eq!(
        h.run.passive("vnc.diagnose", json!({})).await["status"],
        "no_failure"
    );
    inventory.assert_calls_async(3).await;
    resolve.assert_calls_async(1).await;
    assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
    h.run.shutdown().await;
}

#[tokio::test]
async fn check_history_query_cannot_disclose_after_assignment_changes_during_authorization() {
    use super::harness::{bounded, resolved_response};
    use super::peer::Peer;
    use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, http_response};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let inventory = http_response(
        "200 OK",
        remote_inventory(&[(CONNECTION, 7)], CREATED_AT)
            .to_string()
            .as_bytes(),
    );
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(resolved_response(
            &json!({"outcome":"unavailable"}).to_string(),
        )),
        RawHttpAction::Respond(inventory),
        RawHttpAction::WaitForDisconnect,
    ])
    .await;
    let mut h = Harness::with_authority(Peer::new().await, Some(server.url())).await;
    h.run
        .enable_checks(&h.runtime, &["vnc:read", "vnc:write"])
        .await;
    let receipt = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
        .await;
    assert_eq!(receipt["status"], "blocked");
    assert!(
        server
            .next_request("check credential authority")
            .await
            .contains("/vnc/resolve")
    );
    let attempt = diagnostic_attempt(&receipt);
    let control = h
        .run
        .passive("vnc.diagnose", json!({"checks":true,"attemptId":attempt}))
        .await;
    assert_eq!(control["status"], "found", "{control}");
    assert_eq!(diagnostic_text(&control), diagnostic_text(&receipt));
    assert!(
        server
            .next_request("unchanged check-history authority")
            .await
            .starts_with("GET /api/vnc/hosts ")
    );
    let mut guest = h.run.open().await;
    let request = json!({"version":1,"method":"vnc.diagnose",
        "params":{"checks":true,"attemptId":attempt}})
    .to_string();
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    // The external metadata server holds this read across assignment replacement.
    assert!(
        server
            .next_request("pending check-history authority")
            .await
            .starts_with("GET /api/vnc/hosts ")
    );
    let mut replacement = h.run.reassign();
    let mut stale = Vec::new();
    bounded(guest.read_to_end(&mut stale)).await.unwrap();
    assert!(stale.is_empty(), "reassignment must close the stale RPC");
    assert!(!String::from_utf8_lossy(&stale).contains(CONNECTION));
    assert!(!String::from_utf8_lossy(&stale).contains(&attempt.to_string()));
    assert!(h.network.attempts.lock().unwrap().is_empty());
    replacement.shutdown().await;
    h.run.shutdown().await;
    server.assert_finished().await;
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
