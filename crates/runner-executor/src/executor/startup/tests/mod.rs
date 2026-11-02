use std::{
    future::{Future, poll_fn},
    pin::Pin,
    task::Poll,
};

use super::*;
use httpmock::prelude::*;
use runner_provider::http::HttpClientConfig;
use tracing::{Level, instrument::WithSubscriber};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};

fn client(api_url: String) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url,
        vercel_bypass: None,
        client_session_id: "startup-report-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap()
}

async fn wait_for_retry(
    mut report: Pin<&mut impl Future<Output = ()>>,
    captured: &CapturedEvents,
    attempt: usize,
) {
    let attempt = attempt.to_string();
    tokio::time::timeout(
        Duration::from_secs(5),
        poll_fn(|cx| {
            assert!(
                report.as_mut().poll(cx).is_pending(),
                "startup report finished before retry {attempt}"
            );
            if captured.entries().iter().any(|entry| {
                entry
                    .fields
                    .get("message")
                    .is_some_and(|message| message.starts_with("sandbox startup report"))
                    && entry.fields.get("attempt") == Some(&attempt)
                    && entry.fields.get("will_retry").map(String::as_str) == Some("true")
            }) {
                // No await separates the retry event from the sleep select.
                // This Pending poll has established the owned sleep's deadline.
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        }),
    )
    .await
    .expect("startup report should reach its retry wait");
}

async fn advance_retry(
    report: Pin<&mut impl Future<Output = ()>>,
    captured: &CapturedEvents,
    attempt: usize,
) {
    wait_for_retry(report, captured, attempt).await;
    // Keep the report unpolled while time is paused. Real HTTP and peer
    // cleanup run only after resuming, with the production timeout intact.
    tokio::time::pause();
    tokio::time::advance(STARTUP_REPORT_RETRY_DELAY).await;
    tokio::time::resume();
}

#[tokio::test]
async fn sends_all_canonical_paths_with_run_token_and_generated_route() {
    for (path, wire) in [
        (SandboxStartupPath::Sandbox, "sandbox"),
        (SandboxStartupPath::Home, "home"),
        (SandboxStartupPath::Blank, "blank"),
        (SandboxStartupPath::Cold, "cold"),
    ] {
        let server = MockServer::start_async().await;
        let run_id = RunId::new_v4();
        let mock = server.mock(|when, then| {
            when.method(PUT)
                .path(format!("/api/runners/runs/{run_id}/startup"))
                .header("authorization", "Bearer startup-run-token")
                .header("X-Client-Type", "Runner")
                .json_body(serde_json::json!({ "sandboxStartupPath": wire }));
            then.status(204);
        });
        report_startup_path(
            &client(server.base_url()),
            run_id,
            "startup-run-token",
            path,
            &CancellationToken::new(),
        )
        .await;
        mock.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn retries_transient_failures_with_identical_startup_fact() {
    let rejection =
        |status| RawHttpAction::Respond(json_response(&format!("{status} Retryable"), "{}"));
    for [first, second] in [
        [rejection(503), rejection(503)],
        [rejection(408), rejection(421)],
        [rejection(425), rejection(429)],
        [RawHttpAction::Disconnect, rejection(503)],
    ] {
        let mut server = RawHttpTestServer::spawn(vec![
            first,
            second,
            RawHttpAction::Respond(
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_vec(),
            ),
        ])
        .await;
        let http = client(server.url());
        let run_id = RunId::new_v4();
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let cancel = CancellationToken::new();
        let report = report_startup_path(
            &http,
            run_id,
            "startup-run-token",
            SandboxStartupPath::Blank,
            &cancel,
        )
        .with_subscriber(subscriber);
        tokio::pin!(report);
        for (attempt, description) in [
            (1, "initial startup report"),
            (2, "second attempt"),
            (3, "third attempt"),
        ] {
            let request = tokio::select! {
                biased;
                request = server.next_request(description) => request,
                () = &mut report => panic!("startup report finished before {description}"),
            };
            assert!(request.starts_with(&format!("PUT /api/runners/runs/{run_id}/startup ")));
            assert!(request.contains(r#"{"sandboxStartupPath":"blank"}"#));
            if attempt < STARTUP_REPORT_MAX_ATTEMPTS {
                advance_retry(report.as_mut(), &captured, attempt).await;
            }
        }
        report.await;
        server.assert_finished().await;
        let reports: Vec<_> = captured
            .entries()
            .into_iter()
            .filter(|entry| {
                entry
                    .fields
                    .get("message")
                    .is_some_and(|message| message.starts_with("sandbox startup report"))
            })
            .collect();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|entry| entry.level == Level::INFO));
        for (index, entry) in reports.iter().enumerate() {
            assert_eq!(entry.fields.get("attempt"), Some(&(index + 1).to_string()));
            assert_eq!(
                entry.fields.get("max_attempts").map(String::as_str),
                Some("3")
            );
            assert_eq!(
                entry.fields.get("will_retry").map(String::as_str),
                Some("true")
            );
        }
    }
}

#[tokio::test]
async fn permanent_rejections_are_not_retried() {
    for status in [400, 401, 404, 409] {
        let server = MockServer::start_async().await;
        let mock = server.mock(|when, then| {
            when.method(PUT);
            then.status(status);
        });
        report_startup_path(
            &client(server.base_url()),
            RunId::new_v4(),
            "startup-run-token",
            SandboxStartupPath::Cold,
            &CancellationToken::new(),
        )
        .await;
        mock.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn exhausted_startup_reports_emit_error_only_after_three_attempts() {
    let server = MockServer::start_async().await;
    let mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(503);
    });
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let http = client(server.base_url());
    let cancel = CancellationToken::new();
    let report = report_startup_path(
        &http,
        RunId::new_v4(),
        "startup-run-token",
        SandboxStartupPath::Cold,
        &cancel,
    )
    .with_subscriber(subscriber);
    tokio::pin!(report);
    for attempt in 1..STARTUP_REPORT_MAX_ATTEMPTS {
        advance_retry(report.as_mut(), &captured, attempt).await;
    }
    report.await;
    mock.assert_calls_async(3).await;
    // Retry severity is an explicit Runner operational contract requested
    // by the user; the real HTTP requests also prove the bounded attempts.
    let reports: Vec<_> = captured
        .entries()
        .into_iter()
        .filter(|entry| {
            entry
                .fields
                .get("message")
                .is_some_and(|message| message.starts_with("sandbox startup report"))
        })
        .collect();
    assert_eq!(
        reports.iter().map(|entry| entry.level).collect::<Vec<_>>(),
        vec![Level::INFO, Level::INFO, Level::ERROR]
    );
    let last = reports.last().unwrap();
    assert_eq!(last.fields.get("attempt").map(String::as_str), Some("3"));
    assert_eq!(
        last.fields.get("will_retry").map(String::as_str),
        Some("false")
    );
}

#[tokio::test]
async fn cancellation_during_retry_wait_does_not_send_another_request() {
    let server = MockServer::start_async().await;
    let mock = server.mock(|when, then| {
        when.method(PUT);
        then.status(503);
    });
    let http = client(server.base_url());
    let cancel = CancellationToken::new();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let report = report_startup_path(
        &http,
        RunId::new_v4(),
        "startup-run-token",
        SandboxStartupPath::Home,
        &cancel,
    )
    .with_subscriber(subscriber);
    tokio::pin!(report);
    wait_for_retry(report.as_mut(), &captured, 1).await;
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), report)
        .await
        .expect("cancellation should finish the pending retry");
    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn cancellation_closes_an_in_flight_startup_request() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let http = client(server.url());
    let cancel = CancellationToken::new();
    let report = report_startup_path(
        &http,
        RunId::new_v4(),
        "startup-run-token",
        SandboxStartupPath::Home,
        &cancel,
    );
    tokio::pin!(report);
    tokio::select! {
        biased;
        _ = server.next_request("startup before cancellation") => {},
        () = &mut report => panic!("startup report finished before cancellation"),
    }
    // Freeze the request deadline only for this synchronous cancellation poll.
    // Awaiting the report could otherwise succeed through its HTTP timeout.
    tokio::time::pause();
    cancel.cancel();
    let completed = poll_fn(|cx| Poll::Ready(report.as_mut().poll(cx).is_ready())).await;
    tokio::time::resume();
    assert!(
        completed,
        "cancelled in-flight request still waits for HTTP timeout"
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn dropping_report_owner_closes_an_in_flight_startup_request() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let report = StartupReport::spawn(
        client(server.url()),
        RunId::new_v4(),
        "startup-run-token".into(),
        SandboxStartupPath::Home,
        CancellationToken::new(),
    );
    server.next_request("startup before owner drop").await;
    drop(report);
    server.assert_finished().await;
}
