//! Executor telemetry marker helpers.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use guest_contracts::epoch_milliseconds::{
    MIN_PLAUSIBLE_EPOCH_MILLISECONDS, is_plausible_epoch_milliseconds,
};
use tracing::warn;

use crate::guest_timezone::GuestTimezoneAssumption;
use crate::idle_pool::ExactIdleReservationMiss;
use crate::provider::ApiClaimTiming;
use crate::resource_budget::ResourceBudget;
use crate::telemetry::{
    JobTelemetry, RunnerPreSpawnAttribution, RunnerPreSpawnConcurrencyBucket,
    RunnerResourceBudgetOccupancy, RunnerStartupPath,
};
use crate::types::{ExecutionContext, SandboxReuseResult, WorkspaceReuseResult};
use crate::workspace_image_cache::{WorkspaceCacheCheckoutResult, WorkspaceImageLease};

static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

/// Tracks only post-claim jobs that have not yet spawned a guest process.
#[derive(Clone, Default)]
pub(crate) struct RunnerPreSpawnConcurrency {
    active: Arc<AtomicUsize>,
}

struct RunnerPreSpawnConcurrencyGuard {
    active: Arc<AtomicUsize>,
    attribution: RunnerPreSpawnAttribution,
    preserve_attribution_on_drop: bool,
}

impl RunnerPreSpawnConcurrency {
    fn enter(&self) -> RunnerPreSpawnConcurrencyGuard {
        let existing = self.active.fetch_add(1, Ordering::Relaxed);
        let bucket = match existing {
            0 => RunnerPreSpawnConcurrencyBucket::One,
            1 => RunnerPreSpawnConcurrencyBucket::Two,
            2..=3 => RunnerPreSpawnConcurrencyBucket::ThreeToFour,
            4..=7 => RunnerPreSpawnConcurrencyBucket::FiveToEight,
            _ => RunnerPreSpawnConcurrencyBucket::NinePlus,
        };
        RunnerPreSpawnConcurrencyGuard {
            active: Arc::clone(&self.active),
            attribution: RunnerPreSpawnAttribution::new(bucket),
            preserve_attribution_on_drop: false,
        }
    }
}

impl RunnerPreSpawnConcurrencyGuard {
    fn attribution(&self) -> RunnerPreSpawnAttribution {
        self.attribution.clone()
    }

    fn preserve_attribution_after_spawn(&mut self) {
        // Live membership ends when this guard drops at spawn. The immutable
        // cohort remains valid for the immediately following api_to_spawn row.
        self.preserve_attribution_on_drop = true;
    }

    fn record_resource_budget_occupancy(&mut self, budget: &ResourceBudget) {
        self.attribution
            .set_resource_budget_occupancy(RunnerResourceBudgetOccupancy::capture(budget));
    }
}

