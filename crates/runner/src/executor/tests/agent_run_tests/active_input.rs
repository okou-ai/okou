use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use guest_contracts::active_input::{ACTIVE_INPUT_CLOSED_DIAGNOSTIC, encode_active_input};
use tracing::Level;
use tracing_subscriber::prelude::*;

use crate::active_input::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, API_ACTIVE_INPUT_RECHECK_INTERVAL,
    ActiveInputNotifications, ActiveInputSource, identified_active_input_payload_len,
    local_active_input_delivery_id,
};
use crate::executor::active_input::{
    ACTIVE_INPUT_CONTROL_RETRY_INITIAL_INTERVAL, ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL,
};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    CapturedEvent, CapturedEvents, RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox,
    minimal_context, sandbox_read_file_error, test_executor_config, test_telemetry,
};
use crate::http::{HttpClient, HttpClientConfig};
use crate::ids::RunId;
use crate::local_queue::{self, ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use crate::types::SandboxReuseResult;

mod read_backoff;
mod read_recovery;

const DELIVERY_ID: &str = "b1e2ad6d-930a-4d51-aa40-7952d54f978b";
const EVENT_ID: &str = "e6bc287d-8c08-464e-831a-cad771610157";

fn local_queue_with_job(group_dir: &Path, run_id: RunId) -> LocalQueue {
    let profile = crate::profile::DEFAULT_PROFILE;
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
    run_id: crate::ids::RunId,
    notifications: &ActiveInputNotifications,
    client_session_id: &str,
) -> ActiveInputSource {
    ActiveInputSource::api(
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: client_session_id.to_string(),
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
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
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 2),
            local_active_input_delivery_id(run_id, 3),
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
        payloads[0]["deliveryId"],
        local_active_input_delivery_id(run_id, 1)
    );
    assert_eq!(
        payloads[1]["deliveryId"],
        local_active_input_delivery_id(run_id, 2)
    );
    assert_eq!(
        payloads[2]["deliveryId"],
        local_active_input_delivery_id(run_id, 3)
    );
}

#[tokio::test]
async fn run_in_sandbox_retries_api_active_input_after_transient_read_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");

    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"empty"}"#)),
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"transient"}"#,
        )),
        RawHttpAction::Respond(json_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retry delivered"}}"#,
            ),
        )),
    ])
    .await;
    let api_url = server.url();

    let notifications = ActiveInputNotifications::new();
    let source =
        api_active_input_source(api_url, run_id, &notifications, "active-input-retry-test");
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let initial_reserve = server
        .next_request("initial active-input reserve request")
        .await;
    assert!(initial_reserve.starts_with(&format!("POST {reserve_path} ")));
    notifications.notify(run_id);

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await,
        "active input should be retried without another notification"
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());

    let remaining_requests = server.assert_finished_with_requests().await;
    assert_eq!(remaining_requests.len(), 2);
    assert!(remaining_requests[0].starts_with(&format!("POST {reserve_path} ")));
    assert!(remaining_requests[1].starts_with(&format!("POST {reserve_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["deliveryId"], DELIVERY_ID);
    assert_eq!(payload["text"], "retry delivered");
}

#[tokio::test]
async fn run_in_sandbox_rechecks_api_active_input_without_notification() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");

    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"empty"}"#)),
        RawHttpAction::Respond(json_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"recheck delivered"}}"#,
            ),
        )),
    ])
    .await;
    let api_url = server.url();

    let notifications = ActiveInputNotifications::new();
    let source =
        api_active_input_source(api_url, run_id, &notifications, "active-input-recheck-test");
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let initial_reserve = server
        .next_request("initial active-input reserve request")
        .await;
    assert!(initial_reserve.starts_with(&format!("POST {reserve_path} ")));

    tokio::time::pause();
    tokio::task::yield_now().await;
    tokio::time::advance(API_ACTIVE_INPUT_RECHECK_INTERVAL).await;
    tokio::time::resume();

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await,
        "active input should be rechecked without a notification"
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());

    let remaining_requests = server.assert_finished_with_requests().await;
    assert_eq!(remaining_requests.len(), 1);
    assert!(remaining_requests[0].starts_with(&format!("POST {reserve_path} ")));

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap()["text"],
        "recheck delivered"
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
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
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 1),
            local_active_input_delivery_id(run_id, 2),
        ]
    );
}

#[tokio::test]
async fn run_in_sandbox_retries_reserve_when_first_request_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response("404 Not Found", r#"{"error":"not found"}"#)),
        RawHttpAction::Respond(json_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"reserve delivered"}}"#,
            ),
        )),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-first-not-found-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["deliveryId"], DELIVERY_ID);
    assert_eq!(payload["text"], "reserve delivered");
}

