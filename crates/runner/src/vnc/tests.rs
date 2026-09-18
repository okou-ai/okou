mod boundaries;
mod delivery;
mod harness;
mod list;
mod list_lifecycle;
mod peer;

use std::{io::Cursor, sync::Arc};

use serde_json::json;
use tokio::{io::AsyncReadExt, sync::Semaphore};

use harness::{CONNECTION, Harness, TestRun, bounded, send};
use peer::Event;

async fn mode(h: &Harness, expected: u8) {
    match h.peer.event().await {
        Event::Mode(actual) => assert_eq!(actual, expected),
        _ => panic!("expected ClientInit sharing flag"),
    }
}

async fn closed(h: &Harness) {
    assert!(matches!(h.peer.event().await, Event::Closed));
}

#[tokio::test]
async fn dispatcher_streams_fresh_png_and_geometry_then_balanced_input_and_close() {
    let mut h = Harness::new().await;
    let resolve = h.resolve_for_run(h.run.id).await;
    let check = h.check("valid", 200).await;
    let started = h.start("shared").await;
    let session = started.session();
    assert_eq!(started.result()["session"]["connectionId"], CONNECTION);
    assert_eq!(started.result()["session"]["mode"], "shared");
    mode(&h, 1).await;
    let capture = h
        .run
        .request("vnc.capture", json!({"sessionId":session}))
        .await;
    assert!(matches!(h.peer.event().await, Event::Capture));
    assert!(capture.ended);
    assert_eq!(
        capture.result(),
        &json!({"outcome":"captured","bytes":capture.bytes.len()})
    );
    let metadata = &capture.controls[0]["data"];
    assert_eq!(metadata["kind"], "capture");
    assert_eq!(metadata["width"], 2);
    assert_eq!(metadata["height"], 1);
    assert_eq!(metadata["mimeType"], "image/png");
    let mut decoder = png::Decoder::new(Cursor::new(&capture.bytes))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    let frame = decoder.next_frame(&mut pixels).unwrap();
    assert_eq!((frame.width, frame.height), (2, 1));
    assert_eq!(
        &pixels[..frame.buffer_size()],
        &[255, 0, 0, 255, 0, 0, 255, 255]
    );
    let input = h
        .run
        .request(
            "vnc.input",
            json!({"sessionId":session,"input":{
        "type":"click","geometry":metadata["geometry"],"x":1,"y":0,"button":"left"}}),
        )
        .await;
    assert_eq!(input.result()["outcome"], "sent");
    assert!(matches!(h.peer.event().await, Event::Capture));
    for expected in [vec![5, 1, 0, 1, 0, 0], vec![5, 0, 0, 1, 0, 0]] {
        match h.peer.event().await {
            Event::Input(actual) => assert_eq!(actual, expected),
            _ => panic!("expected pointer event"),
        }
    }
    let listed = h.run.request("vnc.session.list", json!({})).await;
    assert_eq!(listed.result()["sessions"][0]["sessionId"], session);
    let status = h
        .run
        .request("vnc.session.status", json!({"sessionId":session}))
        .await;
    assert_eq!(status.result()["session"]["mode"], "shared");
    assert_eq!(
        h.run
            .request("vnc.session.close", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "closed"
    );
    closed(&h).await;
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    resolve.assert_calls_async(1).await;
    check.assert_calls_async(5).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn independent_runs_forward_both_modes_and_reject_cross_run_session_ids() {
    let mut h = Harness::new().await;
    let resolve = h.resolve_for_run(h.run.id).await;
    let _check = h.check("valid", 200).await;
    let mut second = TestRun::new(&h.runtime);
    let second_resolve = h.resolve_for_run(second.id).await;
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    let other = second
        .request(
            "vnc.session.start",
            json!({"connectionId":CONNECTION,"mode":"exclusive"}),
        )
        .await
        .session();
    mode(&h, 0).await;
    assert_ne!(first, other);
    for method in ["vnc.session.status", "vnc.capture", "vnc.session.close"] {
        assert_eq!(
            second
                .request(method, json!({"sessionId":first}))
                .await
                .result()["outcome"],
            "failed"
        );
    }
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":first}))
            .await
            .result()["outcome"],
        "status"
    );
    assert_eq!(
        second
            .request("vnc.session.status", json!({"sessionId":other}))
            .await
            .result()["outcome"],
        "status"
    );
    resolve.assert_calls_async(1).await;
    second_resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
    second.shutdown().await;
    closed(&h).await;
    closed(&h).await;
}

#[tokio::test]
async fn invalid_and_duplicate_fields_are_rejected_before_api_or_network() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let requests = [
        json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":CONNECTION}}).to_string(),
        json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":CONNECTION,"mode":"shared","runId":h.run.id}}).to_string(),
        json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{"connectionId":CONNECTION,"mode":"shared","host":"127.0.0.1"}}).to_string(),
        format!(r#"{{"version":1,"method":"vnc.session.start","remaining_ms":60000,"params":{{"connectionId":"{CONNECTION}","mode":"shared","mode":"exclusive"}}}}"#),
    ];
    for request in requests {
        let reply = h.run.raw(request).await;
        assert_eq!(
            reply.result(),
            &json!({"outcome":"failed","reason":"invalid_input"})
        );
    }
    assert_eq!(
        h.run
            .request("vnc.session.unknown", json!({}))
            .await
            .controls
            .last()
            .unwrap()["code"],
        "unknown_method"
    );
    resolve.assert_calls_async(0).await;
    assert!(h.network.attempts.lock().unwrap().is_empty());
    h.run.shutdown().await;
}

