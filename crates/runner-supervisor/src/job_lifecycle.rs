use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason;
use chrono::{DateTime, Utc};
use sandbox::SandboxId;
use tracing::warn;

use runner_executor::executor::{ExecutionFailure, ExecutionFailureKind, ResourceFailureKind};
use runner_executor::telemetry::JobTelemetry;
use runner_lifecycle::active_runs::ActiveRunGuard;
use runner_lifecycle::resource_budget::BudgetLease;
use runner_lifecycle::status::StatusTracker;
use runner_provider::{CompletionAuth, CompletionReportTiming, JobProvider};
use runner_types::ids::RunId;
use runner_types::types::CompleteRequest;

use crate::idle_lifecycle::SharedIdlePool;
use crate::orphan_reap::OrphanedActiveRuns;
use crate::ownership::{OwnershipTransitions, RunSandbox};

/// Derive the provider's completion reason from the executor's structured evidence.
pub fn completion_failure_reason(
    exit_code: i32,
    cancelled: bool,
    failure: Option<&ExecutionFailure>,
) -> Option<RequestFailureReason> {
    if exit_code == 0 || cancelled {
        return None;
    }
    let failure = failure?;
    match failure.kind {
        ExecutionFailureKind::Generic
            if failure
                .resource_diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
                .is_some_and(ResourceFailureKind::is_filesystem_full) =>
        {
            match failure
                .resource_diagnostics
                .and_then(|diagnostics| diagnostics.failure_kind)
            {
                Some(ResourceFailureKind::GuestHomeFilesystemFull) => {
                    Some(RequestFailureReason::GuestHomeFilesystemFull)
                }
                _ => Some(RequestFailureReason::GuestRootFilesystemFull),
            }
        }
        ExecutionFailureKind::Generic => failure
            .diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.failure_reason)
            .map(Into::into),
        ExecutionFailureKind::RunnerJobTimeout { .. } => {
            Some(RequestFailureReason::ExecutionTimeout)
        }
    }
}

/// Ownership facts known by the outer runner task for panic cleanup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunCleanupDisposition {
    /// The sandbox may still be active, or ownership is otherwise uncertain.
    ActiveOrUnknown,
    /// The sandbox has been accepted by the idle pool.
    IdlePoolOwned,
    /// The sandbox and budget were delivered to a claimed exact successor.
    HandoffOwned,
    /// The active sandbox was explicitly destroyed and destroy returned normally.
    DestroyCompleted,
    /// Normal completion already cleared, or no longer owns, active status.
    StatusRemoved,
}

/// Shared monotonic cleanup state for a claimed run.
#[derive(Clone, Debug)]
pub struct RunCleanupState {
    state: Arc<AtomicU8>,
}

impl Default for RunCleanupState {
    fn default() -> Self {
        Self::new()
    }
}

impl RunCleanupState {
    const ACTIVE_OR_UNKNOWN: u8 = 0;
    const DESTROY_COMPLETED: u8 = 1;
    const IDLE_POOL_OWNED: u8 = 2;
    const HANDOFF_OWNED: u8 = 3;
    const STATUS_REMOVED: u8 = 4;

    pub fn new() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(Self::ACTIVE_OR_UNKNOWN)),
        }
    }

    pub fn disposition(&self) -> RunCleanupDisposition {
        match self.state.load(Ordering::Acquire) {
            Self::STATUS_REMOVED => RunCleanupDisposition::StatusRemoved,
            Self::IDLE_POOL_OWNED => RunCleanupDisposition::IdlePoolOwned,
            Self::HANDOFF_OWNED => RunCleanupDisposition::HandoffOwned,
            Self::DESTROY_COMPLETED => RunCleanupDisposition::DestroyCompleted,
            _ => RunCleanupDisposition::ActiveOrUnknown,
        }
    }

    pub fn mark_idle_pool_owned(&self) {
        self.mark_at_least(Self::IDLE_POOL_OWNED);
    }

    pub fn mark_destroy_completed(&self) {
        self.mark_at_least(Self::DESTROY_COMPLETED);
    }

    pub fn mark_handoff_owned(&self) {
        self.mark_at_least(Self::HANDOFF_OWNED);
    }

    pub fn mark_status_removed(&self) {
        self.mark_at_least(Self::STATUS_REMOVED);
    }

    fn mark_at_least(&self, next: u8) {
        let _ = self
            .state
            .try_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (next > current).then_some(next)
            });
    }
}

