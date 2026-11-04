use super::*;
use crate::env::Framework;
use httpmock::prelude::*;
use raw_http_test_support::clock::advance_timer_phase;
use serde_json::json;
use tokio::time::{self, Instant};

const RETRY_DELAY: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(5);

fn send(runtime: &EventDeliveryRuntime, sequence: u32) {
    runtime
        .sender()
        .try_send_for_framework(
            sequence,
            json!({
                "type": "item.completed",
                "item": {"id": "message", "type": "agent_message", "text": "output"}
            }),
            Framework::Codex,
            &SecretMasker::from_raw(""),
        )
        .unwrap();
}

fn start(server: &MockServer) -> EventDeliveryRuntime {
    let http = HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "test-session",
        RETRY_DELAY,
    )
    .unwrap();
    EventDeliveryRuntime::start(http, "retry-close").unwrap()
}

async fn wait_for_completed_attempt(runtime: &EventDeliveryRuntime, attempt: u32) {
    time::timeout(IO_TIMEOUT, async {
        loop {
            let completed = {
                let progress = progress_guard(&runtime.progress);
                progress.active_batch.as_ref().is_some_and(|batch| {
                    batch.attempt_count == attempt && batch.active_attempt.is_none()
                })
            };
            if completed {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("HTTP response must be processed before advancing its retry timer");
}

async fn enter_backoff(runtime: &EventDeliveryRuntime) {
    send(runtime, 1);
    for attempt in 1..=3 {
        wait_for_completed_attempt(runtime, attempt).await;
        // On this current-thread runtime the worker cannot yield between
        // recording an HTTP 500 and arming its next timer. Attempts 1 and 2
        // arm HTTP's inner retry delay; attempt 3 arms the outer backoff.
        if attempt < 3 {
            advance_timer_phase(RETRY_DELAY).await;
        }
    }
}

fn assert_failed_batch(report: &EventDeliveryReport, acknowledged: Option<u32>) {
    assert_eq!(report.last_acknowledged_sequence, acknowledged);
    let diagnostic = report.diagnostic.as_ref().unwrap();
    assert_eq!(diagnostic.failed_batches, 1);
    assert_eq!(diagnostic.last_acknowledged_sequence, acknowledged);
    assert!(diagnostic.drain_timeout.is_none());
    let failed = diagnostic.first_failed_batch.as_ref().unwrap();
    assert_eq!((failed.first_sequence, failed.last_sequence), (1, 1));
    assert_eq!(failed.event_count, 1);
    assert_eq!(
        failed.response_state,
        EventDeliveryResponseState::AllHttpErrors
    );
    assert_eq!(failed.attempts.len(), 3);
}

#[tokio::test]
async fn finish_wakes_failed_batch_backoff_without_advancing_time() {
    let server = MockServer::start_async().await;
    let failed = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(500);
    });
    let runtime = start(&server);
    enter_backoff(&runtime).await;

    // All response I/O has completed. Close and join the worker while paused:
    // the original unconditional sleep would auto-advance by 30 seconds here.
    time::pause();
    let closed_at = Instant::now();
    let report = runtime.finish().await.unwrap();
    let elapsed = closed_at.elapsed();
    time::resume();

    assert_eq!(elapsed, Duration::ZERO);
    assert_failed_batch(&report, None);
    assert_eq!(report.diagnostic.as_ref().unwrap().total_batches, 1);
    failed.assert_calls_async(3).await;
}

#[tokio::test]
async fn close_during_backoff_drains_later_events_without_retrying_failed_batch() {
    let server = MockServer::start_async().await;
    let failed = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"events":[{"sequenceNumber":1}]}"#);
        then.status(500);
    });
    let later = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"events":[{"sequenceNumber":2}]}"#);
        then.status(200);
    });
    let runtime = start(&server);
    enter_backoff(&runtime).await;
    send(&runtime, 2);
    // Ordinary admission must not bypass backoff. Keep half the delay remaining
    // while letting any incorrectly awakened retry run on the real transport.
    advance_timer_phase(RETRY_DELAY / 2).await;
    tokio::task::yield_now().await;

    let report = time::timeout(IO_TIMEOUT, runtime.finish())
        .await
        .expect("closure must wake backoff and drain later accepted events")
        .unwrap();

    assert_failed_batch(&report, Some(2));
    let diagnostic = report.diagnostic.as_ref().unwrap();
    assert_eq!(diagnostic.total_events, 2);
    assert_eq!(diagnostic.total_batches, 2);
    failed.assert_calls_async(3).await;
    later.assert_calls_async(1).await;
}

#[tokio::test]
async fn backoff_expiry_retries_while_execution_continues() {
    let server = MockServer::start_async().await;
    let failed = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(500);
    });
    let runtime = start(&server);
    enter_backoff(&runtime).await;
    failed.assert_calls_async(3).await;
    failed.delete_async().await;
    let recovered = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"events":[{"sequenceNumber":1}]}"#);
        then.status(200);
    });

    advance_timer_phase(RETRY_DELAY).await;
    time::timeout(IO_TIMEOUT, async {
        while recovered.calls_async().await != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("backoff expiry must admit another HTTP cycle without closure");
    let report = time::timeout(IO_TIMEOUT, runtime.finish())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.last_acknowledged_sequence, Some(1));
    assert!(report.diagnostic.is_none());
    recovered.assert_calls_async(1).await;
}
