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
use runner_types::types::{CompleteRequest, SandboxReuseResult, WorkspaceReuseResult};

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
                == Some(ResourceFailureKind::GuestRootFilesystemFull) =>
        {
            Some(RequestFailureReason::GuestRootFilesystemFull)
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
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
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

    fn release(self) {
        match self {
            Self::Active(lease) => drop(lease),
            Self::IdleOwned | Self::HandoffOwned => {}
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
    reuse_result: SandboxReuseResult,
    workspace_reuse_result: Option<WorkspaceReuseResult>,
    active_input_delivery_ids: Vec<String>,
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
        reuse_result: SandboxReuseResult,
        completion_auth: CompletionAuth,
    ) -> Self {
        Self {
            run_id,
            exit_code,
            failure_reason,
            error,
            sandbox_id,
            reuse_result,
            workspace_reuse_result: None,
            active_input_delivery_ids: Vec::new(),
            completion_auth,
        }
    }

    pub fn with_workspace_reuse_result(
        mut self,
        workspace_reuse_result: Option<WorkspaceReuseResult>,
    ) -> Self {
        self.workspace_reuse_result = workspace_reuse_result;
        self
    }

    pub fn with_active_input_delivery_ids(
        mut self,
        active_input_delivery_ids: Vec<String>,
    ) -> Self {
        self.active_input_delivery_ids = active_input_delivery_ids;
        self
    }

    /// Hold active status, budget and reuse ownership until both the provider
    /// report and finalization resolve, then settle before returning telemetry
    /// for Runner's deferred uploads.
    pub async fn complete_claimed_run<F: Future<Output = FinalizedJob>>(
        self,
        provider: &dyn JobProvider,
        finalize: F,
        run: RunSandbox,
        status: &StatusTracker,
        active_run_guard: ActiveRunGuard,
        cleanup_state: &RunCleanupState,
    ) -> JobTelemetry {
        let (report, finalized) = self.report_with_finalization(provider, finalize).await;
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
    async fn report_with_finalization<F: Future>(
        self,
        provider: &dyn JobProvider,
        finalize: F,
    ) -> (CompletionReportObservation, F::Output) {
        match provider.completion_report_timing() {
            CompletionReportTiming::ConcurrentWithFinalization => {
                tokio::join!(self.report(provider), finalize)
            }
            CompletionReportTiming::AfterFinalization => {
                let finalized = finalize.await;
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
            reuse_result,
            workspace_reuse_result,
            active_input_delivery_ids,
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
                    sandbox_reuse_result: Some(reuse_result),
                    workspace_reuse_result,
                    active_input_delivery_ids,
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
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use async_trait::async_trait;
    use guest_contracts::diagnostics::{
        AgentFramework, FailureClass, FailureDiagnostic, FailureReason, PromptMetadata,
    };
    use runner_executor::executor;
    use sandbox::SandboxId;

    use runner_lifecycle::active_runs::ActiveRuns;
    use runner_lifecycle::resource_budget::{BudgetLease, ResourceBudget};
    use runner_lifecycle::status::StatusTracker;
    use runner_provider::{ClaimedJob, HttpClient, HttpClientConfig, JobCandidate, JobProvider};
    use runner_types::ids::RunId;
    use runner_types::types::{HeartbeatState, SandboxReuseResult};

    use crate::idle_lifecycle::SharedIdlePool;
    use crate::orphan_reap::OrphanedActiveRuns;
    use crate::ownership::OwnershipTransitions;

    #[test]
    fn completion_reason_uses_diagnostic_for_generic_failure() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        let failure = executor::ExecutionFailure::new(1, "usage limit", Some(diagnostic));

        assert_eq!(
            completion_failure_reason(1, false, Some(&failure)),
            Some(RequestFailureReason::UsageLimit)
        );
    }

    #[test]
    fn completion_reason_reports_proven_rootfs_exhaustion() {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        for diagnostic in [None, Some(diagnostic)] {
            let failure =
                executor::ExecutionFailure::new(1, "Agent exited with code 1", diagnostic)
                    .with_resource_diagnostics(Some(
                        executor::ResourceFailureDiagnostics::from_failure_kind(
                            executor::ResourceFailureKind::GuestRootFilesystemFull,
                        ),
                    ));
            assert_eq!(
                completion_failure_reason(1, false, Some(&failure)),
                Some(RequestFailureReason::GuestRootFilesystemFull)
            );
            assert_eq!(completion_failure_reason(0, false, Some(&failure)), None);
            assert_eq!(completion_failure_reason(1, true, Some(&failure)), None);
        }
    }

    #[test]
    fn completion_reason_does_not_infer_rootfs_exhaustion_from_error_text() {
        let failure = executor::ExecutionFailure::new(1, "No space left on device", None);
        assert_eq!(completion_failure_reason(1, false, Some(&failure)), None);
        for kind in [
            executor::ResourceFailureKind::GuestMemoryOomKilled,
            executor::ResourceFailureKind::HostMemoryOomKilled,
        ] {
            let failure = executor::ExecutionFailure::new(1, "Agent process killed", None)
                .with_resource_diagnostics(Some(
                    executor::ResourceFailureDiagnostics::from_failure_kind(kind),
                ));
            assert_eq!(completion_failure_reason(1, false, Some(&failure)), None);
        }
    }

    #[test]
    fn completion_reason_uses_runner_kind_for_timeout_and_overrides_diagnostic() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        );

        assert_eq!(
            completion_failure_reason(124, false, Some(&failure)),
            Some(RequestFailureReason::ExecutionTimeout)
        );

        let conflicting_diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::ClaudeCode,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(FailureReason::UsageLimit);
        let failure_with_conflicting_diagnostic = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            Some(conflicting_diagnostic),
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        )
        .with_resource_diagnostics(Some(
            executor::ResourceFailureDiagnostics::from_failure_kind(
                executor::ResourceFailureKind::GuestRootFilesystemFull,
            ),
        ));

        assert_eq!(
            completion_failure_reason(124, false, Some(&failure_with_conflicting_diagnostic)),
            Some(RequestFailureReason::ExecutionTimeout)
        );
    }

    #[test]
    fn completion_reason_omits_success_and_cancellation() {
        let failure = executor::ExecutionFailure::runner_job_timeout(
            124,
            "execution timed out",
            None,
            Duration::from_secs(7200),
            Duration::from_secs(7200),
            None,
        );

        assert_eq!(completion_failure_reason(0, false, None), None);
        assert_eq!(completion_failure_reason(124, true, Some(&failure)), None);
    }

    fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        (budget, lease)
    }
    async fn status_active_run_count(path: &std::path::Path) -> usize {
        let raw = tokio::fs::read_to_string(path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        status["active_runs"].as_array().unwrap().len()
    }
    async fn status_active_run_records(status_path: &std::path::Path) -> Vec<(String, String)> {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut records: Vec<(String, String)> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| {
                (
                    run["run_id"].as_str().unwrap().to_string(),
                    run["sandbox_id"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        records.sort_unstable();
        records
    }
    struct CompletionAuthProvider {
        auth_matches: Arc<AtomicBool>,
        active_input_delivery_ids: Arc<std::sync::Mutex<Vec<String>>>,
        failure_reason: Arc<std::sync::Mutex<Option<RequestFailureReason>>>,
    }

    #[async_trait]
    impl JobProvider for CompletionAuthProvider {
        async fn discover(&self) -> Option<JobCandidate> {
            None
        }

        async fn claim(&self, _candidate: JobCandidate) -> Option<ClaimedJob> {
            None
        }

        async fn complete(&self, request: CompleteRequest, completion_auth: CompletionAuth) {
            self.auth_matches.store(
                completion_auth
                    .into_sandbox_token(request.run_id)
                    .is_ok_and(|token| token == "completion-token"),
                Ordering::SeqCst,
            );
            *self.failure_reason.lock().unwrap() = request.failure_reason;
            *self.active_input_delivery_ids.lock().unwrap() = request.active_input_delivery_ids;
        }

        async fn heartbeat(&self, _state: &HeartbeatState) {}

        async fn shutdown(&self) {}
    }

    struct SequencingProvider {
        timing: CompletionReportTiming,
        events: Arc<std::sync::Mutex<Vec<&'static str>>>,
        reports: Arc<AtomicUsize>,
        report_started: Arc<tokio::sync::Notify>,
        finalized: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl JobProvider for SequencingProvider {
        async fn discover(&self) -> Option<JobCandidate> {
            None
        }
        async fn claim(&self, _candidate: JobCandidate) -> Option<ClaimedJob> {
            None
        }
        async fn complete(&self, _request: CompleteRequest, _auth: CompletionAuth) {
            self.reports.fetch_add(1, Ordering::SeqCst);
            self.events.lock().unwrap().push("report_started");
            self.report_started.notify_one();
            if matches!(
                self.timing,
                CompletionReportTiming::ConcurrentWithFinalization
            ) {
                self.finalized.notified().await;
            }
            self.events.lock().unwrap().push("report_finished");
        }
        fn completion_report_timing(&self) -> CompletionReportTiming {
            self.timing
        }
        async fn heartbeat(&self, _state: &HeartbeatState) {}
        async fn shutdown(&self) {}
    }

    async fn assert_completion_order(timing: CompletionReportTiming) {
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let (budget, lease) = test_budget_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        status.add_run(run_id, sandbox_id).await.unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let reports = Arc::new(AtomicUsize::new(0));
        let provider = SequencingProvider {
            timing,
            events: Arc::clone(&events),
            reports: Arc::clone(&reports),
            report_started: Arc::new(tokio::sync::Notify::new()),
            finalized: Arc::new(tokio::sync::Notify::new()),
        };
        let finalize = async {
            events.lock().unwrap().push("finalize_started");
            if matches!(timing, CompletionReportTiming::ConcurrentWithFinalization) {
                provider.report_started.notified().await;
            }
            events.lock().unwrap().push("finalize_finished");
            provider.finalized.notify_one();
            FinalizationReady::new(BudgetOwnership::active(ActiveBudgetLease::new(lease)))
        };
        let payload = CompletionPayload::new(
            run_id,
            0,
            None,
            None,
            sandbox_id,
            SandboxReuseResult::PoolMiss,
            CompletionAuth::sandbox_token(run_id, "completion-token".to_owned()),
        );
        let (_report, ready) = tokio::time::timeout(
            Duration::from_secs(2),
            payload.report_with_finalization(&provider, finalize),
        )
        .await
        .expect("report/finalization ordering must not deadlock");
        assert_eq!(reports.load(Ordering::SeqCst), 1);
        assert_eq!(status_active_run_count(&status_path).await, 1);
        assert_eq!(
            budget.allocated().2,
            1,
            "report must precede active budget release"
        );
        let recorded = events.lock().unwrap().clone();
        match timing {
            CompletionReportTiming::ConcurrentWithFinalization => {
                assert_eq!(
                    recorded,
                    [
                        "report_started",
                        "finalize_started",
                        "finalize_finished",
                        "report_finished"
                    ]
                );
            }
            CompletionReportTiming::AfterFinalization => {
                assert_eq!(
                    recorded,
                    [
                        "finalize_started",
                        "finalize_finished",
                        "report_started",
                        "report_finished"
                    ]
                );
            }
        }
        let cleanup = RunCleanupState::new();
        ready
            .settle(
                RunSandbox::new(run_id, sandbox_id),
                &OwnershipTransitions::new(&status),
                &cleanup,
            )
            .await;
        assert_eq!(status_active_run_count(&status_path).await, 0);
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn completion_reports_concurrently_with_finalization_before_settlement() {
        assert_completion_order(CompletionReportTiming::ConcurrentWithFinalization).await;
    }

    #[tokio::test]
    async fn completion_reports_after_finalization_before_settlement() {
        assert_completion_order(CompletionReportTiming::AfterFinalization).await;
    }

    #[tokio::test]
    async fn completed_claimed_run_settles_after_reporting_and_records_release() {
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let (budget, lease) = test_budget_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        status.add_run(run_id, sandbox_id).await.unwrap();
        let active_runs = ActiveRuns::new(Arc::new(tokio::sync::Notify::new()));
        let active_run_guard =
            active_runs.register(run_id, Some("reuse-key".to_owned()), "test".to_owned());
        let reports = Arc::new(AtomicUsize::new(0));
        let provider = SequencingProvider {
            timing: CompletionReportTiming::AfterFinalization,
            events: Arc::new(std::sync::Mutex::new(Vec::new())),
            reports: Arc::clone(&reports),
            report_started: Arc::new(tokio::sync::Notify::new()),
            finalized: Arc::new(tokio::sync::Notify::new()),
        };
        let http = HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".into(),
            vercel_bypass: None,
            client_session_id: "completion-test".to_owned(),
            runner_version: env!("CARGO_PKG_VERSION"),
        })
        .unwrap();
        let telemetry = JobTelemetry::new(http, run_id, "completion-token".to_owned(), None);
        let finalized = async {
            FinalizedJob {
                finalization_ready: FinalizationReady::new(BudgetOwnership::active(
                    ActiveBudgetLease::new(lease),
                )),
                telemetry,
            }
        };
        let cleanup = RunCleanupState::new();
        let result = CompletionPayload::new(
            run_id,
            0,
            None,
            None,
            sandbox_id,
            SandboxReuseResult::PoolMiss,
            CompletionAuth::sandbox_token(run_id, "completion-token".to_owned()),
        )
        .complete_claimed_run(
            &provider,
            finalized,
            RunSandbox::new(run_id, sandbox_id),
            &status,
            active_run_guard,
            &cleanup,
        )
        .await;
        assert_eq!(reports.load(Ordering::SeqCst), 1);
        assert_eq!(status_active_run_count(&status_path).await, 0);
        assert_eq!(budget.allocated().2, 0);
        assert!(!active_runs.contains(run_id));
        assert_eq!(cleanup.disposition(), RunCleanupDisposition::StatusRemoved);
        let ops = result.pending_ops_snapshot();
        assert!(
            ops.iter()
                .any(|op| op.0 == "runner_host_completion_fallback")
        );
        assert!(
            ops.iter()
                .any(|op| op.0 == "runner_active_reuse_key_released")
        );
    }

    #[tokio::test]
    async fn panic_recovery_keeps_unknown_active_run_and_orphan_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await.unwrap();
        let idle_pool: SharedIdlePool = Arc::new(tokio::sync::Mutex::new(
            runner_lifecycle::idle_pool::IdlePool::new(
                runner_lifecycle::idle_pool::IdlePoolConfig { max_idle: 2 },
            ),
        ));
        let orphans = OrphanedActiveRuns::new();
        recover_panicked_run(
            RunSandbox::new(run_id, sandbox_id),
            &status,
            &idle_pool,
            &RunCleanupState::new(),
            &orphans,
        )
        .await;
        assert_eq!(status_active_run_count(&status_path).await, 1);
        assert_eq!(orphans.len(), 1);
    }

    #[tokio::test]
    async fn finalization_ready_settles_active_status_and_budget() {
        let (budget, lease) = test_budget_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await.unwrap();

        FinalizationReady::new(BudgetOwnership::active(ActiveBudgetLease::new(lease)))
            .settle(
                RunSandbox::new(run_id, sandbox_id),
                &ownership,
                &cleanup_state,
            )
            .await;

        assert_eq!(
            status_active_run_count(&status_path).await,
            0,
            "active status removal should complete before active budget release returns",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn completion_payload_forwards_completion_auth() {
        let auth_matches = Arc::new(AtomicBool::new(false));
        let active_input_delivery_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
        let failure_reason = Arc::new(std::sync::Mutex::new(None));
        let provider = CompletionAuthProvider {
            auth_matches: Arc::clone(&auth_matches),
            active_input_delivery_ids: Arc::clone(&active_input_delivery_ids),
            failure_reason: Arc::clone(&failure_reason),
        };
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();

        let _ = CompletionPayload::new(
            run_id,
            1,
            Some(RequestFailureReason::InputTooLarge),
            Some("Codex input exceeded the app-server limit".to_string()),
            sandbox_id,
            SandboxReuseResult::PoolMiss,
            CompletionAuth::sandbox_token(run_id, "completion-token".to_string()),
        )
        .with_active_input_delivery_ids(vec!["b1e2ad6d-930a-4d51-aa40-7952d54f978b".to_string()])
        .report(&provider)
        .await;

        assert!(
            auth_matches.load(Ordering::SeqCst),
            "completion payload auth must be forwarded to provider.complete"
        );
        assert_eq!(
            *active_input_delivery_ids.lock().unwrap(),
            vec!["b1e2ad6d-930a-4d51-aa40-7952d54f978b".to_string()]
        );
        assert_eq!(
            *failure_reason.lock().unwrap(),
            Some(RequestFailureReason::InputTooLarge)
        );
    }

    #[tokio::test]
    async fn finalization_ready_idle_owned_does_not_release_idle_park_budget() {
        let (budget, lease) = test_budget_lease();
        let idle_park_lease = ActiveBudgetLease::new(lease).into_idle_park_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await.unwrap();

        FinalizationReady::new(BudgetOwnership::idle_owned())
            .settle(
                RunSandbox::new(run_id, sandbox_id),
                &ownership,
                &cleanup_state,
            )
            .await;

        assert_eq!(
            budget.allocated().2,
            1,
            "idle-owned completion must not release the park candidate budget",
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        drop(idle_park_lease);
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn finalization_ready_does_not_remove_reinserted_active_run() {
        let (budget, lease) = test_budget_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let completed_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, completed_sandbox_id).await.unwrap();
        status.add_run(run_id, current_sandbox_id).await.unwrap();

        FinalizationReady::new(BudgetOwnership::active(ActiveBudgetLease::new(lease)))
            .settle(
                RunSandbox::new(run_id, completed_sandbox_id),
                &ownership,
                &cleanup_state,
            )
            .await;

        assert_eq!(
            status_active_run_records(&status_path).await,
            vec![(run_id.to_string(), current_sandbox_id.to_string())],
        );
        assert_eq!(
            cleanup_state.disposition(),
            RunCleanupDisposition::StatusRemoved,
        );
        assert_eq!(budget.allocated().2, 0);
    }

    #[tokio::test]
    async fn rejected_park_budget_is_recovered_as_active_and_released_after_settlement() {
        let (budget, lease) = test_budget_lease();
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let ownership = OwnershipTransitions::new(&status);
        let cleanup_state = RunCleanupState::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await.unwrap();

        FinalizationReady::new(BudgetOwnership::active(
            ActiveBudgetLease::from_idle_park_lease(lease),
        ))
        .settle(
            RunSandbox::new(run_id, sandbox_id),
            &ownership,
            &cleanup_state,
        )
        .await;

        assert_eq!(budget.allocated().2, 0);
    }

    #[test]
    fn active_budget_drop_releases_budget_as_raii_fallback() {
        let (budget, lease) = test_budget_lease();
        drop(ActiveBudgetLease::new(lease));
        assert_eq!(budget.allocated().2, 0);
    }

    #[test]
    fn run_cleanup_state_does_not_downgrade_precise_ownership() {
        let state = RunCleanupState::new();

        state.mark_idle_pool_owned();
        state.mark_destroy_completed();
        assert_eq!(state.disposition(), RunCleanupDisposition::IdlePoolOwned);

        state.mark_status_removed();
        state.mark_idle_pool_owned();
        assert_eq!(state.disposition(), RunCleanupDisposition::StatusRemoved);
    }

    #[test]
    fn run_cleanup_state_tracks_direct_handoff_ownership() {
        let state = RunCleanupState::new();

        state.mark_handoff_owned();
        assert_eq!(state.disposition(), RunCleanupDisposition::HandoffOwned);

        state.mark_destroy_completed();
        assert_eq!(state.disposition(), RunCleanupDisposition::HandoffOwned);
    }
}
