use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::error::TryRecvError;
use tracing_subscriber::prelude::*;

use super::{DELIVERY_ID, EVENT_ID, api_active_input_source};
use crate::executor::agent_run::{RunControls, RunStart, run_in_sandbox};
use crate::executor::tests::support::{
    CapturedEvents, RUN_IN_SANDBOX_TEST_TIMEOUT, create_overridden_sandbox, minimal_context,
    test_executor_config, test_telemetry,
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};
use runner_provider::ActiveInputNotifications;
use runner_types::ids::RunId;
use runner_types::types::SandboxReuseResult;

// Real HTTP I/O must make progress without advancing the paused retry clock.
// A wall-clock watchdog also bounds assertions when Tokio time is frozen.
pub(super) async fn observe<T>(description: &str, mut observed: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + RUN_IN_SANDBOX_TEST_TIMEOUT;
    loop {
        if let Some(value) = observed() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "timed out observing {description}"
        );
        tokio::task::yield_now().await;
    }
}

pub(super) async fn retry_delay(captured: &CapturedEvents, count: usize) -> Duration {
    observe("API read retry scheduling", || {
        let events = captured.entries();
        let retries = events
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("active-input API read retry scheduled")
            })
            .collect::<Vec<_>>();
        assert!(
            retries.len() <= count,
            "unexpected extra retry: {retries:?}"
        );
        (retries.len() == count).then(|| {
            Duration::from_millis(retries[count - 1].fields["retry_delay_ms"].parse().unwrap())
        })
    })
    .await
}

async fn take_reserve_request(server: &mut RawHttpTestServer, run_id: RunId) {
    let request = observe("reserve request", || match server.try_next_request() {
        Ok(request) => Some(request),
        Err(TryRecvError::Empty) => None,
        Err(error) => panic!("reserve server closed: {error}"),
    })
    .await;
    assert!(request.starts_with(&format!(
        "POST /api/runners/runs/{run_id}/active-inputs/reserve "
    )));
}

async fn advance_retry(
    server: &mut RawHttpTestServer,
    notifications: &ActiveInputNotifications,
    run_id: RunId,
    delay: Duration,
) {
    notifications.notify(run_id);
    tokio::time::advance(delay - Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert!(
        matches!(server.try_next_request(), Err(TryRecvError::Empty)),
        "a notification must not cause a request before the retry deadline"
    );
    // Tokio timers have millisecond granularity; cross the deadline explicitly.
    tokio::time::advance(Duration::from_millis(2)).await;
    take_reserve_request(server, run_id).await;
}

async fn exercise_read_backoff(run_id: RunId, cancel_while_waiting: bool) -> Duration {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let mut ctx = minimal_context();
    ctx.run_id = run_id;
    let failure = json_response("503 Service Unavailable", r#"{"error":"unavailable"}"#);
    let mut actions = (0..7)
        .map(|_| RawHttpAction::Respond(failure.clone()))
        .collect::<Vec<_>>();
    actions.extend([
        RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"empty"}"#)),
        RawHttpAction::Respond(failure.clone()),
        RawHttpAction::Respond(json_response(
            "200 OK",
            &format!(
                r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"backoff recovered"}}"#,
            ),
        )),
        RawHttpAction::Respond(failure),
        // Keep the server alive to detect an unwanted retry after stop/cancel.
        RawHttpAction::Stall,
    ]);
    let mut server = RawHttpTestServer::spawn(actions).await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(server.url(), run_id, &notifications, "read-backoff-test");
    let cancel = tokio_util::sync::CancellationToken::new();
    let run_cancel = cancel.clone();
    let mut telemetry = test_telemetry(&config, &ctx);
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();

    // Tokio suppresses automatic clock advancement while blocking work exists.
    // Closing the sender releases this guard even if an assertion panics.
    let (clock_release, clock_wait) = std::sync::mpsc::channel::<()>();
    let clock_guard = tokio::task::spawn_blocking(move || {
        let _ = clock_wait.recv_timeout(Duration::from_secs(30));
    });
    tokio::time::pause();
    let started_at = tokio::time::Instant::now();
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
            RunControls::new(run_cancel, Some(source)),
        )
        .await
    });
    take_reserve_request(&mut server, run_id).await;
    let mut delay = retry_delay(&captured, 1).await;
    assert_eq!(
        tokio::time::Instant::now(),
        started_at,
        "first read is immediate"
    );
    let initial_delay = delay;
    let bases_ms = [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000];
    for (index, base_ms) in bases_ms.into_iter().enumerate() {
        assert!(delay >= Duration::from_millis(base_ms * 8 / 10));
        assert!(delay <= Duration::from_millis(base_ms));
        advance_retry(&mut server, &notifications, run_id, delay).await;
        if index < bases_ms.len() - 1 {
            delay = retry_delay(&captured, index + 2).await;
        }
    }

    // The queued notifications trigger the next read after Empty, without
    // waiting for the safety recheck. Its failure must restart at attempt one.
    take_reserve_request(&mut server, run_id).await;
    delay = retry_delay(&captured, 8).await;
    assert_eq!(delay, initial_delay, "empty response resets the backoff");
    advance_retry(&mut server, &notifications, run_id, delay).await;
    observe("recovered Guest delivery", || {
        (overrides.process_control_calls().len() == 1).then_some(())
    })
    .await;
    take_reserve_request(&mut server, run_id).await;
    delay = retry_delay(&captured, 9).await;
    assert_eq!(delay, initial_delay, "reserved response resets the backoff");
    let calls = overrides.process_control_calls();
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["deliveryId"], DELIVERY_ID);
    assert_eq!(payload["text"], "backoff recovered");

    if cancel_while_waiting {
        cancel.cancel();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            server.try_next_request(),
            Err(TryRecvError::Empty)
        ));
    }
    let stop_started_at = tokio::time::Instant::now();
    wait_gate.notify_one();
    observe("Runner completion during retry delay", || {
        run_task.is_finished().then_some(())
    })
    .await;
    let result = run_task.await.unwrap().unwrap();
    assert_eq!(tokio::time::Instant::now(), stop_started_at);
    assert_eq!(result.failure.is_some(), cancel_while_waiting);
    assert_eq!(overrides.process_control_calls().len(), 1);
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::task::yield_now().await;
    assert!(matches!(
        server.try_next_request(),
        Err(TryRecvError::Empty)
    ));
    server.cancel_and_reap().await;
    tokio::time::resume();
    drop(clock_release);
    clock_guard.await.unwrap();
    initial_delay
}

