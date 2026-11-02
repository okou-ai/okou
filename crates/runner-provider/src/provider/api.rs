//! [`JobProvider`] backed by an Ably control plane + HTTP polling + REST API.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::{
    constants::runners::{
        BUILTIN_FIREWALL_CATALOG_MAX_BYTES, CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
        PI_MODEL_CONFIG_CHAT_COMPLETIONS_GENERATION, PI_MODEL_CONFIG_CURRENT_GENERATION,
        PI_MODEL_CONFIG_DIALECT_TIER_GENERATION, RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
    },
    decode_paths, routes,
    types::runners::runs::steerable_inputs::next::Response as NextSteerableInputResponse,
};
use bytes::Bytes;
use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::api_ably_supervisor::{
    AblySupervisor, AblySupervisorConfig, PollDue, PollOutcome, PollReason, PollWakeups,
};
use super::api_cancellation_reconciliation::CancellationReconciliation;
use super::api_claim_cooldowns::{ClaimCooldownRecord, ClaimCooldowns};
use super::api_claim_in_flight::InFlightClaims;
use super::api_direct_candidates::{
    DIRECT_CANDIDATE_STALE_AFTER, DirectCandidateInbox, DirectCandidatePruneSnapshot,
    DirectJobCandidate,
};
use super::builtin_firewall_catalog::{
    BuiltinFirewallCatalog, BuiltinFirewallCatalogRefreshController,
};
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::{
    ApiClaimTiming, ClaimResponseAttribution, ClaimedJob, CompletionAuth, CompletionAuthError,
    CompletionReportTiming, JobCandidate, JobDiscoverySource, JobProvider, RunnerPreference,
    RunnerPreferenceClaimState, parse_runner_preference,
};
use crate::active_input::{ActiveInputNotifications, ActiveInputSource};
use crate::duration::duration_ms;
use crate::error::{
    ApiBodyReadError, ApiFailureKind, ApiStatusError, ApiTransportCause, ApiTransportError,
    ProviderError, ProviderResult,
};
use crate::http::{ApiRequestBuilder, HttpClient};
use crate::run_cancellation::RunCancellationRegistry;
#[cfg(test)]
use guest_contracts::okou_cli::OkouCliInstalledPackage;
use guest_contracts::okou_cli::{InstalledOkouCli, OkouCliVersions};
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;
use runner_types::types::{
    CompleteRequest, ConnectorRuntimeSyncBatchResponse, ConnectorRuntimeTargetRegistration,
    ExecutionContext, HeartbeatState, Job, PollResponse,
};

