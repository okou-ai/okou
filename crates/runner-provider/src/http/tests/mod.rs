use api_contracts::generated::routes;
use reqwest::header::AUTHORIZATION;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket};

use super::*;
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer};

fn http_client(api_url: &str) -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url: api_url.to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: RUNNER_CLIENT_VERSION,
    })
    .unwrap()
}

fn header_value(request: &reqwest::Request, name: &str) -> String {
    request
        .headers()
        .get(name)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string()
}

fn api_transport_error(error: ProviderError) -> ApiTransportError {
    match error {
        ProviderError::ApiTransport(error) => *error,
        other => panic!("expected ProviderError::ApiTransport, got {other:?}"),
    }
}

#[test]
fn request_route_builds_request_from_generated_route() {
    let http = http_client("https://api.vm0.dev/");

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().as_str(),
        "https://api.vm0.dev/api/webhooks/agent/telemetry"
    );
    assert_eq!(
        request
            .headers()
            .get(AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap(),
        "Bearer sandbox-token"
    );
}

#[test]
fn new_normalizes_api_url_before_building_routes() {
    let http = http_client("https://api.vm0.dev/prefix/");

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(
        request.url().as_str(),
        "https://api.vm0.dev/prefix/api/webhooks/agent/telemetry"
    );
}

#[test]
fn new_rejects_api_url_with_sensitive_components() {
    let result = HttpClient::new(HttpClientConfig {
        api_url: "https://user:pass@api.vm0.dev?token=secret".to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: RUNNER_CLIENT_VERSION,
    });
    let error = match result {
        Ok(_) => panic!("expected invalid API URL to be rejected"),
        Err(error) => error,
    };
    let message = error.to_string();

    assert!(message.contains("server.url"), "got: {message}");
    assert!(message.contains("credentials"), "got: {message}");
    assert!(
        !message.contains("user:pass") && !message.contains("token=secret"),
        "error should not echo sensitive URL components: {message}"
    );
}

#[test]
fn new_rejects_cleartext_remote_api_url() {
    let result = HttpClient::new(HttpClientConfig {
        api_url: "http://api.vm0.dev".to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: RUNNER_CLIENT_VERSION,
    });
    let error = match result {
        Ok(_) => panic!("expected cleartext remote API URL to be rejected"),
        Err(error) => error,
    };
    let message = error.to_string();

    assert!(message.contains("server.url"), "got: {message}");
    assert!(message.contains("https"), "got: {message}");
    assert!(!message.contains("api.vm0.dev"), "got: {message}");
}

#[test]
fn request_resolved_route_builds_request_from_generated_route() {
    let http = http_client("https://api.vm0.dev/");

    let request = http
        .request_resolved_route(
            routes::runners::jobs::by_id::claim::route(
                routes::runners::jobs::by_id::claim::Params {
                    id: "550e8400-e29b-41d4-a716-446655440000",
                },
            ),
            "runner-token",
        )
        .build()
        .unwrap();

    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        request.url().as_str(),
        "https://api.vm0.dev/api/runners/jobs/550e8400-e29b-41d4-a716-446655440000/claim"
    );
}

#[test]
fn remote_authority_request_keeps_runner_authentication_headers() {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "https://api.vm0.dev/".into(),
        vercel_bypass: Some("bypass-secret".into()),
        client_session_id: "remote-session".into(),
        runner_version: RUNNER_CLIENT_VERSION,
    })
    .unwrap();
    let route = routes::runners::runs::by_run_id::ssh::resolve::route(
        routes::runners::runs::by_run_id::ssh::resolve::Params { run_id: "test-run" },
    );
    let request = http
        .json_request(
            route,
            "fleet-secret",
            &serde_json::json!({"connectionId":"id"}),
        )
        .unwrap();

    assert_eq!(request.method(), reqwest::Method::POST);
    assert_eq!(
        header_value(&request, "authorization"),
        "Bearer fleet-secret"
    );
    assert_eq!(
        header_value(&request, VERCEL_BYPASS_HEADER),
        "bypass-secret"
    );
    assert_eq!(
        header_value(&request, CLIENT_SESSION_ID_HEADER),
        "remote-session"
    );
    assert_eq!(
        header_value(&request, CLIENT_TYPE_HEADER),
        CLIENT_TYPE_RUNNER
    );
    assert!(!header_value(&request, CLIENT_VERSION_HEADER).is_empty());
    assert!(Uuid::parse_str(&header_value(&request, CLIENT_REQUEST_ID_HEADER)).is_ok());
    assert_eq!(header_value(&request, "content-type"), "application/json");
}

