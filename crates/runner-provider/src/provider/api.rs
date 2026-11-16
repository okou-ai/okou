//! Reporting and control ownership for directly supplied API work.
mod execution_inputs;
mod response_decode;
use super::api_ably_supervisor::{AblySupervisor, AblySupervisorConfig};
use super::api_cancellation_reconciliation::CancellationReconciliation;
use super::builtin_firewall_catalog::{
    BuiltinFirewallCatalog, BuiltinFirewallCatalogRefreshController,
};
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::{
    CompletionAuth, CompletionAuthError, CompletionReportTiming, ExecutionJob, JobProvider,
};
use crate::active_input::{ActiveInputNotifications, ActiveInputSource};
use crate::duration::duration_ms;
use crate::error::{
    ApiBodyReadError, ApiFailureKind, ApiStatusError, ApiTransportCause, ApiTransportError,
    ProviderError, ProviderResult,
};
use crate::http::{ApiRequestBuilder, HttpClient};
use crate::run_cancellation::RunCancellationRegistry;
use api_contracts::generated::{
    constants::runners::{
        BUILTIN_FIREWALL_CATALOG_MAX_BYTES, CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
    },
    routes,
    types::runners::runs::steerable_inputs::next::Response as NextSteerableInputResponse,
};
pub use execution_inputs::decode_execution_publication;
use reqwest::{Response, StatusCode};
use response_decode::{ApiDecodePath, decode_api_json, decode_api_json_bytes};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;
use runner_types::types::{
    CompleteRequest, ConnectorRuntimeSyncBatchResponse, ConnectorRuntimeTargetRegistration,
    ExecutionContext, HeartbeatState,
};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

fn supports_thread_active_input(reuse_key: Option<&str>) -> bool {
    reuse_key.is_some_and(|key| key.starts_with("thread:"))
}

pub(super) enum ConnectorRuntimeSyncOutcome {
    Synced(ConnectorRuntimeSyncBatchResponse),
    RunTerminal,
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorDetails,
}

#[derive(Deserialize)]
struct ApiErrorDetails {
    code: String,
    #[serde(rename = "message")]
    _message: String,
}

// Only a complete response can carry a structured terminal outcome.
struct ApiErrorBody {
    text: String,
    complete: bool,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Report sustained heartbeat delivery failures independently of routine cadence.
const HEARTBEAT_DEGRADED_AFTER: Duration = Duration::from_secs(30);
// The full catalog is multi-megabyte. This budget covers connection setup,
// response headers and the entire body, rather than restarting for each chunk.
const BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT: Duration = Duration::from_secs(60);

// Diagnostic bytes only, before UTF8-lossy conversion. Successful payloads and
// the builtin catalog retain their own contracts and response-body limits.
const API_ERROR_BODY_MAX_BYTES: usize = 64 * 1024;
const API_ERROR_BODY_TRUNCATED: &str = "\n[response body truncated]";

struct DegradationEpisode {
    started_at: Instant,
    consecutive_failures: u64,
    degradation_emitted: bool,
}

#[derive(Clone, Copy)]
pub(super) struct DegradationObservation {
    pub(super) consecutive_failures: u64,
    pub(super) failure_elapsed: Duration,
    pub(super) degraded: bool,
    pub(super) emit_degradation: bool,
}

#[derive(Clone, Copy)]
pub(super) struct DegradationRecovery {
    pub(super) recovered_after_failures: u64,
    pub(super) failure_elapsed: Duration,
    pub(super) was_degraded: bool,
}

pub(super) struct DegradationEpisodeTracker {
    active_episode: Mutex<Option<DegradationEpisode>>,
}

impl DegradationEpisodeTracker {
    pub(super) fn new() -> Self {
        Self {
            active_episode: Mutex::new(None),
        }
    }

    pub(super) async fn observe_failure(
        &self,
        now: Instant,
        degraded_after: Duration,
    ) -> DegradationObservation {
        let mut active_episode = self.active_episode.lock().await;
        let episode = active_episode.get_or_insert(DegradationEpisode {
            started_at: now,
            consecutive_failures: 0,
            degradation_emitted: false,
        });
        episode.consecutive_failures = episode.consecutive_failures.saturating_add(1);
        let failure_elapsed = now.saturating_duration_since(episode.started_at);
        let emit_degradation = failure_elapsed >= degraded_after && !episode.degradation_emitted;
        if emit_degradation {
            episode.degradation_emitted = true;
        }

        DegradationObservation {
            consecutive_failures: episode.consecutive_failures,
            failure_elapsed,
            degraded: episode.degradation_emitted,
            emit_degradation,
        }
    }

