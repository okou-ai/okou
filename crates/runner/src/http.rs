use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_RUNNER;
use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Client, Request, Response};
use serde::Serialize;
use tracing::info;
use uuid::Uuid;

use crate::config::normalize_api_base_url;
use crate::error::{
    ApiFailureKind, ApiRequestContext, ApiTransportCause, ApiTransportError, RunnerError,
    RunnerResult,
};

/// Default timeout for API requests (covers large claim payloads).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const VERCEL_BYPASS_HEADER: &str = "x-vercel-protection-bypass";
const RUNNER_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const API_ERROR_SUMMARY_MAX_CHARS: usize = 512;
const API_ERROR_SUMMARY_TRUNCATION_MARKER: &str = "...";
const API_ERROR_SUMMARY_TRUNCATION_MARKER_CHARS: usize = 3;

/// Configuration for the shared runner API HTTP client.
pub struct HttpClientConfig {
    pub api_url: String,
    pub vercel_bypass: Option<String>,
    pub client_session_id: String,
}

/// Shared HTTP client for the platform API. Owns the connection pool, base URL,
/// and Vercel bypass header. Clone is a cheap Arc refcount bump.
#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    api_url: String,
    vercel_bypass: Option<String>,
    client_headers: ClientHeaders,
}

#[derive(Clone)]
struct ClientHeaders {
    client_type: HeaderValue,
    client_version: HeaderValue,
    client_session_id: HeaderValue,
}

struct AppliedClientHeaders {
    client_version: String,
    client_session_id: String,
    client_request_id: String,
}

struct FinalizedApiRequest {
    request: Request,
    context: ApiRequestContext,
}

/// Finalized API request whose correlation context is available before transport execution.
pub(crate) struct PreparedApiRequest {
    client: Client,
    request: Request,
    context: ApiRequestContext,
}

/// Request builder for generated platform API routes.
///
/// Generated client headers are finalized in `send`/`build` so caller-side
/// request customization cannot accidentally override them.
pub struct ApiRequestBuilder {
    client: Client,
    builder: reqwest::RequestBuilder,
    client_headers: ClientHeaders,
}

impl ApiRequestBuilder {
    pub fn json<T: Serialize + ?Sized>(self, json: &T) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.json(json),
            client_headers,
        }
    }

    pub fn timeout(self, timeout: Duration) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.timeout(timeout),
            client_headers,
        }
    }

    pub async fn send(self, endpoint_label: &'static str) -> RunnerResult<Response> {
        self.prepare(endpoint_label)?.send().await
    }

    pub(crate) fn prepare(self, endpoint_label: &'static str) -> RunnerResult<PreparedApiRequest> {
        let client = self.client.clone();
        let finalized = self.finalize(endpoint_label)?;
        Ok(PreparedApiRequest {
            client,
            request: finalized.request,
            context: finalized.context,
        })
    }

    pub(crate) fn build(self) -> RunnerResult<Request> {
        Ok(self.finalize("build")?.request)
    }

    #[cfg(test)]
    pub fn build_with_context_for_test(
        self,
        endpoint_label: &'static str,
    ) -> RunnerResult<(Request, ApiRequestContext)> {
        let finalized = self.finalize(endpoint_label)?;
        Ok((finalized.request, finalized.context))
    }

    fn finalize(self, endpoint_label: &'static str) -> RunnerResult<FinalizedApiRequest> {
        let mut request = self
            .builder
            .build()
            .map_err(|e| RunnerError::Api(format!("build API request: {e}")))?;
        let applied_headers = self.client_headers.apply(request.headers_mut())?;
        let context = request_context(endpoint_label, &request, applied_headers);
        Ok(FinalizedApiRequest { request, context })
    }

    pub(crate) fn deferred_pi_reader(self) -> Self {
        Self {
            builder: self.builder.header("X-Pi-Deferred-Sandbox", "1"),
            ..self
        }
    }

    #[cfg(test)]
    fn header_for_test(self, name: &'static str, value: &'static str) -> Self {
        let Self {
            client,
            builder,
            client_headers,
        } = self;
        Self {
            client,
            builder: builder.header(name, value),
            client_headers,
        }
    }
}

impl PreparedApiRequest {
    pub(crate) fn context(&self) -> &ApiRequestContext {
        &self.context
    }

    pub(crate) async fn send(self) -> RunnerResult<Response> {
        let Self {
            client,
            request,
            context,
        } = self;
        client
            .execute(request)
            .await
            .map_err(|e| api_transport_error(context, e))
    }
}

impl ClientHeaders {
    fn new(client_session_id: String) -> RunnerResult<Self> {
        let client_session_id = HeaderValue::from_str(&client_session_id)
            .map_err(|e| RunnerError::Internal(format!("invalid client session id: {e}")))?;

        Ok(Self {
            client_type: HeaderValue::from_static(CLIENT_TYPE_RUNNER),
            client_version: HeaderValue::from_static(RUNNER_CLIENT_VERSION),
            client_session_id,
        })
    }

