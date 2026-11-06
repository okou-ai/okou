use super::*;
use crate::http::HttpClientConfig;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer};
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

fn client(url: &str) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url: url.into(),
        vercel_bypass: Some("private-bypass".into()),
        client_session_id: "recovery-session".into(),
        runner_version: "1.2.3",
    })
    .unwrap()
}

fn ok() -> RawHttpAction {
    RawHttpAction::Respond(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec(),
    )
}

fn request_id(request: &str) -> &str {
    request
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("x-client-request-id")
                .then_some(value.trim())
        })
        .unwrap()
}

#[tokio::test]
async fn reset_recovers_safe_reads_and_audited_posts_with_fresh_attempt_identity() {
    for method in [reqwest::Method::GET, reqwest::Method::POST] {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, ok()]).await;
        let http = client(&server.url());
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let mut request = http
            .authenticated_request(
                method.clone(),
                format!("{}/read", server.url()),
                "private-token",
            )
            .query(&[("cursor", "private cursor")])
            .json(&serde_json::json!({"private": "body"}));
        if method == reqwest::Method::POST {
            request = request.idempotent();
        }
        let response = request
            .send("read")
            .with_subscriber(subscriber)
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "ok");
        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 2);
        assert_ne!(request_id(&requests[0]), request_id(&requests[1]));
        for request in &requests {
            assert!(request.starts_with(&format!(
                "{method} /read?cursor=private+cursor HTTP/1.1\r\n"
            )));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer private-token\r\n")
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("x-vercel-protection-bypass: private-bypass\r\n")
            );
            assert_eq!(
                request.split_once("\r\n\r\n").unwrap().1,
                r#"{"private":"body"}"#
            );
        }
        let events = captured.entries();
        let failures: Vec<_> = events
            .iter()
            .filter(|e| {
                e.fields.get("message").map(String::as_str)
                    == Some("API transport failure diagnostics")
            })
            .collect();
        assert_eq!(failures.len(), 1, "{events:#?}");
        assert_eq!(
            failures[0].fields["client_request_id"],
            request_id(&requests[0])
        );
        let records = format!("{events:#?}");
        for secret in [
            "private-token",
            "private-bypass",
            "private cursor",
            r#""private":"body""#,
        ] {
            assert!(!records.contains(secret), "recovery logs leaked {secret}");
        }
    }
}

#[tokio::test]
async fn responses_without_a_recovery_trigger_add_no_recovery_logs_or_requests() {
    let server = RawHttpTestServer::spawn(vec![
        ok(),
        RawHttpAction::Respond(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ),
    ])
    .await;
    let http = client(&server.url());
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    async {
        for status in [reqwest::StatusCode::OK, reqwest::StatusCode::NOT_FOUND] {
            assert_eq!(
                http.authenticated_request(reqwest::Method::GET, server.url(), "token")
                    .send("read")
                    .await
                    .unwrap()
                    .status(),
                status
            );
        }
    }
    .with_subscriber(subscriber)
    .await;
    assert_eq!(server.assert_finished_with_requests().await.len(), 2);
    assert!(!captured.entries().iter().any(|event| {
        event
            .fields
            .get("message")
            .is_some_and(|message| message.starts_with("API request recovery"))
    }));
}

#[tokio::test]
async fn repeated_resets_stop_after_two_attempts_and_report_the_final_identity() {
    let server = RawHttpTestServer::spawn(vec![
        RawHttpAction::ResetConnection,
        RawHttpAction::ResetConnection,
    ])
    .await;
    let error = client(&server.url())
        .authenticated_request(reqwest::Method::GET, server.url(), "token")
        .send("read")
        .await
        .unwrap_err();
    let ProviderError::ApiTransport(error) = error else {
        panic!("typed transport error required")
    };
    assert_eq!(error.failure_cause, ApiTransportCause::ConnectionReset);
    let requests = server.assert_finished_with_requests().await;
    assert_eq!(requests.len(), 2);
    assert_ne!(request_id(&requests[0]), request_id(&requests[1]));
    assert_eq!(error.request.client_request_id, request_id(&requests[1]));
}

