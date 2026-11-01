//! Best-effort, capacity-scaled preparation of tenant-free parked sandboxes.

use std::collections::BTreeMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::{Sandbox, SandboxConfig, SandboxId, SandboxParkOutcome};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::SharedFactory;
use crate::idle_lifecycle::{
    IdleCleanupTask, IdleDestroyTracker, SharedIdlePool, set_idle_status_snapshot,
    spawn_idle_destroy_job,
};
use runner_executor::executor::{BlankPoolSelection, BlankPoolSelectionReason};
use runner_executor::pre_spawn_admission::{BackgroundPreSpawnAdmissionLease, PreSpawnAdmission};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::idle_pool::{
    DestroyOutcome, IdlePool, ParkResult, ParkedIdleCandidate, RetainedIdleDestroyResult,
};
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::resource_budget::{
    BudgetLease, ReservationWithHeadroomStatus, ResourceBudget,
};
use runner_lifecycle::status::StatusTracker;

mod guarded;
pub use guarded::GuardedBlankPoolRequest;
mod optional;
pub use optional::{OptionalBlankPoolRequest, OptionalBlankResult, OptionalBlankSnapshot};

const TARGET_PERCENT: usize = 10;
const EXACT_IDLE_CAPACITY_YIELD_AGE: Duration = Duration::from_secs(30 * 60);

/// Resource shape needed by idle replenishment after Runner loads configuration.
#[derive(Clone)]
pub struct BlankProfile {
    pub vcpu: u32,
    pub memory_mb: u32,
    pub rootfs_hash: String,
    pub home_disk_mb: u32,
}

#[derive(Clone)]
struct BlankPoolPlan {
    profile_name: String,
    profile: BlankProfile,
    factory: SharedFactory,
    target: usize,
    max_idle: usize,
    headroom_vcpu: u32,
    headroom_memory_mb: u32,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

#[derive(Clone)]
pub struct BlankPoolDiagnostics {
    plan: Option<BlankPoolDiagnosticPlan>,
    state: Arc<Mutex<BlankPoolObservedState>>,
}

#[derive(Clone)]
struct BlankPoolDiagnosticPlan {
    profile_name: String,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

enum BlankPoolObservedState {
    Ready,
    Preparing(CancellationToken),
    Suppressed {
        reason: BlankPoolSelectionReason,
        pool_revision: u64,
        budget_allocated: Option<(u32, u32, usize)>,
    },
    Unknown,
}

impl BlankPoolDiagnostics {
    fn new(plan: Option<&BlankPoolPlan>) -> Self {
        Self {
            plan: plan.map(|plan| BlankPoolDiagnosticPlan {
                profile_name: plan.profile_name.clone(),
                device_rate_limits: plan.device_rate_limits.clone(),
            }),
            state: Arc::new(Mutex::new(BlankPoolObservedState::Ready)),
        }
    }

    pub fn classify_empty(
        &self,
        profile_name: &str,
        device_rate_limits: &Option<sandbox::DeviceRateLimits>,
        pool_revision: u64,
        budget: &ResourceBudget,
    ) -> BlankPoolSelection {
        let Some(plan) = self.plan.as_ref() else {
            return BlankPoolSelection::Miss(BlankPoolSelectionReason::DisabledPlan);
        };
        if plan.profile_name != profile_name
            || plan.device_rate_limits.as_ref() != device_rate_limits.as_ref()
        {
            return BlankPoolSelection::Miss(BlankPoolSelectionReason::IncompatibleShape);
        }

        let (reason, observed_revision, observed_budget) = match &*self.lock_state() {
            BlankPoolObservedState::Ready => {
                return BlankPoolSelection::Miss(BlankPoolSelectionReason::EmptyInventory);
            }
            BlankPoolObservedState::Preparing(cancel) if cancel.is_cancelled() => {
                return BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted);
            }
            BlankPoolObservedState::Preparing(_) => {
                return BlankPoolSelection::Miss(BlankPoolSelectionReason::RefillInProgress);
            }
            BlankPoolObservedState::Suppressed {
                reason,
                pool_revision: observed_revision,
                budget_allocated: observed_budget,
            } => (*reason, *observed_revision, *observed_budget),
            BlankPoolObservedState::Unknown => {
                return BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown);
            }
        };
        if observed_revision != pool_revision
            || observed_budget.is_some_and(|observed| observed != budget.allocated())
        {
            BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
        } else {
            BlankPoolSelection::Miss(reason)
        }
    }

