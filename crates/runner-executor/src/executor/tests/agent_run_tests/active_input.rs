use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use guest_contracts::active_input::{ACTIVE_INPUT_CLOSED_DIAGNOSTIC, encode_active_input};
use tracing::Level;
use tracing_subscriber::prelude::*;

use crate::error::RunnerResult;
use crate::executor::agent_run::{AgentExecutionResult, RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    CapturedEvent, CapturedEvents, RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox,
    minimal_context, test_executor_config, test_telemetry,
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_provider::ApiClient;
use runner_provider::http::{HttpClient, HttpClientConfig};
use runner_provider::local_queue::{self, ActiveInputEntry, LocalQueue};
use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, ActiveInputNotifications, ActiveInputSource,
    identified_active_input_payload_len, local_active_input_event_id,
};
use runner_types::ids::RunId;
use runner_types::types::SandboxReuseResult;

const EVENT_ID: &str = "e6bc287d-8c08-464e-831a-cad771610157";
const READ_FAILED: &str = "active-input source read failed; waiting for the next wakeup";
// Long enough for an unwanted automatic read or forward to reach the fixture.
const NO_WAKEUP_WINDOW: Duration = Duration::from_millis(300);

fn next_input(prompt: &str) -> RawHttpAction {
    RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(r#"{{"input":{{"eventId":"{EVENT_ID}","prompt":"{prompt}"}}}}"#),
    ))
}

fn next_request_path(run_id: RunId) -> String {
    format!("GET /api/runners/runs/{run_id}/steerable-inputs/next ")
}

/// An API-sourced run whose Guest process stays alive until `finish`.
struct ApiRun {
    run_id: RunId,
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
    wait_gate: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<RunnerResult<AgentExecutionResult>>,
}

impl ApiRun {
    async fn start(
        server: &RawHttpTestServer,
        notifications: &ActiveInputNotifications,
        control_outcomes: Vec<sandbox::ProcessControlOutcome>,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let wait_gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
            Arc::clone(&wait_gate),
        ));
        for outcome in control_outcomes {
            overrides.push_process_control_outcome(outcome);
        }
        let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
        let ctx = minimal_context();
        let run_id = ctx.run_id;
        let source = api_active_input_source(server.url(), run_id, notifications, "api-run-test");
        let task = tokio::spawn(async move {
            let _dir = dir;
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
                RunControls::new(tokio_util::sync::CancellationToken::new(), Some(source)),
            )
            .await
        });
        Self {
            run_id,
            overrides,
            wait_gate,
            task,
        }
    }

    async fn expect_next_request(&self, server: &mut RawHttpTestServer, description: &str) {
        let request = server.next_request(description).await;
        assert!(
            request.starts_with(&next_request_path(self.run_id)),
            "unexpected request for {description}: {request}"
        );
    }

    async fn expect_control_calls(&self, count: usize) {
        assert!(
            self.overrides
                .wait_for_process_control_calls(count, RUN_IN_SANDBOX_TEST_TIMEOUT)
                .await,
            "expected {count} process-control calls"
        );
    }

    async fn finish(self) -> Arc<sandbox_mock::MockSandboxOverrides> {
        self.wait_gate.notify_one();
        let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.failure.is_none());
        self.overrides
    }
}

/// Neither the API nor the Guest sees another attempt until a wakeup.
async fn assert_idle_without_wakeup(
    server: &mut RawHttpTestServer,
    overrides: &sandbox_mock::MockSandboxOverrides,
) {
    let control_calls = overrides.process_control_calls().len();
    tokio::time::sleep(NO_WAKEUP_WINDOW).await;
    // A fixture that served its last action closes its request channel.
    if let Ok(request) = server.try_next_request() {
        panic!("the runner must not read again without a wakeup: {request}");
    }
    assert_eq!(
        overrides.process_control_calls().len(),
        control_calls,
        "the runner must not forward again without a read"
    );
}

fn read_failures(captured: &CapturedEvents) -> Vec<CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| event.fields.get("message").map(String::as_str) == Some(READ_FAILED))
        .collect()
}

fn local_queue_with_job(group_dir: &Path, run_id: RunId) -> LocalQueue {
    let profile = runner_types::profile_name::DEFAULT_PROFILE;
    local_queue::ensure_profile_jobs_dir(group_dir, profile).unwrap();
    local_queue::write_private_file(
        &local_queue::job_path(group_dir, profile, run_id).unwrap(),
        b"{}",
        "test local job",
    )
    .unwrap();
    LocalQueue::new(group_dir.to_path_buf())
}

