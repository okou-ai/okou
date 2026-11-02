//! Idle-pool lifecycle and status helpers for `runner start`.

mod activation_cleanup;
pub use activation_cleanup::GuardedActivationCleanupTask;
mod batch;
mod insertion;
mod logical;
pub(crate) mod pressure;

pub use batch::{
    IdlePoolBatchRetirementRequest, IdlePoolRetirementBatchReport, IdlePoolRetirementRefusal,
};
pub use insertion::IdlePoolInsertionResult;
pub use logical::{
    GuardedIdlePressureRequest, GuardedIdlePressureResult, GuardedLogicalCleanupTask,
    select_idle_entries_for_guarded_pressure,
};
pub use pressure::{IdlePressureWaveReport, IdlePressureWaveStop};

use std::ops::Deref;
use std::sync::Arc;
use std::{future::Future, panic::AssertUnwindSafe};

use futures_util::FutureExt;
use futures_util::stream::{FuturesUnordered, StreamExt};
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::{Notify, oneshot};
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::blank_pool::BlankPoolDiagnostics;
use runner_executor::executor::{BlankPoolSelection, BlankPoolSelectionReason};
use runner_host::idle_prune_control::{PruneIdleReport, PruneIdleResponse};
use runner_host::paths::short_digest;
use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperationError};
use runner_lifecycle::idle_pool::{
    BlankIdleReservationMiss, DestroyOutcome, ExactIdleReservationMiss, IdleDestroyJob,
    IdleDestroyPayload, IdleDestroyResult, IdlePool, IdlePoolRetirement, IdlePoolSnapshot,
    IdleRetirementCandidate, IdleRetirementEnvelope, ReservedIdleSandbox,
    RestoreReservedIdleResult, RetainedActivationCleanup, RetainedIdleDestroyResult,
};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::{StatusResult, StatusTracker};
use runner_types::ids::RunId;
use runner_types::types::reuse_key_kind;

pub type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

/// Observes accepted cleanup without exposing an abort handle. Dropping this
/// receiver cannot cancel the work registered with `IdleDestroyTracker`.
pub struct IdleCleanupTask<T> {
    completion: oneshot::Receiver<T>,
}

/// Required coverage and exact resource candidate, supplied by the caller.
pub struct IdlePoolRetirementRequest {
    pub candidate: IdleRetirementCandidate,
    pub envelope: IdleRetirementEnvelope,
    pub context: &'static str,
}

/// Inventory snapshot committed with acceptance. Status publication may happen
/// afterward without owning or cancelling the physical cleanup.
pub struct IdlePoolRetirementStarted {
    pub task: GuardedActivationCleanupTask,
    pub snapshot: IdlePoolSnapshot,
}

impl<T> IdleCleanupTask<T> {
    /// Wait for one completion. A lost producer is uncertainty, not cleanup proof.
    pub async fn join(&mut self) -> Result<T, oneshot::error::RecvError> {
        (&mut self.completion).await
    }
}

#[derive(Clone)]
pub struct IdleDestroyTracker {
    tasks: TaskTracker,
    reuse_state_notify: Arc<Notify>,
    activation_owners: Arc<std::sync::Mutex<Vec<RetainedActivationCleanup>>>,
    finalizing_owners:
        Arc<std::sync::Mutex<Vec<crate::finalizing_admission::GuardedFinalizingRecovery>>>,
    pressure_owners: Arc<std::sync::Mutex<Vec<RetainedActivationCleanup>>>,
    #[cfg(any(test, feature = "test-support"))]
    pressure_pool_waits: tokio::sync::watch::Sender<u64>,
    pub(crate) optional_blank_owners:
        Arc<std::sync::Mutex<Vec<crate::blank_pool::OptionalBlankResult>>>,
}

impl IdleDestroyTracker {
    pub(crate) fn joined(&self) -> bool {
        self.tasks.is_closed() && self.tasks.is_empty()
    }

