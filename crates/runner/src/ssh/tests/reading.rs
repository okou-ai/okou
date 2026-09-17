use std::time::Duration;

use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::json;
use tokio::{io::AsyncWriteExt, time::timeout};

use super::{
    harness::{CONNECTION, Harness, Reply},
    sessions::{bytes, envelope, rpc, start, state, write},
    wait_for,
};

#[tokio::test]
async fn quiet_wait_expires_normally_and_immediate_read_preserves_the_shell() {
    let mut h = Harness::new(Reply::Process).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &id, "running").await;
    let immediate = rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await;
    assert_eq!(immediate["wait_expired"], false);
    let waited = rpc(&h, "read", json!({"sessionId":id,"cursor":0,"waitMs":30})).await;
    assert_eq!(waited["wait_expired"], true);
    assert_eq!(waited["session"]["state"]["type"], "running");
    assert_eq!(waited["next_cursor"], 0);
    assert!(bytes(&waited).is_empty());
    write(&h, &id, "printf alive; exit 7\n", true).await;
    state(&h, &id, "finished").await;
    let read = rpc(
        &h,
        "read",
        json!({"sessionId":id,"cursor":0,"waitMs":30000}),
    )
    .await;
    assert_eq!(bytes(&read), b"alive");
    assert_eq!(read["wait_expired"], false);
    assert_eq!(read["session"]["state"]["exit"]["code"], 7);
    h.shutdown().await;
}

#[tokio::test]
async fn all_waiting_readers_wake_on_output_while_saturated_waits_leave_control_available() {
    let mut h = Harness::new(Reply::Process).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &id, "running").await;
    let mut readers = (0..3)
        .map(|_| {
            rpc(
                &h,
                "read",
                json!({"sessionId":id,"cursor":0,"waitMs":30000}),
            )
        })
        .collect::<FuturesUnordered<_>>();
    // The actual resource-exhausted reply proves two other requests hold the
    // waiting capacity, without inspecting a semaphore or sleeping to race it.
    let rejected = timeout(Duration::from_secs(5), readers.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rejected["failure_reason"], "resource_exhausted");
    assert_eq!(rejected["effects"], "not_started");
    state(&h, &id, "running").await;
    write(&h, &id, "printf progress\n", false).await;
    for _ in 0..2 {
        let read = timeout(Duration::from_secs(5), readers.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes(&read), b"progress");
        assert_eq!(read["wait_expired"], false);
        assert_eq!(read["next_cursor"], 8);
    }
    drop(readers);
    state(&h, &id, "running").await;
    assert_eq!(
        rpc(&h, "close", json!({"sessionId":id})).await["type"],
        "closed"
    );
    h.shutdown().await;
}

#[tokio::test]
async fn terminal_and_retirement_wake_quiet_readers() {
    #[derive(Clone, Copy)]
    enum Action {
        Exit,
        Close,
        Invalidate,
    }
    for action in [Action::Exit, Action::Close, Action::Invalidate] {
        let mut h = Harness::new(Reply::Process).await;
        let _resolve = h.resolve(h.credential(true)).await;
        let id = start(&h, json!({"type":"shell"}), false).await;
        state(&h, &id, "running").await;
        let mut readers = (0..3)
            .map(|_| {
                rpc(
                    &h,
                    "read",
                    json!({"sessionId":id,"cursor":0,"waitMs":30000}),
                )
            })
            .collect::<FuturesUnordered<_>>();
        assert_eq!(
            timeout(Duration::from_secs(5), readers.next())
                .await
                .unwrap()
                .unwrap()["failure_reason"],
            "resource_exhausted"
        );
        match action {
            Action::Exit => write(&h, &id, "exit 9\n", true).await,
            Action::Close => {
                assert_eq!(
                    rpc(&h, "close", json!({"sessionId":id})).await["type"],
                    "closed"
                );
            }
            Action::Invalidate => {
                h.runtime.ably_message(&ably_subscriber::Message {
                    name: Some("ssh-authority-invalidated".into()),
                    data: json!({"runId":h.run,"connectionId":CONNECTION}),
                    id: None,
                    client_id: None,
                    timestamp: None,
                });
            }
        }
        for _ in 0..2 {
            let read = timeout(Duration::from_secs(5), readers.next())
                .await
                .unwrap()
                .unwrap();
            if matches!(action, Action::Exit) {
                assert_eq!(read["session"]["state"]["exit"]["code"], 9);
                assert_eq!(read["wait_expired"], false);
                assert!(bytes(&read).is_empty());
            } else {
                assert_eq!(read["failure_reason"], "unavailable");
            }
        }
        drop(readers);
        h.shutdown().await;
    }
}

