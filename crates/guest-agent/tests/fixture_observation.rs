//! Environment-neutral regressions for observing large integration fixtures.
mod common;

use common::{RecordedHttpEvent, RecordedRequest, RecordingServer};
use serde_json::{Value, json};
use std::time::Duration;

#[test]
fn textual_json_observation_preserves_fixture_sentinel_checks() -> serde_json::Result<()> {
    let fixtures = [
        json!({"nested":[null,true,19,{"text":"你好\"\\\nbytes truncated for delivery"}]}),
        json!({"memoryCitation":null,"private-memory-key":[{"note":"private-note"}]}),
        json!([
            "delivery-secret-value",
            "[event content truncated for delivery]",
            "11111111-1111-4111-8111-111111111111"
        ]),
        json!([null, false, 19, {"plain":"no fixture markers"}]),
    ];
    for value in fixtures {
        let serialized = serde_json::to_string(&value)?;
        for needle in [
            "for delivery",
            "memoryCitation",
            "private-memory",
            "private-note",
            "delivery-secret-value",
            "[event content truncated for delivery]",
            "11111111-1111-4111-8111-111111111111",
            "absent-sentinel",
        ] {
            assert_eq!(
                common::contains_json_text(&value, needle),
                serialized.contains(needle),
                "fixture sentinel {needle}"
            );
        }
    }
    assert!(!common::contains_json_text(&Value::Bool(true), "true"));
    assert!(!common::contains_json_text(&json!(19), "19"));
    Ok(())
}

#[tokio::test]
async fn quiet_recording_returns_complete_independent_http_snapshots()
-> Result<(), Box<dyn std::error::Error>> {
    let server = RecordingServer::start(200, Duration::ZERO).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let body = format!("large-fixture-head-{}-tail", "α".repeat(1024 * 1024));
    let waiting = server.wait_for_quiet(Duration::from_millis(20), Duration::from_secs(5));
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    for path in ["/first", "/second"] {
        assert_eq!(
            client
                .post(format!("{}{path}", server.base_url))
                .header("Authorization", "Bearer fixture-token")
                .header("Content-Type", "text/plain")
                .body(body.clone())
                .send()
                .await?
                .status(),
            reqwest::StatusCode::OK
        );
    }
    let snapshot = waiting.await?;
    let expected = ["/first", "/second"]
        .into_iter()
        .flat_map(|path| {
            [
                RecordedHttpEvent::Request(RecordedRequest {
                    path: path.into(),
                    authorization: Some("Bearer fixture-token".into()),
                    content_type: Some("text/plain".into()),
                    client_request_id: None,
                    body: body.clone(),
                }),
                RecordedHttpEvent::Response {
                    path: path.into(),
                    status: 200,
                },
            ]
        })
        .collect::<Vec<_>>();
    assert_eq!(snapshot, expected);
    assert_eq!(server.events()?, expected);
    assert_eq!(server.requests()?.len(), 2);
    assert_eq!(
        client
            .post(format!("{}/third", server.base_url))
            .body("third-body")
            .send()
            .await?
            .status(),
        reqwest::StatusCode::OK
    );
    let next = server
        .wait_for_quiet(Duration::from_millis(20), Duration::from_secs(5))
        .await?;
    assert_eq!(next.len(), 6);
    assert_eq!(snapshot, expected);
    Ok(())
}

#[tokio::test]
async fn quiet_recording_preserves_timeout_error() -> Result<(), String> {
    let server = RecordingServer::start(200, Duration::ZERO).await?;
    let error = server
        .wait_for_quiet(Duration::from_secs(60), Duration::ZERO)
        .await
        .expect_err("a zero timeout cannot establish a nonzero quiet period");
    assert_eq!(
        error,
        "recording server did not become quiet within 0ns; observed 0 events"
    );
    Ok(())
}
