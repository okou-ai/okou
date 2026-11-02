use super::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Method::POST, MockServer};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::{Level, instrument::WithSubscriber};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};
use uuid::Uuid;

use crate::axiom_layer::{init_with_base_url, with_ingest_filter};
use crate::http::{HttpClient, HttpClientConfig};
use crate::provider::{
    ActiveRunnerPreference, RunnerNoPreferenceReason, RunnerPreference,
    RunnerPreferenceRemovalReason, RunnerPreferenceTier,
};
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

mod claim_observation;
mod finalizing_source;
mod parallel_claim;
mod silent_connection;

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

fn claim_request_body_for_test(candidate: &JobCandidate) -> serde_json::Value {
    let runner_identity = test_runner_identity();
    serde_json::to_value(claim_request_body(candidate, &runner_identity, None, None)).unwrap()
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

async fn claim_decode_error(server: &MockServer, run_id: RunId, body: serde_json::Value) -> String {
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(200).json_body(body);
        })
        .await;
    let api = api_client_for_server(server);
    let error = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();
    mock.assert_async().await;
    mock.delete_async().await;

    let ClaimApiError::ResponseDecode(message) = error else {
        panic!("expected ClaimApiError::ResponseDecode");
    };
    message
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

fn api_provider_for_test(
    api_url: String,
    cancel: CancellationToken,
    poll_wakeups: Arc<PollWakeups>,
) -> Arc<ApiProvider> {
    api_provider_for_test_with_claim_cooldown_capacity(
        api_url,
        cancel,
        poll_wakeups,
        CLAIM_COOLDOWN_CAPACITY,
    )
}

fn api_provider_for_test_with_supported_profiles(
    api_url: String,
    cancel: CancellationToken,
    poll_wakeups: Arc<PollWakeups>,
    supported_profiles: Vec<String>,
) -> Arc<ApiProvider> {
    let mut provider = api_provider_for_test(api_url, cancel, poll_wakeups);
    Arc::get_mut(&mut provider)
        .expect("fresh test provider should not be shared")
        .supported_profiles = supported_profiles;
    provider
}

fn api_provider_for_test_with_claim_cooldown_capacity(
    api_url: String,
    cancel: CancellationToken,
    poll_wakeups: Arc<PollWakeups>,
    claim_cooldown_capacity: usize,
) -> Arc<ApiProvider> {
    let api = ApiClient::new(
        HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap(),
        "runner-token".to_string(),
    );
    Arc::new(ApiProvider {
        ably_side_message_handler: None,
        cancellation_reconciliation: CancellationReconciliation::new(
            api.http.clone(),
            "default".to_string(),
            test_runner_identity(),
        ),
        connector_runtime_sync: ConnectorRuntimeSyncHandle::new(api.clone()),
        builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController::disabled(),
        api,
        runner_identity: test_runner_identity(),
        runner_hostname: None,
        installed_okou_cli: None,
        group: "default".to_string(),
        supported_profiles: vec![crate::profile::DEFAULT_PROFILE.to_string()],
        poll_wakeups,
        direct_candidates: DirectCandidateInbox::new(
            DIRECT_CANDIDATE_INBOX_CAPACITY,
            DIRECT_CANDIDATE_STALE_AFTER,
        ),
        claim_cooldowns: ClaimCooldowns::new(claim_cooldown_capacity),
        in_flight_claims: InFlightClaims::default(),
        ably_supervisor: Mutex::new(Some(AblySupervisor::disabled())),
        active_input_notifications: ActiveInputNotifications::new(),
        poll_degradation_tracker: DegradationEpisodeTracker::new(),
        heartbeat_degradation_tracker: DegradationEpisodeTracker::new(),
        cancel_tokens: RunCancellationRegistry::new(),
        cancel,
    })
}

async fn capture_api_provider_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let output = future.with_subscriber(subscriber).await;
    (output, captured.entries())
}

async fn advance_pending_discovery_retry<F>(
    mut discovery: std::pin::Pin<&mut F>,
    captured: &CapturedEvents,
    message: &str,
    delay: Duration,
) where
    F: std::future::Future,
{
    // Drive real HTTP on running time until the retry observation is recorded
    // and this owned future has registered its next wait before returning Pending.
    tokio::time::timeout(
        Duration::from_secs(5),
        std::future::poll_fn(|cx| {
            assert!(
                discovery.as_mut().poll(cx).is_pending(),
                "discovery returned before {message}"
            );
            if captured.entries().iter().any(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            }) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        }),
    )
    .await
    .expect("discovery must reach its retry wait before advancing time");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), discovery.as_mut())
            .await
            .is_err(),
        "discovery must remain pending before the retry delay"
    );

    // Keep discovery unpolled during the timer phase; resume before its next
    // HTTP request so virtual time cannot outrun the real peer's socket I/O.
    tokio::time::pause();
    tokio::time::advance(delay).await;
    tokio::time::resume();
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
                    .is_some_and(|message| message == "completion report failed, retrying")
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
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
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
    api_provider_for_test(
        "http://127.0.0.1:1".to_string(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    )
}

fn synthetic_transport_cause(failure_kind: ApiFailureKind) -> crate::error::ApiTransportCause {
    match failure_kind {
        ApiFailureKind::Timeout => crate::error::ApiTransportCause::Timeout,
        ApiFailureKind::Connect => crate::error::ApiTransportCause::ConnectionRefused,
        _ => crate::error::ApiTransportCause::Unknown,
    }
}

fn poll_transport_error_with_cause(
    failure_kind: ApiFailureKind,
    failure_cause: ApiTransportCause,
) -> ProviderError {
    ProviderError::ApiTransport(Box::new(ApiTransportError {
        request: crate::error::ApiRequestContext {
            endpoint_label: "poll",
            method: "POST".to_string(),
            host: "api.vm0.test".to_string(),
            path: routes::runners::poll::POLL.path.to_string(),
            client_request_id: Uuid::new_v4().to_string(),
            client_session_id: "runner-session-test".to_string(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
        },
        failure_kind,
        failure_cause,
        summary: format!("synthetic {} failure", failure_kind.as_str()),
    }))
}

fn poll_transport_error(failure_kind: ApiFailureKind) -> ProviderError {
    poll_transport_error_with_cause(failure_kind, synthetic_transport_cause(failure_kind))
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

#[derive(Clone, Copy, Debug)]
enum DegradationPath {
    Poll,
    Heartbeat,
}

impl DegradationPath {
    fn degraded_after(self) -> Duration {
        match self {
            Self::Poll => POLL_DEGRADED_AFTER,
            Self::Heartbeat => HEARTBEAT_DEGRADED_AFTER,
        }
    }

    fn retry_message(self) -> &'static str {
        match self {
            Self::Poll => "poll failed, will retry",
            Self::Heartbeat => "heartbeat failed, will retry",
        }
    }

    fn degraded_message(self) -> &'static str {
        match self {
            Self::Poll => "poll fallback degraded",
            Self::Heartbeat => "heartbeat delivery degraded",
        }
    }

    fn degraded_level(self) -> Level {
        match self {
            Self::Poll => Level::ERROR,
            Self::Heartbeat => Level::WARN,
        }
    }

    fn recovery_message(self) -> &'static str {
        match self {
            Self::Poll => "poll fallback recovered",
            Self::Heartbeat => "heartbeat delivery recovered",
        }
    }

    fn transport_error(self, failure_cause: ApiTransportCause) -> ProviderError {
        let failure_kind = if failure_cause == ApiTransportCause::Timeout {
            ApiFailureKind::Timeout
        } else {
            ApiFailureKind::Request
        };
        match self {
            Self::Poll => poll_transport_error_with_cause(failure_kind, failure_cause),
            Self::Heartbeat => heartbeat_transport_error_with_cause(failure_kind, failure_cause),
        }
    }

    async fn record_failure(
        self,
        provider: &ApiProvider,
        state: &HeartbeatState,
        error: &ProviderError,
        now: Instant,
    ) {
        match self {
            Self::Poll => {
                provider
                    .record_poll_failure_at(PollReason::Fast, error, now)
                    .await;
            }
            Self::Heartbeat => {
                provider
                    .record_heartbeat_failure_at(state, error, now)
                    .await;
            }
        }
    }

    async fn record_success(self, provider: &ApiProvider, state: &HeartbeatState, now: Instant) {
        match self {
            Self::Poll => {
                provider
                    .record_poll_success_at(PollReason::WakeupRetry, now)
                    .await;
            }
            Self::Heartbeat => provider.record_heartbeat_success_at(state, now).await,
        }
    }
}