async fn receive_http_request_before(
    deadline: tokio::time::Instant,
    server: &mut RawHttpTestServer,
    description: &str,
) -> Result<String, String> {
    server.next_request_before(deadline, description).await
}

async fn reap_spawned_test_task<T>(
    task: Option<tokio::task::JoinHandle<T>>,
    description: &str,
) -> Option<String> {
    let mut task = task?;
    match tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, &mut task).await {
        Ok(Ok(_)) => return None,
        Ok(Err(error)) if error.is_cancelled() => return None,
        Ok(Err(error)) => return Some(format!("{description} task cleanup failed: {error}")),
        Err(_) => task.abort(),
    }
    match tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, task).await {
        Ok(Ok(_)) => None,
        Ok(Err(error)) if error.is_cancelled() => None,
        Ok(Err(error)) => Some(format!("{description} task cleanup failed: {error}")),
        Err(_) => Some(format!("timed out reaping {description} task after abort")),
    }
}

fn api_active_input_source(
    api_url: String,
    run_id: runner_types::ids::RunId,
    notifications: &ActiveInputNotifications,
    client_session_id: &str,
) -> ActiveInputSource {
    ActiveInputSource::api(
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: client_session_id.to_string(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })
            .unwrap(),
            "runner-token".to_string(),
        ),
        run_id,
        "sandbox-token".to_string(),
        notifications.subscribe(run_id),
    )
}

async fn run_local_active_input_rejection(diagnostic: &str) -> Vec<CapturedEvent> {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::GuestStatus {
        status: sandbox::ProcessControlGuestStatus::Rejected,
        diagnostic: diagnostic.to_string(),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    local_queue_with_job(&group_dir, ctx.run_id)
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            text: "late follow-up".to_string(),
        })
        .unwrap();
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let release_overrides = Arc::clone(&overrides);
    let release_task = tokio::spawn(async move {
        assert!(
            release_overrides
                .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
                .await
        );
        wait_gate.notify_one();
    });

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let result = tokio::time::timeout(
        RUN_IN_SANDBOX_TEST_TIMEOUT,
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    drop(guard);
    release_task.await.unwrap();

    assert!(result.failure.is_none());
    assert_eq!(overrides.process_control_calls().len(), 1);
    captured.entries()
}

fn active_input_stop_event(events: &[CapturedEvent]) -> &CapturedEvent {
    let mut matching = events.iter().filter(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|message| message == "active-input control stopped")
    });
    let event = matching
        .next()
        .unwrap_or_else(|| panic!("missing active-input stop event; captured={events:#?}"));
    assert!(
        matching.next().is_none(),
        "expected one active-input stop event; captured={events:#?}"
    );
    event
}

fn assert_event_field(event: &CapturedEvent, field: &str, expected: &str) {
    assert_eq!(
        event.fields.get(field).map(String::as_str),
        Some(expected),
        "field {field} mismatch; event={event:#?}"
    );
}

#[tokio::test]
async fn run_in_sandbox_classifies_active_input_rejection_logs() {
    let closed_events = run_local_active_input_rejection(ACTIVE_INPUT_CLOSED_DIAGNOSTIC).await;
    let closed = active_input_stop_event(&closed_events);
    assert_eq!(closed.level, Level::INFO);
    assert_event_field(closed, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(closed, "outcome", "closed");
    assert_event_field(closed, "diagnostic", ACTIVE_INPUT_CLOSED_DIAGNOSTIC);

    let rejected_events = run_local_active_input_rejection("unexpected rejection").await;
    let rejected = active_input_stop_event(&rejected_events);
    assert_eq!(rejected.level, Level::WARN);
    assert_event_field(rejected, "run_id", "00000000-0000-0000-0000-000000000000");
    assert_event_field(rejected, "outcome", "rejected");
    assert_event_field(rejected, "diagnostic", "unexpected rejection");
}

#[tokio::test]
async fn run_in_sandbox_forwards_local_active_inputs_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    let queue = local_queue_with_job(&group_dir, ctx.run_id);
    for entry in [
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            text: "first".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            text: "duplicate".to_string(),
        },
        ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 3,
            text: "third".to_string(),
        },
    ] {
        queue.write_active_input_sync(&entry).unwrap();
    }
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let run_id = ctx.run_id;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(3, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    let calls = overrides.process_control_calls();
    assert_eq!(
        calls
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            local_active_input_event_id(run_id, 1),
            local_active_input_event_id(run_id, 2),
            local_active_input_event_id(run_id, 3),
        ]
    );
    let payloads = calls
        .iter()
        .map(|call| serde_json::from_slice::<serde_json::Value>(&call.payload).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(payloads[0]["text"], "first");
    assert_eq!(payloads[1]["text"], "duplicate");
    assert_eq!(payloads[2]["text"], "third");
    assert_eq!(
        payloads[0]["eventId"],
        local_active_input_event_id(run_id, 1)
    );
    assert_eq!(
        payloads[1]["eventId"],
        local_active_input_event_id(run_id, 2)
    );
    assert_eq!(
        payloads[2]["eventId"],
        local_active_input_event_id(run_id, 3)
    );
}