#[tokio::test]
async fn byte_and_chunk_budgets_preserve_terminal_output_and_exact_continuation() {
    let payload = (0..12000).map(|i| i as u8).collect::<Vec<_>>();
    let mut h = Harness::new(Reply::Exit {
        stdout: payload.clone(),
        stderr: b"stderr".to_vec(),
        fragment: 4096,
        code: Some(3),
        signal: None,
    })
    .await;
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"exec","command":"binary"}), false).await;
    state(&h, &id, "finished").await;
    let first = rpc(
        &h,
        "read",
        json!({"sessionId":id,"cursor":0,"maxBytes":7,"maxChunks":1,"waitMs":30000}),
    )
    .await;
    assert_eq!(bytes(&first), payload[..7]);
    assert_eq!(first["next_cursor"], 7);
    assert_eq!(first["session"]["end_cursor"], 12006);
    assert_eq!(first["wait_expired"], false);
    let second = rpc(&h, "read", json!({"sessionId":id,"cursor":7,"maxChunks":1})).await;
    assert_eq!(bytes(&second), payload[7..4096]);
    assert_eq!(second["chunks"].as_array().unwrap().len(), 1);
    let mut cursor = 4096;
    let mut combined = [bytes(&first), bytes(&second)].concat();
    while cursor < 12006 {
        let read = rpc(&h, "read", json!({"sessionId":id,"cursor":cursor})).await;
        combined.extend(bytes(&read));
        cursor = read["next_cursor"].as_u64().unwrap();
    }
    assert_eq!(combined, [payload, b"stderr".to_vec()].concat());
    h.shutdown().await;
}

#[tokio::test]
async fn invalid_read_limits_are_rejected_without_resolving_a_host() {
    let h = Harness::new(Reply::Hold).await;
    let resolve = h.resolve(h.credential(true)).await;
    for (field, value) in [
        ("waitMs", 30001),
        ("maxBytes", 0),
        ("maxBytes", 8193),
        ("maxChunks", 0),
        ("maxChunks", 33),
    ] {
        let mut params = json!({"sessionId":CONNECTION,"cursor":0});
        params[field] = json!(value);
        let frames = h.raw(envelope("read", params)).await;
        assert_eq!(frames[0]["code"], "invalid_request");
    }
    resolve.assert_calls_async(0).await;
}

#[tokio::test]
async fn abandoned_wait_releases_its_guest_reservation_without_stopping_the_shell() {
    let mut h = Harness::new(Reply::Process).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let id = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &id, "running").await;
    let mut guest = h.open().await;
    let request = envelope("read", json!({"sessionId":id,"cursor":0,"waitMs":1000}));
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request.as_bytes()).await.unwrap();
    // Observe actual request ownership before disconnecting; a successful fence
    // before dispatch would not establish cleanup of this abandoned reader.
    wait_for(|| h.control.try_fence_normal_operations().is_err()).await;
    drop(guest);
    wait_for(|| h.control.try_fence_normal_operations().is_ok()).await;
    state(&h, &id, "running").await;
    write(&h, &id, "printf survived; exit\n", true).await;
    state(&h, &id, "finished").await;
    assert_eq!(
        bytes(&rpc(&h, "read", json!({"sessionId":id,"cursor":0})).await),
        b"survived"
    );
    h.shutdown().await;
}
