//! Claimed-resource ownership from active-status publication through executor handoff.
//!
//! The Runner composition root builds the executor request. Until that request is ready, this
//! guard owns the claim, cancellation registration, sandbox lease and active-run registration.
//! Dropping it starts recovery rather than silently abandoning provider or sandbox ownership.

use std::mem::ManuallyDrop;
use std::sync::Arc;
use std::time::Instant;

use runner_executor::executor::{
    BlankPoolSelection, ExecutionFailure, ExecutorConfig, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
};
use runner_executor::telemetry::JobTelemetry;
use runner_lifecycle::active_runs::ActiveRunGuard;
use runner_lifecycle::idle_pool::{DestroyOutcome, IdlePoolSnapshot, ReusableIdleSandbox};
use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
use runner_lifecycle::status::{StatusPersistenceError, StatusTracker};
use runner_provider::{ClaimedJob, JobProvider, RunCancellationRegistration};
use runner_types::ids::RunId;
use runner_types::types::{CompleteRequest, ExecutionContext, SandboxReuseResult};
use sandbox::{DeviceRateLimits, SandboxId};
use tokio::sync::Notify;
use tracing::warn;

use crate::SharedFactory;
use crate::idle_lifecycle::{
    IdleDestroyTracker, add_preparing_run_with_idle_status_snapshot,
    add_running_run_with_idle_status_snapshot,
};
use crate::orphan_reap::OrphanedActiveRuns;
use crate::ownership::{OwnershipTransitions, RunSandbox};

/// Resource selected for a claimed job, not yet transferred to its executor.
pub struct ReadyClaimedResource {
    pub reuse_entry: Option<ReusableIdleSandbox>,
    pub active_lease: BudgetLease,
    pub reuse_result: SandboxReuseResult,
    pub idle_snapshot: Option<IdlePoolSnapshot>,
}

/// All owned inputs held across active-status publication and executor request construction.
pub struct ClaimedJobSetup {
    pub claimed: ClaimedJob,
    pub cancellation: RunCancellationRegistration,
    pub profile_name: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub workspace_disk_mb: u32,
    pub restore_guest_state: bool,
    pub device_rate_limits: Option<DeviceRateLimits>,
    pub factory: SharedFactory,
    pub resource: ReadyClaimedResource,
    pub pre_spawn_timing: RunnerPreSpawnTiming,
    pub active_run_guard: ActiveRunGuard,
}

/// Concrete recovery services supplied by Runner without exposing its `SpawnContext`.
#[derive(Clone)]
pub struct ClaimedActivationResources {
    pub provider: Arc<dyn JobProvider>,
    pub exec_config: Arc<ExecutorConfig>,
    pub status: Arc<StatusTracker>,
    pub orphaned_active_runs: OrphanedActiveRuns,
    pub reuse_state_notify: Arc<Notify>,
    pub idle_destroy_tracker: IdleDestroyTracker,
}

/// Owns a provider claim and sandbox until active status is published and the caller takes it.
pub struct ClaimedActivationGuard {
    setup: ManuallyDrop<ClaimedJobSetup>,
    armed: bool,
    status_published: bool,
    sandbox_id: SandboxId,
    recovery: ClaimedActivationResources,
}

impl ClaimedActivationGuard {
    pub fn new(setup: ClaimedJobSetup, recovery: ClaimedActivationResources) -> Self {
        let sandbox_id = match &setup.resource.reuse_entry {
            Some(entry) => entry.sandbox_id(),
            None => SandboxId::new_v4(),
        };
        Self {
            setup: ManuallyDrop::new(setup),
            armed: true,
            status_published: false,
            sandbox_id,
            recovery,
        }
    }

    pub fn sandbox_id(&self) -> SandboxId {
        self.sandbox_id
    }

    /// Borrow the still-owned setup to build a session restore plan.
    pub fn setup(&mut self) -> &mut ClaimedJobSetup {
        &mut self.setup
    }

    pub fn record_resource_budget_occupancy(&mut self, budget: &ResourceBudget) {
        self.setup
            .pre_spawn_timing
            .record_resource_budget_occupancy(budget);
    }

    /// Commit the matching pool snapshot and active status before executor ownership transfer.
    pub async fn publish_active_status(&mut self) -> Result<(), StatusPersistenceError> {
        assert!(
            !self.status_published,
            "active status was already published"
        );
        let setup = &mut *self.setup;
        let started_at = Instant::now();
        let result = publish_active_run_status(
            &self.recovery.status,
            setup.claimed.context().run_id,
            self.sandbox_id,
            setup.resource.reuse_entry.is_some(),
            setup.resource.idle_snapshot.clone(),
        )
        .await;
        setup
            .pre_spawn_timing
            .record_phase_elapsed(RunnerPreSpawnPhase::ActiveStatusPublish, started_at);
        result?;
        self.status_published = true;
        Ok(())
    }