fn supports_thread_active_input(reuse_key: Option<&str>) -> bool {
    reuse_key.is_some_and(|key| key.starts_with("thread:"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequestBody<'a> {
    runner_identity: &'a RunnerProcessIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_hostname: Option<&'a str>,
    capabilities: RunnerClaimCapabilities,
    telemetry: ClaimRequestTelemetry,
    /// Versions of the Okou CLI installed in this runner's rootfs. A runner
    /// without an installed CLI omits the field.
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_versions: Option<&'a OkouCliVersions>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerClaimCapabilities {
    pi_model_config_generations: [u32; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimRequestTelemetry {
    #[serde(skip_serializing_if = "Option::is_none")]
    discovery_source: Option<&'static str>,
    job_discovered_to_claim_request_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_admission_to_claim_request_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_candidate_notification_to_enqueue_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direct_candidate_inbox_wait_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_discovery_to_main_loop_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    main_loop_to_local_admission_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_due_to_job_discovered_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_http_request_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poll_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_preference: Option<RunnerPreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_preference_claim_state: Option<RunnerPreferenceClaimState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollRequestBody<'a> {
    runner_id: uuid::Uuid,
    group: &'a str,
    supported_profiles: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    excluded_run_ids: Option<&'a [RunId]>,
    telemetry: PollRequestTelemetry,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollRequestTelemetry {
    poll_reason: &'static str,
}

#[derive(Debug, thiserror::Error)]
enum ClaimApiError {
    #[error(transparent)]
    Request(#[from] ProviderError),
    #[error("claim response body read failed: {0}")]
    ResponseRead(String),
    #[error("claim response decode failed: {0}")]
    ResponseDecode(String),
}

#[cfg_attr(test, derive(Debug))]
struct SuccessfulClaimResponse {
    context: ExecutionContext,
    request_to_response_headers_elapsed: Duration,
    response_body_read_elapsed: Duration,
    response_first_body_chunk_wait_elapsed: Duration,
    response_decode_elapsed: Duration,
    response_attribution: ClaimResponseAttribution,
}

#[derive(Clone, Copy)]
enum ClaimFailureClass {
    HttpTransient,
    HttpDeterministic,
    Transport,
    Local,
    ResponseRead,
    ResponseDecode,
    ResponseInvariant,
}

impl ClaimFailureClass {
    const fn as_str(self) -> &'static str {
        match self {
            Self::HttpTransient => "http_transient",
            Self::HttpDeterministic => "http_deterministic",
            Self::Transport => "transport",
            Self::Local => "local",
            Self::ResponseRead => "response_read",
            Self::ResponseDecode => "response_decode",
            Self::ResponseInvariant => "response_invariant",
        }
    }
}

struct ClaimFailureDecision {
    class: ClaimFailureClass,
    cooldown: Duration,
    status: Option<StatusCode>,
    transport_kind: Option<&'static str>,
    response_run_id: Option<RunId>,
}

const CLAIM_TELEMETRY_DURATION_MS_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct PollApiResult {
    job: Option<Job>,
    http_request_elapsed: Duration,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Poll interval when Ably is connected (safety net).
const POLL_SLOW: Duration = Duration::from_secs(30);
/// Poll interval when Ably is disconnected or unavailable (primary mechanism).
const POLL_FAST: Duration = Duration::from_secs(5);
/// Reconcile advertised reuse while Ably may still report Connected, at a
/// load-limited ten-second cadence. This deliberately exceeds the API's one-
/// and two-second preference windows; a competitor can claim after expiry.
/// Connection heartbeats shorten silent-loss detection independently. HTTP
/// latency, capacity and explicit deferrals can further delay discovery.
const POLL_REUSE: Duration = Duration::from_secs(10);
const POLL_REUSE_STAGGER_MS: u64 = 100;
/// Retry delay after a job-notification wakeup reaches poll but poll fails.
const POLL_WAKEUP_RETRY: Duration = POLL_FAST;
const DIRECT_CANDIDATE_INBOX_CAPACITY: usize = 128;
const CLAIM_COOLDOWN_CAPACITY: usize = RUNNER_POLL_EXCLUDED_RUN_IDS_MAX as usize;
const CLAIM_TRANSIENT_COOLDOWN: Duration = POLL_FAST;
const CLAIM_DETERMINISTIC_COOLDOWN: Duration = POLL_SLOW;
/// Matches the existing sustained Ably-disconnection reporting boundary.
const POLL_DEGRADED_AFTER: Duration = Duration::from_secs(60);
/// Runner reuse requires a heartbeat observed within this freshness window.
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

enum DiscoveryWakeup {
    Direct(Box<DirectJobCandidate>),
    Poll(PollDue),
}

// ---------------------------------------------------------------------------
// ApiProvider
// ---------------------------------------------------------------------------

/// [`JobProvider`] backed by Ably control-plane notifications + HTTP polling + REST API.
///
/// This wraps the current production job lifecycle:
/// - **Control plane**: Ably supervisor for reconnect visibility, cancel notifications,
///   and poll wakeups
/// - **Discovery**: HTTP poll fallback (adaptive interval)
/// - **Claim**: `POST /api/runners/jobs/{id}/claim`
/// - **Complete**: `POST /api/webhooks/agent/complete` with per-job sandbox token
///
/// ## Claim failure and rediscovery
///
/// Claim is also feedback into discovery. A successful or unavailable claim
/// clears any per-run cooldown; an unavailable claim promptly polls the backlog.
/// Other failures are classified as transient or deterministic and give that run
/// a corresponding runner-local cooldown.
///
/// While a run is cooling down, matching direct candidates are skipped and the
/// bounded active run IDs are sent as optional poll exclusions. Recording a
/// per-run cooldown requests an immediate poll so unrelated candidates can make
/// progress. An empty excluded poll schedules a deferred retry through the
/// `PollWakeups` state machine. If every exclusion expires while that poll is in
/// flight, the provider immediately polls again without the stale exclusions.
///
/// The API can still return a cooled run: exclusions are truncated to the
/// contract maximum, and a cooldown recorded while a poll is in flight is not in
/// that poll's request. The provider therefore checks returned candidates
/// locally and defers rather than reclaiming that run at network-round-trip
/// cadence. Cooldown capacity never
/// evicts an active entry; saturation instead applies a short provider-wide
/// cooldown and defers all discovery before retrying.
pub struct ApiProvider {
    api: ApiClient,
    runner_identity: RunnerProcessIdentity,
    runner_hostname: Option<String>,
    /// Okou CLI installed into every configured rootfs, advertised at claim.
    installed_okou_cli: Option<InstalledOkouCli>,
    group: String,
    /// Profile names this runner supports (e.g., ["vm0/default"]).
    /// Sent in poll requests so the server only returns jobs this runner can handle.
    supported_profiles: Vec<String>,
    /// Coalesced poll wakeup state updated by the Ably supervisor.
    poll_wakeups: Arc<PollWakeups>,
    /// Supported direct job candidates delivered by Ably notifications.
    direct_candidates: Arc<DirectCandidateInbox>,
    /// Runs temporarily ineligible for this runner after a failed claim.
    claim_cooldowns: ClaimCooldowns,
    /// Requests whose queued Run may still be visible before claim settlement.
    in_flight_claims: InFlightClaims,
    /// Background Ably control-plane task.
    ably_supervisor: Mutex<Option<AblySupervisor>>,
    cancel_tokens: RunCancellationRegistry,
    cancellation_reconciliation: CancellationReconciliation,
    connector_runtime_sync: ConnectorRuntimeSyncHandle,
    ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    builtin_firewall_catalog_refresh: BuiltinFirewallCatalogRefreshController,
    active_input_notifications: ActiveInputNotifications,
    poll_degradation_tracker: DegradationEpisodeTracker,
    heartbeat_degradation_tracker: DegradationEpisodeTracker,
    /// Shutdown signal.
    cancel: CancellationToken,
}

pub struct BuiltinFirewallCatalogCachePaths {
    pub cache_path: PathBuf,
    pub lock_path: PathBuf,
}

pub struct ApiProviderConfig {
    pub ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    pub runner_identity: RunnerProcessIdentity,
    pub runner_hostname: Option<String>,
    pub group: String,
    pub supported_profiles: Vec<String>,
    pub installed_okou_cli: Option<InstalledOkouCli>,
}

impl ApiProvider {
    /// Create a new API-backed provider.
    pub fn new(
        http: HttpClient,
        token: String,
        config: ApiProviderConfig,
        builtin_firewall_catalog_cache_paths: BuiltinFirewallCatalogCachePaths,
        cancel: CancellationToken,
        cancel_tokens: RunCancellationRegistry,
    ) -> Arc<Self> {
        let ApiProviderConfig {
            ably_side_message_handler,
            runner_identity,
            runner_hostname,
            group,
            supported_profiles,
            installed_okou_cli,
        } = config;
        let cancellation_reconciliation =
            CancellationReconciliation::new(http.clone(), group.clone(), runner_identity);
        let api = ApiClient::new(http, token);
        let connector_runtime_sync = ConnectorRuntimeSyncHandle::new(api.clone());
        let builtin_firewall_catalog_refresh = BuiltinFirewallCatalogRefreshController::new(
            api.clone(),
            builtin_firewall_catalog_cache_paths.cache_path,
            builtin_firewall_catalog_cache_paths.lock_path,
            cancel.clone(),
        );
        let poll_wakeups = Arc::new(PollWakeups::new(false));
        let direct_candidates = DirectCandidateInbox::new(
            DIRECT_CANDIDATE_INBOX_CAPACITY,
            DIRECT_CANDIDATE_STALE_AFTER,
        );
        let active_input_notifications = ActiveInputNotifications::new();
        Arc::new(Self {
            api,
            runner_identity,
            runner_hostname,
            installed_okou_cli,
            group,
            supported_profiles,
            poll_wakeups,
            direct_candidates,
            claim_cooldowns: ClaimCooldowns::new(CLAIM_COOLDOWN_CAPACITY),
            in_flight_claims: InFlightClaims::default(),
            ably_supervisor: Mutex::new(None),
            cancel_tokens,
            cancellation_reconciliation,
            connector_runtime_sync,
            ably_side_message_handler,
            builtin_firewall_catalog_refresh,
            active_input_notifications,
            poll_degradation_tracker: DegradationEpisodeTracker::new(),
            heartbeat_degradation_tracker: DegradationEpisodeTracker::new(),
            cancel,
        })
    }

    pub fn connector_runtime_sync_handle(&self) -> ConnectorRuntimeSyncHandle {
        self.connector_runtime_sync.clone()
    }

    async fn try_recv_direct_candidate(&self) -> Option<DirectJobCandidate> {
        loop {
            let outcome = self.direct_candidates.try_pop_with_prune().await;
            if let Some(pruned) = outcome.pruned {
                Self::log_direct_candidate_pruned("pop", pruned);
                if outcome.candidate.is_none() {
                    self.poll_wakeups.request_immediate_poll();
                }
            }
            let candidate = outcome.candidate?;
            let run_id = candidate.run_id();
            let Some(retry_after) = self.claim_cooldowns.remaining(run_id).await else {
                return Some(candidate);
            };

            info!(
                run_id = %run_id,
                retry_after_ms = duration_ms(retry_after),
                "ably: direct candidate skipped during claim cooldown"
            );
            self.poll_wakeups.request_immediate_poll();
            if self.cancel.is_cancelled() {
                return None;
            }
        }
    }

    async fn schedule_claim_retry_after_poll(&self, polled_with_exclusions: bool) {
        let snapshot = self.claim_cooldowns.snapshot().await;
        if let Some(retry_after) = snapshot.retry_after {
            self.poll_wakeups.request_deferred_poll_after(retry_after);
        } else if polled_with_exclusions && self.in_flight_claims.is_empty() {
            // Every exclusion expired or settled while the HTTP poll was in flight.
            // Pending claims wake polling on settlement; do not spin on an empty
            // poll that correctly excluded them.
            self.poll_wakeups.request_immediate_poll();
        }
    }

    async fn record_claim_failure(&self, run_id: RunId, decision: ClaimFailureDecision) {
        let status = decision
            .status
            .map_or_else(String::new, |status| status.as_u16().to_string());
        let transport_kind = decision.transport_kind.unwrap_or("");
        let response_run_id = decision
            .response_run_id
            .map_or_else(String::new, |run_id| run_id.to_string());
        match self.claim_cooldowns.record(run_id, decision.cooldown).await {
            ClaimCooldownRecord::Recorded { active_count } => {
                error!(
                    run_id = %run_id,
                    failure_class = decision.class.as_str(),
                    status = %status,
                    transport_kind,
                    response_run_id = %response_run_id,
                    retry_after_ms = duration_ms(decision.cooldown),
                    retry_scope = "candidate",
                    retry_scheduled = true,
                    active_cooldowns = active_count,
                    cooldown_capacity = CLAIM_COOLDOWN_CAPACITY,
                    "claim failed, candidate cooling down"
                );
                self.poll_wakeups.request_immediate_poll();
            }
            ClaimCooldownRecord::Saturated { active_count } => {
                self.claim_cooldowns.block_all(POLL_FAST).await;
                error!(
                    run_id = %run_id,
                    failure_class = decision.class.as_str(),
                    status = %status,
                    transport_kind,
                    response_run_id = %response_run_id,
                    retry_after_ms = duration_ms(POLL_FAST),
                    retry_scope = "provider",
                    retry_scheduled = true,
                    active_cooldowns = active_count,
                    cooldown_capacity = CLAIM_COOLDOWN_CAPACITY,
                    "claim failed, candidate cooldown capacity reached"
                );
                self.poll_wakeups.request_deferred_poll_after(POLL_FAST);
            }
        }
    }

    async fn wait_for_direct_candidate(&self) -> Option<DirectJobCandidate> {
        loop {
            if let Some(candidate) = self.try_recv_direct_candidate().await {
                return Some(candidate);
            }
            if !self
                .direct_candidates
                .wait_for_notification(&self.cancel)
                .await
            {
                return None;
            }
        }
    }

    fn log_direct_candidate_pruned(source: &'static str, pruned: DirectCandidatePruneSnapshot) {
        info!(
            source,
            pruned_count = pruned.pruned_count,
            depth = pruned.depth,
            capacity = pruned.capacity,
            stale_after_ms = duration_ms(pruned.stale_after),
            oldest_pruned_wait_ms = duration_ms(pruned.oldest_pruned_wait_elapsed),
            "ably: stale direct candidates pruned"
        );
    }

    async fn wait_for_discovery_wakeup(&self) -> Option<DiscoveryWakeup> {
        loop {
            if let Some(candidate) = self.try_recv_direct_candidate().await {
                return Some(DiscoveryWakeup::Direct(Box::new(candidate)));
            }

            tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    return None;
                }
                candidate = self.wait_for_direct_candidate() => {
                    if let Some(candidate) = candidate {
                        return Some(DiscoveryWakeup::Direct(Box::new(candidate)));
                    }
                }
                due = self.poll_wakeups.wait_for_poll_due(&self.cancel, POLL_SLOW, POLL_FAST) => {
                    return due.map(DiscoveryWakeup::Poll);
                }
            }
        }
    }

    async fn ensure_ably_supervisor_started(&self) {
        let mut ably_supervisor = self.ably_supervisor.lock().await;
        if ably_supervisor.is_some() {
            return;
        }

        *ably_supervisor = Some(AblySupervisor::spawn(AblySupervisorConfig {
            api: self.api.clone(),
            group: self.group.clone(),
            profiles: self.supported_profiles.clone(),
            poll_wakeups: Arc::clone(&self.poll_wakeups),
            direct_candidates: Arc::clone(&self.direct_candidates),
            cancel_tokens: self.cancel_tokens.clone(),
            connector_runtime_sync: self.connector_runtime_sync.clone(),
            ably_side_message_handler: self.ably_side_message_handler.clone(),
            active_input_notifications: self.active_input_notifications.clone(),
            provider_cancel: self.cancel.clone(),
        }));
    }

    async fn record_poll_failure_at(
        &self,
        reason: PollReason,
        error: &ProviderError,
        now: Instant,
    ) {
        let retryable = match error {
            ProviderError::ApiStatus(api_error) => is_transient_http_status(api_error.status),
            _ => eligible_poll_transport_error(error).is_some(),
        };
        let observation = if retryable {
            Some(
                self.poll_degradation_tracker
                    .observe_failure(now, POLL_DEGRADED_AFTER)
                    .await,
            )
        } else {
            None
        };

        log_poll_failure(reason, error, observation);
    }

    async fn record_poll_success_at(&self, reason: PollReason, now: Instant) {
        let recovery = self.poll_degradation_tracker.recover(now).await;

        if let Some(recovery) = recovery {
            log_poll_recovery(self, reason, recovery);
        }
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

    async fn discover(&self) -> Option<JobCandidate> {
        loop {
            let due = match self.wait_for_discovery_wakeup().await? {
                DiscoveryWakeup::Direct(direct) => {
                    let run_id = direct.run_id();
                    let profile = direct.profile_name().to_owned();
                    info!(
                        run_id = %run_id,
                        profile = %profile,
                        "ably: direct job candidate discovered"
                    );
                    let mut candidate = direct.into_job_candidate();
                    candidate.mark_provider_discovery_returned();
                    return Some(candidate);
                }
                DiscoveryWakeup::Poll(due) => due,
            };
            let reason = due.reason();
            let poll_due_started_at = Instant::now();
            let cooldowns = self.claim_cooldowns.snapshot().await;
            let excluded_run_ids = self.in_flight_claims.poll_exclusions(&cooldowns.run_ids);

            let poll_result = tokio::select! {
                biased;
                () = self.cancel.cancelled() => {
                    return None;
                }
                direct = self.wait_for_direct_candidate() => {
                    if let Some(direct) = direct {
                        self.poll_wakeups.request_immediate_poll();
                        let run_id = direct.run_id();
                        let profile = direct.profile_name().to_owned();
                        info!(
                            run_id = %run_id,
                            profile = %profile,
                            poll_reason = ?reason,
                            "ably: direct job candidate interrupted poll"
                        );
                        let mut candidate = direct.into_job_candidate();
                        candidate.mark_provider_discovery_returned();
                        return Some(candidate);
                    }
                    return None;
                }
                result = self.api.poll(
                    self.runner_identity.runner_id(),
                    &self.group,
                    &self.supported_profiles,
                    &excluded_run_ids,
                    reason,
                ) => result,
            };

            if poll_result.is_ok() {
                self.record_poll_success_at(reason, Instant::now()).await;
            }

            match poll_result {
                Ok(PollApiResult {
                    job: Some(job),
                    http_request_elapsed,
                }) => {
                    if self.in_flight_claims.contains(job.run_id) {
                        // Locally reject an outstanding claim even if an API
                        // ignores exclusions or this poll raced registration.
                        self.poll_wakeups.record_poll_result(
                            due,
                            PollOutcome::Empty,
                            POLL_WAKEUP_RETRY,
                        );
                        self.schedule_claim_retry_after_poll(!excluded_run_ids.is_empty())
                            .await;
                        continue;
                    }
                    if let Some(retry_after) = self.claim_cooldowns.remaining(job.run_id).await {
                        self.poll_wakeups.record_poll_result(
                            due,
                            PollOutcome::Empty,
                            POLL_WAKEUP_RETRY,
                        );
                        warn!(
                            run_id = %job.run_id,
                            retry_after_ms = duration_ms(retry_after),
                            excluded_run_count = excluded_run_ids.len(),
                            "poll: API returned candidate excluded by claim cooldown"
                        );
                        self.schedule_claim_retry_after_poll(true).await;
                        continue;
                    }
                    let record = self.poll_wakeups.record_poll_result(
                        due,
                        PollOutcome::JobFound,
                        POLL_WAKEUP_RETRY,
                    );
                    if record.defer_job_return() {
                        info!(
                            run_id = %job.run_id,
                            poll_reason = ?reason,
                            "poll: job found while deferred poll arrived, retrying after defer"
                        );
                        continue;
                    }
                    if self.cancel.is_cancelled() {
                        return None;
                    }
                    let run_id = job.run_id;
                    let reuse_key = job.reuse_key().map(str::to_owned);
                    let runner_preference_context =
                        match parse_runner_preference(job.runner_preference) {
                            Ok(context) => context,
                            Err(error) => {
                                warn!(
                                    run_id = %run_id,
                                    error = %error,
                                    "poll: invalid runner preference, using ordinary admission"
                                );
                                None
                            }
                        };
                    let profile = job.experimental_profile;
                    info!(run_id = %run_id, %profile, poll_reason = ?reason, "poll: job found");
                    let mut candidate = JobCandidate::new(run_id, profile)
                        .with_reuse_key(reuse_key)
                        .with_parsed_runner_preference_context(runner_preference_context)
                        .with_discovery_source(JobDiscoverySource::Poll)
                        .with_poll_reason(poll_reason_value(reason))
                        .with_poll_timing(poll_due_started_at.elapsed(), http_request_elapsed);
                    candidate.mark_provider_discovery_returned();
                    return Some(candidate);
                }
                Ok(PollApiResult { job: None, .. }) => {
                    self.poll_wakeups.record_poll_result(
                        due,
                        PollOutcome::Empty,
                        POLL_WAKEUP_RETRY,
                    );
                    self.schedule_claim_retry_after_poll(!excluded_run_ids.is_empty())
                        .await;
                }
                Err(e) => {
                    self.poll_wakeups.record_poll_result(
                        due,
                        PollOutcome::Failure,
                        POLL_WAKEUP_RETRY,
                    );
                    self.record_poll_failure_at(reason, &e, Instant::now())
                        .await;
                }
            }
        }
    }

    async fn try_discover_ready(&self) -> Option<JobCandidate> {
        let direct = self.try_recv_direct_candidate().await?;
        let run_id = direct.run_id();
        let profile = direct.profile_name().to_owned();
        info!(
            run_id = %run_id,
            profile = %profile,
            "ably: ready direct job candidate drained"
        );
        let mut candidate = direct.into_job_candidate();
        candidate.mark_provider_discovery_returned();
        Some(candidate)
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let run_id = candidate.run_id();
        let _in_flight = self.in_flight_claims.register(run_id, &self.poll_wakeups);
        let cancellation_lookup_started_at = Instant::now();
        let cancellation = self.cancel_tokens.handle(run_id).await;
        info!(
            run_id = %run_id,
            cancellation_lookup_ms = duration_ms(cancellation_lookup_started_at.elapsed()),
            "claim cancellation lookup completed"
        );
        // Only an HTTP poll can opt this candidate into the v4 claim protocol.
        // Legacy/notification candidates omit the claim capability, so even a
        // stale hint cannot claim a v4 Run without the durable barrier.
        let claim_request_started_at = Instant::now();
        let claim_result = self
            .api
            .claim(
                &candidate,
                &self.runner_identity,
                self.runner_hostname.as_deref(),
                self.installed_okou_cli.as_ref(),
            )
            .await;
        let claim_request_elapsed = claim_request_started_at.elapsed();
        match claim_result {
            Ok(Some(SuccessfulClaimResponse {
                context: ctx,
                request_to_response_headers_elapsed,
                response_body_read_elapsed,
                response_first_body_chunk_wait_elapsed,
                response_decode_elapsed,
                response_attribution,
            })) => {
                let api_claim_timing = ApiClaimTiming::new(
                    claim_request_elapsed,
                    request_to_response_headers_elapsed,
                    response_body_read_elapsed,
                    response_first_body_chunk_wait_elapsed,
                    response_decode_elapsed,
                    response_attribution,
                );
                let active_input_source = supports_thread_active_input(ctx.reuse_key.as_deref())
                    .then(|| {
                        ActiveInputSource::api(
                            self.api.clone(),
                            run_id,
                            ctx.sandbox_token.clone(),
                            self.active_input_notifications.subscribe(run_id),
                        )
                    });
                let claimed = match if let Some(active_input_source) = active_input_source {
                    ClaimedJob::api_with_active_input_source(
                        run_id,
                        ctx,
                        active_input_source,
                        api_claim_timing,
                    )
                } else {
                    ClaimedJob::api(run_id, ctx, api_claim_timing)
                } {
                    Ok(claimed) => claimed,
                    Err(error) => {
                        self.record_claim_failure(
                            run_id,
                            ClaimFailureDecision {
                                class: ClaimFailureClass::ResponseInvariant,
                                cooldown: CLAIM_DETERMINISTIC_COOLDOWN,
                                status: None,
                                transport_kind: None,
                                response_run_id: Some(error.context_run_id),
                            },
                        )
                        .await;
                        return None;
                    }
                };
                if let Some(handle) = cancellation {
                    self.cancellation_reconciliation.observe(
                        run_id,
                        handle,
                        claimed.context().sandbox_token.clone(),
                    );
                }
                self.claim_cooldowns.remove(run_id).await;
                info!(
                    run_id = %run_id,
                    runner_id = %self.runner_identity.runner_id(),
                    heartbeat_generation = self.runner_identity.heartbeat_generation(),
                    "job claimed"
                );
                Some(claimed)
            }
            Ok(None) => {
                self.claim_cooldowns.remove(run_id).await;
                info!(run_id = %run_id, "job unavailable, skipping");
                self.poll_wakeups.request_immediate_poll();
                None
            }
            Err(e) => {
                self.record_claim_failure(run_id, classify_claim_failure(&e))
                    .await;
                None
            }
        }
    }

    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
        let has_admittable_reuse = state.mode == "running"
            && (state.held_sandbox_states.iter().any(|held| {
                state
                    .admittable_profiles
                    .contains(&held.reusable_sandbox.profile)
            }) || state.held_home_states.iter().any(|held| {
                held.home_caches
                    .iter()
                    .any(|cache| state.admittable_profiles.contains(&cache.profile))
            }));
        // Keep this local projection independent of HTTP delivery. A stalled
        // heartbeat must not delay discovery of work for an available resource.
        let stagger = Duration::from_millis(
            u64::from(self.runner_identity.runner_id().as_bytes()[0]) % (POLL_REUSE_STAGGER_MS + 1),
        );
        self.poll_wakeups.update_reuse_polling(
            (state.snapshot_generation, state.snapshot_sequence),
            has_admittable_reuse.then_some(POLL_REUSE + stagger),
        );
        let result = self.api.heartbeat(state).await;
        match &result {
            Ok(()) => {
                self.record_heartbeat_success_at(state, Instant::now())
                    .await
            }
            Err(error) => {
                self.record_heartbeat_failure_at(state, error, Instant::now())
                    .await;
            }
        }
        result
    }

    async fn defer_poll_until(&self, deadline: Instant) {
        self.poll_wakeups.request_deferred_poll_until(deadline);
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

        const MAX_ATTEMPTS: usize = 3;
        const RETRY_DELAY: Duration = Duration::from_secs(2);

        for attempt in 1..=MAX_ATTEMPTS {
            match self.api.complete(&token, &request).await {
                Ok(()) => return,
                Err(e) => {
                    let (retryable, status, failure_kind) = match &e {
                        ProviderError::ApiStatus(api_error) => (
                            is_transient_http_status(api_error.status),
                            api_error.status.as_str(),
                            "http_status",
                        ),
                        ProviderError::ApiTransport(api_error) => {
                            (true, "", api_error.failure_kind.as_str())
                        }
                        _ => (false, "", "local"),
                    };
                    let will_retry = retryable && attempt < MAX_ATTEMPTS;

                    if will_retry {
                        info!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "completion report failed, retrying"
                        );
                        tokio::time::sleep(RETRY_DELAY).await;
                        continue;
                    }

                    if attempt > 1 {
                        error!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "failed to report completion after retry"
                        );
                    } else {
                        error!(
                            run_id = %run_id,
                            error = %e,
                            attempt,
                            max_attempts = MAX_ATTEMPTS,
                            will_retry,
                            status,
                            failure_kind,
                            "failed to report completion"
                        );
                    }
                    return;
                }
            }
        }
    }
}

fn is_transient_http_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::MISDIRECTED_REQUEST
            | StatusCode::TOO_EARLY
            | StatusCode::TOO_MANY_REQUESTS
    ) || status.is_server_error()
}