    pub fn new(reuse_state_notify: Arc<Notify>) -> Self {
        Self {
            tasks: TaskTracker::new(),
            reuse_state_notify,
            activation_owners: Arc::new(std::sync::Mutex::new(Vec::new())),
            finalizing_owners: Arc::new(std::sync::Mutex::new(Vec::new())),
            pressure_owners: Arc::new(std::sync::Mutex::new(Vec::new())),
            #[cfg(any(test, feature = "test-support"))]
            pressure_pool_waits: tokio::sync::watch::channel(0).0,
            optional_blank_owners: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Keep inventory owned through admission waits, then fence/accept physical
    /// retirement and its shutdown observer before yielding to status/callers.
    /// Closed admission leaves the original inventory and full lease untouched.
    pub async fn retire_pool_entry(
        &self,
        pool: &SharedIdlePool,
        operations: &HostMemoryOperations,
        request: IdlePoolRetirementRequest,
    ) -> Result<IdlePoolRetirementStarted, MemoryOperationError> {
        let mut retirement =
            IdlePoolRetirement::new(request.candidate, operations, request.envelope)?;
        retirement.try_grant().await?;
        let mut pool = pool.lock().await;
        // A token registered before acceptance bridges the gap to installation
        // of the completion observer. close_and_wait cannot miss accepted work.
        let token = self.tasks.token();
        if self.tasks.is_closed() {
            drop(pool);
            return Err(MemoryOperationError::Closed);
        }
        let task = match retirement.start(&mut pool, request.context) {
            Ok(task) => task,
            Err(failure) => {
                drop(pool);
                return Err(failure.into_error());
            }
        };
        let snapshot = pool.status_snapshot();
        let task = self.adopt_activation_cleanup(task, token, request.context);
        Ok(IdlePoolRetirementStarted { task, snapshot })
    }

    pub fn spawn_job(
        &self,
        job: IdleDestroyJob,
        context: &'static str,
    ) -> IdleCleanupTask<RetainedIdleDestroyResult> {
        let (payload, lease) = job.into_retiring_parts();
        self.spawn_payload_retaining_lease(payload, lease, context)
    }

    /// Pressure reclamation requires the captured original backing's positive exit.
    pub(crate) fn spawn_confirmed_job(
        &self,
        job: IdleDestroyJob,
        context: &'static str,
    ) -> IdleCleanupTask<RetainedIdleDestroyResult> {
        self.track(
            job.run_retaining_lease_with_confirmed_exit(context),
            context,
        )
    }

    pub fn spawn_payload_retaining_lease(
        &self,
        payload: IdleDestroyPayload,
        budget_lease: BudgetLease,
        context: &'static str,
    ) -> IdleCleanupTask<RetainedIdleDestroyResult> {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        self.track(
            async move {
                let result = finish_idle_payload(payload, context).await;
                if result.home_cache_promoted {
                    reuse_state_notify.notify_one();
                }
                RetainedIdleDestroyResult {
                    outcome: result.outcome,
                    home_cache_promoted: result.home_cache_promoted,
                    budget_lease,
                }
            },
            context,
        )
    }

    fn spawn_payload(
        &self,
        payload: IdleDestroyPayload,
        context: &'static str,
    ) -> IdleCleanupTask<IdleDestroyResult> {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        self.track(
            async move {
                let result = finish_idle_payload(payload, context).await;
                if result.home_cache_promoted {
                    reuse_state_notify.notify_one();
                }
                result
            },
            context,
        )
    }

    pub fn spawn_cleanup(
        &self,
        cleanup: impl Future<Output = ()> + Send + 'static,
        context: &'static str,
    ) {
        drop(self.track(cleanup, context));
    }

    fn track<T: Send + 'static>(
        &self,
        cleanup: impl Future<Output = T> + Send + 'static,
        context: &'static str,
    ) -> IdleCleanupTask<T> {
        let (sender, completion) = oneshot::channel();
        drop(self.tasks.spawn(async move {
            match AssertUnwindSafe(cleanup).catch_unwind().await {
                Ok(result) => {
                    let _ = sender.send(result);
                }
                Err(_) => warn!(context, "tracked idle cleanup producer panicked"),
            }
        }));
        IdleCleanupTask { completion }
    }

    /// Capture and accept the current batch under the short pool lock, then
    /// run cleanup/status independently. A later resume can park new inventory.
    pub async fn start_drain(
        &self,
        idle_pool: SharedIdlePool,
        status: Arc<StatusTracker>,
        context: &'static str,
    ) -> IdleCleanupTask<()> {
        let mut tasks = {
            let mut pool = idle_pool.lock().await;
            pool.drain()
                .into_iter()
                .map(|job| self.spawn_job(job, context))
                .collect::<Vec<_>>()
        };
        self.track(
            async move {
                wait_idle_destroy_tasks(&mut tasks, context).await;
                let snapshot = idle_pool.lock().await.status_snapshot();
                set_idle_status_snapshot(&status, snapshot).await;
            },
            context,
        )
    }

    pub fn notify_reuse_state(&self) {
        self.reuse_state_notify.notify_one();
    }

    pub async fn close_and_wait(&self) {
        let _ = self.tasks.close();
        self.tasks.wait().await;
    }

    pub(crate) fn retain_finalizing_recovery(
        &self,
        recovery: crate::finalizing_admission::GuardedFinalizingRecovery,
    ) {
        if recovery.claimed.is_some() || recovery.resource.is_some() || recovery.delivery_uncertain
        {
            // Preserve actual custody on an advisory poisoned lock. Recovery
            // still reports that error; this never fabricates a valid receipt.
            let mut owners = match self.finalizing_owners.lock() {
                Ok(owners) => owners,
                Err(poisoned) => poisoned.into_inner(),
            };
            owners.push(recovery);
        }
    }

    /// Recover original claim/resource owners only after joined shutdown.
    /// Taking custody supplies neither physical credit nor completion proof.
    pub fn take_retained_finalizing_owners(
        &self,
    ) -> Result<Vec<crate::finalizing_admission::GuardedFinalizingRecovery>, MemoryOperationError>
    {
        if !self.tasks.is_closed() || !self.tasks.is_empty() {
            return Err(MemoryOperationError::OwnershipInvariant);
        }
        let mut owners = self
            .finalizing_owners
            .lock()
            .map_err(|_| MemoryOperationError::AccountingPoisoned)?;
        Ok(std::mem::take(&mut *owners))
    }
}

/// Reclaim only pool-owned exact idle entries for a generation-fenced operator request.
///
/// All detached entries are transferred to independently running tasks before
/// the first post-selection await. A caller cancellation or status-write failure
/// therefore cannot drop a selected job before its physical cleanup finishes.
pub async fn prune_exact_idle_pool(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
) -> PruneIdleResponse {
    let (mut tasks, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let tasks = pool
            .drain_exact()
            .into_iter()
            .map(|job| tracker.spawn_job(job, "operator_prune_idle"))
            .collect::<Vec<_>>();
        (tasks, pool.status_snapshot())
    };
    let mut report = PruneIdleReport {
        selected: tasks.len(),
        completed: 0,
        uncertain: 0,
    };
    let mut tasks: FuturesUnordered<_> = tasks.iter_mut().map(IdleCleanupTask::join).collect();
    tracker.notify_reuse_state();
    let status_result = status.set_idle_snapshot(snapshot).await;
    while let Some(result) = tasks.next().await {
        match result {
            Ok(result) => {
                match result.outcome {
                    DestroyOutcome::Completed => report.completed += 1,
                    DestroyOutcome::Uncertain => report.uncertain += 1,
                }
                drop(result.budget_lease);
            }
            Err(error) => {
                report.uncertain += 1;
                warn!(%error, "idle prune destruction task failed");
            }
        }
    }
    info!(
        selected = report.selected,
        completed = report.completed,
        uncertain = report.uncertain,
        "exact idle pruning finished"
    );
    status_result
        .map_err(|error| format!("idle pruning finished but status publication failed: {error}"))?;
    Ok(report)
}

/// Drain the idle pool: destroy every entry captured at drain start in parallel
/// and wait for all destroys to complete before returning (budgets released).
/// Used for a directly awaited batch during teardown. Soft drain captures its
/// independently scheduled batch with [`IdleDestroyTracker::start_drain`].
///
/// A SIGUSR2 resume can reopen parking while a soft-drain destroy is still in
/// progress, so write the current post-destroy pool snapshot rather than
/// blindly clearing `idle_sandboxes`.
///
/// `context` is logged alongside the destroyed count for operator clarity
/// (e.g. "draining" vs "shutdown").
pub async fn drain_idle_pool(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
    context: &'static str,
) {
    let mut tasks = {
        let mut pool = idle_pool.lock().await;
        pool.drain()
            .into_iter()
            .map(|job| tracker.spawn_job(job, context))
            .collect::<Vec<_>>()
    };
    if !tasks.is_empty() {
        info!(count = tasks.len(), context, "destroying idle sandboxes");
        wait_idle_destroy_tasks(&mut tasks, context).await;
    }
    let snapshot = idle_pool.lock().await.status_snapshot();
    set_idle_status_snapshot(status, snapshot).await;
}

pub struct RetiringIdleEntry {
    budget_lease: BudgetLease,
    reuse_key: Option<String>,
    profile_name: String,
}

pub struct IdlePressureRequest<'a> {
    pub run_id: RunId,
    pub reuse_key: Option<&'a str>,
    pub profile_name: &'a str,
    pub device_rate_limits: &'a Option<DeviceRateLimits>,
    pub allow_compatible_blank: bool,
    pub blank_pool_diagnostics: Option<&'a BlankPoolDiagnostics>,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub context: &'static str,
}