    pub(super) async fn recover(&self, now: Instant) -> Option<DegradationRecovery> {
        self.active_episode
            .lock()
            .await
            .take()
            .map(|episode| DegradationRecovery {
                recovered_after_failures: episode.consecutive_failures,
                failure_elapsed: now.saturating_duration_since(episode.started_at),
                was_degraded: episode.degradation_emitted,
            })
    }
}

// ---------------------------------------------------------------------------
// ApiProvider
// ---------------------------------------------------------------------------

pub struct ApiProvider {
    api: ApiClient,
    group: String,
    ably_supervisor: Mutex<Option<AblySupervisor>>,
    cancel_tokens: RunCancellationRegistry,
    cancellation_reconciliation: CancellationReconciliation,
    connector_runtime_sync: ConnectorRuntimeSyncHandle,
    ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController,
    active_input_notifications: ActiveInputNotifications,
    heartbeat_degradation_tracker: DegradationEpisodeTracker,
    cancel: CancellationToken,
}

pub struct BuiltinFirewallCatalogCachePaths {
    pub cache_path: PathBuf,
    pub lock_path: PathBuf,
}

pub struct ApiProviderConfig {
    pub ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    pub runner_identity: RunnerProcessIdentity,
    pub group: String,
}

impl ApiProvider {
    /// Create the reporting/control owner for direct work.
    pub fn new(
        http: HttpClient,
        token: String,
        config: ApiProviderConfig,
        builtin_firewall_catalog_cache_paths: BuiltinFirewallCatalogCachePaths,
        cancel: CancellationToken,
        cancel_tokens: RunCancellationRegistry,
    ) -> Arc<Self> {
        let cancellation_reconciliation = CancellationReconciliation::new(
            http.clone(),
            config.group.clone(),
            config.runner_identity,
        );
        let api = ApiClient::new(http, token);
        let connector_runtime_sync = ConnectorRuntimeSyncHandle::new(api.clone());
        let builtin_firewall_catalog_refresh = BuiltinFirewallCatalogRefreshController::new(
            api.clone(),
            builtin_firewall_catalog_cache_paths.cache_path,
            builtin_firewall_catalog_cache_paths.lock_path,
            cancel.clone(),
        );
        Arc::new(Self {
            api,
            group: config.group,
            ably_supervisor: Mutex::new(None),
            cancel_tokens,
            cancellation_reconciliation,
            connector_runtime_sync,
            ably_side_message_handler: config.ably_side_message_handler,
            builtin_firewall_catalog_refresh,
            active_input_notifications: ActiveInputNotifications::new(),
            heartbeat_degradation_tracker: DegradationEpisodeTracker::new(),
            cancel,
        })
    }

    pub fn connector_runtime_sync_handle(&self) -> ConnectorRuntimeSyncHandle {
        self.connector_runtime_sync.clone()
    }

    async fn ensure_ably_supervisor_started(&self) {
        let mut ably_supervisor = self.ably_supervisor.lock().await;
        if ably_supervisor.is_some() {
            return;
        }

        *ably_supervisor = Some(AblySupervisor::spawn(AblySupervisorConfig {
            api: self.api.clone(),
            group: self.group.clone(),
            cancel_tokens: self.cancel_tokens.clone(),
            connector_runtime_sync: self.connector_runtime_sync.clone(),
            ably_side_message_handler: self.ably_side_message_handler.clone(),
            active_input_notifications: self.active_input_notifications.clone(),
            provider_cancel: self.cancel.clone(),
        }));
    }

    async fn record_heartbeat_failure_at(
        &self,
        state: &HeartbeatState,
        error: &ProviderError,
        now: Instant,
    ) {
        let retryable = matches!(state.mode.as_str(), "starting" | "running" | "draining")
            && match error {
                ProviderError::ApiStatus(api_error) => api_error.status.as_u16() == 520,
                _ => eligible_heartbeat_transport_error(error).is_some(),
            };
        let observation = if retryable {
            Some(
                self.heartbeat_degradation_tracker
                    .observe_failure(now, HEARTBEAT_DEGRADED_AFTER)
                    .await,
            )
        } else {
            None
        };

        log_heartbeat_failure(state, error, observation);
    }

