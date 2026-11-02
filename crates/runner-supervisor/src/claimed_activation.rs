//! Claimed-resource ownership from active-status publication through executor handoff.
//!
//! The Runner composition root builds the executor request. Until that request is ready, this
//! guard owns the claim, cancellation registration, sandbox lease and active-run registration.
//! Dropping it starts recovery rather than silently abandoning provider or sandbox ownership.

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
    pub required_home_source_run_id: Option<RunId>,
    pub claimed: ClaimedJob,
    pub rootfs_hash: String,
    pub cancellation: RunCancellationRegistration,
    pub profile_name: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub home_disk_mb: u32,
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

/// Checked ownership/publication failures before executor handoff.
#[derive(Debug, thiserror::Error)]
pub enum ClaimedActivationError {
    #[error("claimed activation setup was already transferred")]
    SetupAlreadyTransferred,
    #[error("active status was already published")]
    StatusAlreadyPublished,
    #[error("claimed activation cannot transfer before active status is published")]
    StatusNotPublished,
    #[error("persist active runner ownership: {0}")]
    StatusPersistence(#[from] StatusPersistenceError),
    #[error("committed home observation closed during claimed startup: {0}")]
    HomeObservationClosed(#[from] tokio::sync::watch::error::RecvError),
}

impl ClaimedActivationError {
    pub fn recovery_reason(&self) -> &'static str {
        match self {
            Self::StatusPersistence(_) => "active_status_persistence_failed",
            Self::HomeObservationClosed(_) => "home_observation_closed",
            Self::SetupAlreadyTransferred
            | Self::StatusAlreadyPublished
            | Self::StatusNotPublished => "activation_ownership_failed",
        }
    }
}

/// Owns a provider claim and sandbox until active status is published and the caller takes it.
pub struct ClaimedActivationGuard {
    setup: Option<ClaimedJobSetup>,
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
            setup: Some(setup),
            status_published: false,
            sandbox_id,
            recovery,
        }
    }

    pub fn sandbox_id(&self) -> SandboxId {
        self.sandbox_id
    }

    /// Borrow the still-owned setup to build a session restore plan.
    pub fn setup(&mut self) -> Result<&mut ClaimedJobSetup, ClaimedActivationError> {
        self.setup
            .as_mut()
            .ok_or(ClaimedActivationError::SetupAlreadyTransferred)
    }

    pub fn record_resource_budget_occupancy(
        &mut self,
        budget: &ResourceBudget,
    ) -> Result<(), ClaimedActivationError> {
        self.setup()?
            .pre_spawn_timing
            .record_resource_budget_occupancy(budget);
        Ok(())
    }

    /// Commit the matching pool snapshot and active status before executor ownership transfer.
    pub async fn publish_active_status(&mut self) -> Result<(), ClaimedActivationError> {
        let setup = self
            .setup
            .as_mut()
            .ok_or(ClaimedActivationError::SetupAlreadyTransferred)?;
        if self.status_published {
            return Err(ClaimedActivationError::StatusAlreadyPublished);
        }
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
    pub fn take_setup_after_status(&mut self) -> Result<ClaimedJobSetup, ClaimedActivationError> {
        if !self.status_published {
            return Err(ClaimedActivationError::StatusNotPublished);
        }
        self.take_setup()
    }

    pub async fn recover(
        self,
        reason: &'static str,
        error: String,
    ) -> Result<ClaimedActivationRecovery, ClaimedActivationError> {
        self.recover_failure(reason, ExecutionFailure::from_error(error))
            .await
    }

    /// Settle cancellation before executor ownership without relabeling it a failure.
    pub async fn recover_cancelled(
        self,
    ) -> Result<ClaimedActivationRecovery, ClaimedActivationError> {
        self.recover_failure("activation_cancelled", ExecutionFailure::cancelled())
            .await
    }

    async fn recover_failure(
        mut self,
        reason: &'static str,
        failure: ExecutionFailure,
    ) -> Result<ClaimedActivationRecovery, ClaimedActivationError> {
        let setup = self.take_setup()?;
        Ok(recover_claimed_activation_failure(
            setup,
            self.sandbox_id,
            reason,
            failure,
            &self.recovery,
        )
        .await)
    }

    fn take_setup(&mut self) -> Result<ClaimedJobSetup, ClaimedActivationError> {
        self.setup
            .take()
            .ok_or(ClaimedActivationError::SetupAlreadyTransferred)
    }
}

impl Drop for ClaimedActivationGuard {
    fn drop(&mut self) {
        let Some(setup) = self.setup.take() else {
            return;
        };
        let sandbox_id = self.sandbox_id;
        let recovery = self.recovery.clone();
        let cleanup = recovery.idle_destroy_tracker.clone();
        cleanup.spawn_cleanup(
            async move {
                recover_claimed_activation_failure(
                    setup,
                    sandbox_id,
                    "activation_task_dropped",
                    ExecutionFailure::from_error(
                        "claimed activation task dropped before executor ownership transfer",
                    ),
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
    execution_failure: ExecutionFailure,
    ctx: &ClaimedActivationResources,
) -> ClaimedActivationRecovery {
    let ClaimedJobSetup {
        required_home_source_run_id: _,
        claimed,
        cancellation,
        profile_name: _,
        vcpu: _,
        memory_mb: _,
        rootfs_hash: _,
        home_disk_mb: _,
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
        reuse_result: _,
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
        error = %execution_failure.error,
        recovery_reason = reason,
        activation_phase = "before_executor_handoff",
        recovery_outcome = "destroy_or_release",
        "recovering claimed activation before executor handoff"
    );
    ctx.provider
        .complete(
            CompleteRequest {
                run_id,
                exit_code: execution_failure.exit_code,
                failure_reason: None,
                error: Some(execution_failure.error),
                sandbox_id: None,
            },
            completion_auth,
        )
        .await;
    let cleanup_completed = if let Some(reuse_entry) = reuse_entry {
        let cleanup = reuse_entry
            .into_destroy_job(factory, active_lease, reason)
            .run_retaining_lease(reason)
            .await;
        if cleanup.home_cache_promoted {
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
mod tests;
