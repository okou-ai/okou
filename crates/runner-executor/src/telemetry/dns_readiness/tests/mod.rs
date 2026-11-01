use std::time::{Duration, SystemTime};

use super::*;
use crate::telemetry::tests::http_client_for_api_url;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_types::ids::RunId;

#[tokio::test]
async fn dns_readiness_flush_preserves_numeric_pairs_and_missing_measurements() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"success":true}"#,
    ))])
    .await;
    let mut telemetry = JobTelemetry::new(
        http_client_for_api_url(&server.url()),
        RunId::from(uuid::Uuid::nil()),
        "test-token".into(),
        None,
    );
    for (duration, guest, outcome) in [
        (10, Some(3), SandboxDnsReadinessOutcome::Success),
        (0, Some(0), SandboxDnsReadinessOutcome::ProcessTimeout),
        (2, Some(10), SandboxDnsReadinessOutcome::Success),
        (4, None, SandboxDnsReadinessOutcome::Deadline),
        (5, None, SandboxDnsReadinessOutcome::HostCancelled),
    ] {
        telemetry.record_dns_readiness_attempt(SandboxDnsReadinessAttempt {
            attempt: 1,
            final_attempt: outcome != SandboxDnsReadinessOutcome::ProcessTimeout,
            duration: Duration::from_millis(duration),
            guest_duration_ms: guest,
            outcome,
            completed_at: SystemTime::UNIX_EPOCH + Duration::from_secs(1_788_864_000),
        });
    }
    telemetry.flush().await;
    let request = server.next_request("DNS attempt telemetry").await;
    assert!(request.starts_with("POST /api/webhooks/agent/telemetry "));
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    let ops = payload["sandboxOperations"].as_array().unwrap();
    assert_eq!(ops.len(), 5);
    for op in ops {
        assert_eq!(op["ts"], "2026-09-08T10:40:00.000Z");
        assert_eq!(
            op["action_type"],
            "runner_fresh_sandbox_start_guest_dns_readiness_attempt"
        );
        assert_eq!(op["dns_readiness_attempt"], 1);
    }
    assert_eq!(ops[0]["duration_ms"], 10);
    assert_eq!(ops[0]["dns_readiness_guest_duration_ms"], 3);
    assert_eq!(ops[0]["dns_readiness_host_residual_ms"], 7);
    assert_eq!(ops[0]["dns_readiness_timing"], "paired");
    assert_eq!(ops[0]["success"], true);
    assert_eq!(ops[1]["dns_readiness_guest_duration_ms"], 0);
    assert_eq!(ops[1]["dns_readiness_host_residual_ms"], 0);
    assert_eq!(ops[1]["dns_readiness_final_attempt"], false);
    assert_eq!(ops[1]["success"], false);
    assert_eq!(ops[1]["outcome"], "process_timeout");
    assert_eq!(ops[2]["dns_readiness_guest_duration_ms"], 10);
    assert_eq!(ops[2]["dns_readiness_timing"], "inconsistent");
    assert!(ops[2].get("dns_readiness_host_residual_ms").is_none());
    for op in &ops[3..] {
        assert_eq!(op["dns_readiness_timing"], "unavailable");
        assert_eq!(op["dns_readiness_final_attempt"], true);
        assert!(op.get("dns_readiness_guest_duration_ms").is_none());
        assert!(op.get("dns_readiness_host_residual_ms").is_none());
    }
    server.assert_finished().await;
}
