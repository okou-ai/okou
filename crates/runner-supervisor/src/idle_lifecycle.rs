//! Idle-pool lifecycle and status helpers for `runner start`.

use std::ops::Deref;
use std::sync::Arc;
use std::{future::Future, panic::AssertUnwindSafe};

use futures_util::FutureExt;
use futures_util::stream::{FuturesUnordered, StreamExt};
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::blank_pool::BlankPoolDiagnostics;
use runner_executor::executor::{BlankPoolSelection, BlankPoolSelectionReason};
use runner_host::idle_prune_control::{PruneIdleReport, PruneIdleResponse};
use runner_host::paths::short_digest;
use runner_lifecycle::idle_pool::{
    BlankIdleReservationMiss, DestroyOutcome, ExactIdleReservationMiss, IdleDestroyJob,
    IdleDestroyPayload, IdleDestroyResult, IdlePool, IdlePoolSnapshot, ReservedIdleSandbox,
    RestoreReservedIdleResult,
};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::{StatusResult, StatusTracker};
use runner_types::ids::RunId;
use runner_types::types::reuse_key_kind;

pub type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

#[derive(Clone)]
pub struct IdleDestroyTracker {
    tasks: TaskTracker,
    reuse_state_notify: Arc<Notify>,
}

impl IdleDestroyTracker {
    pub fn new(reuse_state_notify: Arc<Notify>) -> Self {
        Self {
            tasks: TaskTracker::new(),
            reuse_state_notify,
        }
    }