#[test]
fn request_includes_vercel_bypass_header_when_configured() {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "https://api.vm0.dev/".to_string(),
        vercel_bypass: Some("bypass-secret".to_string()),
        client_session_id: "runner-session-test".to_string(),
        runner_version: RUNNER_CLIENT_VERSION,
    })
    .unwrap();

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(
        request
            .headers()
            .get(VERCEL_BYPASS_HEADER)
            .unwrap()
            .to_str()
            .unwrap(),
        "bypass-secret"
    );
}

#[test]
fn request_excludes_vercel_bypass_header_when_not_configured() {
    let http = http_client("https://api.vm0.dev/");

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert!(request.headers().get(VERCEL_BYPASS_HEADER).is_none());
}

#[test]
fn request_includes_client_headers() {
    let http = http_client("https://api.vm0.dev/");

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(
        header_value(&request, CLIENT_VERSION_HEADER),
        RUNNER_CLIENT_VERSION
    );
    assert_eq!(
        header_value(&request, CLIENT_TYPE_HEADER),
        CLIENT_TYPE_RUNNER
    );
    assert_eq!(
        header_value(&request, CLIENT_SESSION_ID_HEADER),
        "runner-session-test"
    );
    Uuid::parse_str(&header_value(&request, CLIENT_REQUEST_ID_HEADER)).unwrap();
}

#[test]
fn request_uses_the_callers_runner_version_instead_of_the_library_version() {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "https://api.vm0.dev".to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: "9.8.7",
    })
    .unwrap();
    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(http.runner_version(), "9.8.7");
    assert_eq!(header_value(&request, CLIENT_VERSION_HEADER), "9.8.7");
}

#[test]
fn build_with_context_matches_generated_headers_and_excludes_sensitive_request_data() {
    let http = http_client("https://api.vm0.dev/");

    let (request, context) = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .json(&serde_json::json!({"secret": "body-secret"}))
        .build_with_context_for_test("telemetry")
        .unwrap();

    assert_eq!(context.endpoint_label, "telemetry");
    assert_eq!(context.method, "POST");
    assert_eq!(context.host, "api.vm0.dev");
    assert_eq!(context.path, "/api/webhooks/agent/telemetry");
    assert_eq!(
        context.client_request_id,
        header_value(&request, CLIENT_REQUEST_ID_HEADER)
    );
    assert_eq!(context.client_session_id, "runner-session-test");
    assert_eq!(context.client_version, RUNNER_CLIENT_VERSION);

    let context_debug = format!("{context:?}");
    assert!(
        !context_debug.contains("sandbox-token"),
        "context should not include authorization token: {context_debug}"
    );
    assert!(
        !context_debug.contains("body-secret"),
        "context should not include request body: {context_debug}"
    );
    assert!(
        !context.path.contains('?'),
        "context path should exclude query strings"
    );
}

#[test]
fn build_with_context_formats_ipv6_host_with_port_as_authority() {
    let http = http_client("http://[::1]:8080/base/");

    let (_, context) = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build_with_context_for_test("telemetry")
        .unwrap();

    assert_eq!(context.host, "[::1]:8080");
    assert_eq!(context.path, "/base/api/webhooks/agent/telemetry");
}

#[tokio::test]
async fn send_timeout_returns_structured_api_transport_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let server_task = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let error = http_client(&api_url)
        .request_route(routes::runners::heartbeat::HEARTBEAT, "runner-token")
        .timeout(Duration::from_millis(10))
        .json(&serde_json::json!({"token": "body-token"}))
        .send("heartbeat")
        .await
        .unwrap_err();
    server_task.abort();
    let _ = server_task.await;
    let error = api_transport_error(error);

    assert_eq!(error.request.endpoint_label, "heartbeat");
    assert_eq!(error.request.method, "POST");
    assert_eq!(
        error.request.path,
        routes::runners::heartbeat::HEARTBEAT.path
    );
    assert_eq!(error.failure_kind, ApiFailureKind::Timeout);
    assert_eq!(error.failure_kind.as_str(), "timeout");
    assert_eq!(error.failure_cause, ApiTransportCause::Timeout);
    assert!(
        !error.summary.contains(&api_url),
        "summary should not include full URL: {}",
        error.summary
    );
    assert!(
        !error.summary.contains("body-token") && !error.summary.contains("runner-token"),
        "summary should not include token or body: {}",
        error.summary
    );
}

#[tokio::test]
async fn send_connection_refused_exposes_stable_io_cause() {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let api_url = format!("http://{}", socket.local_addr().unwrap());

    let error = http_client(&api_url)
        .request_route(routes::runners::heartbeat::HEARTBEAT, "runner-token")
        .send("heartbeat")
        .await
        .unwrap_err();
    let error = api_transport_error(error);

    assert_eq!(error.failure_kind, ApiFailureKind::Connect);
    assert_eq!(error.failure_cause, ApiTransportCause::ConnectionRefused);
    assert!(error.to_string().contains("cause=connection_refused"));
}