pub enum IdlePressureSelection {
    Reusable(ReservedIdleActivation),
    Fresh(BudgetLease),
    Exhausted(Vec<BudgetLease>),
}

pub struct IdlePressureOutcome {
    pub selection: IdlePressureSelection,
    pub blank_pool_selection: Option<BlankPoolSelection>,
    /// Eviction publication belongs to the caller; reuse carries its own snapshot.
    pub idle_snapshot: Option<IdlePoolSnapshot>,
}

/// A reuse reservation paired with the idle snapshot captured by the pool
/// mutation or direct handoff. Its reservation retains the parked/running
/// distinction so cancellation cannot restore a running sandbox to the pool.
/// Claimed activation can publish ownership without reacquiring the pool.
pub struct ReservedIdleActivation {
    reservation: Box<ReservedIdleSandbox>,
    idle_snapshot: IdlePoolSnapshot,
}

impl ReservedIdleActivation {
    pub fn new(reservation: ReservedIdleSandbox, idle_snapshot: IdlePoolSnapshot) -> Self {
        Self {
            reservation: Box::new(reservation),
            idle_snapshot,
        }
    }

    pub fn into_parts(self) -> (ReservedIdleSandbox, IdlePoolSnapshot) {
        (*self.reservation, self.idle_snapshot)
    }
}

