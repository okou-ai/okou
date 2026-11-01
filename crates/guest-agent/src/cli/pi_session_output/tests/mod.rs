use std::time::Duration;

use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::json;

use super::*;

const RUN_ID: &str = "00000000-0000-4000-8000-000000000001";
const THREAD_ID: &str = "00000000-0000-4000-8000-000000000002";

async fn wait_for_block_failure(sender: &PiSessionOutputSender, run_event_id: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !sender.state.block_failed(run_event_id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("session output worker should classify the failure");
}

#[test]
fn queue_pressure_closes_only_the_overflowing_block() {
    let (sender, _rx) = test_channel(1, RUN_ID);
    assert!(sender.try_send("block-a", "first".to_string()));
    assert!(!sender.try_send("block-a", "overflow".to_string()));
    assert!(!sender.try_send("block-a", "later".to_string()));
    assert!(!sender.state.block_failed("block-b"));
}

#[tokio::test]
async fn merged_requests_receive_contiguous_published_indices() {
    let server = MockServer::start();
    let first_delta = format!("{}{}", "a".repeat(2000), "b".repeat(2000));
    let second_delta = "c".repeat(200);
    let first = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-output")
            .json_body(json!({
                "runId": RUN_ID,
                "threadId": THREAD_ID,
                "runEventId": "block-a",
                "chunkIndex": 0,
                "delta": first_delta,
            }));
        then.status(204);
    });
    let second = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-output")
            .json_body(json!({
                "runId": RUN_ID,
                "threadId": THREAD_ID,
                "runEventId": "block-a",
                "chunkIndex": 1,
                "delta": second_delta,
            }));
        then.status(204);
    });
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)
            .expect("HTTP client");
    let (sender, rx) = test_channel(4, RUN_ID);
    let state = Arc::clone(&sender.state);
    assert!(sender.try_send("block-a", "a".repeat(2000)));
    assert!(sender.try_send("block-a", "b".repeat(2000)));
    assert!(sender.try_send("block-a", "c".repeat(200)));
    drop(sender);

    run_worker(
        http,
        RUN_ID.to_string(),
        THREAD_ID.to_string(),
        rx,
        state,
        FirstSessionOutputTiming::default(),
    )
    .await;

    first.assert_calls(1);
    second.assert_calls(1);
}

#[tokio::test]
async fn failed_request_is_never_retried_and_closes_the_block() {
    let server = MockServer::start();
    let endpoint = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/session-output");
        then.status(503);
    });
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)
            .expect("HTTP client");
    let sender = start(http, RUN_ID, THREAD_ID, FirstSessionOutputTiming::default())
        .expect("session output sender");

    assert!(sender.try_send("block-a", "first".to_string()));
    assert!(sender.try_send("block-a", " second".to_string()));
    wait_for_block_failure(&sender, "block-a").await;
    assert!(!sender.try_send("block-a", " later".to_string()));
    tokio::time::sleep(Duration::from_millis(25)).await;

    endpoint.assert_calls(1);
}

#[tokio::test]
async fn old_api_rejection_disables_future_blocks_without_affecting_the_caller() {
    let server = MockServer::start();
    let endpoint = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/session-output");
        then.status(404);
    });
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)
            .expect("HTTP client");
    let sender = start(http, RUN_ID, THREAD_ID, FirstSessionOutputTiming::default())
        .expect("session output sender");

    assert!(sender.try_send("block-a", "first".to_string()));
    wait_for_block_failure(&sender, "block-a").await;
    assert!(!sender.try_send("block-b", "new response".to_string()));

    endpoint.assert_calls(1);
}
#[tokio::test]
async fn only_the_first_published_chunk_records_first_output_timing() {
    let telemetry_dir = tempfile::tempdir().expect("telemetry dir");
    let telemetry_path = telemetry_dir.path().join("sandbox-ops.jsonl");
    let _sandbox_ops_guard = crate::SandboxOpsTestGuard::with_override(&telemetry_path).await;
    let server = MockServer::start();
    let endpoint = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/session-output");
        then.status(204);
    });
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)
            .expect("HTTP client");
    let startup = Arc::new(OnceLock::new());
    startup
        .set(Instant::now())
        .expect("startup boundary is unset");
    let api_start_time = (timing::current_epoch_ms() - 1_000).to_string();
    let (sender, rx) = test_channel(4, RUN_ID);
    let state = Arc::clone(&sender.state);
    assert!(sender.try_send("block-a", "first".to_string()));
    assert!(sender.try_send("block-b", "second".to_string()));
    drop(sender);

    run_worker(
        http,
        RUN_ID.to_string(),
        THREAD_ID.to_string(),
        rx,
        state,
        FirstSessionOutputTiming {
            pi_startup_succeeded_at: Some(startup),
            api_start_time,
        },
    )
    .await;

    endpoint.assert_calls(2);
    let ops: Vec<serde_json::Value> = std::fs::read_to_string(&telemetry_path)
        .expect("sandbox ops")
        .lines()
        .map(|line| serde_json::from_str(line).expect("sandbox op JSON"))
        .collect();
    let named = |name: &str| {
        ops.iter()
            .filter(|op| op["action_type"] == name)
            .collect::<Vec<_>>()
    };
    let first_output = named("pi_first_session_output");
    assert_eq!(first_output.len(), 1);
    assert_eq!(first_output[0]["success"], true);
    let from_api = named("api_to_first_session_output");
    assert_eq!(from_api.len(), 1);
    assert!(from_api[0]["duration_ms"].as_u64().expect("duration") >= 1_000);
}