async fn push_direct_candidate_for_test(provider: &ApiProvider, candidate: DirectJobCandidate) {
    provider.direct_candidates.push(candidate).await;
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
    let server = RawHttpTestServer::spawn(vec![
        action,
        RawHttpAction::Respond(status_response(200)),
        RawHttpAction::Respond(status_response(500)),
    ])
    .await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
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
async fn api_paths_share_degradation_episode_transition_semantics() {
    let state = heartbeat_state_for_test();

    for (path, failure_cause) in [
        (DegradationPath::Poll, ApiTransportCause::ConnectionReset),
        (DegradationPath::Heartbeat, ApiTransportCause::Timeout),
        (DegradationPath::Poll, ApiTransportCause::UnexpectedEof),
        (DegradationPath::Heartbeat, ApiTransportCause::UnexpectedEof),
        (
            DegradationPath::Poll,
            ApiTransportCause::HttpIncompleteMessage,
        ),
        (
            DegradationPath::Heartbeat,
            ApiTransportCause::HttpIncompleteMessage,
        ),
    ] {
        let provider = idle_api_provider_for_test();
        let error = path.transport_error(failure_cause);
        let degraded_after = path.degraded_after();
        let started_at = Instant::now();

        let (_, events) = capture_api_provider_events(async {
            for failure_elapsed in [
                Duration::ZERO,
                degraded_after - Duration::from_secs(1),
                degraded_after,
                degraded_after + Duration::from_secs(1),
            ] {
                path.record_failure(&provider, &state, &error, started_at + failure_elapsed)
                    .await;
            }
        })
        .await;
        let path_events = events
            .iter()
            .filter(|event| {
                event.fields.get("message").is_some_and(|message| {
                    message == path.retry_message() || message == path.degraded_message()
                })
            })
            .collect::<Vec<_>>();

        assert_eq!(path_events.len(), 4, "path={path:?}; events={events:#?}");
        assert_eq!(path_events[0].level, Level::INFO, "path={path:?}");
        assert_eq!(path_events[1].level, Level::INFO, "path={path:?}");
        assert_eq!(path_events[2].level, path.degraded_level(), "path={path:?}");
        assert_eq!(path_events[3].level, Level::INFO, "path={path:?}");
        for (event, expected_count) in path_events.iter().zip(1_u64..=4) {
            assert_eq!(
                event_field(event, "consecutive_failures"),
                expected_count.to_string(),
                "path={path:?}"
            );
        }
        assert_eq!(
            event_field(path_events[1], "failure_elapsed_ms"),
            duration_ms(degraded_after - Duration::from_secs(1)).to_string(),
            "path={path:?}"
        );
        assert_eq!(
            event_field(path_events[2], "failure_elapsed_ms"),
            duration_ms(degraded_after).to_string(),
            "path={path:?}"
        );
        assert_eq!(
            event_field(path_events[3], "failure_elapsed_ms"),
            duration_ms(degraded_after + Duration::from_secs(1)).to_string(),
            "path={path:?}"
        );
        assert_eq!(event_field(path_events[1], "degraded"), "false");
        assert_eq!(event_field(path_events[2], "degraded"), "true");
        assert_eq!(event_field(path_events[3], "degraded"), "true");
        assert_eq!(
            path_events
                .iter()
                .filter(|event| event.level == path.degraded_level())
                .count(),
            1,
            "path={path:?}"
        );

        let recovery_elapsed = degraded_after + Duration::from_secs(2);
        let (_, recovery_events) = capture_api_provider_events(path.record_success(
            &provider,
            &state,
            started_at + recovery_elapsed,
        ))
        .await;
        let recovery = captured_event(&recovery_events, path.recovery_message());
        assert_eq!(recovery.level, Level::INFO, "path={path:?}");
        assert_eq!(event_field(recovery, "recovered_after_failures"), "4");
        assert_eq!(
            event_field(recovery, "failure_elapsed_ms"),
            duration_ms(recovery_elapsed).to_string(),
            "path={path:?}"
        );
        assert_eq!(event_field(recovery, "was_degraded"), "true");
        match path {
            DegradationPath::Poll => {
                assert_eq!(event_field(recovery, "runner_id"), TEST_RUNNER_ID);
                assert_eq!(event_field(recovery, "runner_group"), "default");
                assert_eq!(event_field(recovery, "poll_reason"), "wakeup_retry");
            }
            DegradationPath::Heartbeat => {
                assert_eq!(event_field(recovery, "runner_id"), "runner-heartbeat-test");
                assert_eq!(event_field(recovery, "runner_group"), "vm0/test");
                assert_eq!(event_field(recovery, "mode"), "running");
                assert_eq!(event_field(recovery, "running"), "1");
                assert_eq!(event_field(recovery, "reusable_sandboxes"), "1");
                assert_eq!(event_field(recovery, "home_states"), "1");
            }
        }

        let later_started_at = started_at + degraded_after + Duration::from_secs(3);
        let (_, later_events) = capture_api_provider_events(async {
            path.record_failure(&provider, &state, &error, later_started_at)
                .await;
            path.record_failure(&provider, &state, &error, later_started_at + degraded_after)
                .await;
        })
        .await;
        let later_initial = captured_event(&later_events, path.retry_message());
        assert_eq!(later_initial.level, Level::INFO);
        assert_eq!(event_field(later_initial, "consecutive_failures"), "1");
        assert_eq!(event_field(later_initial, "failure_elapsed_ms"), "0");
        assert_eq!(event_field(later_initial, "degraded"), "false");
        assert_eq!(
            later_events
                .iter()
                .filter(|event| {
                    event.level == path.degraded_level()
                        && event
                            .fields
                            .get("message")
                            .is_some_and(|message| message == path.degraded_message())
                })
                .count(),
            1,
            "path={path:?}; events={later_events:#?}"
        );
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
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
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
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
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
async fn poll_retryable_failure_logs_local_transport_context_for_every_reason() {
    let reasons = [
        (PollReason::Immediate, "immediate"),
        (PollReason::Deferred, "deferred"),
        (PollReason::WakeupRetry, "wakeup_retry"),
        (PollReason::Slow, "slow"),
        (PollReason::Fast, "fast"),
    ];

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
        for (reason, expected_reason) in reasons {
            let provider = idle_api_provider_for_test();
            let error = poll_transport_error_with_cause(failure_kind, failure_cause);
            let (_, events) = capture_api_provider_events(provider.record_poll_failure_at(
                reason,
                &error,
                Instant::now(),
            ))
            .await;
            let event = captured_event(&events, "poll failed, will retry");

            assert_eq!(event.level, Level::INFO);
            assert_eq!(event_field(event, "endpoint"), "poll");
            assert_eq!(event_field(event, "method"), "POST");
            assert_eq!(event_field(event, "host"), "api.vm0.test");
            assert_eq!(event_field(event, "path"), routes::runners::poll::POLL.path);
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
            assert_eq!(event_field(event, "poll_reason"), expected_reason);
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
                    && !event_debug.contains("supportedProfiles"),
                "event should not include a full URL, bearer token, or poll body: {event_debug}"
            );
        }
    }
}

#[tokio::test]
async fn poll_transient_http_failures_log_retry_without_response_bodies() {
    const STATUS_BODY: &str = "sensitive-transient-poll-status-body";

    for status in [408, 421, 425, 429, 500, 502, 503, 504, 599] {
        for (reason, expected_reason) in [
            (PollReason::Immediate, "immediate"),
            (PollReason::Deferred, "deferred"),
            (PollReason::WakeupRetry, "wakeup_retry"),
            (PollReason::Slow, "slow"),
            (PollReason::Fast, "fast"),
        ] {
            let provider = idle_api_provider_for_test();
            let error = ProviderError::ApiStatus(Box::new(ApiStatusError {
                endpoint_label: "poll",
                status: StatusCode::from_u16(status).unwrap(),
                body: STATUS_BODY.to_string(),
            }));
            let (_, events) = capture_api_provider_events(provider.record_poll_failure_at(
                reason,
                &error,
                Instant::now(),
            ))
            .await;
            let retry = captured_event(&events, "poll failed, will retry");

            assert_eq!(retry.level, Level::INFO, "status={status}");
            assert_eq!(event_field(retry, "endpoint"), "poll");
            assert_eq!(event_field(retry, "status"), status.to_string());
            assert_eq!(event_field(retry, "failure_kind"), "http_status");
            assert_eq!(event_field(retry, "poll_reason"), expected_reason);
            assert_eq!(event_field(retry, "consecutive_failures"), "1");
            assert_eq!(event_field(retry, "failure_elapsed_ms"), "0");
            assert_eq!(event_field(retry, "will_retry"), "true");
            assert_eq!(event_field(retry, "degraded"), "false");
            assert!(
                events
                    .iter()
                    .all(|event| event.level != Level::ERROR && event.level != Level::WARN),
                "a transient status must not immediately escalate: {events:#?}"
            );
            assert!(!format!("{events:#?}").contains(STATUS_BODY));
        }
    }
}

#[tokio::test]
async fn poll_http_and_transport_failures_share_degradation_and_reset() {
    const STATUS_BODY: &str = "sensitive-degraded-poll-status-body";
    let http_error = || {
        ProviderError::ApiStatus(Box::new(ApiStatusError {
            endpoint_label: "poll",
            status: StatusCode::BAD_GATEWAY,
            body: STATUS_BODY.to_string(),
        }))
    };

    for (first, second) in [
        (http_error(), http_error()),
        (http_error(), poll_transport_error(ApiFailureKind::Timeout)),
        (poll_transport_error(ApiFailureKind::Timeout), http_error()),
    ] {
        let provider = idle_api_provider_for_test();
        let started_at = Instant::now();
        let (_, events) = capture_api_provider_events(async {
            for (error, elapsed) in [
                (&first, Duration::ZERO),
                (&second, POLL_DEGRADED_AFTER - Duration::from_secs(1)),
                (&second, POLL_DEGRADED_AFTER),
                (&first, POLL_DEGRADED_AFTER + Duration::from_secs(1)),
            ] {
                provider
                    .record_poll_failure_at(PollReason::Fast, error, started_at + elapsed)
                    .await;
            }
            provider
                .record_poll_success_at(
                    PollReason::Fast,
                    started_at + POLL_DEGRADED_AFTER + Duration::from_secs(2),
                )
                .await;
            let later_started_at = started_at + POLL_DEGRADED_AFTER + Duration::from_secs(3);
            provider
                .record_poll_failure_at(PollReason::Fast, &second, later_started_at)
                .await;
            provider
                .record_poll_failure_at(
                    PollReason::Fast,
                    &first,
                    later_started_at + POLL_DEGRADED_AFTER,
                )
                .await;
        })
        .await;
        let failures = events
            .iter()
            .filter(|event| event.fields.contains_key("consecutive_failures"))
            .collect::<Vec<_>>();

        assert_eq!(failures.len(), 6, "{events:#?}");
        for ((event, count), (level, elapsed, degraded)) in
            failures.iter().zip([1, 2, 3, 4, 1, 2]).zip([
                (Level::INFO, 0, "false"),
                (Level::INFO, 59_000, "false"),
                (Level::ERROR, 60_000, "true"),
                (Level::INFO, 61_000, "true"),
                (Level::INFO, 0, "false"),
                (Level::ERROR, 60_000, "true"),
            ])
        {
            assert_eq!(event.level, level, "{events:#?}");
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
            let message = if level == Level::ERROR {
                "poll fallback degraded"
            } else {
                "poll failed, will retry"
            };
            assert_eq!(event_field(event, "message"), message);
            if event_field(event, "failure_kind") == "http_status" {
                assert_eq!(event_field(event, "status"), "502");
            }
        }
        let recovery = captured_event(&events, "poll fallback recovered");
        assert_eq!(recovery.level, Level::INFO);
        assert_eq!(event_field(recovery, "recovered_after_failures"), "4");
        assert_eq!(event_field(recovery, "failure_elapsed_ms"), "62000");
        assert_eq!(event_field(recovery, "was_degraded"), "true");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.level == Level::ERROR)
                .count(),
            2,
            "each episode should emit only one degradation error: {events:#?}"
        );
        assert!(!format!("{events:#?}").contains(STATUS_BODY));
    }
}