/// Budget ownership while a claimed job is active in the outer task.
pub struct ActiveBudgetLease(BudgetLease);

impl ActiveBudgetLease {
    pub fn new(lease: BudgetLease) -> Self {
        Self(lease)
    }

    pub fn into_idle_park_lease(self) -> BudgetLease {
        self.0
    }

    pub fn from_idle_park_lease(lease: BudgetLease) -> Self {
        Self(lease)
    }
}

/// Budget ownership after sandbox finalization but before runner-local settlement.
///
/// This distinguishes a lease that settlement must release from one already
/// transferred to an accepted idle-pool entry.
#[must_use]
pub enum BudgetOwnership {
    /// The active job retains the lease until provider completion and active-status
    /// settlement have both finished, after which settlement releases it.
    Active(ActiveBudgetLease),
    /// The idle pool accepted the sandbox and its lease, so settlement performs no
    /// release. Reuse transfers the lease; idle destruction drops it.
    IdleOwned,
    /// A claimed exact successor owns the sandbox and lease directly.
    HandoffOwned,
    /// Orphan reconciliation retains capacity until physical absence is proven.
    OrphanOwned,
}

impl BudgetOwnership {
    pub fn active(lease: ActiveBudgetLease) -> Self {
        Self::Active(lease)
    }

    pub fn idle_owned() -> Self {
        Self::IdleOwned
    }

    pub fn handoff_owned() -> Self {
        Self::HandoffOwned
    }

    pub fn orphan_owned() -> Self {
        Self::OrphanOwned
    }

    fn release(self) {
        match self {
            Self::Active(lease) => drop(lease),
            Self::IdleOwned | Self::HandoffOwned | Self::OrphanOwned => {}
        }
    }
}

/// Data required for the provider completion call.
pub struct CompletionPayload {
    run_id: RunId,
    exit_code: i32,
    failure_reason: Option<RequestFailureReason>,
    error: Option<String>,
    sandbox_id: SandboxId,
    completion_auth: CompletionAuth,
}

#[must_use]
pub struct CompletionReportObservation {
    duration: Duration,
    completed_at: DateTime<Utc>,
}

/// Resource and telemetry produced by finalization, awaiting provider completion
/// and active-run settlement.
#[must_use]
pub struct FinalizedJob {
    pub finalization_ready: FinalizationReady,
    pub telemetry: JobTelemetry,
}

impl CompletionReportObservation {
    pub fn record(self, telemetry: &mut runner_executor::telemetry::JobTelemetry) {
        telemetry.record_at(
            "runner_host_completion_fallback",
            self.duration,
            true,
            None,
            self.completed_at,
        );
    }
}

impl CompletionPayload {
    pub fn new(
        run_id: RunId,
        exit_code: i32,
        failure_reason: Option<RequestFailureReason>,
        error: Option<String>,
        sandbox_id: SandboxId,
        completion_auth: CompletionAuth,
    ) -> Self {
        Self {
            run_id,
            exit_code,
            failure_reason,
            error,
            sandbox_id,
            completion_auth,
        }
    }

    /// Hold active status, budget and reuse ownership until both the provider
    /// report and finalization resolve, then settle before returning telemetry
    /// for Runner's deferred uploads. Carry finalization inputs in the constructor
    /// so the large future is created once, on polling the report coordinator.
    pub async fn complete_claimed_run<C, F>(
        self,
        provider: &dyn JobProvider,
        make_finalization: C,
        status: &StatusTracker,
        active_run_guard: ActiveRunGuard,
        cleanup_state: &RunCleanupState,
    ) -> JobTelemetry
    where
        C: FnOnce() -> F,
        F: Future<Output = FinalizedJob>,
    {
        let run = RunSandbox::new(self.run_id, self.sandbox_id);
        let (report, finalized) = self
            .report_with_finalization(provider, make_finalization)
            .await;
        let FinalizedJob {
            finalization_ready,
            mut telemetry,
        } = finalized;
        report.record(&mut telemetry);
        settle_completed_job(
            finalization_ready,
            run,
            status,
            active_run_guard,
            cleanup_state,
            &mut telemetry,
        )
        .await;
        telemetry
    }

