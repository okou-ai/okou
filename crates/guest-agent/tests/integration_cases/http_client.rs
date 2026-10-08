use crate::support::*;
use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_GUEST_AGENT;
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde::{Serialize, Serializer};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use uuid::Uuid;

const RESPONSE_LIMIT_TEST_TIMEOUT: Duration = Duration::from_secs(5);
const EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;
const EXPECTED_ERROR_RESPONSE_BODY_LIMIT_BYTES: usize = 64 * 1024;
const EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_DIAGNOSTIC: &str =
    "API response body exceeds the configured limit";
const EXPECTED_ERROR_RESPONSE_BODY_LIMIT_DIAGNOSTIC: &str =
    "HTTP 400 Bad Request: API error response body exceeds the configured limit";

struct HeldOpenResponseServer {
    base_url: String,
    release: oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl HeldOpenResponseServer {
    async fn start(response_parts: Vec<Vec<u8>>) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (release, release_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            read_raw_request(&mut socket).await?;
            for part in response_parts {
                socket.write_all(&part).await?;
            }
            let _ = release_rx.await;
            Ok(())
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            release,
            handle,
        })
    }

    async fn finish(self) {
        let _ = self.release.send(());
        assert!(matches!(self.handle.await, Ok(Ok(()))));
    }
}

pub(super) async fn read_raw_request(socket: &mut TcpStream) -> std::io::Result<()> {
    let mut request = Vec::new();
    let header_end = loop {
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await?;
        assert!(read > 0, "connection closed before request headers");
        let bytes = chunk
            .get(..read)
            .ok_or_else(|| std::io::Error::other("invalid request read length"))?;
        request.extend_from_slice(bytes);
    };
    let header_bytes = request
        .get(..header_end)
        .ok_or_else(|| std::io::Error::other("invalid request header length"))?;
    let headers = std::str::from_utf8(header_bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let content_length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>())
        .transpose()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
        .unwrap_or_default();
    let body_end = header_end + 4 + content_length;
    while request.len() < body_end {
        let mut chunk = [0_u8; 1024];
        let read = socket.read(&mut chunk).await?;
        assert!(read > 0, "connection closed before request body");
        let bytes = chunk
            .get(..read)
            .ok_or_else(|| std::io::Error::other("invalid request read length"))?;
        request.extend_from_slice(bytes);
    }
    Ok(())
}

fn padded_json_body(total_bytes: usize, prefix: &str, suffix: &str) -> String {
    assert!(prefix.len() + suffix.len() <= total_bytes);
    let mut body = String::with_capacity(total_bytes);
    body.push_str(prefix);
    body.extend(std::iter::repeat_n(
        'x',
        total_bytes - prefix.len() - suffix.len(),
    ));
    body.push_str(suffix);
    assert_eq!(body.len(), total_bytes);
    body
}

struct CountingJsonBody<'a> {
    serializations: &'a AtomicUsize,
}

impl Serialize for CountingJsonBody<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.serializations.fetch_add(1, Ordering::SeqCst);
        json!({ "request": "body" }).serialize(serializer)
    }
}

// =========================================================================
// post_json core
// =========================================================================

#[tokio::test]
async fn post_json_success_json_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/success");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({"status": "ok"}));
    });

    let url = api.url("/test/success");
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    let val = result.unwrap().unwrap();
    assert_eq!(val["status"], "ok");
}

#[tokio::test]
async fn for_config_uses_enabled_client_when_api_token_is_set()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let config = shared_guest_config()?;

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/for-config")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200).json_body(json!({"status": "ok"}));
    });

    let url = api.url("/test/for-config");
    let result = guest_agent::http::HttpClient::for_config(&config)?
        .post_json(&url, &json!({}), 1)
        .await?;

    mock.assert_calls_async(1).await;
    assert_eq!(result.unwrap()["status"], "ok");
    Ok(())
}

#[tokio::test]
async fn for_config_uses_config_api_url_for_webhook_routes()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let config = shared_guest_config()?;
    let paths = shared_guest_paths();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer test-token-abc123")
            .header("x-vercel-protection-bypass", "test-bypass-value")
            .json_body_includes(r#"{"runId": "test-run-001"}"#)
            .body_includes(r#""sequenceNumber":7"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test", "data": "env route"});
    guest_agent::events::send_event_for_config(
        &guest_agent::http::HttpClient::for_config(&config)?,
        event,
        7,
        &masker,
        &config,
        &paths,
    )
    .await?;

    mock.assert_calls_async(1).await;
    Ok(())
}

#[tokio::test]
async fn post_json_success_empty_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/empty");
        then.status(200);
    });

    let url = api.url("/test/empty");
    let result = http_client!()
        .post_json(&url, &json!({"key": "val"}), 1)
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.unwrap().is_none());
}