    async fn record_heartbeat_success_at(&self, state: &HeartbeatState, now: Instant) {
        let recovery = self.heartbeat_degradation_tracker.recover(now).await;

        if let Some(recovery) = recovery {
            log_heartbeat_recovery(state, recovery);
        }
    }
}

#[async_trait::async_trait]
impl JobProvider for ApiProvider {
    async fn prepare_startup_readiness(&self) -> ProviderResult<()> {
        self.builtin_firewall_catalog_refresh
            .prepare_startup_readiness()
            .await?;
        if self.cancel.is_cancelled() {
            return Err(ProviderError::Internal(
                "provider startup readiness cancelled".to_string(),
            ));
        }
        self.ensure_ably_supervisor_started().await;
        Ok(())
    }

    async fn bind_supplied(&self, context: ExecutionContext) -> ProviderResult<ExecutionJob> {
        let run_id = context.run_id;
        let source = supports_thread_active_input(context.reuse_key.as_deref()).then(|| {
            ActiveInputSource::api(
                self.api.clone(),
                run_id,
                context.sandbox_token.clone(),
                self.active_input_notifications.subscribe(run_id),
            )
        });
        if let Some(handle) = self.cancel_tokens.handle(run_id).await {
            self.cancellation_reconciliation
                .observe(run_id, handle, context.sandbox_token.clone());
        }
        Ok(ExecutionJob::supplied(context, source))
    }

    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
        let result = self.api.heartbeat(state).await;
        match &result {
            Ok(()) => {
                self.record_heartbeat_success_at(state, Instant::now())
                    .await
            }
            Err(error) => {
                self.record_heartbeat_failure_at(state, error, Instant::now())
                    .await
            }
        }
        result
    }

    async fn shutdown(&self) {
        self.cancellation_reconciliation.shutdown().await;
        {
            let mut owner = self.ably_supervisor.lock().await;
            if let Some(supervisor) = owner.as_ref() {
                supervisor.shutdown().await;
                *owner = None;
            }
        }
        self.connector_runtime_sync.shutdown().await;
        self.builtin_firewall_catalog_refresh.shutdown().await;
    }

    fn completion_report_timing(&self) -> CompletionReportTiming {
        CompletionReportTiming::ConcurrentWithFinalization
    }

    async fn complete(&self, request: CompleteRequest, completion_auth: CompletionAuth) {
        let run_id = request.run_id;
        let token = match completion_auth.into_sandbox_token(run_id) {
            Ok(token) => token,
            Err(CompletionAuthError::NotSandbox) => {
                error!(run_id = %run_id, "completion auth missing sandbox token");
                return;
            }
            Err(CompletionAuthError::RunIdMismatch { auth_run_id }) => {
                error!(
                    run_id = %run_id,
                    auth_run_id = %auth_run_id,
                    "completion auth run_id mismatch"
                );
                return;
            }
        };

        if let Err(error) = self.api.complete(&token, &request).await {
            let (status, failure_kind) = match &error {
                ProviderError::ApiStatus(error) => (error.status.as_str(), "http_status"),
                ProviderError::ApiTransport(error) => ("", error.failure_kind.as_str()),
                _ => ("", "local"),
            };
            error!(run_id = %run_id, error = %error, status, failure_kind, "failed to report completion");
        }
    }
}