#[tokio::test]
async fn poll_non_retryable_failures_remain_errors_without_mutating_episode() {
    const STATUS_BODY: &str = "sensitive-poll-status-body";

    let provider = idle_api_provider_for_test();
    let retryable_error = poll_transport_error(ApiFailureKind::Timeout);
    let started_at = Instant::now();
    provider
        .record_poll_failure_at(PollReason::Immediate, &retryable_error, started_at)
        .await;
    let mut unsupported_errors = vec![
        poll_transport_error(ApiFailureKind::Request),
        poll_transport_error_with_cause(ApiFailureKind::Request, ApiTransportCause::HttpParse),
        poll_transport_error_with_cause(ApiFailureKind::Body, ApiTransportCause::ConnectionReset),
        poll_transport_error(ApiFailureKind::Body),
        poll_transport_error_with_cause(ApiFailureKind::Body, ApiTransportCause::UnexpectedEof),
        poll_transport_error_with_cause(
            ApiFailureKind::Body,
            ApiTransportCause::HttpIncompleteMessage,
        ),
        poll_transport_error(ApiFailureKind::Unknown),
        poll_transport_error_with_cause(ApiFailureKind::Unknown, ApiTransportCause::UnexpectedEof),
        ProviderError::ApiStatus(Box::new(ApiStatusError {
            endpoint_label: "poll",
            status: StatusCode::UNAUTHORIZED,
            body: STATUS_BODY.to_string(),
        })),
        ProviderError::Api("poll decode: failed at job.runId".to_string()),
        ProviderError::Internal("synthetic poll invariant".to_string()),
    ];
    unsupported_errors.extend([400, 403, 404, 422].map(|status| {
        ProviderError::ApiStatus(Box::new(ApiStatusError {
            endpoint_label: "poll",
            status: StatusCode::from_u16(status).unwrap(),
            body: STATUS_BODY.to_string(),
        }))
    }));

    let (_, events) = capture_api_provider_events(async {
        for error in &unsupported_errors {
            provider
                .record_poll_failure_at(
                    PollReason::Deferred,
                    error,
                    started_at + Duration::from_secs(30),
                )
                .await;
        }
    })
    .await;
    let immediate_errors = events
        .iter()
        .filter(|event| {
            event.level == Level::ERROR
                && event
                    .fields
                    .get("message")
                    .is_some_and(|message| message == "poll failed")
        })
        .collect::<Vec<_>>();
    assert_eq!(immediate_errors.len(), unsupported_errors.len());
    assert!(
        immediate_errors
            .iter()
            .all(|event| event_field(event, "poll_reason") == "deferred")
    );
    let status_event = immediate_errors
        .iter()
        .find(|event| {
            event
                .fields
                .get("failure_kind")
                .is_some_and(|kind| kind == "http_status")
        })
        .expect("status error event");
    assert_eq!(event_field(status_event, "endpoint"), "poll");
    assert_eq!(event_field(status_event, "status"), "401");
    assert!(
        !format!("{events:#?}").contains(STATUS_BODY),
        "poll status response body must not be logged: {events:#?}"
    );
    {
        let active_episode = provider
            .poll_degradation_tracker
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

    let (_, transition_events) = capture_api_provider_events(provider.record_poll_failure_at(
        PollReason::Fast,
        &retryable_error,
        started_at + POLL_DEGRADED_AFTER,
    ))
    .await;
    let transition = captured_event(&transition_events, "poll fallback degraded");
    assert_eq!(transition.level, Level::ERROR);
    assert_eq!(event_field(transition, "consecutive_failures"), "2");
}

#[test]
fn poll_request_body_serializes_poll_reason_telemetry() {
    let profiles = vec![crate::profile::DEFAULT_PROFILE.to_string()];
    let runner_id = TEST_RUNNER_ID.parse().unwrap();
    let body = serde_json::to_value(poll_request_body(
        runner_id,
        "vm0/test",
        &profiles,
        &[],
        PollReason::Immediate,
    ))
    .unwrap();

    assert_eq!(body["runnerId"], "550e8400-e29b-41d4-a716-446655440000");
    assert_eq!(body["group"], "vm0/test");
    assert_eq!(
        body["supportedProfiles"][0],
        crate::profile::DEFAULT_PROFILE
    );
    assert_eq!(body["telemetry"]["pollReason"], "immediate");
}

#[test]
fn claim_request_body_serializes_validated_identity_and_runner_timing() {
    let now = std::time::Instant::now();
    let candidate = JobCandidate::new_with_timing_for_test(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
        now.checked_sub(Duration::from_millis(25)).unwrap(),
        Some(now.checked_sub(Duration::from_millis(7)).unwrap()),
    )
    .with_discovery_source(JobDiscoverySource::Poll)
    .with_poll_reason("deferred")
    .with_poll_timing(Duration::from_millis(19), Duration::from_millis(11));

    let body = claim_request_body_for_test(&candidate);

    assert_eq!(body["runnerIdentity"]["runnerId"], TEST_RUNNER_ID);
    assert_eq!(
        body["runnerIdentity"]["heartbeatGeneration"],
        TEST_HEARTBEAT_GENERATION
    );
    assert_eq!(body["telemetry"]["discoverySource"], "poll");
    assert!(
        body["telemetry"]["jobDiscoveredToClaimRequestMs"]
            .as_u64()
            .is_some_and(|value| value >= 25)
    );
    assert!(
        body["telemetry"]["localAdmissionToClaimRequestMs"]
            .as_u64()
            .is_some_and(|value| value >= 7)
    );
    assert_eq!(body["telemetry"]["pollDueToJobDiscoveredMs"], 19);
    assert_eq!(body["telemetry"]["pollHttpRequestMs"], 11);
    assert_eq!(body["telemetry"]["pollReason"], "deferred");
    assert!(body.get("runnerHostname").is_none());
    assert!(body["telemetry"].get("runnerPreference").is_none());
    assert!(
        body["telemetry"]
            .get("runnerPreferenceClaimState")
            .is_none()
    );
    assert!(!body.to_string().contains("rawSizeBytes"));
    assert!(!body.to_string().contains("sessionId"));
    assert!(!body.to_string().contains("historyHash"));
    assert!(!body.to_string().contains("cacheKey"));
    assert!(!body.to_string().contains("path"));
    assert_eq!(
        body["capabilities"]["piModelConfigGenerations"],
        serde_json::json!([2, 3, 5])
    );

    let runner_identity = test_runner_identity();
    let attributed = serde_json::to_value(claim_request_body(
        &candidate,
        &runner_identity,
        Some("prod-1.aws.vm3.ai"),
        None,
    ))
    .unwrap();
    assert_eq!(attributed["runnerHostname"], "prod-1.aws.vm3.ai");
    assert!(
        attributed.get("installedVersions").is_none(),
        "a runner without an installed CLI must omit installedVersions"
    );

    let installed = InstalledOkouCli {
        schema_version: 1,
        versions: OkouCliVersions {
            cli: "9.353.0".to_string(),
            pi_agent_runtime: "1.36.0".to_string(),
            pi_sdk: "0.86.1+okou.0123456789ab".to_string(),
        },
        package: OkouCliInstalledPackage {
            sha256: "a".repeat(64),
            size: 7,
        },
        entrypoint: InstalledOkouCli::entrypoint_for("9.353.0"),
    };
    let advertised = serde_json::to_value(claim_request_body(
        &candidate,
        &runner_identity,
        None,
        Some(&installed),
    ))
    .unwrap();
    assert_eq!(
        advertised["installedVersions"],
        serde_json::json!({
            "cli": "9.353.0",
            "piAgentRuntime": "1.36.0",
            "piSdk": "0.86.1+okou.0123456789ab"
        })
    );
}

#[test]
fn claim_request_body_serializes_canonical_preference_at_claim_time() {
    let active_preference = ActiveRunnerPreference::new(
        test_runner_identity(),
        crate::provider::RunnerPreferenceTarget::HomeCache,
        Instant::now() + Duration::from_secs(60),
    );
    let active = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_runner_preference(active_preference);
    let active_body = claim_request_body_for_test(&active);
    assert_eq!(
        active_body["telemetry"]["runnerPreference"]["kind"],
        "preference"
    );
    assert_eq!(
        active_body["telemetry"]["runnerPreference"]["tier"],
        "homeCache"
    );
    assert_eq!(
        active_body["telemetry"]["runnerPreference"]["runnerIdentity"]["runnerId"],
        TEST_RUNNER_ID
    );
    assert_eq!(
        active_body["telemetry"]["runnerPreferenceClaimState"],
        "active"
    );

    let expired_preference = ActiveRunnerPreference::new(
        test_runner_identity(),
        crate::provider::RunnerPreferenceTarget::ExactSandbox(RunId::new_v4()),
        Instant::now() - Duration::from_secs(1),
    );
    let expired = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_runner_preference(expired_preference);
    let expired_body = claim_request_body_for_test(&expired);
    assert_eq!(
        expired_body["telemetry"]["runnerPreferenceClaimState"],
        "expired"
    );

    let cleared_preference = ActiveRunnerPreference::new(
        RunnerProcessIdentity::new(Uuid::from_u128(8), TEST_HEARTBEAT_GENERATION).unwrap(),
        crate::provider::RunnerPreferenceTarget::FinalizingPredecessor(RunId::new_v4()),
        Instant::now() + Duration::from_secs(60),
    );
    let cleared = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_runner_preference(cleared_preference)
    .without_runner_preference(RunnerPreferenceRemovalReason::Cleared);
    let cleared_body = claim_request_body_for_test(&cleared);
    assert_eq!(
        cleared_body["telemetry"]["runnerPreferenceClaimState"],
        "cleared"
    );
    let no_preference = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_no_runner_preference_for_test(RunnerNoPreferenceReason::NoViableHolder);
    let no_preference_body = claim_request_body_for_test(&no_preference);
    assert_eq!(
        no_preference_body["telemetry"]["runnerPreference"]["kind"],
        "noPreference"
    );
    assert_eq!(
        no_preference_body["telemetry"]["runnerPreference"]["reason"],
        "noViableHolder"
    );
    assert!(
        no_preference_body["telemetry"]
            .get("runnerPreferenceClaimState")
            .is_none()
    );
}

#[test]
fn claim_request_body_serializes_ably_timing_splits() {
    let mut candidate = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_discovery_source(JobDiscoverySource::Ably)
    .with_direct_candidate_timing(
        Some(Duration::from_millis(3)),
        Some(Duration::from_millis(5)),
    );
    candidate.mark_provider_discovery_returned();
    candidate.mark_main_loop_handling_started();
    candidate.mark_local_admission_started();

    let body = claim_request_body_for_test(&candidate);

    assert_eq!(body["telemetry"]["discoverySource"], "ably");
    assert_eq!(
        body["telemetry"]["directCandidateNotificationToEnqueueMs"],
        3
    );
    assert_eq!(body["telemetry"]["directCandidateInboxWaitMs"], 5);
    assert!(
        body["telemetry"]["providerDiscoveryToMainLoopMs"]
            .as_u64()
            .is_some()
    );
    assert!(
        body["telemetry"]["mainLoopToLocalAdmissionMs"]
            .as_u64()
            .is_some()
    );
}

#[test]
fn claim_request_body_omits_ably_only_timing_splits_for_poll_candidates() {
    let mut candidate = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_discovery_source(JobDiscoverySource::Poll)
    .with_direct_candidate_timing(
        Some(Duration::from_millis(3)),
        Some(Duration::from_millis(5)),
    );
    candidate.mark_provider_discovery_returned();
    candidate.mark_main_loop_handling_started();
    candidate.mark_local_admission_started();

    let body = claim_request_body_for_test(&candidate);

    assert_eq!(body["telemetry"]["discoverySource"], "poll");
    assert!(
        body["telemetry"]
            .get("directCandidateNotificationToEnqueueMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("directCandidateInboxWaitMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("providerDiscoveryToMainLoopMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("mainLoopToLocalAdmissionMs")
            .is_none()
    );
}

#[test]
fn claim_request_body_saturates_wire_timing_to_js_safe_integer() {
    let candidate = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_poll_timing(
        Duration::MAX,
        Duration::from_millis(CLAIM_TELEMETRY_DURATION_MS_MAX + 1),
    );

    let body = claim_request_body_for_test(&candidate);

    assert_eq!(
        body["telemetry"]["pollDueToJobDiscoveredMs"],
        CLAIM_TELEMETRY_DURATION_MS_MAX
    );
    assert_eq!(
        body["telemetry"]["pollHttpRequestMs"],
        CLAIM_TELEMETRY_DURATION_MS_MAX
    );
}

#[test]
fn claim_request_body_omits_missing_local_admission_timing() {
    let now = std::time::Instant::now();
    let candidate = JobCandidate::new_with_timing_for_test(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
        now.checked_sub(Duration::from_millis(25)).unwrap(),
        None,
    );

    let body = claim_request_body_for_test(&candidate);

    assert!(
        body["telemetry"]["jobDiscoveredToClaimRequestMs"]
            .as_u64()
            .is_some_and(|value| value >= 25)
    );
    assert!(
        body["telemetry"]
            .get("localAdmissionToClaimRequestMs")
            .is_none()
    );
    assert!(body["telemetry"].get("pollDueToJobDiscoveredMs").is_none());
    assert!(body["telemetry"].get("pollHttpRequestMs").is_none());
    assert!(body["telemetry"].get("pollReason").is_none());
    assert!(
        body["telemetry"]
            .get("directCandidateNotificationToEnqueueMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("directCandidateInboxWaitMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("providerDiscoveryToMainLoopMs")
            .is_none()
    );
    assert!(
        body["telemetry"]
            .get("mainLoopToLocalAdmissionMs")
            .is_none()
    );
}

#[test]
fn claim_request_body_serializes_ably_discovery_source_without_poll_timing() {
    let candidate = JobCandidate::new(
        RunId::from(uuid::Uuid::nil()),
        crate::profile::DEFAULT_PROFILE.to_string(),
    )
    .with_discovery_source(JobDiscoverySource::Ably);

    let body = claim_request_body_for_test(&candidate);

    assert_eq!(body["telemetry"]["discoverySource"], "ably");
    assert!(body["telemetry"].get("pollDueToJobDiscoveredMs").is_none());
    assert!(body["telemetry"].get("pollHttpRequestMs").is_none());
    assert!(body["telemetry"].get("pollReason").is_none());
}

fn poll_job_response(run_id: RunId) -> Vec<u8> {
    let body = serde_json::json!({
        "job": {
            "runId": run_id,
            "experimentalProfile": "vm0/default"
        }
    })
    .to_string();
    json_response("200 OK", &body)
}

async fn write_poll_job_response(socket: &mut tokio::net::TcpStream, run_id: RunId) {
    socket.write_all(&poll_job_response(run_id)).await.unwrap();
}

#[tokio::test]
async fn discover_cancel_aborts_in_flight_poll() {
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
    let api_url = server.url();

    let cancel = CancellationToken::new();
    let provider =
        api_provider_for_test(api_url, cancel.clone(), Arc::new(PollWakeups::new(false)));

    let provider_for_discover = Arc::clone(&provider);
    let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

    server.next_request("in-flight poll request").await;

    cancel.cancel();

    let result = tokio::time::timeout(Duration::from_secs(1), discover_task)
        .await
        .expect("discover should not wait for the HTTP poll timeout")
        .unwrap();
    assert!(result.is_none());

    server.cancel_and_reap().await;
}

#[tokio::test]
async fn discover_returns_http_poll_job_after_wakeup() {
    let server = MockServer::start_async().await;
    let run_id: RunId = "00000000-0000-0000-0000-000000000003".parse().unwrap();
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": run_id,
                    "experimentalProfile": "vm0/large",
                    "cliAgentSessionId": "sess-poll",
                    "runnerPreference": {
                        "kind": "preference",
                        "runnerIdentity": {
                            "runnerId": "00000000-0000-0000-0000-000000000005",
                            "heartbeatGeneration": 7
                        },
                        "tier": "exactSandbox",
                        "predecessorRunId": "33333333-3333-4333-8333-333333333333",
                        "expiresAt": "2999-01-01T00:00:00.000Z"
                    }
                }
            }));
        })
        .await;
    let provider = api_provider_for_test_with_supported_profiles(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
        vec!["vm0/large".to_string()],
    );

    let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should poll after wakeup")
        .unwrap();

    assert_eq!(discovered.run_id(), run_id);
    assert_eq!(discovered.profile_name(), "vm0/large");
    let preference = discovered
        .runner_preference()
        .expect("canonical preference should be parsed");
    assert_eq!(preference.tier(), RunnerPreferenceTier::ExactSandbox);
    assert_eq!(
        preference.target().predecessor_run_id(),
        Some("33333333-3333-4333-8333-333333333333".parse().unwrap())
    );
    assert!(
        preference.targets(
            RunnerProcessIdentity::new("00000000-0000-0000-0000-000000000005".parse().unwrap(), 7,)
                .unwrap()
        )
    );
    let telemetry = discovered
        .runner_preference_claim_telemetry()
        .expect("canonical preference telemetry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::Preference(
            crate::provider::RunnerPreferenceDecision::ExactSandbox { .. }
        )
    ));
    assert_eq!(telemetry.state, Some(RunnerPreferenceClaimState::Active));
    assert_eq!(
        discovered.discovery_source(),
        Some(JobDiscoverySource::Poll)
    );
    assert!(discovered.poll_due_to_job_discovered_elapsed().is_some());
    assert!(discovered.poll_http_request_elapsed().is_some());
    mock.assert_async().await;
}

