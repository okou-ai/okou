use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason;
use chrono::{DateTime, Utc};
use sandbox::SandboxId;

use crate::resource_budget::BudgetLease;
use runner_provider::{CompletionAuth, JobProvider};
use runner_types::ids::RunId;
use runner_types::types::{CompleteRequest, SandboxReuseResult, WorkspaceReuseResult};

use super::ownership::{OwnershipTransitions, RunSandbox};

/// Ownership facts known by the outer runner task for panic cleanup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RunCleanupDisposition {
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
pub(super) struct RunCleanupState {
    state: Arc<AtomicU8>,
}

impl RunCleanupState {
    const ACTIVE_OR_UNKNOWN: u8 = 0;
    const DESTROY_COMPLETED: u8 = 1;
    const IDLE_POOL_OWNED: u8 = 2;
    const HANDOFF_OWNED: u8 = 3;
    const STATUS_REMOVED: u8 = 4;

    pub(super) fn new() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(Self::ACTIVE_OR_UNKNOWN)),
        }
    }

    pub(super) fn disposition(&self) -> RunCleanupDisposition {
        match self.state.load(Ordering::Acquire) {
            Self::STATUS_REMOVED => RunCleanupDisposition::StatusRemoved,
            Self::IDLE_POOL_OWNED => RunCleanupDisposition::IdlePoolOwned,
            Self::HANDOFF_OWNED => RunCleanupDisposition::HandoffOwned,
            Self::DESTROY_COMPLETED => RunCleanupDisposition::DestroyCompleted,
            _ => RunCleanupDisposition::ActiveOrUnknown,
        }
    }

    pub(super) fn mark_idle_pool_owned(&self) {
        self.mark_at_least(Self::IDLE_POOL_OWNED);
    }

    pub(super) fn mark_destroy_completed(&self) {
        self.mark_at_least(Self::DESTROY_COMPLETED);
    }

    pub(super) fn mark_handoff_owned(&self) {
        self.mark_at_least(Self::HANDOFF_OWNED);
    }

    pub(super) fn mark_status_removed(&self) {
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
pub(super) struct ActiveBudgetLease(BudgetLease);

impl ActiveBudgetLease {
    pub(super) fn new(lease: BudgetLease) -> Self {
        Self(lease)
    }

    pub(super) fn into_idle_park_lease(self) -> BudgetLease {
        self.0
    }

    pub(super) fn from_idle_park_lease(lease: BudgetLease) -> Self {
        Self(lease)
    }
}

/// Budget ownership after sandbox finalization but before runner-local settlement.
///
/// This distinguishes a lease that settlement must release from one already
/// transferred to an accepted idle-pool entry.
#[must_use]
pub(super) enum BudgetOwnership {
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
    pub(super) fn active(lease: ActiveBudgetLease) -> Self {
        Self::Active(lease)
    }

    pub(super) fn idle_owned() -> Self {
        Self::IdleOwned
    }

    pub(super) fn handoff_owned() -> Self {
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
pub(super) struct CompletionPayload {
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
pub(super) struct CompletionReportObservation {
    duration: Duration,
    completed_at: DateTime<Utc>,
}

impl CompletionReportObservation {
    pub(super) fn record(self, telemetry: &mut crate::telemetry::JobTelemetry) {
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
    pub(super) fn new(
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

    pub(super) fn with_workspace_reuse_result(
        mut self,
        workspace_reuse_result: Option<WorkspaceReuseResult>,
    ) -> Self {
        self.workspace_reuse_result = workspace_reuse_result;
        self
    }

    pub(super) fn with_active_input_delivery_ids(
        mut self,
        active_input_delivery_ids: Vec<String>,
    ) -> Self {
        self.active_input_delivery_ids = active_input_delivery_ids;
        self
    }

    pub(super) async fn report(self, provider: &dyn JobProvider) -> CompletionReportObservation {
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
pub(super) struct FinalizationReady {
    budget: BudgetOwnership,
    reuse_state_changed: bool,
}

impl FinalizationReady {
    pub(super) fn new(budget: BudgetOwnership) -> Self {
        Self {
            budget,
            reuse_state_changed: false,
        }
    }

    pub(super) fn with_reuse_state_changed(mut self) -> Self {
        self.reuse_state_changed = true;
        self
    }

    pub(super) fn reuse_state_changed(&self) -> bool {
        self.reuse_state_changed
    }

    pub(super) async fn settle(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use async_trait::async_trait;
    use sandbox::SandboxId;

    use crate::resource_budget::{BudgetLease, ResourceBudget};
    use crate::status::StatusTracker;
    use runner_provider::{ClaimedJob, JobCandidate, JobProvider};
    use runner_types::ids::RunId;
    use runner_types::types::{HeartbeatState, SandboxReuseResult};

    use super::super::ownership::OwnershipTransitions;

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
