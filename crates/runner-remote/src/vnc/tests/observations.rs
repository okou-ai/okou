use serde_json::json;
use std::sync::atomic::Ordering;

use super::{
    closed,
    harness::{CONNECTION, Harness},
    mode,
};

#[tokio::test]
async fn actual_vnc_connection_failure_and_recovery_report_only_bounded_evidence() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    let failed = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/observations$")
                .header("authorization", "Bearer vm0_official_vnc-test")
                .json_body_includes(
                    json!({
                        "connectionId": CONNECTION, "expectedGeneration": 7,
                        "expectedTransport": {"type": "direct"},
                        "failureReason": "authentication_failed",
                    })
                    .to_string(),
                )
                .body_excludes("password")
                .body_excludes(" secret ")
                .body_excludes("caBundle")
                .is_true(|request| {
                    let body: serde_json::Value =
                        serde_json::from_slice(request.body_ref()).unwrap();
                    body["observedAt"]
                        .as_str()
                        .unwrap()
                        .parse::<chrono::DateTime<chrono::Utc>>()
                        .is_ok()
                });
            then.status(200).json_body(json!({"outcome": "recorded"}));
        })
        .await;
    let recovered = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/observations$")
                .json_body_includes(
                    json!({
                        "connectionId": CONNECTION, "expectedGeneration": 7,
                        "failureReason": null,
                    })
                    .to_string(),
                )
                .body_excludes("password")
                .body_excludes(" secret ");
            then.status(200).json_body(json!({"outcome": "recorded"}));
        })
        .await;
    h.peer.refuse.store(true, Ordering::SeqCst);
    assert_eq!(
        h.start("shared").await.result()["reason"],
        "authentication_failed"
    );
    closed(&h).await;
    h.peer.refuse.store(false, Ordering::SeqCst);
    let session = h.start("shared").await.session();
    mode(&h, 1).await;
    // Inventory/status operations must not fabricate another attempt.
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["outcome"],
        "listed"
    );
    h.run
        .request("vnc.session.status", json!({"sessionId": session}))
        .await;
    h.run.shutdown().await;
    failed.assert_calls_async(1).await;
    recovered.assert_calls_async(1).await;
}

#[tokio::test]
async fn unavailable_reporting_on_old_api_or_outage_does_not_change_vnc_results_or_retry() {
    for status in [404, 500] {
        let mut h = Harness::new().await;
        let _resolve = h.resolve().await;
        let _check = h.check("valid", 200).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path_matches(r"^/api/runners/runs/[^/]+/vnc/observations$");
                then.status(status).body("secret-bearing-provider-error");
            })
            .await;
        h.start("shared").await.session();
        mode(&h, 1).await;
        h.run.shutdown().await;
        report.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn post_authentication_authority_errors_preserve_connection_evidence() {
    for (outcome, status, reason) in [
        ("unavailable", 200, "unavailable"),
        ("configuration_changed", 200, "configuration_changed"),
        ("valid", 500, "authority_failure"),
    ] {
        let mut h = Harness::new().await;
        let _resolve = h.resolve().await;
        let _check = h.check(outcome, status).await;
        let report = h
            .api
            .mock_async(|when, then| {
                when.method("POST")
                    .path_matches(r"^/api/runners/runs/[^/]+/vnc/observations$")
                    .json_body_includes(
                        json!({
                            "connectionId": CONNECTION,
                            "expectedGeneration": 7,
                            "expectedTransport": {"type": "direct"},
                            "failureReason": null,
                        })
                        .to_string(),
                    );
                then.status(200).json_body(json!({"outcome": "recorded"}));
            })
            .await;
        assert_eq!(h.start("shared").await.result()["reason"], reason);
        mode(&h, 1).await;
        closed(&h).await;
        h.run.shutdown().await;
        report.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn denied_vnc_start_does_not_publish_connection_evidence() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve_response(json!({"outcome": "unavailable"})).await;
    let report = h
        .api
        .mock_async(|when, then| {
            when.method("POST")
                .path_matches(r"^/api/runners/runs/[^/]+/vnc/observations$");
            then.status(200).json_body(json!({"outcome": "recorded"}));
        })
        .await;
    assert_eq!(h.start("shared").await.result()["reason"], "unavailable");
    h.run.shutdown().await;
    report.assert_calls_async(0).await;
}