fn log_heartbeat_failure(
    state: &HeartbeatState,
    error: &ProviderError,
    observation: Option<DegradationObservation>,
) {
    let reusable_sandboxes = state.held_sandbox_states.len();
    let home_states = state.held_home_states.len();
    if let ProviderError::ApiTransport(api_error) = error {
        if let Some(observation) = observation {
            log_retryable_heartbeat_failure(state, error, api_error, observation);
            return;
        }
        let request = &api_error.request;
        warn!(
            error = %error,
            endpoint = request.endpoint_label,
            method = %request.method,
            host = %request.host,
            path = %request.path,
            client_request_id = %request.client_request_id,
            client_session_id = %request.client_session_id,
            client_version = %request.client_version,
            failure_kind = api_error.failure_kind.as_str(),
            failure_cause = api_error.failure_cause.as_str(),
            error_summary = %api_error.summary,
            runner_id = %state.runner_id,
            runner_group = %state.group,
            mode = %state.mode,
            running = state.running_count,
            reusable_sandboxes,
            home_states,
            "heartbeat failed"
        );
        return;
    }

    if let ProviderError::ApiStatus(api_error) = error {
        if let Some(observation) = observation {
            let failure_elapsed_ms = duration_ms(observation.failure_elapsed);
            if observation.emit_degradation {
                warn!(
                    endpoint = api_error.endpoint_label,
                    status = api_error.status.as_u16(),
                    failure_kind = "http_status",
                    runner_id = %state.runner_id,
                    runner_group = %state.group,
                    mode = %state.mode,
                    running = state.running_count,
                    reusable_sandboxes,
                    home_states,
                    consecutive_failures = observation.consecutive_failures,
                    failure_elapsed_ms,
                    will_retry = true,
                    degraded = observation.degraded,
                    "heartbeat delivery degraded"
                );
            } else {
                info!(
                    endpoint = api_error.endpoint_label,
                    status = api_error.status.as_u16(),
                    failure_kind = "http_status",
                    runner_id = %state.runner_id,
                    runner_group = %state.group,
                    mode = %state.mode,
                    running = state.running_count,
                    reusable_sandboxes,
                    home_states,
                    consecutive_failures = observation.consecutive_failures,
                    failure_elapsed_ms,
                    will_retry = true,
                    degraded = observation.degraded,
                    "heartbeat failed, will retry"
                );
            }
        } else {
            warn!(
                endpoint = api_error.endpoint_label,
                status = api_error.status.as_u16(),
                failure_kind = "http_status",
                runner_id = %state.runner_id,
                runner_group = %state.group,
                mode = %state.mode,
                running = state.running_count,
                reusable_sandboxes,
                home_states,
                "heartbeat failed"
            );
        }
        return;
    }

    warn!(
        error = %error,
        runner_id = %state.runner_id,
        runner_group = %state.group,
        mode = %state.mode,
        running = state.running_count,
        reusable_sandboxes,
        home_states,
        "heartbeat failed"
    );
}

fn eligible_heartbeat_transport_error(error: &ProviderError) -> Option<&ApiTransportError> {
    let ProviderError::ApiTransport(api_error) = error else {
        return None;
    };
    (matches!(
        api_error.failure_kind,
        ApiFailureKind::Timeout | ApiFailureKind::Connect
    ) || api_error.failure_cause == ApiTransportCause::ConnectionReset
        || matches!(
            (api_error.failure_kind, api_error.failure_cause),
            (
                ApiFailureKind::Request,
                ApiTransportCause::UnexpectedEof | ApiTransportCause::HttpIncompleteMessage
            )
        ))
    .then_some(api_error)
}

fn log_retryable_heartbeat_failure(
    state: &HeartbeatState,
    error: &ProviderError,
    api_error: &ApiTransportError,
    observation: DegradationObservation,
) {
    let request = &api_error.request;
    let reusable_sandboxes = state.held_sandbox_states.len();
    let home_states = state.held_home_states.len();
    let failure_elapsed_ms = duration_ms(observation.failure_elapsed);

    if observation.emit_degradation {
        warn!(
            error = %error,
            endpoint = request.endpoint_label,
            method = %request.method,
            host = %request.host,
            path = %request.path,
            client_request_id = %request.client_request_id,
            client_session_id = %request.client_session_id,
            client_version = %request.client_version,
            failure_kind = api_error.failure_kind.as_str(),
            failure_cause = api_error.failure_cause.as_str(),
            error_summary = %api_error.summary,
            runner_id = %state.runner_id,
            runner_group = %state.group,
            mode = %state.mode,
            running = state.running_count,
            reusable_sandboxes,
            home_states,
            consecutive_failures = observation.consecutive_failures,
            failure_elapsed_ms,
            will_retry = true,
            degraded = observation.degraded,
            "heartbeat delivery degraded"
        );
        return;
    }

    info!(
        error = %error,
        endpoint = request.endpoint_label,
        method = %request.method,
        host = %request.host,
        path = %request.path,
        client_request_id = %request.client_request_id,
        client_session_id = %request.client_session_id,
        client_version = %request.client_version,
        failure_kind = api_error.failure_kind.as_str(),
        failure_cause = api_error.failure_cause.as_str(),
        error_summary = %api_error.summary,
        runner_id = %state.runner_id,
        runner_group = %state.group,
        mode = %state.mode,
        running = state.running_count,
        reusable_sandboxes,
        home_states,
        consecutive_failures = observation.consecutive_failures,
        failure_elapsed_ms,
        will_retry = true,
        degraded = observation.degraded,
        "heartbeat failed, will retry"
    );
}