#[tokio::test]
async fn send_premature_http_disconnect_exposes_stable_protocol_cause() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;

    let error = http_client(&server.url())
        .request_route(routes::runners::heartbeat::HEARTBEAT, "runner-token")
        .json(&serde_json::json!({}))
        .send("heartbeat")
        .await
        .unwrap_err();
    server.assert_finished().await;
    let error = api_transport_error(error);

    assert_eq!(error.failure_kind, ApiFailureKind::Request);
    assert_eq!(
        error.failure_cause,
        ApiTransportCause::HttpIncompleteMessage
    );
}

#[tokio::test]
async fn send_invalid_tls_peer_does_not_infer_tls_from_error_text() {
    const QUERY_SECRET: &str = "query-sensitive-value";
    const BODY_SECRET: &str = "body-sensitive-value";
    const BEARER_SECRET: &str = "bearer-sensitive-value";
    const PEER_BYTES: &str = "peer-sensitive-value";

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "https://{}/private?credential={QUERY_SECRET}",
        listener.local_addr().unwrap()
    );
    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut first_client_byte = [0_u8; 1];
        socket.read_exact(&mut first_client_byte).await.unwrap();
        socket.write_all(PEER_BYTES.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });

    let error = http_client("http://127.0.0.1")
        .authenticated_request(reqwest::Method::POST, url, BEARER_SECRET)
        .json(&serde_json::json!({"secret": BODY_SECRET}))
        .send("tls diagnostic")
        .await
        .unwrap_err();
    server_task.await.unwrap();
    let error = api_transport_error(error);

    assert_eq!(error.failure_cause, ApiTransportCause::Io);
    assert_eq!(error.request.path, "/private");
    let diagnostic = format!("{error:?} {error}");
    for secret in [QUERY_SECRET, BODY_SECRET, BEARER_SECRET, PEER_BYTES] {
        assert!(
            !diagnostic.contains(secret),
            "transport diagnostic should exclude sensitive request and peer data: {diagnostic}"
        );
    }
}

#[test]
fn sanitize_api_error_summary_collapses_whitespace_and_caps_output() {
    let summary = format!(
        "connect\nfailed\t{}",
        "x".repeat(API_ERROR_SUMMARY_MAX_CHARS * 2)
    );

    let sanitized = sanitize_api_error_summary(summary);

    assert!(sanitized.starts_with("connect failed "));
    assert!(sanitized.ends_with(API_ERROR_SUMMARY_TRUNCATION_MARKER));
    assert!(sanitized.chars().count() <= API_ERROR_SUMMARY_MAX_CHARS);
    assert!(!sanitized.contains('\n'));
    assert!(!sanitized.contains('\t'));
}

#[test]
fn request_reuses_session_id_and_generates_fresh_request_id() {
    let http = http_client("https://api.vm0.dev/");

    let first = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();
    let second = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .build()
        .unwrap();

    assert_eq!(
        header_value(&first, CLIENT_SESSION_ID_HEADER),
        header_value(&second, CLIENT_SESSION_ID_HEADER)
    );
    assert_ne!(
        header_value(&first, CLIENT_REQUEST_ID_HEADER),
        header_value(&second, CLIENT_REQUEST_ID_HEADER)
    );
}

#[test]
fn generated_client_headers_override_caller_headers() {
    let http = http_client("https://api.vm0.dev/");

    let request = http
        .request_route(routes::webhooks::agent::telemetry::SEND, "sandbox-token")
        .header_for_test(CLIENT_VERSION_HEADER, "caller-version")
        .header_for_test(CLIENT_TYPE_HEADER, "caller-type")
        .header_for_test(CLIENT_SESSION_ID_HEADER, "caller-session")
        .header_for_test(CLIENT_REQUEST_ID_HEADER, "caller-request")
        .build()
        .unwrap();

    assert_eq!(
        header_value(&request, CLIENT_VERSION_HEADER),
        RUNNER_CLIENT_VERSION
    );
    assert_eq!(
        header_value(&request, CLIENT_TYPE_HEADER),
        CLIENT_TYPE_RUNNER
    );
    assert_eq!(
        header_value(&request, CLIENT_SESSION_ID_HEADER),
        "runner-session-test"
    );
    assert_ne!(
        header_value(&request, CLIENT_REQUEST_ID_HEADER),
        "caller-request"
    );
}

#[test]
fn external_get_excludes_client_headers() {
    let http = http_client("https://api.vm0.dev/");

    let request = http.get("https://blob.example/history").build().unwrap();

    assert!(request.headers().get(CLIENT_VERSION_HEADER).is_none());
    assert!(request.headers().get(CLIENT_TYPE_HEADER).is_none());
    assert!(request.headers().get(CLIENT_SESSION_ID_HEADER).is_none());
    assert!(request.headers().get(CLIENT_REQUEST_ID_HEADER).is_none());
}
