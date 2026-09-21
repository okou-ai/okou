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

use super::factory_lifecycle::SharedFactory;
use super::idle_lifecycle::{
    IdleDestroyTracker, SharedIdlePool, set_idle_status_snapshot, spawn_idle_destroy_job,
};
use crate::config::ProfileConfig;
use crate::executor::{BlankPoolSelection, BlankPoolSelectionReason};
use crate::idle_pool::{DestroyOutcome, IdleDestroyJob, IdlePool, ParkResult, ParkedIdleCandidate};
use crate::lifecycle::RunnerMode;
use crate::pre_spawn_admission::{BackgroundPreSpawnAdmissionLease, PreSpawnAdmission};
use crate::resource_budget::{BudgetLease, ReservationWithHeadroomStatus, ResourceBudget};
use crate::status::StatusTracker;
use crate::workspace_mount::ensure_workspace_drive_mounted;

const TARGET_PERCENT: usize = 10;
const EXACT_IDLE_CAPACITY_YIELD_AGE: Duration = Duration::from_secs(30 * 60);

struct BlankPoolPlan {
    profile_name: String,
    profile: ProfileConfig,
    factory: SharedFactory,
    target: usize,
    max_idle: usize,
    headroom_vcpu: u32,
    headroom_memory_mb: u32,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
}

#[derive(Clone)]
pub(super) struct BlankPoolDiagnostics {
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

