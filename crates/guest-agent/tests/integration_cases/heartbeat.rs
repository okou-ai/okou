use crate::support::*;
use guest_contracts::diagnostics::HttpAttemptFailureKind;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

// =========================================================================
// Heartbeat
// =========================================================================

async fn wait_for_count(count: impl Fn() -> usize, expected: usize, context: &str) {
    for _ in 0..1_000 {
        if count() >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }

    assert!(
        count() >= expected,
        "expected at least {expected} {context}, observed {}",
        count(),
    );
}

async fn settle_runnable_tasks() {
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn heartbeat_first_success() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            observer_for_mock.record();
            http_status(200)
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let mut handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_for_run(
            TEST_RUN_ID.to_string(),
            http_client!(),
            shutdown_clone,
        )
        .await
    });

    // Wait for the first heartbeat to land, then shut down.
    observer
        .wait_for(
            1,
            MOCK_CALL_TIMEOUT,
            "heartbeat_first_success initial heartbeat",
        )
        .await;
    shutdown.cancel();

    let join_result = tokio::time::timeout(Duration::from_secs(30), &mut handle).await;
    if join_result.is_err() {
        handle.abort();
        let _ = handle.await;
    }
    mock.delete_async().await;

    let result = join_result
        .expect("initial-success heartbeat loop should stop after cancellation within 30 seconds")
        .expect("initial-success heartbeat task should not panic");
    assert!(result.is_ok());
}

#[tokio::test(start_paused = true)]
async fn heartbeat_does_not_replay_overdue_ticks_after_slow_request() {
    const INTERVAL: Duration = Duration::from_millis(20);
    const SLOW_REQUEST_DURATION: Duration = Duration::from_millis(55);

    let mut server = crate::common::ControlledHttpServer::start()
        .await
        .expect("start controlled heartbeat server");
    let http = guest_agent::http::HttpClient::with_api_config(
        server.base_url.clone(),
        "test-token-abc123",
        "test-bypass-value",
        TEST_RUN_ID,
        Duration::ZERO,
    )
    .expect("build heartbeat HTTP client");
    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_for_run_with_interval(
            TEST_RUN_ID.to_string(),
            http,
            shutdown_clone,
            INTERVAL,
        )
        .await
    });
    let clock_guard = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });

    let started_at = Instant::now();
    wait_for_count(|| server.request_count(), 1, "heartbeat requests").await;
    let first_request = server
        .next_request(MOCK_CALL_TIMEOUT)
        .await
        .expect("initial heartbeat should arrive immediately");
    assert_eq!(Instant::now(), started_at);

    tokio::time::advance(SLOW_REQUEST_DURATION).await;
    first_request
        .respond(200)
        .expect("release slow initial heartbeat");

    wait_for_count(|| server.request_count(), 2, "heartbeat requests").await;
    let second_request = server
        .next_request(MOCK_CALL_TIMEOUT)
        .await
        .expect("one overdue heartbeat should run after the slow request");
    assert_eq!(
        Instant::now().duration_since(started_at),
        SLOW_REQUEST_DURATION
    );
    second_request
        .respond(200)
        .expect("complete overdue heartbeat");
    wait_for_count(
        || server.completed_response_count(),
        2,
        "completed heartbeat responses",
    )
    .await;
    settle_runnable_tasks().await;
    assert_eq!(
        server.request_count(),
        2,
        "completing the overdue heartbeat must not replay another overdue tick"
    );

    tokio::time::advance(INTERVAL - Duration::from_millis(1)).await;
    settle_runnable_tasks().await;
    assert_eq!(
        server.request_count(),
        2,
        "the next heartbeat must wait a full interval instead of replaying another overdue tick"
    );

    tokio::time::advance(Duration::from_millis(1)).await;
    wait_for_count(|| server.request_count(), 3, "heartbeat requests").await;
    let third_request = server
        .next_request(MOCK_CALL_TIMEOUT)
        .await
        .expect("heartbeat should resume after one full interval");
    assert_eq!(
        Instant::now().duration_since(started_at),
        SLOW_REQUEST_DURATION + INTERVAL
    );
    third_request
        .respond(200)
        .expect("complete resumed heartbeat");

    shutdown.cancel();
    wait_for_count(
        || usize::from(handle.is_finished()),
        1,
        "finished heartbeat tasks",
    )
    .await;
    let result = handle.await.expect("heartbeat task should not panic");
    clock_guard.abort();
    assert!(result.is_ok(), "heartbeat should stop cleanly: {result:?}");
}