fn log_heartbeat_recovery(state: &HeartbeatState, recovery: DegradationRecovery) {
    info!(
        runner_id = %state.runner_id,
        runner_group = %state.group,
        mode = %state.mode,
        running = state.running_count,
        reusable_sandboxes = state.held_sandbox_states.len(),
        home_states = state.held_home_states.len(),
        recovered_after_failures = recovery.recovered_after_failures,
        failure_elapsed_ms = duration_ms(recovery.failure_elapsed),
        was_degraded = recovery.was_degraded,
        "heartbeat delivery recovered"
    );
}

// ---------------------------------------------------------------------------
// ApiClient (HTTP transport)
// ---------------------------------------------------------------------------

/// Low-level HTTP client for the runner API endpoints.
#[derive(Clone)]
pub struct ApiClient {
    http: HttpClient,
    token: String,
}

impl ApiClient {
    pub fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    pub(crate) async fn next_steerable_input(
        &self,
        run_id: RunId,
        sandbox_token: &str,
    ) -> ProviderResult<NextSteerableInputResponse> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.http.request_resolved_route(
                routes::runners::runs::by_run_id::steerable_inputs::next::route(
                    routes::runners::runs::by_run_id::steerable_inputs::next::Params {
                        run_id: run_id.as_str(),
                    },
                ),
                sandbox_token,
            ),
            "read next steerable input",
        )
        .await?;
        let resp = check_api_status(resp, "read next steerable input").await?;
        decode_api_json(resp, "read next steerable input").await
    }

    /// Send a heartbeat with runner state. The default API timeout allows for
    /// cold starts while bounding this request and lifecycle drain waits.
    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
        let resp = send_api(
            self.http
                .request_route(routes::runners::heartbeat::HEARTBEAT, &self.token)
                .json(state)
                .idempotent(),
            "heartbeat",
        )
        .await?;

        check_api_status(resp, "heartbeat").await?;

        Ok(())
    }

    /// Report job completion. Uses the per-job **sandbox token** for auth.
    async fn complete(&self, sandbox_token: &str, request: &CompleteRequest) -> ProviderResult<()> {
        let resp = send_api(
            self.http
                .request_route(routes::webhooks::agent::complete::COMPLETE, sandbox_token)
                .json(request)
                .retry_transient(3, Duration::from_secs(2)),
            "complete",
        )
        .await?;

        check_api_status(resp, "complete").await?;

        Ok(())
    }

    /// Fetch an Ably token for subscribing to runner group notifications.
    pub(super) async fn realtime_token(
        &self,
        group: &str,
    ) -> ProviderResult<ably_subscriber::TokenRequest> {
        let resp = send_api(
            self.http
                .request_route(routes::runners::realtime::token::CREATE, &self.token)
                .json(&serde_json::json!({ "group": group })),
            "realtime token",
        )
        .await?;

        let resp = check_api_status(resp, "realtime token").await?;
        decode_api_json(resp, "realtime token").await
    }

    pub(super) async fn sync_connector_runtime(
        &self,
        run_id: RunId,
        targets: &[ConnectorRuntimeTargetRegistration],
    ) -> ProviderResult<ConnectorRuntimeSyncOutcome> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.connector_runtime_sync_request(&run_id, targets),
            "connector runtime sync",
        )
        .await?;

        if resp.status() == StatusCode::CONFLICT {
            let (status, body) = read_api_error(resp).await;
            if body.complete
                && serde_json::from_str::<ApiErrorEnvelope>(&body.text).is_ok_and(|response| {
                    response.error.code == CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE
                })
            {
                return Ok(ConnectorRuntimeSyncOutcome::RunTerminal);
            }
            return Err(api_status_error(
                "connector runtime sync",
                status,
                body.text,
            ));
        }

        let resp = check_api_status(resp, "connector runtime sync").await?;
        decode_api_json(resp, "connector runtime sync")
            .await
            .map(ConnectorRuntimeSyncOutcome::Synced)
    }

    fn connector_runtime_sync_request(
        &self,
        run_id: &str,
        targets: &[ConnectorRuntimeTargetRegistration],
    ) -> ApiRequestBuilder {
        self.http
            .request_resolved_route(
                routes::runners::runs::by_run_id::connector_runtime::sync::route(
                    routes::runners::runs::by_run_id::connector_runtime::sync::Params { run_id },
                ),
                &self.token,
            )
            .json(&serde_json::json!({ "targets": targets }))
    }

    pub(super) async fn resolve_builtin_firewall_catalog(
        &self,
    ) -> ProviderResult<BuiltinFirewallCatalog> {
        const LABEL: &str = "builtin firewall catalog resolve";

        let mut resp = send_api(self.builtin_firewall_catalog_resolve_request(), LABEL).await?;

        let status = resp.status();
        let max_bytes = BUILTIN_FIREWALL_CATALOG_MAX_BYTES;
        let content_length = resp.content_length();
        if content_length.is_some_and(|length| length > max_bytes) {
            return Err(ProviderError::Api(format!(
                "{LABEL} response body exceeds {max_bytes} bytes"
            )));
        }

        let initial_capacity = content_length
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or_default();
        let mut body = Vec::with_capacity(initial_capacity);
        let mut body_len = 0_u64;
        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) if !status.is_success() => return Err(api_status_error(LABEL, status, "")),
                Err(error) => {
                    let content_type = match resp.headers().get(reqwest::header::CONTENT_TYPE) {
                        None => "missing",
                        Some(value) => match value.to_str() {
                            Err(_) => "invalid",
                            Ok(value) => {
                                let media_type = value
                                    .split_once(';')
                                    .map_or(value, |(media_type, _)| media_type)
                                    .trim();
                                if media_type.eq_ignore_ascii_case("application/json") {
                                    "application/json"
                                } else {
                                    "other"
                                }
                            }
                        },
                    };
                    return Err(ProviderError::ApiBodyRead(Box::new(ApiBodyReadError {
                        endpoint_label: LABEL,
                        status,
                        content_type,
                        content_length,
                        received_bytes: body_len,
                        failure_cause: crate::http::api_transport_cause(&error),
                    })));
                }
            };
            let chunk_len = u64::try_from(chunk.len()).map_err(|error| {
                ProviderError::Api(format!("{LABEL} response body chunk length: {error}"))
            })?;
            let next_body_len = body_len.checked_add(chunk_len).ok_or_else(|| {
                ProviderError::Api(format!("{LABEL} response body length overflow"))
            })?;
            if next_body_len > max_bytes {
                return Err(ProviderError::Api(format!(
                    "{LABEL} response body exceeds {max_bytes} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
            body_len = next_body_len;
        }

        if !status.is_success() {
            return Err(api_status_error(
                LABEL,
                status,
                String::from_utf8_lossy(&body).into_owned(),
            ));
        }
        let catalog: BuiltinFirewallCatalog = decode_api_json_bytes(&body)
            .map_err(|e| ProviderError::Api(format!("{LABEL} decode: {e}")))?;
        catalog.validate_for_api_response().map_err(|e| {
            ProviderError::Api(format!(
                "builtin firewall catalog resolve invalid catalog: {e}"
            ))
        })?;
        Ok(catalog)
    }

    fn builtin_firewall_catalog_resolve_request(&self) -> ApiRequestBuilder {
        self.http
            .request_route(
                routes::runners::builtin_firewalls::resolve::RESOLVE,
                &self.token,
            )
            .timeout(BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
            .json(&serde_json::json!({}))
            .idempotent()
    }
}

async fn send_api(req: ApiRequestBuilder, label: &'static str) -> ProviderResult<Response> {
    match req.send(label).await {
        Ok(resp) => Ok(resp),
        Err(ProviderError::Api(message)) => Err(ProviderError::Api(format!("{label}: {message}"))),
        Err(error) => Err(error),
    }
}

async fn check_api_status(resp: Response, label: &'static str) -> ProviderResult<Response> {
    let status = resp.status();
    if !status.is_success() {
        let (status, body) = read_api_error(resp).await;
        return Err(api_status_error(label, status, body.text));
    }
    Ok(resp)
}

async fn read_api_error(mut resp: Response) -> (StatusCode, ApiErrorBody) {
    let status = resp.status();
    let mut bytes = Vec::new();
    let complete = loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break true,
            // Preserve the existing empty diagnostic for a body-read failure.
            Err(_) => {
                return (
                    status,
                    ApiErrorBody {
                        text: String::new(),
                        complete: false,
                    },
                );
            }
        };
        let remaining = API_ERROR_BODY_MAX_BYTES - bytes.len();
        bytes.extend(chunk.iter().take(remaining));
        if chunk.len() > remaining {
            break false;
        }
    };
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if !complete {
        text.push_str(API_ERROR_BODY_TRUNCATED);
    }
    (status, ApiErrorBody { text, complete })
}

fn api_status_error(
    label: &'static str,
    status: StatusCode,
    body: impl Into<String>,
) -> ProviderError {
    ProviderError::ApiStatus(Box::new(ApiStatusError {
        endpoint_label: label,
        status,
        body: body.into(),
    }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
