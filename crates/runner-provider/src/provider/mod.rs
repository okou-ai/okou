//! Job provider trait and implementations.
//!
//! The [`JobProvider`] trait abstracts job lifecycle (discovery, claiming,
//! completion reporting) so different transports can be plugged in without
//! changing the executor or main loop.

mod api;
mod api_ably_supervisor;
mod api_cancellation_reconciliation;
mod api_claim_cooldowns;
mod api_direct_candidates;
mod builtin_firewall_catalog;
mod connector_runtime_sync;
mod local;

pub use api::ApiClient;
pub use api::{ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths};
pub use connector_runtime_sync::{ConnectorRuntimeSyncHandle, ConnectorRuntimeSyncRegistration};
pub use local::LocalProvider;

use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize, de::Error as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::active_input::ActiveInputSource;
use crate::error::ProviderResult;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_types::ids::RunId;
use runner_types::types::{CompleteRequest, ExecutionContext, HeartbeatState};

/// Consumer-owned handler for non-provider messages received on the shared
/// Runner Ably subscription.
pub trait AblySideMessageHandler: Send + Sync {
    /// Return `true` when the message was recognized and consumed.
    fn handle(&self, message: &ably_subscriber::Message) -> bool;
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerPreferenceTier {
    ExactSandbox,
    FinalizingPredecessor,
    ReusableSandbox,
    WorkspaceCache,
}

impl RunnerPreferenceTier {
    pub fn rank(self) -> u8 {
        match self {
            Self::WorkspaceCache => 1,
            Self::ReusableSandbox => 2,
            Self::FinalizingPredecessor => 3,
            Self::ExactSandbox => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunnerNoPreferenceReason {
    NoReuseKey,
    Expired,
    NoViableHolder,
    LookupError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerPreferenceClaimState {
    Active,
    Expired,
    Cleared,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunnerPreferenceRemovalReason {
    Expired,
    Cleared,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum RunnerPreference {
    #[serde(rename = "preference")]
    Preference {
        #[serde(rename = "runnerIdentity")]
        runner_identity: RunnerProcessIdentity,
        tier: RunnerPreferenceTier,
        #[serde(rename = "expiresAt")]
        expires_at: DateTime<FixedOffset>,
    },
    #[serde(rename = "noPreference")]
    NoPreference { reason: RunnerNoPreferenceReason },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveRunnerPreference {
    runner_identity: RunnerProcessIdentity,
    tier: RunnerPreferenceTier,
    deadline: Instant,
}

impl ActiveRunnerPreference {
    pub fn tier(&self) -> RunnerPreferenceTier {
        self.tier
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn is_expired(&self) -> bool {
        self.deadline <= Instant::now()
    }

    pub fn targets(&self, runner_identity: RunnerProcessIdentity) -> bool {
        self.runner_identity == runner_identity
    }

    pub fn new(
        runner_identity: RunnerProcessIdentity,
        tier: RunnerPreferenceTier,
        deadline: Instant,
    ) -> Self {
        Self {
            runner_identity,
            tier,
            deadline,
        }
    }
}

pub fn parse_runner_preference(
    value: Option<serde_json::Value>,
) -> Result<Option<RunnerPreferenceContext>, serde_json::Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    let runner_preference: RunnerPreference = serde_json::from_value(value)?;
    let active_preference = match &runner_preference {
        RunnerPreference::Preference {
            runner_identity,
            tier,
            expires_at,
        } => Some(ActiveRunnerPreference {
            runner_identity: *runner_identity,
            tier: *tier,
            deadline: preference_deadline(*expires_at)?,
        }),
        RunnerPreference::NoPreference { .. } => None,
    };
    Ok(Some(RunnerPreferenceContext {
        runner_preference,
        active_preference,
        removal_reason: None,
    }))
}

fn preference_deadline(expires_at: DateTime<FixedOffset>) -> Result<Instant, serde_json::Error> {
    let now = Instant::now();
    let remaining = (expires_at.with_timezone(&Utc) - Utc::now())
        .to_std()
        .unwrap_or_default();
    now.checked_add(remaining)
        .ok_or_else(|| serde_json::Error::custom("runner preference expiry is out of range"))
}

/// Low-cardinality source that first discovered a job candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobDiscoverySource {
    Ably,
    Poll,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionReportTiming {
    ConcurrentWithFinalization,
    AfterFinalization,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerPreferenceContext {
    runner_preference: RunnerPreference,
    active_preference: Option<ActiveRunnerPreference>,
    removal_reason: Option<RunnerPreferenceRemovalReason>,
}

impl RunnerPreferenceContext {
    pub fn preference(&self) -> Option<&ActiveRunnerPreference> {
        self.active_preference.as_ref()
    }

    fn remove_preference(&mut self, removal_reason: RunnerPreferenceRemovalReason) {
        self.active_preference = None;
        self.removal_reason = Some(removal_reason);
    }

    fn from_active_preference(preference: ActiveRunnerPreference) -> Self {
        let runner_identity = preference.runner_identity;
        let tier = preference.tier;
        let expires_at = (Utc::now()
            + chrono::Duration::from_std(preference.remaining()).unwrap_or(chrono::Duration::MAX))
        .fixed_offset();
        Self {
            runner_preference: RunnerPreference::Preference {
                runner_identity,
                tier,
                expires_at,
            },
            active_preference: Some(preference),
            removal_reason: None,
        }
    }

    #[cfg(test)]
    pub fn no_preference_for_test(reason: RunnerNoPreferenceReason) -> Self {
        Self {
            runner_preference: RunnerPreference::NoPreference { reason },
            active_preference: None,
            removal_reason: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunnerPreferenceClaimTelemetry {
    pub runner_preference: RunnerPreference,
    pub state: Option<RunnerPreferenceClaimState>,
}

impl JobDiscoverySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ably => "ably",
            Self::Poll => "poll",
        }
    }
}

/// Discovered work item ready for the non-cancellable claim phase.
#[derive(Clone, Debug)]
pub struct JobCandidate {
    run_id: RunId,
    profile_name: String,
    local_job_path: Option<PathBuf>,
    discovered_at: Instant,
    provider_discovery_returned_at: Option<Instant>,
    provider_discovery_to_main_loop_elapsed: Option<Duration>,
    main_loop_handling_started_at: Option<Instant>,
    main_loop_to_local_admission_elapsed: Option<Duration>,
    local_admission_started_at: Option<Instant>,
    discovery_source: Option<JobDiscoverySource>,
    direct_candidate_notification_to_enqueue_elapsed: Option<Duration>,
    direct_candidate_inbox_wait_elapsed: Option<Duration>,
    poll_reason: Option<String>,
    poll_due_to_job_discovered_elapsed: Option<Duration>,
    poll_http_request_elapsed: Option<Duration>,
    reuse_key: Option<String>,
    history_generation_run_id: Option<RunId>,
    runner_preference_context: Option<RunnerPreferenceContext>,
}

impl JobCandidate {
    pub fn new(run_id: RunId, profile_name: String) -> Self {
        Self::new_with_discovered_at(run_id, profile_name, Instant::now())
    }

    pub fn new_with_discovered_at(
        run_id: RunId,
        profile_name: String,
        discovered_at: Instant,
    ) -> Self {
        Self {
            run_id,
            profile_name,
            local_job_path: None,
            discovered_at,
            provider_discovery_returned_at: None,
            provider_discovery_to_main_loop_elapsed: None,
            main_loop_handling_started_at: None,
            main_loop_to_local_admission_elapsed: None,
            local_admission_started_at: None,
            discovery_source: None,
            direct_candidate_notification_to_enqueue_elapsed: None,
            direct_candidate_inbox_wait_elapsed: None,
            poll_reason: None,
            poll_due_to_job_discovered_elapsed: None,
            poll_http_request_elapsed: None,
            reuse_key: None,
            history_generation_run_id: None,
            runner_preference_context: None,
        }
    }

    pub fn local(run_id: RunId, profile_name: String, job_path: PathBuf) -> Self {
        Self {
            local_job_path: Some(job_path),
            ..Self::new(run_id, profile_name)
        }
    }

    pub fn run_id(&self) -> RunId {
        self.run_id
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub fn local_job_path(&self) -> Option<&Path> {
        self.local_job_path.as_deref()
    }

    pub fn mark_provider_discovery_returned(&mut self) {
        self.provider_discovery_returned_at = Some(Instant::now());
    }

    pub fn mark_main_loop_handling_started(&mut self) {
        let started_at = Instant::now();
        if let Some(provider_returned_at) = self.provider_discovery_returned_at {
            self.provider_discovery_to_main_loop_elapsed =
                Some(started_at.saturating_duration_since(provider_returned_at));
        }
        self.main_loop_handling_started_at = Some(started_at);
    }

    pub fn mark_local_admission_started(&mut self) {
        let started_at = Instant::now();
        if let Some(main_loop_started_at) = self.main_loop_handling_started_at {
            self.main_loop_to_local_admission_elapsed =
                Some(started_at.saturating_duration_since(main_loop_started_at));
        }
        self.local_admission_started_at = Some(started_at);
    }

    pub fn job_discovered_elapsed(&self) -> Duration {
        self.discovered_at.elapsed()
    }

    pub fn local_admission_elapsed(&self) -> Option<Duration> {
        self.local_admission_started_at
            .map(|started| started.elapsed())
    }

    pub fn direct_candidate_notification_to_enqueue_elapsed(&self) -> Option<Duration> {
        self.direct_candidate_notification_to_enqueue_elapsed
    }

    pub fn direct_candidate_inbox_wait_elapsed(&self) -> Option<Duration> {
        self.direct_candidate_inbox_wait_elapsed
    }

    pub fn provider_discovery_to_main_loop_elapsed(&self) -> Option<Duration> {
        self.provider_discovery_to_main_loop_elapsed
    }

    pub fn main_loop_to_local_admission_elapsed(&self) -> Option<Duration> {
        self.main_loop_to_local_admission_elapsed
    }

    pub fn discovery_source(&self) -> Option<JobDiscoverySource> {
        self.discovery_source
    }

    pub fn poll_reason(&self) -> Option<&str> {
        self.poll_reason.as_deref()
    }

    pub fn poll_due_to_job_discovered_elapsed(&self) -> Option<Duration> {
        self.poll_due_to_job_discovered_elapsed
    }

    pub fn poll_http_request_elapsed(&self) -> Option<Duration> {
        self.poll_http_request_elapsed
    }

    pub fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }

    pub fn history_generation_run_id(&self) -> Option<RunId> {
        self.history_generation_run_id
    }

    pub fn runner_preference(&self) -> Option<&ActiveRunnerPreference> {
        self.runner_preference_context
            .as_ref()
            .and_then(RunnerPreferenceContext::preference)
    }

    pub fn without_runner_preference(
        mut self,
        removal_reason: RunnerPreferenceRemovalReason,
    ) -> Self {
        if let Some(context) = &mut self.runner_preference_context {
            context.remove_preference(removal_reason);
        }
        self
    }

    pub fn with_reuse_key(mut self, reuse_key: Option<String>) -> Self {
        self.reuse_key = reuse_key.filter(|reuse_key| !reuse_key.is_empty());
        self
    }

    pub fn with_parsed_runner_preference_context(
        mut self,
        context: Option<RunnerPreferenceContext>,
    ) -> Self {
        self.runner_preference_context = context;
        self
    }

    pub fn with_runner_preference(mut self, preference: ActiveRunnerPreference) -> Self {
        self.runner_preference_context =
            Some(RunnerPreferenceContext::from_active_preference(preference));
        self
    }

    #[cfg(test)]
    pub fn with_no_runner_preference_for_test(mut self, reason: RunnerNoPreferenceReason) -> Self {
        self.runner_preference_context =
            Some(RunnerPreferenceContext::no_preference_for_test(reason));
        self
    }

    pub fn runner_preference_claim_telemetry(&self) -> Option<RunnerPreferenceClaimTelemetry> {
        let context = self.runner_preference_context.as_ref()?;
        let state = match &context.runner_preference {
            RunnerPreference::NoPreference { .. } => None,
            RunnerPreference::Preference { .. } => Some(match context.preference() {
                Some(preference) if preference.is_expired() => RunnerPreferenceClaimState::Expired,
                Some(_) => RunnerPreferenceClaimState::Active,
                None => match context.removal_reason {
                    Some(RunnerPreferenceRemovalReason::Expired) => {
                        RunnerPreferenceClaimState::Expired
                    }
                    Some(RunnerPreferenceRemovalReason::Cleared) | None => {
                        RunnerPreferenceClaimState::Cleared
                    }
                },
            }),
        };
        Some(RunnerPreferenceClaimTelemetry {
            runner_preference: context.runner_preference.clone(),
            state,
        })
    }

    pub fn with_history_generation_run_id(
        mut self,
        history_generation_run_id: Option<RunId>,
    ) -> Self {
        self.history_generation_run_id = history_generation_run_id;
        self
    }

    pub fn with_discovery_source(mut self, source: JobDiscoverySource) -> Self {
        self.discovery_source = Some(source);
        self
    }

    pub fn with_direct_candidate_timing(
        mut self,
        notification_to_enqueue_elapsed: Option<Duration>,
        inbox_wait_elapsed: Option<Duration>,
    ) -> Self {
        self.direct_candidate_notification_to_enqueue_elapsed = notification_to_enqueue_elapsed;
        self.direct_candidate_inbox_wait_elapsed = inbox_wait_elapsed;
        self
    }

    pub fn with_poll_reason(mut self, poll_reason: impl Into<String>) -> Self {
        self.poll_reason = Some(poll_reason.into());
        self
    }

    pub fn with_poll_timing(
        mut self,
        poll_due_to_job_discovered_elapsed: Duration,
        poll_http_request_elapsed: Duration,
    ) -> Self {
        self.poll_due_to_job_discovered_elapsed = Some(poll_due_to_job_discovered_elapsed);
        self.poll_http_request_elapsed = Some(poll_http_request_elapsed);
        self
    }

    #[cfg(test)]
    pub fn new_with_timing_for_test(
        run_id: RunId,
        profile_name: String,
        discovered_at: Instant,
        local_admission_started_at: Option<Instant>,
    ) -> Self {
        Self {
            local_admission_started_at,
            ..Self::new_with_discovered_at(run_id, profile_name, discovered_at)
        }
    }
}

/// Job claim result with the context and auth required for terminal completion.
pub struct ClaimedJob {
    context: ExecutionContext,
    completion_auth: CompletionAuth,
    active_input_source: Option<ActiveInputSource>,
    api_claim_timing: Option<ApiClaimTiming>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ApiClaimTiming {
    request_elapsed: Duration,
    request_to_response_headers_elapsed: Duration,
    response_body_read_elapsed: Duration,
    response_first_body_chunk_wait_elapsed: Duration,
    response_decode_elapsed: Duration,
    response_attribution: ClaimResponseAttribution,
}

/// Bounded facts about the application-visible successful claim response.
/// Neither field represents bytes transferred by an intermediary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimResponseAttribution {
    body_size_bucket: &'static str,
    content_encoding: &'static str,
}

impl ClaimResponseAttribution {
    pub fn from_body_and_encoding(
        body_bytes: usize,
        content_encoding: Option<&reqwest::header::HeaderValue>,
    ) -> Self {
        let body_size_bucket = match body_bytes {
            0..=4095 => "lt_4_kib",
            4096..=16383 => "4_16_kib",
            16384..=65535 => "16_64_kib",
            65536..=262143 => "64_256_kib",
            262144..=1048575 => "256_kib_1_mib",
            _ => "ge_1_mib",
        };
        let content_encoding = match content_encoding.map(reqwest::header::HeaderValue::to_str) {
            None => "absent",
            Some(Err(_)) => "invalid",
            Some(Ok(value)) => match value.trim() {
                value if value.eq_ignore_ascii_case("identity") => "identity",
                value if value.eq_ignore_ascii_case("gzip") => "gzip",
                value if value.eq_ignore_ascii_case("br") => "br",
                value if value.eq_ignore_ascii_case("deflate") => "deflate",
                value if value.eq_ignore_ascii_case("zstd") => "zstd",
                "" => "invalid",
                _ => "other",
            },
        };
        Self {
            body_size_bucket,
            content_encoding,
        }
    }

    pub const fn body_size_bucket(self) -> &'static str {
        self.body_size_bucket
    }

    pub const fn content_encoding(self) -> &'static str {
        self.content_encoding
    }
}

impl ApiClaimTiming {
    pub const fn new(
        request_elapsed: Duration,
        request_to_response_headers_elapsed: Duration,
        response_body_read_elapsed: Duration,
        response_first_body_chunk_wait_elapsed: Duration,
        response_decode_elapsed: Duration,
        response_attribution: ClaimResponseAttribution,
    ) -> Self {
        Self {
            request_elapsed,
            request_to_response_headers_elapsed,
            response_body_read_elapsed,
            response_first_body_chunk_wait_elapsed,
            response_decode_elapsed,
            response_attribution,
        }
    }

    pub const fn request_elapsed(self) -> Duration {
        self.request_elapsed
    }

    pub const fn request_to_response_headers_elapsed(self) -> Duration {
        self.request_to_response_headers_elapsed
    }

    pub const fn response_body_read_elapsed(self) -> Duration {
        self.response_body_read_elapsed
    }

    /// Time after response headers until the first non-empty, application-visible body chunk.
    /// This is not a server-flush or first physical wire-byte measurement.
    pub const fn response_first_body_chunk_wait_elapsed(self) -> Duration {
        self.response_first_body_chunk_wait_elapsed
    }

    /// Reconcile the emitted millisecond durations with the existing total event.
    /// Subtracting sub-millisecond Durations before serialization can otherwise
    /// lose one millisecond when each event is truncated independently.
    pub fn response_body_after_first_chunk_elapsed(self) -> Duration {
        let total_ms =
            u64::try_from(self.response_body_read_elapsed.as_millis()).unwrap_or(u64::MAX);
        let first_ms = u64::try_from(self.response_first_body_chunk_wait_elapsed.as_millis())
            .unwrap_or(u64::MAX);
        assert!(
            first_ms <= total_ms,
            "first body chunk must arrive before body read completes"
        );
        Duration::from_millis(total_ms - first_ms)
    }

    pub const fn response_decode_elapsed(self) -> Duration {
        self.response_decode_elapsed
    }

    pub const fn response_attribution(self) -> ClaimResponseAttribution {
        self.response_attribution
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimedJobRunIdMismatch {
    pub expected_run_id: RunId,
    pub context_run_id: RunId,
}

impl ClaimedJob {
    fn validate_run_id(
        expected_run_id: RunId,
        context: &ExecutionContext,
    ) -> Result<(), ClaimedJobRunIdMismatch> {
        if context.run_id == expected_run_id {
            Ok(())
        } else {
            Err(ClaimedJobRunIdMismatch {
                expected_run_id,
                context_run_id: context.run_id,
            })
        }
    }

    pub fn api(
        expected_run_id: RunId,
        context: ExecutionContext,
        api_claim_timing: ApiClaimTiming,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::api_with_optional_source(expected_run_id, context, None, api_claim_timing)
    }

    pub fn api_with_active_input_source(
        expected_run_id: RunId,
        context: ExecutionContext,
        active_input_source: ActiveInputSource,
        api_claim_timing: ApiClaimTiming,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::api_with_optional_source(
            expected_run_id,
            context,
            Some(active_input_source),
            api_claim_timing,
        )
    }

    fn api_with_optional_source(
        expected_run_id: RunId,
        context: ExecutionContext,
        active_input_source: Option<ActiveInputSource>,
        api_claim_timing: ApiClaimTiming,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        let completion_auth =
            CompletionAuth::sandbox_token(context.run_id, context.sandbox_token.clone());
        Ok(Self {
            context,
            completion_auth,
            active_input_source,
            api_claim_timing: Some(api_claim_timing),
        })
    }

    #[cfg(test)]
    pub fn local(
        expected_run_id: RunId,
        context: ExecutionContext,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::local_with_active_input_source(expected_run_id, context, None)
    }

    pub fn local_with_active_input_source(
        expected_run_id: RunId,
        context: ExecutionContext,
        active_input_source: Option<ActiveInputSource>,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        Ok(Self {
            context,
            completion_auth: CompletionAuth::local(),
            active_input_source,
            api_claim_timing: None,
        })
    }

    pub fn into_parts(self) -> (ExecutionContext, CompletionAuth, Option<ActiveInputSource>) {
        (self.context, self.completion_auth, self.active_input_source)
    }

    pub fn context(&self) -> &ExecutionContext {
        &self.context
    }

    pub fn api_claim_timing(&self) -> Option<ApiClaimTiming> {
        self.api_claim_timing
    }

    #[cfg(test)]
    pub fn active_input_source(&self) -> Option<&ActiveInputSource> {
        self.active_input_source.as_ref()
    }
}

/// Auth material needed by a provider to report terminal completion.
pub struct CompletionAuth {
    kind: CompletionAuthKind,
}

enum CompletionAuthKind {
    Sandbox { run_id: RunId, token: String },
    Local,
}

#[derive(Debug)]
pub enum CompletionAuthError {
    NotSandbox,
    RunIdMismatch { auth_run_id: RunId },
}

impl CompletionAuth {
    pub fn sandbox_token(run_id: RunId, token: String) -> Self {
        Self {
            kind: CompletionAuthKind::Sandbox { run_id, token },
        }
    }

    pub fn local() -> Self {
        Self {
            kind: CompletionAuthKind::Local,
        }
    }

    pub fn into_sandbox_token(self, expected_run_id: RunId) -> Result<String, CompletionAuthError> {
        match self.kind {
            CompletionAuthKind::Sandbox { run_id, token } if run_id == expected_run_id => Ok(token),
            CompletionAuthKind::Sandbox { run_id, .. } => Err(CompletionAuthError::RunIdMismatch {
                auth_run_id: run_id,
            }),
            CompletionAuthKind::Local => Err(CompletionAuthError::NotSandbox),
        }
    }
}

/// Abstraction over job lifecycle — discovery, claiming, and completion reporting.
///
/// The runner main loop calls [`discover()`](JobProvider::discover) to find work,
/// [`claim()`](JobProvider::claim) to claim it, and
/// [`complete()`](JobProvider::complete) to report results. All transport
/// details (Ably control-plane notifications, HTTP poll, WebSocket, etc.) are
/// hidden behind this trait.
///
/// `discover()` and `claim()` are deliberately separate so that `discover()`
/// can live as a cancellable `select!` branch future while `claim()` runs
/// inside the branch handler where it cannot be interrupted.
#[async_trait::async_trait]
pub trait JobProvider: Send + Sync {
    /// Wait for the next job candidate. Returns `None` on shutdown signal.
    ///
    /// Implementations handle discovery (push/poll) internally. The returned
    /// candidate contains the `run_id` and profile name (e.g. `"vm0/default"`)
    /// for resource-budget pre-checking before
    /// [`claim()`](JobProvider::claim).
    ///
    /// This method has **no server-side side effects** and can be safely
    /// dropped (cancelled) at any `.await` point.
    async fn discover(&self) -> Option<JobCandidate>;

    /// Return one already-buffered job candidate without waiting or polling.
    ///
    /// Default no-op for providers that do not have a local push-delivery
    /// inbox. Implementations must not perform network I/O here; the runner
    /// main loop uses this only for bounded catch-up after a normal discovery.
    async fn try_discover_ready(&self) -> Option<JobCandidate> {
        None
    }

    /// Run provider-owned startup work that must finish before this runner can
    /// admit jobs.
    ///
    /// The start loop calls this after publishing observable `starting` status
    /// and before transitioning to `running`.
    async fn prepare_startup_readiness(&self) -> ProviderResult<()> {
        Ok(())
    }

    /// Claim a discovered job. Returns `None` if the job was already claimed
    /// by another runner or an error occurred. A returned claim must carry an
    /// execution context whose `run_id` matches the discovered candidate.
    ///
    /// Callers **must** invoke this from a non-cancellable context (e.g.
    /// inside a `select!` branch handler) to guarantee that a successful
    /// claim is always paired with a later [`complete()`](JobProvider::complete).
    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob>;

    /// Controls when reporting completion may make the terminal result
    /// externally observable.
    ///
    /// API-backed providers can report while finalization runs because the API
    /// coordinates immediate successors with finalizing runner state. Providers
    /// whose completion result directly releases a local caller can require
    /// finalization first so a following reuse-dependent submission is safe.
    fn completion_report_timing(&self) -> CompletionReportTiming {
        CompletionReportTiming::AfterFinalization
    }

    /// Report job completion. Called concurrently from spawned executor tasks.
    ///
    /// The request carries the exit status and optional sandbox/workspace reuse
    /// outcomes. Reuse fields remain optional for failures that happen before
    /// the corresponding decision is final.
    ///
    /// `completion_auth` is returned by [`claim()`](JobProvider::claim) and
    /// carried by the claimed job lifecycle until completion.
    async fn complete(&self, request: CompleteRequest, completion_auth: CompletionAuth);

    /// Report runner state to the server as a best-effort operation.
    ///
    /// Delivery failures do not affect runner operation, but callers retain
    /// the future to enforce single-flight and lifecycle ordering.
    async fn heartbeat(&self, state: &HeartbeatState);

    /// Defer the next API-backed poll until the immutable preference deadline
    /// allows normal compatible-runner claiming.
    /// Default no-op — only relevant for API-backed providers.
    async fn defer_poll_until(&self, _deadline: Instant) {}

    /// Stop provider-owned discovery work and release its resources.
    ///
    /// Called once when the runner will perform no further discovery.
    /// [`discover()`](JobProvider::discover) may never have started, may have
    /// returned `None`, or may still be pending when a lifecycle transition
    /// ends the reactor. In the last case, callers drop the pending future
    /// before invoking this method so provider-local borrows and guards are
    /// released first. This ordering preserves the fix for the shutdown
    /// deadlock reported in #8890 (PR #8898).
    ///
    /// During normal reactor teardown, the runner sends a final
    /// [`heartbeat()`](JobProvider::heartbeat) after this method returns and
    /// then drains in-flight jobs. Concurrent
    /// [`complete()`](JobProvider::complete) calls may therefore still arrive.
    async fn shutdown(&self);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::execution_context::execution_context_for_test;

    fn minimal_context(run_id: RunId) -> ExecutionContext {
        let mut ctx = execution_context_for_test(run_id);
        ctx.sandbox_token = "sandbox-token".into();
        ctx
    }

    fn api_claim_timing() -> ApiClaimTiming {
        ApiClaimTiming::new(
            Duration::from_millis(10),
            Duration::from_millis(4),
            Duration::from_millis(2),
            Duration::from_millis(1),
            Duration::from_millis(3),
            ClaimResponseAttribution::from_body_and_encoding(100, None),
        )
    }

    #[test]
    fn claim_response_attribution_uses_fixed_size_and_encoding_labels() {
        let cases = [
            (0, "lt_4_kib"),
            (4095, "lt_4_kib"),
            (4096, "4_16_kib"),
            (16384, "16_64_kib"),
            (65536, "64_256_kib"),
            (262144, "256_kib_1_mib"),
            (1048576, "ge_1_mib"),
        ];
        for (bytes, expected) in cases {
            assert_eq!(
                ClaimResponseAttribution::from_body_and_encoding(bytes, None).body_size_bucket(),
                expected,
            );
        }

        use reqwest::header::HeaderValue;
        let cases = [
            (None, "absent"),
            (Some(HeaderValue::from_static("identity")), "identity"),
            (Some(HeaderValue::from_static("GZIP")), "gzip"),
            (Some(HeaderValue::from_static("br")), "br"),
            (Some(HeaderValue::from_static("deflate")), "deflate"),
            (Some(HeaderValue::from_static("zstd")), "zstd"),
            (Some(HeaderValue::from_static("gzip, br")), "other"),
            (Some(HeaderValue::from_static(" ")), "invalid"),
            (Some(HeaderValue::from_bytes(b"\xff").unwrap()), "invalid"),
        ];
        for (header, expected) in cases {
            assert_eq!(
                ClaimResponseAttribution::from_body_and_encoding(100, header.as_ref())
                    .content_encoding(),
                expected,
            );
        }
    }

    #[test]
    fn claimed_job_rejects_mismatched_api_context() {
        let expected_run_id = RunId::from(uuid::Uuid::nil());
        let context_run_id = RunId::new_v4();

        let Err(err) = ClaimedJob::api(
            expected_run_id,
            minimal_context(context_run_id),
            api_claim_timing(),
        ) else {
            panic!("mismatched context must be rejected");
        };

        assert_eq!(
            err,
            ClaimedJobRunIdMismatch {
                expected_run_id,
                context_run_id,
            }
        );
    }

    #[test]
    fn claimed_job_accepts_matching_api_context() {
        let run_id = RunId::from(uuid::Uuid::nil());

        let claimed = ClaimedJob::api(run_id, minimal_context(run_id), api_claim_timing())
            .expect("matching context is valid");
        assert_eq!(claimed.api_claim_timing(), Some(api_claim_timing()));
        let (context, completion_auth, active_input_source) = claimed.into_parts();

        assert_eq!(context.run_id, run_id);
        assert!(active_input_source.is_none());
        assert_eq!(
            completion_auth.into_sandbox_token(run_id).unwrap(),
            "sandbox-token"
        );
    }

    #[test]
    fn claimed_job_local_context_has_no_api_claim_timing() {
        let run_id = RunId::from(uuid::Uuid::nil());

        let claimed = ClaimedJob::local(run_id, minimal_context(run_id))
            .expect("matching local context is valid");

        assert!(claimed.api_claim_timing().is_none());
    }
}