#[tokio::test]
async fn post_json_retry_then_succeed() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/retry-succeed")
            .header("content-type", "application/json")
            .json_body(json!({ "request": "body" }));
        then.respond_with(retry_then_response(
            2,
            json_http_response(200, json!({"recovered": true})),
        ));
    });

    let serializations = AtomicUsize::new(0);
    let body = CountingJsonBody {
        serializations: &serializations,
    };
    let url = api.url("/test/retry-succeed");
    let result = http_client!().post_json(&url, &body, 3).await;

    let val = result.unwrap().unwrap();
    assert_eq!(val["recovered"], true);
    mock.assert_calls_async(3).await;
    assert_eq!(serializations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn post_json_retry_exhausted() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/exhaust");
        then.status(500);
    });

    let url = api.url("/test/exhaust");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(3).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn post_json_accepts_response_at_success_body_limit() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let body = padded_json_body(
        EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES,
        "{\"value\":\"",
        "\"}",
    );

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/exact-response-limit");
        then.status(200)
            .header("Content-Type", "application/json")
            .body(body);
    });

    let url = api.url("/test/exact-response-limit");
    let response = http_client!()
        .post_json(&url, &json!({}), 1)
        .await
        .unwrap()
        .unwrap();

    mock.assert_calls_async(1).await;
    assert_eq!(
        response["value"].as_str().unwrap().len(),
        EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES - "{\"value\":\"".len() - "\"}".len(),
    );
}

#[tokio::test]
async fn post_json_rejects_declared_response_over_success_body_limit() {
    let response_head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES + 1,
    );
    let server = HeldOpenResponseServer::start(vec![response_head.into_bytes()])
        .await
        .unwrap();
    let client = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "authorization-secret",
        "",
        "response-limit-run",
        Duration::ZERO,
    )
    .unwrap();
    let url = format!("{}/test?query-secret", server.base_url);

    let result = tokio::time::timeout(
        RESPONSE_LIMIT_TEST_TIMEOUT,
        client.post_json(&url, &json!({}), 1),
    )
    .await
    .expect("client waited for an oversized declared response");

    let Err(AgentError::Http(message)) = result else {
        panic!("expected response body limit error");
    };
    assert_eq!(message, EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_DIAGNOSTIC);
    server.finish().await;
}

#[tokio::test]
async fn post_json_rejects_chunked_response_over_success_body_limit() {
    let first_chunk = vec![b'x'; EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES];
    let first_chunk_head = format!("{:X}\r\n", first_chunk.len());
    let server = HeldOpenResponseServer::start(vec![
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
            .to_vec(),
        first_chunk_head.into_bytes(),
        first_chunk,
        b"\r\n1\r\nx\r\n".to_vec(),
    ])
    .await
    .unwrap();
    let client = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        "response-limit-run",
        Duration::ZERO,
    )
    .unwrap();
    let url = format!("{}/test", server.base_url);

    let result = tokio::time::timeout(
        RESPONSE_LIMIT_TEST_TIMEOUT,
        client.post_json(&url, &json!({}), 1),
    )
    .await
    .expect("client waited after a chunked response exceeded the limit");

    let Err(AgentError::Http(message)) = result else {
        panic!("expected response body limit error");
    };
    assert_eq!(message, EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_DIAGNOSTIC);
    server.finish().await;
}

#[tokio::test]
async fn post_json_rejects_no_length_response_over_success_body_limit() {
    let server = HeldOpenResponseServer::start(vec![
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n".to_vec(),
        vec![b'x'; EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_BYTES],
        vec![b'x'],
    ])
    .await
    .unwrap();
    let client = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        "response-limit-run",
        Duration::ZERO,
    )
    .unwrap();
    let url = format!("{}/test", server.base_url);

    let result = tokio::time::timeout(
        RESPONSE_LIMIT_TEST_TIMEOUT,
        client.post_json(&url, &json!({}), 1),
    )
    .await
    .expect("client waited after a response without content-length exceeded the limit");

    let Err(AgentError::Http(message)) = result else {
        panic!("expected response body limit error");
    };
    assert_eq!(message, EXPECTED_SUCCESS_RESPONSE_BODY_LIMIT_DIAGNOSTIC);
    server.finish().await;
}

