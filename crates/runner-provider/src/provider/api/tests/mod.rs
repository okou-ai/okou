use super::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Method::POST, MockServer};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tracing::{Level, instrument::WithSubscriber};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};
use tracing_test_support::{
    capture_future_events as capture_api_provider_events, find_captured_event,
};
use uuid::Uuid;

use crate::axiom_layer::{init_with_base_url, with_ingest_filter};
use crate::http::{HttpClient, HttpClientConfig};
use crate::test_fixtures::raw_http::{
    RawHttpAction, RawHttpTestServer, http_response, join_raw_http_task, json_response,
    read_http_request,
};

const RUNNER_CLAIM_RESPONSE_FIXTURE: &str = include_str!(
    "../../../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-claim-response.json"
);
const RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID: &str = "00000000-0000-4000-8000-000000020985";
const TEST_RUNNER_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

const TEST_HEARTBEAT_GENERATION: u64 = 7;

mod execution_inputs;
mod supplied;
mod template_guidance;

fn api_client_for_url(api_url: String) -> ApiClient {
    ApiClient::new(
        HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "runner-token".to_string(),
    )
}

fn test_runner_identity() -> RunnerProcessIdentity {
    RunnerProcessIdentity::new(TEST_RUNNER_ID.parse().unwrap(), TEST_HEARTBEAT_GENERATION).unwrap()
}

#[test]
fn active_input_source_requires_a_thread_run() {
    assert!(supports_thread_active_input(Some("thread:chat-id")));
    assert!(!supports_thread_active_input(Some("resource:resource-id")));
    assert!(!supports_thread_active_input(None));
}

#[test]
fn builtin_firewall_catalog_resolve_request_uses_bounded_timeout_and_empty_body() {
    let api = ApiClient::new(
        HttpClient::new(HttpClientConfig {
            api_url: "https://api.vm0.dev".to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "runner-token".to_string(),
    );

    let request = api
        .builtin_firewall_catalog_resolve_request()
        .build()
        .unwrap();

    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().path(),
        routes::runners::builtin_firewalls::resolve::RESOLVE.path
    );
    assert_eq!(
        request.timeout(),
        Some(&BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
    );
    assert_eq!(
        request.body().and_then(reqwest::Body::as_bytes),
        Some(br#"{}"#.as_slice())
    );
}

fn api_client_for_server(server: &MockServer) -> ApiClient {
    api_client_for_url(server.base_url())
}

#[tokio::test]
async fn heartbeat_and_connector_sync_allow_api_cold_starts() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, mut requests) = tokio::sync::mpsc::channel(2);
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let peer_release = Arc::clone(&release);
    let server = tokio::spawn(async move {
        let response = json_response(
            "200 OK",
            &serde_json::json!({
                "results": [{
                    "target": {"kind": "builtin", "connectorSlug": "slack"},
                    "state": "unresolved",
                    "reason": "connector-unavailable",
                }],
            })
            .to_string(),
        );
        let serve = || async {
            let (mut socket, _) = listener.accept().await.unwrap();
            entered
                .send(read_http_request(&mut socket).await.unwrap())
                .await
                .unwrap();
            let _permit = peer_release.acquire().await.unwrap();
            socket.write_all(&response).await.unwrap();
        };
        tokio::join!(serve(), serve());
    });
    let run_id = RunId::from(uuid::Uuid::nil());
    let api = api_client_for_url(url);
    let state = heartbeat_state_for_test();
    let targets = [ConnectorRuntimeTargetRegistration::Builtin {
        connector_slug: "slack".to_string(),
        base_url_vars: None,
        source_id: None,
    }];

    let calls = async {
        tokio::join!(
            api.heartbeat(&state),
            api.sync_connector_runtime(run_id, &targets)
        )
    };
    tokio::pin!(calls);
    let mut paths = Vec::new();
    for _ in 0..2 {
        let request = tokio::select! {
            request = tokio::time::timeout(Duration::from_secs(5), requests.recv()) => {
                request.unwrap().unwrap()
            },
            _ = &mut calls => panic!("cold-start calls completed before their responses were released"),
        };
        assert!(request.contains("authorization: Bearer runner-token\r\n"));
        paths.push(request.lines().next().unwrap().to_owned());
    }
    paths.sort();
    assert_eq!(
        paths,
        vec![
            "POST /api/runners/heartbeat HTTP/1.1".to_owned(),
            format!("POST /api/runners/runs/{run_id}/connector-runtime/sync HTTP/1.1"),
        ]
    );
    raw_http_test_support::clock::advance_timer_phase(Duration::from_secs(6)).await;
    release.add_permits(2);
    let (heartbeat_result, sync_result) = calls.await;

    heartbeat_result.expect("heartbeat should survive an API cold start");
    assert!(matches!(
        sync_result.expect("connector sync should survive an API cold start"),
        ConnectorRuntimeSyncOutcome::Synced(response) if response.results.len() == 1
    ));
    join_raw_http_task(server, "cold-start API peers").await;
}

#[tokio::test]
async fn api_client_sync_requires_complete_terminal_diagnostics() {
    let complete = r#"{"error":{"code":"RUN_TERMINAL","message":"Run is terminal"}}"#;
    let mut oversized = complete.to_string();
    oversized.extend(std::iter::repeat_n(' ', API_ERROR_BODY_MAX_BYTES + 1));
    for (body, terminal) in [(complete.to_string(), true), (oversized, false)] {
        let server = MockServer::start();
        let run_id = RunId::new_v4();
        let response = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(409).body(body);
        });
        let api = api_client_for_server(&server);
        let targets = [ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".into(),
            base_url_vars: None,
            source_id: None,
        }];
        let result = api.sync_connector_runtime(run_id, &targets).await;
        if terminal {
            assert!(matches!(
                result,
                Ok(ConnectorRuntimeSyncOutcome::RunTerminal)
            ));
        } else {
            let Err(ProviderError::ApiStatus(error)) = result else {
                panic!("expected incomplete terminal response to remain an API error");
            };
            assert_eq!(error.status, StatusCode::CONFLICT);
            assert_eq!(
                error.body.len(),
                API_ERROR_BODY_MAX_BYTES + API_ERROR_BODY_TRUNCATED.len()
            );
            assert!(error.body.ends_with(API_ERROR_BODY_TRUNCATED));
        }
        response.assert_calls(1);
    }
}