#[tokio::test]
async fn discover_recovers_after_retryable_poll_failure() {
    const STATUS_BODY: &str = "sensitive-http-502-poll-response";

    for (action, failure_kind, status) in [
        (RawHttpAction::Disconnect, "request", None),
        (
            RawHttpAction::Respond(http_response("502 Bad Gateway", STATUS_BODY.as_bytes())),
            "http_status",
            Some("502"),
        ),
    ] {
        let run_id = RunId::new_v4();
        let server = RawHttpTestServer::spawn(vec![
            action,
            RawHttpAction::Respond(poll_job_response(run_id)),
        ])
        .await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let discovery = tokio::time::timeout(Duration::from_secs(10), provider.discover())
            .with_subscriber(subscriber);
        tokio::pin!(discovery);
        advance_pending_discovery_retry(
            discovery.as_mut(),
            &captured,
            "poll failed, will retry",
            POLL_WAKEUP_RETRY,
        )
        .await;
        let discovered = discovery
            .await
            .expect("discovery should recover on the existing wakeup retry")
            .expect("poll candidate after retryable failure");
        let events = captured.entries();
        let requests = server.assert_finished_with_requests().await;

        assert_eq!(discovered.run_id(), run_id);
        assert_eq!(
            discovered.discovery_source(),
            Some(JobDiscoverySource::Poll)
        );
        assert_eq!(requests.len(), 2);
        for (request, reason) in requests.iter().zip(["immediate", "wakeup_retry"]) {
            assert!(request.starts_with("POST /api/runners/poll "));
            let (_, body) = request.split_once("\r\n\r\n").expect("poll request body");
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["telemetry"]["pollReason"], reason);
        }
        let retry = captured_event(&events, "poll failed, will retry");
        assert_eq!(retry.level, Level::INFO);
        assert_eq!(event_field(retry, "failure_kind"), failure_kind);
        if let Some(status) = status {
            assert_eq!(event_field(retry, "status"), status);
        } else {
            assert_eq!(
                event_field(retry, "failure_cause"),
                "http_incomplete_message"
            );
        }
        assert_eq!(event_field(retry, "poll_reason"), "immediate");
        assert_eq!(event_field(retry, "will_retry"), "true");
        assert_eq!(event_field(retry, "degraded"), "false");
        let recovery = captured_event(&events, "poll fallback recovered");
        assert_eq!(recovery.level, Level::INFO);
        assert_eq!(event_field(recovery, "poll_reason"), "wakeup_retry");
        assert_eq!(event_field(recovery, "recovered_after_failures"), "1");
        assert_eq!(event_field(recovery, "was_degraded"), "false");
        assert!(
            events
                .iter()
                .all(|event| event.level != Level::ERROR && event.level != Level::WARN)
        );
        assert!(!format!("{events:#?}").contains(STATUS_BODY));
    }
}

#[tokio::test]
async fn discover_transient_status_extends_episode_until_empty_poll_recovers() {
    const STATUS_BODY: &str = "sensitive-poll-status-response";

    let run_id = RunId::new_v4();
    let (release_status_tx, release_status_rx) = tokio::sync::oneshot::channel();
    let (release_empty_tx, release_empty_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: release_status_rx,
            response: http_response("503 Service Unavailable", STATUS_BODY.as_bytes()),
        },
        RawHttpAction::WaitThenRespond {
            release: release_empty_rx,
            response: json_response("200 OK", r#"{"job":null}"#),
        },
        RawHttpAction::Respond(poll_job_response(run_id)),
    ])
    .await;
    let wakeups = Arc::new(PollWakeups::new(false));
    let provider =
        api_provider_for_test(server.url(), CancellationToken::new(), Arc::clone(&wakeups));
    let started_at = Instant::now();
    provider
        .record_poll_failure_at(
            PollReason::Immediate,
            &poll_transport_error_with_cause(
                ApiFailureKind::Request,
                ApiTransportCause::ConnectionReset,
            ),
            started_at,
        )
        .await;

    let ((discovered, ()), events) = capture_api_provider_events(async {
        tokio::join!(
            async {
                tokio::time::timeout(Duration::from_secs(1), provider.discover())
                    .await
                    .expect("queued polls should discover the final candidate")
                    .expect("poll candidate")
            },
            async {
                server.next_request("status poll request").await;
                wakeups.request_immediate_poll();
                release_status_tx.send(()).unwrap();

                server.next_request("empty poll request").await;
                {
                    let active_episode = provider
                        .poll_degradation_tracker
                        .active_episode
                        .lock()
                        .await;
                    let episode = active_episode
                        .as_ref()
                        .expect("status failure must not reset the poll episode");
                    assert_eq!(episode.started_at, started_at);
                    assert_eq!(episode.consecutive_failures, 2);
                }
                wakeups.request_immediate_poll();
                release_empty_tx.send(()).unwrap();

                server.next_request("job poll request after recovery").await;
            }
        )
    })
    .await;

    assert_eq!(discovered.run_id(), run_id);
    assert!(
        provider
            .poll_degradation_tracker
            .active_episode
            .lock()
            .await
            .is_none()
    );
    let status_event = captured_event(&events, "poll failed, will retry");
    assert_eq!(status_event.level, Level::INFO);
    assert_eq!(event_field(status_event, "status"), "503");
    assert_eq!(event_field(status_event, "failure_kind"), "http_status");
    assert_eq!(event_field(status_event, "poll_reason"), "immediate");
    assert_eq!(event_field(status_event, "consecutive_failures"), "2");
    assert!(
        !format!("{status_event:#?}").contains(STATUS_BODY),
        "status response body must not be logged: {status_event:#?}"
    );
    let recovery = captured_event(&events, "poll fallback recovered");
    assert_eq!(recovery.level, Level::INFO);
    assert_eq!(event_field(recovery, "poll_reason"), "immediate");
    assert_eq!(event_field(recovery, "recovered_after_failures"), "2");
    assert_eq!(event_field(recovery, "was_degraded"), "false");
    assert!(
        events
            .iter()
            .all(|event| event.level != Level::ERROR && event.level != Level::WARN)
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn discover_parses_canonical_no_preference() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": run_id,
                    "experimentalProfile": "vm0/default",
                    "runnerPreference": {
                        "kind": "noPreference",
                        "reason": "noViableHolder"
                    }
                }
            }));
        })
        .await;
    let provider = api_provider_for_test_with_supported_profiles(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
        vec!["vm0/default".to_string()],
    );

    let candidate = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should preserve the job")
        .expect("job candidate");

    assert!(candidate.runner_preference().is_none());
    let telemetry = candidate
        .runner_preference_claim_telemetry()
        .expect("no-preference telemetry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::NoPreference {
            reason: RunnerNoPreferenceReason::NoViableHolder
        }
    ));
    assert_eq!(telemetry.state, None);
    mock.assert_async().await;
}

#[tokio::test]
async fn discover_preserves_poll_job_after_malformed_preference() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": run_id,
                    "experimentalProfile": "vm0/default",
                    "reuseKey": "thread:malformed-preference",
                    "runnerPreference": {
                        "kind": "preference",
                        "runnerIdentity": {
                            "runnerId": TEST_RUNNER_ID,
                            "heartbeatGeneration": 0
                        },
                        "tier": "homeCache",
                        "expiresAt": "2999-01-01T00:00:00.000Z"
                    }
                }
            }));
        })
        .await;
    let provider = api_provider_for_test_with_supported_profiles(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
        vec!["vm0/default".to_string()],
    );

    let candidate = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should preserve the job")
        .expect("job candidate");

    assert_eq!(candidate.run_id(), run_id);
    assert_eq!(candidate.reuse_key(), Some("thread:malformed-preference"));
    assert!(candidate.runner_preference().is_none());
    assert!(candidate.runner_preference_claim_telemetry().is_none());
    mock.assert_async().await;
}

#[tokio::test]
async fn discover_preserves_poll_job_without_preference() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": run_id,
                    "experimentalProfile": "vm0/default",
                    "reuseKey": "thread:missing-preference"
                }
            }));
        })
        .await;
    let provider = api_provider_for_test_with_supported_profiles(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
        vec!["vm0/default".to_string()],
    );

    let candidate = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should preserve the job")
        .expect("job candidate");

    assert_eq!(candidate.run_id(), run_id);
    assert_eq!(candidate.reuse_key(), Some("thread:missing-preference"));
    assert!(candidate.runner_preference().is_none());
    assert!(candidate.runner_preference_claim_telemetry().is_none());
    mock.assert_async().await;
}

#[tokio::test]
async fn discover_returns_ably_direct_candidate_without_polling() {
    let server = MockServer::start_async().await;
    let run_id: RunId = "00000000-0000-0000-0000-000000000006".parse().unwrap();
    let poll_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200)
                .json_body(serde_json::json!({ "job": null }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let discovered_at = Instant::now()
        .checked_sub(Duration::from_millis(25))
        .unwrap();
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new_with_discovered_at(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
            discovered_at,
        ),
    )
    .await;

    let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should receive direct candidate")
        .unwrap();

    assert_eq!(discovered.run_id(), run_id);
    assert_eq!(discovered.profile_name(), crate::profile::DEFAULT_PROFILE);
    assert_eq!(
        discovered.discovery_source(),
        Some(JobDiscoverySource::Ably)
    );
    assert!(discovered.job_discovered_elapsed() >= Duration::from_millis(25));
    assert!(
        discovered
            .direct_candidate_notification_to_enqueue_elapsed()
            .is_some()
    );
    assert!(discovered.direct_candidate_inbox_wait_elapsed().is_some());
    assert!(
        discovered
            .provider_discovery_to_main_loop_elapsed()
            .is_none()
    );
    assert!(discovered.poll_due_to_job_discovered_elapsed().is_none());
    assert!(discovered.poll_http_request_elapsed().is_none());
    poll_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn try_discover_ready_returns_buffered_direct_candidate_without_polling() {
    let server = MockServer::start_async().await;
    let run_id: RunId = "00000000-0000-0000-0000-000000000016".parse().unwrap();
    let poll_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200)
                .json_body(serde_json::json!({ "job": null }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let discovered = provider
        .try_discover_ready()
        .await
        .expect("ready candidate should be available");

    assert_eq!(discovered.run_id(), run_id);
    assert_eq!(discovered.profile_name(), crate::profile::DEFAULT_PROFILE);
    assert_eq!(
        discovered.discovery_source(),
        Some(JobDiscoverySource::Ably)
    );
    assert!(provider.try_discover_ready().await.is_none());
    poll_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn discover_prunes_stale_direct_candidate_and_polls_immediately() {
    let server = MockServer::start_async().await;
    let stale_run_id: RunId = "00000000-0000-0000-0000-000000000017".parse().unwrap();
    let poll_run_id: RunId = "00000000-0000-0000-0000-000000000018".parse().unwrap();
    let poll_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::runners::poll::POLL.path)
                .json_body(serde_json::json!({
                    "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                    "group": "default",
                    "supportedProfiles": [crate::profile::DEFAULT_PROFILE],
                    "telemetry": {
                        "pollReason": "immediate"
                    }
                }));
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": poll_run_id,
                    "experimentalProfile": crate::profile::DEFAULT_PROFILE
                }
            }));
        })
        .await;
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial_poll = wakeups
        .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY);
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::clone(&wakeups),
    );
    let stale_enqueued_at = Instant::now() - Duration::from_secs(120);
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new_with_enqueued_at(
            stale_run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
            stale_enqueued_at,
            stale_enqueued_at,
        ),
    )
    .await;

    let discovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("stale direct pruning should wake immediate poll")
        .unwrap();

    assert_eq!(discovered.run_id(), poll_run_id);
    assert_eq!(
        discovered.discovery_source(),
        Some(JobDiscoverySource::Poll)
    );
    poll_mock.assert_async().await;
}

#[tokio::test]
async fn deterministic_claim_failure_excludes_run_and_polls_next_candidate() {
    let server = MockServer::start_async().await;
    let rejected_run_id: RunId = "00000000-0000-0000-0000-000000000009".parse().unwrap();
    let next_run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let rejected_claim_path = format!("/api/runners/jobs/{rejected_run_id}/claim");
    let rejected_claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(rejected_claim_path.as_str());
            then.status(400).body("sensitive-claim-rejection-body");
        })
        .await;
    let poll_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::runners::poll::POLL.path)
                .json_body(serde_json::json!({
                    "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                    "group": "default",
                    "supportedProfiles": [crate::profile::DEFAULT_PROFILE],
                    "excludedRunIds": [rejected_run_id],
                    "telemetry": {
                        "pollReason": "immediate"
                    }
                }));
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": next_run_id,
                    "experimentalProfile": crate::profile::DEFAULT_PROFILE
                }
            }));
        })
        .await;
    let next_claim_path = format!("/api/runners/jobs/{next_run_id}/claim");
    let next_claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(next_claim_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .body(RUNNER_CLAIM_RESPONSE_FIXTURE);
        })
        .await;
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial_poll = wakeups
        .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY);
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::clone(&wakeups),
    );
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(rejected_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let direct = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("discover should receive direct candidate")
        .unwrap();
    assert_eq!(direct.discovery_source(), Some(JobDiscoverySource::Ably));
    let (claim, events) = capture_api_provider_events(provider.claim(direct)).await;
    assert!(claim.is_none());
    let event = captured_event(&events, "claim failed, candidate cooling down");
    assert_eq!(event.level, Level::ERROR);
    assert_eq!(event_field(event, "failure_class"), "http_deterministic");
    assert_eq!(event_field(event, "status"), "400");
    assert_eq!(event_field(event, "retry_after_ms"), "30000");
    assert_eq!(event_field(event, "retry_scope"), "candidate");
    assert!(
        !format!("{event:#?}").contains("sensitive-claim-rejection-body"),
        "claim failure event must not contain the response body"
    );
    let next = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("claim failure should poll for another candidate")
        .unwrap();

    assert_eq!(next.run_id(), next_run_id);
    assert_eq!(next.discovery_source(), Some(JobDiscoverySource::Poll));
    assert!(provider.claim(next).await.is_some());
    rejected_claim_mock.assert_calls_async(1).await;
    poll_mock.assert_async().await;
    next_claim_mock.assert_async().await;
}