fn classify_claim_failure(error: &ClaimApiError) -> ClaimFailureDecision {
    match error {
        ClaimApiError::Request(ProviderError::ApiStatus(api_error)) => {
            let status = api_error.status;
            let transient = is_transient_http_status(status);
            ClaimFailureDecision {
                class: if transient {
                    ClaimFailureClass::HttpTransient
                } else {
                    ClaimFailureClass::HttpDeterministic
                },
                cooldown: if transient {
                    CLAIM_TRANSIENT_COOLDOWN
                } else {
                    CLAIM_DETERMINISTIC_COOLDOWN
                },
                status: Some(status),
                transport_kind: None,
                response_run_id: None,
            }
        }
        ClaimApiError::Request(ProviderError::ApiTransport(api_error)) => ClaimFailureDecision {
            class: ClaimFailureClass::Transport,
            cooldown: CLAIM_TRANSIENT_COOLDOWN,
            status: None,
            transport_kind: Some(api_error.failure_kind.as_str()),
            response_run_id: None,
        },
        ClaimApiError::Request(_) => ClaimFailureDecision {
            class: ClaimFailureClass::Local,
            cooldown: CLAIM_DETERMINISTIC_COOLDOWN,
            status: None,
            transport_kind: None,
            response_run_id: None,
        },
        ClaimApiError::ResponseRead(_) => ClaimFailureDecision {
            class: ClaimFailureClass::ResponseRead,
            cooldown: CLAIM_TRANSIENT_COOLDOWN,
            status: None,
            transport_kind: None,
            response_run_id: None,
        },
        ClaimApiError::ResponseDecode(_) => ClaimFailureDecision {
            class: ClaimFailureClass::ResponseDecode,
            cooldown: CLAIM_DETERMINISTIC_COOLDOWN,
            status: None,
            transport_kind: None,
            response_run_id: None,
        },
    }
}