#[tokio::test]
async fn api_client_resolves_builtin_firewall_catalog() {
    let server = MockServer::start_async().await;
    let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::builtin_firewalls::resolve::RESOLVE.path)
                    .json_body(serde_json::json!({}));
                then.status(200).json_body(serde_json::json!({
                    "catalogDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "catalogVersion": "test-catalog",
                    "firewalls": {
                        "aws": {
                            "name": "aws",
                            "apis": [{
                                "base": "https://s3.amazonaws.com",
                                "hostPolicy": {
                                    "kind": "providerOwned",
                                    "exactHosts": ["s3.amazonaws.com"]
                                },
                                "auth": {
                                    "awsSigv4": {
                                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}"
                                    }
                                },
                                "permissions": [{"name": "read", "rules": ["GET /{bucket}"]}]
                            }]
                        }
                    }
                }));
            })
            .await;
    let api = api_client_for_server(&server);

    let catalog = api.resolve_builtin_firewall_catalog().await.unwrap();

    assert_eq!(catalog.catalog_version, "test-catalog");
    assert_eq!(
        catalog.firewalls["aws"].apis[0].base,
        "https://s3.amazonaws.com"
    );
    assert!(catalog.firewalls["aws"].apis[0].host_policy.is_some());
    assert!(catalog.firewalls["aws"].apis[0].auth.aws_sigv4.is_some());
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_rejects_builtin_firewall_catalog_key_name_mismatch() {
    let server = MockServer::start_async().await;
    let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::builtin_firewalls::resolve::RESOLVE.path);
                then.status(200).json_body(serde_json::json!({
                    "catalogDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "catalogVersion": "test-catalog",
                    "firewalls": {
                        "github": {
                            "name": "slack",
                            "apis": [{
                                "base": "https://slack.com/api",
                                "auth": {"headers": {}},
                                "permissions": []
                            }]
                        }
                    }
                }));
            })
            .await;
    let api = api_client_for_server(&server);

    let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

    match error {
        ProviderError::Api(message) => assert!(
            message.contains("does not match firewall.name"),
            "unexpected error: {message}"
        ),
        other => panic!("expected ProviderError::Api, got {other:?}"),
    }
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_bounds_builtin_firewall_catalog_response_body() {
    let max_bytes = BUILTIN_FIREWALL_CATALOG_MAX_BYTES;
    let max_bytes_usize = usize::try_from(max_bytes).unwrap();
    let expected_error =
        format!("builtin firewall catalog resolve response body exceeds {max_bytes} bytes");

    let declared_oversized_response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        max_bytes + 1
    )
    .into_bytes();
    let mut server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(declared_oversized_response)]).await;
    let api = api_client_for_url(server.url());

    let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

    match error {
        ProviderError::Api(message) => assert!(
            message.contains(&expected_error),
            "unexpected error: {message}"
        ),
        other => panic!("expected ProviderError::Api, got {other:?}"),
    }
    let request = server
        .next_request("declared oversized builtin firewall catalog request")
        .await;
    assert!(
        request.contains(routes::runners::builtin_firewalls::resolve::RESOLVE.path),
        "unexpected request: {request}"
    );
    server.assert_finished().await;

    let mut exact_limit_response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {max_bytes}\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
    let body_start = exact_limit_response.len();
    exact_limit_response.resize(body_start + max_bytes_usize, b'x');
    let mut server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(exact_limit_response)]).await;
    let api = api_client_for_url(server.url());

    let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

    match error {
        ProviderError::ApiStatus(error) => {
            assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(error.body.len(), max_bytes_usize);
        }
        other => panic!("expected ProviderError::ApiStatus, got {other:?}"),
    }
    let request = server
        .next_request("exact-limit builtin firewall catalog request")
        .await;
    assert!(
        request.contains(routes::runners::builtin_firewalls::resolve::RESOLVE.path),
        "unexpected request: {request}"
    );
    server.assert_finished().await;

    let chunked_body_len = max_bytes_usize + 1;
    let mut chunked_oversized_response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{chunked_body_len:x}\r\n"
        )
        .into_bytes();
    let body_start = chunked_oversized_response.len();
    chunked_oversized_response.resize(body_start + chunked_body_len, b'x');
    chunked_oversized_response.extend_from_slice(b"\r\n0\r\n\r\n");
    let mut server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(chunked_oversized_response)]).await;
    let api = api_client_for_url(server.url());

    let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

    match error {
        ProviderError::Api(message) => assert!(
            message.contains(&expected_error),
            "unexpected error: {message}"
        ),
        other => panic!("expected ProviderError::Api, got {other:?}"),
    }
    let request = server
        .next_request("chunked oversized builtin firewall catalog request")
        .await;
    assert!(
        request.contains(routes::runners::builtin_firewalls::resolve::RESOLVE.path),
        "unexpected request: {request}"
    );
    server.assert_finished().await;
}

fn assert_api_status_error(
    err: ProviderError,
    endpoint_label: &'static str,
    status: StatusCode,
    body: &str,
) {
    let display = err.to_string();
    match err {
        ProviderError::ApiStatus(error) => {
            assert_eq!(error.endpoint_label, endpoint_label);
            assert_eq!(error.status, status);
            assert_eq!(error.body, body);
        }
        other => panic!("expected ProviderError::ApiStatus, got {other:?}"),
    }
    assert_eq!(
        display,
        format!("api error: {endpoint_label} {status}: {body}")
    );
}

async fn assert_completion_retry_delay<F>(
    mut completion: std::pin::Pin<&mut F>,
    captured: &CapturedEvents,
    server: &mut RawHttpTestServer,
    attempt: usize,
) where
    F: std::future::Future<Output = ()>,
{
    // Observe the failed response and register the retry timer before checking its delay.
    std::future::poll_fn(|cx| {
        assert!(
            completion.as_mut().poll(cx).is_pending(),
            "completion returned before retry {attempt}"
        );
        if captured.entries().iter().any(|event| {
            event.fields.get("attempt") == Some(&attempt.to_string())
                && event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "API request recovery waiting")
        }) {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;

    let before_retry = tokio::time::Instant::now() + Duration::from_millis(1999);
    let early_request = tokio::select! {
        () = completion.as_mut() => panic!("completion returned before retry {attempt}"),
        request = server.next_request_before(before_retry, "completion before retry delay") => request,
    };
    assert!(
        matches!(&early_request, Err(error) if error.starts_with("timed out waiting for")),
        "retry {attempt} was sent before two seconds: {early_request:?}"
    );
    tokio::time::advance(Duration::from_millis(1)).await;
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    find_captured_event(events, message)
        .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
}

fn event_field<'a>(event: &'a CapturedEvent, field: &str) -> &'a str {
    event
        .fields
        .get(field)
        .map(String::as_str)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"))
}