    fn ready(&self) {
        *self.lock_state() = BlankPoolObservedState::Ready;
    }

    fn preparing(&self, cancel: CancellationToken) {
        *self.lock_state() = BlankPoolObservedState::Preparing(cancel);
    }

    fn suppressed(
        &self,
        reason: BlankPoolSelectionReason,
        pool: &IdlePool,
        budget_allocated: Option<(u32, u32, usize)>,
    ) {
        let pool_revision = pool.revision();
        *self.lock_state() = BlankPoolObservedState::Suppressed {
            reason,
            pool_revision,
            budget_allocated,
        };
    }

    fn unknown(&self) {
        *self.lock_state() = BlankPoolObservedState::Unknown;
    }

    fn preparing_was_cancelled(&self) -> bool {
        matches!(
            &*self.lock_state(),
            BlankPoolObservedState::Preparing(cancel) if cancel.is_cancelled()
        )
    }

    fn lock_state(&self) -> MutexGuard<'_, BlankPoolObservedState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

pub struct BlankPoolReplenisher {
    #[cfg(feature = "test-support")]
    optional_pool_wait: Option<tokio::sync::watch::Sender<bool>>,
    plan: Option<BlankPoolPlan>,
    diagnostics: BlankPoolDiagnostics,
    preparation: Option<BlankPreparation>,
    attempt_requested: bool,
    optional: Option<OptionalBlankResult>,
    budget: std::sync::Weak<ResourceBudget>,
}

struct BlankPrepareInput {
    profile_name: String,
    profile: BlankProfile,
    factory: SharedFactory,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    budget: BlankPrepareBudget,
    pre_spawn_lease: BackgroundPreSpawnAdmissionLease,
}

enum BlankPrepareBudget {
    Available(BudgetLease),
    RetiringExact(IdleCleanupTask<RetainedIdleDestroyResult>),
}

enum BlankParkOutcome {
    Parked,
    Replaced,
    Rejected,
}

#[derive(Clone, Copy)]
enum BlankRefillSuppression {
    ResourceUnavailable,
    HeadroomReserved,
    MaxIdle,
}

impl BlankRefillSuppression {
    const fn selection_reason(self) -> BlankPoolSelectionReason {
        match self {
            Self::ResourceUnavailable => BlankPoolSelectionReason::ResourceUnavailable,
            Self::HeadroomReserved => BlankPoolSelectionReason::HeadroomReserved,
            Self::MaxIdle => BlankPoolSelectionReason::MaxIdle,
        }
    }
}

enum BackgroundStageResult<T, E> {
    Completed(Result<T, E>),
    CancelledBeforeStart,
    CancelledAfterStart(Result<T, E>),
    Panicked,
}

pub enum BlankPrepareResult {
    Ready {
        candidate: Box<ParkedIdleCandidate>,
        retired_exact: bool,
    },
    Failed(BlankPrepareFailure),
}

pub struct BlankPrepareFailure {
    stage: &'static str,
    error: Option<String>,
}

struct BlankPreparation {
    task: JoinHandle<BlankPrepareResult>,
    cancel: CancellationToken,
}

impl BlankPreparation {
    fn start(input: BlankPrepareInput, cancel: CancellationToken) -> Self {
        let task = tokio::spawn(prepare_blank_sandbox(input, cancel.clone()));
        Self { task, cancel }
    }

    fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Borrow the handle so losing a reactor select retains accepted work.
    async fn observe(&mut self) -> BlankPrepareResult {
        match (&mut self.task).await {
            Ok(result) => result,
            Err(error) => BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "task",
                error: Some(error.to_string()),
            }),
        }
    }

    async fn shutdown(mut self, idle_destroy_tracker: &IdleDestroyTracker) {
        self.cancel();
        if let BlankPrepareResult::Ready { candidate, .. } = self.observe().await {
            destroy_candidate(*candidate, idle_destroy_tracker, "blank_pool_shutdown").await;
        }
    }
}