impl Drop for RunnerPreSpawnConcurrencyGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        if !self.preserve_attribution_on_drop {
            self.attribution.deactivate();
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum RunnerPreSpawnPhase {
    ResumeSessionValidation,
    FinalizingWait,
    SessionHistoryMaterializerStart,
    DeviceRateLimits,
    IdleReuseLookup,
    WorkspaceCacheStateLookup,
    WorkspacePromotionValidation,
    IdleUnpark,
    ActiveStatusPublish,
    SpawnJobSetup,
}

#[derive(Clone, Copy)]
pub(crate) enum FinalizingHandoffOutcome {
    Accepted,
    ActivationFailed,
    PublishedExact,
    PreFinalizationDeadline,
    NotAcceptedBeforeDeadline,
    NoExact,
    Cancelled,
}

#[derive(Clone, Copy)]
pub(crate) enum FinalizingHandoffReason {
    PreFinalizationDeadline,
    HandoffAcceptanceDeadline,
    PublishedExactUnavailable,
    PredecessorReleasedWithoutExact,
    PredecessorNoExact,
    ExactHandoffUnavailable,
    HandoffRequestUnavailable,
    ExactHandoffClosed,
    SuccessorCancelled,
    ActivationCancelled,
    HandoffIdentityMismatch,
    ExactActivationFallback,
    ExactActivationFailed,
}

impl FinalizingHandoffReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::PreFinalizationDeadline => "pre_finalization_deadline",
            Self::HandoffAcceptanceDeadline => "handoff_acceptance_deadline",
            Self::PublishedExactUnavailable => "published_exact_unavailable",
            Self::PredecessorReleasedWithoutExact => "predecessor_released_without_exact",
            Self::PredecessorNoExact => "predecessor_no_exact",
            Self::ExactHandoffUnavailable => "exact_handoff_unavailable",
            Self::HandoffRequestUnavailable => "handoff_request_unavailable",
            Self::ExactHandoffClosed => "exact_handoff_closed",
            Self::SuccessorCancelled => "successor_cancelled",
            Self::ActivationCancelled => "activation_cancelled",
            Self::HandoffIdentityMismatch => "handoff_identity_mismatch",
            Self::ExactActivationFallback => "exact_activation_fallback",
            Self::ExactActivationFailed => "exact_activation_failed",
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct FinalizingHandoffTelemetry {
    outcome: FinalizingHandoffOutcome,
    reason: Option<FinalizingHandoffReason>,
}

#[derive(Clone, Copy)]
pub(crate) enum FinalizingExactIdleLookup {
    Hit,
    Miss(ExactIdleReservationMiss),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BlankPoolSelectionReason {
    EmptyInventory,
    IncompatibleShape,
    RefillInProgress,
    ForegroundPreempted,
    ResourceUnavailable,
    HeadroomReserved,
    MaxIdle,
    DisabledPlan,
    Unknown,
}

impl BlankPoolSelectionReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::EmptyInventory => "empty_inventory",
            Self::IncompatibleShape => "incompatible_shape",
            Self::RefillInProgress => "refill_in_progress",
            Self::ForegroundPreempted => "foreground_preempted",
            Self::ResourceUnavailable => "resource_unavailable",
            Self::HeadroomReserved => "headroom_reserved",
            Self::MaxIdle => "max_idle",
            Self::DisabledPlan => "disabled_plan",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BlankPoolSelection {
    Hit,
    Miss(BlankPoolSelectionReason),
}

impl BlankPoolSelection {
    fn record(self, telemetry: &mut JobTelemetry) {
        let (outcome, reason) = match self {
            Self::Hit => ("hit", None),
            Self::Miss(reason) => ("miss", Some(reason.as_str())),
        };
        telemetry.record_bounded_outcome(
            "runner_claim_blank_pool_selection",
            true,
            outcome,
            reason,
        );
    }
}

#[derive(Clone, Copy)]
pub(crate) struct FinalizingDiagnostics {
    handoff: Option<FinalizingHandoffTelemetry>,
    exact_idle_lookup: Option<FinalizingExactIdleLookup>,
}

impl FinalizingHandoffOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::ActivationFailed => "activation_failed",
            Self::PublishedExact => "published_exact",
            Self::PreFinalizationDeadline => "pre_finalization_deadline",
            Self::NotAcceptedBeforeDeadline => "not_accepted_before_deadline",
            Self::NoExact => "no_exact",
            Self::Cancelled => "cancelled",
        }
    }

    const fn succeeded(self) -> bool {
        matches!(self, Self::Accepted | Self::PublishedExact)
    }
}

impl FinalizingHandoffTelemetry {
    pub(crate) fn record(self, telemetry: &mut JobTelemetry) {
        telemetry.record_bounded_outcome_with_error(
            "runner_claim_finalizing_handoff",
            self.outcome.succeeded(),
            (!self.outcome.succeeded()).then_some(self.outcome.as_str()),
            self.outcome.as_str(),
            self.reason.map(FinalizingHandoffReason::as_str),
        );
    }
}