fn heartbeat_state_for_test() -> HeartbeatState {
    HeartbeatState {
        ingress_service_active: false,
        runner_id: "runner-heartbeat-test".to_string(),
        runner_hostname: None,
        group: "vm0/test".to_string(),
        snapshot_generation: 7,
        snapshot_sequence: 42,
        total_vcpu: 8,
        total_memory_mb: 32768,
        max_concurrent: 4,
        allocated_vcpu: 2,
        allocated_memory_mb: 4096,
        running_count: 1,
        admittable_profiles: vec![crate::profile::DEFAULT_PROFILE.to_string()],
        held_sandbox_states: vec![runner_types::types::HeldSandboxState {
            reuse_key: "thread:heartbeat-test".to_string(),
            last_completed_at: "2026-07-08T00:00:00.000Z".to_string(),
            reusable_sandbox: runner_types::types::ReusableSandboxState {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: crate::profile::DEFAULT_PROFILE.to_string(),
            },
        }],
        held_home_states: vec![runner_types::types::HeldHomeState {
            reuse_key: "thread:heartbeat-test".to_string(),
            last_completed_at: "2026-07-08T00:00:00.000Z".to_string(),
            home_caches: vec![runner_types::types::HomeCacheCapability {
                source_run_id: "33333333-3333-4333-8333-333333333333".parse().unwrap(),
                profile: crate::profile::DEFAULT_PROFILE.to_string(),
                home_affinity_version: runner_types::types::HOME_AFFINITY_VERSION,
            }],
        }],
        active_reuse_producers: vec![],
        mode: "running".to_string(),
    }
}

fn idle_api_provider_for_test() -> Arc<ApiProvider> {
    api_provider_for_test("http://127.0.0.1:1".to_string(), CancellationToken::new())
}

fn synthetic_transport_cause(failure_kind: ApiFailureKind) -> crate::error::ApiTransportCause {
    match failure_kind {
        ApiFailureKind::Timeout => crate::error::ApiTransportCause::Timeout,
        ApiFailureKind::Connect => crate::error::ApiTransportCause::ConnectionRefused,
        _ => crate::error::ApiTransportCause::Unknown,
    }
}