#[tokio::test]
async fn run_in_sandbox_does_not_reread_after_read_failure_until_a_wakeup() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"input":null}"#)),
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"transient"}"#,
        )),
        next_input("delivered after wakeup"),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(&server, &notifications, Vec::new()).await;

    run.expect_next_request(&mut server, "initial next").await;
    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "notified next").await;
    assert_idle_without_wakeup(&mut server, &run.overrides).await;
    let failures = read_failures(&captured);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].level, Level::ERROR);

    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "next after a later wakeup")
        .await;
    run.expect_control_calls(1).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, EVENT_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["eventId"], EVENT_ID);
    assert_eq!(payload["text"], "delivered after wakeup");
    assert_eq!(read_failures(&captured).len(), 1);
}

#[tokio::test]
async fn run_in_sandbox_reads_api_active_input_only_on_wakeups() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"input":null}"#)),
        next_input("delivered after reconnect"),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(&server, &notifications, Vec::new()).await;
    run.expect_next_request(&mut server, "initial next").await;

    // No periodic recheck: time alone never triggers a read.
    tokio::time::pause();
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(10 * 60)).await;
    tokio::time::resume();
    notifications.notify(RunId::new_v4());
    assert_idle_without_wakeup(&mut server, &run.overrides).await;

    // An Ably reconnect wakes every active run.
    notifications.notify_all();
    run.expect_next_request(&mut server, "next after reconnect")
        .await;
    run.expect_control_calls(1).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, EVENT_ID);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
        "delivered after reconnect"
    );
}

#[tokio::test]
async fn run_in_sandbox_reconnect_wakes_every_active_run() {
    let mut first_server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"input":null}"#)),
        next_input("first run input"),
    ])
    .await;
    let mut second_server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"input":null}"#)),
        next_input("second run input"),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let first = ApiRun::start(&first_server, &notifications, Vec::new()).await;
    let second = ApiRun::start(&second_server, &notifications, Vec::new()).await;
    first
        .expect_next_request(&mut first_server, "first run initial next")
        .await;
    second
        .expect_next_request(&mut second_server, "second run initial next")
        .await;

    notifications.notify_all();

    for (run, server) in [(&first, &mut first_server), (&second, &mut second_server)] {
        run.expect_next_request(server, "next after reconnect")
            .await;
        run.expect_control_calls(1).await;
    }
    for (run, server, text) in [
        (first, first_server, "first run input"),
        (second, second_server, "second run input"),
    ] {
        let overrides = run.finish().await;
        server.assert_finished().await;
        let calls = overrides.process_control_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
            text
        );
    }
}

#[tokio::test]
async fn run_in_sandbox_retries_local_active_input_with_same_id_after_uncertain_error() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_io_error(
        std::io::ErrorKind::TimedOut,
        "simulated transient control error",
    );
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let group_dir = dir.path().join("active-inputs");
    let queue = local_queue_with_job(&group_dir, ctx.run_id);
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 1,
            text: "first".to_string(),
        })
        .unwrap();
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: ctx.run_id,
            sequence: 2,
            text: "second".to_string(),
        })
        .unwrap();
    let source = ActiveInputSource::local_queue(LocalQueue::new(group_dir), ctx.run_id);
    let run_id = ctx.run_id;
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(3, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    assert!(result.failure.is_none());
    assert_eq!(
        overrides
            .process_control_calls()
            .iter()
            .map(|call| call.message_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            local_active_input_event_id(run_id, 1),
            local_active_input_event_id(run_id, 1),
            local_active_input_event_id(run_id, 2),
        ]
    );
}