#[tokio::test]
async fn unavailable_claim_polls_backlog_without_excluding_run() {
    let server = MockServer::start_async().await;
    let unavailable_run_id: RunId = "00000000-0000-0000-0000-00000000001b".parse().unwrap();
    let next_run_id: RunId = "00000000-0000-0000-0000-00000000001c".parse().unwrap();
    let claim_path = format!("/api/runners/jobs/{unavailable_run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(404);
        })
        .await;
    let poll_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::runners::poll::POLL.path)
                .json_body(serde_json::json!({
                    "runnerId": "550e8400-e29b-41d4-a716-446655440000",
                    "group": "default",
                    "supportedProfiles": [crate::profile::DEFAULT_PROFILE],
                    "telemetry": {
                        "pollReason": "immediate"
                    }
                }));
            then.status(200).json_body(serde_json::json!({
                "job": {
                    "runId": next_run_id,
                    "experimentalProfile": crate::profile::DEFAULT_PROFILE
                }
            }));
        })
        .await;
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial_poll = wakeups
        .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY);
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::clone(&wakeups),
    );
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(
            unavailable_run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ),
    )
    .await;

    let unavailable = provider.discover().await.unwrap();
    assert!(provider.claim(unavailable).await.is_none());
    let next = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("unavailable claim should promptly poll the backlog")
        .unwrap();
    assert_eq!(next.run_id(), next_run_id);

    claim_mock.assert_calls_async(1).await;
    poll_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn transient_claim_failure_repolls_when_cooldown_expires_during_excluded_poll() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let (release_excluded_poll_tx, release_excluded_poll_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(status_response(503)),
        RawHttpAction::WaitThenRespond {
            release: release_excluded_poll_rx,
            response: json_response("200 OK", r#"{"job":null}"#),
        },
        RawHttpAction::Respond(poll_job_response(run_id)),
        RawHttpAction::Respond(json_response("200 OK", RUNNER_CLAIM_RESPONSE_FIXTURE)),
    ])
    .await;
    let api_url = server.url();
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial_poll = wakeups
        .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY);
    let provider = api_provider_for_test(api_url, CancellationToken::new(), Arc::clone(&wakeups));
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let direct = provider.discover().await.unwrap();
    assert!(provider.claim(direct).await.is_none());
    let first_claim_request = server.next_request("initial transient claim request").await;
    assert!(first_claim_request.contains(&format!("/api/runners/jobs/{run_id}/claim")));

    let provider_for_discover = Arc::clone(&provider);
    let discover_task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        provider_for_discover.discover().await.unwrap()
    }));
    let excluded_poll_request = server
        .next_request("poll request excluding the transiently failed claim")
        .await;
    let excluded_poll_observed_at = tokio::time::Instant::now();
    assert!(excluded_poll_request.contains(r#""excludedRunIds":["#));
    assert!(excluded_poll_request.contains(&run_id.to_string()));
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            server.next_request("claim retry before its transient cooldown"),
        )
        .await
        .is_err(),
        "claim retry must wait for its transient cooldown"
    );

    let cooldown_elapsed_at =
        excluded_poll_observed_at + CLAIM_TRANSIENT_COOLDOWN + Duration::from_millis(50);
    let cooldown = tokio::time::sleep_until(cooldown_elapsed_at);
    tokio::pin!(cooldown);
    // A delayed observer may reach the original deadline after it has elapsed.
    if futures_util::poll!(cooldown.as_mut()).is_pending() {
        // The peer is holding its response. Advance the armed timer, then
        // resume before releasing the real I/O.
        tokio::time::pause();
        tokio::time::advance(
            cooldown_elapsed_at.saturating_duration_since(tokio::time::Instant::now()),
        )
        .await;
        tokio::time::resume();
        cooldown.await;
    }
    release_excluded_poll_tx
        .send(())
        .expect("excluded poll response should still be waiting for release");

    let retry_poll_request = server
        .next_request("poll request after the transient cooldown")
        .await;
    assert!(!retry_poll_request.contains(r#""excludedRunIds""#));
    let retry_candidate = tokio::time::timeout(Duration::from_secs(1), discover_task)
        .await
        .expect("retry poll should return the cooled candidate")
        .unwrap();
    assert_eq!(retry_candidate.run_id(), run_id);
    assert!(
        tokio::time::timeout(Duration::from_secs(1), provider.claim(retry_candidate))
            .await
            .expect("retry claim should receive its response")
            .is_some()
    );
    let second_claim_request = server
        .next_request("claim request after the transient cooldown")
        .await;
    assert!(second_claim_request.contains(&format!("/api/runners/jobs/{run_id}/claim")));

    server.assert_finished().await;
}

#[tokio::test]
async fn poll_returning_cooled_run_does_not_rediscover_it() {
    let run_id: RunId = "00000000-0000-0000-0000-00000000001a".parse().unwrap();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::Respond(status_response(400)),
        RawHttpAction::Respond(poll_job_response(run_id)),
    ])
    .await;
    let api_url = server.url();
    let wakeups = Arc::new(PollWakeups::new(true));
    let initial_poll = wakeups
        .wait_for_poll_due(&CancellationToken::new(), POLL_SLOW, POLL_FAST)
        .await
        .unwrap();
    wakeups.record_poll_result(initial_poll, PollOutcome::Empty, POLL_WAKEUP_RETRY);
    let cancel = CancellationToken::new();
    let provider = api_provider_for_test(api_url, cancel.clone(), Arc::clone(&wakeups));
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let direct = provider.discover().await.unwrap();
    assert!(provider.claim(direct).await.is_none());
    let claim_request = server.next_request("rejected claim request").await;
    assert!(claim_request.contains(&format!("/api/runners/jobs/{run_id}/claim")));

    let provider_for_discover = Arc::clone(&provider);
    let mut discover_task = tokio::spawn(async move { provider_for_discover.discover().await });
    let excluded_poll_request = server.next_request("excluded poll request").await;
    assert!(excluded_poll_request.contains(r#""excludedRunIds":["#));
    assert!(excluded_poll_request.contains(&run_id.to_string()));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut discover_task)
            .await
            .is_err(),
        "a cooled run returned by a poll must not be rediscovered"
    );
    assert!(server.try_next_request().is_err());

    cancel.cancel();
    assert!(discover_task.await.unwrap().is_none());
    server.assert_finished().await;
}

#[tokio::test]
async fn failed_direct_candidate_does_not_block_next_direct_candidate() {
    let server = MockServer::start_async().await;
    let rejected_run_id: RunId = "00000000-0000-0000-0000-000000000019".parse().unwrap();
    let next_run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let rejected_path = format!("/api/runners/jobs/{rejected_run_id}/claim");
    let rejected_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(rejected_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"runId":"truncated-response"#);
        })
        .await;
    let next_path = format!("/api/runners/jobs/{next_run_id}/claim");
    let next_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(next_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .body(RUNNER_CLAIM_RESPONSE_FIXTURE);
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(true)),
    );
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(rejected_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(next_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let rejected = provider.discover().await.unwrap();
    assert_eq!(rejected.run_id(), rejected_run_id);
    let (claim, events) = capture_api_provider_events(provider.claim(rejected)).await;
    assert!(claim.is_none());
    let event = captured_event(&events, "claim failed, candidate cooling down");
    assert_eq!(event_field(event, "failure_class"), "response_decode");
    assert_eq!(event_field(event, "retry_after_ms"), "30000");

    let next = provider
        .try_discover_ready()
        .await
        .expect("next direct candidate should remain ready");
    assert_eq!(next.run_id(), next_run_id);
    assert_eq!(next.discovery_source(), Some(JobDiscoverySource::Ably));
    assert!(provider.claim(next).await.is_some());

    rejected_mock.assert_calls_async(1).await;
    next_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn saturated_claim_cooldowns_gate_repeated_direct_candidates() {
    let server = MockServer::start_async().await;
    let first_run_id: RunId = "00000000-0000-0000-0000-00000000001d".parse().unwrap();
    let overflow_run_id: RunId = "00000000-0000-0000-0000-00000000001e".parse().unwrap();
    let first_path = format!("/api/runners/jobs/{first_run_id}/claim");
    let first_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(first_path.as_str());
            then.status(400);
        })
        .await;
    let overflow_path = format!("/api/runners/jobs/{overflow_run_id}/claim");
    let overflow_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(overflow_path.as_str());
            then.status(400);
        })
        .await;
    let wakeups = Arc::new(PollWakeups::new(true));
    let provider = api_provider_for_test_with_claim_cooldown_capacity(
        server.base_url(),
        CancellationToken::new(),
        Arc::clone(&wakeups),
        1,
    );
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(first_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(overflow_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let first = provider.discover().await.unwrap();
    assert!(provider.claim(first).await.is_none());
    let overflow = provider.try_discover_ready().await.unwrap();
    let claim_started_at = tokio::time::Instant::now();
    let (claim, events) = capture_api_provider_events(provider.claim(overflow)).await;
    let claim_finished_at = tokio::time::Instant::now();
    assert!(claim.is_none());
    let event = captured_event(&events, "claim failed, candidate cooldown capacity reached");
    assert_eq!(event_field(event, "retry_scope"), "provider");
    assert_eq!(event_field(event, "retry_after_ms"), "5000");
    assert_eq!(event_field(event, "active_cooldowns"), "1");
    let deferred_poll_at = wakeups
        .snapshot()
        .deferred_poll_at
        .expect("saturation should defer HTTP polling");
    assert!(
        deferred_poll_at >= claim_started_at + POLL_FAST,
        "deferred polling should use at least the fast fallback from claim start"
    );
    assert!(
        deferred_poll_at <= claim_finished_at + POLL_FAST,
        "deferred polling should use at most the fast fallback from claim completion"
    );

    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(first_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(overflow_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;
    assert!(
        provider.try_discover_ready().await.is_none(),
        "saturation fallback should gate repeated direct claims"
    );

    first_mock.assert_calls_async(1).await;
    overflow_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn discover_returns_direct_candidate_that_arrives_during_poll() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let direct_run_id: RunId = "00000000-0000-0000-0000-00000000000a".parse().unwrap();
    let poll_run_id: RunId = "00000000-0000-0000-0000-00000000000b".parse().unwrap();
    let (poll_accepted_tx, poll_accepted_rx) = tokio::sync::oneshot::channel();
    let (release_first_poll_tx, release_first_poll_rx) = tokio::sync::oneshot::channel();
    let server_task = tokio::spawn(async move {
        let (mut first_socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut first_socket).await.unwrap();
        let _ = poll_accepted_tx.send(());
        release_first_poll_rx.await.unwrap();
        drop(first_socket);

        let (mut second_socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut second_socket).await.unwrap();
        write_poll_job_response(&mut second_socket, poll_run_id).await;
    });
    let provider = api_provider_for_test(
        api_url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    provider
        .record_poll_failure_at(
            PollReason::Immediate,
            &poll_transport_error(ApiFailureKind::Connect),
            Instant::now(),
        )
        .await;
    let provider_for_discover = Arc::clone(&provider);
    let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

    tokio::time::timeout(Duration::from_secs(1), poll_accepted_rx)
        .await
        .expect("poll should reach the server")
        .unwrap();
    push_direct_candidate_for_test(
        &provider,
        DirectJobCandidate::new(direct_run_id, crate::profile::DEFAULT_PROFILE.to_string()),
    )
    .await;

    let discovered = tokio::time::timeout(Duration::from_secs(1), discover_task)
        .await
        .expect("direct candidate should interrupt poll")
        .unwrap()
        .unwrap();
    assert_eq!(discovered.run_id(), direct_run_id);
    assert_eq!(
        discovered.discovery_source(),
        Some(JobDiscoverySource::Ably)
    );
    assert!(
        provider
            .poll_degradation_tracker
            .active_episode
            .lock()
            .await
            .is_some(),
        "direct candidate interruption must not reset HTTP poll state"
    );

    release_first_poll_tx.send(()).unwrap();
    let rediscovered = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("interrupted poll should be rearmed")
        .unwrap();
    assert_eq!(rediscovered.run_id(), poll_run_id);
    assert_eq!(
        rediscovered.discovery_source(),
        Some(JobDiscoverySource::Poll)
    );
    assert!(
        provider
            .poll_degradation_tracker
            .active_episode
            .lock()
            .await
            .is_none(),
        "successful HTTP poll with a job must reset poll state"
    );
    join_raw_http_task(server_task, "direct candidate sequence server").await;
}

#[tokio::test]
async fn discover_defers_job_return_when_deferred_poll_arrives_during_poll() {
    let first_run_id: RunId = "00000000-0000-0000-0000-000000000004".parse().unwrap();
    let second_run_id: RunId = "00000000-0000-0000-0000-000000000005".parse().unwrap();
    let (release_first_tx, release_first_rx) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitThenRespond {
            release: release_first_rx,
            response: poll_job_response(first_run_id),
        },
        RawHttpAction::Respond(poll_job_response(second_run_id)),
    ])
    .await;
    let api_url = server.url();
    let wakeups = Arc::new(PollWakeups::new(false));
    let provider = api_provider_for_test(api_url, CancellationToken::new(), Arc::clone(&wakeups));
    let provider_for_discover = Arc::clone(&provider);
    let discover_task = tokio::spawn(async move { provider_for_discover.discover().await });

    server.next_request("first deferred poll request").await;
    wakeups.request_deferred_poll_after_for_test(Duration::ZERO);
    release_first_tx.send(()).unwrap();

    let discovered = tokio::time::timeout(Duration::from_secs(1), discover_task)
        .await
        .expect("discover should retry after deferred poll")
        .unwrap()
        .unwrap();

    assert_eq!(discovered.run_id(), second_run_id);
    assert_eq!(discovered.profile_name(), "vm0/default");
    server.assert_finished().await;
}

#[tokio::test]
async fn api_client_poll_non_success_includes_status_and_body() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(503).body("poll unavailable");
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .poll(
            TEST_RUNNER_ID.parse().unwrap(),
            "default",
            &[],
            &[],
            PollReason::Immediate,
        )
        .await
        .unwrap_err();

    assert_api_status_error(
        err,
        "poll",
        StatusCode::SERVICE_UNAVAILABLE,
        "poll unavailable",
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_poll_decode_error_keeps_operation_label() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).body("not json");
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .poll(
            TEST_RUNNER_ID.parse().unwrap(),
            "default",
            &[],
            &[],
            PollReason::Immediate,
        )
        .await
        .unwrap_err();

    match err {
        ProviderError::Api(message) => assert!(
            message.starts_with("poll decode: "),
            "unexpected error: {message}"
        ),
        other => panic!("expected ProviderError::Api, got {other:?}"),
    }
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_not_found_is_unavailable() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(404);
        })
        .await;
    let api = api_client_for_server(&server);

    let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string());
    let outcome = api.claim_for_test(&candidate).await.unwrap();

    assert!(outcome.is_none());
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_conflict_is_api_status_error() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(409).body("unexpected conflict");
        })
        .await;
    let api = api_client_for_server(&server);

    let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string());
    let error = api.claim_for_test(&candidate).await.unwrap_err();

    let ClaimApiError::Request(error) = error else {
        panic!("expected ClaimApiError::Request");
    };
    assert_api_status_error(error, "claim", StatusCode::CONFLICT, "unexpected conflict");
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_truncated_body_remains_a_read_failure() {
    let run_id = RunId::from(uuid::Uuid::nil());
    let response =
        b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"runId\":".to_vec();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(response)]).await;
    let api = api_client_for_url(server.url());
    let error = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();
    assert!(matches!(error, ClaimApiError::ResponseRead(_)));
    assert!(
        server
            .next_request("truncated claim response")
            .await
            .contains(&format!("/api/runners/jobs/{run_id}/claim"))
    );
    server.assert_finished().await;
}