fn eligible_poll_transport_error(error: &ProviderError) -> Option<&ApiTransportError> {
    let ProviderError::ApiTransport(api_error) = error else {
        return None;
    };
    let retryable = matches!(
        api_error.failure_kind,
        ApiFailureKind::Timeout | ApiFailureKind::Connect
    ) || matches!(
        (api_error.failure_kind, api_error.failure_cause),
        (
            ApiFailureKind::Request,
            ApiTransportCause::ConnectionReset
                | ApiTransportCause::UnexpectedEof
                | ApiTransportCause::HttpIncompleteMessage
        )
    );
    retryable.then_some(api_error)
}

fn log_retryable_poll_failure(
    reason: PollReason,
    api_error: &ApiTransportError,
    observation: DegradationObservation,
) {
    let request = &api_error.request;
    let poll_reason = poll_reason_value(reason);
    let failure_elapsed_ms = duration_ms(observation.failure_elapsed);

    if observation.emit_degradation {
        error!(
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
            poll_reason,
            consecutive_failures = observation.consecutive_failures,
            failure_elapsed_ms,
            will_retry = true,
            degraded = observation.degraded,
            "poll fallback degraded"
        );
        return;
    }

    info!(
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
        poll_reason,
        consecutive_failures = observation.consecutive_failures,
        failure_elapsed_ms,
        will_retry = true,
        degraded = observation.degraded,
        "poll failed, will retry"
    );
}