#[tokio::test]
async fn ambiguous_writes_and_response_body_failures_are_never_replayed() {
    for body_failure in [false, true] {
        let action = if body_failure {
            RawHttpAction::Respond(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial"
                    .to_vec(),
            )
        } else {
            RawHttpAction::ResetConnection
        };
        let mut server = RawHttpTestServer::spawn(vec![action, ok()]).await;
        let http = client(&server.url());
        let method = if body_failure {
            reqwest::Method::GET
        } else {
            reqwest::Method::POST
        };
        let result = http
            .authenticated_request(method, server.url(), "token")
            .json(&serde_json::json!({"append": "once"}))
            .send("write")
            .await;
        if body_failure {
            let error = result.unwrap().text().await.unwrap_err();
            assert!(error.is_decode());
            assert_eq!(
                api_transport_cause(&error),
                ApiTransportCause::UnexpectedEof
            );
        } else {
            assert!(
                matches!(result, Err(ProviderError::ApiTransport(error)) if error.failure_cause == ApiTransportCause::ConnectionReset)
            );
        }
        // The peer captured the complete write before resetting it. A successful
        // response is available to expose any unintended duplicate submission.
        server.next_request("original request").await;
        assert!(server.try_next_request().is_err());
        server.cancel_and_reap().await;
    }
}

#[tokio::test]
async fn non_cloneable_body_disables_replay_even_for_a_safe_method() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, ok()]).await;
    let http = client(&server.url());
    let mut prepared = http
        .authenticated_request(reqwest::Method::GET, server.url(), "token")
        .prepare("read")
        .unwrap();
    *prepared.request.body_mut() = Some(reqwest::Body::wrap("private-stream".to_owned()));
    let result = prepared.send().await;
    assert!(
        matches!(result, Err(ProviderError::ApiTransport(error)) if error.failure_cause == ApiTransportCause::ConnectionReset)
    );
    let request = server.next_request("non-replayable request").await;
    assert_eq!(request.split_once("\r\n\r\n").unwrap().1, "private-stream");
    assert!(server.try_next_request().is_err());
    server.cancel_and_reap().await;
}

#[tokio::test]
async fn recovery_shares_the_original_overridden_deadline() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::ResetConnection,
        RawHttpAction::WaitForDisconnect,
    ])
    .await;
    let http = client(&server.url());
    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(1);
    let pending = tokio::spawn(
        http.authenticated_request(reqwest::Method::GET, server.url(), "token")
            .timeout(Duration::from_secs(1))
            .send("read"),
    );
    server.next_request("first attempt").await;
    server.next_request("recovery attempt").await;
    tokio::time::pause();
    tokio::time::advance(
        deadline.saturating_duration_since(tokio::time::Instant::now()) + Duration::from_millis(1),
    )
    .await;
    let result = pending.await.unwrap();
    tokio::time::resume();
    assert!(
        matches!(result, Err(ProviderError::ApiTransport(error)) if error.failure_cause == ApiTransportCause::Timeout)
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn dropped_caller_during_backoff_never_starts_a_recovery() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, ok()]).await;
    let http = client(&server.url());
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    {
        let request = http
            .authenticated_request(reqwest::Method::GET, server.url(), "token")
            .send("read")
            .with_subscriber(subscriber);
        tokio::pin!(request);
        tokio::time::timeout(
            Duration::from_secs(1),
            std::future::poll_fn(|cx| {
                assert!(request.as_mut().poll(cx).is_pending());
                if captured.entries().iter().any(|e| {
                    e.fields.get("message").map(String::as_str)
                        == Some("API request recovery waiting")
                }) {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            }),
        )
        .await
        .unwrap();
    }
    server.next_request("abandoned original attempt").await;
    assert!(
        server
            .next_request_before(
                tokio::time::Instant::now() + Duration::from_millis(200),
                "unexpected recovery"
            )
            .await
            .unwrap_err()
            .starts_with("timed out waiting")
    );
    assert_eq!(
        http.inner.retry_slots.available_permits(),
        MAX_CONCURRENT_RECOVERIES
    );
    server.cancel_and_reap().await;
}