#[tokio::test]
async fn denied_changed_and_failed_authority_close_before_any_input() {
    for (outcome, status, reason) in [
        ("unavailable", 200, "unavailable"),
        ("configuration_changed", 200, "configuration_changed"),
        ("sensitive-secret-provider-error", 500, "authority_failure"),
    ] {
        let mut h = Harness::new().await;
        let resolve = h.resolve().await;
        let allowed = h.check("valid", 200).await;
        let session = h.start("shared").await.session();
        mode(&h, 1).await;
        allowed.delete_async().await;
        let denied = h.check(outcome, status).await;
        let reply = h
            .run
            .request(
                "vnc.input",
                json!({"sessionId":session,"input":{"type":"text","text":"a"}}),
            )
            .await;
        assert_eq!(reply.result()["outcome"], "not_started");
        assert_eq!(reply.result()["reason"], reason);
        assert!(
            !serde_json::to_string(&reply.controls)
                .unwrap()
                .contains("sensitive-secret")
        );
        closed(&h).await;
        denied.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn unsafe_dns_answer_rejects_without_connecting() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    h.network
        .answers
        .lock()
        .unwrap()
        .push("127.0.0.1:5900".parse().unwrap());
    let reply = h.start("shared").await;
    assert_eq!(reply.result()["outcome"], "failed");
    assert_eq!(reply.result()["reason"], "unsafe_destination");
    assert!(h.network.attempts.lock().unwrap().is_empty());
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn session_limits_apply_per_run_and_host_and_close_returns_capacity() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let mut second = TestRun::new(&h.runtime);
    let mut third = TestRun::new(&h.runtime);
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    h.start("shared").await.session();
    mode(&h, 1).await;
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "resource_exhausted"
    );
    for _ in 0..2 {
        second
            .request(
                "vnc.session.start",
                json!({"connectionId":CONNECTION,"mode":"shared"}),
            )
            .await
            .session();
        mode(&h, 1).await;
    }
    assert_eq!(
        third
            .request(
                "vnc.session.start",
                json!({"connectionId":CONNECTION,"mode":"shared"})
            )
            .await
            .result()["reason"],
        "resource_exhausted"
    );
    h.run
        .request("vnc.session.close", json!({"sessionId":first}))
        .await;
    closed(&h).await;
    // Closing observes actual socket cleanup before the replacement admission.
    third
        .request(
            "vnc.session.start",
            json!({"connectionId":CONNECTION,"mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    resolve.assert_calls_async(5).await;
    h.run.shutdown().await;
    second.shutdown().await;
    third.shutdown().await;
}

#[tokio::test]
async fn run_and_sandbox_cancellation_close_idle_session_sockets() {
    for sandbox_cancel in [false, true] {
        let mut h = Harness::new().await;
        let _resolve = h.resolve().await;
        let _check = h.check("valid", 200).await;
        h.start("shared").await.session();
        mode(&h, 1).await;
        if sandbox_cancel {
            h.run.lifecycle.cancel();
        } else {
            h.run.cancel.cancel();
        }
        closed(&h).await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn close_cancels_a_pending_capture_without_replaying_or_retaining_socket() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    *h.peer.capture_gate.lock().await = Some(Arc::new(Semaphore::new(0)));
    let mut guest = h.run.open().await;
    send(&mut guest, &json!({"version":1,"method":"vnc.capture","remaining_ms":60000,"params":{"sessionId":session}}).to_string()).await;
    assert!(matches!(h.peer.event().await, Event::Capture));
    assert_eq!(
        h.run
            .request("vnc.session.close", json!({"sessionId":session}))
            .await
            .result()["outcome"],
        "closed"
    );
    closed(&h).await;
    let mut output = Vec::new();
    bounded(guest.read_to_end(&mut output)).await.unwrap();
    assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
    resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
}