    fn spawn_job(&self, job: IdleDestroyJob, context: &'static str) {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        drop(self.tasks.spawn(async move {
            match tokio::spawn(destroy_idle_job(job, context)).await {
                Ok(true) => reuse_state_notify.notify_one(),
                Ok(false) => {}
                Err(error) => warn!(context, %error, "idle entry destroy task panicked"),
            }
        }));
    }

    fn spawn_payload(&self, payload: IdleDestroyPayload, context: &'static str) {
        let reuse_state_notify = Arc::clone(&self.reuse_state_notify);
        drop(self.tasks.spawn(async move {
            let result = destroy_idle_payload_and_wait(payload, context).await;
            if result.workspace_cache_promoted {
                reuse_state_notify.notify_one();
            }
        }));
    }

    pub fn spawn_cleanup(
        &self,
        cleanup: impl Future<Output = ()> + Send + 'static,
        context: &'static str,
    ) {
        drop(self.tasks.spawn(async move {
            if AssertUnwindSafe(cleanup).catch_unwind().await.is_err() {
                warn!(context, "tracked activation cleanup panicked");
            }
        }));
    }

    pub fn notify_reuse_state(&self) {
        self.reuse_state_notify.notify_one();
    }

    pub async fn close_and_wait(&self) {
        let _ = self.tasks.close();
        self.tasks.wait().await;
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
    let (jobs, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let jobs = pool.drain_exact();
        (jobs, pool.status_snapshot())
    };
    let mut report = PruneIdleReport {
        selected: jobs.len(),
        completed: 0,
        uncertain: 0,
    };
    let mut tasks: FuturesUnordered<_> = jobs
        .into_iter()
        .map(|job| {
            tokio::spawn(async move { job.run_retaining_lease("operator_prune_idle").await })
        })
        .collect();
    tracker.notify_reuse_state();
    let status_result = status.set_idle_snapshot(snapshot).await;
    while let Some(result) = tasks.next().await {
        match result {
            Ok(result) => {
                match result.outcome {
                    DestroyOutcome::Completed => report.completed += 1,
                    DestroyOutcome::Uncertain => report.uncertain += 1,
                }
                if result.workspace_cache_promoted {
                    tracker.notify_reuse_state();
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
/// Called from both Draining mode (soft-drain entry) and teardown.
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
    context: &'static str,
) {
    let jobs = idle_pool.lock().await.drain();
    if !jobs.is_empty() {
        info!(count = jobs.len(), context, "destroying idle sandboxes");
        destroy_idle_jobs_and_wait(jobs, context).await;
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
    pub history_generation_run_id: Option<RunId>,
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

/// Reserve an ordinary or generation-matching idle sandbox and capture the
/// post-reservation snapshot under the same pool lock.
pub async fn reserve_reusable_idle_for_spawn(
    idle_pool: &SharedIdlePool,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<DeviceRateLimits>,
    history_generation_run_id: Option<RunId>,
) -> Option<ReservedIdleActivation> {
    let (reservation, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let reservation = match history_generation_run_id {
            Some(history_generation_run_id) => pool.reserve_reusable_generation(
                reuse_key,
                profile_name,
                device_rate_limits,
                history_generation_run_id,
            )?,
            None => pool.reserve_reusable(reuse_key, profile_name, device_rate_limits)?,
        };
        let snapshot = pool.status_snapshot();
        (reservation, snapshot)
    };
    Some(ReservedIdleActivation::new(reservation, snapshot))
}

/// Reserve exactly the predecessor's generation, retaining a typed miss reason
/// from the same locked observation when no matching entry can be claimed.
pub async fn reserve_exact_idle_for_spawn(
    idle_pool: &SharedIdlePool,
    reuse_key: &str,
    profile_name: &str,
    device_rate_limits: &Option<DeviceRateLimits>,
    history_generation_run_id: RunId,
) -> Result<ReservedIdleActivation, ExactIdleReservationMiss> {
    let (reservation, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let reservation = pool.reserve_reusable_generation_with_reason(
            reuse_key,
            profile_name,
            device_rate_limits,
            history_generation_run_id,
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
) {
    let (reservation, _) = reservation.into_parts();
    let (restore_result, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let restore_result = pool.restore_reserved(reservation);
        let snapshot = pool.status_snapshot();
        (restore_result, snapshot)
    };
    set_idle_status_snapshot(status, snapshot).await;
    if let RestoreReservedIdleResult::Replaced(destroy_job)
    | RestoreReservedIdleResult::Rejected(destroy_job) = restore_result
    {
        destroy_idle_jobs_and_wait(
            vec![*destroy_job],
            "finalizing_claim_reserved_idle_rollback",
        )
        .await;
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
/// snapshot is captured and persisted once.
pub async fn select_idle_entries_for_pressure(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
    budget: &Arc<ResourceBudget>,
    mut retiring_leases: Vec<BudgetLease>,
    request: IdlePressureRequest<'_>,
) -> (IdlePressureSelection, Option<BlankPoolSelection>) {
    let (selection, blank_pool_selection, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let exact = pool.reserve_reusable_for_pressure(
            request.reuse_key,
            request.profile_name,
            request.device_rate_limits,
            request.history_generation_run_id,
        );
        let (reservation, blank_pool_selection) = match exact {
            Some(reservation) => (Some(reservation), None),
            None if request.allow_compatible_blank => {
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
            None => (None, None),
        };
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
    if let Some(snapshot) = snapshot {
        set_idle_status_snapshot(status, snapshot).await;
    }
    (selection, blank_pool_selection)
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
    tracker.spawn_job(job, context);
}

fn retire_idle_destroy_job(
    tracker: &IdleDestroyTracker,
    job: IdleDestroyJob,
    context: &'static str,
) -> RetiringIdleEntry {
    let reuse_key = job.reuse_key().map(str::to_owned);
    let profile_name = job.profile_name().to_owned();
    let (payload, budget_lease) = job.into_retiring_parts();
    tracker.spawn_payload(payload, context);
    tracker.reuse_state_notify.notify_one();
    RetiringIdleEntry {
        budget_lease,
        reuse_key,
        profile_name,
    }
}

/// Destroy idle entries in parallel and wait until their leases are dropped.
pub async fn destroy_idle_jobs_and_wait(jobs: Vec<IdleDestroyJob>, context: &'static str) -> bool {
    // Destroy in parallel -- cgroup/NBD/netns teardown can still make serial
    // cleanup exceed shutdown and budget-pressure recovery budgets when many
    // sandboxes are idle.
    let mut set = JoinSet::new();
    for job in jobs {
        set.spawn(destroy_idle_job(job, context));
    }
    let mut workspace_cache_promoted = false;
    while let Some(result) = set.join_next().await {
        match result {
            Ok(promoted) => workspace_cache_promoted |= promoted,
            Err(e) => warn!(context, error = %e, "idle entry destroy task panicked"),
        }
    }
    workspace_cache_promoted
}

/// Destroy an idle sandbox entry. Its budget lease is released by Drop.
async fn destroy_idle_job(job: IdleDestroyJob, context: &'static str) -> bool {
    job.run_with_context(context).await
}

pub async fn destroy_idle_payload_and_wait(
    payload: IdleDestroyPayload,
    context: &'static str,
) -> IdleDestroyResult {
    let handle = tokio::spawn(payload.finalize_workspace_and_destroy(context));
    match handle.await {
        Ok(outcome) => outcome,
        Err(e) => {
            warn!(context, error = %e, "idle payload destroy task panicked");
            IdleDestroyResult {
                outcome: DestroyOutcome::Uncertain,
                workspace_cache_promoted: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory};
    use sandbox_mock::MockSandboxFactory;

    use runner_lifecycle::idle_pool::{
        ExactIdleReservationMiss, IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig,
        ParkResult, ParkingGate, test_support::ParkedIdleCandidateBuilder,
    };
    use runner_lifecycle::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
    use runner_lifecycle::resource_budget::ResourceBudget;
    use runner_lifecycle::workspace_promotion::test_support::{
        TEST_COMPLETED_AT, WorkspacePromotionFixture,
    };
    use runner_storage::storage_fingerprints::StorageFingerprints;

    fn claimed_idle_pool(
        gate: ParkingGate,
        history_generation_run_id: RunId,
    ) -> (SharedIdlePool, Arc<ResourceBudget>, SandboxId) {
        let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
        let sandbox_id = SandboxId::new_v4();
        let mut pool = IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 2 }, gate);
        assert!(matches!(
            pool.park(
                ParkedIdleCandidateBuilder::new("thread:claimed-idle", lease)
                    .with_sandbox_id(sandbox_id)
                    .with_history_generation_run_id(history_generation_run_id)
                    .build()
            ),
            ParkResult::Parked
        ));
        (Arc::new(tokio::sync::Mutex::new(pool)), budget, sandbox_id)
    }

    #[tokio::test]
    async fn claimed_idle_reservation_rollback_restores_pool_and_status() {
        let generation = RunId::new_v4();
        let (idle_pool, budget, sandbox_id) =
            claimed_idle_pool(ParkingGate::new_open(), generation);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let status = StatusTracker::new(path.clone(), 4, None, None);
        status.write_initial().await.unwrap();
        let initial = idle_pool.lock().await.status_snapshot();
        status.set_idle_snapshot(initial.clone()).await.unwrap();

        let reservation = reserve_reusable_idle_for_spawn(
            &idle_pool,
            "thread:claimed-idle",
            "vm0/default",
            &None,
            None,
        )
        .await
        .expect("ordinary matching sandbox should reserve");
        assert_eq!(idle_pool.lock().await.len(), 0);
        assert_eq!(reservation.idle_snapshot.revision, initial.revision + 1);
        assert!(reservation.idle_snapshot.idle_sandboxes.is_empty());
        status
            .set_idle_snapshot(reservation.idle_snapshot.clone())
            .await
            .unwrap();
        let reuse_state_notify = Notify::new();
        rollback_reserved_idle_for_spawn(reservation, &idle_pool, &status, &reuse_state_notify)
            .await;

        let restored = idle_pool.lock().await.status_snapshot();
        assert_eq!(restored.revision, initial.revision + 2);
        assert_eq!(restored.idle_sandboxes.len(), 1);
        assert_eq!(restored.idle_sandboxes[0].sandbox_id, sandbox_id);
        let wire: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert_eq!(
            wire["idle_sandboxes"][0]["sandbox_id"],
            sandbox_id.to_string()
        );
        assert!(reuse_state_notify.notified().now_or_never().is_none());
        assert_eq!(budget.allocated(), (2, 2048, 1));
        destroy_idle_jobs_and_wait(idle_pool.lock().await.drain(), "claimed_idle_test").await;
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn claimed_exact_reservation_classifies_miss_without_mutation() {
        let generation = RunId::new_v4();
        let (idle_pool, budget, sandbox_id) =
            claimed_idle_pool(ParkingGate::new_open(), generation);
        let initial_revision = idle_pool.lock().await.revision();
        let other_limits = sandbox::DeviceRateLimits {
            block: sandbox::BlockRateLimits {
                bandwidth_bytes_per_sec: 1024,
                ops_per_sec: 100,
            },
            network: sandbox::NetworkRateLimits {
                rx_bytes_per_sec: 1024,
                tx_bytes_per_sec: 1024,
            },
        };
        for (reuse_key, profile, device_rate_limits, history_generation_run_id, expected) in [
            (
                "missing-key",
                "vm0/default",
                None,
                generation,
                ExactIdleReservationMiss::Absent,
            ),
            (
                "thread:claimed-idle",
                "other-profile",
                None,
                generation,
                ExactIdleReservationMiss::ProfileMismatch,
            ),
            (
                "thread:claimed-idle",
                "vm0/default",
                Some(other_limits),
                generation,
                ExactIdleReservationMiss::DeviceLimitMismatch,
            ),
            (
                "thread:claimed-idle",
                "vm0/default",
                None,
                RunId::new_v4(),
                ExactIdleReservationMiss::HistoryGenerationMismatch,
            ),
        ] {
            let miss = reserve_exact_idle_for_spawn(
                &idle_pool,
                reuse_key,
                profile,
                &device_rate_limits,
                history_generation_run_id,
            )
            .await;
            assert!(matches!(miss, Err(reason) if reason == expected));
            let pool = idle_pool.lock().await;
            assert_eq!(pool.revision(), initial_revision);
            assert!(pool.contains_sandbox_id(sandbox_id));
        }
        let reservation = reserve_exact_idle_for_spawn(
            &idle_pool,
            "thread:claimed-idle",
            "vm0/default",
            &None,
            generation,
        )
        .await
        .expect("matching generation should reserve");
        assert_eq!(reservation.idle_snapshot.revision, initial_revision + 1);
        let dir = tempfile::tempdir().unwrap();
        let status = StatusTracker::new(dir.path().join("status.json"), 4, None, None);
        status.write_initial().await.unwrap();
        rollback_reserved_idle_for_spawn(reservation, &idle_pool, &status, &Notify::new()).await;
        destroy_idle_jobs_and_wait(idle_pool.lock().await.drain(), "claimed_exact_test").await;
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn rejected_claimed_idle_rollback_destroys_and_notifies() {
        let gate = ParkingGate::new_open();
        let (idle_pool, budget, _) = claimed_idle_pool(gate.clone(), RunId::new_v4());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let status = StatusTracker::new(path.clone(), 4, None, None);
        status.write_initial().await.unwrap();
        let initial = idle_pool.lock().await.status_snapshot();
        status.set_idle_snapshot(initial).await.unwrap();
        let reservation = reserve_reusable_idle_for_spawn(
            &idle_pool,
            "thread:claimed-idle",
            "vm0/default",
            &None,
            None,
        )
        .await
        .expect("sandbox should reserve before soft drain");
        status
            .set_idle_snapshot(reservation.idle_snapshot.clone())
            .await
            .unwrap();
        gate.close();
        let reuse_state_notify = Notify::new();
        rollback_reserved_idle_for_spawn(reservation, &idle_pool, &status, &reuse_state_notify)
            .await;

        assert_eq!(idle_pool.lock().await.len(), 0);
        assert_eq!(budget.allocated(), (0, 0, 0));
        let wire: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert!(wire.get("idle_sandboxes").is_none());
        assert!(reuse_state_notify.notified().now_or_never().is_some());
    }

    #[tokio::test]
    async fn exact_prune_keeps_reserved_entry_and_publishes_selected_snapshot() {
        let budget = Arc::new(ResourceBudget::new(8, 8192, 1.0, 2));
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 2 });
        for key in ["reserved", "pruned"] {
            let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
            assert!(matches!(
                pool.park(ParkedIdleCandidateBuilder::new(key, lease).build()),
                ParkResult::Parked
            ));
        }
        let reservation = pool.take_reserved("reserved").unwrap();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let status = StatusTracker::new(path.clone(), 4, None, None);
        status.write_initial().await.unwrap();
        let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));

        let report = prune_exact_idle_pool(&idle_pool, &status, &tracker)
            .await
            .unwrap();
        assert_eq!(
            (report.selected, report.completed, report.uncertain),
            (1, 1, 0)
        );
        assert_eq!(budget.allocated(), (2, 2048, 1));
        assert_eq!(idle_pool.lock().await.len(), 0);
        let wire: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert!(wire.get("idle_sandboxes").is_none());
        assert!(matches!(
            idle_pool.lock().await.restore_reserved(reservation),
            RestoreReservedIdleResult::Restored
        ));
        destroy_idle_jobs_and_wait(idle_pool.lock().await.drain(), "exact_prune_test").await;
        assert_eq!(budget.allocated(), (0, 0, 0));
    }

    #[tokio::test]
    async fn exact_prune_status_failure_or_cancellation_keeps_destroy_owned() {
        for cancel_caller in [false, true] {
            let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
            let gate = sandbox_mock::MockLifecycleGate::new();
            overrides.set_destroy_lifecycle_gate(gate.clone());
            let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
                MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
            ));
            let sandbox = factory
                .create(SandboxConfig {
                    id: SandboxId::new_v4(),
                    resources: ResourceLimits {
                        cpu_count: 2,
                        memory_mb: 2048,
                    },
                    device_rate_limits: None,
                    workspace_drive: None,
                })
                .await
                .unwrap();
            let budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
            let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
            let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
            assert!(matches!(
                pool.park(
                    ParkedIdleCandidateBuilder::new("prune-with-gate", lease)
                        .with_sandbox(sandbox)
                        .with_factory(factory)
                        .build()
                ),
                ParkResult::Parked
            ));
            let idle_pool = Arc::new(tokio::sync::Mutex::new(pool));
            let dir = tempfile::tempdir().unwrap();
            let path = if cancel_caller {
                dir.path().join("status.json")
            } else {
                dir.path().join("missing/status.json")
            };
            let status = Arc::new(StatusTracker::new(path, 2, None, None));
            if cancel_caller {
                status.write_initial().await.unwrap();
            }
            let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
            let pool_for_task = Arc::clone(&idle_pool);
            let status_for_task = Arc::clone(&status);
            let task = tokio::spawn(async move {
                prune_exact_idle_pool(&pool_for_task, &status_for_task, &tracker).await
            });
            gate.wait_entered(1, std::time::Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(idle_pool.lock().await.len(), 0);
            assert_eq!(budget.allocated(), (2, 2048, 1));
            if cancel_caller {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
                gate.release_one();
            } else {
                gate.release_one();
                let error = task.await.unwrap().unwrap_err();
                assert!(error.contains("status publication failed"), "{error}");
            }
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while budget.allocated().2 != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("detached destruction must complete after release");
        }
    }

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_empty_returns_false() {
        assert!(!destroy_idle_jobs_and_wait(Vec::new(), "test_empty").await);
    }

    #[tokio::test]
    async fn destroy_idle_jobs_and_wait_reports_workspace_cache_promotion() {
        let fixture = WorkspacePromotionFixture::new("thread:idle-destroy-cache").await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
        add_healthy_reuse_preparation_matcher(&overrides);
        let factory: Arc<Box<dyn SandboxFactory>> =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(overrides)));
        let sandbox = factory
            .create(SandboxConfig {
                id: fixture.sandbox_id,
                resources: ResourceLimits {
                    cpu_count: 2,
                    memory_mb: 4096,
                },
                device_rate_limits: None,
                workspace_drive: None,
            })
            .await
            .expect("create sandbox");
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let request = IdleParkRequest::new(IdleParkRequestParts {
            run_id: runner_types::ids::RunId::new_v4(),
            sandbox,
            factory,
            reuse_key: fixture.reuse_key.clone(),
            sandbox_id: fixture.sandbox_id,
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: lease,
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: StorageFingerprints::default(),
            restored_session_identity: None,
            history_generation_run_id: None,
            guest_timezone_intent: runner_lifecycle::guest_timezone::GuestTimezoneIntent::Unknown,
            workspace_image_size_bytes: b"workspace image".len() as u64,
            workspace_promotion: Some(fixture.promotion),
            handoff: None,
        });
        let candidate = match request.park_for_idle().await {
            Ok(outcome) => outcome
                .expect_reusable()
                .with_last_completed_at(TEST_COMPLETED_AT.into()),
            Err(_) => panic!("park should succeed"),
        };
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));

        let promoted = destroy_idle_jobs_and_wait(pool.drain(), "test_idle_destroy_cache").await;

        assert!(promoted);
        assert_eq!(budget.allocated(), (0, 0, 0));
        let held = fixture.cache.held_workspace_states().await;
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].reuse_key, fixture.reuse_key);
    }
}