impl BlankPoolReplenisher {
    pub fn new(
        profiles: &BTreeMap<String, BlankProfile>,
        factories: &BTreeMap<String, (SharedFactory, bool)>,
        budget: &Arc<ResourceBudget>,
        max_idle: usize,
        device_rate_limits: Option<sandbox::DeviceRateLimits>,
    ) -> Self {
        let plan = select_plan(profiles, factories, budget, max_idle, device_rate_limits);
        if let Some(plan) = plan.as_ref() {
            info!(
                profile = %plan.profile_name,
                target = plan.target,
                "blank sandbox pool initialized"
            );
        } else {
            info!(
                target = 0,
                "blank sandbox pool disabled by effective capacity"
            );
        }
        let diagnostics = BlankPoolDiagnostics::new(plan.as_ref());
        Self {
            #[cfg(feature = "test-support")]
            optional_pool_wait: None,
            plan,
            diagnostics,
            preparation: None,
            attempt_requested: true,
            optional: None,
            budget: Arc::downgrade(budget),
        }
    }

    pub fn diagnostics(&self) -> BlankPoolDiagnostics {
        self.diagnostics.clone()
    }

    pub fn request_attempt(&mut self) {
        self.attempt_requested = true;
    }

    pub fn cancel_if_inactive(&self, mode: RunnerMode) {
        if mode == RunnerMode::Running {
            return;
        }
        self.cancel_preparation();
    }

    /// Suppress accepted optional preparation through its existing cleanup owner.
    pub(crate) fn cancel_preparation(&self) {
        if let Some(preparation) = self.preparation.as_ref() {
            self.diagnostics.unknown();
            preparation.cancel();
        } else if let Some(optional) = self.optional.as_ref() {
            self.diagnostics.unknown();
            optional.cancel();
        }
    }