#[tokio::test]
async fn run_in_sandbox_rereads_next_after_not_found_only_on_wakeup() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("404 Not Found", r#"{"error":"not found"}"#)),
        next_input("next delivered"),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(&server, &notifications, Vec::new()).await;
    run.expect_next_request(&mut server, "initial next").await;
    assert_idle_without_wakeup(&mut server, &run.overrides).await;

    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "next after wakeup")
        .await;
    run.expect_control_calls(1).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, EVENT_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["eventId"], EVENT_ID);
    assert_eq!(payload["text"], "next delivered");
}

#[tokio::test]
async fn run_in_sandbox_logs_lost_next_response_and_rereads_on_wakeup() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    tracing::callsite::rebuild_interest_cache();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Disconnect,
        next_input("retrieved delivery"),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(&server, &notifications, Vec::new()).await;
    run.expect_next_request(&mut server, "initial next").await;
    assert_idle_without_wakeup(&mut server, &run.overrides).await;

    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "next after wakeup")
        .await;
    run.expect_control_calls(1).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, EVENT_ID);
    let failures = read_failures(&captured);
    assert_eq!(failures.len(), 1);
    let event = &failures[0];
    assert_eq!(event.level, Level::ERROR);
    assert_eq!(event.fields["endpoint"], "read next steerable input");
    assert!(event.fields["error"].starts_with("api error: "));
    assert_eq!(event.fields["failure_kind"], "request");
    assert_eq!(event.fields["failure_cause"], "http_incomplete_message");
    let event_debug = format!("{event:#?}");
    assert!(!event_debug.contains("runner-token"));
    assert!(!event_debug.contains(&api_url));
}

#[tokio::test]
async fn run_in_sandbox_keeps_reading_next_on_wakeups_after_failures() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"transient"}"#,
        )),
        RawHttpAction::Respond(json_response("404 Not Found", r#"{"error":"not found"}"#)),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(&server, &notifications, Vec::new()).await;
    run.expect_next_request(&mut server, "initial next").await;
    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "next after wakeup")
        .await;
    assert_idle_without_wakeup(&mut server, &run.overrides).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_reforwards_not_written_delivery_only_after_a_wakeup() {
    let mut server = RawHttpTestServer::spawn(vec![
        next_input("exact delivery"),
        next_input("exact delivery"),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(
        &server,
        &notifications,
        vec![sandbox::ProcessControlOutcome::Failed {
            kind: sandbox::ProcessControlFailureKind::Operation,
            write_state: sandbox::ProcessControlWriteState::NotWritten,
            error: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "not written"),
        }],
    )
    .await;
    run.expect_next_request(&mut server, "initial next").await;
    run.expect_control_calls(1).await;
    assert_idle_without_wakeup(&mut server, &run.overrides).await;

    // The unforwarded input is not recorded as forwarded, so the next read
    // offers it again with the same identity.
    notifications.notify(run.run_id);
    run.expect_next_request(&mut server, "next after wakeup")
        .await;
    run.expect_control_calls(2).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|call| call.message_id == EVENT_ID));
    assert_eq!(calls[0].payload, calls[1].payload);
}

#[tokio::test]
async fn run_in_sandbox_forwards_guest_backpressured_input_once_per_read() {
    let payload_overhead = identified_active_input_payload_len("").unwrap();
    let prompt = "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - payload_overhead);
    let expected_payload = encode_active_input(EVENT_ID, &prompt).unwrap();
    assert_eq!(
        expected_payload.len(),
        ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
    );
    let mut server = RawHttpTestServer::spawn(vec![
        next_input(&prompt),
        next_input(&prompt),
        next_input(&prompt),
    ])
    .await;
    let notifications = ActiveInputNotifications::new();
    let run = ApiRun::start(
        &server,
        &notifications,
        [
            sandbox::ProcessControlGuestStatus::QueueFull,
            sandbox::ProcessControlGuestStatus::SinkUnavailable,
        ]
        .into_iter()
        .map(|status| sandbox::ProcessControlOutcome::GuestStatus {
            status,
            diagnostic: "guest backpressure".to_string(),
        })
        .collect(),
    )
    .await;

    run.expect_next_request(&mut server, "initial next").await;
    for attempt in 1..=2 {
        run.expect_control_calls(attempt).await;
        assert_idle_without_wakeup(&mut server, &run.overrides).await;
        notifications.notify(run.run_id);
        run.expect_next_request(&mut server, "next after wakeup")
            .await;
    }
    run.expect_control_calls(3).await;
    let overrides = run.finish().await;
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|call| call.message_id == EVENT_ID));
    assert!(
        calls
            .iter()
            .all(|call| call.payload.as_slice() == expected_payload)
    );
}

