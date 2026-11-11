use std::time::Duration;

use serde_json::{Value, json};

use super::{closed, harness::Harness, mode};

#[tokio::test]
async fn malformed_or_failed_admission_cannot_admit_authority() {
    for (status, response) in [
        (404, json!({"error":"unknown endpoint"})),
        (500, json!({"outcome":"valid"})),
        (200, json!({})),
        (200, json!({"outcome":"unknown"})),
    ] {
        let mut h = Harness::new().await;
        let resolve = h.resolve().await;
        let check = check(&h, status, response).await;
        assert_eq!(
            h.start("shared").await.result(),
            &json!({"outcome":"failed","reason":"authority_failure"})
        );
        mode(&h, 1).await;
        closed(&h).await;
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
            json!([])
        );
        check.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn vnc_credential_authority_enforces_declared_and_streamed_response_bounds() {
    use super::peer::Peer;
    use crate::authority_response::tests::scenarios;
    use crate::test_fixtures::raw_http::RawHttpTestServer;

    for case in scenarios() {
        let mut api = RawHttpTestServer::spawn(vec![case.action]).await;
        let mut h = Harness::with_authority(Peer::classic().await, Some(api.url())).await;
        let reply = h.start("shared").await;
        assert_eq!(
            reply.result(),
            &json!({"outcome":"failed","reason":case.reason}),
            "{}",
            case.name
        );
        assert!(
            !reply
                .result()
                .to_string()
                .contains("authority-response-secret-canary")
        );
        assert!(h.network.queries.lock().unwrap().is_empty());
        assert!(h.network.attempts.lock().unwrap().is_empty());
        let request = api.next_request("credential authority resolve").await;
        assert!(request.starts_with("POST /api/runners/runs/"));
        assert!(request.contains("/vnc/resolve HTTP/1.1"));
        h.run.shutdown().await;
        api.assert_finished().await;
    }
}

async fn check(h: &Harness, status: u16, response: Value) -> httpmock::Mock<'_> {
    h.api
        .mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/check$");
            then.status(status).json_body(response);
        })
        .await
}

#[tokio::test]
async fn physical_expiry_closes_idle_transport_and_a_new_session_refills_authority() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let check = h.check("valid", 200).await;
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2 * 60 * 60 + 1)).await;
    tokio::time::resume();
    closed(&h).await;
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":first}))
            .await
            .result()["reason"],
        "session_not_found"
    );
    let next = h.start("shared").await.session();
    mode(&h, 1).await;
    assert_ne!(first, next);
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":next}))
            .await
            .result()["outcome"],
        "status"
    );
    resolve.assert_calls_async(2).await;
    check.assert_calls_async(2).await;
    h.run.shutdown().await;
    closed(&h).await;
}