fn log_poll_failure(
    reason: PollReason,
    error: &ProviderError,
    observation: Option<DegradationObservation>,
) {
    let poll_reason = poll_reason_value(reason);
    match error {
        ProviderError::ApiTransport(api_error) => {
            if let Some(observation) = observation {
                log_retryable_poll_failure(reason, api_error, observation);
                return;
            }
            let request = &api_error.request;
            error!(
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
                poll_reason,
                "poll failed"
            );
        }
        ProviderError::ApiStatus(api_error) => {
            if let Some(observation) = observation {
                let failure_elapsed_ms = duration_ms(observation.failure_elapsed);
                if observation.emit_degradation {
                    error!(
                        endpoint = api_error.endpoint_label,
                        status = api_error.status.as_u16(),
                        failure_kind = "http_status",
                        poll_reason,
                        consecutive_failures = observation.consecutive_failures,
                        failure_elapsed_ms,
                        will_retry = true,
                        degraded = observation.degraded,
                        "poll fallback degraded"
                    );
                } else {
                    info!(
                        endpoint = api_error.endpoint_label,
                        status = api_error.status.as_u16(),
                        failure_kind = "http_status",
                        poll_reason,
                        consecutive_failures = observation.consecutive_failures,
                        failure_elapsed_ms,
                        will_retry = true,
                        degraded = observation.degraded,
                        "poll failed, will retry"
                    );
                }
                return;
            }
            error!(
                endpoint = api_error.endpoint_label,
                status = api_error.status.as_u16(),
                failure_kind = "http_status",
                poll_reason,
                "poll failed"
            );
        }
        ProviderError::Api(error_summary) => {
            error!(
                failure_kind = "api",
                error_summary, poll_reason, "poll failed"
            );
        }
        ProviderError::Internal(error_summary) => {
            error!(
                failure_kind = "local",
                error_summary, poll_reason, "poll failed"
            );
        }
        _ => {
            error!(failure_kind = "local", poll_reason, "poll failed");
        }
    }
}