impl Deref for ReservedIdleActivation {
    type Target = ReservedIdleSandbox;

    fn deref(&self) -> &Self::Target {
        &self.reservation
    }
}

/// Reserve an ordinary compatible idle sandbox and capture the
/// post-reservation snapshot under the same pool lock.
pub async fn reserve_reusable_idle_for_spawn(
    idle_pool: &SharedIdlePool,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<DeviceRateLimits>,
) -> Option<ReservedIdleActivation> {
    let (reservation, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let reservation = pool.reserve_reusable(reuse_key, profile_name, device_rate_limits)?;
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    Some(ReservedIdleActivation::new(reservation, snapshot))
}

/// Reserve the actual producing Run and snapshot while holding the pool lock.
pub async fn reserve_source_idle_for_spawn(
    idle_pool: &SharedIdlePool,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<DeviceRateLimits>,
    source_run_id: RunId,
) -> Result<ReservedIdleActivation, ExactIdleReservationMiss> {
    let mut pool = idle_pool.lock().await;
    let reservation =
        pool.reserve_reusable_source(reuse_key, profile_name, device_rate_limits, source_run_id)?;
    let snapshot = pool.status_snapshot();
    Ok(ReservedIdleActivation::new(reservation, snapshot))
}

/// Reserve exactly the predecessor's generation, retaining a typed miss reason
/// from the same locked observation when no matching entry can be claimed.
pub async fn reserve_exact_idle_for_spawn(
    idle_pool: &SharedIdlePool,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<DeviceRateLimits>,
    native_generation_run_id: RunId,
) -> Result<ReservedIdleActivation, ExactIdleReservationMiss> {
    let (reservation, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let reservation = pool.reserve_reusable_native_source(
            reuse_key,
            profile_name,
            device_rate_limits,
            native_generation_run_id,
        )?;
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    Ok(ReservedIdleActivation::new(reservation, snapshot))
}

/// Restore an unconsumed claim reservation, publish the post-restore snapshot,
/// and finish any rejected or replaced sandbox destruction before notifying.
pub async fn rollback_reserved_idle_for_spawn(
    reservation: ReservedIdleActivation,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    reuse_state_notify: &Notify,
    tracker: &IdleDestroyTracker,
) {
    let (reservation, _) = reservation.into_parts();
    let (destroy_task, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let restore_result = pool.restore_reserved(reservation);
        let snapshot = pool.status_snapshot();
        let destroy_task = match restore_result {
            RestoreReservedIdleResult::Restored => None,
            RestoreReservedIdleResult::Replaced(job) | RestoreReservedIdleResult::Rejected(job) => {
                Some(tracker.spawn_job(*job, "finalizing_claim_reserved_idle_rollback"))
            }
        };
        (destroy_task, snapshot)
    };
    set_idle_status_snapshot(status, snapshot).await;
    if let Some(mut task) = destroy_task {
        if let Err(error) = task.join().await {
            warn!(%error, "reserved idle rollback cleanup producer lost");
        }
        reuse_state_notify.notify_one();
    }
}

impl RetiringIdleEntry {
    pub fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }

    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    pub fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }

    pub fn into_budget_lease(self) -> BudgetLease {
        self.budget_lease
    }
}