fn heartbeat_transport_error_with_cause(
    failure_kind: ApiFailureKind,
    failure_cause: ApiTransportCause,
) -> ProviderError {
    ProviderError::ApiTransport(Box::new(ApiTransportError {
        request: crate::error::ApiRequestContext {
            endpoint_label: "heartbeat",
            method: "POST".to_string(),
            host: "api.vm0.test".to_string(),
            path: routes::runners::heartbeat::HEARTBEAT.path.to_string(),
            client_request_id: Uuid::new_v4().to_string(),
            client_session_id: "runner-session-test".to_string(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        failure_kind,
        failure_cause,
        summary: format!("synthetic {} failure", failure_kind.as_str()),
    }))
}

fn heartbeat_transport_error(failure_kind: ApiFailureKind) -> ProviderError {
    heartbeat_transport_error_with_cause(failure_kind, synthetic_transport_cause(failure_kind))
}

fn status_response(status: u16) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let body = if status == 200 { "ok" } else { "failed" };
    http_response(&format!("{status} {reason}"), body.as_bytes())
}

async fn complete_sequence_server(statuses: Vec<u16>) -> RawHttpTestServer {
    RawHttpTestServer::spawn(
        statuses
            .into_iter()
            .map(|status| RawHttpAction::Respond(status_response(status)))
            .collect(),
    )
    .await
}

fn assert_complete_authorization(request: &str, token: &str) {
    let expected = format!("authorization: Bearer {token}");
    assert!(
        request
            .lines()
            .any(|line| line.eq_ignore_ascii_case(&expected)),
        "completion request should use sandbox auth; request was:\n{request}",
    );
}

fn complete_request(run_id: RunId) -> CompleteRequest {
    CompleteRequest {
        run_id,
        exit_code: 0,
        failure_reason: None,
        error: None,
        sandbox_id: None,
    }
}

#[tokio::test]
async fn heartbeat_retryable_failure_logs_local_transport_context_without_secrets() {
    let state = heartbeat_state_for_test();

    for (failure_kind, failure_cause) in [
        (ApiFailureKind::Timeout, ApiTransportCause::Timeout),
        (
            ApiFailureKind::Connect,
            ApiTransportCause::ConnectionRefused,
        ),
        (ApiFailureKind::Request, ApiTransportCause::ConnectionReset),
        (ApiFailureKind::Request, ApiTransportCause::UnexpectedEof),
        (
            ApiFailureKind::Request,
            ApiTransportCause::HttpIncompleteMessage,
        ),
    ] {
        let provider = idle_api_provider_for_test();
        let error = heartbeat_transport_error_with_cause(failure_kind, failure_cause);
        let (_, events) = capture_api_provider_events(provider.record_heartbeat_failure_at(
            &state,
            &error,
            Instant::now(),
        ))
        .await;
        let event = captured_event(&events, "heartbeat failed, will retry");

        assert_eq!(event.level, Level::INFO);
        assert_eq!(event_field(event, "runner_id"), "runner-heartbeat-test");
        assert!(!event.fields.contains_key("runner_name"));
        assert_eq!(event_field(event, "runner_group"), "vm0/test");
        assert_eq!(event_field(event, "mode"), "running");
        assert_eq!(event_field(event, "running"), "1");
        assert_eq!(event_field(event, "reusable_sandboxes"), "1");
        assert_eq!(event_field(event, "home_states"), "1");
        assert_eq!(event_field(event, "endpoint"), "heartbeat");
        assert_eq!(event_field(event, "method"), "POST");
        assert_eq!(
            event_field(event, "path"),
            routes::runners::heartbeat::HEARTBEAT.path
        );
        assert_eq!(event_field(event, "host"), "api.vm0.test");
        assert_eq!(
            event_field(event, "client_session_id"),
            "runner-session-test"
        );
        assert_eq!(
            event_field(event, "client_version"),
            env!("CARGO_PKG_VERSION")
        );
        assert_eq!(event_field(event, "failure_kind"), failure_kind.as_str());
        assert_eq!(event_field(event, "failure_cause"), failure_cause.as_str());
        assert_eq!(event_field(event, "consecutive_failures"), "1");
        assert_eq!(event_field(event, "failure_elapsed_ms"), "0");
        assert_eq!(event_field(event, "will_retry"), "true");
        assert_eq!(event_field(event, "degraded"), "false");
        Uuid::parse_str(event_field(event, "client_request_id"))
            .expect("client_request_id should be a UUID");

        let event_debug = format!("{event:#?}");
        assert!(
            !event_debug.contains("http://")
                && !event_debug.contains("runner-token")
                && !event_debug.contains("thread:heartbeat-test"),
            "event should not include a full URL, bearer token, or heartbeat body: {event_debug}"
        );
    }
}

#[tokio::test]
async fn heartbeat_transient_failures_recover_without_axiom_warning() {
    for (action, failure_cause) in [
        (
            RawHttpAction::ResetConnection,
            Some(ApiTransportCause::ConnectionReset),
        ),
        (
            RawHttpAction::Disconnect,
            Some(ApiTransportCause::HttpIncompleteMessage),
        ),
        (
            RawHttpAction::Respond(http_response(
                "520 Unknown",
                b"sensitive-heartbeat-status-response",
            )),
            None,
        ),
    ] {
        assert_heartbeat_failure_recovers_without_axiom_warning(action, failure_cause).await;
    }
}

async fn assert_heartbeat_failure_recovers_without_axiom_warning(
    action: RawHttpAction,
    failure_cause: Option<ApiTransportCause>,
) {
    let axiom = MockServer::start_async().await;
    let ingested = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&ingested);
    let ingest = axiom
        .mock_async(move |when, then| {
            when.method(POST)
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
    let mut actions = vec![action];
    if failure_cause == Some(ApiTransportCause::ConnectionReset) {
        // Exhaust the shared reset recovery before testing the provider's
        // existing delivery-degradation episode and later scheduled success.
        actions.push(RawHttpAction::ResetConnection);
    }
    actions.extend([
        RawHttpAction::Respond(status_response(200)),
        RawHttpAction::Respond(status_response(500)),
    ]);
    let server = RawHttpTestServer::spawn(actions).await;
    let provider = api_provider_for_test(server.url(), CancellationToken::new());
    let state = heartbeat_state_for_test();

    assert!(provider.heartbeat(&state).await.is_err());
    provider.heartbeat(&state).await.unwrap();
    assert!(provider.heartbeat(&state).await.is_err());
    server.assert_finished().await;
    guard.shutdown().await;

    let events = captured.entries();
    let retry = captured_event(&events, "heartbeat failed, will retry");
    assert_eq!(retry.level, Level::INFO);
    if let Some(failure_cause) = failure_cause {
        assert_eq!(event_field(retry, "failure_kind"), "request");
        assert_eq!(event_field(retry, "failure_cause"), failure_cause.as_str());
    } else {
        assert_eq!(event_field(retry, "failure_kind"), "http_status");
        assert_eq!(event_field(retry, "status"), "520");
    }
    assert_eq!(event_field(retry, "will_retry"), "true");
    assert_eq!(event_field(retry, "degraded"), "false");
    let recovery = captured_event(&events, "heartbeat delivery recovered");
    assert_eq!(recovery.level, Level::INFO);
    assert_eq!(event_field(recovery, "recovered_after_failures"), "1");
    assert_eq!(event_field(recovery, "was_degraded"), "false");
    let warning = captured_event(&events, "heartbeat failed");
    assert_eq!(warning.level, Level::WARN);

    let heartbeat_event_debug = format!("{retry:#?}\n{recovery:#?}\n{warning:#?}");
    assert!(!heartbeat_event_debug.contains("runner-token"));
    assert!(!heartbeat_event_debug.contains("thread:heartbeat-test"));
    assert!(!heartbeat_event_debug.contains("http://"));
    assert!(!heartbeat_event_debug.contains("sensitive-heartbeat-status-response"));

    assert!(ingest.calls_async().await > 0);
    let ingested = ingested.lock().unwrap();
    assert_eq!(ingested.len(), 1);
    assert_eq!(ingested[0]["message"], "heartbeat failed");
    assert_eq!(ingested[0]["level"], "warn");
}

#[tokio::test]
async fn heartbeat_http520_and_transport_failures_share_degradation_and_reset() {
    const STATUS_BODY: &str = "sensitive-degraded-heartbeat-status-body";
    let http_error =
        || api_status_error("heartbeat", StatusCode::from_u16(520).unwrap(), STATUS_BODY);

    for mode in ["starting", "running", "draining"] {
        let mut state = heartbeat_state_for_test();
        state.mode = mode.to_string();
        for (first, second) in [
            (http_error(), http_error()),
            (
                http_error(),
                heartbeat_transport_error(ApiFailureKind::Timeout),
            ),
            (
                heartbeat_transport_error(ApiFailureKind::Timeout),
                http_error(),
            ),
        ] {
            let provider = idle_api_provider_for_test();
            let started_at = Instant::now();
            let (_, events) = capture_api_provider_events(async {
                for (error, elapsed) in [
                    (&first, Duration::ZERO),
                    (&second, HEARTBEAT_DEGRADED_AFTER - Duration::from_millis(1)),
                    (&second, HEARTBEAT_DEGRADED_AFTER),
                    (&first, HEARTBEAT_DEGRADED_AFTER + Duration::from_secs(1)),
                ] {
                    provider
                        .record_heartbeat_failure_at(&state, error, started_at + elapsed)
                        .await;
                }
                provider
                    .record_heartbeat_success_at(
                        &state,
                        started_at + HEARTBEAT_DEGRADED_AFTER + Duration::from_secs(2),
                    )
                    .await;
                let later_started_at =
                    started_at + HEARTBEAT_DEGRADED_AFTER + Duration::from_secs(3);
                provider
                    .record_heartbeat_failure_at(&state, &second, later_started_at)
                    .await;
                provider
                    .record_heartbeat_failure_at(
                        &state,
                        &first,
                        later_started_at + HEARTBEAT_DEGRADED_AFTER,
                    )
                    .await;
            })
            .await;
            let failures = events
                .iter()
                .filter(|event| event.fields.contains_key("consecutive_failures"))
                .collect::<Vec<_>>();

            assert_eq!(failures.len(), 6, "mode={mode}; {events:#?}");
            for ((event, count), (level, elapsed, degraded)) in
                failures.iter().zip([1, 2, 3, 4, 1, 2]).zip([
                    (Level::INFO, 0, "false"),
                    (Level::INFO, 29_999, "false"),
                    (Level::WARN, 30_000, "true"),
                    (Level::INFO, 31_000, "true"),
                    (Level::INFO, 0, "false"),
                    (Level::WARN, 30_000, "true"),
                ])
            {
                assert_eq!(event.level, level, "mode={mode}; {events:#?}");
                assert_eq!(event_field(event, "mode"), mode);
                assert_eq!(
                    event_field(event, "consecutive_failures"),
                    count.to_string()
                );
                assert_eq!(
                    event_field(event, "failure_elapsed_ms"),
                    elapsed.to_string()
                );
                assert_eq!(event_field(event, "degraded"), degraded);
                assert_eq!(event_field(event, "will_retry"), "true");
                let message = if level == Level::WARN {
                    "heartbeat delivery degraded"
                } else {
                    "heartbeat failed, will retry"
                };
                assert_eq!(event_field(event, "message"), message);
                if event_field(event, "failure_kind") == "http_status" {
                    assert_eq!(event_field(event, "endpoint"), "heartbeat");
                    assert_eq!(event_field(event, "status"), "520");
                    assert_eq!(event_field(event, "running"), "1");
                    assert_eq!(event_field(event, "reusable_sandboxes"), "1");
                    assert_eq!(event_field(event, "home_states"), "1");
                    assert!(!event.fields.contains_key("error"));
                }
            }
            let recovery = captured_event(&events, "heartbeat delivery recovered");
            assert_eq!(recovery.level, Level::INFO);
            assert_eq!(event_field(recovery, "recovered_after_failures"), "4");
            assert_eq!(event_field(recovery, "failure_elapsed_ms"), "32000");
            assert_eq!(event_field(recovery, "was_degraded"), "true");
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.level == Level::WARN)
                    .count(),
                2,
                "each episode should emit only one degradation warning: {events:#?}"
            );
            assert!(!format!("{events:#?}").contains(STATUS_BODY));
        }
    }
}