// =========================================================================
// post_json 4xx handling
// =========================================================================

#[tokio::test]
async fn post_json_4xx_returns_immediately_no_retry() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-400");
        then.status(400);
    });

    let url = api.url("/test/post-400");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    let Err(AgentError::HttpStatus { status, .. }) = result else {
        panic!("expected structured HTTP status error");
    };
    assert_eq!(status, 400);
}

#[tokio::test]
async fn post_json_4xx_error_body_preserves_status_and_message() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-401");
        then.status(401)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "error": {
                    "message": "token expired"
                }
            }));
    });

    let url = api.url("/test/post-401");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(1).await;
    let Err(AgentError::HttpStatus { status, message }) = result else {
        panic!("expected structured HTTP status error");
    };
    assert_eq!(status, 401);
    assert!(message.contains("token expired"));
}

#[tokio::test]
async fn post_json_accepts_error_response_at_body_limit() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let body = padded_json_body(
        EXPECTED_ERROR_RESPONSE_BODY_LIMIT_BYTES,
        "{\"error\":{\"message\":\"at limit\"},\"padding\":\"",
        "\"}",
    );

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/exact-error-limit");
        then.status(400)
            .header("Content-Type", "application/json")
            .body(body);
    });

    let url = api.url("/test/exact-error-limit");
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    let Err(AgentError::HttpStatus { status, message }) = result else {
        panic!("expected structured HTTP status error");
    };
    assert_eq!(status, 400);
    assert!(message.contains("at limit"));
}

#[tokio::test]
async fn post_json_rejects_declared_error_body_over_limit_with_safe_diagnostic() {
    let response_head = format!(
        "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        EXPECTED_ERROR_RESPONSE_BODY_LIMIT_BYTES + 1,
    );
    let server = HeldOpenResponseServer::start(vec![response_head.into_bytes()])
        .await
        .unwrap();
    let client = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "authorization-secret",
        "",
        "response-limit-run",
        Duration::ZERO,
    )
    .unwrap();
    let url = format!("{}/test?query-secret", server.base_url);

    let result = tokio::time::timeout(
        RESPONSE_LIMIT_TEST_TIMEOUT,
        client.post_json(&url, &json!({}), 1),
    )
    .await
    .expect("client waited for an oversized declared error response");

    let Err(AgentError::HttpStatus { status, message }) = result else {
        panic!("expected structured HTTP status error");
    };
    assert_eq!(status, 400);
    assert_eq!(message, EXPECTED_ERROR_RESPONSE_BODY_LIMIT_DIAGNOSTIC);
    server.finish().await;
}

#[tokio::test]
async fn post_json_429_retries() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/post-429");
        then.status(429);
    });

    let url = api.url("/test/post-429");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    // 429 is retriable — should exhaust all retries.
    mock.assert_calls_async(3).await;
    assert!(result.is_err());
}

// =========================================================================
// Auth headers
// =========================================================================

#[tokio::test]
async fn post_json_sends_bearer_token() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/auth")
            .header("Authorization", "Bearer test-token-abc123");
        then.status(200);
    });

    let url = api.url("/test/auth");
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn post_json_sends_vercel_bypass_header() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/test/bypass")
            .header("x-vercel-protection-bypass", "test-bypass-value");
        then.status(200);
    });

    let url = api.url("/test/bypass");
    let result = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn post_json_sends_client_headers() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let request_ids = Arc::new(Mutex::new(Vec::new()));
    let request_ids_for_mock = Arc::clone(&request_ids);

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/client-headers");
        then.respond_with(move |req| {
            let request_id = req
                .headers_vec()
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(CLIENT_REQUEST_ID_HEADER))
                .map(|(_, value)| value.as_str());
            let Some(request_id) = request_id else {
                return http_status(400);
            };
            if Uuid::parse_str(request_id).is_err() {
                return http_status(400);
            }
            if !request_header_eq(req, CLIENT_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
                || !request_header_eq(req, CLIENT_TYPE_HEADER, CLIENT_TYPE_GUEST_AGENT)
                || !request_header_eq(req, CLIENT_SESSION_ID_HEADER, TEST_RUN_ID)
            {
                return http_status(400);
            }

            request_ids_for_mock
                .lock()
                .expect("request ids lock should not be poisoned")
                .push(request_id.to_string());
            http_status(200)
        });
    });

    let url = api.url("/test/client-headers");
    let first = http_client!().post_json(&url, &json!({}), 1).await;
    let second = http_client!().post_json(&url, &json!({}), 1).await;

    mock.assert_calls_async(2).await;
    assert!(first.is_ok());
    assert!(second.is_ok());
    let request_ids = request_ids
        .lock()
        .expect("request ids lock should not be poisoned");
    assert_eq!(request_ids.len(), 2);
    assert_ne!(request_ids[0], request_ids[1]);
}

