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

use crate::resource_budget::ResourceBudget;
use crate::telemetry::{
    JobTelemetry, RunnerPreSpawnAttribution, RunnerPreSpawnConcurrencyBucket,
    RunnerResourceBudgetOccupancy, RunnerStartupPath,
};
use runner_types::types::{ExecutionContext, SandboxReuseResult};

static INVALID_API_START_TIME_WARNED: AtomicBool = AtomicBool::new(false);

/// Tracks post-claim Runner startup work through Agent readiness.
///
/// Membership ends when startup timing is consumed after readiness or dropped
/// on early exit. Each admission captures a fixed concurrency cohort including
/// the new job, rather than a continuously updated gauge.
#[derive(Clone, Default)]
pub struct RunnerPreSpawnConcurrency {
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
        // Live membership ends when startup timing is consumed after Agent readiness.
        // Keep the admission-time cohort for the following api_to_spawn and
        // api_to_agent_ready rows after this guard drops.
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
pub enum RunnerPreSpawnPhase {
    ResumeSessionValidation,
    DeviceRateLimits,
    IdleReuseLookup,
    HomeCacheStateLookup,
    HomePromotionValidation,
    IdleUnpark,
    ActiveStatusPublish,
    SpawnJobSetup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlankPoolSelectionReason {
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
    pub const fn as_str(self) -> &'static str {
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
pub enum BlankPoolSelection {
    Hit,
    Miss(BlankPoolSelectionReason),
}

impl BlankPoolSelection {
    pub fn record(self, telemetry: &mut JobTelemetry) {
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

impl RunnerPreSpawnPhase {
    const ALL: [Self; 8] = [
        Self::ResumeSessionValidation,
        Self::DeviceRateLimits,
        Self::IdleReuseLookup,
        Self::HomeCacheStateLookup,
        Self::HomePromotionValidation,
        Self::IdleUnpark,
        Self::ActiveStatusPublish,
        Self::SpawnJobSetup,
    ];

    const fn action_type(self) -> &'static str {
        match self {
            Self::ResumeSessionValidation => "runner_claim_resume_session_validation",
            Self::DeviceRateLimits => "runner_claim_device_rate_limits",
            Self::IdleReuseLookup => "runner_claim_idle_reuse_lookup",
            Self::HomeCacheStateLookup => "runner_claim_home_cache_state_lookup",
            Self::HomePromotionValidation => "runner_claim_home_promotion_validation",
            Self::IdleUnpark => "runner_claim_idle_unpark",
            Self::ActiveStatusPublish => "runner_claim_active_status_publish",
            Self::SpawnJobSetup => "runner_claim_spawn_job_setup",
        }
    }
}

#[derive(Default)]
struct RunnerPreSpawnPhaseDurations {
    resume_session_validation: Option<Duration>,
    device_rate_limits: Option<Duration>,
    idle_reuse_lookup: Option<Duration>,
    home_cache_state_lookup: Option<Duration>,
    home_promotion_validation: Option<Duration>,
    idle_unpark: Option<Duration>,
    active_status_publish: Option<Duration>,
    spawn_job_setup: Option<Duration>,
}

impl RunnerPreSpawnPhaseDurations {
    fn get_mut(&mut self, phase: RunnerPreSpawnPhase) -> &mut Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => &mut self.resume_session_validation,
            RunnerPreSpawnPhase::DeviceRateLimits => &mut self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => &mut self.idle_reuse_lookup,
            RunnerPreSpawnPhase::HomeCacheStateLookup => &mut self.home_cache_state_lookup,
            RunnerPreSpawnPhase::HomePromotionValidation => &mut self.home_promotion_validation,
            RunnerPreSpawnPhase::IdleUnpark => &mut self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => &mut self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => &mut self.spawn_job_setup,
        }
    }

    fn get(&self, phase: RunnerPreSpawnPhase) -> Option<Duration> {
        match phase {
            RunnerPreSpawnPhase::ResumeSessionValidation => self.resume_session_validation,
            RunnerPreSpawnPhase::DeviceRateLimits => self.device_rate_limits,
            RunnerPreSpawnPhase::IdleReuseLookup => self.idle_reuse_lookup,
            RunnerPreSpawnPhase::HomeCacheStateLookup => self.home_cache_state_lookup,
            RunnerPreSpawnPhase::HomePromotionValidation => self.home_promotion_validation,
            RunnerPreSpawnPhase::IdleUnpark => self.idle_unpark,
            RunnerPreSpawnPhase::ActiveStatusPublish => self.active_status_publish,
            RunnerPreSpawnPhase::SpawnJobSetup => self.spawn_job_setup,
        }
    }
}

pub struct RunnerPreSpawnTiming {
    claim_returned_at: Instant,
    concurrency: RunnerPreSpawnConcurrencyGuard,
    phase_durations: RunnerPreSpawnPhaseDurations,
    task_enqueued_at: Option<Instant>,
    blank_pool_selection: Option<BlankPoolSelection>,
}

pub(super) struct RunnerSpawnTiming {
    executor_started_at: Instant,
    pre_spawn_timing: Option<RunnerPreSpawnTiming>,
}

impl RunnerPreSpawnTiming {
    #[cfg(test)]
    pub(crate) fn start_after_claim() -> Self {
        Self::start_at(Instant::now(), &RunnerPreSpawnConcurrency::default())
    }

    pub fn start_at(claim_returned_at: Instant, concurrency: &RunnerPreSpawnConcurrency) -> Self {
        Self {
            claim_returned_at,
            concurrency: concurrency.enter(),
            phase_durations: RunnerPreSpawnPhaseDurations::default(),
            task_enqueued_at: None,
            blank_pool_selection: None,
        }
    }

    pub fn record_blank_pool_selection(&mut self, selection: BlankPoolSelection) {
        // A fresh admission can probe before claim and again after authoritative
        // claim metadata is available. Retain only the latest decision so one
        // run emits one terminal blank-selection operation.
        self.blank_pool_selection = Some(selection);
    }

    pub fn blank_pool_selection(&self) -> Option<BlankPoolSelection> {
        self.blank_pool_selection
    }

    pub fn record_phase(&mut self, phase: RunnerPreSpawnPhase, duration: Duration) {
        *self.phase_durations.get_mut(phase) = Some(duration);
    }

    pub fn record_phase_elapsed(&mut self, phase: RunnerPreSpawnPhase, started_at: Instant) {
        self.record_phase(phase, started_at.elapsed());
    }

    pub fn mark_task_enqueued(&mut self) {
        self.task_enqueued_at = Some(Instant::now());
    }

    pub fn record_resource_budget_occupancy(&mut self, budget: &ResourceBudget) {
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
        if let Some(blank_pool_selection) = self.blank_pool_selection {
            blank_pool_selection.record(telemetry);
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
    runner_startup_path: RunnerStartupPath,
    shell_started_at: Instant,
    agent_ready_at: Instant,
) {
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