    pub async fn maybe_start(
        &mut self,
        mode: RunnerMode,
        idle_pool: &SharedIdlePool,
        budget: &Arc<ResourceBudget>,
        admission: &PreSpawnAdmission,
        status: &Arc<StatusTracker>,
        idle_destroy_tracker: &IdleDestroyTracker,
    ) {
        if !self.attempt_requested
            || self.preparation.is_some()
            || self.optional.is_some()
            || mode != RunnerMode::Running
        {
            return;
        }
        self.attempt_requested = false;
        let Some(plan) = self.plan.as_ref() else {
            return;
        };
        let (inventory, pre_spawn_lease, prepare_budget, retired_snapshot) = {
            let mut pool = idle_pool.lock().await;
            let inventory = pool.blank_len();
            let total_idle = pool.len();
            if inventory >= plan.target {
                self.diagnostics.ready();
                return;
            }

            let pre_spawn_lease = match admission.try_acquire_background(plan.profile.vcpu) {
                Ok(Some(lease)) => lease,
                Ok(None) => {
                    // Admission unavailability can reflect a real waiter or a
                    // permit holder that releases before a later selection.
                    // Only a live cancelled preparation token proves foreground
                    // preemption at selection time.
                    self.diagnostics.unknown();
                    info!(
                        target = plan.target,
                        inventory,
                        outcome = "pre_spawn_unavailable",
                        "blank sandbox refill suppressed"
                    );
                    return;
                }
                Err(error) => {
                    self.diagnostics.unknown();
                    warn!(
                        target = plan.target,
                        inventory,
                        outcome = "pre_spawn_error",
                        error = %error,
                        "blank sandbox refill suppressed"
                    );
                    return;
                }
            };

            let ordinary_budget = if plan.max_idle > 0 && total_idle >= plan.max_idle {
                Err(BlankRefillSuppression::MaxIdle)
            } else {
                match ResourceBudget::try_reserve_lease(
                    budget,
                    plan.profile.vcpu,
                    plan.profile.memory_mb,
                ) {
                    Some(lease)
                        if budget.can_afford(plan.headroom_vcpu, plan.headroom_memory_mb) =>
                    {
                        Ok(lease)
                    }
                    Some(lease) => {
                        drop(lease);
                        Err(BlankRefillSuppression::HeadroomReserved)
                    }
                    None => Err(BlankRefillSuppression::ResourceUnavailable),
                }
            };

            match ordinary_budget {
                Ok(lease) => (
                    inventory,
                    pre_spawn_lease,
                    BlankPrepareBudget::Available(lease),
                    None,
                ),
                Err(suppression) => {
                    let reason = suppression.selection_reason();
                    let Some((job, idle_age)) = pool.evict_oldest_exact_for_blank(
                        Instant::now(),
                        EXACT_IDLE_CAPACITY_YIELD_AGE,
                        &plan.profile_name,
                        &plan.device_rate_limits,
                        plan.profile.vcpu,
                        plan.profile.memory_mb,
                    ) else {
                        match suppression {
                            BlankRefillSuppression::MaxIdle => {
                                self.diagnostics.suppressed(reason, &pool, None);
                            }
                            BlankRefillSuppression::ResourceUnavailable
                            | BlankRefillSuppression::HeadroomReserved => {
                                let (status, allocated) = budget.observe_reservation_with_headroom(
                                    plan.profile.vcpu,
                                    plan.profile.memory_mb,
                                    plan.headroom_vcpu,
                                    plan.headroom_memory_mb,
                                );
                                let observed_reason = match status {
                                    ReservationWithHeadroomStatus::ResourceUnavailable => {
                                        Some(BlankPoolSelectionReason::ResourceUnavailable)
                                    }
                                    ReservationWithHeadroomStatus::HeadroomReserved => {
                                        Some(BlankPoolSelectionReason::HeadroomReserved)
                                    }
                                    ReservationWithHeadroomStatus::Available => None,
                                };
                                if observed_reason == Some(reason) {
                                    self.diagnostics.suppressed(reason, &pool, Some(allocated));
                                } else {
                                    self.diagnostics.unknown();
                                }
                            }
                        }
                        info!(
                            target = plan.target,
                            inventory,
                            total_idle,
                            outcome = reason.as_str(),
                            aged_exact_eligible = false,
                            "blank sandbox refill suppressed"
                        );
                        return;
                    };
                    let snapshot = pool.status_snapshot();
                    idle_destroy_tracker.notify_reuse_state();
                    info!(
                        target = plan.target,
                        inventory,
                        total_idle,
                        blocked_by = reason.as_str(),
                        idle_age_seconds = idle_age.as_secs(),
                        "retiring aged exact sandbox for blank capacity"
                    );
                    (
                        inventory,
                        pre_spawn_lease,
                        BlankPrepareBudget::RetiringExact(
                            idle_destroy_tracker.spawn_job(job, "blank_pool_aged_exact"),
                        ),
                        Some(snapshot),
                    )
                }
            }
        };
        if let Some(snapshot) = retired_snapshot {
            let status = Arc::clone(status);
            idle_destroy_tracker.spawn_cleanup(
                async move { set_idle_status_snapshot(&status, snapshot).await },
                "blank_pool_aged_exact_status",
            );
        }

        let task_cancel = pre_spawn_lease.cancellation_token();
        let retired_exact = matches!(&prepare_budget, BlankPrepareBudget::RetiringExact(_));
        let input = BlankPrepareInput {
            profile_name: plan.profile_name.clone(),
            profile: plan.profile.clone(),
            factory: Arc::clone(&plan.factory),
            device_rate_limits: plan.device_rate_limits.clone(),
            budget: prepare_budget,
            pre_spawn_lease,
        };
        info!(
            profile = %input.profile_name,
            target = plan.target,
            inventory,
            retired_exact,
            "preparing blank sandbox"
        );
        self.diagnostics.preparing(task_cancel.clone());
        self.preparation = Some(BlankPreparation::start(input, task_cancel));
    }

    pub fn is_preparing(&self) -> bool {
        self.preparation.is_some()
            || self
                .optional
                .as_ref()
                .is_some_and(|result| !result.snapshot().finished)
    }

    pub async fn wait_for_preparation(&mut self) -> Option<BlankPrepareResult> {
        let preparation = self.preparation.as_mut()?;
        let result = preparation.observe().await;
        self.preparation = None;
        // Diagnostics retains its token until finish_preparation classifies
        // the selected result, including completed foreground cancellation.
        Some(result)
    }