#[test]
fn with_api_config_rejects_invalid_client_session_header() {
    let result = guest_agent::http::HttpClient::with_api_config(
        "http://127.0.0.1",
        "test-token",
        "",
        "bad\nrun",
        Duration::ZERO,
    );

    let Err(AgentError::Http(message)) = result else {
        panic!("expected invalid client session id error");
    };
    assert!(message.contains("invalid client session id"));
}

#[tokio::test]
async fn post_json_uses_explicit_api_config_without_env_api_url() {
    let server = MockServer::start();
    let http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "explicit-token",
        "explicit-bypass",
        "explicit-run",
        Duration::ZERO,
    )
    .expect("build explicit API client");

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer explicit-token")
            .header("x-vercel-protection-bypass", "explicit-bypass");
        then.status(200).json_body(json!({}));
    });

    let url = format!("{}/api/webhooks/agent/events", server.base_url());
    let result = http.post_json(&url, &json!({"events": []}), 1).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
    mock.delete_async().await;
}

#[tokio::test]
async fn steered_input_declaration_posts_once_to_the_event_route() {
    let server = MockServer::start();
    let client = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "steered-run",
        Duration::ZERO,
    )
    .unwrap();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/runners/runs/run-123/steerable-inputs/event-123/steered")
            .header("Authorization", "Bearer test-token")
            .json_body(json!({}));
        then.status(200).json_body(json!({ "outcome": "steered" }));
    });

    client
        .post_steered_input("run-123", "event-123")
        .await
        .unwrap();

    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn steered_input_conflict_is_returned_without_a_retry() {
    let server = MockServer::start();
    let client = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        "steered-run",
        Duration::ZERO,
    )
    .unwrap();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/runners/runs/run-123/steerable-inputs/event-123/steered");
        then.status(409).json_body(json!({
            "error": { "code": "INPUT_ALREADY_CONSUMED", "message": "Input already consumed" }
        }));
    });

    let result = client.post_steered_input("run-123", "event-123").await;

    mock.assert_calls_async(1).await;
    assert!(matches!(
        result,
        Err(AgentError::HttpStatus { status: 409, .. })
    ));
}

#[tokio::test]
async fn send_event_uses_explicit_api_config_route_instead_of_env_route()
-> Result<(), Box<dyn std::error::Error>> {
    let api = SharedApiMock::new().await;
    let env_server = api.server();
    let explicit_server = MockServer::start();

    let env_mock = env_server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });
    let explicit_mock = explicit_server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .header("Authorization", "Bearer explicit-token")
            .body_includes(r#""sequenceNumber":3"#);
        then.respond_with(|req| {
            if request_header_absent(req, "x-vercel-protection-bypass") {
                http_status(200)
            } else {
                http_status(400)
            }
        });
    });

    let http = guest_agent::http::HttpClient::with_api_config(
        explicit_server.base_url(),
        "explicit-token",
        "",
        "explicit-run",
        Duration::ZERO,
    )?;
    let config = shared_guest_config()?;
    let paths = shared_guest_paths();
    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test", "data": "explicit route"});
    guest_agent::events::send_event_for_config(&http, event, 3, &masker, &config, &paths).await?;

    explicit_mock.assert_calls_async(1).await;
    env_mock.assert_calls_async(0).await;
    explicit_mock.delete_async().await;
    Ok(())
}

// =========================================================================
// Edge cases
// =========================================================================

#[tokio::test]
async fn post_json_malformed_json_response() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/test/malformed");
        then.status(200)
            .header("Content-Type", "application/json")
            .body("not valid json {{{");
    });

    let url = api.url("/test/malformed");
    let result = http_client!().post_json(&url, &json!({}), 3).await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
}