impl FinalizingExactIdleLookup {
    fn record(self, telemetry: &mut JobTelemetry) {
        let (outcome, reason) = match self {
            Self::Hit => ("hit", None),
            Self::Miss(reason) => ("miss", Some(reason.as_str())),
        };
        telemetry.record_bounded_outcome(
            "runner_claim_finalizing_exact_idle_lookup",
            true,
            outcome,
            reason,
        );
    }
}

impl FinalizingDiagnostics {
    pub(crate) fn record(self, telemetry: &mut JobTelemetry) {
        if let Some(handoff) = self.handoff {
            handoff.record(telemetry);
        }
        if let Some(exact_idle_lookup) = self.exact_idle_lookup {
            exact_idle_lookup.record(telemetry);
        }
    }
}

impl RunnerPreSpawnPhase {
    const ALL: [Self; 10] = [
        Self::ResumeSessionValidation,
        Self::FinalizingWait,
        Self::SessionHistoryMaterializerStart,
        Self::DeviceRateLimits,
        Self::IdleReuseLookup,
        Self::WorkspaceCacheStateLookup,
        Self::WorkspacePromotionValidation,
        Self::IdleUnpark,
        Self::ActiveStatusPublish,
        Self::SpawnJobSetup,
    ];

    const fn action_type(self) -> &'static str {
        match self {
            Self::ResumeSessionValidation => "runner_claim_resume_session_validation",
            Self::FinalizingWait => "runner_claim_finalizing_wait",
            Self::SessionHistoryMaterializerStart => {
                "runner_claim_session_history_materializer_start"
            }
            Self::DeviceRateLimits => "runner_claim_device_rate_limits",
            Self::IdleReuseLookup => "runner_claim_idle_reuse_lookup",
            Self::WorkspaceCacheStateLookup => "runner_claim_workspace_cache_state_lookup",
            Self::WorkspacePromotionValidation => "runner_claim_workspace_promotion_validation",
            Self::IdleUnpark => "runner_claim_idle_unpark",
            Self::ActiveStatusPublish => "runner_claim_active_status_publish",
            Self::SpawnJobSetup => "runner_claim_spawn_job_setup",
        }
    }
}

#[derive(Default)]
struct RunnerPreSpawnPhaseDurations {
    resume_session_validation: Option<Duration>,
    finalizing_wait: Option<Duration>,
    session_history_materializer_start: Option<Duration>,
    device_rate_limits: Option<Duration>,
    idle_reuse_lookup: Option<Duration>,
    workspace_cache_state_lookup: Option<Duration>,
    workspace_promotion_validation: Option<Duration>,
    idle_unpark: Option<Duration>,
    active_status_publish: Option<Duration>,
    spawn_job_setup: Option<Duration>,
}

impl RunnerPreSpawnPhaseDurations {
    fn get_mut(&mut self, phase: RunnerPreSpawnPhase) -> &mut Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => &mut self.resume_session_validation,
            RunnerPreSpawnPhase::FinalizingWait => &mut self.finalizing_wait,
            RunnerPreSpawnPhase::SessionHistoryMaterializerStart => {
                &mut self.session_history_materializer_start
            }
            RunnerPreSpawnPhase::DeviceRateLimits => &mut self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => &mut self.idle_reuse_lookup,
            RunnerPreSpawnPhase::WorkspaceCacheStateLookup => {
                &mut self.workspace_cache_state_lookup
            }
            RunnerPreSpawnPhase::WorkspacePromotionValidation => {
                &mut self.workspace_promotion_validation
            }
            RunnerPreSpawnPhase::IdleUnpark => &mut self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => &mut self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => &mut self.spawn_job_setup,
        }
    }

    fn get(&self, phase: RunnerPreSpawnPhase) -> Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => self.resume_session_validation,
            RunnerPreSpawnPhase::FinalizingWait => self.finalizing_wait,
            RunnerPreSpawnPhase::SessionHistoryMaterializerStart => {
                self.session_history_materializer_start
            }
            RunnerPreSpawnPhase::DeviceRateLimits => self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => self.idle_reuse_lookup,
            RunnerPreSpawnPhase::WorkspaceCacheStateLookup => self.workspace_cache_state_lookup,
            RunnerPreSpawnPhase::WorkspacePromotionValidation => {
                self.workspace_promotion_validation
            }
            RunnerPreSpawnPhase::IdleUnpark => self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => self.spawn_job_setup,
        }
    }
}