    /// Transfer only after status publication succeeds; a panic while preparing stays recoverable.
    pub fn take_setup_after_status(&mut self) -> ClaimedJobSetup {
        assert!(
            self.status_published,
            "claimed activation cannot transfer before active status is published"
        );
        self.take_setup()
    }

    pub async fn recover(
        mut self,
        reason: &'static str,
        error: String,
    ) -> ClaimedActivationRecovery {
        recover_claimed_activation_failure(
            self.take_setup(),
            self.sandbox_id,
            reason,
            error,
            &self.recovery,
        )
        .await
    }

    fn take_setup(&mut self) -> ClaimedJobSetup {
        self.armed = false;
        // SAFETY: `armed` is true exactly while `setup` has not been taken.
        // Every take clears it first, and `Drop` only takes while it is true.
        unsafe { ManuallyDrop::take(&mut self.setup) }
    }
}

impl Drop for ClaimedActivationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let setup = self.take_setup();
        let sandbox_id = self.sandbox_id;
        let recovery = self.recovery.clone();
        let cleanup = recovery.idle_destroy_tracker.clone();
        cleanup.spawn_cleanup(
            async move {
                recover_claimed_activation_failure(
                    setup,
                    sandbox_id,
                    "activation_task_dropped",
                    "claimed activation task dropped before executor ownership transfer".to_owned(),
                    &recovery,
                )
                .await
                .finish()
                .await;
            },
            "claimed_activation_drop",
        );
    }
}

/// Completion result retains cancellation registration for the caller's existing lifecycle.
pub struct ClaimedActivationRecovery {
    cancellation: RunCancellationRegistration,
    telemetry: Option<JobTelemetry>,
}

impl ClaimedActivationRecovery {
    pub async fn finish(self) {
        self.cancellation.unregister().await;
        if let Some(telemetry) = self.telemetry {
            telemetry.flush().await;
        }
    }

    pub async fn into_cancellation(self) -> RunCancellationRegistration {
        if let Some(telemetry) = self.telemetry {
            telemetry.flush().await;
        }
        self.cancellation
    }
}

async fn publish_active_run_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
    reused_idle: bool,
    idle_snapshot: Option<IdlePoolSnapshot>,
) -> Result<(), StatusPersistenceError> {
    if let Some(snapshot) = idle_snapshot {
        if reused_idle {
            add_running_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await
        } else {
            add_preparing_run_with_idle_status_snapshot(status, run_id, sandbox_id, snapshot).await
        }
    } else {
        status.add_preparing_run(run_id, sandbox_id).await
    }
}

async fn recover_claimed_activation_failure(
    setup: ClaimedJobSetup,
    sandbox_id: SandboxId,
    reason: &'static str,
    error: String,
    ctx: &ClaimedActivationResources,
) -> ClaimedActivationRecovery {
    let ClaimedJobSetup {
        claimed,
        cancellation,
        profile_name: _,
        vcpu: _,
        memory_mb: _,
        workspace_disk_mb: _,
        restore_guest_state: _,
        device_rate_limits: _,
        factory,
        resource,
        pre_spawn_timing,
        active_run_guard,
    } = setup;
    let ReadyClaimedResource {
        reuse_entry,
        active_lease,
        reuse_result,
        idle_snapshot: _,
    } = resource;
    let (context, completion_auth, active_input_source) = claimed.into_parts();
    let run_id = context.run_id;
    drop(active_input_source);
    let telemetry = blank_pool_selection_telemetry(
        &context,
        pre_spawn_timing.blank_pool_selection(),
        &ctx.exec_config,
    );
    warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        error,
        recovery_reason = reason,
        activation_phase = "before_executor_handoff",
        recovery_outcome = "destroy_or_release",
        "recovering claimed activation before executor handoff"
    );
    let execution_failure = ExecutionFailure::from_error(error);
    ctx.provider
        .complete(
            CompleteRequest {
                run_id,
                exit_code: execution_failure.exit_code,
                failure_reason: None,
                error: Some(execution_failure.error),
                sandbox_id: None,
                sandbox_reuse_result: Some(reuse_result),
                workspace_reuse_result: None,
                active_input_delivery_ids: Vec::new(),
            },
            completion_auth,
        )
        .await;
    let cleanup_completed = if let Some(reuse_entry) = reuse_entry {
        let cleanup = reuse_entry
            .into_destroy_job(factory, active_lease, reason)
            .run_retaining_lease(reason)
            .await;
        if cleanup.workspace_cache_promoted {
            ctx.reuse_state_notify.notify_one();
        }
        drop(cleanup.budget_lease);
        cleanup.outcome == DestroyOutcome::Completed
    } else {
        drop(active_lease);
        true
    };
    if cleanup_completed {
        remove_failed_activation_status(&ctx.status, run_id, sandbox_id).await;
    } else {
        retain_uncertain_activation_ownership(
            ctx.status.as_ref(),
            &ctx.orphaned_active_runs,
            run_id,
            sandbox_id,
            reason,
        );
    }
    drop(active_run_guard);
    ClaimedActivationRecovery {
        cancellation,
        telemetry,
    }
}

