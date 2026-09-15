use super::{
    harness::{AdditionalRun, Harness, Reply, frames, params, request_frames},
    terminal,
};
use serde_json::json;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

const UNKNOWN_REQUEST: &str = r#"{"version":1,"method":"unknown","params":{}}"#;

#[tokio::test]
async fn eight_requests_are_admitted_before_parsing_and_completed_exec_releases_a_slot() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(h.open().await);
    }
    assert_eq!(
        frames(h.open().await).await,
        vec![json!({"type":"error","code":"resource_exhausted","delivery":"not_dispatched"})]
    );
    resolve.assert_calls_async(0).await;
    assert!(h.control.try_fence_normal_operations().is_err());

    let result = request_frames(
        pending.pop().unwrap(),
        json!({"version":1,"method":"ssh.exec","remaining_ms":60000,"params":params()}).to_string(),
    )
    .await;
    assert_eq!(terminal(&result)["type"], "finished");
    // Seven unread requests still hold their slots; completed exec frees the eighth.
    assert_eq!(terminal(&h.request(params()).await)["type"], "finished");
    pending.push(h.open().await);
    assert_eq!(
        frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );

    h.shutdown().await;
    for guest in pending {
        assert!(frames(guest).await.is_empty());
    }
    assert_eq!(h.observed.reservations.load(Ordering::SeqCst), 0);
    drop(h.control.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn three_runs_share_a_runtime_and_admit_twenty_four_requests() {
    let mut h = Harness::new(Reply::default()).await;
    let second = AdditionalRun::new(&h.runtime, "sandbox-second").await;
    let third = AdditionalRun::new(&h.runtime, "sandbox-third").await;
    let mut pending = Vec::new();
    for _ in 0..8 {
        pending.push(h.open().await);
    }
    assert_eq!(
        frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    for run in [&second, &third] {
        for _ in 0..8 {
            pending.push(run.open().await);
        }
        assert_eq!(
            frames(run.open().await).await[0]["code"],
            "resource_exhausted"
        );
    }
    // All 24 stay admitted until now. A rejection on any of the first eight in
    // any Run would fail here, even if its ninth request was also rejected.
    for guest in pending {
        assert_eq!(
            request_frames(guest, UNKNOWN_REQUEST.into()).await[0]["code"],
            "unknown_method"
        );
    }
    h.shutdown().await;
    second.shutdown().await;
    third.shutdown().await;
}

#[tokio::test]
async fn timed_out_dns_keeps_its_run_slot_until_resolution_finishes() {
    let mut h = Harness::new(Reply::default()).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.network.resolve_gate.lock().unwrap() = Some(Arc::clone(&gate));
    let _resolve = h.resolve(h.credential(true)).await;
    let result = h
        .raw(
            json!({"version":1,"method":"ssh.exec","remaining_ms":2000,"params":params()})
                .to_string(),
        )
        .await;
    assert_eq!(terminal(&result)["failure_reason"], "timed_out");
    assert_eq!(terminal(&result)["effects"], "not_started");
    assert_eq!(h.observed.queries.lock().unwrap().len(), 1);
    drop(h.control.try_fence_normal_operations().unwrap());

    let mut pending = Vec::new();
    for _ in 0..7 {
        pending.push(h.open().await);
    }
    // Guest terminal+EOF released park protection, but the eighth slot is
    // still charged to the detached resolver in this otherwise active Run.
    assert_eq!(
        frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            // A non-effectful unknown-method probe observes actual admission
            // recovery, independently of when the resolver task is scheduled.
            let result = h.raw(UNKNOWN_REQUEST.into()).await;
            if result[0]["code"] == "unknown_method" {
                break;
            }
            assert_eq!(result[0]["code"], "resource_exhausted");
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    assert!(h.observed.commands.lock().unwrap().is_empty());
    for guest in pending {
        assert_eq!(
            request_frames(guest, UNKNOWN_REQUEST.into()).await[0]["code"],
            "unknown_method"
        );
    }
    h.shutdown().await;
    drop(h.control.try_fence_normal_operations().unwrap());
}