pub(crate) struct RunnerPreSpawnTiming {
    claim_returned_at: Instant,
    api_claim_timing: Option<ApiClaimTiming>,
    concurrency: RunnerPreSpawnConcurrencyGuard,
    phase_durations: RunnerPreSpawnPhaseDurations,
    task_enqueued_at: Option<Instant>,
    exact_reuse_speculation: Option<ExactReuseSpeculationTiming>,
    finalizing_handoff: Option<FinalizingHandoffTelemetry>,
    finalizing_exact_idle_lookup: Option<FinalizingExactIdleLookup>,
    blank_pool_selection: Option<BlankPoolSelection>,
}

#[derive(Clone, Copy)]
pub(crate) struct RunnerPreSpawnOperationTiming {
    pub(crate) duration: Duration,
    pub(crate) succeeded: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct ExactReuseSpeculationTiming {
    pub(crate) unpark: RunnerPreSpawnOperationTiming,
    pub(crate) guest_restore: Option<RunnerPreSpawnOperationTiming>,
    pub(crate) claim_overlap: Duration,
    pub(crate) post_claim_remainder: Duration,
    pub(crate) timezone_correction: Option<RunnerPreSpawnOperationTiming>,
    pub(crate) timezone_assumption: Option<GuestTimezoneAssumption>,
}

pub(super) struct RunnerSpawnTiming {
    executor_started_at: Instant,
    pre_spawn_timing: Option<RunnerPreSpawnTiming>,
}

impl RunnerPreSpawnTiming {
    #[cfg(test)]
    pub(crate) fn start_after_claim() -> Self {
        Self::start_at(Instant::now(), None, &RunnerPreSpawnConcurrency::default())
    }

    pub(crate) fn start_at(
        claim_returned_at: Instant,
        api_claim_timing: Option<ApiClaimTiming>,
        concurrency: &RunnerPreSpawnConcurrency,
    ) -> Self {
        Self {
            claim_returned_at,
            api_claim_timing,
            concurrency: concurrency.enter(),
            phase_durations: RunnerPreSpawnPhaseDurations::default(),
            task_enqueued_at: None,
            exact_reuse_speculation: None,
            finalizing_handoff: None,
            finalizing_exact_idle_lookup: None,
            blank_pool_selection: None,
        }
    }

    pub(crate) fn record_exact_reuse_speculation(&mut self, timing: ExactReuseSpeculationTiming) {
        self.exact_reuse_speculation = Some(timing);
    }

    pub(crate) fn record_finalizing_handoff_outcome(&mut self, outcome: FinalizingHandoffOutcome) {
        self.record_finalizing_handoff(outcome, None);
    }

    pub(crate) fn record_finalizing_handoff(
        &mut self,
        outcome: FinalizingHandoffOutcome,
        reason: Option<FinalizingHandoffReason>,
    ) {
        self.finalizing_handoff = Some(FinalizingHandoffTelemetry { outcome, reason });
    }

    pub(crate) fn finalizing_diagnostics(&self) -> Option<FinalizingDiagnostics> {
        (self.finalizing_handoff.is_some() || self.finalizing_exact_idle_lookup.is_some())
            .then_some(FinalizingDiagnostics {
                handoff: self.finalizing_handoff,
                exact_idle_lookup: self.finalizing_exact_idle_lookup,
            })
    }

    pub(crate) fn record_finalizing_exact_idle_lookup(
        &mut self,
        lookup: FinalizingExactIdleLookup,
    ) {
        // Capacity waits can probe more than once. Retaining only the latest atomic observation
        // emits one terminal decision for the successor instead of one row per retry.
        self.finalizing_exact_idle_lookup = Some(lookup);
    }

