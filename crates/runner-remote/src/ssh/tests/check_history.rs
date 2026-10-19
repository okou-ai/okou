use super::{
    harness::{CONNECTION, CREATED_AT, Harness, Reply, params},
    terminal, wait_for,
};
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::io::AsyncWriteExt;

async fn rpc(h: &Harness, method: &str, params: Value) -> Value {
    terminal(
        &h.raw(
            json!({"version":1,"method":method,"remaining_ms":10000,"params":params}).to_string(),
        )
        .await,
    )
    .clone()
}

#[tokio::test]
async fn check_history_recovers_lost_response_then_reauthorizes_exact_creation_identity() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_checks(&["ssh:read", "ssh:write"]).await;
    let resolve = h.resolve(h.credential(true)).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    assert_eq!(
        rpc(&h, "ssh.diagnose", json!({"checks":true})).await["status"],
        "not_retained"
    );
    // Send one real check, then lose the response channel before any returned ID.
    let request = json!({"version":1,"method":"ssh.check","remaining_ms":10000,"params":{"connectionId":CONNECTION}}).to_string();
    let mut guest = h.open().await;
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    drop(guest);
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
    let retained = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let query = rpc(
                &h,
                "ssh.diagnose",
                json!({"checks":true,"connectionId":CONNECTION}),
            )
            .await;
            if query["status"] == "found" {
                break query;
            }
            assert_eq!(query["status"], "not_retained");
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let message = diagnostic_text(&retained);
    assert!(message.starts_with("Active check (SSH): passed. Checked at:"));
    assert!(message.contains("Check-owned cleanup: passed."));
    assert!(message.contains("Helper delivery is unconfirmed"));
    assert!(
        message.contains("Without an exact Attempt, latest history may identify another check")
    );
    assert!(message.len() <= 8192);
    let attempt = diagnostic_attempt(&retained);
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":attempt})
        )
        .await,
        retained
    );
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":uuid::Uuid::new_v4()})
        )
        .await["status"],
        "not_retained"
    );
    assert_eq!(
        rpc(&h, "ssh.diagnose", json!({"attemptId":attempt})).await["status"],
        "not_retained"
    );
    assert_eq!(
        rpc(&h, "ssh.diagnose", json!({})).await["status"],
        "no_failure"
    );
    inventory.delete_async().await;
    for (hosts, created_at) in [
        (vec![], CREATED_AT),
        (vec![(CONNECTION, 7)], "2026-09-01T00:00:00.123457Z"),
    ] {
        let denied = h
            .api
            .mock_async(|when, then| {
                when.method("GET").path("/api/ssh/hosts");
                then.status(200)
                    .json_body(remote_inventory(&hosts, created_at));
            })
            .await;
        let query = rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":attempt}),
        )
        .await;
        assert_eq!(query["status"], "authority_unavailable");
        assert!(!diagnostic_text(&query).contains(CONNECTION));
        assert!(!diagnostic_text(&query).contains(&attempt.to_string()));
        denied.delete_async().await;
    }
    resolve.assert_calls_async(1).await;
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    assert!(h.observed.forwards.lock().unwrap().is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn check_history_evicts_only_old_completions_without_changing_operational_pins() {
    let mut h = Harness::new(Reply::default()).await;
    h.enable_checks(&["ssh:write", "ssh:read"]).await;
    let resolve = h.resolve(json!({"outcome":"unavailable"})).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/ssh/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "unavailable"
    );
    let failure = rpc(&h, "ssh.diagnose", json!({})).await;
    let mut receipts = Vec::new();
    for _ in 0..65 {
        let receipt = rpc(&h, "ssh.check", json!({"connectionId":CONNECTION})).await;
        assert_eq!(receipt["status"], "blocked");
        assert!(diagnostic_text(&receipt).contains("Check-owned cleanup: unknown."));
        receipts.push(receipt);
    }
    let evicted = rpc(
        &h,
        "ssh.diagnose",
        json!({"checks":true,"attemptId":diagnostic_attempt(&receipts[0])}),
    )
    .await;
    assert_eq!(evicted["status"], "not_retained");
    assert!(
        diagnostic_text(&evicted)
            .contains("Missing evidence proves neither connectivity nor cleanup")
    );
    for index in [1, 64] {
        let retained = rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&receipts[index])}),
        )
        .await;
        assert_eq!(retained["status"], "found");
        assert_eq!(retained["message"], receipts[index]["message"]);
    }
    assert_eq!(
        rpc(&h, "ssh.diagnose", json!({"checks":true})).await["message"],
        receipts[64]["message"]
    );
    assert_eq!(rpc(&h, "ssh.diagnose", json!({})).await, failure);
    assert_eq!(
        rpc(
            &h,
            "ssh.diagnose",
            json!({"checks":true,"attemptId":diagnostic_attempt(&failure)})
        )
        .await["status"],
        "not_retained"
    );
    resolve.assert_calls_async(66).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    h.shutdown().await;
}
