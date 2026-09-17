//! HTTP client for webhook calls and single-attempt S3 uploads.

use crate::constants;
use crate::env;
use crate::error::AgentError;
use crate::urls;
use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_GUEST_AGENT;
use api_contracts::generated::types::runners::jobs::pi_handoff::Response as DeferredPiHandoffResponse;
use api_contracts::generated::types::runners::runs::active_inputs::receipt::Response as ActiveInputReceiptResponse;
use bytes::{Bytes, BytesMut};
use guest_contracts::diagnostics::{HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic};
use guest_telemetry::log_warn;
use http_body::{Frame, SizeHint};
use pin_project_lite::pin_project;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, RequestBuilder, Response};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::time::Instant;
use uuid::Uuid;

const LOG_TAG: &str = "sandbox:guest-agent";
const HTTP_TOO_MANY_REQUESTS: u16 = 429;
const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(1);
const SESSION_OUTPUT_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(debug_assertions)]
const TEST_DISABLE_HTTP_RETRY_DELAY_ENV: &str = "OKOU_TEST_DISABLE_HTTP_RETRY_DELAY";
const GUEST_AGENT_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const API_RESPONSE_BODY_TOO_LARGE_DIAGNOSTIC: &str =
    "API response body exceeds the configured limit";
const API_ERROR_RESPONSE_BODY_TOO_LARGE_DIAGNOSTIC: &str =
    "API error response body exceeds the configured limit";
const PI_DEFERRED_HANDOFF_RESPONSE_MAX_BYTES: usize = 1_500_000;

enum ResponseBodyCollectionError {
    TooLarge,
    Transport(reqwest::Error),
}

/// Content-safe facts published before one observed request is awaited.
#[derive(Debug, Clone)]
pub(crate) struct HttpAttemptStarted {
    pub attempt: u32,
    pub client_request_id: String,
    pub started_at: Instant,
}

/// Content-safe facts published after one observed request completes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpAttemptFinished {
    pub attempt: u32,
    pub client_request_id: String,
    pub elapsed_ms: u64,
    pub outcome: HttpAttemptOutcome,
}

impl HttpAttemptFinished {
    /// Retain completed failure facts without recording successful attempts.
    pub(crate) fn into_failure_diagnostic(self) -> Option<HttpCompletedAttemptDiagnostic> {
        let HttpAttemptOutcome::Failure {
            kind,
            http_status,
            timeout_observed,
            connect_observed,
        } = self.outcome
        else {
            return None;
        };

        Some(HttpCompletedAttemptDiagnostic {
            attempt: self.attempt,
            client_request_id: self.client_request_id,
            elapsed_ms: self.elapsed_ms,
            failure_kind: kind,
            http_status,
            timeout_observed,
            connect_observed,
        })
    }
}