    pub(crate) fn record_blank_pool_selection(&mut self, selection: BlankPoolSelection) {
        // A fresh admission can probe before claim and again after authoritative
        // claim metadata is available. Retain only the latest decision so one
        // run emits one terminal blank-selection operation.
        self.blank_pool_selection = Some(selection);
    }

    pub(crate) fn record_phase(&mut self, phase: RunnerPreSpawnPhase, duration: Duration) {
        *self.phase_durations.get_mut(phase) = Some(duration);
    }

    pub(crate) fn record_phase_elapsed(&mut self, phase: RunnerPreSpawnPhase, started_at: Instant) {
        self.record_phase(phase, started_at.elapsed());
    }

    pub(crate) fn mark_task_enqueued(&mut self) {
        self.task_enqueued_at = Some(Instant::now());
    }

    pub(crate) fn record_resource_budget_occupancy(&mut self, budget: &ResourceBudget) {
        self.concurrency.record_resource_budget_occupancy(budget);
    }

    fn elapsed_at(&self, at: Instant) -> Duration {
        at.saturating_duration_since(self.claim_returned_at)
    }

    fn concurrency_attribution(&self) -> RunnerPreSpawnAttribution {
        self.concurrency.attribution()
    }

    fn preserve_concurrency_attribution_after_spawn(&mut self) {
        self.concurrency.preserve_attribution_after_spawn();
    }

    fn record_collected_phases(&self, telemetry: &mut JobTelemetry, executor_started_at: Instant) {
        if let Some(timing) = self.api_claim_timing {
            telemetry.record(
                "runner_claim_http_request",
                timing.request_elapsed(),
                true,
                None,
            );
            telemetry.record(
                "runner_claim_request_to_response_headers",
                timing.request_to_response_headers_elapsed(),
                true,
                None,
            );
            telemetry.record(
                "runner_claim_response_body_read",
                timing.response_body_read_elapsed(),
                true,
                None,
            );
            telemetry.record(
                "runner_claim_response_decode",
                timing.response_decode_elapsed(),
                true,
                None,
            );
        }
        for phase in RunnerPreSpawnPhase::ALL {
            if let Some(duration) = self.phase_durations.get(phase) {
                telemetry.record(phase.action_type(), duration, true, None);
            }
        }
        if let Some(task_enqueued_at) = self.task_enqueued_at {
            telemetry.record(
                "runner_claim_task_schedule_wait",
                executor_started_at.saturating_duration_since(task_enqueued_at),
                true,
                None,
            );
        }
        if let Some(handoff) = self.finalizing_handoff {
            handoff.record(telemetry);
        }
        if let Some(exact_lookup) = self.finalizing_exact_idle_lookup {
            exact_lookup.record(telemetry);
        }
        if let Some(blank_pool_selection) = self.blank_pool_selection {
            blank_pool_selection.record(telemetry);
        }
        if let Some(timing) = self.exact_reuse_speculation.as_ref() {
            telemetry.record(
                "runner_exact_reuse_preclaim_unpark",
                timing.unpark.duration,
                timing.unpark.succeeded,
                (!timing.unpark.succeeded).then_some("speculative_unpark_failed"),
            );
            if let Some(operation) = timing.guest_restore {
                telemetry.record(
                    "runner_exact_reuse_preclaim_guest_restore",
                    operation.duration,
                    operation.succeeded,
                    (!operation.succeeded).then_some("speculative_guest_restore_failed"),
                );
            }
            telemetry.record(
                "runner_exact_reuse_claim_overlap",
                timing.claim_overlap,
                true,
                None,
            );
            telemetry.record(
                "runner_exact_reuse_postclaim_remainder",
                timing.post_claim_remainder,
                true,
                None,
            );
            if let Some(operation) = timing.timezone_correction {
                telemetry.record(
                    "runner_exact_reuse_timezone_correction",
                    operation.duration,
                    operation.succeeded,
                    (!operation.succeeded).then_some("speculative_timezone_correction_failed"),
                );
            }
            if let Some(assumption) = timing.timezone_assumption {
                let action_type = match assumption {
                    GuestTimezoneAssumption::Match => {
                        "runner_exact_reuse_timezone_assumption_match"
                    }
                    GuestTimezoneAssumption::Mismatch => {
                        "runner_exact_reuse_timezone_assumption_mismatch"
                    }
                    GuestTimezoneAssumption::Unknown => {
                        "runner_exact_reuse_timezone_assumption_unknown"
                    }
                };
                telemetry.record(action_type, Duration::ZERO, true, None);
            }
        }
    }
}

impl RunnerSpawnTiming {
    pub(super) fn start(pre_spawn_timing: Option<RunnerPreSpawnTiming>) -> Self {
        Self {
            executor_started_at: Instant::now(),
            pre_spawn_timing,
        }
    }