    fn apply(&self, headers: &mut HeaderMap) -> RunnerResult<AppliedClientHeaders> {
        let request_id = Uuid::new_v4().to_string();
        let request_id = match HeaderValue::from_str(&request_id) {
            Ok(value) => value,
            Err(error) => {
                return Err(RunnerError::Internal(format!(
                    "invalid client request id: {error}"
                )));
            }
        };
        headers.insert(CLIENT_VERSION_HEADER, self.client_version.clone());
        headers.insert(CLIENT_TYPE_HEADER, self.client_type.clone());
        headers.insert(CLIENT_SESSION_ID_HEADER, self.client_session_id.clone());
        headers.insert(CLIENT_REQUEST_ID_HEADER, request_id.clone());
        Ok(AppliedClientHeaders {
            client_version: header_value_string(&self.client_version, "client version")?,
            client_session_id: header_value_string(&self.client_session_id, "client session id")?,
            client_request_id: header_value_string(&request_id, "client request id")?,
        })
    }
}

fn header_value_string(value: &HeaderValue, label: &str) -> RunnerResult<String> {
    value
        .to_str()
        .map(str::to_string)
        .map_err(|e| RunnerError::Internal(format!("invalid {label}: {e}")))
}

impl HttpClient {
    /// Create a shared API HTTP client using `config.api_url` as the base URL for generated routes.
    ///
    /// The client uses the runner's default request timeout. When
    /// `config.vercel_bypass` is present, that value is attached as
    /// `x-vercel-protection-bypass` on authenticated requests.
    ///
    /// Returns an error if the API URL is invalid or the underlying HTTP client cannot be built.
    pub fn new(config: HttpClientConfig) -> RunnerResult<Self> {
        let HttpClientConfig {
            api_url: raw_api_url,
            vercel_bypass,
            client_session_id,
        } = config;
        let api_url = normalize_api_base_url(&raw_api_url)?;

        let client = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|e| RunnerError::Internal(format!("http client: {e}")))?;

        info!(
            api_url = %api_url,
            vercel_bypass = vercel_bypass.is_some(),
            "http client initialized"
        );

        Ok(Self {
            inner: Arc::new(Inner {
                client,
                api_url,
                vercel_bypass,
                client_headers: ClientHeaders::new(client_session_id)?,
            }),
        })
    }

    /// Build an authenticated request from a generated API route.
    pub fn request_route(&self, route: Route, token: &str) -> ApiRequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    /// Build an authenticated request from a generated route with params applied.
    pub fn request_resolved_route(&self, route: ResolvedRoute, token: &str) -> ApiRequestBuilder {
        self.authenticated_request(
            reqwest_method(route.method),
            route.url(&self.inner.api_url),
            token,
        )
    }

    pub fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.inner.client.get(url)
    }

    fn authenticated_request(
        &self,
        method: reqwest::Method,
        url: String,
        token: &str,
    ) -> ApiRequestBuilder {
        let mut req = self.inner.client.request(method, url).bearer_auth(token);

        if let Some(bypass) = &self.inner.vercel_bypass {
            req = req.header(VERCEL_BYPASS_HEADER, bypass);
        }

        ApiRequestBuilder {
            client: self.inner.client.clone(),
            builder: req,
            client_headers: self.inner.client_headers.clone(),
        }
    }
}

fn reqwest_method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        Method::Put => reqwest::Method::PUT,
        Method::Patch => reqwest::Method::PATCH,
        Method::Delete => reqwest::Method::DELETE,
        Method::Head => reqwest::Method::HEAD,
        Method::Options => reqwest::Method::OPTIONS,
    }
}

fn request_context(
    endpoint_label: &'static str,
    request: &Request,
    headers: AppliedClientHeaders,
) -> ApiRequestContext {
    let url = request.url();
    let host = match (url.host_str(), url.port()) {
        (Some(host), Some(port)) if host.contains(':') && !host.starts_with('[') => {
            format!("[{host}]:{port}")
        }
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => String::new(),
    };
    ApiRequestContext {
        endpoint_label,
        method: request.method().as_str().to_string(),
        host,
        path: url.path().to_string(),
        client_request_id: headers.client_request_id,
        client_session_id: headers.client_session_id,
        client_version: headers.client_version,
    }
}

fn api_transport_error(context: ApiRequestContext, error: reqwest::Error) -> RunnerError {
    let failure_kind = api_failure_kind(&error);
    let failure_cause = api_transport_cause(&error);
    let summary = sanitize_api_error_summary(error.without_url().to_string());
    RunnerError::ApiTransport(Box::new(ApiTransportError {
        request: context,
        failure_kind,
        failure_cause,
        summary,
    }))
}