/// Transport outcome for an observed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpAttemptOutcome {
    Success,
    Failure {
        kind: HttpAttemptFailureKind,
        http_status: Option<u16>,
        timeout_observed: Option<bool>,
        connect_observed: Option<bool>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetryableFailure {
    HttpStatus(u16),
    Timeout { connect_observed: bool },
    Connect,
    Transport,
}

impl RetryableFailure {
    fn from_status(status: reqwest::StatusCode) -> Self {
        Self::HttpStatus(status.as_u16())
    }

    fn from_transport(error: &reqwest::Error) -> Self {
        let timeout_observed = error.is_timeout();
        let connect_observed = error.is_connect();
        if timeout_observed {
            Self::Timeout { connect_observed }
        } else if connect_observed {
            Self::Connect
        } else {
            Self::Transport
        }
    }

    fn attempt_outcome(self) -> HttpAttemptOutcome {
        match self {
            Self::HttpStatus(status) => HttpAttemptOutcome::Failure {
                kind: HttpAttemptFailureKind::HttpStatus,
                http_status: Some(status),
                timeout_observed: None,
                connect_observed: None,
            },
            Self::Timeout { connect_observed } => HttpAttemptOutcome::Failure {
                kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: Some(true),
                connect_observed: Some(connect_observed),
            },
            Self::Connect => HttpAttemptOutcome::Failure {
                kind: HttpAttemptFailureKind::Connect,
                http_status: None,
                timeout_observed: Some(false),
                connect_observed: Some(true),
            },
            Self::Transport => HttpAttemptOutcome::Failure {
                kind: HttpAttemptFailureKind::Transport,
                http_status: None,
                timeout_observed: Some(false),
                connect_observed: Some(false),
            },
        }
    }
}

/// Synchronous observer for selected control and event request paths.
pub(crate) trait HttpAttemptObserver: Send + Sync {
    fn attempt_started(&self, attempt: HttpAttemptStarted) -> Result<(), AgentError>;
    fn attempt_finished(&self, attempt: HttpAttemptFinished) -> Result<(), AgentError>;
}

fn format_reqwest_error(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

/// Shared guest-agent HTTP client.
///
/// API-enabled runs build this during initialization and pass cheap clones to
/// background tasks. That keeps webhook/S3 timeout configuration consistent
/// across all HTTP calls and makes client-construction failures explicit at
/// startup. Local/test runs without `OKOU_API_TOKEN` use a disabled client so
/// they do not fail on HTTP stack setup they will never use.
#[derive(Clone)]
pub struct HttpClient {
    inner: Option<Client>,
    retry_delay: Duration,
    api: Option<Arc<ApiHttpConfig>>,
}

struct ApiHttpConfig {
    base_url: String,
    urls: ApiUrls,
    token: String,
    vercel_bypass: String,
    client_session_id: String,
}

#[derive(Clone)]
struct ApiUrls {
    events: String,
    session_output: String,
    complete: String,
    heartbeat: String,
    telemetry: String,
    checkpoint_prepare_history: String,
    storage_prepare: String,
    storage_commit: String,
}

impl HttpClient {
    /// Build an HTTP transport client without API webhook configuration.
    ///
    /// This constructor always initializes the underlying `reqwest` client and
    /// does not check `OKOU_API_TOKEN`. It can send presigned uploads, but
    /// webhook JSON posts require API config from [`Self::with_api_config`],
    /// or [`Self::for_config`].
    /// Production guest-agent initialization should use [`Self::for_config`]
    /// so API settings come from the captured runtime config.
    pub fn new() -> Result<Self, AgentError> {
        Self::with_retry_delay(DEFAULT_RETRY_DELAY)
    }

    /// Build an enabled client with a custom retry delay.
    ///
    /// Integration tests use this to cover real retry behavior without paying
    /// production backoff time. This constructor does not enable API webhook
    /// auth by itself; use [`Self::with_api_config`] for explicit API tests or
    /// [`Self::for_config`] for production guest-agent initialization.
    #[doc(hidden)]
    pub fn with_retry_delay(retry_delay: Duration) -> Result<Self, AgentError> {
        Self::build(
            None,
            retry_delay,
            Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS),
        )
    }

    #[doc(hidden)]
    pub fn with_api_config(
        base_url: impl Into<String>,
        token: impl Into<String>,
        vercel_bypass: impl Into<String>,
        client_session_id: impl Into<String>,
        retry_delay: Duration,
    ) -> Result<Self, AgentError> {
        Self::with_api_config_and_connect_timeout(
            base_url,
            token,
            vercel_bypass,
            client_session_id,
            retry_delay,
            Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS),
        )
    }

    /// Build an API-configured client with a custom connection timeout.
    ///
    /// Integration tests use this to exercise stalled connection setup without
    /// advancing the runtime's global clock.
    #[doc(hidden)]
    pub fn with_api_config_and_connect_timeout(
        base_url: impl Into<String>,
        token: impl Into<String>,
        vercel_bypass: impl Into<String>,
        client_session_id: impl Into<String>,
        retry_delay: Duration,
        connect_timeout: Duration,
    ) -> Result<Self, AgentError> {
        Self::build(
            Some(ApiHttpConfig::new(
                base_url.into(),
                token.into(),
                vercel_bypass.into(),
                client_session_id.into(),
            )?),
            retry_delay,
            connect_timeout,
        )
    }

    fn build(
        api: Option<ApiHttpConfig>,
        retry_delay: Duration,
        connect_timeout: Duration,
    ) -> Result<Self, AgentError> {
        let inner = Client::builder()
            .connect_timeout(connect_timeout)
            .timeout(Duration::from_secs(constants::HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| {
                AgentError::Http(format!("failed to build guest-agent HTTP client: {e}"))
            })?;

        Ok(Self {
            inner: Some(inner),
            retry_delay,
            api: api.map(Arc::new),
        })
    }

    /// Build the HTTP client from an owned guest-agent config.
    pub fn for_config(config: &env::GuestConfig) -> Result<Self, AgentError> {
        let Some(api) = Self::api_config_from_values(
            &config.api_url,
            &config.api_token,
            &config.vercel_bypass,
            &config.run_id,
        )?
        else {
            return Ok(Self {
                inner: None,
                retry_delay: DEFAULT_RETRY_DELAY,
                api: None,
            });
        };
        let retry_delay = {
            #[cfg(debug_assertions)]
            {
                if std::env::var_os(TEST_DISABLE_HTTP_RETRY_DELAY_ENV).is_some() {
                    Duration::ZERO
                } else {
                    DEFAULT_RETRY_DELAY
                }
            }
            #[cfg(not(debug_assertions))]
            {
                DEFAULT_RETRY_DELAY
            }
        };
        Self::build(
            Some(api),
            retry_delay,
            Duration::from_secs(constants::HTTP_CONNECT_TIMEOUT_SECS),
        )
    }

    /// Returns whether backend API/webhook configuration is present.
    ///
    /// This reports API capability, not generic HTTP transport availability.
    /// [`Self::new`] returns `false` here while still providing a transport for
    /// presigned uploads. [`Self::for_config`] also returns `false` when its API
    /// token is empty, but that API-disabled client has no transport. Presigned
    /// uploads require only the transport, while backend API operations require
    /// API configuration.
    pub fn has_api(&self) -> bool {
        self.api.is_some()
    }

    fn inner(&self) -> Result<&Client, AgentError> {
        self.inner.as_ref().ok_or_else(|| {
            AgentError::Http(
                "guest-agent HTTP client is disabled because OKOU_API_TOKEN is unset".into(),
            )
        })
    }

    fn api_config(&self) -> Result<&ApiHttpConfig, AgentError> {
        self.api
            .as_ref()
            .map(Arc::as_ref)
            .ok_or_else(|| {
                AgentError::Http(
                    "guest-agent API HTTP config is disabled; build the client with API config to send webhooks".into(),
                )
            })
    }

    fn api_config_from_values(
        base_url: &str,
        token: &str,
        vercel_bypass: &str,
        client_session_id: &str,
    ) -> Result<Option<ApiHttpConfig>, AgentError> {
        if token.is_empty() {
            return Ok(None);
        }

        Ok(Some(ApiHttpConfig::new(
            base_url.to_string(),
            token.to_string(),
            vercel_bypass.to_string(),
            client_session_id.to_string(),
        )?))
    }

    pub(crate) fn events_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.events)
    }

    fn session_output_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.session_output)
    }

    pub(crate) fn complete_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.complete)
    }

    pub(crate) fn heartbeat_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.heartbeat)
    }

    pub(crate) fn telemetry_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.telemetry)
    }

    pub(crate) fn checkpoint_prepare_history_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.checkpoint_prepare_history)
    }

    pub(crate) fn storage_prepare_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.storage_prepare)
    }

    pub(crate) fn storage_commit_url(&self) -> Result<&str, AgentError> {
        Ok(&self.api_config()?.urls.storage_commit)
    }

    fn active_input_receipt_url(
        &self,
        run_id: &str,
        delivery_id: &str,
    ) -> Result<String, AgentError> {
        Ok(urls::active_input_receipt_url(
            &self.api_config()?.base_url,
            run_id,
            delivery_id,
        ))
    }

    fn deferred_pi_handoff_url(&self, run_id: &str, offset: u64) -> Result<String, AgentError> {
        Ok(urls::deferred_pi_handoff_url(
            &self.api_config()?.base_url,
            run_id,
            offset,
        ))
    }
}