fn log_poll_recovery(provider: &ApiProvider, reason: PollReason, recovery: DegradationRecovery) {
    info!(
        runner_id = %provider.runner_identity.runner_id(),
        runner_group = %provider.group,
        poll_reason = poll_reason_value(reason),
        recovered_after_failures = recovery.recovered_after_failures,
        failure_elapsed_ms = duration_ms(recovery.failure_elapsed),
        was_degraded = recovery.was_degraded,
        "poll fallback recovered"
    );
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

    /// Poll for a pending job. The response contains `job: None` when no work is available.
    async fn poll(
        &self,
        runner_id: uuid::Uuid,
        group: &str,
        supported_profiles: &[String],
        excluded_run_ids: &[RunId],
        reason: PollReason,
    ) -> ProviderResult<PollApiResult> {
        let body = poll_request_body(
            runner_id,
            group,
            supported_profiles,
            excluded_run_ids,
            reason,
        );
        let poll_started_at = Instant::now();
        let resp = send_api(
            self.http
                .request_route(routes::runners::poll::POLL, &self.token)
                .json(&body),
            "poll",
        )
        .await?;

        let resp = check_api_status(resp, "poll").await?;
        let poll: PollResponse = decode_api_json(resp, "poll").await?;

        Ok(PollApiResult {
            job: poll.job,
            http_request_elapsed: poll_started_at.elapsed(),
        })
    }

    /// Send a heartbeat with runner state. The default API timeout allows for
    /// cold starts while bounding this request and lifecycle drain waits.
    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()> {
        let resp = send_api(
            self.http
                .request_route(routes::runners::heartbeat::HEARTBEAT, &self.token)
                .json(state),
            "heartbeat",
        )
        .await?;

        check_api_status(resp, "heartbeat").await?;

        Ok(())
    }

    /// Claim a job for execution. Treats HTTP 404 as an unavailable job so
    /// callers can continue gracefully.
    async fn claim(
        &self,
        candidate: &JobCandidate,
        runner_identity: &RunnerProcessIdentity,
        runner_hostname: Option<&str>,
        installed_okou_cli: Option<&InstalledOkouCli>,
    ) -> Result<Option<SuccessfulClaimResponse>, ClaimApiError> {
        let claim_started_at = Instant::now();
        let run_id = candidate.run_id();
        let body = claim_request_body(
            candidate,
            runner_identity,
            runner_hostname,
            installed_okou_cli,
        );
        let run_id_string = run_id.to_string();
        let request = self.http.request_resolved_route(
            routes::runners::jobs::by_id::claim::route(
                routes::runners::jobs::by_id::claim::Params {
                    id: run_id_string.as_str(),
                },
            ),
            &self.token,
        );
        let request = request.query(&[("workflowSkills", "2")]).json(&body);
        let request_to_response_headers_started_at = Instant::now();
        let request = request.prepare("claim").map_err(|error| match error {
            ProviderError::Api(message) => ProviderError::Api(format!("claim: {message}")),
            error => error,
        })?;
        let request_context = request.context().clone();
        // This is the handoff to reqwest execution, not a physical socket write.
        // Connection, transport, edge and server work are not split by this clock.
        let execution_started_at = Instant::now();
        info!(
            run_id = %run_id,
            client_request_id = %request_context.client_request_id,
            client_session_id = %request_context.client_session_id,
            client_version = %request_context.client_version,
            discovery_source = body.telemetry.discovery_source,
            job_discovered_to_execution_ms = duration_ms(candidate.job_discovered_elapsed()),
            local_admission_to_execution_ms = candidate.local_admission_elapsed().map(duration_ms),
            request_prepare_ms = duration_ms(claim_started_at.elapsed()),
            direct_candidate_notification_to_enqueue_ms = body.telemetry.direct_candidate_notification_to_enqueue_ms,
            direct_candidate_inbox_wait_ms = body.telemetry.direct_candidate_inbox_wait_ms,
            provider_discovery_to_main_loop_ms = body.telemetry.provider_discovery_to_main_loop_ms,
            main_loop_to_local_admission_ms = body.telemetry.main_loop_to_local_admission_ms,
            poll_due_to_job_discovered_ms = body.telemetry.poll_due_to_job_discovered_ms,
            poll_http_request_ms = body.telemetry.poll_http_request_ms,
            "claim request execution started"
        );
        let mut status = None;
        let mut headers_elapsed = None;
        let mut body_read_elapsed = None;
        let mut decode_elapsed = None;
        let result = async {
            let resp = request.send_observed_claim(run_id, execution_started_at).await?;
            let headers_received_at = Instant::now();
            let request_to_response_headers_elapsed =
                headers_received_at.duration_since(request_to_response_headers_started_at);
            let execution_to_response_headers_elapsed =
                headers_received_at.duration_since(execution_started_at);
            headers_elapsed = Some(execution_to_response_headers_elapsed);
            status = Some(resp.status().as_u16());
            info!(
                run_id = %run_id,
                client_request_id = %request_context.client_request_id,
                client_session_id = %request_context.client_session_id,
                http_status = status,
                execution_to_response_headers_ms = duration_ms(execution_to_response_headers_elapsed),
                http_version = ?resp.version(),
                response_cf_ray = claim_cf_ray(resp.headers()),
                response_vercel_id = claim_vercel_id(resp.headers()),
                "claim response headers received"
            );

            if resp.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }

            let body_read_started_at = Instant::now();
            let resp = check_api_status(resp, "claim").await;
            if resp.is_err() {
                body_read_elapsed = Some(body_read_started_at.elapsed());
            }
            let resp = resp?;
            let content_encoding = resp
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .cloned();
            let body_read_started_at = Instant::now();
            let body = read_claim_response_body(resp, || {}).await;
            body_read_elapsed = Some(body_read_started_at.elapsed());
            let (body, response_first_body_chunk_wait_elapsed, response_body_read_elapsed) = body?;
            let response_decode_started_at = Instant::now();
            let context = decode_api_json_bytes(&body).map_err(ClaimApiError::ResponseDecode);
            let response_decode_elapsed = response_decode_started_at.elapsed();
            decode_elapsed = Some(response_decode_elapsed);
            let context = context?;
            let response_attribution = ClaimResponseAttribution::from_body_and_encoding(
                body.len(),
                content_encoding.as_ref(),
            );

            Ok(Some(SuccessfulClaimResponse {
                context,
                request_to_response_headers_elapsed,
                response_body_read_elapsed,
                response_first_body_chunk_wait_elapsed,
                response_decode_elapsed,
                response_attribution,
            }))
        }
        .await;
        let outcome = match &result {
            // The provider still validates the returned Run before accepting
            // ownership; decoding alone must not report a successful claim.
            Ok(Some(_)) => "response_decoded",
            Ok(None) => "unavailable",
            Err(ClaimApiError::Request(ProviderError::ApiStatus(_))) => "http_error",
            Err(ClaimApiError::Request(ProviderError::ApiTransport(_))) => "transport_error",
            Err(ClaimApiError::Request(_)) => "request_error",
            Err(ClaimApiError::ResponseRead(_)) => "response_read_error",
            Err(ClaimApiError::ResponseDecode(_)) => "response_decode_error",
        };
        let transport = match &result {
            Err(ClaimApiError::Request(ProviderError::ApiTransport(error))) => Some(error),
            _ => None,
        };
        let completed_at = Instant::now();
        info!(
            run_id = %run_id,
            client_request_id = %request_context.client_request_id,
            client_session_id = %request_context.client_session_id,
            client_version = %request_context.client_version,
            outcome,
            response_run_id = result.as_ref().ok().and_then(Option::as_ref)
                .map(|response| response.context.run_id.to_string()),
            http_status = status,
            response_headers_received = headers_elapsed.is_some(),
            claim_elapsed_ms = duration_ms(completed_at.duration_since(claim_started_at)),
            execution_to_completion_ms = duration_ms(completed_at.duration_since(execution_started_at)),
            execution_to_response_headers_ms = headers_elapsed.map(duration_ms),
            response_body_read_ms = body_read_elapsed.map(duration_ms),
            response_decode_ms = decode_elapsed.map(duration_ms),
            transport_failure_kind = transport.map(|error| error.failure_kind.as_str()),
            transport_failure_cause = transport.map(|error| error.failure_cause.as_str()),
            "claim request completed"
        );
        result
    }

    #[cfg(test)]
    async fn claim_for_test(
        &self,
        candidate: &JobCandidate,
    ) -> Result<Option<SuccessfulClaimResponse>, ClaimApiError> {
        let runner_identity =
            RunnerProcessIdentity::new("550e8400-e29b-41d4-a716-446655440000".parse().unwrap(), 7)
                .unwrap();
        self.claim(candidate, &runner_identity, None, None).await
    }
    /// Report job completion. Uses the per-job **sandbox token** for auth.
    async fn complete(&self, sandbox_token: &str, request: &CompleteRequest) -> ProviderResult<()> {
        let resp = send_api(
            self.http
                .request_route(routes::webhooks::agent::complete::COMPLETE, sandbox_token)
                .json(request),
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
    }
}