/// Remove status only when the sandbox and run still match this activation.
pub async fn remove_failed_activation_status(
    status: &StatusTracker,
    run_id: RunId,
    sandbox_id: SandboxId,
) {
    match status.remove_run_if_matching(run_id, sandbox_id).await {
        Ok(true) => {}
        Ok(false) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                "failed activation status had already changed before recovery"
            );
        }
        Err(error) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                %error,
                "failed to persist active status removal during activation recovery"
            );
        }
    }
}

/// Keep the exact active record visible for orphan reconciliation after uncertain destruction.
pub fn retain_uncertain_activation_ownership(
    status: &StatusTracker,
    orphaned_active_runs: &OrphanedActiveRuns,
    run_id: RunId,
    sandbox_id: SandboxId,
    reason: &'static str,
) {
    warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        recovery_reason = reason,
        recovery_outcome = "orphaned_after_uncertain_destroy",
        "activation cleanup could not prove sandbox destruction; keeping active status for orphan reconciliation"
    );
    OwnershipTransitions::new(status)
        .active_ownership_unknown(orphaned_active_runs, RunSandbox::new(run_id, sandbox_id));
}

/// Construct blank-pool selection telemetry for pre-executor completion paths.
pub fn blank_pool_selection_telemetry(
    context: &ExecutionContext,
    selection: Option<BlankPoolSelection>,
    exec_config: &ExecutorConfig,
) -> Option<JobTelemetry> {
    selection.map(|selection| {
        let mut telemetry = JobTelemetry::new(
            exec_config.http.clone(),
            context.run_id,
            context.sandbox_token.clone(),
            exec_config.runner_hostname.clone(),
        );
        selection.record(&mut telemetry);
        telemetry
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_lifecycle::status::IdleSandbox;

    fn read_active_run_phase(path: &std::path::Path) -> String {
        let raw = std::fs::read_to_string(path).unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"][0]["phase"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn idle_snapshot() -> IdlePoolSnapshot {
        IdlePoolSnapshot {
            revision: 1,
            blank_sandboxes: vec![],
            idle_sandboxes: vec![IdleSandbox {
                reuse_key: "sess-removed-from-pool".into(),
                sandbox_id: SandboxId::new_v4(),
            }],
        }
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_preparing_after_reuse_miss_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            false,
            Some(idle_snapshot()),
        )
        .await
        .unwrap();
        assert_eq!(read_active_run_phase(&status_path), "preparing");
    }

    #[tokio::test]
    async fn publish_active_run_status_writes_running_for_reused_idle_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        publish_active_run_status(
            &status,
            RunId::new_v4(),
            SandboxId::new_v4(),
            true,
            Some(idle_snapshot()),
        )
        .await
        .unwrap();
        assert_eq!(read_active_run_phase(&status_path), "running");
    }

    #[tokio::test]
    async fn uncertain_cleanup_keeps_the_exact_active_record_for_orphan_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        status.write_initial().await.unwrap();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await.unwrap();
        let orphaned = OrphanedActiveRuns::new();

        retain_uncertain_activation_ownership(
            &status,
            &orphaned,
            run_id,
            sandbox_id,
            "uncertain_activation_test",
        );
        assert_eq!(orphaned.len(), 1);
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
        assert_eq!(raw["active_runs"][0]["run_id"], run_id.to_string());
        assert_eq!(raw["active_runs"][0]["sandbox_id"], sandbox_id.to_string());

        remove_failed_activation_status(&status, run_id, SandboxId::new_v4()).await;
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
        assert_eq!(raw["active_runs"].as_array().unwrap().len(), 1);
    }
}