impl ApiHttpConfig {
    fn new(
        base_url: String,
        token: String,
        vercel_bypass: String,
        client_session_id: String,
    ) -> Result<Self, AgentError> {
        if base_url.is_empty() {
            return Err(AgentError::Http(
                "OKOU_API_BACKEND_URL is required when OKOU_API_TOKEN is set".into(),
            ));
        }
        if token.is_empty() {
            return Err(AgentError::Http(
                "OKOU_API_TOKEN is required for enabled API HTTP config".into(),
            ));
        }
        reqwest::header::HeaderValue::from_str(&client_session_id)
            .map_err(|e| AgentError::Http(format!("invalid client session id: {e}")))?;
        Ok(Self {
            base_url: base_url.clone(),
            urls: ApiUrls::new(&base_url),
            token,
            vercel_bypass,
            client_session_id,
        })
    }
}

impl ApiUrls {
    fn new(base_url: &str) -> Self {
        Self {
            events: urls::events_url(base_url),
            session_output: urls::session_output_url(base_url),
            complete: urls::complete_url(base_url),
            heartbeat: urls::heartbeat_url(base_url),
            telemetry: urls::telemetry_url(base_url),
            checkpoint_prepare_history: urls::checkpoint_prepare_history_url(base_url),
            storage_prepare: urls::storage_prepare_url(base_url),
            storage_commit: urls::storage_commit_url(base_url),
        }
    }
}

struct RetryRequest {
    builder: RequestBuilder,
    client_request_id: Option<String>,
}

impl RetryRequest {
    fn observed(builder: RequestBuilder, client_request_id: String) -> Self {
        Self {
            builder,
            client_request_id: Some(client_request_id),
        }
    }
}

async fn send_with_retry<
    BuildRequest,
    BuildRequestFuture,
    BuildClientError,
    ClientErrorFuture,
    BuildFinalError,
