//! Report the settled Run resource independently of observability uploads.

use std::time::Duration;

use api_contracts::generated::{routes, types::runners::runs::startup::Request};
use runner_provider::{ProviderError, http::HttpClient};
use runner_types::{ids::RunId, types::SandboxStartupPath};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

const STARTUP_REPORT_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_REPORT_MAX_ATTEMPTS: usize = 3;
const STARTUP_REPORT_RETRY_DELAY: Duration = Duration::from_secs(2);

pub(super) async fn report_startup_path(
    http: &HttpClient,
    run_id: RunId,
    sandbox_token: &str,
    sandbox_startup_path: SandboxStartupPath,
    cancel: &CancellationToken,
) {
    let run_id_string = run_id.to_string();
    let body = Request {
        sandbox_startup_path,
    };
    // This ancillary fact cannot prevent guest execution. Old/rolled-back APIs
    // may lack the additive route; exhausted delivery leaves the Run path NULL.
    for attempt in 1..=STARTUP_REPORT_MAX_ATTEMPTS {
        let result = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            result = http.request_resolved_route(
                routes::runners::runs::by_run_id::startup::route(
                    routes::runners::runs::by_run_id::startup::Params {
                        run_id: &run_id_string,
                    },
                ),
                sandbox_token,
            ).json(&body).timeout(STARTUP_REPORT_TIMEOUT).send("run startup") => result,
        };
        let will_retry = match result {
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::NO_CONTENT {
                    return;
                }
                let retryable = matches!(
                    status,
                    reqwest::StatusCode::REQUEST_TIMEOUT
                        | reqwest::StatusCode::MISDIRECTED_REQUEST
                        | reqwest::StatusCode::TOO_EARLY
                        | reqwest::StatusCode::TOO_MANY_REQUESTS
                ) || status.is_server_error();
                let will_retry = retryable && attempt < STARTUP_REPORT_MAX_ATTEMPTS;
                if will_retry {
                    info!(%run_id, %status, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed, retrying");
                } else {
                    error!(%run_id, %status, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed");
                }
                will_retry
            }
            Err(error) => {
                let will_retry = matches!(&error, ProviderError::ApiTransport(_))
                    && attempt < STARTUP_REPORT_MAX_ATTEMPTS;
                if will_retry {
                    info!(%run_id, %error, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed, retrying");
                } else {
                    error!(%run_id, %error, attempt, max_attempts = STARTUP_REPORT_MAX_ATTEMPTS,
                        will_retry, "sandbox startup report failed");
                }
                will_retry
            }
        };
        if !will_retry {
            return;
        }
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(STARTUP_REPORT_RETRY_DELAY) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;
    use runner_provider::http::HttpClientConfig;
    use tokio_util::task::AbortOnDropHandle;
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
            let task = AbortOnDropHandle::new(tokio::spawn(async move {
                report_startup_path(
                    &http,
                    run_id,
                    "startup-run-token",
                    SandboxStartupPath::Blank,
                    &CancellationToken::new(),
                )
                .with_subscriber(subscriber)
                .await;
            }));
            for description in ["initial startup report", "second attempt", "third attempt"] {
                let request = server.next_request(description).await;
                assert!(request.starts_with(&format!("PUT /api/runners/runs/{run_id}/startup ")));
                assert!(request.contains(r#"{"sandboxStartupPath":"blank"}"#));
            }
            task.await.unwrap();
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
        report_startup_path(
            &client(server.base_url()),
            RunId::new_v4(),
            "startup-run-token",
            SandboxStartupPath::Cold,
            &CancellationToken::new(),
        )
        .with_subscriber(subscriber)
        .await;
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
    async fn cancellation_closes_an_in_flight_startup_request() {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
        let http = client(server.url());
        let cancel = CancellationToken::new();
        let task = AbortOnDropHandle::new(tokio::spawn({
            let cancel = cancel.clone();
            async move {
                report_startup_path(
                    &http,
                    RunId::new_v4(),
                    "startup-run-token",
                    SandboxStartupPath::Home,
                    &cancel,
                )
                .await;
            }
        }));
        server.next_request("startup before cancellation").await;
        cancel.cancel();
        task.await.unwrap();
        server.assert_finished().await;
    }
}