#[tokio::test]
async fn api_client_claim_empty_body_remains_a_decode_failure() {
    let run_id = RunId::from(uuid::Uuid::nil());
    let mut server =
        RawHttpTestServer::spawn(vec![RawHttpAction::Respond(http_response("200 OK", b""))]).await;
    let api = api_client_for_url(server.url());
    let error = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();
    assert!(matches!(error, ClaimApiError::ResponseDecode(_)));
    server.next_request("empty claim response").await;
    server.assert_finished().await;
}

#[tokio::test]
async fn api_client_claim_decode_error_includes_json_path_without_body_values() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "firewalls": [{
                    "kind": "secret-kind-value",
                    "name": "github"
                }],
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();

    let ClaimApiError::ResponseDecode(message) = err else {
        panic!("expected ClaimApiError::ResponseDecode");
    };
    assert!(
        message.contains("failed at firewalls[0].kind"),
        "decode error should include JSON path, got: {message}"
    );
    assert!(
        !message.contains("claim-sandbox-token"),
        "decode error must not include response body values, got: {message}"
    );
    assert!(
        !message.contains("secret-kind-value"),
        "decode error must not include invalid field values, got: {message}"
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_decode_error_redacts_values_that_look_like_field_errors() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "firewalls": [{
                    "kind": "missing field `secret-kind-value`",
                    "name": "github"
                }],
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();

    let ClaimApiError::ResponseDecode(message) = err else {
        panic!("expected ClaimApiError::ResponseDecode");
    };
    assert!(
        message.contains("failed at firewalls[0].kind"),
        "decode error should include JSON path, got: {message}"
    );
    assert!(
        !message.contains("claim-sandbox-token"),
        "decode error must not include response body values, got: {message}"
    );
    assert!(
        !message.contains("secret-kind-value"),
        "decode error must not include invalid field values, got: {message}"
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_decode_error_includes_missing_field_name() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "firewalls": [{
                    "name": "github",
                    "apis": []
                }],
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();

    let ClaimApiError::ResponseDecode(message) = err else {
        panic!("expected ClaimApiError::ResponseDecode");
    };
    assert!(
        message.contains("failed at firewalls[0]"),
        "decode error should include JSON path, got: {message}"
    );
    assert!(
        message.contains("missing field `kind`"),
        "decode error should include the missing field name, got: {message}"
    );
    assert!(
        !message.contains("claim-sandbox-token"),
        "decode error must not include response body values, got: {message}"
    );
    assert!(
        !message.contains("github"),
        "decode error must not include response body values, got: {message}"
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_decode_error_redacts_dynamic_map_keys() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let path = format!("/api/runners/jobs/{run_id}/claim");
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "environment": {
                    "OPENAI_API_KEY": 123
                },
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap_err();

    let ClaimApiError::ResponseDecode(message) = err else {
        panic!("expected ClaimApiError::ResponseDecode");
    };
    assert!(
        message.contains("failed at environment.<map-key>"),
        "decode error should include a redacted dynamic map path, got: {message}"
    );
    assert!(
        !message.contains("OPENAI_API_KEY"),
        "decode error must not include dynamic map keys, got: {message}"
    );
    assert!(
        !message.contains("claim-sandbox-token"),
        "decode error must not include response body values, got: {message}"
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_claim_decode_path_uses_current_codex_schema_fields() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let codex_error = claim_decode_error(
        &server,
        run_id,
        serde_json::json!({
            "runId": run_id,
            "prompt": "hello",
            "sandboxToken": "claim-sandbox-token",
            "cliAgentType": "claude_code",
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": [],
            "codexRuntimeConfig": {
                "providerId": 123,
                "name": "provider",
                "baseUrl": "https://api.example.com",
                "envKey": "OPENAI_API_KEY",
                "wireApi": "responses",
                "supportsWebsockets": false
            }
        }),
    )
    .await;
    assert!(
        codex_error.contains("failed at codexRuntimeConfig.providerId"),
        "unexpected Codex decode error: {codex_error}"
    );
    assert!(!codex_error.contains("claim-sandbox-token"));
}

#[tokio::test]
async fn api_client_claim_decode_path_redacts_policy_refresh_key_then_resumes_static_field() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let error = claim_decode_error(
        &server,
        run_id,
        serde_json::json!({
            "runId": run_id,
            "prompt": "hello",
            "sandboxToken": "claim-sandbox-token",
            "cliAgentType": "claude_code",
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": [],
            "networkPolicyRefreshes": {
                "secret-connector-name": {
                    "nextRefreshAt": 123
                }
            }
        }),
    )
    .await;

    assert!(
        error.contains("failed at networkPolicyRefreshes.<map-key>.nextRefreshAt"),
        "unexpected typed map decode error: {error}"
    );
    assert!(!error.contains("secret-connector-name"));
    assert!(!error.contains("claim-sandbox-token"));
}

#[tokio::test]
async fn api_client_claim_decode_path_redacts_colliding_dynamic_keys() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let error = claim_decode_error(
        &server,
        run_id,
        serde_json::json!({
            "runId": run_id,
            "prompt": "hello",
            "sandboxToken": "claim-sandbox-token",
            "cliAgentType": "claude_code",
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": [],
            "environment": {"prompt": 123}
        }),
    )
    .await;

    assert!(
        error.contains("failed at environment.<map-key>"),
        "unexpected colliding key decode error: {error}"
    );
    assert!(!error.contains("environment.prompt"));
    assert!(!error.contains("claim-sandbox-token"));
}

#[tokio::test]
async fn api_client_poll_decode_path_uses_poll_response_schema() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200).json_body(serde_json::json!({
                "job": {"runId": 123, "experimentalProfile": "vm0/default"}
            }));
        })
        .await;
    let api = api_client_for_server(&server);
    let runner_id = TEST_RUNNER_ID.parse().unwrap();
    let error = api
        .poll(runner_id, "default", &[], &[], PollReason::Immediate)
        .await
        .unwrap_err();
    let ProviderError::Api(error) = error else {
        panic!("expected ProviderError::Api");
    };

    assert!(
        error.contains("failed at job.runId"),
        "unexpected poll decode error: {error}"
    );
    mock.assert_async().await;
}

