use serde_json::json;

use super::{closed, harness::Harness, mode, peer::Event};

#[tokio::test]
async fn list_preserves_valid_siblings_but_surfaces_authority_failures() {
    const OTHER_CONNECTION: &str = "58629e7e-6504-46f7-a294-ce1732b83b82";
    for (outcome, status, expected) in [
        ("unavailable", 200, "listed"),
        ("configuration_changed", 200, "listed"),
        ("provider-failure", 500, "failed"),
    ] {
        let mut h = Harness::new().await;
        let _resolve = h.resolve().await;
        let _other_resolve = h.resolve_connection(OTHER_CONNECTION).await;
        let allowed = h.check("valid", 200).await;
        let _other_allowed = h.check_connection(OTHER_CONNECTION, "valid", 200).await;
        let stale = h.start("shared").await.session();
        mode(&h, 1).await;
        let valid = h
            .run
            .request(
                "vnc.session.start",
                json!({"connectionId":OTHER_CONNECTION,"mode":"shared"}),
            )
            .await
            .session();
        mode(&h, 1).await;
        allowed.delete_async().await;
        let _unavailable = h.check(outcome, status).await;

        let listed = h.run.request("vnc.session.list", json!({})).await;
        assert_eq!(
            listed.result()["outcome"],
            expected,
            "authority outcome {outcome} with status {status}: {}",
            listed.result()
        );
        if status == 200 {
            assert_eq!(
                listed.result()["sessions"],
                json!([{"sessionId":valid,"connectionId":OTHER_CONNECTION,"mode":"shared"}])
            );
        } else {
            assert_eq!(listed.result()["reason"], "authority_failure");
        }
        closed(&h).await;
        assert_eq!(
            h.run
                .request("vnc.session.status", json!({"sessionId":stale}))
                .await
                .result()["outcome"],
            "failed"
        );
        let capture = h
            .run
            .request("vnc.capture", json!({"sessionId":valid}))
            .await;
        assert_eq!(capture.result()["outcome"], "captured");
        assert!(capture.ended);
        assert!(matches!(h.peer.event().await, Event::Capture));
        h.run.shutdown().await;
        closed(&h).await;
    }
}