>(
    label: &str,
    max_attempts: u32,
    retry_delay: Duration,
    build_final_error: BuildFinalError,
    mut build_request: BuildRequest,
    mut build_client_error: BuildClientError,
    observer: Option<&dyn HttpAttemptObserver>,
) -> Result<Response, AgentError>
where
    BuildRequest: FnMut() -> BuildRequestFuture,
    BuildRequestFuture: Future<Output = Result<RetryRequest, AgentError>>,
    BuildClientError: FnMut(Response, u32, u32) -> ClientErrorFuture,
    ClientErrorFuture: Future<Output = AgentError>,
    BuildFinalError: FnOnce(Option<RetryableFailure>) -> AgentError,
{
    let mut last_retryable_failure = None;
    for attempt in 1..=max_attempts {
        let request = build_request().await?;
        let active_attempt =
            request
                .client_request_id
                .map(|client_request_id| HttpAttemptStarted {
                    attempt,
                    client_request_id,
                    started_at: Instant::now(),
                });
        if let Some(observer) = observer {
            let started = active_attempt.as_ref().ok_or_else(|| {
                AgentError::Execution(
                    "observed HTTP request omitted its client request ID".to_string(),
                )
            })?;
            observer.attempt_started(started.clone())?;
        }
        match request.builder.send().await {
            Ok(resp) if resp.status().is_success() => {
                observe_attempt_finished(observer, active_attempt, HttpAttemptOutcome::Success)?;
                return Ok(resp);
            }
            Ok(resp) => {
                let status = resp.status();
                let failure = RetryableFailure::from_status(status);
                observe_attempt_finished(observer, active_attempt, failure.attempt_outcome())?;
                // 4xx errors are deterministic except for rate limits.
                if status.is_client_error() && status.as_u16() != HTTP_TOO_MANY_REQUESTS {
                    return Err(build_client_error(resp, attempt, max_attempts).await);
                }
                last_retryable_failure = Some(failure);
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                );
            }
            Err(error) => {
                let failure = RetryableFailure::from_transport(&error);
                observe_attempt_finished(observer, active_attempt, failure.attempt_outcome())?;
                last_retryable_failure = Some(failure);
                let error = format_reqwest_error(error);
                log_warn!(
                    LOG_TAG,
                    "HTTP {label} failed (attempt {attempt}/{max_attempts}): {error}"
                );
            }
        }

        if attempt < max_attempts && !retry_delay.is_zero() {
            tokio::time::sleep(retry_delay).await;
        }
    }

    Err(build_final_error(last_retryable_failure))
}

