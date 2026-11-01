use std::error::Error as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

use crate::error::{
    ApiFailureKind, ApiRequestContext, ApiTransportCause, ApiTransportError, ProviderError,
    ProviderResult,
};

mod transport_timing;
use transport_timing::{ConnectionTimingLayer, TimedResolver};
mod transport_diagnostics;
use transport_diagnostics::{ConnectionDiagnosticsLayer, TransportDiagnostics};

/// Validate and normalize the Runner API base URL before authenticated requests.
pub fn normalize_api_base_url(value: &str) -> ProviderResult<String> {
    let mut parsed = url::Url::parse(value)
        .map_err(|_| ProviderError::Config("server.url must be an absolute http(s) URL".into()))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ProviderError::Config(
            "server.url must use the http or https scheme".into(),
        ));
    }
    if parsed.host_str().is_none() {
        return Err(ProviderError::Config(
            "server.url must include a host".into(),
        ));
    }
    if parsed_has_userinfo(value, &parsed) {
        return Err(ProviderError::Config(
            "server.url must not include credentials".into(),
        ));
    }
    if parsed.query().is_some() {
        return Err(ProviderError::Config(
            "server.url must not include a query string".into(),
        ));
    }
    if parsed.fragment().is_some() {
        return Err(ProviderError::Config(
            "server.url must not include a fragment".into(),
        ));
    }

    let raw_authority = runner_types::firewall_hostname_policy::raw_url_authority(value)
        .ok_or_else(|| ProviderError::Config("server.url must include a host".into()))?;
    runner_types::firewall_hostname_policy::validate_raw_url_host(
        runner_types::firewall_hostname_policy::raw_host_from_authority(raw_authority),
        "server.url",
    )
    .map_err(ProviderError::Config)?;

    let host_without_trailing_dot = parsed
        .host_str()
        .and_then(|host| host.strip_suffix('.'))
        .map(str::to_owned);
    if let Some(host) = host_without_trailing_dot {
        parsed
            .set_host(Some(&host))
            .map_err(|_| ProviderError::Config("server.url has an invalid host".into()))?;
    }

    let host_is_loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() == "http" && !host_is_loopback {
        return Err(ProviderError::Config(
            "server.url must use https unless its host is localhost or a loopback IP address"
                .into(),
        ));
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn parsed_has_userinfo(raw_value: &str, url: &url::Url) -> bool {
    !url.username().is_empty()
        || url.password().is_some()
        || authority_has_userinfo_marker(raw_value)
        || authority_has_userinfo_marker(url.as_str())
}

fn authority_has_userinfo_marker(value: &str) -> bool {
    let Some((_, after_scheme)) = value.split_once("://") else {
        return false;
    };
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    authority.contains('@')
}

/// Default timeout for API requests (covers large claim payloads).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
const VERCEL_BYPASS_HEADER: &str = "x-vercel-protection-bypass";
#[cfg(test)]
const RUNNER_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const API_ERROR_SUMMARY_MAX_CHARS: usize = 512;
const API_ERROR_SUMMARY_TRUNCATION_MARKER: &str = "...";
const API_ERROR_SUMMARY_TRUNCATION_MARKER_CHARS: usize = 3;

/// Configuration for the shared runner API HTTP client.
pub struct HttpClientConfig {
    pub api_url: String,
    pub vercel_bypass: Option<String>,
    pub client_session_id: String,
    pub runner_version: &'static str,
}

/// Shared HTTP client for the platform API. Owns the connection pool, base URL,
/// and Vercel bypass header. Clone is a cheap Arc refcount bump.
#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    diagnostics: TransportDiagnostics,
    api_url: String,
    vercel_bypass: Option<String>,
    runner_version: &'static str,
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
pub struct PreparedApiRequest {
    client: Client,
    diagnostics: TransportDiagnostics,
    request: Request,
    context: ApiRequestContext,
}

/// Request builder for generated platform API routes.
///
/// Generated client headers are finalized in `send`/`build` so caller-side
/// request customization cannot accidentally override them.
pub struct ApiRequestBuilder {
    client: Client,
    diagnostics: TransportDiagnostics,
    builder: reqwest::RequestBuilder,
    client_headers: ClientHeaders,
    query: Vec<(String, String)>,
}

impl ApiRequestBuilder {
    pub fn json<T: Serialize + ?Sized>(self, json: &T) -> Self {
        let Self {
            client,
            diagnostics,
            builder,
            client_headers,
            query,
        } = self;
        Self {
            client,
            diagnostics,
            builder: builder.json(json),
            client_headers,
            query,
        }
    }

    pub fn timeout(self, timeout: Duration) -> Self {
        let Self {
            client,
            diagnostics,
            builder,
            client_headers,
            query,
        } = self;
        Self {
            client,
            diagnostics,
            builder: builder.timeout(timeout),
            client_headers,
            query,
        }
    }

    pub fn query(mut self, pairs: &[(&str, &str)]) -> Self {
        self.query.extend(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
        );
        self
    }

    pub async fn send(self, endpoint_label: &'static str) -> ProviderResult<Response> {
        self.prepare(endpoint_label)?.send().await
    }

    pub fn prepare(self, endpoint_label: &'static str) -> ProviderResult<PreparedApiRequest> {
        let client = self.client.clone();
        let diagnostics = self.diagnostics.clone();
        let finalized = self.finalize(endpoint_label)?;
        Ok(PreparedApiRequest {
            client,
            diagnostics,
            request: finalized.request,
            context: finalized.context,
        })
    }

    pub(crate) fn build(self) -> ProviderResult<Request> {
        Ok(self.finalize("build")?.request)
    }

    #[cfg(test)]
    pub fn build_with_context_for_test(
        self,
        endpoint_label: &'static str,
    ) -> ProviderResult<(Request, ApiRequestContext)> {
        let finalized = self.finalize(endpoint_label)?;
        Ok((finalized.request, finalized.context))
    }

    fn finalize(self, endpoint_label: &'static str) -> ProviderResult<FinalizedApiRequest> {
        let mut request = self
            .builder
            .build()
            .map_err(|e| ProviderError::Api(format!("build API request: {e}")))?;
        if !self.query.is_empty() {
            request
                .url_mut()
                .query_pairs_mut()
                .extend_pairs(self.query.iter().map(|(name, value)| (name, value)));
        }
        let applied_headers = self.client_headers.apply(request.headers_mut())?;
        let context = request_context(endpoint_label, &request, applied_headers);
        Ok(FinalizedApiRequest { request, context })
    }

    #[cfg(test)]
    fn header_for_test(self, name: &'static str, value: &'static str) -> Self {
        let Self {
            client,
            diagnostics,
            builder,
            client_headers,
            query,
        } = self;
        Self {
            client,
            diagnostics,
            builder: builder.header(name, value),
            client_headers,
            query,
        }
    }
}

impl PreparedApiRequest {
    pub fn url(&self) -> &url::Url {
        self.request.url()
    }

    pub fn context(&self) -> &ApiRequestContext {
        &self.context
    }

    pub async fn send(self) -> ProviderResult<Response> {
        let Self {
            client,
            diagnostics,
            request,
            context,
        } = self;
        let started = Instant::now();
        let result = diagnostics
            .scope(&context.client_request_id, client.execute(request))
            .await;
        match result {
            Ok(response) => {
                diagnostics.response(&response, &context.client_request_id, started);
                Ok(response)
            }
            Err(error) => {
                diagnostics.failure(&context, started, &error);
                Err(api_transport_error(context, error))
            }
        }
    }

    pub(crate) async fn send_observed_claim(
        self,
        run_id: runner_types::ids::RunId,
        execution_started_at: Instant,
    ) -> ProviderResult<Response> {
        transport_timing::send_claim(self, run_id, execution_started_at).await
    }
}

impl ClientHeaders {
    fn new(client_session_id: String, runner_version: &'static str) -> ProviderResult<Self> {
        let client_session_id = HeaderValue::from_str(&client_session_id)
            .map_err(|e| ProviderError::Internal(format!("invalid client session id: {e}")))?;

        Ok(Self {
            client_type: HeaderValue::from_static(CLIENT_TYPE_RUNNER),
            client_version: HeaderValue::from_static(runner_version),
            client_session_id,
        })
    }

    fn apply(&self, headers: &mut HeaderMap) -> ProviderResult<AppliedClientHeaders> {
        let request_id = Uuid::new_v4().to_string();
        let request_id = match HeaderValue::from_str(&request_id) {
            Ok(value) => value,
            Err(error) => {
                return Err(ProviderError::Internal(format!(
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

fn header_value_string(value: &HeaderValue, label: &str) -> ProviderResult<String> {
    value
        .to_str()
        .map(str::to_string)
        .map_err(|e| ProviderError::Internal(format!("invalid {label}: {e}")))
}

impl HttpClient {
    /// Create a shared API HTTP client using `config.api_url` as the base URL for generated routes.
    ///
    /// The client uses the runner's default request timeout. When
    /// `config.vercel_bypass` is present, that value is attached as
    /// `x-vercel-protection-bypass` on authenticated requests.
    ///
    /// Returns an error if the API URL is invalid or the underlying HTTP client cannot be built.
    pub fn new(config: HttpClientConfig) -> ProviderResult<Self> {
        let HttpClientConfig {
            api_url: raw_api_url,
            vercel_bypass,
            client_session_id,
            runner_version,
        } = config;
        let api_url = normalize_api_base_url(&raw_api_url)?;
        let diagnostics = TransportDiagnostics::new();

        let client = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .dns_resolver(TimedResolver::default())
            .connector_layer(ConnectionTimingLayer)
            .connector_layer(ConnectionDiagnosticsLayer)
            .build()
            .map_err(|e| ProviderError::Internal(format!("http client: {e}")))?;

        info!(
            api_url = %api_url,
            vercel_bypass = vercel_bypass.is_some(),
            "http client initialized"
        );

        Ok(Self {
            inner: Arc::new(Inner {
                client,
                diagnostics,
                api_url,
                vercel_bypass,
                runner_version,
                client_headers: ClientHeaders::new(client_session_id, runner_version)?,
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

    pub fn runner_version(&self) -> &'static str {
        self.inner.runner_version
    }

    /// Build an authenticated JSON request for a caller-owned transport.
    pub fn json_request(
        &self,
        route: ResolvedRoute,
        token: &str,
        body: &serde_json::Value,
    ) -> ProviderResult<Request> {
        self.request_resolved_route(route, token).json(body).build()
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
            diagnostics: self.inner.diagnostics.clone(),
            builder: req,
            client_headers: self.inner.client_headers.clone(),
            query: Vec::new(),
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

fn api_transport_error(context: ApiRequestContext, error: reqwest::Error) -> ProviderError {
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
mod tests;