#[tokio::test]
async fn heartbeat_stopping_transport_failures_remain_immediate_warnings() {
    let mut state = heartbeat_state_for_test();
    state.mode = "stopping".to_string();
    for (failure_kind, failure_cause) in [
        (ApiFailureKind::Timeout, ApiTransportCause::Timeout),
        (ApiFailureKind::Request, ApiTransportCause::ConnectionReset),
        (ApiFailureKind::Request, ApiTransportCause::UnexpectedEof),
        (
            ApiFailureKind::Request,
            ApiTransportCause::HttpIncompleteMessage,
        ),
    ] {
        let provider = idle_api_provider_for_test();
        let error = heartbeat_transport_error_with_cause(failure_kind, failure_cause);

        let (_, events) = capture_api_provider_events(provider.record_heartbeat_failure_at(
            &state,
            &error,
            Instant::now(),
        ))
        .await;
        let event = captured_event(&events, "heartbeat failed");

        assert_eq!(event.level, Level::WARN);
        assert_eq!(event_field(event, "mode"), "stopping");
        assert_eq!(event_field(event, "failure_kind"), failure_kind.as_str());
        assert_eq!(event_field(event, "failure_cause"), failure_cause.as_str());
        assert!(!event.fields.contains_key("will_retry"));
        assert!(
            provider
                .heartbeat_degradation_tracker
                .active_episode
                .lock()
                .await
                .is_none()
        );
    }
}

#[tokio::test]
async fn heartbeat_success_recovers_connection_reset_degradation_episode() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(status_response(200))]).await;
    let provider = api_provider_for_test(server.url(), CancellationToken::new());
    let state = heartbeat_state_for_test();
    let error = heartbeat_transport_error_with_cause(
        ApiFailureKind::Request,
        ApiTransportCause::ConnectionReset,
    );
    let started_at = Instant::now()
        .checked_sub(HEARTBEAT_DEGRADED_AFTER)
        .expect("test instant should support the degradation window");
    provider
        .record_heartbeat_failure_at(&state, &error, started_at)
        .await;
    provider
        .record_heartbeat_failure_at(&state, &error, Instant::now())
        .await;

    let (_, recovery_events) = capture_api_provider_events(provider.heartbeat(&state)).await;
    server.assert_finished().await;
    let recovery = captured_event(&recovery_events, "heartbeat delivery recovered");
    assert_eq!(recovery.level, Level::INFO);
    assert_eq!(event_field(recovery, "recovered_after_failures"), "2");
    assert_eq!(event_field(recovery, "was_degraded"), "true");
    assert!(
        event_field(recovery, "failure_elapsed_ms")
            .parse::<u64>()
            .unwrap()
            >= duration_ms(HEARTBEAT_DEGRADED_AFTER)
    );
    assert!(
        provider
            .heartbeat_degradation_tracker
            .active_episode
            .lock()
            .await
            .is_none()
    );
}

#[tokio::test]
async fn heartbeat_non_retryable_failures_remain_warnings_without_mutating_episode() {
    let provider = idle_api_provider_for_test();
    let state = heartbeat_state_for_test();
    let retryable_error = heartbeat_transport_error(ApiFailureKind::Timeout);
    let started_at = Instant::now();
    provider
        .record_heartbeat_failure_at(&state, &retryable_error, started_at)
        .await;

    let unsupported_errors = [
        heartbeat_transport_error(ApiFailureKind::Request),
        heartbeat_transport_error_with_cause(ApiFailureKind::Request, ApiTransportCause::HttpParse),
        heartbeat_transport_error(ApiFailureKind::Body),
        heartbeat_transport_error_with_cause(
            ApiFailureKind::Body,
            ApiTransportCause::UnexpectedEof,
        ),
        heartbeat_transport_error_with_cause(
            ApiFailureKind::Body,
            ApiTransportCause::HttpIncompleteMessage,
        ),
        heartbeat_transport_error(ApiFailureKind::Unknown),
        heartbeat_transport_error_with_cause(
            ApiFailureKind::Unknown,
            ApiTransportCause::UnexpectedEof,
        ),
        ProviderError::ApiStatus(Box::new(ApiStatusError {
            endpoint_label: "heartbeat",
            status: StatusCode::INTERNAL_SERVER_ERROR,
            body: "failed".to_string(),
        })),
        ProviderError::Internal("synthetic heartbeat invariant".to_string()),
        ProviderError::Api("heartbeat 520: untyped error".to_string()),
    ];
    let mut stopping_state = state.clone();
    stopping_state.mode = "stopping".to_string();
    let (_, events) = capture_api_provider_events(async {
        for error in &unsupported_errors {
            provider
                .record_heartbeat_failure_at(&state, error, started_at + Duration::from_secs(15))
                .await;
        }
        provider
            .record_heartbeat_failure_at(
                &stopping_state,
                &retryable_error,
                started_at + Duration::from_secs(15),
            )
            .await;
        provider
            .record_heartbeat_failure_at(
                &stopping_state,
                &api_status_error(
                    "heartbeat",
                    StatusCode::from_u16(520).unwrap(),
                    "stopping status body",
                ),
                started_at + Duration::from_secs(15),
            )
            .await;
    })
    .await;

    let immediate_warnings = events
        .iter()
        .filter(|event| {
            event.level == Level::WARN
                && event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "heartbeat failed")
        })
        .count();
    assert_eq!(
        immediate_warnings,
        unsupported_errors.len() + 2,
        "events={events:#?}"
    );
    {
        let active_episode = provider
            .heartbeat_degradation_tracker
            .active_episode
            .lock()
            .await;
        let episode = active_episode
            .as_ref()
            .expect("unsupported failures should not reset the active episode");
        assert_eq!(episode.started_at, started_at);
        assert_eq!(episode.consecutive_failures, 1);
        assert!(!episode.degradation_emitted);
    }

    let (_, transition_events) = capture_api_provider_events(provider.record_heartbeat_failure_at(
        &state,
        &retryable_error,
        started_at + HEARTBEAT_DEGRADED_AFTER,
    ))
    .await;
    let transition = captured_event(&transition_events, "heartbeat delivery degraded");
    assert_eq!(transition.level, Level::WARN);
    assert_eq!(event_field(transition, "consecutive_failures"), "2");
}

