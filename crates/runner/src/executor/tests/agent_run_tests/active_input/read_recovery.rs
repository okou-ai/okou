use std::sync::{Arc, Mutex};
use std::time::Duration;

use httpmock::{HttpMockRequest, HttpMockResponse, MockServer};
use serde_json::Value;
use tokio::sync::oneshot;
use tracing::Level;
use tracing_subscriber::prelude::*;

use super::read_backoff::{observe, retry_delay};
use super::{DELIVERY_ID, EVENT_ID, api_active_input_source};
use crate::active_input::ActiveInputNotifications;
use crate::axiom_layer::{init_with_base_url, with_ingest_filter};
use crate::error::RunnerResult;
use crate::executor::agent_run::{AgentExecutionResult, RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    CapturedEvent, CapturedEvents, create_overridden_sandbox, minimal_context,
    test_executor_config, test_telemetry,
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_types::ids::RunId;
use runner_types::types::SandboxReuseResult;

const FAILURE: &str = "active-input source read failed; retrying";
const DEGRADED: &str = "active-input source reads degraded; retrying";
const RECOVERED: &str = "active-input source read recovered";

struct RunningInput {
    _dir: tempfile::TempDir,
    run_id: RunId,
    notifications: ActiveInputNotifications,
    cancel: tokio_util::sync::CancellationToken,
    wait_gate: Arc<tokio::sync::Notify>,
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    task: tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>>,
}

impl RunningInput {
    async fn start(server: &RawHttpTestServer) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            Arc::clone(&wait_gate),
        ));
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let run_id = ctx.run_id;
        let notifications = ActiveInputNotifications::new();
        let source = api_active_input_source(server.url(), run_id, &notifications, "read-recovery");
        let cancel = tokio_util::sync::CancellationToken::new();
        let run_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let mut telemetry = test_telemetry(&config, &ctx);
            run_in_sandbox(
                &*sandbox,
                &ctx,
                &config,
                RunStart {
                    restore_guest_state: false,
                    reuse_result: SandboxReuseResult::PoolMiss,
                    workspace_reuse_result:
                        runner_types::types::WorkspaceReuseResult::NotConfigured,
                    prev_storage: None,
                },
                &mut telemetry,
                RunControls::new(run_cancel, Some(source)),
            )
            .await
        });
        Self {
            _dir: dir,
            run_id,
            notifications,
            cancel,
            wait_gate,
            overrides,
            task,
        }
    }

    async fn expect_delivery(&self) {
        observe("recovered Guest handoff", || {
            (self.overrides.process_control_calls().len() == 1).then_some(())
        })
        .await;
        let calls = self.overrides.process_control_calls();
        assert_eq!(calls[0].message_id, DELIVERY_ID);
        let payload: Value = serde_json::from_slice(&calls[0].payload).unwrap();
        assert_eq!(payload["deliveryId"], DELIVERY_ID);
        assert_eq!(payload["text"], "recovered input");
    }

    async fn finish(self, cancelled: bool) {
        if !cancelled {
            self.wait_gate.notify_one();
        }
        observe("run completion", || self.task.is_finished().then_some(())).await;
        let result = self.task.await.unwrap().unwrap();
        assert_eq!(result.failure.is_some(), cancelled);
    }
}

// Keep real socket I/O progressing while the retry/request clock is controlled.
// The existing wall-clock observer bounds every wait, including a frozen clock.
struct PausedClock {
    release: std::sync::mpsc::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl PausedClock {
    fn start() -> Self {
        let (release, receiver) = std::sync::mpsc::channel();
        let task = tokio::task::spawn_blocking(move || {
            let _ = receiver.recv_timeout(Duration::from_secs(30));
        });
        tokio::time::pause();
        Self { release, task }
    }

    async fn finish(self) {
        tokio::time::resume();
        drop(self.release);
        self.task.await.unwrap();
    }
}

fn reserved() -> RawHttpAction {
    RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"recovered input"}}"#,
        ),
    ))
}

fn events(captured: &CapturedEvents, message: &str) -> Vec<CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| event.fields.get("message").map(String::as_str) == Some(message))
        .collect()
}