#[tokio::test]
async fn heartbeat_first_failure_fatal() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.status(500);
    });

    let shutdown = CancellationToken::new();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        guest_agent::heartbeat::heartbeat_loop_for_run(
            TEST_RUN_ID.to_string(),
            http_client!(),
            shutdown,
        ),
    )
    .await;
    let heartbeat_calls = mock.calls_async().await;
    mock.delete_async().await;

    let failure = result
        .expect("initial-failure heartbeat loop should stop within 30 seconds")
        .expect_err("initial heartbeat failure should be terminal");
    assert_eq!(heartbeat_calls, 3);
    assert_eq!(failure.diagnostic.failed_cycles.len(), 1);
    let cycle = &failure.diagnostic.failed_cycles[0];
    assert_eq!(cycle.attempts.len(), 3);
    for (index, attempt) in cycle.attempts.iter().enumerate() {
        assert_eq!(attempt.attempt, u32::try_from(index + 1).unwrap());
        assert!(!attempt.client_request_id.is_empty());
        assert_eq!(attempt.failure_kind, HttpAttemptFailureKind::HttpStatus);
        assert_eq!(attempt.http_status, Some(500));
        assert_eq!(attempt.timeout_observed, None);
        assert_eq!(attempt.connect_observed, None);
    }
    assert_ne!(
        cycle.attempts[0].client_request_id,
        cycle.attempts[1].client_request_id
    );
}

#[tokio::test]
async fn heartbeat_consecutive_failures_fatal() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| {
            if observer_for_mock.record() == 1 {
                return http_status(200);
            }

            json_http_response(401, json!({"error": {"message": "Run expired"}}))
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_for_run_with_interval(
            TEST_RUN_ID.to_string(),
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // heartbeat_loop should exit after MAX_CONSECUTIVE_HEARTBEAT_FAILURES.
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");

    // Clean up mocks before assertions to avoid leaks on panic.
    let heartbeat_calls = observer.calls();
    mock.delete_async().await;
    shutdown.cancel();

    let failure = result.expect_err("consecutive heartbeat failures should be terminal");
    let err = failure.to_string();
    assert!(
        err.contains("consecutive"),
        "error should mention consecutive failures: {err}"
    );

    // 401 is a 4xx error -> post_json returns immediately (no internal retries),
    // so the sequence is one success followed by the fatal failure window.
    assert_eq!(heartbeat_calls, 4);
    assert_eq!(failure.diagnostic.failed_cycles.len(), 3);
    assert!(
        failure
            .diagnostic
            .failed_cycles
            .iter()
            .all(|cycle| cycle.attempts.len() == 1)
    );
}

#[tokio::test]
async fn heartbeat_recovery_resets_counter() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let observer = MockCallObserver::default();
    let observer_for_mock = observer.clone();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/heartbeat");
        then.respond_with(move |_req| match observer_for_mock.record() {
            2 | 3 | 5 | 6 | 7 => {
                json_http_response(401, json!({"error": {"message": "Run expired"}}))
            }
            _ => http_status(200),
        });
    });

    let shutdown = CancellationToken::new();
    let shutdown_clone = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::heartbeat::heartbeat_loop_for_run_with_interval(
            TEST_RUN_ID.to_string(),
            http_client!(),
            shutdown_clone,
            TEST_HEARTBEAT_INTERVAL,
        )
        .await
    });

    // Sequence: success -> 2 failures -> recovery -> 3 failures. The terminal
    // diagnostic must retain only the failures after recovery.
    let result = tokio::time::timeout(Duration::from_secs(30), handle)
        .await
        .expect("heartbeat_loop should exit within timeout")
        .expect("task should not panic");
    let heartbeat_calls = observer.calls();
    mock.delete_async().await;
    shutdown.cancel();

    let failure = result.expect_err("three failures after recovery should be terminal");
    assert_eq!(heartbeat_calls, 7);
    assert_eq!(failure.diagnostic.failed_cycles.len(), 3);
    assert!(
        failure
            .diagnostic
            .failed_cycles
            .iter()
            .all(|cycle| cycle.attempts.len() == 1)
    );
}