    pub(super) fn record_claim_to_executor_start(&self, telemetry: &mut JobTelemetry) {
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_ref() {
            telemetry
                .start_runner_pre_spawn_attribution(pre_spawn_timing.concurrency_attribution());
            telemetry.record(
                "runner_claim_to_executor_start",
                pre_spawn_timing.elapsed_at(self.executor_started_at),
                true,
                None,
            );
            pre_spawn_timing.record_collected_phases(telemetry, self.executor_started_at);
        }
    }

    pub(super) fn record_agent_ready_success_at(
        mut self,
        telemetry: &mut JobTelemetry,
        spawned_at: Instant,
        ready_at: Instant,
    ) {
        telemetry.record(
            "runner_executor_start_to_spawn",
            spawned_at.saturating_duration_since(self.executor_started_at),
            true,
            None,
        );
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_ref() {
            telemetry.record(
                "runner_claim_to_spawn",
                pre_spawn_timing.elapsed_at(spawned_at),
                true,
                None,
            );
        }
        telemetry.record(
            "runner_executor_start_to_agent_ready",
            ready_at.saturating_duration_since(self.executor_started_at),
            true,
            None,
        );
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_ref() {
            telemetry.record(
                "runner_claim_to_agent_ready",
                pre_spawn_timing.elapsed_at(ready_at),
                true,
                None,
            );
        }
        if let Some(pre_spawn_timing) = self.pre_spawn_timing.as_mut() {
            pre_spawn_timing.preserve_concurrency_attribution_after_spawn();
        }
    }
}

pub(super) fn record_reuse_result(telemetry: &mut JobTelemetry, result: SandboxReuseResult) {
    let action_type = match result {
        SandboxReuseResult::Reused => "sandbox_reuse_hit",
        SandboxReuseResult::NoReuseKey
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::DeviceLimitMismatch
        | SandboxReuseResult::UnparkFailed => "sandbox_reuse_miss",
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

pub(super) fn record_workspace_cache_result(
    telemetry: &mut JobTelemetry,
    lease: &WorkspaceImageLease,
) {
    let result = lease.result();
    let action_type = match result {
        WorkspaceCacheCheckoutResult::Hit => "workspace_image_cache_hit",
        WorkspaceCacheCheckoutResult::Miss => "workspace_image_cache_miss",
        WorkspaceCacheCheckoutResult::NoReuseKey => "workspace_image_cache_no_reuse_key",
        WorkspaceCacheCheckoutResult::InvalidWorkingDir => {
            "workspace_image_cache_invalid_working_dir"
        }
        WorkspaceCacheCheckoutResult::LockBusy => "workspace_image_cache_lock_busy",
        WorkspaceCacheCheckoutResult::InvalidMetadata => "workspace_image_cache_invalid_metadata",
        WorkspaceCacheCheckoutResult::DiskPressure => "workspace_image_cache_disk_pressure",
    };
    if result == WorkspaceCacheCheckoutResult::LockBusy {
        if let Some((outcome, reason)) = lease.lock_outcome_and_reason() {
            telemetry.record_bounded_outcome(action_type, true, outcome, reason);
        } else {
            telemetry.record(action_type, Duration::ZERO, true, None);
        }
    } else {
        telemetry.record(action_type, Duration::ZERO, true, None);
    }
}

pub(super) fn record_api_latency(
    action_type: &str,
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
) {
    if let Some(duration) = api_latency_duration(action_type, context) {
        telemetry.record(action_type, duration, true, None);
    }
}

pub(super) fn record_api_startup_boundaries(
    context: &ExecutionContext,
    telemetry: &mut JobTelemetry,
    sandbox_reuse_result: SandboxReuseResult,
    workspace_reuse_result: WorkspaceReuseResult,
    shell_started_at: Instant,
    agent_ready_at: Instant,
) {
    let runner_startup_path = if sandbox_reuse_result == SandboxReuseResult::Reused {
        RunnerStartupPath::Sandbox
    } else if workspace_reuse_result == WorkspaceReuseResult::Reused {
        RunnerStartupPath::Workspace
    } else {
        RunnerStartupPath::Cold
    };
    let observed_at = Instant::now();
    let observed_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    if let Some(duration) = api_latency_duration_at(
        "api_to_spawn",
        context,
        shell_started_at,
        observed_at,
        observed_ms,
    ) {
        telemetry.record_api_to_spawn(duration, runner_startup_path, sandbox_reuse_result);
    }
    if let Some(duration) = api_latency_duration_at(
        "api_to_agent_ready",
        context,
        agent_ready_at,
        observed_at,
        observed_ms,
    ) {
        telemetry.record_api_to_agent_ready(duration, runner_startup_path, sandbox_reuse_result);
    }
    telemetry.finish_runner_pre_spawn_attribution();
}

fn api_latency_duration_at(
    action_type: &str,
    context: &ExecutionContext,
    completed_at: Instant,
    observed_at: Instant,
    observed_ms: u64,
) -> Option<Duration> {
    let completed_ago = observed_at.saturating_duration_since(completed_at);
    let completed_ago_ms = completed_ago
        .as_secs()
        .saturating_mul(1_000)
        .saturating_add(u64::from(completed_ago.subsec_millis()));
    let completed_ms = observed_ms.saturating_sub(completed_ago_ms);
    api_latency_duration_from_ms(action_type, context, completed_ms)
}

fn api_latency_duration(action_type: &str, context: &ExecutionContext) -> Option<Duration> {
    let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
    api_latency_duration_from_ms(action_type, context, now_ms)
}

fn api_latency_duration_from_ms(
    action_type: &str,
    context: &ExecutionContext,
    completed_ms: u64,
) -> Option<Duration> {
    if let Some(api_start_ms) = context.api_start_time {
        if let Some(duration) = elapsed_since_api_start_ms(api_start_ms, completed_ms) {
            return Some(duration);
        } else {
            warn_invalid_api_start_time_once(action_type, context, api_start_ms);
        }
    }
    None
}

pub(super) fn warn_invalid_api_start_time_once(
    action_type: &str,
    context: &ExecutionContext,
    api_start_ms: u64,
) {
    if INVALID_API_START_TIME_WARNED.swap(true, Ordering::Relaxed) {
        return;
    }

    warn!(
        run_id = %context.run_id,
        api_start_ms,
        min_epoch_ms_timestamp = MIN_PLAUSIBLE_EPOCH_MILLISECONDS,
        action_type,
        "skipping API latency telemetry for invalid epoch-ms start timestamp"
    );
}

pub(super) fn elapsed_since_api_start_ms(api_start_ms: u64, now_ms: u64) -> Option<Duration> {
    if !is_plausible_epoch_milliseconds(api_start_ms) {
        return None;
    }

    Some(Duration::from_millis(now_ms.saturating_sub(api_start_ms)))
}