    /// Report exactly once, either concurrently with sandbox finalization or
    /// after it. The caller retains the finalization result until settlement.
    async fn report_with_finalization<C, F>(
        self,
        provider: &dyn JobProvider,
        make_finalization: C,
    ) -> (CompletionReportObservation, F::Output)
    where
        C: FnOnce() -> F,
        F: Future,
    {
        match provider.completion_report_timing() {
            CompletionReportTiming::ConcurrentWithFinalization => {
                tokio::join!(self.report(provider), make_finalization())
            }
            CompletionReportTiming::AfterFinalization => {
                let finalized = make_finalization().await;
                let report = self.report(provider).await;
                (report, finalized)
            }
        }
    }

    pub async fn report(self, provider: &dyn JobProvider) -> CompletionReportObservation {
        let Self {
            run_id,
            exit_code,
            failure_reason,
            error,
            sandbox_id,
            completion_auth,
        } = self;
        let provider_completion_started = Instant::now();
        provider
            .complete(
                CompleteRequest {
                    run_id,
                    exit_code,
                    failure_reason,
                    error,
                    sandbox_id: Some(sandbox_id),
                },
                completion_auth,
            )
            .await;
        CompletionReportObservation {
            duration: provider_completion_started.elapsed(),
            completed_at: Utc::now(),
        }
    }
}

/// Sandbox finalization has resolved resource ownership.
#[must_use]
pub struct FinalizationReady {
    budget: BudgetOwnership,
    reuse_state_changed: bool,
}

impl FinalizationReady {
    pub fn new(budget: BudgetOwnership) -> Self {
        Self {
            budget,
            reuse_state_changed: false,
        }
    }

    pub fn with_reuse_state_changed(mut self) -> Self {
        self.reuse_state_changed = true;
        self
    }

    pub fn reuse_state_changed(&self) -> bool {
        self.reuse_state_changed
    }

    pub async fn settle(
        self,
        completed_run: RunSandbox,
        ownership: &OwnershipTransitions<'_>,
        cleanup_state: &RunCleanupState,
    ) {
        if matches!(self.budget, BudgetOwnership::OrphanOwned) {
            return;
        }
        ownership.active_completed(completed_run).await;
        cleanup_state.mark_status_removed();
        self.budget.release();
    }
}

/// Complete status and budget settlement before releasing the active reuse key.
async fn settle_completed_job(
    ready: FinalizationReady,
    run: RunSandbox,
    status: &StatusTracker,
    active_run_guard: ActiveRunGuard,
    cleanup_state: &RunCleanupState,
    telemetry: &mut JobTelemetry,
) {
    let ownership = OwnershipTransitions::new(status);
    ready.settle(run, &ownership, cleanup_state).await;
    if active_run_guard.release() {
        telemetry.record(
            "runner_active_reuse_key_released",
            Duration::ZERO,
            true,
            None,
        );
    }
}

/// Reconcile the proven resource owner after an outer-task panic. Unknown
/// ownership remains visible and is registered for orphan recovery.
pub async fn recover_panicked_run(
    run: RunSandbox,
    status: &StatusTracker,
    idle_pool: &SharedIdlePool,
    cleanup_state: &RunCleanupState,
    orphaned_active_runs: &OrphanedActiveRuns,
) {
    let ownership = OwnershipTransitions::new(status);
    match cleanup_state.disposition() {
        RunCleanupDisposition::StatusRemoved => {}
        RunCleanupDisposition::DestroyCompleted => {
            ownership.active_destroy_completed(run).await;
        }
        RunCleanupDisposition::IdlePoolOwned => {
            let snapshot = idle_pool.lock().await.status_snapshot();
            ownership.active_idle_pool_owned(run, snapshot).await;
        }
        RunCleanupDisposition::HandoffOwned => {
            ownership.active_completed(run).await;
        }
        RunCleanupDisposition::ActiveOrUnknown => {
            warn!(
                run_id = %run.run_id(),
                sandbox_id = %run.sandbox_id(),
                "outer job task panicked before sandbox ownership was proven; leaving active run visible for orphan reconciliation"
            );
            ownership.active_ownership_unknown(orphaned_active_runs, run);
        }
    }
}

#[cfg(test)]
mod tests;
