use std::error::Error as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::Response;
use serde::Serialize;

use crate::error::{
    ApiFailureKind, ApiRequestContext, ApiTransportCause, ApiTransportError, ProviderError,
    ProviderResult,
};

const API_ERROR_SUMMARY_MAX_CHARS: usize = 512;
const API_ERROR_SUMMARY_TRUNCATION_MARKER: &str = "...";
const API_ERROR_SUMMARY_TRUNCATION_MARKER_CHARS: usize = 3;

/// Narrow request description accepted by the Runner-owned HTTP adapter.
///
/// Provider owns route, authentication, body, query, and timeout policy. The
/// adapter owns the connection pool, API base URL, bypass configuration, and
/// correlation headers.
pub struct ProviderHttpRequest {
    method: Method,
    path: String,
    token: String,
    json_body: Option<Vec<u8>>,
    timeout: Option<Duration>,
    query: Vec<(String, String)>,
    native_gpt_6_reader: bool,
}

impl ProviderHttpRequest {
    pub fn method(&self) -> Method {
        self.method
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn json_body(&self) -> Option<&[u8]> {
        self.json_body.as_deref()
    }

    pub fn timeout(&self) -> Option<Duration> {
        self.timeout
    }

    pub fn query(&self) -> &[(String, String)] {
        &self.query
    }

    pub fn uses_native_gpt_6_reader(&self) -> bool {
        self.native_gpt_6_reader
    }
}

type SendFuture = Pin<Box<dyn Future<Output = ProviderResult<Response>> + Send>>;

/// Finalized provider request with correlation context available before send.
pub struct PreparedProviderHttpRequest {
    url: url::Url,
    context: ApiRequestContext,
    send: SendFuture,
}

impl PreparedProviderHttpRequest {
    /// Construct the opaque prepared request returned by a transport adapter.
    pub fn new<F>(url: url::Url, context: ApiRequestContext, send: F) -> Self
    where
        F: Future<Output = ProviderResult<Response>> + Send + 'static,
    {
        Self {
            url,
            context,
            send: Box::pin(send),
        }
    }

    pub fn url(&self) -> &url::Url {
        &self.url
    }

    pub fn context(&self) -> &ApiRequestContext {
        &self.context
    }

    pub async fn send(self) -> ProviderResult<Response> {
        self.send.await
    }
}

/// Runner-owned execution boundary for provider API requests.
pub trait ProviderHttpTransport: Send + Sync {
    fn prepare(
        &self,
        request: ProviderHttpRequest,
        endpoint_label: &'static str,
    ) -> ProviderResult<PreparedProviderHttpRequest>;
}

/// Cloneable provider-side handle around the narrow transport port.
#[derive(Clone)]
pub struct ProviderHttpClient {
    transport: Arc<dyn ProviderHttpTransport>,
}

impl ProviderHttpClient {
    pub fn new<T>(transport: T) -> Self
    where
        T: ProviderHttpTransport + 'static,
    {
        Self {
            transport: Arc::new(transport),
        }
    }

    pub(crate) fn request_route(&self, route: Route, token: &str) -> ProviderHttpRequestBuilder {
        self.request(route.method, route.path.to_string(), token)
    }

    pub(crate) fn request_resolved_route(
        &self,
        route: ResolvedRoute,
        token: &str,
    ) -> ProviderHttpRequestBuilder {
        self.request(route.method, route.path, token)
    }

    fn request(&self, method: Method, path: String, token: &str) -> ProviderHttpRequestBuilder {
        ProviderHttpRequestBuilder {
            transport: self.transport.clone(),
            request: Ok(ProviderHttpRequest {
                method,
                path,
                token: token.to_string(),
                json_body: None,
                timeout: None,
                query: Vec::new(),
                native_gpt_6_reader: false,
            }),
        }
    }
}

pub(crate) struct ProviderHttpRequestBuilder {
    transport: Arc<dyn ProviderHttpTransport>,
    request: ProviderResult<ProviderHttpRequest>,
}

impl ProviderHttpRequestBuilder {
    pub(crate) fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.request = self.request.and_then(|mut request| {
            request.json_body = Some(
                serde_json::to_vec(value)
                    .map_err(|error| ProviderError::Api(format!("encode API request: {error}")))?,
            );
            Ok(request)
        });
        self
    }

    pub(crate) fn timeout(mut self, timeout: Duration) -> Self {
        if let Ok(request) = &mut self.request {
            request.timeout = Some(timeout);
        }
        self
    }

    pub(crate) fn query(mut self, pairs: &[(&str, &str)]) -> Self {
        if let Ok(request) = &mut self.request {
            request.query.extend(
                pairs
                    .iter()
                    .map(|(name, value)| ((*name).to_string(), (*value).to_string())),
            );
        }
        self
    }

    pub(crate) fn native_gpt_6_reader(mut self) -> Self {
        if let Ok(request) = &mut self.request {
            request.native_gpt_6_reader = true;
        }
        self
    }

    pub(crate) fn prepare(
        self,
        endpoint_label: &'static str,
    ) -> ProviderResult<PreparedProviderHttpRequest> {
        self.transport.prepare(self.request?, endpoint_label)
    }

    pub(crate) async fn send(self, endpoint_label: &'static str) -> ProviderResult<Response> {
        self.prepare(endpoint_label)?.send().await
    }
}