/// Prefer a matching exact entry, then an allowed compatible blank; otherwise
/// retire only enough oldest idle entries for the incoming resource shape.
///
/// The idle pool stays locked while one deterministic oldest-first ordering is
/// consumed. Resource-budget substitution takes only its short synchronous
/// mutex inside that pool lock and never carries a guard across an await. Every
/// evicted payload obtains tracked cleanup ownership before the final pool
/// snapshot is captured. The caller owns publication so pre-claim admission
/// can register it independently without waiting for status state or IO.
pub async fn select_idle_entries_for_pressure(
    idle_pool: &SharedIdlePool,
    tracker: &IdleDestroyTracker,
    budget: &Arc<ResourceBudget>,
    mut retiring_leases: Vec<BudgetLease>,
    request: IdlePressureRequest<'_>,
) -> IdlePressureOutcome {
    let (selection, blank_pool_selection, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let (reservation, blank_pool_selection) =
            reserve_pressure_reuse(&mut pool, budget, &request);
        if let Some(reservation) = reservation {
            drop(retiring_leases);
            let snapshot = pool.status_snapshot();
            (
                IdlePressureSelection::Reusable(ReservedIdleActivation {
                    reservation: Box::new(reservation),
                    idle_snapshot: snapshot,
                }),
                blank_pool_selection,
                None,
            )
        } else {
            let mut mutated = false;
            let mut fresh_lease = try_substitute_retiring_leases(
                budget,
                &mut retiring_leases,
                request.vcpu,
                request.memory_mb,
            );
            if fresh_lease.is_none() {
                for identity in pool.oldest_first_pressure_keys() {
                    let idle_kind = identity.kind();
                    let Some(job) = pool.evict_for_pressure(&identity) else {
                        continue;
                    };
                    mutated = true;
                    let retiring = retire_idle_destroy_job(tracker, job, request.context);
                    info!(
                        run_id = %request.run_id,
                        context = request.context,
                        idle_kind = ?idle_kind,
                        reuse_key_fingerprint = retiring.reuse_key().map(short_digest),
                        reuse_key_kind = retiring.reuse_key().map(reuse_key_kind),
                        profile = %retiring.profile_name(),
                        vcpu = retiring.budget_vcpu(),
                        memory_mb = retiring.budget_memory_mb(),
                        "evicting idle sandbox for admission pressure"
                    );
                    retiring_leases.push(retiring.into_budget_lease());
                    fresh_lease = try_substitute_retiring_leases(
                        budget,
                        &mut retiring_leases,
                        request.vcpu,
                        request.memory_mb,
                    );
                    if fresh_lease.is_some() {
                        break;
                    }
                }
            }
            let selection = match fresh_lease {
                Some(lease) => IdlePressureSelection::Fresh(lease),
                None => IdlePressureSelection::Exhausted(retiring_leases),
            };
            let snapshot = mutated.then(|| pool.status_snapshot());
            (selection, blank_pool_selection, snapshot)
        }
    };
    IdlePressureOutcome {
        selection,
        blank_pool_selection,
        idle_snapshot: snapshot,
    }
}