#[tokio::test]
async fn conditional_cancellation_interrupts_backoff_without_discarding_the_response() {
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(
            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
        ),
        ok(),
    ])
    .await;
    let http = client(&server.url());
    let cancel = CancellationToken::new();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let request = http
        .authenticated_request(reqwest::Method::POST, server.url(), "token")
        .recovery(
            RecoveryPolicy::bounded(
                2,
                Duration::from_millis(100),
                RetryConditions::ResetOrStatus(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
            )
            .until(Instant::now() + Duration::from_secs(10), cancel.clone()),
        )
        .send("claim")
        .with_subscriber(subscriber);
    tokio::pin!(request);
    tokio::time::timeout(
        Duration::from_secs(1),
        std::future::poll_fn(|cx| {
            assert!(request.as_mut().poll(cx).is_pending());
            if captured.entries().iter().any(|e| {
                e.fields.get("message").map(String::as_str) == Some("API request recovery waiting")
            }) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        }),
    )
    .await
    .unwrap();
    cancel.cancel();
    assert_eq!(
        request.await.unwrap().status(),
        reqwest::StatusCode::INTERNAL_SERVER_ERROR
    );
    server.next_request("original admitted request").await;
    assert!(server.try_next_request().is_err());
    assert_eq!(
        http.inner.retry_slots.available_permits(),
        MAX_CONCURRENT_RECOVERIES
    );
    server.cancel_and_reap().await;
}

#[tokio::test]
async fn conditional_expiry_during_the_initial_attempt_prevents_replay() {
    let (release, wait) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
        release: wait,
        response: b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    }, ok()]).await;
    let http = client(&server.url());
    let request = tokio::spawn(
        http.authenticated_request(reqwest::Method::POST, server.url(), "token")
            .recovery(
                RecoveryPolicy::bounded(
                    2,
                    Duration::from_millis(100),
                    RetryConditions::ResetOrStatus(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
                )
                .until(
                    Instant::now() + Duration::from_millis(150),
                    CancellationToken::new(),
                ),
            )
            .send("claim"),
    );
    server
        .next_request("initial attempt admitted before expiry")
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    release.send(()).unwrap();
    assert_eq!(
        request.await.unwrap().unwrap().status(),
        reqwest::StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(server.try_next_request().is_err());
    server.cancel_and_reap().await;
}

#[tokio::test]
async fn exhausted_recovery_capacity_does_not_block_original_attempts() {
    let http = client("http://localhost");
    let mut recovering = Vec::new();
    for _ in 0..MAX_CONCURRENT_RECOVERIES {
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::ResetConnection,
            RawHttpAction::WaitForDisconnect,
        ])
        .await;
        let request = tokio::spawn(
            http.authenticated_request(reqwest::Method::GET, server.url(), "token")
                .send("recovering"),
        );
        server.next_request("original request").await;
        server.next_request("recovery holding capacity").await;
        recovering.push((server, request));
    }
    assert_eq!(http.inner.retry_slots.available_permits(), 0);
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection, ok()]).await;
    let error = http
        .authenticated_request(reqwest::Method::GET, server.url(), "token")
        .send("read")
        .await
        .unwrap_err();
    assert!(
        matches!(error, ProviderError::ApiTransport(error) if error.failure_cause == ApiTransportCause::ConnectionReset)
    );
    server
        .next_request("original attempt without recovery capacity")
        .await;
    assert_eq!(
        http.authenticated_request(reqwest::Method::GET, server.url(), "token")
            .send("read")
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    server.next_request("unblocked original request").await;
    server.assert_finished().await;
    for (server, request) in recovering {
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        server.assert_finished().await;
    }
    assert_eq!(
        http.inner.retry_slots.available_permits(),
        MAX_CONCURRENT_RECOVERIES
    );
}
