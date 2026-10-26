//! SSH RPCs run without a subscription; delivered messages revoke authority.
//! Subscription health and supervisor lifetime belong to runner-provider.

use std::sync::atomic::Ordering;

use ably_subscriber::Message;
use runner_provider::AblySideMessageHandler;
use serde_json::{Value, json};

use super::{
    harness::{CONNECTION, Harness, Reply, params},
    output,
    sessions::{bytes, rpc, start, state, write},
    terminal, wait_for,
};

fn invalidation(h: &Harness, connection: Value) -> Message {
    Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId": h.run, "connectionId": connection}),
        id: None,
        client_id: None,
        timestamp: None,
    }
}

#[tokio::test]
async fn direct_sessions_run_without_a_subscription_and_honor_delivered_invalidation() {
    let mut h = Harness::new(Reply::Process).await;
    let resolve = h.resolve(h.credential(true)).await;
    session_continuity(&h).await;
    resolve.assert_calls_async(1).await;
    h.shutdown().await;
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
}

pub(super) async fn session_continuity(h: &Harness) {
    let idle = start(h, json!({"type":"shell"}), false).await;
    let active = start(h, json!({"type":"shell"}), false).await;
    state(h, &idle, "running").await;
    state(h, &active, "running").await;
    let mut cursor = json!(0);
    let mut expected = Vec::new();
    for index in 0..3 {
        let text = format!("chunk-{index}");
        write(h, &active, &format!("printf {text}\n"), false).await;
        let read = rpc(
            h,
            "read",
            json!({"sessionId": active, "cursor": cursor, "waitMs": 5000}),
        )
        .await;
        assert_eq!(bytes(&read), text.as_bytes());
        cursor = read["next_cursor"].clone();
        expected.extend_from_slice(text.as_bytes());
        state(h, &idle, "running").await;
        state(h, &active, "running").await;
    }
    state(h, &idle, "running").await;
    state(h, &active, "running").await;
    assert_eq!(
        bytes(&rpc(h, "read", json!({"sessionId": active, "cursor": 0})).await),
        expected
    );
    assert!(h.observed.commands.lock().unwrap().is_empty());

    // Fresh API-authorized work preserves the older session IDs.
    let fresh = start(h, json!({"type":"exec", "command":"printf fresh"}), false).await;
    state(h, &fresh, "finished").await;
    assert_eq!(
        bytes(&rpc(h, "read", json!({"sessionId": fresh, "cursor": 0})).await),
        b"fresh"
    );
    assert_eq!(
        rpc(h, "close", json!({"sessionId":fresh})).await["type"],
        "closed"
    );
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);

    write(h, &idle, "printf still-live; exit 0\n", false).await;
    state(h, &idle, "finished").await;
    assert_eq!(
        bytes(&rpc(h, "read", json!({"sessionId": idle, "cursor": 0})).await),
        b"still-live"
    );
    assert_eq!(
        rpc(h, "close", json!({"sessionId":idle})).await["type"],
        "closed"
    );

    assert!(
        h.runtime
            .handle(&invalidation(h, json!(uuid::Uuid::new_v4())))
    );
    state(h, &active, "running").await;
    // Delivered invalidation retires only its exact authority ID.
    assert!(h.runtime.handle(&invalidation(h, json!(CONNECTION))));
    assert_eq!(
        rpc(h, "status", json!({"sessionId":active})).await["failure_reason"],
        "unavailable"
    );
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == h.observed.auth.load(Ordering::SeqCst))
        .await;
}

#[tokio::test]
async fn admission_requires_api_authority_and_never_restores_revoked_snapshots() {
    let mut h = Harness::new(Reply::Process).await;
    let first = start(&h, json!({"type":"exec", "command":"never"}), false).await;
    assert_eq!(
        state(&h, &first, "failed").await["state"]["failure_reason"],
        "authority_failure"
    );
    let denied = h.resolve(json!({"outcome":"unavailable"})).await;
    let next = start(&h, json!({"type":"exec", "command":"never"}), false).await;
    assert_eq!(
        state(&h, &next, "failed").await["state"]["failure_reason"],
        "unavailable"
    );
    denied.delete_async().await;
    let granted = h.resolve(h.credential(true)).await;
    let mut request = params();
    request["command"] = json!("printf granted");
    assert_eq!(output(&h.request(request).await, "stdout"), b"granted");
    granted.delete_async().await;
    assert!(h.runtime.handle(&invalidation(&h, Value::Null)));
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authority_failure"
    );
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn direct_in_flight_exec_completes_once_without_a_subscription() {
    let mut h = Harness::new(Reply::Process).await;
    let _resolve = h.resolve(h.credential(true)).await;
    exec_continuity(&h).await;
    h.shutdown().await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}

pub(super) async fn exec_continuity(h: &Harness) {
    let dir = tempfile::tempdir().unwrap();
    let release = dir.path().join("release");
    let mut request = params();
    request["command"] = json!(format!(
        "while [ ! -e '{}' ]; do sleep 0.01; done; printf once",
        release.display()
    ));
    let (frames, ()) = tokio::join!(h.request(request), async {
        wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
        std::fs::write(&release, []).unwrap();
    });
    assert_eq!(terminal(&frames)["type"], "finished");
    assert_eq!(terminal(&frames)["exit"]["code"], 0);
    assert_eq!(output(&frames, "stdout"), b"once");
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn delivered_invalidation_interrupts_in_flight_exec_without_a_subscription() {
    let mut h = Harness::new(Reply::Hold).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let (frames, ()) = tokio::join!(h.request(params()), async {
        wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
        assert!(h.runtime.handle(&invalidation(&h, Value::Null)));
    });
    assert_eq!(terminal(&frames)["type"], "failed");
    assert_eq!(terminal(&frames)["effects"], "unknown");
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    h.shutdown().await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}