    pub async fn finish_preparation(
        &mut self,
        result: BlankPrepareResult,
        idle_pool: &SharedIdlePool,
        status: &Arc<StatusTracker>,
        idle_destroy_tracker: &IdleDestroyTracker,
    ) {
        let Some(plan) = self.plan.as_ref() else {
            if let BlankPrepareResult::Ready { candidate, .. } = result {
                destroy_candidate(*candidate, idle_destroy_tracker, "blank_pool_disabled").await;
            }
            return;
        };
        match result {
            BlankPrepareResult::Ready {
                candidate,
                retired_exact,
            } => {
                let (park_result, snapshot, inventory) = {
                    let mut pool = idle_pool.lock().await;
                    let result = pool.park(*candidate);
                    let snapshot = matches!(result, ParkResult::Parked | ParkResult::Replaced(_))
                        .then(|| pool.status_snapshot());
                    let result = match result {
                        ParkResult::Parked => BlankParkOutcome::Parked,
                        ParkResult::Replaced(job) => {
                            spawn_idle_destroy_job(
                                idle_destroy_tracker,
                                job,
                                "blank_pool_replaced",
                            );
                            BlankParkOutcome::Replaced
                        }
                        ParkResult::Rejected(rejected) => {
                            let (payload, lease) = rejected.into_active_destroy_parts();
                            drop(idle_destroy_tracker.spawn_payload_retaining_lease(
                                payload,
                                lease,
                                "blank_pool_rejected",
                            ));
                            BlankParkOutcome::Rejected
                        }
                    };
                    (result, snapshot, pool.blank_len())
                };
                if let Some(snapshot) = snapshot {
                    let status = Arc::clone(status);
                    idle_destroy_tracker.spawn_cleanup(
                        async move { set_idle_status_snapshot(&status, snapshot).await },
                        "blank_pool_prepared_status",
                    );
                }
                match park_result {
                    BlankParkOutcome::Parked => {
                        self.diagnostics.ready();
                        info!(
                            target = plan.target,
                            inventory,
                            retired_exact,
                            outcome = "parked",
                            "blank sandbox refill completed"
                        );
                        if inventory < plan.target {
                            self.attempt_requested = true;
                        }
                    }
                    BlankParkOutcome::Replaced => {
                        self.diagnostics.ready();
                        info!(
                            target = plan.target,
                            inventory,
                            retired_exact,
                            outcome = "replaced",
                            "blank sandbox refill completed"
                        );
                    }
                    BlankParkOutcome::Rejected => {
                        self.diagnostics.unknown();
                        info!(
                            target = plan.target,
                            inventory,
                            retired_exact,
                            outcome = "pool_rejected",
                            "blank sandbox refill suppressed"
                        );
                    }
                }
            }
            BlankPrepareResult::Failed(failure) => {
                if let Some(error) = failure.error {
                    self.diagnostics.unknown();
                    warn!(
                        target = plan.target,
                        stage = failure.stage,
                        outcome = "failed",
                        error = %error,
                        "blank sandbox refill failed"
                    );
                } else {
                    if !self.diagnostics.preparing_was_cancelled() {
                        self.diagnostics.unknown();
                    }
                    info!(
                        target = plan.target,
                        stage = failure.stage,
                        outcome = "cancelled",
                        "blank sandbox refill cancelled"
                    );
                }
            }
        }
    }

    pub async fn shutdown(mut self, idle_destroy_tracker: &IdleDestroyTracker) {
        if self.optional.is_some() {
            if let Err(error) = self.shutdown_optional(idle_destroy_tracker).await {
                warn!(%error, "optional blank shutdown retains unresolved resource custody");
            }
            return;
        }
        if let Some(preparation) = self.preparation.take() {
            preparation.shutdown(idle_destroy_tracker).await;
        }
    }
}

