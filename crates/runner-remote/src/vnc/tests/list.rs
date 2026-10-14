use ably_subscriber::Message;
use runner_provider::AblySideMessageHandler;
use serde_json::json;

use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
    peer::Event,
};

#[tokio::test]
async fn normal_operations_reuse_snapshots_without_notifications_or_api_reauthorization() {
    const OTHER: &str = "58629e7e-6504-46f7-a294-ce1732b83b82";
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let other_resolve = h.resolve_connection(OTHER).await;
    let allowed = h.snapshot("valid", 200).await;
    let other_allowed = h.snapshot_connection(OTHER, "valid", 200).await;
    // No notification subscription is connected in this harness. Admission
    // and established operations must not require its readiness or continuity.
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    let second = h
        .run
        .request(
            "vnc.session.start",
            json!({"connectionId":OTHER,"mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    allowed.assert_calls_async(1).await;
    other_allowed.assert_calls_async(1).await;
    allowed.delete_async().await;
    other_allowed.delete_async().await;
    let outage = h.snapshot("unavailable", 500).await;
    let other_outage = h.snapshot_connection(OTHER, "unavailable", 500).await;

    for _ in 0..3 {
        let listed = h.run.request("vnc.session.list", json!({})).await;
        assert_eq!(listed.result()["sessions"].as_array().unwrap().len(), 2);
        for session in [&first, &second] {
            assert_eq!(
                h.run
                    .request("vnc.session.status", json!({"sessionId":session}))
                    .await
                    .result()["outcome"],
                "status"
            );
            let capture = h
                .run
                .request("vnc.capture", json!({"sessionId":session}))
                .await;
            assert_eq!(capture.result()["outcome"], "captured");
            assert_eq!(&capture.bytes[..8], b"\x89PNG\r\n\x1a\n");
            assert!(matches!(h.peer.event().await, Event::Capture));
            assert_eq!(
                h.run
                    .request(
                        "vnc.input",
                        json!({"sessionId":session,"input":{"type":"text","text":"q"}})
                    )
                    .await
                    .result()["outcome"],
                "sent"
            );
            for pressed in [1, 0] {
                let Event::Input(bytes) = h.peer.event().await else {
                    panic!("expected balanced input");
                };
                assert_eq!(bytes, vec![4, pressed, 0, 0, 0, 0, 0, b'q']);
            }
        }
    }
    // Delivery is revoke-only even if the notification transport was unavailable.
    assert!(h.runtime.handle(&Message {
        name: Some("vnc-authority-invalidated".into()),
        data: json!({"runId":h.run.id,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: Some(1),
    }));
    closed(&h).await;
    let listed = h.run.request("vnc.session.list", json!({})).await;
    assert_eq!(
        listed.result()["sessions"],
        json!([{"sessionId":second,"connectionId":OTHER,"mode":"shared"}])
    );
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "authority_failure"
    );
    mode(&h, 1).await;
    closed(&h).await;
    outage.assert_calls_async(1).await;
    other_outage.assert_calls_async(0).await;
    resolve.assert_calls_async(2).await;
    other_resolve.assert_calls_async(1).await;
    h.run.shutdown().await;
    closed(&h).await;
}