#[tokio::test]
async fn run_in_sandbox_retrieves_reservation_after_lost_first_response() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let reserved = json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retrieved delivery"}}"#,
        ),
    );
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Disconnect,
        RawHttpAction::Respond(reserved),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url.clone(),
        run_id,
        &notifications,
        "active-input-lost-reserve-response-test",
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(guard);
    assert!(result.failure.is_none());
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let event = captured
        .entries()
        .into_iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "active-input source read failed; retrying")
        })
        .expect("active-input transport failure should be logged");
    assert_eq!(event.fields["endpoint"], "reserve active inputs");
    assert!(event.fields["error"].starts_with("api error: "));
    assert_eq!(event.fields["failure_kind"], "request");
    assert_eq!(event.fields["failure_cause"], "http_incomplete_message");
    let event_debug = format!("{event:#?}");
    assert!(!event_debug.contains("runner-token"));
    assert!(!event_debug.contains(&api_url));
}

#[tokio::test]
async fn run_in_sandbox_keeps_using_reserve_after_ambiguous_failure() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"transient"}"#,
        )),
        RawHttpAction::Respond(json_response("404 Not Found", r#"{"error":"not found"}"#)),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-reserve-only-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_stops_when_reserve_reports_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"outcome":"terminal"}"#,
    ))])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-terminal-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    server.assert_finished().await;
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_stops_when_reserve_reports_held() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(r#"{{"outcome":"held","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"]}}"#,),
    ))])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(api_url, run_id, &notifications, "active-input-held-test");
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let requests = server.assert_finished_with_requests().await;
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with(&format!("POST {reserve_path} ")));
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_stops_when_reserve_rejects_run_not_running() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        r#"{"outcome":"rejected","reason":"run_not_running"}"#,
    ))])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-run-not-running-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let requests = server.assert_finished_with_requests().await;
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with(&format!("POST {reserve_path} ")));
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_reconciles_after_payload_too_large_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "200 OK",
            r#"{"outcome":"rejected","reason":"payload_too_large"}"#,
        )),
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"terminal"}"#)),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-payload-too-large-test",
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
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
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the first request".into());
        };
        let first_request = receive_http_request_before(
            deadline,
            server_fixture,
            "the payload-too-large reserve request",
        )
        .await?;
        notifications.notify(run_id);
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the second request".into());
        };
        let second_request = receive_http_request_before(
            deadline,
            server_fixture,
            "the terminal reserve request after payload-too-large rejection",
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
        Ok::<_, String>((result, [first_request, second_request]))
    }
    .await;

    let (result, requests) = match scenario {
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
    assert!(
        requests
            .iter()
            .all(|request| request.starts_with(&format!("POST {reserve_path} ")))
    );
    assert!(overrides.process_control_calls().is_empty());
}

#[tokio::test]
async fn run_in_sandbox_retries_not_written_delivery_with_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::Failed {
        kind: sandbox::ProcessControlFailureKind::Operation,
        write_state: sandbox::ProcessControlWriteState::NotWritten,
        error: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "not written"),
    });
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"retry exact delivery"}}"#,
        ),
    ))])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-not-written-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(2, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 2);
    assert!(calls.iter().all(|call| call.message_id == DELIVERY_ID));
    assert_eq!(calls[0].payload, calls[1].payload);
}