fn api_failure_kind(error: &reqwest::Error) -> ApiFailureKind {
    if error.is_timeout() {
        ApiFailureKind::Timeout
    } else if error.is_connect() {
        ApiFailureKind::Connect
    } else if error.is_body() {
        ApiFailureKind::Body
    } else if error.is_request() {
        ApiFailureKind::Request
    } else {
        ApiFailureKind::Unknown
    }
}

pub(crate) fn api_transport_cause(error: &reqwest::Error) -> ApiTransportCause {
    if error.is_timeout() {
        return ApiTransportCause::Timeout;
    }

    // A concrete operating-system cause is more actionable than its protocol
    // wrapper. Keep the first typed Hyper cause only as a fallback while
    // walking deeper sources; never inspect dependency-owned error text.
    let mut source = error.source();
    let mut hyper_cause = None;
    let mut saw_io = false;
    while let Some(error) = source {
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            if let Some(cause) = api_io_cause(error.kind()) {
                return cause;
            }
            saw_io = true;
        }
        if let Some(error) = error.downcast_ref::<hyper::Error>() {
            hyper_cause = hyper_cause.or_else(|| api_hyper_cause(error));
        }
        source = error.source();
    }

    if let Some(cause) = hyper_cause {
        cause
    } else if saw_io {
        ApiTransportCause::Io
    } else {
        ApiTransportCause::Unknown
    }
}

fn api_io_cause(kind: std::io::ErrorKind) -> Option<ApiTransportCause> {
    match kind {
        std::io::ErrorKind::TimedOut => Some(ApiTransportCause::Timeout),
        std::io::ErrorKind::ConnectionRefused => Some(ApiTransportCause::ConnectionRefused),
        std::io::ErrorKind::ConnectionReset => Some(ApiTransportCause::ConnectionReset),
        std::io::ErrorKind::ConnectionAborted => Some(ApiTransportCause::ConnectionAborted),
        std::io::ErrorKind::NetworkUnreachable => Some(ApiTransportCause::NetworkUnreachable),
        std::io::ErrorKind::HostUnreachable => Some(ApiTransportCause::HostUnreachable),
        std::io::ErrorKind::NotConnected => Some(ApiTransportCause::NotConnected),
        std::io::ErrorKind::BrokenPipe => Some(ApiTransportCause::BrokenPipe),
        std::io::ErrorKind::UnexpectedEof => Some(ApiTransportCause::UnexpectedEof),
        _ => None,
    }
}

fn api_hyper_cause(error: &hyper::Error) -> Option<ApiTransportCause> {
    if error.is_timeout() {
        Some(ApiTransportCause::Timeout)
    } else if error.is_incomplete_message() {
        Some(ApiTransportCause::HttpIncompleteMessage)
    } else if error.is_canceled() {
        Some(ApiTransportCause::HttpCanceled)
    } else if error.is_closed() {
        Some(ApiTransportCause::HttpClosed)
    } else if error.is_parse() {
        Some(ApiTransportCause::HttpParse)
    } else if error.is_body_write_aborted() {
        Some(ApiTransportCause::HttpBodyWriteAborted)
    } else if error.is_shutdown() {
        Some(ApiTransportCause::HttpShutdown)
    } else {
        None
    }
}

fn sanitize_api_error_summary(summary: String) -> String {
    let mut sanitized = String::with_capacity(summary.len().min(API_ERROR_SUMMARY_MAX_CHARS));
    let mut previous_was_whitespace = false;
    let mut emitted = 0;
    let max_body_chars =
        API_ERROR_SUMMARY_MAX_CHARS.saturating_sub(API_ERROR_SUMMARY_TRUNCATION_MARKER_CHARS);
    let mut truncated = false;
    for ch in summary.chars() {
        if emitted >= max_body_chars {
            truncated = true;
            break;
        }
        if ch.is_control() || ch.is_whitespace() {
            if !previous_was_whitespace {
                sanitized.push(' ');
                emitted += 1;
                previous_was_whitespace = true;
            }
            continue;
        }
        sanitized.push(ch);
        emitted += 1;
        previous_was_whitespace = false;
    }
    let mut sanitized = sanitized.trim().to_string();
    if truncated {
        sanitized.push_str(API_ERROR_SUMMARY_TRUNCATION_MARKER);
    }
    sanitized
}

#[cfg(test)]
mod tests {
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

    fn api_transport_error(error: RunnerError) -> ApiTransportError {
        match error {
            RunnerError::ApiTransport(error) => *error,
            other => panic!("expected RunnerError::ApiTransport, got {other:?}"),
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
    fn request_includes_vercel_bypass_header_when_configured() {
        let http = HttpClient::new(HttpClientConfig {
            api_url: "https://api.vm0.dev/".to_string(),
            vercel_bypass: Some("bypass-secret".to_string()),
            client_session_id: "runner-session-test".to_string(),
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
}