fn observe_attempt_finished(
    observer: Option<&dyn HttpAttemptObserver>,
    started: Option<HttpAttemptStarted>,
    outcome: HttpAttemptOutcome,
) -> Result<(), AgentError> {
    let Some(observer) = observer else {
        return Ok(());
    };
    let started = started.ok_or_else(|| {
        AgentError::Execution("observed HTTP attempt lost its request context".to_string())
    })?;
    observer.attempt_finished(HttpAttemptFinished {
        attempt: started.attempt,
        client_request_id: started.client_request_id,
        elapsed_ms: u64::try_from(started.started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        outcome,
    })
}

async fn collect_response_body(
    mut response: Response,
    max_bytes: usize,
) -> Result<Bytes, ResponseBodyCollectionError> {
    let capacity = match response.content_length() {
        Some(length) if length > max_bytes as u64 => {
            return Err(ResponseBodyCollectionError::TooLarge);
        }
        Some(length) => {
            usize::try_from(length).map_err(|_| ResponseBodyCollectionError::TooLarge)?
        }
        None => 0,
    };
    let mut body = BytesMut::with_capacity(capacity);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(ResponseBodyCollectionError::Transport)?
    {
        let length = body
            .len()
            .checked_add(chunk.len())
            .ok_or(ResponseBodyCollectionError::TooLarge)?;
        if length > max_bytes {
            return Err(ResponseBodyCollectionError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }

    Ok(body.freeze())
}

async fn collect_api_success_body(response: Response) -> Result<Bytes, AgentError> {
    collect_response_body(response, constants::API_SUCCESS_RESPONSE_BODY_MAX_BYTES)
        .await
        .map_err(|error| match error {
            ResponseBodyCollectionError::TooLarge => {
                AgentError::Http(API_RESPONSE_BODY_TOO_LARGE_DIAGNOSTIC.to_string())
            }
            ResponseBodyCollectionError::Transport(error) => {
                AgentError::Http(format_reqwest_error(error))
            }
        })
}

impl HttpClient {
    /// POST JSON to a webhook endpoint with Bearer auth, Vercel bypass, and retry.
    ///
    /// `max_attempts` is the total request budget, including the initial request.
    /// Returns the parsed JSON response on success, or `None` if the response body
    /// is empty. Returns `Err` immediately on non-retriable 4xx errors (except 429),
    /// or after the attempt budget is exhausted for 5xx / 429 / network errors.
    pub async fn post_json(
        &self,
        url: &str,
        body: &impl Serialize,
        max_attempts: u32,
    ) -> Result<Option<Value>, AgentError> {
        let body = Bytes::from(serde_json::to_vec(body)?);
        self.post_json_bytes(url, body, max_attempts).await
    }

    pub(crate) async fn post_json_observed(
        &self,
        url: &str,
        body: &impl Serialize,
        max_attempts: u32,
        observer: &dyn HttpAttemptObserver,
    ) -> Result<Option<Value>, AgentError> {
        let body = Bytes::from(serde_json::to_vec(body)?);
        let resp = self
            .post_json_response(url, body, max_attempts, Some(observer), None)
            .await?;
        let body = collect_api_success_body(resp).await?;
        if body.is_empty() {
            return Ok(None);
        }
        let value =
            serde_json::from_slice(&body).map_err(|error| AgentError::Http(error.to_string()))?;
        Ok(Some(value))
    }

    pub(crate) async fn post_json_bytes(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
    ) -> Result<Option<Value>, AgentError> {
        let resp = self
            .post_json_response(url, body, max_attempts, None, None)
            .await?;

        let body = collect_api_success_body(resp).await?;
        if body.is_empty() {
            return Ok(None);
        }
        let val: Value =
            serde_json::from_slice(&body).map_err(|error| AgentError::Http(error.to_string()))?;
        Ok(Some(val))
    }

    pub(crate) async fn post_event_bytes(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
        observer: Option<&dyn HttpAttemptObserver>,
    ) -> Result<(), AgentError> {
        self.post_json_response(url, body, max_attempts, observer, None)
            .await?;
        Ok(())
    }

    /// Publish one best-effort session-output delta exactly once.
    ///
    /// A timeout can race with successful server publication, so this path must
    /// never retry. The caller stops previewing the affected text block and
    /// leaves reconciliation to the durable event path.
    pub(crate) async fn post_session_output(
        &self,
        body: &impl Serialize,
    ) -> Result<(), AgentError> {
        let url = self.session_output_url()?;
        let body = Bytes::from(serde_json::to_vec(body)?);
        self.post_json_response(url, body, 1, None, Some(SESSION_OUTPUT_REQUEST_TIMEOUT))
            .await?;
        Ok(())
    }

    /// Record one backend-accepted active-input delivery.
    ///
    /// The API operation is idempotent. Retry ownership remains with the
    /// active-input receipt runtime, so one call performs exactly one bounded
    /// HTTP attempt.
    pub async fn post_active_input_receipt(
        &self,
        run_id: &str,
        delivery_id: &str,
    ) -> Result<ActiveInputReceiptResponse, AgentError> {
        let url = self.active_input_receipt_url(run_id, delivery_id)?;
        let response = self
            .post_json_response(
                &url,
                Bytes::from_static(b"{}"),
                1,
                None,
                Some(Duration::from_secs(
                    constants::ACTIVE_INPUT_RECEIPT_TIMEOUT_SECS,
                )),
            )
            .await?;
        let body = collect_api_success_body(response).await?;
        serde_json::from_slice::<ActiveInputReceiptResponse>(&body)
            .map_err(|error| AgentError::Http(error.to_string()))
    }

    /// Read one authenticated deferred Pi handoff chunk exactly once.
    ///
    /// The guest owns the private Sandbox control token. It never forwards
    /// that credential to the CLI child; only the validated response bytes
    /// cross the child boundary through a private runtime file.
    pub(crate) async fn get_deferred_pi_handoff_chunk(
        &self,
        run_id: &str,
        offset: u64,
        request_timeout: Duration,
    ) -> Result<DeferredPiHandoffResponse, AgentError> {
        let url = self.deferred_pi_handoff_url(run_id, offset)?;
        let client = self.inner()?;
        let api = self.api_config()?;
        let response = send_with_retry(
            "deferred Pi handoff GET",
            1,
            Duration::ZERO,
            |failure| match failure {
                Some(RetryableFailure::HttpStatus(status)) => AgentError::HttpStatus {
                    status,
                    message: format!("Deferred Pi handoff read failed: HTTP {status}"),
                },
                Some(RetryableFailure::Timeout { .. }) => {
                    AgentError::Http("Deferred Pi handoff read timed out".to_string())
                }
                Some(RetryableFailure::Connect | RetryableFailure::Transport) | None => {
                    AgentError::Http("Deferred Pi handoff transport failed".to_string())
                }
            },
            || {
                let request_id = Uuid::new_v4().to_string();
                let mut request = client
                    .get(&url)
                    .timeout(request_timeout)
                    .header("Authorization", format!("Bearer {}", api.token));
                if !api.vercel_bypass.is_empty() {
                    request = request.header("x-vercel-protection-bypass", &api.vercel_bypass);
                }
                request = request
                    .header(CLIENT_VERSION_HEADER, GUEST_AGENT_CLIENT_VERSION)
                    .header(CLIENT_TYPE_HEADER, CLIENT_TYPE_GUEST_AGENT)
                    .header(CLIENT_SESSION_ID_HEADER, api.client_session_id.as_str())
                    .header(CLIENT_REQUEST_ID_HEADER, &request_id);
                std::future::ready(Ok(RetryRequest::observed(request, request_id)))
            },
            |response, _, _| async move {
                let status = response.status().as_u16();
                AgentError::HttpStatus {
                    status,
                    message: format!("Deferred Pi handoff read failed: HTTP {status}"),
                }
            },
            None,
        )
        .await?;
        let body = collect_response_body(response, PI_DEFERRED_HANDOFF_RESPONSE_MAX_BYTES)
            .await
            .map_err(|error| match error {
                ResponseBodyCollectionError::TooLarge => {
                    AgentError::Http("Deferred Pi handoff response exceeds its size limit".into())
                }
                ResponseBodyCollectionError::Transport(_) => {
                    AgentError::Http("Deferred Pi handoff response body could not be read".into())
                }
            })?;
        serde_json::from_slice(&body)
            .map_err(|_| AgentError::Http("Deferred Pi handoff response is malformed".into()))
    }

    async fn post_json_response(
        &self,
        url: &str,
        body: Bytes,
        max_attempts: u32,
        observer: Option<&dyn HttpAttemptObserver>,
        request_timeout: Option<Duration>,
    ) -> Result<Response, AgentError> {
        let client = self.inner()?;
        let api = self.api_config()?;
        send_with_retry(
            "POST",
            max_attempts,
            self.retry_delay,
            {
                let final_error = format!("POST failed after {max_attempts} attempts to {url}");
                move |_| AgentError::Http(final_error)
            },
            || {
                let request_id = Uuid::new_v4().to_string();
                let mut req = client
                    .post(url)
                    .header("Authorization", format!("Bearer {}", api.token))
                    .header(CONTENT_TYPE, "application/json")
                    .body(body.clone());

                if let Some(request_timeout) = request_timeout {
                    req = req.timeout(request_timeout);
                }

                if !api.vercel_bypass.is_empty() {
                    req = req.header("x-vercel-protection-bypass", &api.vercel_bypass);
                }

                req = req
                    .header(CLIENT_VERSION_HEADER, GUEST_AGENT_CLIENT_VERSION)
                    .header(CLIENT_TYPE_HEADER, CLIENT_TYPE_GUEST_AGENT)
                    .header(CLIENT_SESSION_ID_HEADER, api.client_session_id.as_str())
                    .header(CLIENT_REQUEST_ID_HEADER, &request_id);

                std::future::ready(Ok(RetryRequest::observed(req, request_id)))
            },
            |resp, attempt, max_attempts| {
                let url = url.to_owned();
                async move {
                    let status = resp.status();
                    let error_msg = match collect_response_body(
                        resp,
                        constants::API_ERROR_RESPONSE_BODY_MAX_BYTES,
                    )
                    .await
                    {
                        Ok(body) => serde_json::from_slice::<Value>(&body).ok().and_then(|value| {
                            value
                                .get("error")?
                                .get("message")?
                                .as_str()
                                .map(String::from)
                        }),
                        Err(ResponseBodyCollectionError::TooLarge) => {
                            log_warn!(
                                LOG_TAG,
                                "HTTP POST failed: HTTP {status} — {API_ERROR_RESPONSE_BODY_TOO_LARGE_DIAGNOSTIC}",
                            );
                            return AgentError::HttpStatus {
                                status: status.as_u16(),
                                message: format!(
                                    "HTTP {status}: {API_ERROR_RESPONSE_BODY_TOO_LARGE_DIAGNOSTIC}"
                                ),
                            };
                        }
                        Err(ResponseBodyCollectionError::Transport(_)) => None,
                    };

                    match error_msg {
                        Some(msg) => {
                            log_warn!(LOG_TAG, "HTTP POST failed: HTTP {status} — {msg}",);
                            AgentError::HttpStatus {
                                status: status.as_u16(),
                                message: format!("POST {url}: {msg}"),
                            }
                        }
                        None => {
                            log_warn!(
                                LOG_TAG,
                                "HTTP POST failed (attempt {attempt}/{max_attempts}): HTTP {status}",
                            );
                            AgentError::HttpStatus {
                                status: status.as_u16(),
                                message: format!("POST {url}: HTTP {status}"),
                            }
                        }
                    }
                }
            },
            observer,
        )
        .await
    }

    /// PUT raw bytes to a presigned S3 URL.
    ///
    /// No auth headers — the URL itself carries the authorization.
    /// Uses a per-request timeout override for longer uploads.
    pub async fn put_presigned(
        &self,
        url: &str,
        data: Bytes,
        content_type: &str,
    ) -> Result<(), AgentError> {
        let response = self
            .inner()?
            .put(url)
            .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
            .header("Content-Type", content_type)
            .body(data)
            .send()
            .await
            .map_err(|error| {
                AgentError::Http(format!("PUT presigned: {}", format_reqwest_error(error)))
            })?;
        if !response.status().is_success() {
            return Err(AgentError::Http(format!(
                "PUT presigned: HTTP {}",
                response.status()
            )));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Streaming file upload
// ---------------------------------------------------------------------------

/// Chunk size for streaming file reads (256 KB).
const STREAM_CHUNK_SIZE: usize = 256 * 1024;

fn next_chunk_size(remaining: u64) -> usize {
    usize::try_from(remaining)
        .unwrap_or(usize::MAX)
        .min(STREAM_CHUNK_SIZE)
}

pin_project! {
    /// HTTP body backed by an async file reader with a known size.
    ///
    /// Reports the remaining byte count via [`size_hint`](http_body::Body::size_hint),
    /// which lets hyper set `Content-Length` automatically — no chunked encoding,
    /// no manual header.
    struct SizedBody {
        #[pin]
        reader: tokio::fs::File,
        remaining: u64,
        buffer: BytesMut,
    }
}

impl SizedBody {
    fn new(reader: tokio::fs::File, remaining: u64) -> Self {
        Self {
            reader,
            remaining,
            buffer: BytesMut::with_capacity(next_chunk_size(remaining)),
        }
    }
}

impl http_body::Body for SizedBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = self.project();
        if *this.remaining == 0 {
            return Poll::Ready(None);
        }

        let buffer_len = this.buffer.len();
        let to_read = next_chunk_size(*this.remaining);
        let spare_capacity = this.buffer.capacity() - buffer_len;
        if spare_capacity < to_read {
            // `reserve` takes additional space relative to length, not capacity.
            this.buffer.reserve(to_read);
        }

        let Some(spare) = this.buffer.spare_capacity_mut().get_mut(..to_read) else {
            return Poll::Ready(Some(Err(std::io::Error::other(
                "failed to reserve streaming upload buffer",
            ))));
        };
        let mut read_buf = ReadBuf::uninit(spare);
        match this.reader.poll_read(cx, &mut read_buf) {
            Poll::Ready(Ok(())) => {
                let n = read_buf.filled().len();
                if n == 0 {
                    let missing = *this.remaining;
                    *this.remaining = 0;
                    return Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        format!("streaming upload source ended {missing} bytes early"),
                    ))));
                }
                // SAFETY: `poll_read` initialized exactly `n` bytes in the spare
                // capacity exposed to `ReadBuf` above.
                unsafe {
                    this.buffer.set_len(buffer_len + n);
                }
                let frame_data = this.buffer.split_to(n).freeze();
                debug_assert!((n as u64) <= *this.remaining);
                *this.remaining -= n as u64;
                Poll::Ready(Some(Ok(Frame::data(frame_data))))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.remaining == 0
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

impl HttpClient {
    /// PUT a file to a presigned S3 URL by streaming from disk.
    ///
    /// Unlike [`Self::put_presigned`], this avoids loading the entire file into
    /// memory. A `SizedBody` streams bounded chunks and reports the file size via
    /// `size_hint`, so hyper sets `Content-Length` automatically.
    pub async fn put_presigned_file(
        &self,
        url: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<(), AgentError> {
        let client = self.inner()?;
        let file = tokio::fs::File::open(path).await?;
        let file_len = file.metadata().await?.len();
        let body = reqwest::Body::wrap(SizedBody::new(file, file_len));
        let response = client
            .put(url)
            .timeout(Duration::from_secs(constants::HTTP_UPLOAD_TIMEOUT_SECS))
            .header("Content-Type", content_type)
            .body(body)
            .send()
            .await
            .map_err(|error| {
                AgentError::Http(format!("PUT presigned: {}", format_reqwest_error(error)))
            })?;
        if !response.status().is_success() {
            return Err(AgentError::Http(format!(
                "PUT presigned: HTTP {}",
                response.status()
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Body as _;
    use std::future::poll_fn;

    #[test]
    fn completed_http_failures_preserve_diagnostic_wire_facts() {
        let cases = [
            (
                RetryableFailure::HttpStatus(503),
                serde_json::json!({ "failureKind": "http_status", "httpStatus": 503 }),
            ),
            (
                RetryableFailure::Timeout {
                    connect_observed: false,
                },
                serde_json::json!({
                    "failureKind": "timeout",
                    "timeoutObserved": true,
                    "connectObserved": false
                }),
            ),
            (
                RetryableFailure::Timeout {
                    connect_observed: true,
                },
                serde_json::json!({
                    "failureKind": "timeout",
                    "timeoutObserved": true,
                    "connectObserved": true
                }),
            ),
            (
                RetryableFailure::Connect,
                serde_json::json!({
                    "failureKind": "connect",
                    "timeoutObserved": false,
                    "connectObserved": true
                }),
            ),
            (
                RetryableFailure::Transport,
                serde_json::json!({
                    "failureKind": "transport",
                    "timeoutObserved": false,
                    "connectObserved": false
                }),
            ),
        ];

        for (failure, mut expected) in cases {
            let diagnostic = HttpAttemptFinished {
                attempt: 3,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 12_345,
                outcome: failure.attempt_outcome(),
            }
            .into_failure_diagnostic()
            .expect("failed attempt should retain its diagnostic");

            expected["attempt"] = serde_json::json!(3);
            expected["clientRequestId"] = serde_json::json!("11111111-1111-4111-8111-111111111111");
            expected["elapsedMs"] = serde_json::json!(12_345);
            assert_eq!(diagnostic.failure_kind.as_str(), expected["failureKind"]);
            assert_eq!(serde_json::to_value(&diagnostic).unwrap(), expected);
        }
    }

    #[test]
    fn completed_http_success_has_no_failure_diagnostic() {
        let attempt = HttpAttemptFinished {
            attempt: 2,
            client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
            elapsed_ms: 17,
            outcome: HttpAttemptOutcome::Success,
        };

        assert_eq!(attempt.into_failure_diagnostic(), None);
    }

    async fn sized_body_from_bytes(data: &[u8]) -> (tempfile::TempDir, SizedBody) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, data).await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        (dir, SizedBody::new(file, file_len))
    }

    async fn next_data(body: &mut SizedBody) -> Option<Bytes> {
        let frame = poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx))
            .await
            .transpose()
            .unwrap()?;
        match frame.into_data() {
            Ok(data) => Some(data),
            Err(_) => panic!("expected data frame"),
        }
    }

    #[tokio::test]
    async fn disabled_client_fails_before_request_build() {
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
        let result = client
            .post_json("http://127.0.0.1:1/test", &serde_json::json!({}), 1)
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn disabled_client_raw_upload_fails_before_request_build() {
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
        let result = client
            .put_presigned(
                "http://127.0.0.1:1/upload",
                Bytes::from_static(b"manifest"),
                "application/json",
            )
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn disabled_client_stream_upload_fails_before_file_open() {
        let client = HttpClient {
            inner: None,
            retry_delay: DEFAULT_RETRY_DELAY,
            api: None,
        };
        let result = client
            .put_presigned_file(
                "http://127.0.0.1:1/upload",
                Path::new("/definitely/missing/source.bin"),
                "application/octet-stream",
            )
            .await;

        let Err(AgentError::Http(message)) = result else {
            panic!("expected disabled HTTP client error");
        };
        assert!(message.contains("HTTP client is disabled"));
    }

    #[tokio::test]
    async fn sized_body_streams_large_file_in_bounded_chunks() {
        let data: Vec<u8> = (0..(STREAM_CHUNK_SIZE * 2 + 37))
            .map(|i| (i % 251) as u8)
            .collect();
        for read_size in [STREAM_CHUNK_SIZE, 8192] {
            for retain_frames in [false, true] {
                let (_dir, mut body) = sized_body_from_bytes(&data).await;
                // Force legal short reads through the real file reader.
                body.reader.set_max_buf_size(read_size);

                let mut remaining = data.len() as u64;
                assert_eq!(body.size_hint().exact(), Some(remaining));
                assert!(!body.is_end_stream());

                let mut chunks = 0;
                let mut uploaded = Vec::with_capacity(data.len());
                let mut retained = Vec::new();
                while let Some(chunk) = next_data(&mut body).await {
                    assert!(!chunk.is_empty());
                    assert!(chunk.len() <= read_size);
                    chunks += 1;
                    remaining -= chunk.len() as u64;
                    assert_eq!(body.size_hint().exact(), Some(remaining));
                    assert_eq!(body.is_end_stream(), remaining == 0);
                    uploaded.extend_from_slice(&chunk);
                    if retain_frames {
                        retained.push(chunk);
                    }
                }

                assert!(chunks > 1);
                assert_eq!(uploaded, data);
                if retain_frames {
                    assert_eq!(retained.concat(), data);
                }
                assert_eq!(body.size_hint().exact(), Some(0));
                assert!(body.is_end_stream());
                assert!(next_data(&mut body).await.is_none());
            }
        }
    }

    #[tokio::test]
    async fn sized_body_streams_small_file_once() {
        let data = b"streaming body";
        let (_dir, mut body) = sized_body_from_bytes(data).await;

        assert_eq!(body.size_hint().exact(), Some(data.len() as u64));
        let chunk = next_data(&mut body).await.unwrap();

        assert_eq!(&chunk[..], data);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_streams_exact_chunk_once() {
        let data = vec![0x5Au8; STREAM_CHUNK_SIZE];
        let (_dir, mut body) = sized_body_from_bytes(&data).await;

        assert_eq!(body.size_hint().exact(), Some(STREAM_CHUNK_SIZE as u64));
        let chunk = next_data(&mut body).await.unwrap();

        assert_eq!(chunk.len(), STREAM_CHUNK_SIZE);
        assert_eq!(&chunk[..], &data[..]);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(body.is_end_stream());
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_empty_file_has_no_frames() {
        let (_dir, mut body) = sized_body_from_bytes(&[]).await;

        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
        assert!(body.is_end_stream());
    }

    #[tokio::test]
    async fn sized_body_does_not_stream_bytes_added_after_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, b"initial-extra").await.unwrap();

        let chunk = next_data(&mut body).await.unwrap();
        assert_eq!(&chunk[..], b"initial");
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(next_data(&mut body).await.is_none());
    }

    #[tokio::test]
    async fn sized_body_errors_when_file_is_shorter_than_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial-extra").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, b"initial").await.unwrap();

        let chunk = next_data(&mut body).await.unwrap();
        assert_eq!(&chunk[..], b"initial");
        let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .expect("expected a frame")
            .expect_err("expected early EOF error");

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(body.size_hint().exact(), Some(0));
    }

    #[tokio::test]
    async fn sized_body_errors_when_file_is_truncated_before_first_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.bin");
        tokio::fs::write(&path, b"initial").await.unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let file_len = file.metadata().await.unwrap().len();
        let mut body = SizedBody::new(file, file_len);

        tokio::fs::write(&path, &[]).await.unwrap();

        let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .expect("expected a frame")
            .expect_err("expected early EOF error");

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(body.size_hint().exact(), Some(0));
        assert!(body.is_end_stream());
    }
}
