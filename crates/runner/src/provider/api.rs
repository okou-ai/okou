//! [`JobProvider`] backed by an Ably control plane + HTTP polling + REST API.

use super::{
    DeferredSandboxFence,
    deferred_release::{DeferredReleaseOutbox, ReleaseOutcome},
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use api_contracts::generated::{
    constants::runners::{
        BUILTIN_FIREWALL_CATALOG_MAX_BYTES, CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
        PI_MODEL_CONFIG_CURRENT_GENERATION, PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
        PI_MODEL_CONFIG_LEGACY_GENERATION, PI_MODEL_CONFIG_NATIVE_GENERATION,
        RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
    },
    decode_paths, routes,
    types::runners::runs::active_inputs::{
        receipt::Response as ActiveInputReceiptResponse,
        reserve::Response as ActiveInputReserveResponse,
    },
};
use reqwest::{Response, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::api_ably_supervisor::{
    AblySupervisor, AblySupervisorConfig, PollDue, PollOutcome, PollReason, PollWakeups,
};
use super::api_cancellation_reconciliation::CancellationReconciliation;
use super::api_claim_cooldowns::{ClaimCooldownRecord, ClaimCooldowns};
use super::api_direct_candidates::{
    DIRECT_CANDIDATE_STALE_AFTER, DirectCandidateInbox, DirectCandidatePruneSnapshot,
    DirectJobCandidate,
};
use super::builtin_firewall_catalog::{
    BuiltinFirewallCatalog, BuiltinFirewallCatalogRefreshController,
};
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::{
    ApiClaimTiming, ClaimedJob, CompletionAuth, CompletionAuthError, CompletionReportTiming,
    JobCandidate, JobDiscoverySource, JobProvider, RunnerPreference, RunnerPreferenceClaimState,
    parse_runner_preference,
};
use crate::active_input::{ActiveInputNotifications, ActiveInputSource};
use crate::duration::duration_ms;
use crate::error::{
    ApiBodyReadError, ApiFailureKind, ApiStatusError, ApiTransportError, RunnerError, RunnerResult,
};
use crate::http::{ApiRequestBuilder, HttpClient};
use crate::ids::RunId;
use crate::run_cancellation::RunCancellationRegistry;
use crate::runner_process_identity::RunnerProcessIdentity;
use crate::types::{
    CompleteRequest, ConnectorRuntimeSyncBatchResponse, ConnectorRuntimeTargetRegistration,
    ExecutionContext, HeartbeatState, Job, PollResponse,
};
#[cfg(test)]
use crate::types::{SandboxReuseResult, WorkspaceReuseResult};

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerClaimCapabilities {
    pi_model_config_generations: [u32; 4],
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollRequestTelemetry {
    poll_reason: &'static str,
}

#[derive(Debug, thiserror::Error)]
enum ClaimApiError {
    #[error(transparent)]
    Request(#[from] RunnerError),
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
    response_decode_elapsed: Duration,
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
    deferred_sandbox: bool,
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
const BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

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
/// An older API may ignore the additive exclusions and return a cooled run. The
/// provider therefore checks returned candidates locally and defers rather than
/// reclaiming that run at network-round-trip cadence. Cooldown capacity never
/// evicts an active entry; saturation instead applies a short provider-wide
/// cooldown and defers all discovery before retrying.
pub struct ApiProvider {
    api: ApiClient,
    deferred_release_outbox: DeferredReleaseOutbox,
    runner_identity: RunnerProcessIdentity,
    runner_hostname: Option<String>,
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
    /// Background Ably control-plane task.
    ably_supervisor: Mutex<Option<AblySupervisor>>,
    cancel_tokens: RunCancellationRegistry,
    cancellation_reconciliation: CancellationReconciliation,
    connector_runtime_sync: ConnectorRuntimeSyncHandle,
    ssh: Option<Arc<crate::ssh::SshRuntime>>,
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
    pub(crate) deferred_release_root: std::path::PathBuf,
    pub(crate) ssh: Option<Arc<crate::ssh::SshRuntime>>,
    pub(crate) runner_identity: RunnerProcessIdentity,
    pub(crate) runner_hostname: Option<String>,
    pub group: String,
    pub supported_profiles: Vec<String>,
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
            deferred_release_root,
            ssh,
            runner_identity,
            runner_hostname,
            group,
            supported_profiles,
        } = config;
        let deferred_release_outbox =
            DeferredReleaseOutbox::new_shared(deferred_release_root, &runner_identity);
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
            deferred_release_outbox,
            runner_identity,
            runner_hostname,
            group,
            supported_profiles,
            poll_wakeups,
            direct_candidates,
            claim_cooldowns: ClaimCooldowns::new(CLAIM_COOLDOWN_CAPACITY),
            ably_supervisor: Mutex::new(None),
            cancel_tokens,
            cancellation_reconciliation,
            connector_runtime_sync,
            ssh,
            builtin_firewall_catalog_refresh,
            active_input_notifications,
            poll_degradation_tracker: DegradationEpisodeTracker::new(),
            heartbeat_degradation_tracker: DegradationEpisodeTracker::new(),
            cancel,
        })
    }

    pub(crate) fn connector_runtime_sync_handle(&self) -> ConnectorRuntimeSyncHandle {
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
        } else if polled_with_exclusions {
            // Every exclusion expired while the HTTP poll was in flight.
            // Re-poll once without the stale exclusions instead of waiting for the normal cadence.
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
            ssh: self.ssh.clone(),
            active_input_notifications: self.active_input_notifications.clone(),
            provider_cancel: self.cancel.clone(),
        }));
    }

    async fn record_poll_failure_at(&self, reason: PollReason, error: &RunnerError, now: Instant) {
        let Some(api_error) = eligible_poll_transport_error(error) else {
            log_poll_failure(reason, error);
            return;
        };

        let observation = self
            .poll_degradation_tracker
            .observe_failure(now, POLL_DEGRADED_AFTER)
            .await;

        log_retryable_poll_failure(reason, api_error, observation);
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
        error: &RunnerError,
        now: Instant,
    ) {
        let Some(api_error) = eligible_heartbeat_transport_error(state, error) else {
            log_heartbeat_failure(state, error);
            return;
        };

        let observation = self
            .heartbeat_degradation_tracker
            .observe_failure(now, HEARTBEAT_DEGRADED_AFTER)
            .await;

        log_retryable_heartbeat_failure(state, error, api_error, observation);
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
    async fn prepare_startup_readiness(&self) -> RunnerResult<()> {
        self.builtin_firewall_catalog_refresh
            .prepare_startup_readiness()
            .await?;
        if self.cancel.is_cancelled() {
            return Err(RunnerError::Internal(
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
            let excluded_run_ids = self.claim_cooldowns.snapshot().await.run_ids;

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
                    deferred_sandbox,
                    http_request_elapsed,
                }) => {
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
                    let history_generation_run_id = job.history_generation_run_id;
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
                        .with_deferred_sandbox(deferred_sandbox)
                        .with_reuse_key(reuse_key)
                        .with_history_generation_run_id(history_generation_run_id)
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
        let cancellation = self.cancel_tokens.handle(run_id).await;
        // Only an HTTP poll can opt this candidate into the v4 claim protocol.
        // Legacy/notification candidates omit the claim capability, so even a
        // stale hint cannot claim a v4 Run without the durable barrier.
        if candidate.deferred_sandbox()
            && let Err(error) = self
                .deferred_release_outbox
                .begin_claim(run_id, &self.runner_identity)
                .await
        {
            warn!(%run_id, %error, "claim skipped because its durable ownership journal is unavailable");
            return None;
        }
        let claim_request_started_at = Instant::now();
        let claim_result = self
            .api
            .claim(
                &candidate,
                &self.runner_identity,
                self.runner_hostname.as_deref(),
            )
            .await;
        let claim_request_elapsed = claim_request_started_at.elapsed();
        match claim_result {
            Ok(Some(SuccessfulClaimResponse {
                context: ctx,
                request_to_response_headers_elapsed,
                response_body_read_elapsed,
                response_decode_elapsed,
            })) => {
                let deferred_slot = ctx
                    .pi_launch_config
                    .as_ref()
                    .and_then(|config| config.get("apiFirstTurn"))
                    .filter(|slot| {
                        slot.get("schemaVersion")
                            .and_then(serde_json::Value::as_u64)
                            == Some(2)
                    });
                let fence = deferred_slot.and_then(|slot| {
                    serde_json::from_value::<DeferredSandboxFence>(slot.clone()).ok()
                });
                if deferred_slot.is_some() && (!candidate.deferred_sandbox() || fence.is_none()) {
                    self.deferred_release_outbox.actor_gone(run_id).await;
                    return None;
                }
                if candidate.deferred_sandbox()
                    && let Err(error) = self
                        .deferred_release_outbox
                        .accept_claim(run_id, fence)
                        .await
                {
                    warn!(%run_id, %error, "claimed job cannot dispatch without durable claim identity");
                    self.deferred_release_outbox.actor_gone(run_id).await;
                    return None;
                }
                let api_claim_timing = ApiClaimTiming::new(
                    claim_request_elapsed,
                    request_to_response_headers_elapsed,
                    response_body_read_elapsed,
                    response_decode_elapsed,
                );
                let deferred_active_input = ctx
                    .pi_launch_config
                    .as_ref()
                    .and_then(|config| config.get("apiFirstTurn"))
                    .is_some_and(|slot| {
                        slot.get("schemaVersion")
                            .and_then(serde_json::Value::as_u64)
                            == Some(2)
                            && slot.get("activeInput").and_then(serde_json::Value::as_bool)
                                == Some(true)
                    });
                let active_input_source = (supports_thread_active_input(ctx.reuse_key.as_deref())
                    || deferred_active_input)
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
                        self.deferred_release_outbox.actor_gone(run_id).await;
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
                self.deferred_release_outbox.actor_gone(run_id).await;
                self.claim_cooldowns.remove(run_id).await;
                info!(run_id = %run_id, "job unavailable, skipping");
                self.poll_wakeups.request_immediate_poll();
                None
            }
            Err(e) => {
                self.deferred_release_outbox.actor_gone(run_id).await;
                self.record_claim_failure(run_id, classify_claim_failure(&e))
                    .await;
                None
            }
        }
    }

    async fn release_deferred_sandbox(&self, run_id: RunId, fence: DeferredSandboxFence) {
        self.deferred_release_outbox
            .record_and_flush(&self.api, self.runner_identity.runner_id(), run_id, fence)
            .await;
    }

    async fn bind_claimed_sandbox(
        &self,
        run_id: RunId,
        sandbox_id: sandbox::SandboxId,
    ) -> RunnerResult<()> {
        self.deferred_release_outbox
            .bind_sandbox(run_id, sandbox_id)
            .await
            .map_err(|error| {
                RunnerError::Internal(format!("persist deferred Sandbox binding: {error}"))
            })
    }

    async fn claimed_actor_gone(&self, run_id: RunId) {
        self.deferred_release_outbox.actor_gone(run_id).await;
    }

    async fn heartbeat(&self, state: &HeartbeatState) {
        match self.api.heartbeat(state).await {
            Ok(()) => {
                self.record_heartbeat_success_at(state, Instant::now())
                    .await
            }
            Err(error) => {
                self.record_heartbeat_failure_at(state, &error, Instant::now())
                    .await;
            }
        }
        self.deferred_release_outbox
            .recover_claims(&self.api, &self.runner_identity)
            .await;
        self.deferred_release_outbox.flush_batch(&self.api).await;
        self.deferred_release_outbox
            .recover_foreign(&self.api, &self.runner_identity)
            .await;
    }

    async fn defer_poll_until(&self, deadline: Instant) {
        self.poll_wakeups.request_deferred_poll_until(deadline);
    }

    async fn shutdown(&self) {
        self.cancellation_reconciliation.shutdown().await;
        let ably_supervisor = self.ably_supervisor.lock().await.take();
        if let Some(ably_supervisor) = ably_supervisor {
            ably_supervisor.shutdown().await;
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

        const MAX_ATTEMPTS: usize = 2;
        const RETRY_DELAY: Duration = Duration::from_secs(2);

        for attempt in 1..=MAX_ATTEMPTS {
            match self.api.complete(&token, &request).await {
                Ok(()) => return,
                Err(e) => {
                    let (retryable, status, failure_kind) = match &e {
                        RunnerError::ApiStatus(api_error) => {
                            let status = api_error.status;
                            (
                                matches!(
                                    status,
                                    StatusCode::REQUEST_TIMEOUT
                                        | StatusCode::MISDIRECTED_REQUEST
                                        | StatusCode::TOO_EARLY
                                        | StatusCode::TOO_MANY_REQUESTS
                                ) || status.is_server_error(),
                                api_error.status.as_str(),
                                "http_status",
                            )
                        }
                        RunnerError::ApiTransport(api_error) => {
                            (true, "", api_error.failure_kind.as_str())
                        }
                        _ => (false, "", "local"),
                    };
                    let will_retry = retryable && attempt < MAX_ATTEMPTS;

                    if will_retry {
                        if matches!(
                            &e,
                            RunnerError::ApiTransport(error)
                                if error.failure_kind == ApiFailureKind::Timeout
                        ) {
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
                        } else {
                            warn!(
                                run_id = %run_id,
                                error = %e,
                                attempt,
                                max_attempts = MAX_ATTEMPTS,
                                will_retry,
                                status,
                                failure_kind,
                                "completion report failed, retrying"
                            );
                        }
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

fn classify_claim_failure(error: &ClaimApiError) -> ClaimFailureDecision {
    match error {
        ClaimApiError::Request(RunnerError::ApiStatus(api_error)) => {
            let status = api_error.status;
            let transient = matches!(
                status,
                StatusCode::REQUEST_TIMEOUT
                    | StatusCode::MISDIRECTED_REQUEST
                    | StatusCode::TOO_EARLY
                    | StatusCode::TOO_MANY_REQUESTS
            ) || status.is_server_error();
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
        ClaimApiError::Request(RunnerError::ApiTransport(api_error)) => ClaimFailureDecision {
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

fn eligible_poll_transport_error(error: &RunnerError) -> Option<&ApiTransportError> {
    let RunnerError::ApiTransport(api_error) = error else {
        return None;
    };
    matches!(
        api_error.failure_kind,
        ApiFailureKind::Timeout | ApiFailureKind::Connect
    )
    .then_some(api_error)
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
        warn!(
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

fn log_poll_failure(reason: PollReason, error: &RunnerError) {
    let poll_reason = poll_reason_value(reason);
    match error {
        RunnerError::ApiTransport(api_error) => {
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
        RunnerError::ApiStatus(api_error) => {
            error!(
                endpoint = api_error.endpoint_label,
                status = api_error.status.as_u16(),
                failure_kind = "http_status",
                poll_reason,
                "poll failed"
            );
        }
        RunnerError::Api(error_summary) => {
            error!(
                failure_kind = "api",
                error_summary, poll_reason, "poll failed"
            );
        }
        RunnerError::Internal(error_summary) => {
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

fn log_heartbeat_failure(state: &HeartbeatState, error: &RunnerError) {
    let reusable_sandboxes = state.held_sandbox_states.len();
    let workspace_states = state.held_workspace_states.len();
    if let RunnerError::ApiTransport(api_error) = error {
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
            workspace_states,
            "heartbeat failed"
        );
        return;
    }

    warn!(
        error = %error,
        runner_id = %state.runner_id,
        runner_group = %state.group,
        mode = %state.mode,
        running = state.running_count,
        reusable_sandboxes,
        workspace_states,
        "heartbeat failed"
    );
}

fn eligible_heartbeat_transport_error<'a>(
    state: &HeartbeatState,
    error: &'a RunnerError,
) -> Option<&'a ApiTransportError> {
    if !matches!(state.mode.as_str(), "starting" | "running" | "draining") {
        return None;
    }
    let RunnerError::ApiTransport(api_error) = error else {
        return None;
    };
    matches!(
        api_error.failure_kind,
        ApiFailureKind::Timeout | ApiFailureKind::Connect
    )
    .then_some(api_error)
}

fn log_retryable_heartbeat_failure(
    state: &HeartbeatState,
    error: &RunnerError,
    api_error: &ApiTransportError,
    observation: DegradationObservation,
) {
    let request = &api_error.request;
    let reusable_sandboxes = state.held_sandbox_states.len();
    let workspace_states = state.held_workspace_states.len();
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
            workspace_states,
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
        workspace_states,
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
        workspace_states = state.held_workspace_states.len(),
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
pub(crate) struct ApiClient {
    http: HttpClient,
    token: String,
}

#[derive(Serialize)]
struct EmptyRequest {}

impl ApiClient {
    pub(crate) fn new(http: HttpClient, token: String) -> Self {
        Self { http, token }
    }

    pub(crate) async fn reserve_active_inputs(
        &self,
        run_id: RunId,
        sandbox_token: &str,
    ) -> RunnerResult<ActiveInputReserveResponse> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.http
                .request_resolved_route(
                    routes::runners::runs::by_run_id::active_inputs::reserve::route(
                        routes::runners::runs::by_run_id::active_inputs::reserve::Params {
                            run_id: run_id.as_str(),
                        },
                    ),
                    sandbox_token,
                )
                .json(&EmptyRequest {}),
            "reserve active inputs",
        )
        .await?;
        let resp = check_api_status(resp, "reserve active inputs").await?;
        decode_api_json(resp, "reserve active inputs").await
    }

    pub(crate) async fn record_active_input_delivery(
        &self,
        run_id: RunId,
        sandbox_token: &str,
        delivery_id: &str,
    ) -> RunnerResult<ActiveInputReceiptResponse> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.http
                .request_resolved_route(
                    routes::runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::route(
                        routes::runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::Params {
                            run_id: run_id.as_str(),
                            delivery_id,
                        },
                    ),
                    sandbox_token,
                )
                .json(&EmptyRequest {}),
            "record active input delivery",
        )
        .await?;
        let resp = check_api_status(resp, "record active input delivery").await?;
        decode_api_json(resp, "record active input delivery").await
    }

    /// Poll for a pending job. The response contains `job: None` when no work is available.
    pub(super) async fn release_deferred_sandbox(
        &self,
        run_id: RunId,
        body: &serde_json::Value,
    ) -> RunnerResult<ReleaseOutcome> {
        let id = run_id.to_string();
        let response = send_api(
            self.http
                .request_resolved_route(
                    routes::runners::jobs::by_id::release::route(
                        routes::runners::jobs::by_id::release::Params { id: &id },
                    ),
                    &self.token,
                )
                .json(body),
            "deferred-sandbox-release",
        )
        .await?;
        let response = check_api_status(response, "deferred-sandbox-release").await?;
        #[derive(Deserialize)]
        struct ReleaseReceipt {
            outcome: ReleaseOutcome,
        }
        let receipt: ReleaseReceipt = response
            .json()
            .await
            .map_err(|error| RunnerError::Api(format!("decode deferred release: {error}")))?;
        Ok(receipt.outcome)
    }

    async fn poll(
        &self,
        runner_id: uuid::Uuid,
        group: &str,
        supported_profiles: &[String],
        excluded_run_ids: &[RunId],
        reason: PollReason,
    ) -> RunnerResult<PollApiResult> {
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
                .deferred_pi_reader()
                .json(&body),
            "poll",
        )
        .await?;

        let resp = check_api_status(resp, "poll").await?;
        let deferred_sandbox = resp
            .headers()
            .get("X-Pi-Deferred-Sandbox")
            .is_some_and(|value| value == "1");
        let poll: PollResponse = decode_api_json(resp, "poll").await?;

        Ok(PollApiResult {
            deferred_sandbox,
            job: poll.job,
            http_request_elapsed: poll_started_at.elapsed(),
        })
    }

    /// Send a heartbeat with runner state. The default API timeout allows for
    /// cold starts while bounding this request and lifecycle drain waits.
    async fn heartbeat(&self, state: &HeartbeatState) -> RunnerResult<()> {
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
    ) -> Result<Option<SuccessfulClaimResponse>, ClaimApiError> {
        let run_id = candidate.run_id();
        let body = claim_request_body(candidate, runner_identity, runner_hostname);
        let run_id = run_id.to_string();
        let request = self.http.request_resolved_route(
            routes::runners::jobs::by_id::claim::route(
                routes::runners::jobs::by_id::claim::Params {
                    id: run_id.as_str(),
                },
            ),
            &self.token,
        );
        let request = if candidate.deferred_sandbox() {
            request.deferred_pi_reader()
        } else {
            request
        };
        let request = request.json(&body);
        let request_to_response_headers_started_at = Instant::now();
        let resp = send_api(request, "claim").await?;
        let request_to_response_headers_elapsed = request_to_response_headers_started_at.elapsed();

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }

        let resp = check_api_status(resp, "claim").await?;
        let response_body_read_started_at = Instant::now();
        let body = resp
            .bytes()
            .await
            .map_err(|error| ClaimApiError::ResponseRead(error.to_string()))?;
        let response_body_read_elapsed = response_body_read_started_at.elapsed();
        let response_decode_started_at = Instant::now();
        let context = decode_api_json_bytes(&body).map_err(ClaimApiError::ResponseDecode)?;
        let response_decode_elapsed = response_decode_started_at.elapsed();

        Ok(Some(SuccessfulClaimResponse {
            context,
            request_to_response_headers_elapsed,
            response_body_read_elapsed,
            response_decode_elapsed,
        }))
    }

    #[cfg(test)]
    async fn claim_for_test(
        &self,
        candidate: &JobCandidate,
    ) -> Result<Option<SuccessfulClaimResponse>, ClaimApiError> {
        let runner_identity =
            RunnerProcessIdentity::new("550e8400-e29b-41d4-a716-446655440000".parse().unwrap(), 7)
                .unwrap();
        self.claim(candidate, &runner_identity, None).await
    }
    /// Report job completion. Uses the per-job **sandbox token** for auth.
    async fn complete(&self, sandbox_token: &str, request: &CompleteRequest) -> RunnerResult<()> {
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
    ) -> RunnerResult<ably_subscriber::TokenRequest> {
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
    ) -> RunnerResult<ConnectorRuntimeSyncOutcome> {
        let run_id = run_id.to_string();
        let resp = send_api(
            self.connector_runtime_sync_request(&run_id, targets),
            "connector runtime sync",
        )
        .await?;

        if resp.status() == StatusCode::CONFLICT {
            let (status, body) = read_api_error(resp).await;
            if serde_json::from_str::<ApiErrorEnvelope>(&body).is_ok_and(|response| {
                response.error.code == CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE
            }) {
                return Ok(ConnectorRuntimeSyncOutcome::RunTerminal);
            }
            return Err(api_status_error("connector runtime sync", status, &body));
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
    ) -> RunnerResult<BuiltinFirewallCatalog> {
        const LABEL: &str = "builtin firewall catalog resolve";

        let mut resp = send_api(
            self.http
                .request_route(
                    routes::runners::builtin_firewalls::resolve::RESOLVE,
                    &self.token,
                )
                .timeout(BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
                .json(&serde_json::json!({})),
            LABEL,
        )
        .await?;

        let status = resp.status();
        let max_bytes = BUILTIN_FIREWALL_CATALOG_MAX_BYTES;
        let content_length = resp.content_length();
        if content_length.is_some_and(|length| length > max_bytes) {
            return Err(RunnerError::Api(format!(
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
                    return Err(RunnerError::ApiBodyRead(Box::new(ApiBodyReadError {
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
                RunnerError::Api(format!("{LABEL} response body chunk length: {error}"))
            })?;
            let next_body_len = body_len.checked_add(chunk_len).ok_or_else(|| {
                RunnerError::Api(format!("{LABEL} response body length overflow"))
            })?;
            if next_body_len > max_bytes {
                return Err(RunnerError::Api(format!(
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
                &String::from_utf8_lossy(&body),
            ));
        }
        let catalog: BuiltinFirewallCatalog = decode_api_json_bytes(&body)
            .map_err(|e| RunnerError::Api(format!("{LABEL} decode: {e}")))?;
        catalog.validate_for_api_response().map_err(|e| {
            RunnerError::Api(format!(
                "builtin firewall catalog resolve invalid catalog: {e}"
            ))
        })?;
        Ok(catalog)
    }
}

fn claim_request_body<'a>(
    candidate: &JobCandidate,
    runner_identity: &'a RunnerProcessIdentity,
    runner_hostname: Option<&'a str>,
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
        capabilities: RunnerClaimCapabilities {
            pi_model_config_generations: [
                PI_MODEL_CONFIG_LEGACY_GENERATION,
                PI_MODEL_CONFIG_CURRENT_GENERATION,
                PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
                PI_MODEL_CONFIG_NATIVE_GENERATION,
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

async fn send_api(req: ApiRequestBuilder, label: &'static str) -> RunnerResult<Response> {
    match req.send(label).await {
        Ok(resp) => Ok(resp),
        Err(RunnerError::Api(message)) => Err(RunnerError::Api(format!("{label}: {message}"))),
        Err(error) => Err(error),
    }
}

async fn check_api_status(resp: Response, label: &'static str) -> RunnerResult<Response> {
    let status = resp.status();
    if !status.is_success() {
        let (status, body) = read_api_error(resp).await;
        return Err(api_status_error(label, status, &body));
    }
    Ok(resp)
}

trait ApiDecodePath: DeserializeOwned {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema;
}

impl ApiDecodePath for ActiveInputReserveResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::active_inputs::reserve::RESPONSE;
}

impl ApiDecodePath for ActiveInputReceiptResponse {
    const DECODE_PATH_SCHEMA: &'static api_contracts::DecodePathSchema =
        &decode_paths::runners::runs::by_run_id::active_inputs::deliveries::by_delivery_id::receipt::RESPONSE;
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

async fn decode_api_json<T: ApiDecodePath>(resp: Response, label: &str) -> RunnerResult<T> {
    let body = resp
        .bytes()
        .await
        .map_err(|e| RunnerError::Api(format!("{label} decode read body: {}", e.without_url())))?;
    decode_api_json_bytes(&body).map_err(|e| RunnerError::Api(format!("{label} decode: {e}")))
}

async fn read_api_error(resp: Response) -> (StatusCode, String) {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    (status, body)
}

fn api_status_error(label: &'static str, status: StatusCode, body: &str) -> RunnerError {
    RunnerError::ApiStatus(Box::new(ApiStatusError {
        endpoint_label: label,
        status,
        body: body.to_string(),
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
mod tests {
    use super::*;
    use httpmock::Method::POST;
    use httpmock::MockServer;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    use tracing::{Level, instrument::WithSubscriber};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};
    use uuid::Uuid;

    use crate::http::HttpClientConfig;
    use crate::provider::{
        ActiveRunnerPreference, RunnerNoPreferenceReason, RunnerPreference,
        RunnerPreferenceRemovalReason, RunnerPreferenceTier,
    };
    use crate::test_fixtures::raw_http::{
        RawHttpAction, RawHttpTestServer, http_response, join_raw_http_task, json_response,
        read_http_request,
    };

    const RUNNER_CLAIM_RESPONSE_FIXTURE: &str = include_str!(
        "../../../../turbo/packages/api-contracts/src/contracts/__tests__/fixtures/runner-claim-response.json"
    );
    const RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID: &str = "00000000-0000-4000-8000-000000020985";
    const TEST_RUNNER_ID: &str = "550e8400-e29b-41d4-a716-446655440000";

    const TEST_HEARTBEAT_GENERATION: u64 = 7;

    fn api_client_for_url(api_url: String) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "runner-session-test".to_string(),
            })
            .unwrap(),
            "runner-token".to_string(),
        )
    }

    fn test_runner_identity() -> RunnerProcessIdentity {
        RunnerProcessIdentity::new(TEST_RUNNER_ID.parse().unwrap(), TEST_HEARTBEAT_GENERATION)
            .unwrap()
    }

    fn claim_request_body_for_test(candidate: &JobCandidate) -> serde_json::Value {
        let runner_identity = test_runner_identity();
        serde_json::to_value(claim_request_body(candidate, &runner_identity, None)).unwrap()
    }

    #[test]
    fn active_input_source_requires_a_thread_run() {
        assert!(supports_thread_active_input(Some("thread:chat-id")));
        assert!(!supports_thread_active_input(Some("goal:goal-id")));
        assert!(!supports_thread_active_input(None));
    }

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        api_client_for_url(server.base_url())
    }

    #[tokio::test]
    async fn heartbeat_and_connector_sync_allow_api_cold_starts() {
        let server = MockServer::start_async().await;
        let heartbeat = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/heartbeat")
                    .header("authorization", "Bearer runner-token");
                then.status(200).delay(Duration::from_secs(6));
            })
            .await;
        let run_id = RunId::nil();
        let sync = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                    .header("authorization", "Bearer runner-token");
                then.status(200)
                    .delay(Duration::from_secs(6))
                    .json_body(serde_json::json!({
                        "results": [{
                            "target": {"kind": "builtin", "connectorSlug": "slack"},
                            "state": "unresolved",
                            "reason": "connector-unavailable",
                        }],
                    }));
            })
            .await;
        let api = api_client_for_server(&server);
        let state = heartbeat_state_for_test();
        let targets = [ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        }];

        let (heartbeat_result, sync_result) = tokio::join!(
            api.heartbeat(&state),
            api.sync_connector_runtime(run_id, &targets),
        );

        heartbeat_result.expect("heartbeat should survive an API cold start");
        assert!(matches!(
            sync_result.expect("connector sync should survive an API cold start"),
            ConnectorRuntimeSyncOutcome::Synced(response) if response.results.len() == 1
        ));
        heartbeat.assert_calls_async(1).await;
        sync.assert_calls_async(1).await;
    }

    async fn claim_decode_error(
        server: &MockServer,
        run_id: RunId,
        body: serde_json::Value,
    ) -> String {
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

    #[test]
    fn builtin_firewall_catalog_resolve_request_uses_bounded_timeout_and_empty_body() {
        let server = MockServer::start();
        let api = api_client_for_server(&server);

        let request = api
            .http
            .request_route(
                routes::runners::builtin_firewalls::resolve::RESOLVE,
                &api.token,
            )
            .timeout(BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
            .json(&serde_json::json!({}))
            .build()
            .expect("builtin firewall catalog resolve request should build");

        assert_eq!(
            request.timeout(),
            Some(&BUILTIN_FIREWALL_CATALOG_RESOLVE_TIMEOUT)
        );
        assert_eq!(
            request.url().path(),
            "/api/runners/builtin-firewalls/resolve"
        );
        assert_eq!(
            request
                .body()
                .and_then(reqwest::Body::as_bytes)
                .expect("request should include JSON body"),
            br#"{}"#
        );
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
            RunnerError::Api(message) => assert!(
                message.contains("does not match firewall.name"),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
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
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(declared_oversized_response)])
                .await;
        let api = api_client_for_url(server.url());

        let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

        match error {
            RunnerError::Api(message) => assert!(
                message.contains(&expected_error),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
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
            RunnerError::ApiStatus(error) => {
                assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(error.body.len(), max_bytes_usize);
            }
            other => panic!("expected RunnerError::ApiStatus, got {other:?}"),
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
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(chunked_oversized_response)])
                .await;
        let api = api_client_for_url(server.url());

        let error = api.resolve_builtin_firewall_catalog().await.unwrap_err();

        match error {
            RunnerError::Api(message) => assert!(
                message.contains(&expected_error),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
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
        err: RunnerError,
        endpoint_label: &'static str,
        status: StatusCode,
        body: &str,
    ) {
        let display = err.to_string();
        match err {
            RunnerError::ApiStatus(error) => {
                assert_eq!(error.endpoint_label, endpoint_label);
                assert_eq!(error.status, status);
                assert_eq!(error.body, body);
            }
            other => panic!("expected RunnerError::ApiStatus, got {other:?}"),
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
            })
            .unwrap(),
            "runner-token".to_string(),
        );
        Arc::new(ApiProvider {
            ssh: None,
            deferred_release_outbox: DeferredReleaseOutbox::new(
                std::env::temp_dir().join(format!("pi-release-test-{}", Uuid::new_v4())),
            ),
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
            group: "default".to_string(),
            supported_profiles: vec![crate::profile::DEFAULT_PROFILE.to_string()],
            poll_wakeups,
            direct_candidates: DirectCandidateInbox::new(
                DIRECT_CANDIDATE_INBOX_CAPACITY,
                DIRECT_CANDIDATE_STALE_AFTER,
            ),
            claim_cooldowns: ClaimCooldowns::new(claim_cooldown_capacity),
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
            held_sandbox_states: vec![crate::types::HeldSandboxState {
                reuse_key: "thread:heartbeat-test".to_string(),
                last_completed_at: "2026-07-08T00:00:00.000Z".to_string(),
                reusable_sandbox: crate::types::ReusableSandboxState {
                    profile: crate::profile::DEFAULT_PROFILE.to_string(),
                    history_generation_run_id: None,
                },
            }],
            held_workspace_states: vec![crate::types::HeldWorkspaceState {
                reuse_key: "thread:heartbeat-test".to_string(),
                last_completed_at: "2026-07-08T00:00:00.000Z".to_string(),
                workspace_caches: vec![crate::types::WorkspaceCacheCapability {
                    profile: crate::profile::DEFAULT_PROFILE.to_string(),
                    workspace_affinity_version: crate::types::WORKSPACE_AFFINITY_VERSION,
                }],
            }],
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

    fn poll_transport_error(failure_kind: ApiFailureKind) -> RunnerError {
        RunnerError::ApiTransport(Box::new(ApiTransportError {
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
            failure_cause: synthetic_transport_cause(failure_kind),
            summary: format!("synthetic {} failure", failure_kind.as_str()),
        }))
    }

    fn heartbeat_transport_error(failure_kind: ApiFailureKind) -> RunnerError {
        RunnerError::ApiTransport(Box::new(ApiTransportError {
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
            failure_cause: synthetic_transport_cause(failure_kind),
            summary: format!("synthetic {} failure", failure_kind.as_str()),
        }))
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

        fn recovery_message(self) -> &'static str {
            match self {
                Self::Poll => "poll fallback recovered",
                Self::Heartbeat => "heartbeat delivery recovered",
            }
        }

        fn transport_error(self) -> RunnerError {
            match self {
                Self::Poll => poll_transport_error(ApiFailureKind::Timeout),
                Self::Heartbeat => heartbeat_transport_error(ApiFailureKind::Timeout),
            }
        }

        async fn record_failure(
            self,
            provider: &ApiProvider,
            state: &HeartbeatState,
            error: &RunnerError,
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

        async fn record_success(
            self,
            provider: &ApiProvider,
            state: &HeartbeatState,
            now: Instant,
        ) {
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
            sandbox_reuse_result: None,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
        }
    }

    #[tokio::test]
    async fn heartbeat_retryable_failure_logs_local_transport_context_without_secrets() {
        let state = heartbeat_state_for_test();

        for failure_kind in [ApiFailureKind::Timeout, ApiFailureKind::Connect] {
            let provider = idle_api_provider_for_test();
            let error = heartbeat_transport_error(failure_kind);
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
            assert_eq!(event_field(event, "workspace_states"), "1");
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
            assert_eq!(
                event_field(event, "failure_cause"),
                synthetic_transport_cause(failure_kind).as_str()
            );
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
    async fn api_paths_share_degradation_episode_transition_semantics() {
        let state = heartbeat_state_for_test();

        for path in [DegradationPath::Poll, DegradationPath::Heartbeat] {
            let provider = idle_api_provider_for_test();
            let error = path.transport_error();
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
            assert_eq!(path_events[2].level, Level::WARN, "path={path:?}");
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
                    .filter(|event| event.level == Level::WARN)
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
                    assert_eq!(event_field(recovery, "workspace_states"), "1");
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
            assert_eq!(
                later_events
                    .iter()
                    .filter(|event| {
                        event.level == Level::WARN
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
    async fn heartbeat_stopping_transport_failure_remains_an_immediate_warning() {
        let provider = idle_api_provider_for_test();
        let mut state = heartbeat_state_for_test();
        state.mode = "stopping".to_string();
        let error = heartbeat_transport_error(ApiFailureKind::Timeout);

        let (_, events) = capture_api_provider_events(provider.record_heartbeat_failure_at(
            &state,
            &error,
            Instant::now(),
        ))
        .await;
        let event = captured_event(&events, "heartbeat failed");

        assert_eq!(event.level, Level::WARN);
        assert_eq!(event_field(event, "mode"), "stopping");
        assert_eq!(event_field(event, "failure_kind"), "timeout");
        assert_eq!(event_field(event, "failure_cause"), "timeout");
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

    #[tokio::test]
    async fn heartbeat_success_recovers_active_degradation_episode() {
        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(status_response(200))]).await;
        let provider = api_provider_for_test(
            server.url(),
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let state = heartbeat_state_for_test();
        let error = heartbeat_transport_error(ApiFailureKind::Timeout);
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
            heartbeat_transport_error(ApiFailureKind::Body),
            heartbeat_transport_error(ApiFailureKind::Unknown),
            RunnerError::ApiStatus(Box::new(ApiStatusError {
                endpoint_label: "heartbeat",
                status: StatusCode::INTERNAL_SERVER_ERROR,
                body: "failed".to_string(),
            })),
            RunnerError::Internal("synthetic heartbeat invariant".to_string()),
        ];
        let mut stopping_state = state.clone();
        stopping_state.mode = "stopping".to_string();
        let (_, events) = capture_api_provider_events(async {
            for error in &unsupported_errors {
                provider
                    .record_heartbeat_failure_at(
                        &state,
                        error,
                        started_at + Duration::from_secs(15),
                    )
                    .await;
            }
            provider
                .record_heartbeat_failure_at(
                    &stopping_state,
                    &retryable_error,
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
            unsupported_errors.len() + 1,
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

        let (_, transition_events) =
            capture_api_provider_events(provider.record_heartbeat_failure_at(
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
        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Respond(status_response(500))]).await;
        let api_url = server.url();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let state = heartbeat_state_for_test();

        let (_, events) = capture_api_provider_events(provider.heartbeat(&state)).await;
        server.assert_finished().await;
        let event = captured_event(&events, "heartbeat failed");

        assert_eq!(event.level, Level::WARN);
        assert_eq!(event_field(event, "reusable_sandboxes"), "1");
        assert_eq!(event_field(event, "workspace_states"), "1");
        assert!(
            provider
                .heartbeat_degradation_tracker
                .active_episode
                .lock()
                .await
                .is_none()
        );
        let event_debug = format!("{event:#?}");
        assert!(
            !event_debug.contains("thread:heartbeat-test"),
            "event should not include heartbeat body: {event_debug}"
        );
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

        for failure_kind in [ApiFailureKind::Timeout, ApiFailureKind::Connect] {
            for (reason, expected_reason) in reasons {
                let provider = idle_api_provider_for_test();
                let error = poll_transport_error(failure_kind);
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
                assert_eq!(
                    event_field(event, "failure_cause"),
                    synthetic_transport_cause(failure_kind).as_str()
                );
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
    async fn poll_non_retryable_failures_remain_errors_without_mutating_episode() {
        const STATUS_BODY: &str = "sensitive-poll-status-body";

        let provider = idle_api_provider_for_test();
        let retryable_error = poll_transport_error(ApiFailureKind::Timeout);
        let started_at = Instant::now();
        provider
            .record_poll_failure_at(PollReason::Immediate, &retryable_error, started_at)
            .await;
        let unsupported_errors = [
            poll_transport_error(ApiFailureKind::Request),
            poll_transport_error(ApiFailureKind::Body),
            poll_transport_error(ApiFailureKind::Unknown),
            RunnerError::ApiStatus(Box::new(ApiStatusError {
                endpoint_label: "poll",
                status: StatusCode::SERVICE_UNAVAILABLE,
                body: STATUS_BODY.to_string(),
            })),
            RunnerError::Api("poll decode: failed at job.runId".to_string()),
            RunnerError::Internal("synthetic poll invariant".to_string()),
        ];

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
        assert_eq!(event_field(status_event, "status"), "503");
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
        assert_eq!(transition.level, Level::WARN);
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
            RunId::nil(),
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
            serde_json::json!([1, 2, 3, 4])
        );

        let runner_identity = test_runner_identity();
        let attributed = serde_json::to_value(claim_request_body(
            &candidate,
            &runner_identity,
            Some("prod-1.aws.vm3.ai"),
        ))
        .unwrap();
        assert_eq!(attributed["runnerHostname"], "prod-1.aws.vm3.ai");
    }

    #[test]
    fn claim_request_body_serializes_canonical_preference_at_claim_time() {
        let active_preference = ActiveRunnerPreference::ranked_for_test(
            test_runner_identity(),
            RunnerPreferenceTier::WorkspaceCache,
            Instant::now() + Duration::from_secs(60),
        );
        let active = JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
            .with_runner_preference_for_test(active_preference);
        let active_body = claim_request_body_for_test(&active);
        assert_eq!(
            active_body["telemetry"]["runnerPreference"]["kind"],
            "preference"
        );
        assert_eq!(
            active_body["telemetry"]["runnerPreference"]["tier"],
            "workspaceCache"
        );
        assert_eq!(
            active_body["telemetry"]["runnerPreference"]["runnerIdentity"]["runnerId"],
            TEST_RUNNER_ID
        );
        assert_eq!(
            active_body["telemetry"]["runnerPreferenceClaimState"],
            "active"
        );

        let expired_preference = ActiveRunnerPreference::ranked_for_test(
            test_runner_identity(),
            RunnerPreferenceTier::ExactSandbox,
            Instant::now() - Duration::from_secs(1),
        );
        let expired = JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
            .with_runner_preference_for_test(expired_preference);
        let expired_body = claim_request_body_for_test(&expired);
        assert_eq!(
            expired_body["telemetry"]["runnerPreferenceClaimState"],
            "expired"
        );

        let cleared_preference = ActiveRunnerPreference::ranked_for_test(
            RunnerProcessIdentity::new(Uuid::from_u128(8), TEST_HEARTBEAT_GENERATION).unwrap(),
            RunnerPreferenceTier::FinalizingPredecessor,
            Instant::now() + Duration::from_secs(60),
        );
        let cleared = JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
            .with_runner_preference_for_test(cleared_preference)
            .without_runner_preference(RunnerPreferenceRemovalReason::Cleared);
        let cleared_body = claim_request_body_for_test(&cleared);
        assert_eq!(
            cleared_body["telemetry"]["runnerPreferenceClaimState"],
            "cleared"
        );
        let no_preference =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
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
        let mut candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
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
        let mut candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
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
        let candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
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
            RunId::nil(),
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
        let candidate =
            JobCandidate::new(RunId::nil(), crate::profile::DEFAULT_PROFILE.to_string())
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
        let history_generation_run_id: RunId =
            "00000000-0000-0000-0000-000000000004".parse().unwrap();
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(routes::runners::poll::POLL.path);
                then.status(200).json_body(serde_json::json!({
                    "job": {
                        "runId": run_id,
                        "experimentalProfile": "vm0/large",
                        "cliAgentSessionId": "sess-poll",
                        "historyGenerationRunId": history_generation_run_id,
                        "runnerPreference": {
                            "kind": "preference",
                            "runnerIdentity": {
                                "runnerId": "00000000-0000-0000-0000-000000000005",
                                "heartbeatGeneration": 7
                            },
                            "tier": "exactSandbox",
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
        assert_eq!(
            discovered.history_generation_run_id(),
            Some(history_generation_run_id)
        );
        let preference = discovered
            .runner_preference()
            .expect("canonical preference should be parsed");
        assert_eq!(preference.tier(), RunnerPreferenceTier::ExactSandbox);
        assert!(
            preference.targets(
                RunnerProcessIdentity::new(
                    "00000000-0000-0000-0000-000000000005".parse().unwrap(),
                    7,
                )
                .unwrap()
            )
        );
        let telemetry = discovered
            .runner_preference_claim_telemetry()
            .expect("canonical preference telemetry");
        assert!(matches!(
            telemetry.runner_preference,
            RunnerPreference::Preference {
                tier: RunnerPreferenceTier::ExactSandbox,
                ..
            }
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
    async fn discover_status_error_preserves_episode_until_empty_poll_recovers() {
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
                &poll_transport_error(ApiFailureKind::Timeout),
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
                        assert_eq!(episode.consecutive_failures, 1);
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
        let status_event = captured_event(&events, "poll failed");
        assert_eq!(status_event.level, Level::ERROR);
        assert_eq!(event_field(status_event, "status"), "503");
        assert_eq!(event_field(status_event, "failure_kind"), "http_status");
        assert_eq!(event_field(status_event, "poll_reason"), "immediate");
        assert!(
            !format!("{status_event:#?}").contains(STATUS_BODY),
            "status response body must not be logged: {status_event:#?}"
        );
        let recovery = captured_event(&events, "poll fallback recovered");
        assert_eq!(recovery.level, Level::INFO);
        assert_eq!(event_field(recovery, "poll_reason"), "immediate");
        assert_eq!(event_field(recovery, "recovered_after_failures"), "1");
        assert_eq!(event_field(recovery, "was_degraded"), "false");
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
                            "tier": "workspaceCache",
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
        let provider =
            api_provider_for_test(api_url, CancellationToken::new(), Arc::clone(&wakeups));
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

        tokio::time::sleep_until(
            excluded_poll_observed_at + CLAIM_TRANSIENT_COOLDOWN + Duration::from_millis(50),
        )
        .await;
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
    async fn old_api_returning_excluded_run_does_not_rediscover_it() {
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
        let claim_request = server.next_request("old API claim request").await;
        assert!(claim_request.contains(&format!("/api/runners/jobs/{run_id}/claim")));

        let provider_for_discover = Arc::clone(&provider);
        let mut discover_task = tokio::spawn(async move { provider_for_discover.discover().await });
        let ignored_exclusion_request = server.next_request("old API poll request").await;
        assert!(ignored_exclusion_request.contains(r#""excludedRunIds":["#));
        assert!(ignored_exclusion_request.contains(&run_id.to_string()));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut discover_task)
                .await
                .is_err(),
            "an excluded run returned by an old API must not be rediscovered"
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
        let provider =
            api_provider_for_test(api_url, CancellationToken::new(), Arc::clone(&wakeups));
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
            RunnerError::Api(message) => assert!(
                message.starts_with("poll decode: "),
                "unexpected error: {message}"
            ),
            other => panic!("expected RunnerError::Api, got {other:?}"),
        }
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_not_found_is_unavailable() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
    async fn api_client_claim_decode_error_includes_json_path_without_body_values() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
    async fn api_client_claim_rejects_resume_history_ref_without_encoding() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let path = format!("/api/runners/jobs/{run_id}/claim");
        let mock = server
            .mock_async(|when, then| {
                when.method(POST).path(path.as_str());
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "continue",
                    "sandboxToken": "claim-sandbox-token",
                    "cliAgentType": "claude_code",
                    "resumeSession": {
                        "sessionId": "session-id",
                        "historyRef": {
                            "kind": "blob",
                            "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            "url": "https://storage.example/history?secret=presigned-value",
                            "rawSize": 42,
                            "encodedSize": 42
                        }
                    },
                    "billableFirewalls": [],
                    "platformEnvironment": {},
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
            message.contains("failed at resumeSession"),
            "decode error should identify the resume session, got: {message}"
        );
        assert!(
            !message.contains("claim-sandbox-token"),
            "decode error must not include response body values, got: {message}"
        );
        assert!(
            !message.contains("presigned-value"),
            "decode error must not include response body values, got: {message}"
        );
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn api_client_claim_decode_error_redacts_dynamic_map_keys() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
        let codex_error = claim_decode_error(
            &server,
            run_id,
            serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
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
        let run_id = RunId::nil();
        let error = claim_decode_error(
            &server,
            run_id,
            serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
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
        let run_id = RunId::nil();
        let error = claim_decode_error(
            &server,
            run_id,
            serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
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
    async fn api_client_claim_decode_path_redacts_codex_header_keys() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let error = claim_decode_error(
            &server,
            run_id,
            serde_json::json!({
                "runId": run_id,
                "prompt": "hello",
                "sandboxToken": "claim-sandbox-token",
                "cliAgentType": "claude_code",
                "platformEnvironment": {},
                "connectorRuntimeTargets": [],
                "codexRuntimeConfig": {
                    "providerId": "provider",
                    "name": "provider",
                    "baseUrl": "https://api.example.com",
                    "envKey": "OPENAI_API_KEY",
                    "httpHeaders": {"secret-header-name": 123},
                    "wireApi": "responses",
                    "supportsWebsockets": false
                }
            }),
        )
        .await;

        assert!(
            error.contains("failed at codexRuntimeConfig.httpHeaders.<map-key>"),
            "unexpected Codex header decode error: {error}"
        );
        assert!(!error.contains("secret-header-name"));
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
        let RunnerError::Api(error) = error else {
            panic!("expected RunnerError::Api");
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
        let RunnerError::Api(message) = error else {
            panic!("expected RunnerError::Api");
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
        let RunnerError::Api(error) = error else {
            panic!("expected RunnerError::Api");
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

        let RunnerError::Api(message) = err else {
            panic!("expected RunnerError::Api");
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
                    run_id: RunId::nil(),
                    exit_code: 1,
                    failure_reason: None,
                    error: Some("boom".to_string()),
                    sandbox_id: None,
                    sandbox_reuse_result: None,
                    workspace_reuse_result: None,
                    active_input_delivery_ids: Vec::new(),
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
    async fn api_client_complete_serializes_no_reuse_key() {
        let server = MockServer::start_async().await;
        let run_id = RunId::nil();
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(routes::webhooks::agent::complete::COMPLETE.path)
                    .header("authorization", "Bearer sandbox-token")
                    .json_body(serde_json::json!({
                        "runId": run_id,
                        "exitCode": 0,
                        "sandboxReuseResult": "noReuseKey",
                        "workspaceReuseResult": "noReuseKey",
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
                sandbox_id: None,
                sandbox_reuse_result: Some(SandboxReuseResult::NoReuseKey),
                workspace_reuse_result: Some(WorkspaceReuseResult::NoReuseKey),
                active_input_delivery_ids: Vec::new(),
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
        assert!(
            claim_timing.request_elapsed()
                >= claim_timing.request_to_response_headers_elapsed()
                    + claim_timing.response_body_read_elapsed()
                    + claim_timing.response_decode_elapsed()
        );
        let context = claimed.context();

        assert_eq!(context.run_id, run_id);
        assert_eq!(context.prompt, "Inspect the fixture repository");
        assert_eq!(
            context.append_system_prompt.as_deref(),
            Some("Use the shared contract fixture")
        );
        assert_eq!(
            context.vars.as_ref().unwrap()["FIXTURE_REGION"],
            "test-region"
        );
        assert_eq!(context.storage_manifest.as_ref().unwrap().storages.len(), 1);
        assert!(
            !context.storage_manifest.as_ref().unwrap().storages[0].baseline_candidate,
            "the previous claim fixture must default an absent marker to false"
        );
        assert_eq!(context.cli_agent_session_id(), Some("fixture-session-id"));
        assert_eq!(
            context.environment.as_ref().unwrap()["FIXTURE_MODEL"],
            "fixture-model"
        );
        assert_eq!(
            context.platform_environment["OKOU_AGENT_ID"],
            "fixture-agent-id"
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
            serde_json::to_value(context.x_resource_billing.as_ref().unwrap()).unwrap(),
            serde_json::json!({"protocol": "x-resource-v1", "startDate": "2099-01-01"})
        );
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
    async fn api_provider_claim_accepts_canonical_storage_mount_response() {
        let server = MockServer::start_async().await;
        let run_id: RunId = RUNNER_CLAIM_RESPONSE_FIXTURE_RUN_ID.parse().unwrap();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let mut response: serde_json::Value =
            serde_json::from_str(RUNNER_CLAIM_RESPONSE_FIXTURE).unwrap();
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
        assert!(manifest.storages[0].baseline_candidate);
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
        assert!(!candidate.deferred_sandbox());
        assert!(provider.claim(candidate).await.is_none());
        transient.assert_calls_async(1).await;
        transient.delete_async().await;
        let success = server.mock_async(|when, then| {
            when.method(POST).path(&claim_path).header_missing("X-Pi-Deferred-Sandbox");
            then.status(200).json_body(serde_json::json!({
                "runId": run_id, "prompt": "legacy retry", "sandboxToken": "test-token", "cliAgentType": "claude_code", "platformEnvironment": {}, "connectorRuntimeTargets": []
            }));
        }).await;
        let candidate = tokio::time::timeout(Duration::from_secs(10), provider.discover())
            .await
            .expect("bounded retry poll")
            .expect("retry candidate");
        assert!(!candidate.deferred_sandbox());
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
        let run_id = RunId::nil();
        let claim_path = format!("/api/runners/jobs/{run_id}/claim");
        let claim_mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path(claim_path.as_str())
                    .json_body_includes(
                        serde_json::json!({
                            "runnerIdentity": {
                                "runnerId": TEST_RUNNER_ID,
                                "heartbeatGeneration": TEST_HEARTBEAT_GENERATION,
                            },
                            "runnerHostname": "prod-1.aws.vm3.ai",
                        })
                        .to_string(),
                    );
                then.status(200).json_body(serde_json::json!({
                    "runId": run_id,
                    "prompt": "minimal response",
                    "sandboxToken": "minimal-sandbox-token",
                    "cliAgentType": "claude_code",
                    "platformEnvironment": {},
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
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
            assert!(request.starts_with(&format!("POST /api/runners/jobs/{run_id}/claim ")));
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
                "cliAgentType": "claude_code", "platformEnvironment": {}, "connectorRuntimeTargets": [],
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
                then.status(200).json_body(
                    serde_json::json!({"protocolVersion":1,"runId":run_id,"state":"gone"}),
                );
            })
            .await;
        let cases = [
            (409, "unavailable".to_string()),
            (401, "unauthorized".to_string()),
            (500, "service unavailable".to_string()),
            (200, "malformed".to_string()),
            (200, serde_json::json!({
                "runId":RunId::new_v4(),"prompt":"hello","sandboxToken":"test-token",
                "cliAgentType":"claude_code","platformEnvironment":{},"connectorRuntimeTargets":[],
            }).to_string()),
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
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
        let run_id = RunId::nil();
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
            .complete(complete_request(RunId::nil()), CompletionAuth::local())
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
                complete_request(RunId::nil()),
                CompletionAuth::sandbox_token(RunId::new_v4(), "sandbox-token".to_string()),
            )
            .await;

        mock.assert_calls_async(0).await;
    }

    #[tokio::test]
    async fn api_provider_complete_does_not_retry_permanent_http_failure() {
        let mut server = complete_sequence_server(vec![400]).await;
        let api_url = server.url();
        let run_id = RunId::nil();
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
        assert_eq!(event_field(event, "max_attempts"), "2");
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
            let mut server = complete_sequence_server(vec![status.as_u16(), 200]).await;
            let api_url = server.url();
            let run_id = RunId::nil();
            let provider = api_provider_for_test(
                api_url,
                CancellationToken::new(),
                Arc::new(PollWakeups::new(false)),
            );
            let complete_task = tokio::spawn(async move {
                provider
                    .complete(
                        complete_request(run_id),
                        CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                    )
                    .await;
            });

            let first_request = server
                .next_request("first transient completion request")
                .await;
            assert_complete_authorization(&first_request, "sandbox-token");
            tokio::task::yield_now().await;
            assert!(
                server.try_next_request().is_err(),
                "status {status} should wait before the retry"
            );
            tokio::time::advance(Duration::from_secs(2)).await;
            let second_request = server
                .next_request("retried transient completion request")
                .await;
            assert_complete_authorization(&second_request, "sandbox-token");

            complete_task.await.unwrap();
            server.assert_finished().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_retries_transport_failure() {
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Disconnect,
            RawHttpAction::Respond(status_response(200)),
        ])
        .await;
        let api_url = server.url();
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );
        let complete_task = tokio::spawn(async move {
            provider
                .complete(
                    complete_request(run_id),
                    CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
                )
                .await;
        });

        let first_request = server.next_request("first completion request").await;
        assert_complete_authorization(&first_request, "sandbox-token");
        tokio::task::yield_now().await;
        assert!(
            server.try_next_request().is_err(),
            "transport failure should wait before the retry"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        let second_request = server.next_request("retried completion request").await;
        assert_complete_authorization(&second_request, "sandbox-token");

        complete_task.await.unwrap();
        server.assert_finished().await;
    }

    #[tokio::test(start_paused = true)]
    async fn api_provider_complete_timeout_retry_is_info_and_exhaustion_is_error() {
        for repeated_timeout in [false, true] {
            let (first_release, first_response) = tokio::sync::oneshot::channel();
            let (second_release, second_response) = tokio::sync::oneshot::channel();
            let mut server = RawHttpTestServer::spawn(vec![
                RawHttpAction::WaitThenRespond {
                    release: first_response,
                    response: Vec::new(),
                },
                RawHttpAction::WaitThenRespond {
                    release: second_response,
                    response: if repeated_timeout {
                        Vec::new()
                    } else {
                        status_response(200)
                    },
                },
            ])
            .await;
            let run_id = RunId::nil();
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

            let first_request = tokio::select! {
                () = &mut completion => panic!("completion returned before the first request"),
                request = server.next_request("completion request to time out") => request,
            };
            assert_complete_authorization(&first_request, "sandbox-token");
            // Expire the real HTTP client's deadline after the server receives the request.
            tokio::time::advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
            std::future::poll_fn(|cx| {
                assert!(completion.as_mut().poll(cx).is_pending());
                if captured.entries().iter().any(|event| {
                    event
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
            first_release.send(()).unwrap();
            tokio::time::advance(Duration::from_secs(2)).await;
            let second_request = tokio::select! {
                () = &mut completion => panic!("completion returned before the retry request"),
                request = server.next_request("retried completion request") => request,
            };
            assert_complete_authorization(&second_request, "sandbox-token");
            assert_eq!(
                first_request.split_once("\r\n\r\n").unwrap().1,
                second_request.split_once("\r\n\r\n").unwrap().1,
            );
            if repeated_timeout {
                tokio::time::advance(Duration::from_secs(10) + Duration::from_millis(1)).await;
                completion.await;
                second_release.send(()).unwrap();
            } else {
                second_release.send(()).unwrap();
                completion.await;
            }
            server.assert_finished().await;

            let events = captured.entries();
            let retry_event = captured_event(&events, "completion report failed, retrying");
            assert_eq!(retry_event.level, Level::INFO);
            assert_eq!(event_field(retry_event, "attempt"), "1");
            assert_eq!(event_field(retry_event, "will_retry"), "true");
            assert_eq!(event_field(retry_event, "failure_kind"), "timeout");
            let terminal_events: Vec<_> = events
                .iter()
                .filter(|event| event.level == Level::WARN || event.level == Level::ERROR)
                .collect();
            if repeated_timeout {
                assert_eq!(terminal_events.len(), 1, "{events:#?}");
                let final_event =
                    captured_event(&events, "failed to report completion after retry");
                assert_eq!(final_event.level, Level::ERROR);
                assert_eq!(event_field(final_event, "attempt"), "2");
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
        let run_id = RunId::nil();
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
    async fn api_provider_complete_stops_after_two_transient_failures() {
        let mut server = complete_sequence_server(vec![500, 500]).await;
        let api_url = server.url();
        let run_id = RunId::nil();
        let provider = api_provider_for_test(
            api_url,
            CancellationToken::new(),
            Arc::new(PollWakeups::new(false)),
        );

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let completion = provider
            .complete(
                CompleteRequest {
                    exit_code: 1,
                    error: Some("boom".to_string()),
                    ..complete_request(run_id)
                },
                CompletionAuth::sandbox_token(run_id, "sandbox-token".to_string()),
            )
            .with_subscriber(subscriber);
        tokio::pin!(completion);

        let first_request = tokio::select! {
            () = &mut completion => panic!("completion should wait before the retry"),
            request = server.next_request("first failed completion request") => request,
        };
        assert_complete_authorization(&first_request, "sandbox-token");
        // Establish the retry timer before advancing paused time.
        std::future::poll_fn(|cx| {
            assert!(
                completion.as_mut().poll(cx).is_pending(),
                "completion should wait before the retry"
            );
            if captured.entries().iter().any(|event| {
                event
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
            "completion should wait before the retry"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        let ((), second_request) = tokio::join!(
            &mut completion,
            server.next_request("second failed completion request")
        );
        assert_complete_authorization(&second_request, "sandbox-token");
        server.assert_finished().await;

        let events = captured.entries();
        let run_id = run_id.to_string();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.fields.get("run_id") == Some(&run_id))
                .count(),
            2,
            "two failed requests should produce two provider events: {events:#?}"
        );
        let retry_event = captured_event(&events, "completion report failed, retrying");
        assert_eq!(retry_event.level, Level::WARN);
        assert_eq!(event_field(retry_event, "attempt"), "1");
        assert_eq!(event_field(retry_event, "will_retry"), "true");
        assert_eq!(event_field(retry_event, "status"), "500");
        assert_eq!(event_field(retry_event, "failure_kind"), "http_status");

        let final_event = captured_event(&events, "failed to report completion after retry");
        assert_eq!(final_event.level, Level::ERROR);
        assert_eq!(event_field(final_event, "attempt"), "2");
        assert_eq!(event_field(final_event, "will_retry"), "false");
        assert_eq!(event_field(final_event, "status"), "500");
        assert_eq!(event_field(final_event, "failure_kind"), "http_status");
    }
}