#[tokio::test]
async fn run_in_sandbox_backs_off_api_reads_resets_and_stops_without_waiting() {
    let first = exercise_read_backoff(RunId::from(uuid::Uuid::from_u128(1)), false).await;
    let second = exercise_read_backoff(RunId::from(uuid::Uuid::from_u128(2)), false).await;
    assert_ne!(
        first, second,
        "different runs should not share every retry deadline"
    );
}

#[tokio::test]
async fn run_in_sandbox_cancels_api_read_backoff() {
    exercise_read_backoff(RunId::from(uuid::Uuid::from_u128(3)), true).await;
}

#[tokio::test]
async fn run_in_sandbox_spaces_failed_api_reads_on_the_wire() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let wait_gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&wait_gate),
    ));
    let sandbox = create_overridden_sandbox(Arc::clone(&overrides)).await;
    let ctx = minimal_context();
    let run_id = ctx.run_id;
    let mut actions = Vec::new();
    let mut releases = Vec::new();
    for _ in 0..3 {
        let (release, gate) = tokio::sync::oneshot::channel();
        releases.push(release);
        actions.push(RawHttpAction::WaitThenRespond {
            release: gate,
            response: json_response("503 Service Unavailable", r#"{"error":"unavailable"}"#),
        });
    }
    actions.push(RawHttpAction::Respond(json_response(
        "200 OK",
        &format!(
            r#"{{"outcome":"reserved","deliveryId":"{DELIVERY_ID}","eventIds":["{EVENT_ID}"],"prompt":"wire retry recovered"}}"#,
        ),
    )));
    let mut server = RawHttpTestServer::spawn(actions).await;
    let notifications = ActiveInputNotifications::new();
    let source = api_active_input_source(server.url(), run_id, &notifications, "wire-backoff-test");
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
            RunControls::new(tokio_util::sync::CancellationToken::new(), Some(source)),
        )
        .await
    });

    let reserve_prefix = format!("POST /api/runners/runs/{run_id}/active-inputs/reserve ");
    let initial = server.next_request("initial wire reserve").await;
    assert!(initial.starts_with(&reserve_prefix));
    let mut observed_delays = Vec::new();
    for release in releases {
        // Use real time and gate the response: backoff cannot begin before
        // this point. Paused-clock channel checks can miss an early request
        // whose real socket I/O has not yet been polled by the runtime.
        let released_at = Instant::now();
        release.send(()).unwrap();
        notifications.notify(run_id);
        let request = server.next_request("wire retry after failure").await;
        observed_delays.push(released_at.elapsed());
        assert!(request.starts_with(&reserve_prefix));
    }
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
    server.assert_finished().await;

    let calls = overrides.process_control_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].message_id, DELIVERY_ID);
    let payload = serde_json::from_slice::<serde_json::Value>(&calls[0].payload).unwrap();
    assert_eq!(payload["text"], "wire retry recovered");
    for (elapsed, minimum_ms) in observed_delays.into_iter().zip([200, 400, 800]) {
        assert!(
            elapsed >= Duration::from_millis(minimum_ms),
            "reserve retry arrived after {elapsed:?}, before its {minimum_ms} ms lower bound"
        );
    }
}