#[tokio::test]
async fn api_client_poll_body_read_error_excludes_full_url() {
    let response =
        b"HTTP/1.1 200 OK\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{\"job\":null}"
            .to_vec();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(response)]).await;
    let server_url = server.url();
    let api = api_client_for_url(server_url.clone());

    let error = api
        .poll(
            TEST_RUNNER_ID.parse().unwrap(),
            "default",
            &[crate::profile::DEFAULT_PROFILE.to_string()],
            &[],
            PollReason::Immediate,
        )
        .await
        .unwrap_err();
    let ProviderError::Api(message) = error else {
        panic!("expected ProviderError::Api");
    };

    assert!(
        message.contains("poll decode read body"),
        "unexpected body read error: {message}"
    );
    assert!(
        !message.contains(&server_url),
        "body read error must not include the full URL: {message}"
    );
    let request = server.next_request("truncated poll response request").await;
    assert!(request.contains(routes::runners::poll::POLL.path));
    server.assert_finished().await;
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
async fn api_client_poll_decode_rejects_trailing_response_body() {
    let server = MockServer::start_async().await;
    let mock = server
        .mock_async(|when, then| {
            when.method(POST).path(routes::runners::poll::POLL.path);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"job":null} trailing-response-value"#);
        })
        .await;
    let api = api_client_for_server(&server);

    let err = api
        .poll(
            TEST_RUNNER_ID.parse().unwrap(),
            "default",
            &[crate::profile::DEFAULT_PROFILE.to_string()],
            &[],
            PollReason::Immediate,
        )
        .await
        .unwrap_err();

    let ProviderError::Api(message) = err else {
        panic!("expected ProviderError::Api");
    };
    assert!(
        message.contains("poll decode: failed at <root>: trailing characters"),
        "decode error should reject trailing response content, got: {message}"
    );
    assert!(
        !message.contains("trailing-response-value"),
        "decode error must not include trailing response values, got: {message}"
    );
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

    let err = api
        .complete(
            "sandbox-token",
            &CompleteRequest {
                run_id: RunId::from(uuid::Uuid::nil()),
                exit_code: 1,
                failure_reason: None,
                error: Some("boom".to_string()),
                sandbox_id: None,
            },
        )
        .await
        .unwrap_err();

    assert_api_status_error(
        err,
        "complete",
        StatusCode::INTERNAL_SERVER_ERROR,
        "complete failed",
    );
    mock.assert_async().await;
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
async fn api_provider_claim_accepts_shared_current_response_fixture() {
    let server = MockServer::start_async().await;
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .body(RUNNER_CLAIM_RESPONSE_FIXTURE);
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("shared current claim response should decode");
    let claim_timing = claimed
        .api_claim_timing()
        .expect("successful API claim should retain timing");
    assert_eq!(
        claim_timing
            .response_first_body_chunk_wait_elapsed()
            .as_millis()
            + claim_timing
                .response_body_after_first_chunk_elapsed()
                .as_millis(),
        claim_timing.response_body_read_elapsed().as_millis()
    );
    assert!(
        claim_timing.request_elapsed()
            >= claim_timing.request_to_response_headers_elapsed()
                + claim_timing.response_body_read_elapsed()
                + claim_timing.response_decode_elapsed()
    );
    assert_eq!(
        claim_timing.response_attribution().body_size_bucket(),
        "lt_4_kib"
    );
    assert_eq!(
        claim_timing.response_attribution().content_encoding(),
        "absent"
    );
    let context = claimed.context();

    assert_eq!(context.run_id, run_id);
    assert_eq!(context.prompt, "Inspect the fixture repository");
    let bundles = &context.content_bundles;
    let instructions = bundles.instructions.as_ref().unwrap();
    instructions.validate().unwrap();
    assert_eq!(instructions.sha256, "a".repeat(64));
    assert_eq!(instructions.archive_bytes, 128);
    assert_eq!(bundles.skills.len(), 1);
    let skill = &bundles.skills[0];
    skill.reference().validate().unwrap();
    assert_eq!(skill.sha256, "b".repeat(64));
    assert_eq!(skill.archive_bytes, 256);
    assert_eq!(skill.mount_path, "/home/user/.codex/skills/fixture-skill");
    assert_eq!(
        context.append_system_prompt.as_deref(),
        Some("Use the shared contract fixture")
    );
    assert_eq!(
        context.vars.as_ref().unwrap()["FIXTURE_REGION"],
        "test-region"
    );
    assert_eq!(context.storage_manifest.as_ref().unwrap().storages.len(), 1);
    let native = context
        .native_continuation
        .as_ref()
        .expect("current API claims include native continuation intent");
    assert!(native.session_id.is_none());
    assert!(native.generation_run_id.is_none());
    assert!(native.recovery_prompt.is_none());
    assert!(context.cli_agent_session_id().is_none());
    assert_eq!(
        context.environment.as_ref().unwrap()["FIXTURE_MODEL"],
        "fixture-model"
    );
    assert_eq!(
        context.platform_environment["OKOU_AGENT_ID"],
        "fixture-agent-id"
    );
    assert_eq!(
        context.model_usage_provider.as_deref(),
        Some("fixture-model")
    );
    assert_eq!(
        context.model_usage_long_context_min_total_input_tokens,
        Some(272_001)
    );
    assert_eq!(
        context.secret_values.as_deref(),
        Some(["fixture-secret-value-not-real".to_string()].as_slice())
    );
    assert!(context.local_secret_env_keys.is_none());
    assert_eq!(
        context.secret_connector_metadata_map.as_ref().unwrap()["FIXTURE_API_KEY"]
            .source_user_id
            .as_deref(),
        Some("fixture-user-id")
    );
    assert_eq!(context.capture_network_bodies, Some(true));
    assert_eq!(context.user_timezone.as_deref(), Some("UTC"));
    assert_eq!(
        context.network_policies.as_ref().unwrap()["model-provider:fixture"].unknown_policy,
        "deny"
    );
    assert_eq!(
        context.billable_firewalls,
        ["model-provider:fixture".to_string()]
    );
    assert_eq!(
        context.codex_runtime_config.as_ref().unwrap().provider_id,
        "fixture_provider"
    );
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_client_claim_buckets_large_received_body_with_observed_identity_encoding() {
    let server = MockServer::start_async().await;
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let mut response: serde_json::Value =
        serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
    response["prompt"] = serde_json::Value::String("界".repeat(50_000));
    let serialized = serde_json::to_string(&response).unwrap();
    assert!((64 * 1024..256 * 1024).contains(&serialized.len()));
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .header("content-encoding", "identity")
                .body(serialized);
        })
        .await;
    let api = api_client_for_server(&server);

    let claimed = api
        .claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .unwrap()
        .expect("large synthetic claim response should decode");
    assert!(claimed.response_first_body_chunk_wait_elapsed <= claimed.response_body_read_elapsed);
    let attribution = claimed.response_attribution;
    assert_eq!(attribution.body_size_bucket(), "64_256_kib");
    assert_eq!(attribution.content_encoding(), "identity");
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_client_claim_attributes_first_and_remaining_body_chunks() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let mut context: Value = serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
    context["prompt"] = Value::String("synthetic chunked prompt".repeat(5000));
    let body = serde_json::to_vec(&context).unwrap();
    let first_len = 128;
    assert!((64 * 1024..256 * 1024).contains(&body.len()));
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (headers_sent_tx, headers_sent_rx) = oneshot::channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let (first_sent_tx, first_sent_rx) = oneshot::channel();
    let (release_tail_tx, release_tail_rx) = oneshot::channel();
    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await.unwrap();
        assert!(request.contains(&format!("/api/runners/jobs/{run_id}/claim")));
        socket.write_all(headers.as_bytes()).await.unwrap();
        headers_sent_tx.send(()).unwrap();
        release_first_rx.await.unwrap();
        socket.write_all(&body[..first_len]).await.unwrap();
        first_sent_tx.send(()).unwrap();
        release_tail_rx.await.unwrap();
        socket.write_all(&body[first_len..]).await.unwrap();
    });
    let api = api_client_for_url(url);
    let claim_task = tokio::spawn(async move {
        api.claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
    });
    headers_sent_rx.await.unwrap();
    assert!(
        !claim_task.is_finished(),
        "the claim must wait for body bytes"
    );
    release_first_tx.send(()).unwrap();
    first_sent_rx.await.unwrap();
    assert!(
        !claim_task.is_finished(),
        "the claim must wait for the rest of the body"
    );
    release_tail_tx.send(()).unwrap();
    let claimed = claim_task.await.unwrap().unwrap().unwrap();
    assert_eq!(
        claimed.context.prompt,
        "synthetic chunked prompt".repeat(5000)
    );
    assert_eq!(
        claimed.response_attribution.body_size_bucket(),
        "64_256_kib"
    );
    assert!(claimed.response_first_body_chunk_wait_elapsed < claimed.response_body_read_elapsed);
    join_raw_http_task(server_task, "split claim response server").await;
}

#[tokio::test]
async fn claim_body_reader_observes_first_chunk_before_collecting_tail() {
    let body = b"synthetic first chunk and delayed tail";
    let first_len = 16;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (headers_sent_tx, headers_sent_rx) = oneshot::channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let (release_tail_tx, release_tail_rx) = oneshot::channel();
    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await.unwrap();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        headers_sent_tx.send(()).unwrap();
        release_first_rx.await.unwrap();
        socket.write_all(&body[..first_len]).await.unwrap();
        release_tail_rx.await.unwrap();
        socket.write_all(&body[first_len..]).await.unwrap();
    });
    let resp = reqwest::Client::new().get(url).send().await.unwrap();
    headers_sent_rx.await.unwrap();
    let (first_observed_tx, first_observed_rx) = oneshot::channel();
    let read_task = tokio::spawn(async move {
        read_claim_response_body(resp, move || {
            first_observed_tx.send(()).unwrap();
        })
        .await
    });
    assert!(
        !read_task.is_finished(),
        "the reader must wait for the first chunk"
    );
    release_first_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), first_observed_rx)
        .await
        .expect("first chunk observation should not stall")
        .unwrap();
    assert!(
        !read_task.is_finished(),
        "the reader must still wait for the tail after observing the first chunk"
    );
    release_tail_tx.send(()).unwrap();
    let (collected, first_wait, total_read) = read_task.await.unwrap().unwrap();
    assert_eq!(collected.as_ref(), body);
    assert!(first_wait < total_read);
    join_raw_http_task(server_task, "first chunk and tail server").await;
}

#[tokio::test]
async fn api_client_claim_cancellation_drops_incomplete_body_read() {
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (first_sent_tx, first_sent_rx) = oneshot::channel();
    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request(&mut socket).await.unwrap();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n{\"runId\":",
            )
            .await
            .unwrap();
        first_sent_tx.send(()).unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
            .await
            .expect("cancelled claim should close the incomplete response");
        match read {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("cancelled claim should disconnect, got {other:?}"),
        }
    });
    let api = api_client_for_url(url);
    let claim_task = tokio::spawn(async move {
        api.claim_for_test(&JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
    });
    first_sent_rx.await.unwrap();
    assert!(!claim_task.is_finished());
    claim_task.abort();
    assert!(claim_task.await.unwrap_err().is_cancelled());
    join_raw_http_task(server_task, "cancelled claim response server").await;
}

#[tokio::test]
async fn api_provider_claim_accepts_canonical_storage_mount_response() {
    let server = MockServer::start_async().await;
    let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let mut response: serde_json::Value =
        serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
    // The claim response carries the storage manifest when mounts exist.
    response["storageManifest"] = serde_json::json!({
        "storageMounts": [
            {
                "name": "fixture-workspace",
                "storageId": "fixture-workspace-id",
                "versionId": "fixture-storage-version",
                "mountPath": "/home/user/workspace",
                "archiveUrl": "https://storage.fixture.invalid/workspace.tar.gz",
                "baselineCandidate": true
            },
            {
                "name": "fixture-artifacts",
                "storageId": "fixture-storage-id",
                "versionId": "fixture-artifact-version",
                "mountPath": "/home/user/artifacts",
                "archiveUrl": "https://storage.fixture.invalid/artifacts.tar.gz",
                "writeback": true
            }
        ]
    });
    let claim_mock = server
        .mock_async(move |when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200)
                .header("content-type", "application/json")
                .json_body(response);
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("canonical storage mount claim response should decode");
    let manifest = claimed.context().storage_manifest.as_ref().unwrap();

    assert_eq!(manifest.storages.len(), 1);
    assert_eq!(manifest.storages[0].name, "fixture-workspace");
    assert_eq!(
        manifest.storages[0].vas_version_id,
        "fixture-storage-version"
    );
    assert_eq!(manifest.artifacts.len(), 1);
    assert_eq!(manifest.artifacts[0].vas_storage_id, "fixture-storage-id");
    assert_eq!(
        manifest.artifacts[0].vas_version_id,
        "fixture-artifact-version"
    );
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn deferred_legacy_api_transient_claim_can_retry_without_release_protocol() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let transient = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(&claim_path)
                .header_missing("X-Pi-Deferred-Sandbox");
            then.status(503);
        })
        .await;
    let poll = server.mock_async(|when, then| {
            when.method(POST).path("/api/runners/poll");
            then.status(200).json_body(serde_json::json!({"job": {"runId": run_id, "experimentalProfile": crate::profile::DEFAULT_PROFILE}}));
        }).await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let candidate = tokio::time::timeout(Duration::from_secs(1), provider.discover())
        .await
        .expect("old API poll should decode")
        .expect("old API poll candidate");
    assert!(provider.claim(candidate).await.is_none());
    transient.assert_calls_async(1).await;
    transient.delete_async().await;
    let success = server.mock_async(|when, then| {
            when.method(POST).path(&claim_path).header_missing("X-Pi-Deferred-Sandbox");
            then.status(200).json_body(serde_json::json!({
                "runId": run_id, "prompt": "legacy retry", "sandboxToken": "test-token", "cliAgentType": "claude_code", "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []}, "connectorRuntimeTargets": []
            }));
        }).await;
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let discovery = tokio::time::timeout(Duration::from_secs(10), provider.discover())
        .with_subscriber(subscriber);
    tokio::pin!(discovery);
    advance_pending_discovery_retry(
        discovery.as_mut(),
        &captured,
        "poll: API returned candidate excluded by claim cooldown",
        CLAIM_TRANSIENT_COOLDOWN,
    )
    .await;
    let candidate = discovery
        .await
        .expect("bounded retry poll")
        .expect("retry candidate");
    let claimed = provider
        .claim(candidate)
        .await
        .expect("legacy retry must not require a v4 release endpoint");
    assert_eq!(claimed.context().prompt, "legacy retry");
    success.assert_calls_async(1).await;
    assert!(poll.calls_async().await >= 2);
}