fn reserve_pressure_reuse(
    pool: &mut IdlePool,
    budget: &Arc<ResourceBudget>,
    request: &IdlePressureRequest<'_>,
) -> (Option<ReservedIdleSandbox>, Option<BlankPoolSelection>) {
    if let Some(reservation) = pool.reserve_reusable_for_pressure(
        request.reuse_key,
        request.profile_name,
        request.device_rate_limits,
    ) {
        return (Some(reservation), None);
    }
    if !request.allow_compatible_blank {
        return (None, None);
    }
    match pool.reserve_blank(request.profile_name, request.device_rate_limits) {
        Ok(reservation) => (Some(reservation), Some(BlankPoolSelection::Hit)),
        Err(BlankIdleReservationMiss::Empty) => (
            None,
            Some(request.blank_pool_diagnostics.map_or(
                BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown),
                |diagnostics| {
                    diagnostics.classify_empty(
                        request.profile_name,
                        request.device_rate_limits,
                        pool.revision(),
                        budget,
                    )
                },
            )),
        ),
        Err(BlankIdleReservationMiss::Incompatible) => (
            None,
            Some(BlankPoolSelection::Miss(
                BlankPoolSelectionReason::IncompatibleShape,
            )),
        ),
        Err(BlankIdleReservationMiss::Unknown) => (
            None,
            Some(BlankPoolSelection::Miss(BlankPoolSelectionReason::Unknown)),
        ),
    }
}

fn try_substitute_retiring_leases(
    budget: &Arc<ResourceBudget>,
    retiring_leases: &mut Vec<BudgetLease>,
    vcpu: u32,
    memory_mb: u32,
) -> Option<BudgetLease> {
    match ResourceBudget::try_substitute_leases(
        budget,
        std::mem::take(retiring_leases),
        vcpu,
        memory_mb,
    ) {
        Ok(lease) => Some(lease),
        Err(retained) => {
            *retiring_leases = retained;
            None
        }
    }
}

