use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use serde_json::json;
use tokio::sync::Semaphore;

use super::{
    closed,
    harness::{CONNECTION, Harness, bounded, read, send},
    mode,
    peer::Event,
};

async fn input_bytes(h: &Harness, expected: &[Vec<u8>]) {
    for bytes in expected {
        match h.peer.event().await {
            Event::Input(actual) => assert_eq!(&actual, bytes),
            _ => panic!("expected input bytes"),
        }
    }
}

fn key(down: bool, code: u32) -> Vec<u8> {
    let mut bytes = vec![4, u8::from(down), 0, 0];
    bytes.extend(code.to_be_bytes());
    bytes
}

#[tokio::test]
async fn unicode_chord_drag_and_scroll_reach_server_once_with_balanced_releases() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    for (input, expected) in [
        (
            json!({"type":"text","text":"中"}),
            vec![key(true, 0x01004e2d), key(false, 0x01004e2d)],
        ),
        (
            json!({"type":"key_chord","keys":["Control","a"]}),
            vec![
                key(true, 0xffe3),
                key(true, 0x61),
                key(false, 0x61),
                key(false, 0xffe3),
            ],
        ),
    ] {
        assert_eq!(
            h.run
                .request("vnc.input", json!({"sessionId":session,"input":input}))
                .await
                .result()["outcome"],
            "sent"
        );
        input_bytes(&h, &expected).await;
    }
    let capture = h
        .run
        .request("vnc.capture", json!({"sessionId":session}))
        .await;
    assert!(matches!(h.peer.event().await, Event::Capture));
    let geometry = &capture.controls[0]["data"]["geometry"];
    for (input, expected) in [
        (
            json!({"type":"drag","geometry":geometry,"points":[[0,0],[1,0]],"button":"left"}),
            vec![
                vec![5, 1, 0, 0, 0, 0],
                vec![5, 1, 0, 1, 0, 0],
                vec![5, 0, 0, 1, 0, 0],
            ],
        ),
        (
            json!({"type":"scroll","geometry":geometry,"x":1,"y":0,"axis":"horizontal","steps":-2}),
            vec![
                vec![5, 32, 0, 1, 0, 0],
                vec![5, 0, 0, 1, 0, 0],
                vec![5, 32, 0, 1, 0, 0],
                vec![5, 0, 0, 1, 0, 0],
            ],
        ),
    ] {
        assert_eq!(
            h.run
                .request("vnc.input", json!({"sessionId":session,"input":input}))
                .await
                .result()["outcome"],
            "sent"
        );
        assert!(matches!(h.peer.event().await, Event::Capture));
        input_bytes(&h, &expected).await;
    }
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
    closed(&h).await;
}

#[tokio::test]
async fn stale_geometry_is_not_started_and_preserves_untouched_session() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    let reply = h.run.request("vnc.input", json!({"sessionId":session,"input":{
        "type":"click","geometry":{"sessionId":uuid::Uuid::new_v4(),"epoch":0},"x":0,"y":0,"button":"left"}})).await;
    assert_eq!(
        reply.result(),
        &json!({"outcome":"not_started","reason":"stale_geometry"})
    );
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "status"
    );
    h.run
        .request("vnc.session.close", json!({"sessionId":session}))
        .await;
    // Neither refresh nor pointer events were emitted for the foreign geometry.
    closed(&h).await;
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn server_refusal_and_disconnect_fail_without_reconnect_or_mode_retry() {
    for refusal in [true, false] {
        let mut h = Harness::new().await;
        let resolve = h.resolve().await;
        let _check = h.check("valid", 200).await;
        h.peer.refuse.store(refusal, Ordering::SeqCst);
        let started = h.start("exclusive").await;
        if refusal {
            assert_eq!(started.result()["outcome"], "failed");
            assert_eq!(started.result()["reason"], "authentication_failed");
            closed(&h).await;
        } else {
            let session = started.session();
            mode(&h, 0).await;
            h.peer.disconnect.cancel();
            closed(&h).await;
            let reply = h
                .run
                .request("vnc.capture", json!({"sessionId":session}))
                .await;
            assert_eq!(reply.result()["outcome"], "failed");
            assert_eq!(reply.result()["reason"], "disconnected");
        }
        resolve.assert_calls_async(1).await;
        assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn timed_out_dns_retains_session_capacity_until_resolution_completes() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let gate = Arc::new(Semaphore::new(0));
    *h.network.resolve_gate.lock().unwrap() = Some(Arc::clone(&gate));
    for _ in 0..2 {
        let reply = h
            .run
            .raw(
                json!({"version":1,"method":"vnc.session.start","remaining_ms":2000,
            "params":{"connectionId":CONNECTION,"mode":"shared"}})
                .to_string(),
            )
            .await;
        assert_eq!(
            reply.result(),
            &json!({"outcome":"failed","reason":"timed_out"})
        );
    }
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "resource_exhausted"
    );
    assert!(h.network.attempts.lock().unwrap().is_empty());
    *h.network.resolve_gate.lock().unwrap() = None;
    gate.add_permits(2);
    bounded(async {
        loop {
            let reply = h.start("shared").await;
            if reply.result()["outcome"] == "started" {
                break;
            }
            assert_eq!(reply.result()["reason"], "resource_exhausted");
            tokio::task::yield_now().await;
        }
    })
    .await;
    mode(&h, 1).await;
    assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
    resolve.assert_calls_async(3).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn idle_session_expires_without_waiting_for_a_followup_operation() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let check = h.check("valid", 200).await;
    h.start("shared").await.session();
    mode(&h, 1).await;
    // Advance only the two-hour lifetime; do not pause while driving HTTP/TLS.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2 * 60 * 60 + 1)).await;
    tokio::time::resume();
    closed(&h).await;
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    resolve.assert_calls_async(1).await;
    check.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn cancellation_between_data_and_end_reports_unknown_error_and_eof() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    let mut guest = h.run.open_stream(true).await;
    send(&mut guest, &json!({"version":1,"method":"vnc.capture","remaining_ms":60000,"params":{"sessionId":session}}).to_string()).await;
    // The host stream cancels this Run synchronously only after a whole Data
    // frame has flushed, when the codec can still emit a valid error terminal.
    let reply = read(guest).await;
    assert!(!reply.bytes.is_empty());
    assert!(!reply.ended);
    assert_eq!(
        reply.controls.last().unwrap(),
        &json!({"type":"error","code":"transport","delivery":"unknown"})
    );
    assert!(matches!(h.peer.event().await, Event::Capture));
    closed(&h).await;
    h.run.shutdown().await;
}
