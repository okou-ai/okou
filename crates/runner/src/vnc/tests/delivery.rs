use std::time::Duration;

use runner_rpc_proto::stream::{Frame, Writer};
use serde_json::json;
use tokio::io::AsyncReadExt;

use super::{
    closed,
    harness::{Harness, bounded, read, send},
    mode,
    peer::Event,
};

#[tokio::test]
async fn bundled_streaming_helper_delivers_capture_and_proves_terminal_eof() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    let request =
        json!({"version":1,"method":"vnc.capture","params":{"sessionId":session}}).to_string();
    let mut input = Vec::new();
    input.extend(u32::try_from(request.len()).unwrap().to_be_bytes());
    input.extend(request.as_bytes());
    Writer::input(&mut input).send(&Frame::End).await.unwrap();
    let guest = h.run.open().await;
    let mut output = Vec::new();
    assert!(
        bounded(runner_rpc_client::stream::run_with_io(
            input.as_slice(),
            &mut output,
            || async { Ok(guest) }
        ))
        .await
        .unwrap()
    );
    let reply = read(output.as_slice()).await;
    assert!(reply.ended);
    assert_eq!(
        reply.result(),
        &json!({"outcome":"captured","bytes":reply.bytes.len()})
    );
    assert_eq!(&reply.bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert!(matches!(h.peer.event().await, Event::Capture));
    h.run.shutdown().await;
    closed(&h).await;
}

#[tokio::test]
async fn post_handshake_generation_check_denies_before_publishing_session() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let check = h.check("configuration_changed", 200).await;
    let reply = h.start("shared").await;
    assert_eq!(
        reply.result(),
        &json!({"outcome":"failed","reason":"configuration_changed"})
    );
    mode(&h, 1).await;
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
async fn input_write_to_reset_socket_is_unknown_and_never_replayed() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    h.peer.disconnect.cancel();
    closed(&h).await;
    let reply = h
        .run
        .request(
            "vnc.input",
            json!({"sessionId":session,"input":{"type":"text","text":"a"}}),
        )
        .await;
    assert_eq!(
        reply.result(),
        &json!({"outcome":"unknown","reason":"disconnected"})
    );
    resolve.assert_calls_async(1).await;
    assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
    h.run.shutdown().await;
}

#[tokio::test]
async fn failed_input_terminal_delivery_closes_session_without_replaying_input() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    let mut guest = h.run.open_failing_output().await;
    send(
        &mut guest,
        &json!({"version":1,"method":"vnc.input","remaining_ms":60000,
        "params":{"sessionId":session,"input":{"type":"text","text":"a"}}})
        .to_string(),
    )
    .await;
    for expected in [vec![4, 1, 0, 0, 0, 0, 0, 97], vec![4, 0, 0, 0, 0, 0, 0, 97]] {
        match h.peer.event().await {
            Event::Input(bytes) => assert_eq!(bytes, expected),
            _ => panic!("expected a single balanced key press"),
        }
    }
    closed(&h).await;
    let mut bytes = Vec::new();
    bounded(guest.read_to_end(&mut bytes)).await.unwrap();
    assert!(
        bytes.is_empty(),
        "failed delivery cannot fabricate a terminal"
    );
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    resolve.assert_calls_async(1).await;
    assert_eq!(h.network.attempts.lock().unwrap().len(), 1);
    h.run.shutdown().await;
}

#[tokio::test]
async fn blocked_list_metadata_does_not_retain_a_closed_sessions_capacity() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let check = h.check("valid", 200).await;
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    let second = h.start("shared").await.session();
    mode(&h, 1).await;
    let to_close = first.max(second);
    check.delete_async().await;
    // Delay one external request; remove this mock after the API has accepted
    // it so later checks are independently available while list still waits.
    let blocked = h.check_delayed("valid", 200, Duration::from_secs(30)).await;
    let mut guest = h.run.open().await;
    send(
        &mut guest,
        &json!({"version":1,"method":"vnc.session.list","remaining_ms":60000,"params":{}})
            .to_string(),
    )
    .await;
    bounded(async {
        while blocked.calls_async().await == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    blocked.delete_async().await;
    let _available = h.check("valid", 200).await;
    assert_eq!(
        h.run
            .request("vnc.session.close", json!({"sessionId":to_close}))
            .await
            .result()["outcome"],
        "closed"
    );
    closed(&h).await;
    // The list still owns its snapshot of both IDs. The freed socket's permit
    // must nevertheless admit a replacement while the other check is pending.
    h.start("shared").await.session();
    mode(&h, 1).await;
    h.run.cancel.cancel();
    let mut bytes = Vec::new();
    bounded(guest.read_to_end(&mut bytes)).await.unwrap();
    h.run.shutdown().await;
}