#[tokio::test]
async fn api_provider_claim_accepts_current_minimal_response() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(claim_path.as_str())
                // The strict claim body only varies in its measured latency.
                .is_true(|request| {
                    let Ok(mut body) =
                        serde_json::from_slice::<serde_json::Value>(request.body_ref())
                    else {
                        return false;
                    };
                    let Some(telemetry) = body["telemetry"].as_object_mut() else {
                        return false;
                    };
                    let elapsed = telemetry.remove("jobDiscoveredToClaimRequestMs");
                    elapsed.as_ref().is_some_and(serde_json::Value::is_u64)
                        && body
                            == serde_json::json!({
                                "runnerIdentity": {
                                    "runnerId": TEST_RUNNER_ID,
                                    "heartbeatGeneration": TEST_HEARTBEAT_GENERATION,
                                },
                                "runnerHostname": "prod-1.aws.vm3.ai",
                                "capabilities": { "piModelConfigGenerations": [2, 3, 5] },
                                "telemetry": {},
                            })
                });
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "minimal response",
                "sandboxToken": "minimal-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let mut provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    Arc::get_mut(&mut provider)
        .expect("fresh test provider should not be shared")
        .runner_hostname = Some("prod-1.aws.vm3.ai".to_string());

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("current minimal claim response should decode");
    let context = claimed.context();

    assert_eq!(context.prompt, "minimal response");
    assert!(context.append_system_prompt.is_none());
    assert!(context.billable_firewalls.is_empty());
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_claim_attaches_active_input_source_for_thread_bound_pi() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "reuseKey": "thread:pi-active-input",
                "prompt": "steer the active Pi run",
                "sandboxToken": "pi-active-input-sandbox-token",
                "cliAgentType": "pi",
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("thread-bound Pi claim should succeed");

    assert!(matches!(
        claimed.active_input_source(),
        Some(ActiveInputSource::Api(_))
    ));
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_claim_ignores_additive_unknown_top_level_fields() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "response with additive field",
                "sandboxToken": "additive-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": [],
                "futureClaimMetadata": {"version": 2}
            }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("additive unknown claim fields should be ignored");

    assert_eq!(claimed.context().prompt, "response with additive field");
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_claim_ignores_api_local_secret_env_keys() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "attempt local secret trust",
                "sandboxToken": "local-secret-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": [],
                "localSecretEnvKeys": ["ANTHROPIC_API_KEY"]
            }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed = provider
        .claim(JobCandidate::new(
            run_id,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("API local secret metadata should be ignored");

    assert!(claimed.context().local_secret_env_keys.is_none());
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn cancellation_reconciliation_starts_only_after_valid_claim_without_active_input() {
    for ably_connected in [false, true] {
        let run_id = RunId::new_v4();
        let claim = serde_json::json!({
            "runId": run_id,
            "prompt": "hello",
            "sandboxToken": "claim-sandbox-token",
            "cliAgentType": "claude_code",
            "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []},
            "connectorRuntimeTargets": [],
        });
        let (release, wait) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::WaitThenRespond {
                release: wait,
                response: json_response("200 OK", &claim.to_string()),
            },
            RawHttpAction::Respond(json_response(
                "200 OK",
                &serde_json::json!({
                    "protocolVersion": 1, "runId": run_id, "state": "gone",
                })
                .to_string(),
            )),
        ])
        .await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(ably_connected)),
        );
        let registration = provider.cancel_tokens.register(run_id).await.unwrap();
        let claiming = provider.clone();
        let claim_task = tokio::spawn(async move {
            claiming
                .claim(JobCandidate::new(
                    run_id,
                    crate::profile::DEFAULT_PROFILE.into(),
                ))
                .await
        });
        let request = server.next_request("claim before eligibility").await;
        assert!(request.starts_with(&format!(
            "POST /api/runners/jobs/{run_id}/claim?workflowSkills=2 "
        )));
        assert!(!registration.is_cancelled());
        release.send(()).unwrap();
        let claimed = claim_task.await.unwrap().unwrap();
        assert!(claimed.active_input_source().is_none());
        let request = server.next_request("claim-scoped cancellation read").await;
        assert!(request.starts_with(&format!("GET /api/runners/runs/{run_id}/cancellation?")));
        assert!(request.contains("authorization: Bearer claim-sandbox-token"));
        assert!(request.contains("runnerGroup=default"));
        assert!(request.contains(&format!("runnerId={TEST_RUNNER_ID}")));
        assert!(request.contains(&format!("heartbeatGeneration={TEST_HEARTBEAT_GENERATION}")));
        tokio::time::timeout(
            Duration::from_secs(5),
            registration.handle().signals().hard().cancelled(),
        )
        .await
        .unwrap();
        registration.unregister().await;
        provider.shutdown().await;
        server.assert_finished().await;
    }
}

#[tokio::test]
async fn cancellation_reconciliation_never_attaches_to_a_replacement_after_claim() {
    let run_id = RunId::new_v4();
    let (release, wait) = tokio::sync::oneshot::channel();
    let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: wait,
            response: json_response("200 OK", &serde_json::json!({
                "runId": run_id, "prompt": "hello", "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code", "platformEnvironment": {},
            "contentBundles": {"format": "tar-gzip-v1", "skills": []}, "connectorRuntimeTargets": [],
            }).to_string()),
        }]).await;
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let original = provider.cancel_tokens.register(run_id).await.unwrap();
    let claiming = provider.clone();
    let claim_task = tokio::spawn(async move {
        claiming
            .claim(JobCandidate::new(
                run_id,
                crate::profile::DEFAULT_PROFILE.into(),
            ))
            .await
    });
    server.next_request("pending claim").await;
    original.unregister().await;
    let successor = provider.cancel_tokens.register(run_id).await.unwrap();
    release.send(()).unwrap();
    assert!(claim_task.await.unwrap().is_some());
    provider.shutdown().await;
    assert!(!successor.is_cancelled());
    assert!(successor.unregister().await);
    server.assert_finished().await;
}

#[tokio::test]
async fn cancellation_reconciliation_rejects_failed_unavailable_and_invalid_claims() {
    let server = MockServer::start_async().await;
    let run_id = RunId::new_v4();
    let cancellation = server
        .mock_async(|when, then| {
            when.method(httpmock::Method::GET)
                .path(format!("/api/runners/runs/{run_id}/cancellation"));
            then.status(200)
                .json_body(serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}));
        })
        .await;
    let cases = [
        (409, "unavailable".to_string()),
        (401, "unauthorized".to_string()),
        (500, "service unavailable".to_string()),
        (200, "malformed".to_string()),
        (
            200,
            serde_json::json!({
                "runId":RunId::new_v4(),"prompt":"hello","sandboxToken":"test-token",
                "cliAgentType":"claude_code","platformEnvironment":{},"connectorRuntimeTargets":[],
            })
            .to_string(),
        ),
    ];
    for (status, body) in cases {
        let claim = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/jobs/{run_id}/claim"));
                then.status(status).body(body);
            })
            .await;
        let provider = api_provider_for_test(
            server.base_url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let registration = provider.cancel_tokens.register(run_id).await.unwrap();
        assert!(
            provider
                .claim(JobCandidate::new(
                    run_id,
                    crate::profile::DEFAULT_PROFILE.into()
                ))
                .await
                .is_none()
        );
        provider.shutdown().await;
        assert!(!registration.is_cancelled());
        registration.unregister().await;
        claim.delete_async().await;
    }
    cancellation.assert_calls_async(0).await;
}

#[tokio::test]
async fn api_provider_claim_rejects_run_id_mismatch() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let context_run_id = RunId::new_v4();
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": context_run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string());
    let (claimed, events) = capture_api_provider_events(provider.claim(candidate)).await;

    assert!(claimed.is_none());
    let event = captured_event(&events, "claim failed, candidate cooling down");
    assert_eq!(event_field(event, "failure_class"), "response_invariant");
    assert_eq!(
        event_field(event, "response_run_id"),
        context_run_id.to_string()
    );
    assert_eq!(event_field(event, "retry_after_ms"), "30000");
    claim_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_claim_carries_sandbox_token_to_completion() {
    let server = MockServer::start_async().await;
    let run_id = RunId::from(uuid::Uuid::nil());
    let claim_path = format!("/api/runners/jobs/{run_id}/claim");
    let claim_mock = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let complete_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer claim-sandbox-token");
            then.status(200);
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let candidate = JobCandidate::new(run_id, crate::profile::DEFAULT_PROFILE.to_string());
    let (claimed, events) = capture_api_provider_events(provider.claim(candidate)).await;
    let claimed = claimed.expect("claim should succeed");
    let event = captured_event(&events, "job claimed");
    assert_eq!(
        event_field(event, "runner_id"),
        "550e8400-e29b-41d4-a716-446655440000"
    );
    assert_eq!(event_field(event, "heartbeat_generation"), "7");
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    assert_eq!(context.sandbox_token, "claim-sandbox-token");
    assert!(active_input_source.is_none());

    provider
        .complete(complete_request(run_id), completion_auth)
        .await;

    claim_mock.assert_calls_async(1).await;
    complete_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn api_provider_claimed_jobs_complete_out_of_order_with_their_own_tokens() {
    let server = MockServer::start_async().await;
    let run_id_a: RunId = "00000000-0000-0000-0000-000000000101".parse().unwrap();
    let run_id_b: RunId = "00000000-0000-0000-0000-000000000102".parse().unwrap();
    let claim_path_a = format!("/api/runners/jobs/{run_id_a}/claim");
    let claim_path_b = format!("/api/runners/jobs/{run_id_b}/claim");
    let claim_mock_a = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path_a.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id_a,
                "prompt": "first",
                "sandboxToken": "sandbox-token-a",
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let claim_mock_b = server
        .mock_async(|when, then| {
            when.method(POST).path(claim_path_b.as_str());
            then.status(200).json_body(serde_json::json!({
                "runId": run_id_b,
                "prompt": "second",
                "sandboxToken": "sandbox-token-b",
                "cliAgentType": "claude_code",
                "billableFirewalls": [],
                "platformEnvironment": {},
                "contentBundles": {"format": "tar-gzip-v1", "skills": []},
                "connectorRuntimeTargets": []
            }));
        })
        .await;
    let complete_mock_a = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer sandbox-token-a")
                .json_body(serde_json::json!({
                    "runId": run_id_a,
                    "exitCode": 0
                }));
            then.status(200);
        })
        .await;
    let complete_mock_b = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(routes::webhooks::agent::complete::COMPLETE.path)
                .header("authorization", "Bearer sandbox-token-b")
                .json_body(serde_json::json!({
                    "runId": run_id_b,
                    "exitCode": 0
                }));
            then.status(200);
        })
        .await;
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

    let claimed_a = provider
        .claim(JobCandidate::new(
            run_id_a,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("first claim should succeed");
    let claimed_b = provider
        .claim(JobCandidate::new(
            run_id_b,
            crate::profile::DEFAULT_PROFILE.to_string(),
        ))
        .await
        .expect("second claim should succeed");
    let (context_a, completion_auth_a, active_input_source_a) = claimed_a.into_parts();
    let (context_b, completion_auth_b, active_input_source_b) = claimed_b.into_parts();
    assert!(active_input_source_a.is_none());
    assert!(active_input_source_b.is_none());

    provider
        .complete(complete_request(context_b.run_id), completion_auth_b)
        .await;
    provider
        .complete(complete_request(context_a.run_id), completion_auth_a)
        .await;

    claim_mock_a.assert_calls_async(1).await;
    claim_mock_b.assert_calls_async(1).await;
    complete_mock_a.assert_calls_async(1).await;
    complete_mock_b.assert_calls_async(1).await;
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
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

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
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

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
    let provider = api_provider_for_test(
        server.base_url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

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
    let provider = api_provider_for_test(
        api_url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
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
    assert_eq!(event_field(event, "attempt"), "1");
    assert_eq!(event_field(event, "max_attempts"), "3");
    assert_eq!(event_field(event, "will_retry"), "false");
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
            let provider = api_provider_for_test(
                server.url(),
                CancellationToken::new(),
                Arc::new(PollWakeups::new(false)),
            );
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
                            && event.fields.get("message").is_some_and(|message| {
                                message == "completion report failed, retrying"
                            })
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
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
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
                            .is_some_and(|message| message == "completion report failed, retrying")
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
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
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
                            .is_some_and(|message| message == "completion report failed, retrying")
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
        let retry_event = captured_event(&events, "completion report failed, retrying");
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
            let final_event = captured_event(&events, "failed to report completion after retry");
            assert_eq!(final_event.level, Level::ERROR);
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
    let provider = api_provider_for_test(
        api_url,
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );
    let ((), events) = capture_api_provider_events(provider.complete(
        complete_request(run_id),
        CompletionAuth::sandbox_token(run_id, "invalid\nheader".to_string()),
    ))
    .await;

    let event = captured_event(&events, "failed to report completion");
    assert_eq!(event.level, Level::ERROR);
    assert_eq!(event_field(event, "attempt"), "1");
    assert_eq!(event_field(event, "will_retry"), "false");
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
    let provider = api_provider_for_test(
        server.url(),
        CancellationToken::new(),
        Arc::new(PollWakeups::new(false)),
    );

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
                        .is_some_and(|message| message == "completion report failed, retrying")
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
        3,
        "three failed requests should produce three provider events: {events:#?}"
    );
    let retry_events: Vec<_> = events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "completion report failed, retrying")
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

    let final_event = captured_event(&events, "failed to report completion after retry");
    assert_eq!(final_event.level, Level::ERROR);
    assert_eq!(event_field(final_event, "attempt"), "3");
    assert_eq!(event_field(final_event, "will_retry"), "false");
    assert_eq!(event_field(final_event, "status"), "500");
    assert_eq!(event_field(final_event, "failure_kind"), "http_status");
}
