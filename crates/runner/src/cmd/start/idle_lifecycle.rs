//! Idle-pool lifecycle and status helpers for `runner start`.

use std::ops::Deref;
use std::sync::Arc;
use std::{future::Future, panic::AssertUnwindSafe};

use futures_util::FutureExt;
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tokio_util::task::TaskTracker;
use tracing::{info, warn};

use crate::idle_pool::{
    DestroyOutcome, IdleDestroyJob, IdleDestroyPayload, IdleDestroyResult, IdlePool,
    IdlePoolSnapshot, ReservedIdleSandbox,
};
use crate::ids::RunId;
use crate::paths::short_digest;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::status::{StatusResult, StatusTracker};
use crate::types::reuse_key_kind;

pub(super) type SharedIdlePool = Arc<tokio::sync::Mutex<IdlePool>>;

#[derive(Clone)]
pub(super) struct IdleDestroyTracker {
    tasks: TaskTracker,
    reuse_state_notify: Arc<Notify>,
}

impl IdleDestroyTracker {
    pub(super) fn new(reuse_state_notify: Arc<Notify>) -> Self {
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

    pub(super) fn spawn_cleanup(
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

    pub(super) fn notify_reuse_state(&self) {
        self.reuse_state_notify.notify_one();
    }

    pub(super) async fn close_and_wait(&self) {
        let _ = self.tasks.close();
        self.tasks.wait().await;
    }
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
pub(super) async fn drain_idle_pool(
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

pub(super) struct RetiringIdleEntry {
    budget_lease: BudgetLease,
    reuse_key: Option<String>,
    profile_name: String,
}

pub(super) struct IdlePressureRequest<'a> {
    pub(super) run_id: RunId,
    pub(super) reuse_key: Option<&'a str>,
    pub(super) profile_name: &'a str,
    pub(super) device_rate_limits: &'a Option<DeviceRateLimits>,
    pub(super) history_generation_run_id: Option<RunId>,
    pub(super) allow_compatible_blank: bool,
    pub(super) vcpu: u32,
    pub(super) memory_mb: u32,
    pub(super) context: &'static str,
}

pub(super) enum IdlePressureSelection {
    Reusable(ReservedIdleActivation),
    Fresh(BudgetLease),
    Exhausted(Vec<BudgetLease>),
}

/// A reuse reservation paired with the idle snapshot captured by the pool
/// mutation or direct handoff. Its reservation retains the parked/running
/// distinction so cancellation cannot restore a running sandbox to the pool.
/// Claimed activation can publish ownership without reacquiring the pool.
pub(super) struct ReservedIdleActivation {
    reservation: Box<ReservedIdleSandbox>,
    idle_snapshot: IdlePoolSnapshot,
}

impl ReservedIdleActivation {
    pub(super) fn new(reservation: ReservedIdleSandbox, idle_snapshot: IdlePoolSnapshot) -> Self {
        Self {
            reservation: Box::new(reservation),
            idle_snapshot,
        }
    }

    pub(super) fn into_parts(self) -> (ReservedIdleSandbox, IdlePoolSnapshot) {
        (*self.reservation, self.idle_snapshot)
    }
}

impl Deref for ReservedIdleActivation {
    type Target = ReservedIdleSandbox;

    fn deref(&self) -> &Self::Target {
        &self.reservation
    }
}

impl RetiringIdleEntry {
    pub(super) fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }

    pub(super) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(super) fn budget_vcpu(&self) -> u32 {
        self.budget_lease.vcpu()
    }

    pub(super) fn budget_memory_mb(&self) -> u32 {
        self.budget_lease.memory_mb()
    }

    pub(super) fn into_budget_lease(self) -> BudgetLease {
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
pub(super) async fn select_idle_entries_for_pressure(
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    tracker: &IdleDestroyTracker,
    budget: &Arc<ResourceBudget>,
    mut retiring_leases: Vec<BudgetLease>,
    request: IdlePressureRequest<'_>,
) -> IdlePressureSelection {
    let (selection, snapshot) = {
        let mut pool = idle_pool.lock().await;
        let reservation = pool
            .reserve_reusable_for_pressure(
                request.reuse_key,
                request.profile_name,
                request.device_rate_limits,
                request.history_generation_run_id,
            )
            .or_else(|| {
                request
                    .allow_compatible_blank
                    .then(|| pool.reserve_blank(request.profile_name, request.device_rate_limits))
                    .flatten()
            });
        if let Some(reservation) = reservation {
            drop(retiring_leases);
            let snapshot = pool.status_snapshot();
            (
                IdlePressureSelection::Reusable(ReservedIdleActivation {
                    reservation: Box::new(reservation),
                    idle_snapshot: snapshot,
                }),
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
            (selection, snapshot)
        }
    };
    if let Some(snapshot) = snapshot {
        set_idle_status_snapshot(status, snapshot).await;
    }
    selection
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

pub(super) async fn set_idle_status_snapshot(status: &StatusTracker, snapshot: IdlePoolSnapshot) {
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

pub(super) async fn add_running_run_with_idle_status_snapshot(
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

pub(super) async fn add_preparing_run_with_idle_status_snapshot(
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

pub(super) fn spawn_idle_destroy_job(
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
pub(super) async fn destroy_idle_jobs_and_wait(
    jobs: Vec<IdleDestroyJob>,
    context: &'static str,
) -> bool {
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

pub(super) async fn destroy_idle_payload_and_wait(
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

    use crate::idle_pool::{
        IdleParkRequest, IdleParkRequestParts, IdlePool, IdlePoolConfig, ParkResult,
    };
    use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
    use crate::resource_budget::ResourceBudget;
    use crate::storage_fingerprints::StorageFingerprints;
    use crate::workspace_promotion::test_support::{TEST_COMPLETED_AT, WorkspacePromotionFixture};

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
            run_id: crate::ids::RunId::new_v4(),
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
            guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
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