    pub(super) fn classify_empty(
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

pub(super) struct BlankPoolReplenisher {
    plan: Option<BlankPoolPlan>,
    diagnostics: BlankPoolDiagnostics,
    task: Option<JoinHandle<BlankPrepareResult>>,
    task_cancel: Option<CancellationToken>,
    attempt_requested: bool,
}

struct BlankPrepareInput {
    profile_name: String,
    profile: ProfileConfig,
    factory: SharedFactory,
    device_rate_limits: Option<sandbox::DeviceRateLimits>,
    budget: BlankPrepareBudget,
    pre_spawn_lease: BackgroundPreSpawnAdmissionLease,
    idle_destroy_tracker: IdleDestroyTracker,
}

enum BlankPrepareBudget {
    Available(BudgetLease),
    RetiringExact(Box<IdleDestroyJob>),
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

pub(super) enum BlankPrepareResult {
    Ready {
        candidate: Box<ParkedIdleCandidate>,
        retired_exact: bool,
    },
    Failed(BlankPrepareFailure),
}

pub(super) struct BlankPrepareFailure {
    stage: &'static str,
    error: Option<String>,
}

impl BlankPoolReplenisher {
    pub(super) fn new(
        profiles: &BTreeMap<String, ProfileConfig>,
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
            plan,
            diagnostics,
            task: None,
            task_cancel: None,
            attempt_requested: true,
        }
    }

    pub(super) fn diagnostics(&self) -> BlankPoolDiagnostics {
        self.diagnostics.clone()
    }

    pub(super) fn request_attempt(&mut self) {
        self.attempt_requested = true;
    }

    pub(super) fn cancel_if_inactive(&self, mode: RunnerMode) {
        if mode != RunnerMode::Running
            && let Some(cancel) = self.task_cancel.as_ref()
        {
            self.diagnostics.unknown();
            cancel.cancel();
        }
    }

    pub(super) async fn maybe_start(
        &mut self,
        mode: RunnerMode,
        idle_pool: &SharedIdlePool,
        budget: &Arc<ResourceBudget>,
        admission: &PreSpawnAdmission,
        status: &StatusTracker,
        idle_destroy_tracker: &IdleDestroyTracker,
    ) {
        if !self.attempt_requested || self.task.is_some() || mode != RunnerMode::Running {
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
                        BlankPrepareBudget::RetiringExact(Box::new(job)),
                        Some(snapshot),
                    )
                }
            }
        };
        if let Some(snapshot) = retired_snapshot {
            set_idle_status_snapshot(status, snapshot).await;
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
            idle_destroy_tracker: idle_destroy_tracker.clone(),
        };
        info!(
            profile = %input.profile_name,
            target = plan.target,
            inventory,
            retired_exact,
            "preparing blank sandbox"
        );
        self.task_cancel = Some(task_cancel.clone());
        self.diagnostics.preparing(task_cancel.clone());
        self.task = Some(tokio::spawn(prepare_blank_sandbox(input, task_cancel)));
    }

    pub(super) fn is_preparing(&self) -> bool {
        self.task.is_some()
    }

    pub(super) async fn wait_for_preparation(&mut self) -> Option<BlankPrepareResult> {
        let task = self.task.as_mut()?;
        let result = task.await;
        self.task = None;
        self.task_cancel = None;
        Some(match result {
            Ok(result) => result,
            Err(error) => BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "task",
                error: Some(error.to_string()),
            }),
        })
    }

    pub(super) async fn finish_preparation(
        &mut self,
        result: BlankPrepareResult,
        idle_pool: &SharedIdlePool,
        status: &StatusTracker,
        idle_destroy_tracker: &IdleDestroyTracker,
    ) {
        let Some(plan) = self.plan.as_ref() else {
            if let BlankPrepareResult::Ready { candidate, .. } = result {
                destroy_candidate(*candidate, "blank_pool_disabled").await;
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
                    (result, snapshot, pool.blank_len())
                };
                if let Some(snapshot) = snapshot {
                    set_idle_status_snapshot(status, snapshot).await;
                }
                match park_result {
                    ParkResult::Parked => {
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
                    ParkResult::Replaced(evicted) => {
                        self.diagnostics.ready();
                        info!(
                            target = plan.target,
                            inventory,
                            retired_exact,
                            outcome = "replaced",
                            "blank sandbox refill completed"
                        );
                        spawn_idle_destroy_job(
                            idle_destroy_tracker,
                            evicted,
                            "blank_pool_replaced",
                        );
                    }
                    ParkResult::Rejected(rejected) => {
                        self.diagnostics.unknown();
                        info!(
                            target = plan.target,
                            inventory,
                            retired_exact,
                            outcome = "pool_rejected",
                            "blank sandbox refill suppressed"
                        );
                        let (payload, lease) = rejected.into_active_destroy_parts();
                        idle_destroy_tracker.spawn_cleanup(
                            async move {
                                payload
                                    .finalize_workspace_and_destroy("blank_pool_rejected")
                                    .await;
                                drop(lease);
                            },
                            "blank_pool_rejected",
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

    pub(super) async fn shutdown(mut self) {
        if let Some(cancel) = self.task_cancel.as_ref() {
            cancel.cancel();
        }
        if let Some(result) = self.wait_for_preparation().await
            && let BlankPrepareResult::Ready { candidate, .. } = result
        {
            destroy_candidate(*candidate, "blank_pool_shutdown").await;
        }
    }
}

fn select_plan(
    profiles: &BTreeMap<String, ProfileConfig>,
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

fn profile_capacity(profile: &ProfileConfig, budget: &ResourceBudget) -> usize {
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
        idle_destroy_tracker,
    } = input;
    let retired_exact = matches!(&budget, BlankPrepareBudget::RetiringExact(_));
    let mut pre_spawn_lease = Some(pre_spawn_lease);
    let budget_lease = match budget {
        BlankPrepareBudget::Available(lease) => lease,
        BlankPrepareBudget::RetiringExact(job) => {
            match retire_exact_before_blank(
                *job,
                &cancel,
                &mut pre_spawn_lease,
                &idle_destroy_tracker,
            )
            .await
            {
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
        workspace_drive: Some(sandbox::WorkspaceDriveConfig {
            size_mb: profile.workspace_disk_mb,
            seed_image: None,
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
        ensure_workspace_drive_mounted(sandbox.as_ref(), sandbox_id),
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
                stage: "workspace_mount",
                error: Some(error.error.to_string()),
            });
        }
        BackgroundStageResult::CancelledBeforeStart
        | BackgroundStageResult::CancelledAfterStart(_) => {
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "workspace_mount",
                error: None,
            });
        }
        BackgroundStageResult::Panicked => {
            drop(pre_spawn_lease.take());
            destroy_sandbox(&factory, sandbox).await;
            return BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "workspace_mount",
                error: Some("workspace drive mount panicked".into()),
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
    job: IdleDestroyJob,
    cancel: &CancellationToken,
    pre_spawn_lease: &mut Option<BackgroundPreSpawnAdmissionLease>,
    idle_destroy_tracker: &IdleDestroyTracker,
) -> Result<BudgetLease, BlankPrepareFailure> {
    let cleanup = job.run_retaining_lease("blank_pool_aged_exact");
    tokio::pin!(cleanup);
    let (cancelled, result) = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            drop(pre_spawn_lease.take());
            (true, cleanup.await)
        }
        result = &mut cleanup => (false, result),
    };
    if result.workspace_cache_promoted {
        idle_destroy_tracker.notify_reuse_state();
    }
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

async fn destroy_candidate(candidate: ParkedIdleCandidate, context: &'static str) {
    let (payload, lease) = candidate.into_active_destroy_parts();
    payload.finalize_workspace_and_destroy(context).await;
    drop(lease);
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;
    use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkingGate};

    fn profile(vcpu: u32, memory_mb: u32) -> ProfileConfig {
        ProfileConfig {
            rootfs_hash: "rootfs".into(),
            snapshot_hash: "snapshot".into(),
            vcpu,
            memory_mb,
            rootfs_disk_mb: 8192,
            workspace_disk_mb: 10240,
        }
    }

    fn enabled_diagnostics() -> BlankPoolDiagnostics {
        BlankPoolDiagnostics {
            plan: Some(BlankPoolDiagnosticPlan {
                profile_name: "vm0/default".into(),
                device_rate_limits: None,
            }),
            state: Arc::new(Mutex::new(BlankPoolObservedState::Ready)),
        }
    }

    async fn observed_empty_selection(
        replenisher: &BlankPoolReplenisher,
        idle_pool: &SharedIdlePool,
        budget: &ResourceBudget,
    ) -> BlankPoolSelection {
        let pool = idle_pool.lock().await;
        replenisher
            .diagnostics()
            .classify_empty("vm0/default", &None, pool.revision(), budget)
    }

    #[test]
    fn diagnostics_classify_inventory_and_plan_facts() {
        let diagnostics = enabled_diagnostics();
        let budget = ResourceBudget::new(8, 16_384, 1.0, 0);

        assert_eq!(
            diagnostics.classify_empty("vm0/large", &None, 0, &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::IncompatibleShape)
        );
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, 0, &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::EmptyInventory)
        );
        assert_eq!(
            BlankPoolDiagnostics::new(None).classify_empty("vm0/default", &None, 0, &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::DisabledPlan)
        );
    }

    #[test]
    fn diagnostics_classify_live_preparation_and_preemption() {
        let diagnostics = enabled_diagnostics();
        let budget = ResourceBudget::new(8, 16_384, 1.0, 0);
        let cancel = CancellationToken::new();
        diagnostics.preparing(cancel.clone());
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, 0, &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::RefillInProgress)
        );

        cancel.cancel();
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, 0, &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
        );
    }

    #[test]
    fn diagnostics_keep_only_fresh_bounded_suppression() {
        let diagnostics = enabled_diagnostics();
        let pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        let budget = Arc::new(ResourceBudget::new(8, 16_384, 1.0, 0));

        for reason in [
            BlankPoolSelectionReason::ResourceUnavailable,
            BlankPoolSelectionReason::HeadroomReserved,
        ] {
            diagnostics.suppressed(reason, &pool, Some(budget.allocated()));
            assert_eq!(
                diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget,),
                BlankPoolSelection::Miss(reason)
            );
        }

        diagnostics.suppressed(BlankPoolSelectionReason::MaxIdle, &pool, None);
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::MaxIdle)
        );
        drop(lease);

        diagnostics.suppressed(
            BlankPoolSelectionReason::ResourceUnavailable,
            &pool,
            Some(budget.allocated()),
        );
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
        );
        drop(lease);

        diagnostics.suppressed(
            BlankPoolSelectionReason::ResourceUnavailable,
            &pool,
            Some(budget.allocated()),
        );
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, pool.revision() + 1, &budget,),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
        );
        diagnostics.unknown();
        assert_eq!(
            diagnostics.classify_empty("vm0/default", &None, pool.revision(), &budget),
            BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
        );
    }

    #[tokio::test]
    async fn replenisher_classifies_authoritative_suppression_branches() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (factory, true));
        let temp = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(temp.path().join("status.json"), 1, None, None);
        let tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));

        let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let foreground_cancel = CancellationToken::new();
        let foreground = admission.acquire(2, &foreground_cancel).await.unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &tracker,
            )
            .await;
        assert!(!replenisher.is_preparing());
        assert_eq!(
            observed_empty_selection(&replenisher, &idle_pool, &budget).await,
            BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)
        );
        drop(foreground);

        let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
        let held = ResourceBudget::try_reserve_lease(&budget, 18, 36_864).unwrap();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &tracker,
            )
            .await;
        assert_eq!(
            observed_empty_selection(&replenisher, &idle_pool, &budget).await,
            BlankPoolSelection::Miss(BlankPoolSelectionReason::ResourceUnavailable)
        );
        drop(held);

        let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
        let held = ResourceBudget::try_reserve_lease(&budget, 17, 34_816).unwrap();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);
        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &tracker,
            )
            .await;
        assert_eq!(
            observed_empty_selection(&replenisher, &idle_pool, &budget).await,
            BlankPoolSelection::Miss(BlankPoolSelectionReason::HeadroomReserved)
        );
        drop(held);

        let budget = Arc::new(ResourceBudget::new(20, 40_960, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        assert!(matches!(
            pool.park(ParkedIdleCandidateBuilder::new("recent-exact", lease).build()),
            ParkResult::Parked
        ));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &tracker,
            )
            .await;
        assert_eq!(
            observed_empty_selection(&replenisher, &idle_pool, &budget).await,
            BlankPoolSelection::Miss(BlankPoolSelectionReason::MaxIdle)
        );
        for job in idle_pool.lock().await.drain() {
            job.run().await;
        }
        tracker.close_and_wait().await;
    }

    #[test]
    fn target_scales_with_capacity_and_operator_cap() {
        assert_eq!(blank_pool_target(0, 0), 0);
        assert_eq!(blank_pool_target(1, 0), 0);
        assert_eq!(blank_pool_target(2, 0), 0);
        assert_eq!(blank_pool_target(5, 0), 1);
        assert_eq!(blank_pool_target(62, 0), 6);
        assert_eq!(blank_pool_target(62, 4), 4);
    }

    #[tokio::test]
    async fn replenisher_creates_parks_and_publishes_one_blank_sandbox() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let factory: SharedFactory = Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (factory, true));
        let budget = Arc::new(ResourceBudget::new(16, 32_768, 1.0, 0));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 0 },
            ParkingGate::new_open(),
        )));
        let temp = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(temp.path().join("status.json"), 7, None, None);
        let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
        let admission = PreSpawnAdmission::new(4).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 0, None);

        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        assert!(replenisher.is_preparing());
        {
            let pool = idle_pool.lock().await;
            assert_eq!(
                replenisher.diagnostics().classify_empty(
                    "vm0/default",
                    &None,
                    pool.revision(),
                    &budget,
                ),
                BlankPoolSelection::Miss(BlankPoolSelectionReason::RefillInProgress)
            );
        }
        let result = replenisher
            .wait_for_preparation()
            .await
            .expect("preparation should be active");
        replenisher
            .finish_preparation(result, &idle_pool, &status, &idle_destroy_tracker)
            .await;

        let mut pool = idle_pool.lock().await;
        assert_eq!(pool.blank_len(), 1);
        assert!(pool.status_snapshot().idle_sandboxes.is_empty());
        assert_eq!(pool.status_snapshot().blank_sandboxes.len(), 1);
        assert!(pool.held_sandbox_states().is_empty());
        let destroy = pool.drain();
        drop(pool);
        for job in destroy {
            job.run().await;
        }
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert!(admission.try_acquire_background(4).unwrap().is_some());
        replenisher.shutdown().await;
        idle_destroy_tracker.close_and_wait().await;
    }

    #[tokio::test]
    async fn aged_exact_capacity_is_converted_to_blanks_one_at_a_time() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let blank_factory: SharedFactory =
            Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (blank_factory, true));
        let budget = Arc::new(ResourceBudget::new(32, 65_536, 1.0, 0));
        let mut pool = IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 2 },
            ParkingGate::new_open(),
        );
        let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let destroy_gate = sandbox_mock::MockLifecycleGate::new();
        exact_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let exact_factory: SharedFactory = Arc::new(Box::new(
            sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
        ));
        let now = Instant::now();
        for (reuse_key, idle_for) in [
            ("older-exact", Duration::from_secs(40 * 60)),
            ("newer-exact", Duration::from_secs(30 * 60)),
        ] {
            let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
            let candidate = ParkedIdleCandidateBuilder::new(reuse_key, lease)
                .with_factory(Arc::clone(&exact_factory))
                .build();
            assert!(matches!(
                pool.park_at_for_test(candidate, now - idle_for),
                ParkResult::Parked
            ));
        }
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let temp = tempfile::tempdir().unwrap();
        let status_path = temp.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 2, None, None);
        let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
        let idle_destroy_tracker = IdleDestroyTracker::new(Arc::clone(&reuse_state_notify));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 2, None);

        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        destroy_gate
            .wait_entered(1, Duration::from_secs(2))
            .await
            .expect("first exact destroy should start");
        tokio::time::timeout(Duration::from_secs(2), reuse_state_notify.notified())
            .await
            .expect("exact removal should request an immediate heartbeat");
        assert_eq!(idle_pool.lock().await.held_reuse_keys(), ["newer-exact"]);
        let status_json = tokio::fs::read_to_string(status_path).await.unwrap();
        assert!(!status_json.contains("older-exact"));
        assert!(status_json.contains("newer-exact"));

        replenisher.request_attempt();
        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        assert_eq!(idle_pool.lock().await.held_reuse_keys(), ["newer-exact"]);

        destroy_gate.release_many(1);
        let first = replenisher.wait_for_preparation().await.unwrap();
        replenisher
            .finish_preparation(first, &idle_pool, &status, &idle_destroy_tracker)
            .await;
        assert_eq!(idle_pool.lock().await.blank_len(), 1);

        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        destroy_gate
            .wait_entered(2, Duration::from_secs(2))
            .await
            .expect("second exact destroy should start only after the first conversion");
        assert_eq!(idle_pool.lock().await.blank_len(), 1);

        destroy_gate.release_many(1);
        let second = replenisher.wait_for_preparation().await.unwrap();
        replenisher
            .finish_preparation(second, &idle_pool, &status, &idle_destroy_tracker)
            .await;
        let mut pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 2);
        assert_eq!(pool.blank_len(), 2);
        let destroy = pool.drain();
        drop(pool);
        for job in destroy {
            job.run().await;
        }
        assert_eq!(budget.allocated(), (0, 0, 0));
        replenisher.shutdown().await;
        idle_destroy_tracker.close_and_wait().await;
    }

    #[tokio::test]
    async fn uncertain_aged_exact_cleanup_does_not_create_a_blank() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let blank_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let blank_factory: SharedFactory = Arc::new(Box::new(
            sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&blank_overrides)),
        ));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (blank_factory, true));
        let budget = Arc::new(ResourceBudget::new(12, 24_576, 1.0, 0));
        let mut pool = IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 1 },
            ParkingGate::new_open(),
        );
        let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        exact_overrides.push_destroy_panic("simulated aged exact destroy panic");
        let exact_factory: SharedFactory = Arc::new(Box::new(
            sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
        ));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("aged-exact", lease)
            .with_factory(exact_factory)
            .build();
        assert!(matches!(
            pool.park_at_for_test(candidate, Instant::now() - EXACT_IDLE_CAPACITY_YIELD_AGE,),
            ParkResult::Parked
        ));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let temp = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(temp.path().join("status.json"), 1, None, None);
        let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);

        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        let result = replenisher.wait_for_preparation().await.unwrap();
        assert!(matches!(
            result,
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "retire_exact",
                error: Some(_),
            })
        ));
        assert!(blank_overrides.create_configs().is_empty());
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert_eq!(idle_pool.lock().await.len(), 0);
        replenisher.shutdown().await;
        idle_destroy_tracker.close_and_wait().await;
    }

    #[tokio::test]
    async fn foreground_admission_preempts_blank_conversion_during_exact_destroy() {
        let mut profiles = BTreeMap::new();
        profiles.insert("vm0/default".to_owned(), profile(2, 4096));
        let blank_factory: SharedFactory =
            Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new()));
        let mut factories = BTreeMap::new();
        factories.insert("vm0/default".to_owned(), (blank_factory, true));
        let budget = Arc::new(ResourceBudget::new(12, 24_576, 1.0, 0));
        let mut pool = IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 1 },
            ParkingGate::new_open(),
        );
        let exact_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        let destroy_gate = sandbox_mock::MockLifecycleGate::new();
        exact_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
        let exact_factory: SharedFactory = Arc::new(Box::new(
            sandbox_mock::MockSandboxFactory::with_overrides(exact_overrides),
        ));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate = ParkedIdleCandidateBuilder::new("aged-exact", lease)
            .with_factory(exact_factory)
            .build();
        assert!(matches!(
            pool.park_at_for_test(candidate, Instant::now() - EXACT_IDLE_CAPACITY_YIELD_AGE,),
            ParkResult::Parked
        ));
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let temp = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(temp.path().join("status.json"), 1, None, None);
        let idle_destroy_tracker = IdleDestroyTracker::new(Arc::new(tokio::sync::Notify::new()));
        let admission = PreSpawnAdmission::new(2).unwrap();
        let mut replenisher = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);

        replenisher
            .maybe_start(
                RunnerMode::Running,
                &idle_pool,
                &budget,
                &admission,
                &status,
                &idle_destroy_tracker,
            )
            .await;
        destroy_gate
            .wait_entered(1, Duration::from_secs(2))
            .await
            .expect("aged exact destroy should start");

        let foreground_cancel = CancellationToken::new();
        let foreground = tokio::time::timeout(
            Duration::from_secs(2),
            admission.acquire(2, &foreground_cancel),
        )
        .await
        .expect("foreground admission should not wait for exact destroy")
        .unwrap();
        assert!(replenisher.is_preparing());
        assert_eq!(budget.allocated().2, 1);
        {
            let pool = idle_pool.lock().await;
            assert_eq!(
                replenisher.diagnostics().classify_empty(
                    "vm0/default",
                    &None,
                    pool.revision(),
                    &budget,
                ),
                BlankPoolSelection::Miss(BlankPoolSelectionReason::ForegroundPreempted)
            );
        }

        destroy_gate.release_many(1);
        let result = replenisher.wait_for_preparation().await.unwrap();
        assert!(matches!(
            result,
            BlankPrepareResult::Failed(BlankPrepareFailure {
                stage: "retire_exact",
                error: None,
            })
        ));
        drop(foreground);
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert_eq!(idle_pool.lock().await.len(), 0);
        replenisher.shutdown().await;
        idle_destroy_tracker.close_and_wait().await;
    }
}