// Only provider-issued request identifiers are retained, never arbitrary
// response headers. Invalid/unknown shapes are simply unobserved diagnostics.
fn claim_cf_ray(headers: &reqwest::header::HeaderMap) -> Option<&str> {
    let value = headers.get("cf-ray")?.to_str().ok()?;
    let (ray, colo) = value.split_once('-')?;
    (ray.len() == 16
        && ray.bytes().all(|byte| byte.is_ascii_hexdigit())
        && colo.len() == 3
        && colo.bytes().all(|byte| byte.is_ascii_uppercase()))
    .then_some(value)
}

fn claim_vercel_id(headers: &reqwest::header::HeaderMap) -> Option<&str> {
    let value = headers.get("x-vercel-id")?.to_str().ok()?;
    let (region, request_id) = value.split_once("::")?;
    (value.len() <= 128
        && (4..=6).contains(&region.len())
        && region
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && region.bytes().any(|byte| byte.is_ascii_digit())
        && !request_id.is_empty()
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-')))
    .then_some(value)
}

// The callback is a no-op in production and lets raw-HTTP tests acknowledge the
// actual first application-visible chunk before releasing the response tail.
async fn read_claim_response_body(
    mut resp: Response,
    first_chunk_observed: impl FnOnce(),
) -> Result<(Bytes, Duration, Duration), ClaimApiError> {
    let response_body_read_started_at = Instant::now();
    // This is not a physical wire-byte or server-flush boundary.
    let first_chunk = loop {
        match resp
            .chunk()
            .await
            .map_err(|error| ClaimApiError::ResponseRead(error.to_string()))?
        {
            Some(chunk) if !chunk.is_empty() => break chunk,
            Some(_) => continue,
            None => break Bytes::new(),
        }
    };
    let response_first_body_chunk_wait_elapsed = response_body_read_started_at.elapsed();
    if !first_chunk.is_empty() {
        first_chunk_observed();
    }
    // Group tiny fragments so retained descriptors and backing allocations do
    // not scale with HTTP chunk count. Large chunks still avoid an extra copy.
    // This is allocation organization, not a response-size or fragment limit.
    const CHUNK_GROUP_BYTES: usize = 4 * 1024;
    let mut tail = Vec::new();
    let mut pending = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|error| ClaimApiError::ResponseRead(error.to_string()))?
    {
        if chunk.is_empty() {
            continue;
        }
        if chunk.len() < CHUNK_GROUP_BYTES {
            pending.extend_from_slice(&chunk);
            if pending.len() >= CHUNK_GROUP_BYTES {
                tail.push(Bytes::from(std::mem::take(&mut pending)));
            }
        } else {
            if !pending.is_empty() {
                tail.push(Bytes::from(std::mem::take(&mut pending)));
            }
            tail.push(chunk);
        }
    }
    if !pending.is_empty() {
        tail.push(Bytes::from(pending));
    }
    // The common one-chunk case stays zero-copy; split input is coalesced once.
    let body = if tail.is_empty() {
        first_chunk
    } else {
        let body_len = first_chunk.len() + tail.iter().map(Bytes::len).sum::<usize>();
        let mut combined = Vec::with_capacity(body_len);
        combined.extend_from_slice(&first_chunk);
        for chunk in tail {
            combined.extend_from_slice(&chunk);
        }
        Bytes::from(combined)
    };
    let response_body_read_elapsed = response_body_read_started_at.elapsed();
    Ok((
        body,
        response_first_body_chunk_wait_elapsed,
        response_body_read_elapsed,
    ))
}

fn claim_request_body<'a>(
    candidate: &JobCandidate,
    runner_identity: &'a RunnerProcessIdentity,
    runner_hostname: Option<&'a str>,
    installed_okou_cli: Option<&'a InstalledOkouCli>,
) -> ClaimRequestBody<'a> {
    let runner_preference_telemetry = candidate.runner_preference_claim_telemetry();
    let is_ably_candidate = candidate.discovery_source() == Some(JobDiscoverySource::Ably);
    let (
        direct_candidate_notification_to_enqueue_ms,
        direct_candidate_inbox_wait_ms,
        provider_discovery_to_main_loop_ms,
        main_loop_to_local_admission_ms,
    ) = if is_ably_candidate {
        (
            candidate
                .direct_candidate_notification_to_enqueue_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .direct_candidate_inbox_wait_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .provider_discovery_to_main_loop_elapsed()
                .map(claim_telemetry_duration_ms),
            candidate
                .main_loop_to_local_admission_elapsed()
                .map(claim_telemetry_duration_ms),
        )
    } else {
        (None, None, None, None)
    };

    ClaimRequestBody {
        runner_identity,
        runner_hostname,
        installed_versions: installed_okou_cli.map(|installed| &installed.versions),
        capabilities: RunnerClaimCapabilities {
            pi_model_config_generations: [
                PI_MODEL_CONFIG_CURRENT_GENERATION,
                PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
                PI_MODEL_CONFIG_CHAT_COMPLETIONS_GENERATION,
            ],
        },
        telemetry: ClaimRequestTelemetry {
            discovery_source: candidate.discovery_source().map(JobDiscoverySource::as_str),
            job_discovered_to_claim_request_ms: claim_telemetry_duration_ms(
                candidate.job_discovered_elapsed(),
            ),
            local_admission_to_claim_request_ms: candidate
                .local_admission_elapsed()
                .map(claim_telemetry_duration_ms),
            direct_candidate_notification_to_enqueue_ms,
            direct_candidate_inbox_wait_ms,
            provider_discovery_to_main_loop_ms,
            main_loop_to_local_admission_ms,
            poll_due_to_job_discovered_ms: candidate
                .poll_due_to_job_discovered_elapsed()
                .map(claim_telemetry_duration_ms),
            poll_http_request_ms: candidate
                .poll_http_request_elapsed()
                .map(claim_telemetry_duration_ms),
            poll_reason: candidate.poll_reason().map(String::from),
            runner_preference: runner_preference_telemetry
                .as_ref()
                .map(|telemetry| telemetry.runner_preference.clone()),
            runner_preference_claim_state: runner_preference_telemetry
                .and_then(|telemetry| telemetry.state),
        },
    }
}