#[tokio::test]
async fn heartbeat_status_failure_logs_held_state_counts_without_body() {
    const STATUS_BODY: &str = "sensitive-heartbeat-status-body";
    for (status, mode) in [
        (400, "running"),
        (401, "running"),
        (403, "running"),
        (408, "running"),
        (429, "running"),
        (500, "running"),
        (502, "running"),
        (503, "running"),
        (521, "running"),
        (520, "stopping"),
    ] {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(http_response(
            &format!("{status} Unknown"),
            STATUS_BODY.as_bytes(),
        ))])
        .await;
        let provider = api_provider_for_test(server.url(), CancellationToken::new());
        let mut state = heartbeat_state_for_test();
        state.mode = mode.to_string();

        let (_, events) = capture_api_provider_events(provider.heartbeat(&state)).await;
        server.assert_finished().await;
        let event = captured_event(&events, "heartbeat failed");

        assert_eq!(event.level, Level::WARN, "status={status}; mode={mode}");
        assert_eq!(event_field(event, "endpoint"), "heartbeat");
        assert_eq!(event_field(event, "status"), status.to_string());
        assert_eq!(event_field(event, "failure_kind"), "http_status");
        assert_eq!(event_field(event, "mode"), mode);
        assert_eq!(event_field(event, "reusable_sandboxes"), "1");
        assert_eq!(event_field(event, "home_states"), "1");
        assert!(!event.fields.contains_key("will_retry"));
        assert!(
            provider
                .heartbeat_degradation_tracker
                .active_episode
                .lock()
                .await
                .is_none()
        );
        let event_debug = format!("{event:#?}");
        assert!(!event_debug.contains("thread:heartbeat-test"));
        assert!(!event_debug.contains(STATUS_BODY));
        assert!(!event.fields.contains_key("error"));
    }
}

#[tokio::test]
async fn api_client_builtin_catalog_decode_path_redacts_firewall_map_keys() {
    let server = MockServer::start_async().await;
    let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::runners::builtin_firewalls::resolve::RESOLVE.path);
                then.status(200).json_body(serde_json::json!({
                    "catalogDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "catalogVersion": "test-catalog",
                    "firewalls": {
                        "secret-firewall-name": {
                            "name": "github",
                            "apis": [{"base": 123, "auth": {"headers": {}}}]
                        }
                    }
                }));
            })
            .await;
    let api = api_client_for_server(&server);
    let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();
    let ProviderError::Api(error) = error else {
        panic!("expected ProviderError::Api");
    };

    assert!(
        error.contains("failed at firewalls.<map-key>.apis[0].base"),
        "unexpected builtin catalog decode error: {error}"
    );
    assert!(!error.contains("secret-firewall-name"));
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_complete_non_success_includes_status_and_body() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path);
            then.status(500).body("complete failed");
        })
        .await;
    let api = api_client_for_server(&server);
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let request = CompleteRequest {
        run_id: RunId::from(uuid::Uuid::nil()),
        exit_code: 1,
        failure_reason: None,
        error: Some("boom".to_string()),
        sandbox_id: None,
    };
    let completion = api
        .complete("sandbox-token", &request)
        .with_subscriber(subscriber);
    tokio::pin!(completion);

    for attempt in 1..=2 {
        // Drive the real HTTP response until this attempt has armed its retry timer.
        tokio::time::timeout(
            Duration::from_secs(5),
            std::future::poll_fn(|cx| {
                assert!(
                    completion.as_mut().poll(cx).is_pending(),
                    "completion returned before retry {attempt}"
                );
                if captured.entries().iter().any(|event| {
                    event.fields.get("attempt") == Some(&attempt.to_string())
                        && event.fields.get("message").map(String::as_str)
                            == Some("API request recovery waiting")
                }) {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            }),
        )
        .await
        .expect("completion must register each retry wait before advancing time");
        // Resume before any awakened task or the next HTTP poll can run.
        raw_http_test_support::clock::advance_timer_phase(Duration::from_secs(2)).await;
    }

    let err = completion.await.unwrap_err();

    assert_api_status_error(
        err,
        "complete",
        StatusCode::INTERNAL_SERVER_ERROR,
        "complete failed",
    );
    mock.assert_calls_async(3).await;
}

#[tokio::test]
async fn api_client_complete_serializes_sandbox_identity() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let sandbox_id = sandbox::SandboxId::new_v4();
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer sandbox-token")
                .json_body(serde_json::json!({
                    "runId": run_id,
                    "exitCode": 0,
                    "sandboxId": sandbox_id,
                }));
            then.status(200);
        })
        .await;
    let api = api_client_for_server(&server);

    api.complete(
        "sandbox-token",
        &CompleteRequest {
            run_id,
            exit_code: 0,
            failure_reason: None,
            error: None,
            sandbox_id: Some(sandbox_id),
        },
    )
    .await
    .unwrap();

    mock.assert_async().await;
}