#[tokio::test]
async fn run_in_sandbox_suppresses_possibly_written_delivery() {
    assert_uncertain_delivery_is_suppressed(sandbox::ProcessControlOutcome::Failed {
        kind: sandbox::ProcessControlFailureKind::Operation,
        write_state: sandbox::ProcessControlWriteState::PossiblyWritten,
        error: std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "delivery acknowledgement timed out",
        ),
    })
    .await;
}

#[tokio::test]
async fn run_in_sandbox_suppresses_delivery_when_control_sink_closed() {
    assert_uncertain_delivery_is_suppressed(sandbox::ProcessControlOutcome::GuestStatus {
        status: sandbox::ProcessControlGuestStatus::SinkClosed,
        diagnostic: "control sink closed".into(),
    })
    .await;
}

async fn assert_uncertain_delivery_is_suppressed(outcome: sandbox::ProcessControlOutcome) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_outcome(outcome);
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let next_input = json_response(
        "200 OK",
        &format!(r#"{{"input":{{"eventId":"{EVENT_ID}","prompt":"uncertain delivery"}}}}"#,),
    );
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(next_input.clone()),
        RawHttpAction::Respond(next_input),
        RawHttpAction::Respond(json_response("200 OK", r#"{"input":null}"#)),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-possibly-written-test",
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_cancel = cancel.clone();
    let mut telemetry = test_telemetry(&config, &ctx);

    let mut run_task = Some(tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: runner_types::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(run_cancel, Some(source)),
        )
        .await
    }));
    let mut server = Some(server);
    let deadline = tokio::time::Instant::now() + RUN_IN_SANDBOX_TEST_TIMEOUT;

    let scenario = async {
        let process_control_observed = tokio::time::timeout_at(
            deadline,
            overrides.wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT),
        )
        .await
        .map_err(|_| {
            "timed out waiting for the first process-control delivery attempt".to_string()
        })?;
        if !process_control_observed {
            return Err("timed out waiting for the first process-control delivery attempt".into());
        }
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the first request".into());
        };
        receive_http_request_before(deadline, server_fixture, "the first next request").await?;
        notifications.notify(run_id);
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the second request".into());
        };
        receive_http_request_before(
            deadline,
            server_fixture,
            "the second next request after the first notification",
        )
        .await?;
        notifications.notify(run_id);
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the third request".into());
        };
        receive_http_request_before(
            deadline,
            server_fixture,
            "the third next request after the second notification",
        )
        .await?;
        wait_gate.notify_one();

        let Some(run_handle) = run_task.as_mut() else {
            return Err("runner task ownership was lost before completion".into());
        };
        let run_outcome = tokio::time::timeout_at(deadline, run_handle)
            .await
            .map_err(|_| "timed out waiting for the runner task to finish".to_string())?;
        run_task.take();
        let result = run_outcome
            .map_err(|error| format!("runner task failed: {error}"))?
            .map_err(|error| format!("run_in_sandbox failed: {error}"))?;

        let Some(server_fixture) = server.take() else {
            return Err("active-input server task ownership was lost before completion".into());
        };
        server_fixture.assert_finished().await;
        Ok::<_, String>(result)
    }
    .await;

    let result = match scenario {
        Ok(result) => result,
        Err(error) => {
            cancel.cancel();
            wait_gate.notify_one();
            if let Some(server_fixture) = server.take() {
                server_fixture.cancel_and_reap().await;
            }
            let cleanup_errors = reap_spawned_test_task(run_task.take(), "runner")
                .await
                .into_iter()
                .collect::<Vec<_>>();
            if cleanup_errors.is_empty() {
                panic!("{error}");
            }
            panic!("{error}; cleanup errors: {}", cleanup_errors.join("; "));
        }
    };
    assert!(result.failure.is_none());
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, EVENT_ID);
}