pub async fn set_idle_status_snapshot(status: &StatusTracker, snapshot: IdlePoolSnapshot) {
    let revision = snapshot.revision;
    let result = status.set_idle_snapshot(snapshot).await;
    match result {
        Ok(false) => {
            info!(revision, "ignored stale idle pool status snapshot");
        }
        Ok(true) => {}
        Err(error) => {
            warn!(
                revision,
                %error,
                "failed to persist idle pool status snapshot"
            );
        }
    }
}

pub async fn add_running_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) -> StatusResult<()> {
    let revision = snapshot.revision;
    let applied = status
        .add_running_run_with_idle_snapshot(run_id, sandbox_id, snapshot)
        .await?;
    if !applied {
        info!(
            revision,
            "ignored stale idle pool status snapshot while adding active run"
        );
    }
    Ok(())
}

pub async fn add_preparing_run_with_idle_status_snapshot(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    snapshot: IdlePoolSnapshot,
) -> StatusResult<()> {
    let revision = snapshot.revision;
    let applied = status
        .add_preparing_run_with_idle_snapshot(run_id, sandbox_id, snapshot)
        .await?;
    if !applied {
        info!(
            revision,
            "ignored stale idle pool status snapshot while adding preparing run"
        );
    }
    Ok(())
}

pub fn spawn_idle_destroy_job(
    tracker: &IdleDestroyTracker,
    job: IdleDestroyJob,
    context: &'static str,
) {
    drop(tracker.spawn_job(job, context));
}

fn retire_idle_destroy_job(
    tracker: &IdleDestroyTracker,
    job: IdleDestroyJob,
    context: &'static str,
) -> RetiringIdleEntry {
    let reuse_key = job.reuse_key().map(str::to_owned);
    let profile_name = job.profile_name().to_owned();
    let (payload, budget_lease) = job.into_retiring_parts();
    drop(tracker.spawn_payload(payload, context));
    tracker.reuse_state_notify.notify_one();
    RetiringIdleEntry {
        budget_lease,
        reuse_key,
        profile_name,
    }
}

/// Destroy idle entries in parallel and wait until their leases are dropped.
#[cfg(test)]
pub async fn destroy_idle_jobs_and_wait(
    tracker: &IdleDestroyTracker,
    jobs: Vec<IdleDestroyJob>,
    context: &'static str,
) -> bool {
    let mut tasks = jobs
        .into_iter()
        .map(|job| tracker.spawn_job(job, context))
        .collect::<Vec<_>>();
    wait_idle_destroy_tasks(&mut tasks, context).await
}

async fn wait_idle_destroy_tasks(
    tasks: &mut [IdleCleanupTask<RetainedIdleDestroyResult>],
    context: &'static str,
) -> bool {
    let mut pending: FuturesUnordered<_> = tasks.iter_mut().map(IdleCleanupTask::join).collect();
    let mut home_cache_promoted = false;
    while let Some(result) = pending.next().await {
        match result {
            Ok(result) => home_cache_promoted |= result.home_cache_promoted,
            Err(error) => warn!(context, %error, "idle entry destroy producer lost"),
        }
    }
    home_cache_promoted
}

pub async fn destroy_idle_payload_and_wait(
    tracker: &IdleDestroyTracker,
    payload: IdleDestroyPayload,
    budget_lease: BudgetLease,
    context: &'static str,
) -> Result<RetainedIdleDestroyResult, oneshot::error::RecvError> {
    let mut task = tracker.spawn_payload_retaining_lease(payload, budget_lease, context);
    task.join().await
}

async fn finish_idle_payload(
    payload: IdleDestroyPayload,
    context: &'static str,
) -> IdleDestroyResult {
    match AssertUnwindSafe(payload.finalize_home_and_destroy(context))
        .catch_unwind()
        .await
    {
        Ok(outcome) => outcome,
        Err(_) => {
            warn!(context, "idle payload destroy task panicked");
            IdleDestroyResult {
                outcome: DestroyOutcome::Uncertain,
                home_cache_promoted: false,
            }
        }
    }
}

#[cfg(test)]
mod tests;