/// Map a concrete reqwest transport failure into provider-owned safe diagnostics.
pub fn provider_http_transport_error(
    context: ApiRequestContext,
    error: reqwest::Error,
) -> ProviderError {
    let failure_kind = api_failure_kind(&error);
    let failure_cause = api_transport_cause(&error);
    let summary = sanitize_api_error_summary(error.without_url().to_string());
    ProviderError::ApiTransport(Box::new(ApiTransportError {
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
pub(crate) struct HttpClientConfig {
    pub(crate) api_url: String,
    pub(crate) vercel_bypass: Option<String>,
    pub(crate) client_session_id: String,
}

/// Test-only concrete adapter used by owner tests. Production always injects
/// the Runner-owned transport implementation.
#[cfg(test)]
pub(crate) struct HttpClient;

#[cfg(test)]
impl HttpClient {
    pub(crate) fn create(config: HttpClientConfig) -> ProviderResult<ProviderHttpClient> {
        use api_contracts::generated::constants::client::headers::{
            CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER,
            CLIENT_VERSION_HEADER,
        };
        use api_contracts::generated::constants::client::types::CLIENT_TYPE_RUNNER;
        use reqwest::header::{HeaderValue, USER_AGENT};

        let mut default_headers = reqwest::header::HeaderMap::new();
        default_headers.insert(
            USER_AGENT,
            HeaderValue::from_static("runner-provider-owner-tests"),
        );
        let client = reqwest::Client::builder()
            .default_headers(default_headers)
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| ProviderError::Internal(format!("http client: {error}")))?;
        let api_url = config.api_url.trim_end_matches('/').to_string();
        let client_session_id =
            HeaderValue::from_str(&config.client_session_id).map_err(|error| {
                ProviderError::Internal(format!("invalid client session id: {error}"))
            })?;
        let transport = TestHttpTransport {
            client,
            api_url,
            vercel_bypass: config.vercel_bypass,
            client_session_id,
            client_type: HeaderValue::from_static(CLIENT_TYPE_RUNNER),
            client_version: HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
            header_names: TestHeaderNames {
                client_request_id: CLIENT_REQUEST_ID_HEADER,
                client_session_id: CLIENT_SESSION_ID_HEADER,
                client_type: CLIENT_TYPE_HEADER,
                client_version: CLIENT_VERSION_HEADER,
            },
        };
        Ok(ProviderHttpClient::new(transport))
    }
}

#[cfg(test)]
struct TestHeaderNames {
    client_request_id: &'static str,
    client_session_id: &'static str,
    client_type: &'static str,
    client_version: &'static str,
}

#[cfg(test)]
struct TestHttpTransport {
    client: reqwest::Client,
    api_url: String,
    vercel_bypass: Option<String>,
    client_session_id: reqwest::header::HeaderValue,
    client_type: reqwest::header::HeaderValue,
    client_version: reqwest::header::HeaderValue,
    header_names: TestHeaderNames,
}

#[cfg(test)]
impl ProviderHttpTransport for TestHttpTransport {
    fn prepare(
        &self,
        request: ProviderHttpRequest,
        endpoint_label: &'static str,
    ) -> ProviderResult<PreparedProviderHttpRequest> {
        use reqwest::header::{CONTENT_TYPE, HeaderValue};
        use uuid::Uuid;

        let query = request.query.clone();
        let url = format!("{}{}", self.api_url, request.path);
        let mut builder = self
            .client
            .request(test_reqwest_method(request.method), url)
            .bearer_auth(request.token);
        if let Some(bypass) = &self.vercel_bypass {
            builder = builder.header("x-vercel-protection-bypass", bypass);
        }
        if let Some(body) = request.json_body {
            builder = builder.header(CONTENT_TYPE, "application/json").body(body);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        if request.native_gpt_6_reader {
            builder = builder
                .header("X-Native-Gpt-6-Sol", "1")
                .header("X-Native-Gpt-6-Luna", "1");
        }
        let mut request = builder
            .build()
            .map_err(|error| ProviderError::Api(format!("build API request: {error}")))?;
        if !query.is_empty() {
            request
                .url_mut()
                .query_pairs_mut()
                .extend_pairs(query.iter().map(|(name, value)| (name, value)));
        }
        let request_id = HeaderValue::from_str(&Uuid::new_v4().to_string())
            .map_err(|error| ProviderError::Internal(format!("invalid request id: {error}")))?;
        request.headers_mut().insert(
            self.header_names.client_version,
            self.client_version.clone(),
        );
        request
            .headers_mut()
            .insert(self.header_names.client_type, self.client_type.clone());
        request.headers_mut().insert(
            self.header_names.client_session_id,
            self.client_session_id.clone(),
        );
        request
            .headers_mut()
            .insert(self.header_names.client_request_id, request_id.clone());

        let request_url = request.url().clone();
        let host = match (request_url.host_str(), request_url.port()) {
            (Some(host), Some(port)) if host.contains(':') && !host.starts_with('[') => {
                format!("[{host}]:{port}")
            }
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_string(),
            (None, _) => String::new(),
        };
        let context = ApiRequestContext {
            endpoint_label,
            method: request.method().as_str().to_string(),
            host,
            path: request_url.path().to_string(),
            client_request_id: request_id.to_str().unwrap().to_string(),
            client_session_id: self.client_session_id.to_str().unwrap().to_string(),
            client_version: self.client_version.to_str().unwrap().to_string(),
        };
        let error_context = context.clone();
        let client = self.client.clone();
        Ok(PreparedProviderHttpRequest::new(
            request_url,
            context,
            async move {
                client
                    .execute(request)
                    .await
                    .map_err(|error| provider_http_transport_error(error_context, error))
            },
        ))
    }
}

#[cfg(test)]
fn test_reqwest_method(method: Method) -> reqwest::Method {
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
