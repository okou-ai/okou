use std::time::Duration;

use serde_json::{Value, json};

use super::{closed, harness::Harness, mode};

#[tokio::test]
async fn old_or_malformed_api_cannot_admit_cached_authority() {
    for (status, response) in [
        (404, json!({"error":"unknown endpoint"})),
        (200, json!({"outcome":"valid"})),
        (200, json!({"outcome":"valid","lifetimeSeconds":0})),
        (200, json!({"outcome":"valid","lifetimeSeconds":-1})),
        (200, json!({"outcome":"valid","lifetimeSeconds":7201})),
        (200, json!({"outcome":"valid","lifetimeSeconds":1.5})),
        (200, json!({"outcome":"valid","lifetimeSeconds":"7200"})),
    ] {
        let mut h = Harness::new().await;
        let resolve = h.resolve().await;
        let snapshot = snapshot(&h, status, response).await;
        let legacy = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path_matches(r"^/api/runners/runs/[^/]+/vnc/check$");
                then.status(200).json_body(json!({"outcome":"valid"}));
            })
            .await;
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
        snapshot.assert_calls_async(1).await;
        resolve.assert_calls_async(1).await;
        legacy.assert_calls_async(0).await;
        h.run.shutdown().await;
    }
}

async fn snapshot(h: &Harness, status: u16, response: Value) -> httpmock::Mock<'_> {
    h.api
        .mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/snapshot$");
            then.status(status).json_body(response);
        })
        .await
}

#[tokio::test]
async fn cached_lifetime_closes_idle_transport_and_a_new_session_refills_authority() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let snapshot = snapshot(&h, 200, json!({"outcome":"valid","lifetimeSeconds":2})).await;
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
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
    snapshot.assert_calls_async(2).await;
    h.run.shutdown().await;
    closed(&h).await;
}