async fn next_retry(captured: &CapturedEvents, count: usize) {
    let delay = retry_delay(captured, count).await;
    tokio::time::advance(delay + Duration::from_millis(2)).await;
}

#[tokio::test]
async fn run_in_sandbox_recovers_tcp_reset_without_ingesting_a_warning() {
    let axiom = MockServer::start_async().await;
    let ingest = axiom
        .mock_async(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.status(200);
        })
        .await;
    let (layer, guard) = init_with_base_url(&axiom.base_url(), "test", "test").unwrap();
    let captured = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(with_ingest_filter(layer)),
    );
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, reserved()]).await;
    let run = RunningInput::start(&server).await;
    run.expect_delivery().await;
    run.finish(false).await;
    server.assert_finished().await;
    guard.shutdown().await;

    let failures = events(&captured, FAILURE);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].level, Level::INFO);
    assert_eq!(failures[0].fields["failure_cause"], "connection_reset");
    let recoveries = events(&captured, RECOVERED);
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].level, Level::INFO);
    assert_eq!(recoveries[0].fields["reserve_outcome"], "reserved");
    assert_eq!(recoveries[0].fields["recovered_after_failures"], "1");
    assert_eq!(recoveries[0].fields["was_degraded"], "false");
    ingest.assert_calls_async(0).await;
}

#[tokio::test]
async fn run_in_sandbox_recovers_a_real_reserve_request_timeout() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let (release, response_gate) = oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: response_gate,
            // No response bytes: release the timed-out socket before accepting retry.
            response: Vec::new(),
        },
        reserved(),
    ])
    .await;
    let run = RunningInput::start(&server).await;
    server.next_request("request to time out").await;
    let clock = PausedClock::start();
    tokio::time::advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
    let delay = retry_delay(&captured, 1).await;
    release.send(()).unwrap();
    tokio::time::advance(delay + Duration::from_millis(2)).await;
    run.expect_delivery().await;
    run.finish(false).await;
    clock.finish().await;
    server.assert_finished().await;

    let failures = events(&captured, FAILURE);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].level, Level::INFO);
    assert_eq!(failures[0].fields["failure_cause"], "timeout");
    assert!(events(&captured, DEGRADED).is_empty());
    assert_eq!(
        events(&captured, RECOVERED)[0].fields["reserve_outcome"],
        "reserved"
    );
}

#[tokio::test]
async fn run_in_sandbox_warns_on_sustained_reads_and_resets_after_empty() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::ResetConnection,
        RawHttpAction::ResetConnection,
        RawHttpAction::ResetConnection,
        RawHttpAction::ResetConnection,
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"empty"}"#)),
        RawHttpAction::ResetConnection,
        reserved(),
    ])
    .await;
    let clock = PausedClock::start();
    let run = RunningInput::start(&server).await;
    retry_delay(&captured, 1).await;
    tokio::time::advance(Duration::from_secs(29)).await;
    retry_delay(&captured, 2).await;
    assert!(events(&captured, DEGRADED).is_empty());
    tokio::time::advance(Duration::from_secs(1)).await;
    retry_delay(&captured, 3).await;
    let warnings = events(&captured, DEGRADED);
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].level, Level::WARN);
    assert_eq!(warnings[0].fields["failure_elapsed_ms"], "30000");
    assert_eq!(warnings[0].fields["consecutive_failures"], "3");
    next_retry(&captured, 3).await;
    next_retry(&captured, 4).await;
    observe("empty reserve recovery", || {
        (events(&captured, RECOVERED).len() == 1).then_some(())
    })
    .await;
    assert!(run.overrides.process_control_calls().is_empty());
    let recovery = &events(&captured, RECOVERED)[0];
    assert_eq!(recovery.fields["reserve_outcome"], "empty");
    assert_eq!(recovery.fields["recovered_after_failures"], "4");
    assert_eq!(recovery.fields["was_degraded"], "true");
    run.notifications.notify(run.run_id);
    next_retry(&captured, 5).await;
    run.expect_delivery().await;
    run.finish(false).await;
    clock.finish().await;
    server.assert_finished().await;
    assert_eq!(events(&captured, DEGRADED).len(), 1);
    let recoveries = events(&captured, RECOVERED);
    assert_eq!(recoveries.len(), 2);
    assert_eq!(recoveries[1].fields["recovered_after_failures"], "1");
    assert_eq!(recoveries[1].fields["was_degraded"], "false");
}