#[tokio::test]
async fn api_provider_complete_uses_sandbox_token_from_completion_auth() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer sandbox-token");
            then.status(200);
        })
        .await;
    let provider = api_provider_for_test(server.base_url(), CancellationToken::new());

    provider
        .complete(
            complete_request(run_id),
            CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
        )
        .await;

    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_complete_with_local_auth_does_not_send_request() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path);
            then.status(200);
        })
        .await;
    let provider = api_provider_for_test(server.base_url(), CancellationToken::new());

    provider
        .complete(
            complete_request(RunId::from(uuid::Uuid::nil())),
            CompletionAuth::local(),
        )
        .await;

    mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn api_provider_complete_with_mismatched_auth_does_not_send_request() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path);
            then.status(200);
        })
        .await;
    let provider = api_provider_for_test(server.base_url(), CancellationToken::new());

    provider
        .complete(
            complete_request(RunId::from(uuid::Uuid::nil())),
            CompletionAuth::sandbox_token(RunId::new_v4(), "sandbox-token".to_string()),
        )
        .await;

    mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn api_provider_complete_does_not_retry_permanent_http_failure() {
    let mut server = complete_sequence_server(vec![400]).await;
    let api_url = server.url();
    let run_id = RunId::from(uuid::Uuid::nil());
    let provider = api_provider_for_test(api_url, CancellationToken::new());
    let ((), events) = tokio::time::timeout(
        Duration::from_secs(1),
        capture_api_provider_events(async move {
            provider
                .complete(
                    complete_request(run_id),
                    CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                )
                .await;
        }),
    )
    .await
    .expect("permanent completion failure should not wait for the retry delay");

    let request = server.next_request("permanent completion request").await;
    assert_complete_authorization(&request, "sandbox-token");
    server.assert_finished().await;

    let run_id = run_id.to_string();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.fields.get("run_id") == Some(&run_id))
            .count(),
        1,
        "one failed request should produce one provider event: {events:#?}"
    );
    let event = captured_event(&events, "failed to report completion");
    assert_eq!(event.level, Level::ERROR);
    assert!(
        !events
            .iter()
            .any(|event| event.fields.get("message").map(String::as_str)
                == Some("API request recovery waiting"))
    );
    assert_eq!(event_field(event, "status"), "400");
    assert_eq!(event_field(event, "failure_kind"), "http_status");
}

