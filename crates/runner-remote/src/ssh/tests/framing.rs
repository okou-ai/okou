use super::harness::{CONNECTION, Harness, Reply, frames};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn complete_request_dispatches_once_with_immediate_or_delayed_extra_frames() {
    for delayed in [false, true] {
        let mut h = Harness::new(Reply::default()).await;
        let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
        *h.network.resolve_gate.lock().unwrap() = Some(gate.clone());
        let resolve = h.resolve(h.credential(true)).await;
        let request = json!({
            "version": 1, "method": "ssh.exec", "remaining_ms": 60000,
            "params": {"sshConnectionId": CONNECTION, "command": "first"}
        })
        .to_string();
        let extra = json!({
            "version": 1, "method": "ssh.exec", "remaining_ms": 60000,
            "params": {"sshConnectionId": CONNECTION, "command": "second"}
        })
        .to_string();
        let mut guest = h.open().await;
        guest.write_u32(request.len() as u32).await.unwrap();
        guest.write_all(request.as_bytes()).await.unwrap();
        if delayed {
            // The external resolver has received the first operation's lookup.
            // Hold its answer while sending more bytes after dispatch began.
            super::wait_for(|| !h.observed.queries.lock().unwrap().is_empty()).await;
        }
        guest.write_u32(extra.len() as u32).await.unwrap();
        guest.write_all(extra.as_bytes()).await.unwrap();
        // Deliberately keep the write side open throughout the response.
        gate.add_permits(1);
        let observed = tokio::time::timeout(Duration::from_secs(5), frames(guest))
            .await
            .unwrap();
        assert_eq!(super::terminal(&observed)["effects"], "completed");
        resolve.assert_calls_async(1).await;
        assert_eq!(
            *h.observed.commands.lock().unwrap(),
            vec![b"first".to_vec()]
        );
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 1);
        h.shutdown().await;
    }
}

#[tokio::test]
async fn unknown_method_rejects_without_peer_eof_or_authority_lookup() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    let mut guest = h.open().await;
    let request = br#"{"version":1,"method":"diagnostic.unknown","params":{}}"#;
    guest.write_u32(request.len() as u32).await.unwrap();
    guest.write_all(request).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), frames(guest))
            .await
            .unwrap(),
        vec![json!({"type":"error","code":"unknown_method","delivery":"not_dispatched"})]
    );
    resolve.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
    h.shutdown().await;
}
