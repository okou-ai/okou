use runner_rpc_proto::{
    Response,
    stream::{Frame, Reader},
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Semaphore;

use super::{
    closed,
    harness::{Harness, read, send},
    mode,
    peer::Event,
};

async fn list_during_close(close_capturing: bool) {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let _other_resolve = h
        .resolve_connection("58629e7e-6504-46f7-a294-ce1732b83b82")
        .await;
    let check = h.snapshot("valid", 200).await;
    let other_check = h
        .snapshot_connection("58629e7e-6504-46f7-a294-ce1732b83b82", "valid", 200)
        .await;
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    let second = h
        .run
        .request(
            "vnc.session.start",
            json!({"connectionId":"58629e7e-6504-46f7-a294-ce1732b83b82","mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    let gate = Arc::new(Semaphore::new(0));
    *h.peer.capture_gate.lock().await = Some(Arc::clone(&gate));
    let mut capture = h.run.open().await;
    send(&mut capture, &json!({"version":1,"method":"vnc.capture","remaining_ms":60000,"params":{"sessionId":first}}).to_string()).await;
    assert!(matches!(h.peer.event().await, Event::Capture));
    let mut list = h.run.open().await;
    send(
        &mut list,
        &json!({"version":1,"method":"vnc.session.list","remaining_ms":60000,"params":{}})
            .to_string(),
    )
    .await;
    let (closing, surviving, connection) = if close_capturing {
        (&first, &second, "58629e7e-6504-46f7-a294-ce1732b83b82")
    } else {
        (&second, &first, super::harness::CONNECTION)
    };
    assert_eq!(
        h.run
            .request("vnc.session.close", json!({"sessionId":closing}))
            .await
            .result()["outcome"],
        "closed"
    );
    gate.add_permits(1);
    read(capture).await;
    closed(&h).await;
    let listed = read(list).await;
    assert_eq!(
        listed.result(),
        &json!({"outcome":"listed","sessions":[{"sessionId":surviving,"connectionId":connection,"mode":"shared"}]})
    );
    check.assert_calls_async(1).await;
    other_check.assert_calls_async(1).await;
    h.run.shutdown().await;
    closed(&h).await;
}

#[tokio::test]
async fn list_omits_a_session_closed_while_waiting_for_its_active_capture() {
    list_during_close(true).await;
}

#[tokio::test]
async fn list_omits_a_closed_sibling_while_another_capture_is_active() {
    list_during_close(false).await;
}

async fn interrupted_list(cancel_run: bool) {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let check = h.snapshot("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    let gate = Arc::new(Semaphore::new(0));
    *h.peer.capture_gate.lock().await = Some(Arc::clone(&gate));
    let mut capture = h.run.open().await;
    send(&mut capture, &json!({"version":1,"method":"vnc.capture","remaining_ms":60000,"params":{"sessionId":session}}).to_string()).await;
    assert!(matches!(h.peer.event().await, Event::Capture));
    let mut list = h.run.open().await;
    send(&mut list, &json!({"version":1,"method":"vnc.session.list","remaining_ms":if cancel_run { 60000 } else { 2000 },"params":{}}).to_string()).await;
    if cancel_run {
        h.run.cancel.cancel();
    }
    if cancel_run {
        // Run teardown may close the guest stream before list dispatch. It
        // must never claim a successful list or retain the capture transport.
        let mut reader = Reader::responses(list);
        while let Ok(Some(frame)) = super::harness::bounded(reader.next()).await {
            if let Frame::Control(Response::Result { data }) = frame {
                let data: serde_json::Value = serde_json::from_str(data.get()).unwrap();
                assert_eq!(data["outcome"], "failed");
                assert_eq!(data["reason"], "cancelled");
            }
        }
    } else {
        let listed = read(list).await;
        assert_eq!(listed.result()["outcome"], "failed");
        assert_eq!(listed.result()["reason"], "timed_out");
    }
    gate.add_permits(1);
    read(capture).await;
    closed(&h).await;
    check.assert_calls_async(1).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn list_preserves_run_cancellation_while_capture_owns_the_engine() {
    interrupted_list(true).await;
}

#[tokio::test]
async fn list_preserves_request_deadline_while_capture_owns_the_engine() {
    interrupted_list(false).await;
}