#[tokio::test]
async fn run_in_sandbox_retries_guest_backpressure_with_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    for attempt in 0..7 {
        let status = if attempt % 2 == 0 {
            sandbox::ProcessControlGuestStatus::QueueFull
        } else {
            sandbox::ProcessControlGuestStatus::SinkUnavailable
        };
        overrides.push_process_control_outcome(sandbox::ProcessControlOutcome::GuestStatus {
            status,
            diagnostic: "retryable guest backpressure".to_string(),
        });
    }
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let payload_overhead = identified_active_input_payload_len("").unwrap();
    let prompt = "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - payload_overhead);
    let expected_payload = encode_active_input(DELIVERY_ID, &prompt).unwrap();
    assert_eq!(
        expected_payload.len(),
        ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
    );
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"{prompt}"}}"#,
        ),
    ))])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-guest-backpressure-test",
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut telemetry = test_telemetry(&config, &ctx);

    // Freeze the clock before the first attempt. Blocking work prevents Tokio
    // from auto-advancing through deadlines while startup performs real I/O.
    // Dropping the sender also releases the guard if an assertion panics.
    let (clock_release, clock_wait) = std::sync::mpsc::channel::<()>();
    let clock_guard = tokio::task::spawn_blocking(move || {
        let _ = clock_wait.recv_timeout(Duration::from_secs(30));
    });
    tokio::time::pause();

    let run_task = tokio::spawn(async move {
        run_in_sandbox(
            &*sandbox,
            &ctx,
            &config,
            RunStart {
                restore_guest_state: false,
                reuse_result: SandboxReuseResult::PoolMiss,
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    let retry_delays = [
        ACTIVE_INPUT_CONTROL_RETRY_INITIAL_INTERVAL,
        Duration::from_millis(500),
        Duration::from_secs(1),
        Duration::from_secs(2),
        ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL,
        ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL,
        ACTIVE_INPUT_CONTROL_RETRY_MAX_INTERVAL,
    ];
    let scheduling_margin = Duration::from_millis(10);
    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
            .await
    );
    let mut previous_attempt_at = tokio::time::Instant::now();
    drop(clock_release);
    for (index, expected_delay) in retry_delays.into_iter().enumerate() {
        assert!(
            overrides
                .wait_for_process_control_calls(index + 2, Duration::from_secs(30))
                .await,
            "control did not retry after backoff interval {index}"
        );
        let attempted_at = tokio::time::Instant::now();
        let elapsed = attempted_at.duration_since(previous_attempt_at);
        assert!(
            elapsed >= expected_delay && elapsed <= expected_delay + scheduling_margin,
            "retry interval {index} was {elapsed:?}, expected {expected_delay:?}"
        );
        previous_attempt_at = attempted_at;
    }

    tokio::time::resume();
    clock_guard.await.unwrap();
    wait_gate.notify_one();
    let result = tokio::time::timeout(RUN_IN_SANDBOX_TEST_TIMEOUT, run_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.failure.is_none());
    server.assert_finished().await;
    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), retry_delays.len() + 1);
    assert!(calls.iter().all(|call| call.message_id == DELIVERY_ID));
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
    let reserve = json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"uncertain delivery"}}"#,
        ),
    );
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(reserve.clone()),
        RawHttpAction::Respond(reserve),
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"empty"}"#)),
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
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
        receive_http_request_before(deadline, server_fixture, "the first reserve request").await?;
        notifications.notify(run_id);
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the second request".into());
        };
        receive_http_request_before(
            deadline,
            server_fixture,
            "the second reserve request after the first notification",
        )
        .await?;
        notifications.notify(run_id);
        let Some(server_fixture) = server.as_mut() else {
            return Err("active-input server ownership was lost before the third request".into());
        };
        receive_http_request_before(
            deadline,
            server_fixture,
            "the third reserve request after the second notification",
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
    assert_eq!(calls[0].message_id, DELIVERY_ID);
}

#[tokio::test]
async fn run_in_sandbox_carries_failed_journal_receipt_to_completion() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    overrides.push_read_file_result(Err(sandbox_read_file_error(
        "transient guest file read failure",
    )));
    overrides.push_read_file_result(Ok(Some(
        format!(r#"{{"runId":"{run_id}","deliveryIds":["{DELIVERY_ID}"]}}"#).into_bytes(),
    )));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let reserve_path = format!("/api/runners/runs/{run_id}/active-inputs/reserve");
    let receipt_path =
        format!("/api/runners/runs/{run_id}/active-inputs/deliveries/{DELIVERY_ID}/receipt");
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(json_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"recover receipt"}}"#,
            ),
        )),
        RawHttpAction::Respond(json_response(
            "503 Service Unavailable",
            r#"{"error":"transient"}"#,
        )),
    ])
    .await;
    let api_url = server.url();
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(
        api_url,
        run_id,
        &notifications,
        "active-input-journal-recovery-test",
    );
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
                workspace_reuse_result: crate::types::WorkspaceReuseResult::NotConfigured,
                prev_storage: None,
            },
            &mut telemetry,
            RunControls::new(cancel, Some(source)),
        )
        .await
    });

    assert!(
        overrides
            .wait_for_process_control_calls(1, RUN_IN_SANDBOX_TEST_TIMEOUT)
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
        result.active_input_delivery_ids,
        vec![DELIVERY_ID.to_string()]
    );
    let requests = server.assert_finished_with_requests().await;
    let first_request = &requests[0];
    let second_request = &requests[1];
    assert!(first_request.starts_with(&format!("POST {reserve_path} ")));
    assert!(second_request.starts_with(&format!("POST {receipt_path} ")));
}