fn select_plan(
    profiles: &BTreeMap<String, BlankProfile>,
    factories: &BTreeMap<String, (SharedFactory, bool)>,
    budget: &ResourceBudget,
    max_idle: usize,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
) -> Option<BlankPoolPlan> {
    let headroom_vcpu = profiles.values().map(|profile| profile.vcpu).max()?;
    let headroom_memory_mb = profiles.values().map(|profile| profile.memory_mb).max()?;
    let (profile_name, profile, capacity) = profiles
        .iter()
        .filter_map(|(name, profile)| {
            let capacity = profile_capacity(profile, budget);
            factories
                .contains_key(name)
                .then_some((name, profile, capacity))
        })
        .max_by(|left, right| left.2.cmp(&right.2).then_with(|| right.0.cmp(left.0)))?;
    let target = blank_pool_target(capacity, max_idle);
    if target == 0 {
        return None;
    }
    let (factory, _) = factories.get(profile_name)?;
    Some(BlankPoolPlan {
        profile_name: profile_name.clone(),
        profile: profile.clone(),
        factory: Arc::clone(factory),
        target,
        max_idle,
        headroom_vcpu,
        headroom_memory_mb,
        device_rate_limits,
    })
}

fn profile_capacity(profile: &BlankProfile, budget: &ResourceBudget) -> usize {
    let resource_capacity = std::cmp::min(
        budget.effective_vcpu() as usize / profile.vcpu as usize,
        budget.effective_memory_mb() as usize / profile.memory_mb as usize,
    );
    if budget.max_concurrent() == 0 {
        resource_capacity
    } else {
        resource_capacity.min(budget.max_concurrent())
    }
}

fn blank_pool_target(capacity: usize, max_idle: usize) -> usize {
    if capacity < 2 {
        return 0;
    }
    let target = ((capacity + TARGET_PERCENT / 2) / TARGET_PERCENT).min(capacity - 1);
    if max_idle == 0 {
        target
    } else {
        target.min(max_idle)
    }
}

async fn prepare_blank_sandbox(
    input: BlankPrepareInput,
    cancel: CancellationToken,
) -> BlankPrepareResult {
    let BlankPrepareInput {
        profile_name,
        profile,
        factory,
        device_rate_limits,
        budget,
        pre_spawn_lease,
    } = input;
    let retired_exact = matches!(&budget, BlankPrepareBudget::RetiringExact(_));
    let mut pre_spawn_lease = Some(pre_spawn_lease);
    let budget_lease = match budget {
        BlankPrepareBudget::Available(lease) => lease,
        BlankPrepareBudget::RetiringExact(cleanup) => {
            match retire_exact_before_blank(cleanup, &cancel, &mut pre_spawn_lease).await {
                Ok(lease) => lease,
                Err(failure) => return BlankPrepareResult::Failed(failure),
            }
        }
    };
    let sandbox_id = SandboxId::new_v4();
    let config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: profile.vcpu,
            memory_mb: profile.memory_mb,
        },
        device_rate_limits: device_rate_limits.clone(),
        home_drive: Some(sandbox::HomeDriveConfig {
            size_mb: profile.home_disk_mb,
            seed_image: None,
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
        }),
    };
    let mut sandbox = match create_or_cancel(&factory, config, &cancel, &mut pre_spawn_lease).await
    {
        Some(Ok(sandbox)) => sandbox,
        Some(Err(error)) => {
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "create",
                error: Some(error.to_string()),
            });
        }
        None => {
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "create",
                error: None,
            });
        }
    };

    match run_background_stage(sandbox.start(), &cancel, &mut pre_spawn_lease).await {
        BackgroundStageResult::Completed(Ok(())) => {}
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: Some(error.to_string()),
            });
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: None,
            });
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "start",
                error: Some("sandbox start panicked".into()),
            });
        }
    }

    match run_background_stage(
        ensure_home_drive_mounted(sandbox.as_ref(), sandbox_id),
        &cancel,
        &mut pre_spawn_lease,
    )
    .await
    {
        BackgroundStageResult::Completed(Ok(_)) => {}
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "home_mount",
                error: Some(error.error.to_string()),
            });
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "home_mount",
                error: None,
            });
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "home_mount",
                error: Some("home drive mount panicked".into()),
            });
        }
    }

    match run_background_stage(sandbox.park_for_blank_pool(), &cancel, &mut pre_spawn_lease).await {
        BackgroundStageResult::Completed(Ok(SandboxParkOutcome::Reusable)) => {
            drop(pre_spawn_lease.take());
            BlankPrepareResult::Ready {
                candidate: Box::new(ParkedIdleCandidate::blank(
                    sandbox,
                    factory,
                    budget_lease,
                    sandbox_id,
                    profile_name,
                    profile.rootfs_hash,
                    device_rate_limits,
                )),
                retired_exact,
            }
        }
        BackgroundStageResult::Completed(Ok(SandboxParkOutcome::NonReusable(reason))) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park_non_reusable",
                error: Some(reason.as_str().to_owned()),
            })
        }
        BackgroundStageResult::Completed(Err(error)) => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: Some(error.to_string()),
            })
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: None,
            })
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "park",
                error: Some("sandbox park panicked".into()),
            })
        }
    }
}