#[tokio::test]
async fn run_in_sandbox_ingests_genuine_read_failures_after_a_transient() {
    let axiom = MockServer::start_async().await;
    let ingested = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&ingested);
    let ingest = axiom
        .mock_async(move |when, then| {
            when.method(httpmock::Method::POST)
                .path("/v1/datasets/vm0-web-logs-test/ingest");
            then.respond_with(move |request: &HttpMockRequest| {
                let batch: Vec<Value> = serde_json::from_slice(request.body_ref()).unwrap();
                sink.lock().unwrap().extend(batch);
                HttpMockResponse::builder().status(200).build()
            });
        })
        .await;
    let (layer, guard) = init_with_base_url(&axiom.base_url(), "test", "test").unwrap();
    let captured = CapturedEvents::default();
    let _subscriber = tracing::subscriber::set_default(
        tracing_subscriber::registry()
            .with(captured.clone())
            .with(with_ingest_filter(layer)),
    );
    for failure in [
        RawHttpAction::Respond(json_response(
            "401 Unauthorized",
            r#"{"error":"unauthorized"}"#,
        )),
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"unavailable"}"#,
        )),
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"invalid"}"#)),
        RawHttpAction::Disconnect,
    ] {
        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, failure, reserved()])
                .await;
        let run = RunningInput::start(&server).await;
        run.expect_delivery().await;
        run.finish(false).await;
        server.assert_finished().await;
    }
    guard.shutdown().await;
    assert!(ingest.calls_async().await > 0);
    let failures = events(&captured, FAILURE);
    assert_eq!(
        failures
            .iter()
            .filter(|event| event.level == Level::INFO)
            .count(),
        4
    );
    assert_eq!(
        failures
            .iter()
            .filter(|event| event.level == Level::WARN)
            .count(),
        4
    );
    let ingested = ingested.lock().unwrap();
    assert_eq!(ingested.len(), 4);
    for event in ingested.iter() {
        assert_eq!(event["message"], FAILURE);
        assert_eq!(event["level"], "warn");
        assert_eq!(event["consecutive_failures"], 2);
    }
}

#[tokio::test]
async fn run_in_sandbox_does_not_claim_read_recovery_on_cancellation() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let server =
        RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, RawHttpAction::Stall]).await;
    let clock = PausedClock::start();
    let run = RunningInput::start(&server).await;
    retry_delay(&captured, 1).await;
    assert!(run.overrides.process_control_calls().is_empty());
    run.cancel.cancel();
    run.finish(true).await;
    clock.finish().await;
    server.cancel_and_reap().await;
    assert!(events(&captured, RECOVERED).is_empty());
    assert!(events(&captured, DEGRADED).is_empty());
}

#[tokio::test]
async fn run_in_sandbox_reports_readable_non_delivery_outcomes_truthfully() {
    for (response, expected) in [
        (r#"{"outcome":"terminal"}"#.to_string(), "terminal"),
        (
            format!(
                r#"{{"outcome":"held","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"]}}"#
            ),
            "held",
        ),
        (
            r#"{"outcome":"rejected","reason":"run_not_running"}"#.to_string(),
            "rejected_run_not_running",
        ),
        (
            r#"{"outcome":"rejected","reason":"payload_too_large"}"#.to_string(),
            "rejected_payload_too_large",
        ),
    ] {
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let server = RawHttpTestServer::spawn(vec![
            RawHttpAction::ResetConnection,
            RawHttpAction::Respond(json_response("200 OK", &response)),
        ])
        .await;
        let run = RunningInput::start(&server).await;
        observe("readable reserve outcome", || {
            (!events(&captured, RECOVERED).is_empty()).then_some(())
        })
        .await;
        assert!(run.overrides.process_control_calls().is_empty());
        run.finish(false).await;
        server.assert_finished().await;
        assert_eq!(
            events(&captured, RECOVERED)[0].fields["reserve_outcome"],
            expected
        );
        if expected == "rejected_payload_too_large" {
            assert_eq!(
                events(&captured, "active-input reserve rejected pending input")[0].level,
                Level::WARN
            );
        }
    }
}