fn claim_telemetry_duration_ms(duration: Duration) -> u64 {
    // The TypeScript claim route validates these fields with z.number().int(),
    // which rejects values above Number.MAX_SAFE_INTEGER.
    duration_ms(duration).min(CLAIM_TELEMETRY_DURATION_MS_MAX)
}

fn poll_request_body<'a>(
    runner_id: uuid::Uuid,
    group: &'a str,
    supported_profiles: &'a [String],
    excluded_run_ids: &'a [RunId],
    reason: PollReason,
) -> PollRequestBody<'a> {
    PollRequestBody {
        runner_id,
        group,
        supported_profiles,
        excluded_run_ids: (!excluded_run_ids.is_empty()).then_some(excluded_run_ids),
        telemetry: PollRequestTelemetry {
            poll_reason: poll_reason_value(reason),
        },
    }
}

fn poll_reason_value(reason: PollReason) -> &'static str {
    match reason {
        PollReason::Immediate => "immediate",
        PollReason::Deferred => "deferred",
        PollReason::WakeupRetry => "wakeup_retry",
        PollReason::Slow => "slow",
        PollReason::Fast => "fast",
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

trait ApiDecodePath: DeserializeOwned {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema;
}

impl ApiDecodePath for NextSteerableInputResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::steerable_inputs::next::RESPONSE;
}

impl ApiDecodePath for PollResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::poll::RESPONSE;
}

impl ApiDecodePath for ExecutionContext {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::jobs::by_id::claim::RESPONSE;
}

impl ApiDecodePath for ably_subscriber::TokenRequest {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::realtime::token::RESPONSE;
}

impl ApiDecodePath for ConnectorRuntimeSyncBatchResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::connector_runtime::sync::RESPONSE;
}

impl ApiDecodePath for BuiltinFirewallCatalog {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::builtin_firewalls::resolve::RESPONSE;
}

async fn decode_api_json<T: ApiDecodePath>(resp: Response, label: &str) -> ProviderResult<T> {
    let body = resp.bytes().await.map_err(|e| {
        ProviderError::Api(format!("{label} decode read body: {}", e.without_url()))
    })?;
    decode_api_json_bytes(&body).map_err(|e| ProviderError::Api(format!("{label} decode: {e}")))
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

fn decode_api_json_bytes<T: ApiDecodePath>(body: &[u8]) -> Result<T, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(body);
    let value = serde_path_to_error::deserialize(&mut deserializer).map_err(|e| {
        format_json_decode_error(
            format_json_decode_path(e.path(), T::DECODE_PATH_SCHEMA),
            e.inner(),
        )
    })?;
    deserializer
        .end()
        .map_err(|e| format_json_decode_error(".".to_string(), &e))?;
    Ok(value)
}

fn format_json_decode_path(
    path: &serde_path_to_error::Path,
    schema: &'static api_contracts::DecodePathSchema,
) -> String {
    let mut formatted = String::new();
    let mut cursor = schema.root();

    for segment in path {
        match segment {
            serde_path_to_error::Segment::Seq { index } => {
                formatted.push('[');
                formatted.push_str(&index.to_string());
                formatted.push(']');
                cursor = cursor.sequence_item();
            }
            serde_path_to_error::Segment::Map { key } => {
                let (segment, next_cursor) = match cursor.map_segment(key) {
                    api_contracts::DecodePathMapSegment::Field(next) => (key.as_str(), next),
                    api_contracts::DecodePathMapSegment::DynamicKey(next) => ("<map-key>", next),
                    api_contracts::DecodePathMapSegment::Unknown(next) => ("<field>", next),
                };
                push_json_path_segment(&mut formatted, segment);
                cursor = next_cursor;
            }
            serde_path_to_error::Segment::Enum { .. } => {
                push_json_path_segment(&mut formatted, "<variant>");
            }
            serde_path_to_error::Segment::Unknown => {
                push_json_path_segment(&mut formatted, "?");
                cursor = cursor.unknown();
            }
        }
    }

    if formatted.is_empty() {
        ".".to_string()
    } else {
        formatted
    }
}

fn push_json_path_segment(formatted: &mut String, segment: &str) {
    if !formatted.is_empty() {
        formatted.push('.');
    }
    formatted.push_str(segment);
}

fn format_json_decode_error(mut path: String, error: &serde_json::Error) -> String {
    let category = match error.classify() {
        serde_json::error::Category::Io => "io",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "eof",
    };
    let location = format!("line {} column {}", error.line(), error.column());
    let detail = sanitized_json_error_detail(error);
    if detail == "unknown variant" && is_firewall_entry_decode_path(&path) {
        path.push_str(".kind");
    }
    if path == "." {
        format!("failed at <root>: {detail}; {category} error at {location}")
    } else {
        format!("failed at {path}: {detail}; {category} error at {location}")
    }
}

fn is_firewall_entry_decode_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("firewalls[") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once(']') else {
        return false;
    };
    !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) && suffix.is_empty()
}

fn sanitized_json_error_detail(error: &serde_json::Error) -> String {
    let message = error.to_string();
    let location_suffix = format!(" at line {} column {}", error.line(), error.column());
    let detail = message
        .strip_suffix(&location_suffix)
        .unwrap_or(message.as_str());
    if detail.starts_with("missing field `") || detail.starts_with("duplicate field `") {
        return detail.to_string();
    }

    if detail.starts_with("unknown field `") {
        return "unknown field".to_string();
    }
    if detail.starts_with("trailing characters") {
        return "trailing characters".to_string();
    }
    if detail.starts_with("invalid type:") {
        return "invalid type".to_string();
    }
    if detail.starts_with("invalid value:") {
        return "invalid value".to_string();
    }
    if detail.starts_with("unknown variant `") {
        return "unknown variant".to_string();
    }
    if detail.starts_with("expected value") {
        return "expected value".to_string();
    }
    if detail.starts_with("EOF while parsing") {
        return "unexpected end of input".to_string();
    }
    "invalid JSON".to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