async fn retire_exact_before_blank(
    mut cleanup: IdleCleanupTask<RetainedIdleDestroyResult>,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> Result<BudgetLease, BlankPrepareFailure> {
    let (cancelled, result) = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            (true, cleanup.join().await)
        }
        result = cleanup.join() => (false, result),
    };
    let result = result.map_err(|error| BlankPrepareFailure {
        stage: "retire_exact",
        error: Some(format!("aged exact cleanup producer lost: {error}")),
    })?;
    if cancelled || cancel.is_cancelled() {
        drop(result.budget_lease);
        return Err(BlankPrepareFailure {
            stage: "retire_exact",
            error: None,
        });
    }
    match result.outcome {
        DestroyOutcome::Completed => Ok(result.budget_lease),
        DestroyOutcome::Uncertain => {
            drop(result.budget_lease);
            Err(BlankPrepareFailure {
                stage: "retire_exact",
                error: Some("aged exact sandbox cleanup was uncertain".into()),
            })
        }
    }
}

async fn create_or_cancel(
    factory: &SharedFactory,
    config: SandboxConfig,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> Option<sandbox::Result<Box<dyn Sandbox>>> {
    if cancel.is_cancelled() {
        drop(pre_spawn_lease.take());
        return None;
    }
    // Firecracker factory creation owns a cancellation-safe transaction. Do
    // not drain a cancelled create: it may be waiting on the same COW or netns
    // resources needed by the foreground request that triggered cancellation.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            None
        }
        result = factory.create(config) => Some(result),
    }
}

async fn run_background_stage<T, E>(
    stage: impl Future<Output = Result<T, E>>,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
) -> BackgroundStageResult<T, E> {
    if cancel.is_cancelled() {
        drop(pre_spawn_lease.take());
        return BackgroundStageResult::CancelledBeforeStart;
    }
    let stage = AssertUnwindSafe(stage).catch_unwind();
    tokio::pin!(stage);
    tokio::select! {
        biased;
        result = &mut stage => {
            match result {
                Ok(result) if cancel.is_cancelled() => {
                    drop(pre_spawn_lease.take());
                    BackgroundStageResult::CancelledAfterStart(result)
                }
                Ok(result) => BackgroundStageResult::Completed(result),
                Err(_) => BackgroundStageResult::Panicked,
            }
        }
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            match stage.await {
                Ok(result) => BackgroundStageResult::CancelledAfterStart(result),
                Err(_) => BackgroundStageResult::Panicked,
            }
        }
    }
}

async fn destroy_sandbox(factory: &SharedFactory, mut sandbox: Box<dyn Sandbox>) {
    match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(error = %error, "failed to stop blank sandbox"),
        Err(_) => warn!("blank sandbox stop panicked"),
    }
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("blank sandbox destroy panicked");
    }
}

async fn destroy_candidate(
    candidate: ParkedIdleCandidate,
    tracker: &IdleDestroyTracker,
    context: &'static str,
) {
    let (payload, lease) = candidate.into_active_destroy_parts();
    if let Err(error) =
        crate::idle_lifecycle::destroy_idle_payload_and_wait(tracker, payload, lease, context).await
    {
        warn!(context, %error, "blank candidate cleanup producer lost");
    }
}

#[cfg(test)]
mod tests;
