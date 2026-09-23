use std::{sync::atomic::Ordering, time::Duration};

use ably_subscriber::{Event, Message};
use serde_json::{Value, json};

use super::{
    harness::{CONNECTION, Harness, Reply, params},
    output,
    sessions::{bytes, rpc, start, state, write},
    terminal, wait_for,
};

pub(super) fn outage_events() -> Vec<Option<Event>> {
    vec![
        Some(Event::Connected),
        Some(Event::Disconnected {
            reason: Some("connection reset".into()),
        }),
        Some(Event::Connected),
        Some(Event::Disconnected { reason: None }),
        Some(Event::Connected),
        Some(Event::Error {
            code: 40142,
            message: "subscription unavailable".into(),
        }),
        None,
    ]
}

fn invalidation(h: &Harness, connection: Value) -> Option<Event> {
    Some(Event::Message(Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId": h.run, "connectionId": connection}),
        id: None,
        client_id: None,
        timestamp: None,
    }))
}

#[tokio::test]
async fn direct_sessions_survive_notification_outages_without_replaying_work() {
    let mut h = Harness::new(Reply::Process).await;
    let resolve = h.resolve(h.credential(true)).await;
    session_continuity(&h).await;
    resolve.assert_calls_async(1).await;
    h.shutdown().await;
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
}

pub(super) async fn session_continuity(h: &Harness) {
    let mut notifications = h.notifications();
    // Neither session waits for initial subscription readiness.
    let idle = start(h, json!({"type":"shell"}), false).await;
    let active = start(h, json!({"type":"shell"}), false).await;
    state(h, &idle, "running").await;
    state(h, &active, "running").await;
    let mut cursor = json!(0);
    let mut expected = Vec::new();
    for (index, event) in outage_events().into_iter().enumerate() {
        notifications.send(event).await;
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
    // No reconnect/grace deadline: exceed the supervisor's prolonged-outage threshold.
    // Ordinary idle-pool expiration is allowed; these active session transports remain live.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(65)).await;
    tokio::time::resume();
    state(h, &idle, "running").await;
    state(h, &active, "running").await;
    assert_eq!(
        bytes(&rpc(h, "read", json!({"sessionId": active, "cursor": 0})).await),
        expected
    );
    assert!(h.observed.commands.lock().unwrap().is_empty());

    // A new session is admitted during the outage; the older sessions keep their IDs.
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

    // Retiring the notification supervisor is not retiring the Run.
    drop(notifications);
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

    let mut notifications = h.notifications();
    notifications
        .send(invalidation(h, json!(uuid::Uuid::new_v4())))
        .await;
    state(h, &active, "running").await;
    // Delivered invalidation still retires the exact ID, even while disconnected.
    notifications.send(invalidation(h, json!(CONNECTION))).await;
    assert_eq!(
        rpc(h, "status", json!({"sessionId":active})).await["failure_reason"],
        "unavailable"
    );
    notifications.send(Some(Event::Connected)).await;
    assert_eq!(
        rpc(h, "status", json!({"sessionId":active})).await["failure_reason"],
        "unavailable"
    );
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == h.observed.auth.load(Ordering::SeqCst))
        .await;
}

#[tokio::test]
async fn outage_admission_still_requires_api_authority_and_never_restores_revoked_snapshots() {
    let mut h = Harness::new(Reply::Process).await;
    let mut notifications = h.notifications();
    notifications
        .send(Some(Event::Error {
            code: 40142,
            message: "unavailable".into(),
        }))
        .await;
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
    notifications.send(invalidation(&h, Value::Null)).await;
    notifications.send(Some(Event::Connected)).await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authority_failure"
    );
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn direct_in_flight_exec_completes_once_across_notification_outages() {
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
        let mut notifications = h.notifications();
        for event in outage_events() {
            notifications.send(event).await;
        }
        drop(notifications);
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
        let mut notifications = h.notifications();
        notifications.send(invalidation(&h, Value::Null)).await;
    });
    assert_eq!(terminal(&frames)["type"], "failed");
    assert_eq!(terminal(&frames)["effects"], "unknown");
    assert_eq!(h.observed.commands.lock().unwrap().len(), 1);
    h.shutdown().await;
    wait_for(|| h.observed.closed.load(Ordering::SeqCst) == 1).await;
}