#[tokio::test(start_paused = true)]
async fn api_provider_complete_retries_transient_http_failures() {
    for status in [
        StatusCode::REQUEST_TIMEOUT,
        StatusCode::MISDIRECTED_REQUEST,
        StatusCode::TOO_EARLY,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        for success_attempt in 2..=3 {
            let mut statuses = vec![status.as_u16(); success_attempt - 1];
            statuses.push(200);
            let mut server = complete_sequence_server(statuses).await;
            let run_id = RunId::from(uuid::Uuid::nil());
            let expected_body = serde_json::to_string(&complete_request(run_id)).unwrap();
            let provider = api_provider_for_test(server.url(), CancellationToken::new());
            let captured = CapturedEvents::default();
            let subscriber = tracing_subscriber::registry().with(captured.clone());
            let completion = provider
                .complete(
                    complete_request(run_id),
                    CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                )
                .with_subscriber(subscriber);
            tokio::pin!(completion);

            for attempt in 1..=success_attempt {
                let request = tokio::select! {
                    () = &mut completion => panic!("completion returned before attempt {attempt}"),
                    request = server.next_request("transient completion request") => request,
                };
                assert_complete_authorization(&request, "sandbox-token");
                assert_eq!(request.split_once("\r\n\r\n").unwrap().1, expected_body);
                if attempt < success_attempt {
                    assert_completion_retry_delay(
                        completion.as_mut(),
                        &captured,
                        &mut server,
                        attempt,
                    )
                    .await;
                }
            }

            completion.await;
            server.assert_finished().await;

            let events = captured.entries();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| {
                        event.level == Level::INFO
                            && event
                                .fields
                                .get("message")
                                .is_some_and(|message| message == "API request recovery waiting")
                    })
                    .count(),
                success_attempt - 1,
                "{events:#?}"
            );
            assert!(
                events
                    .iter()
                    .all(|event| event.level != Level::WARN && event.level != Level::ERROR),
                "successful completion retries should not emit warnings or errors: {events:#?}"
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn api_provider_complete_retries_transport_failure() {
    for reset_connection in [false, true] {
        let mut actions: Vec<_> = (0..2)
            .map(|_| {
                if reset_connection {
                    RawHttpAction::ResetConnection
                } else {
                    RawHttpAction::Disconnect
                }
            })
            .collect();
        actions.push(RawHttpAction::Respond(status_response(200)));
        let mut server = RawHttpTestServer::spawn(actions).await;
        let run_id = RunId::from(uuid::Uuid::nil());
        let expected_body = serde_json::to_string(&complete_request(run_id)).unwrap();
        let provider = api_provider_for_test(server.url(), CancellationToken::new());
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let completion = provider
            .complete(
                complete_request(run_id),
                CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
            )
            .with_subscriber(subscriber);
        tokio::pin!(completion);

        for attempt in 1..=3 {
            let request = tokio::select! {
                () = &mut completion => panic!("completion returned before attempt {attempt}"),
                request = server.next_request("completion transport request") => request,
            };
            assert_complete_authorization(&request, "sandbox-token");
            assert_eq!(request.split_once("\r\n\r\n").unwrap().1, expected_body);
            if attempt < 3 {
                assert_completion_retry_delay(completion.as_mut(), &captured, &mut server, attempt)
                    .await;
            }
        }

        completion.await;
        server.assert_finished().await;

        let events = captured.entries();
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.level == Level::INFO
                        && event
                            .fields
                            .get("message")
                            .is_some_and(|message| message == "API request recovery waiting")
                })
                .count(),
            2,
            "reset_connection={reset_connection}; events={events:#?}"
        );
        assert!(
            events
                .iter()
                .all(|event| event.level != Level::WARN && event.level != Level::ERROR),
            "successful completion retries should not emit warnings or errors: {events:#?}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn api_provider_complete_timeout_retry_is_info_and_exhaustion_is_error() {
    for repeated_timeout in [false, true] {
        let attempt_count = if repeated_timeout { 3 } else { 2 };
        let mut releases = Vec::new();
        let mut actions = Vec::new();
        for attempt in 1..=attempt_count {
            let (release, response) = tokio::sync::oneshot::channel();
            releases.push(release);
            actions.push(RawHttpAction::WaitThenRespond {
                release: response,
                response: if !repeated_timeout && attempt == attempt_count {
                    status_response(200)
                } else {
                    Vec::new()
                },
            });
        }
        let mut server = RawHttpTestServer::spawn(actions).await;
        let run_id = RunId::from(uuid::Uuid::nil());
        let expected_body = serde_json::to_string(&complete_request(run_id)).unwrap();
        let provider = api_provider_for_test(server.url(), CancellationToken::new());
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let completion = provider
            .complete(
                complete_request(run_id),
                CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
            )
            .with_subscriber(subscriber);
        tokio::pin!(completion);

        for (index, release) in releases.into_iter().enumerate() {
            let attempt = index + 1;
            let request = tokio::select! {
                () = &mut completion => panic!("completion returned before attempt {attempt}"),
                request = server.next_request("completion timeout request") => request,
            };
            assert_complete_authorization(&request, "sandbox-token");
            assert_eq!(request.split_once("\r\n\r\n").unwrap().1, expected_body);
            if !repeated_timeout && attempt == attempt_count {
                release.send(()).unwrap();
                completion.as_mut().await;
                break;
            }
            // Expire the real HTTP client's deadline after receiving the request.
            tokio::time::advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
            if attempt == attempt_count {
                completion.as_mut().await;
                release.send(()).unwrap();
                break;
            }
            std::future::poll_fn(|cx| {
                assert!(completion.as_mut().poll(cx).is_pending());
                if captured.entries().iter().any(|event| {
                    event.fields.get("attempt") == Some(&attempt.to_string())
                        && event
                            .fields
                            .get("message")
                            .is_some_and(|message| message == "API request recovery waiting")
                }) {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            })
            .await;
            // Close the timed-out connection without sending a response.
            release.send(()).unwrap();
            assert!(server.try_next_request().is_err());
            tokio::time::advance(Duration::from_secs(2)).await;
        }
        server.assert_finished().await;

        let events = captured.entries();
        let retry_event = captured_event(&events, "API request recovery waiting");
        assert_eq!(retry_event.level, Level::INFO);
        assert_eq!(event_field(retry_event, "attempt"), "1");
        assert_eq!(event_field(retry_event, "max_attempts"), "3");
        assert_eq!(event_field(retry_event, "will_retry"), "true");
        assert_eq!(event_field(retry_event, "failure_kind"), "timeout");
        let terminal_events: Vec<_> = events
            .iter()
            .filter(|event| event.level == Level::WARN || event.level == Level::ERROR)
            .collect();
        if repeated_timeout {
            assert_eq!(terminal_events.len(), 1, "{events:#?}");
            assert_eq!(
                captured_event(&events, "failed to report completion").level,
                Level::ERROR
            );
            let final_event = captured_event(&events, "API request recovery completed");
            assert_eq!(final_event.level, Level::INFO);
            assert_eq!(event_field(final_event, "attempt"), "3");
            assert_eq!(event_field(final_event, "will_retry"), "false");
            assert_eq!(event_field(final_event, "failure_kind"), "timeout");
        } else {
            assert!(terminal_events.is_empty(), "{events:#?}");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn api_provider_complete_does_not_retry_local_request_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let run_id = RunId::from(uuid::Uuid::nil());
    let provider = api_provider_for_test(api_url, CancellationToken::new());
    let ((), events) = capture_api_provider_events(provider.complete(
        complete_request(run_id),
        CompletionAuth::sandbox_token(run_id, "invalid\nheader".to_string()),
    ))
    .await;

    let event = captured_event(&events, "failed to report completion");
    assert_eq!(event.level, Level::ERROR);
    assert!(
        !events
            .iter()
            .any(|event| event.fields.get("message").map(String::as_str)
                == Some("API request recovery waiting"))
    );
    assert_eq!(event_field(event, "status"), "");
    assert_eq!(event_field(event, "failure_kind"), "local");
    assert!(event_field(event, "error").contains("build API request"));
}

#[tokio::test(start_paused = true)]
async fn api_provider_complete_stops_after_three_transient_failures() {
    let mut server = complete_sequence_server(vec![500; 3]).await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let request = CompleteRequest {
        exit_code: 1,
        error: Some("boom".to_string()),
        ..complete_request(run_id)
    };
    let expected_body = serde_json::to_string(&request).unwrap();
    let provider = api_provider_for_test(server.url(), CancellationToken::new());

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let completion = provider
        .complete(
            request,
            CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
        )
        .with_subscriber(subscriber);
    tokio::pin!(completion);

    for attempt in 1..=3 {
        let request = tokio::select! {
            () = &mut completion => panic!("completion returned before attempt {attempt}"),
            request = server.next_request("failed completion request") => request,
        };
        assert_complete_authorization(&request, "sandbox-token");
        assert_eq!(request.split_once("\r\n\r\n").unwrap().1, expected_body);
        if attempt == 3 {
            completion.as_mut().await;
            break;
        }
        // Establish each retry timer before advancing paused time.
        std::future::poll_fn(|cx| {
            assert!(
                completion.as_mut().poll(cx).is_pending(),
                "completion should wait before retry {attempt}"
            );
            if captured.entries().iter().any(|event| {
                event.fields.get("attempt") == Some(&attempt.to_string())
                    && event
                        .fields
                        .get("message")
                        .is_some_and(|message| message == "API request recovery waiting")
            }) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
        .await;
        assert!(
            server.try_next_request().is_err(),
            "completion should wait before retry {attempt}"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
    }
    server.assert_finished().await;

    let events = captured.entries();
    let run_id = run_id.to_string();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.fields.get("run_id") == Some(&run_id))
            .count(),
        1,
        "the provider reports the final outcome once: {events:#?}"
    );
    let retry_events: Vec<_> = events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "API request recovery waiting")
        })
        .collect();
    assert_eq!(retry_events.len(), 2);
    for (index, retry_event) in retry_events.iter().enumerate() {
        assert_eq!(retry_event.level, Level::INFO);
        assert_eq!(event_field(retry_event, "attempt"), (index + 1).to_string());
        assert_eq!(event_field(retry_event, "max_attempts"), "3");
        assert_eq!(event_field(retry_event, "will_retry"), "true");
        assert_eq!(event_field(retry_event, "status"), "500");
        assert_eq!(event_field(retry_event, "failure_kind"), "http_status");
    }

    assert_eq!(
        captured_event(&events, "failed to report completion").level,
        Level::ERROR
    );
    let final_event = captured_event(&events, "API request recovery completed");
    assert_eq!(final_event.level, Level::INFO);
    assert_eq!(event_field(final_event, "attempt"), "3");
    assert_eq!(event_field(final_event, "will_retry"), "false");
    assert_eq!(event_field(final_event, "status"), "500");
    assert_eq!(event_field(final_event, "failure_kind"), "http_status");
}

fn api_provider_for_test(api_url: String, cancel: CancellationToken) -> Arc<ApiProvider> {
    let api = api_client_for_url(api_url);
    Arc::new(ApiProvider {
        cancellation_reconciliation: CancellationReconciliation::new(
            api.http.clone(),
            "default".into(),
            test_runner_identity(),
        ),
        connector_runtime_sync: ConnectorRuntimeSyncHandle::new(api.clone()),
        builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController::disabled(),
        api,
        group: "default".into(),
        ably_supervisor: Mutex::new(Some(AblySupervisor::disabled())),
        active_input_notifications: ActiveInputNotifications::new(),
        heartbeat_degradation_tracker: DegradationEpisodeTracker::new(),
        cancel_tokens: RunCancellationRegistry::new(),
        ably_side_message_handler: None,
        cancel,
    })
}
