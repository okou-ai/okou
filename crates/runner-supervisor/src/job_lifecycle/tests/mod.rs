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
use runner_types::types::HeartbeatState;

use crate::idle_lifecycle::SharedIdlePool;
use crate::orphan_reap::OrphanedActiveRuns;
use crate::ownership::OwnershipTransitions;

#[test]
fn completion_reason_uses_diagnostic_for_generic_failure() {
    for (framework, reason, expected) in [
        (
            AgentFramework::ClaudeCode,
            FailureReason::UsageLimit,
            RequestFailureReason::UsageLimit,
        ),
        (
            AgentFramework::Codex,
            FailureReason::UnsupportedModel,
            RequestFailureReason::UnsupportedModel,
        ),
    ] {
        let diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            framework,
            PromptMetadata::from_prompt("plain prompt"),
        )
        .with_failure_reason(reason);
        let failure = executor::ExecutionFailure::new(1, reason.as_str(), Some(diagnostic));

        assert_eq!(
            completion_failure_reason(1, false, Some(&failure)),
            Some(expected)
        );
    }
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
        let failure = executor::ExecutionFailure::new(1, "Agent exited with code 1", diagnostic)
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
    }

    async fn heartbeat(&self, _state: &HeartbeatState) -> runner_provider::ProviderResult<()> {
        Ok(())
    }

    async fn shutdown(&self) {}
}

struct SequencingProvider {
    timing: CompletionReportTiming,
    events: Arc<std::sync::Mutex<Vec<&'static str>>>,
    reports: Arc<AtomicUsize>,
    report_started: Arc<tokio::sync::Notify>,
    finalized: Arc<tokio::sync::Notify>,
    report_release: Option<Arc<tokio::sync::Notify>>,
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
        if let Some(release) = &self.report_release {
            release.notified().await;
        }
        self.events.lock().unwrap().push("report_finished");
    }
    fn completion_report_timing(&self) -> CompletionReportTiming {
        self.timing
    }
    async fn heartbeat(&self, _state: &HeartbeatState) -> runner_provider::ProviderResult<()> {
        Ok(())
    }
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
        report_release: None,
    };
    let finalize = || {
        events.lock().unwrap().push("finalize_constructed");
        async {
            events.lock().unwrap().push("finalize_started");
            if matches!(timing, CompletionReportTiming::ConcurrentWithFinalization) {
                provider.report_started.notified().await;
            }
            events.lock().unwrap().push("finalize_finished");
            provider.finalized.notify_one();
            FinalizationReady::new(BudgetOwnership::active(ActiveBudgetLease::new(lease)))
        }
    };
    let payload = CompletionPayload::new(
        run_id,
        0,
        None,
        None,
        sandbox_id,
        CompletionAuth::sandbox_token(run_id, "completion-token".to_owned()),
    );
    let completion = payload.report_with_finalization(&provider, finalize);
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(status_active_run_count(&status_path).await, 1);
    let (_report, ready) = tokio::time::timeout(Duration::from_secs(2), completion)
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
    assert_eq!(recorded[0], "finalize_constructed");
    match timing {
        CompletionReportTiming::ConcurrentWithFinalization => {
            assert_eq!(recorded.len(), 5);
            let position = |event| {
                recorded
                    .iter()
                    .position(|recorded| *recorded == event)
                    .unwrap()
            };
            assert!(position("report_started") < position("finalize_finished"));
            assert!(position("finalize_started") < position("report_finished"));
            assert!(position("finalize_finished") < position("report_finished"));
        }
        CompletionReportTiming::AfterFinalization => {
            assert_eq!(
                recorded,
                [
                    "finalize_constructed",
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
        report_release: Some(Arc::new(tokio::sync::Notify::new())),
    };
    let http = HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".into(),
        vercel_bypass: None,
        client_session_id: "completion-test".to_owned(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let telemetry = JobTelemetry::new(http, run_id, "completion-token".to_owned(), None);
    let finalized = move || async move {
        FinalizedJob {
            finalization_ready: FinalizationReady::new(BudgetOwnership::active(
                ActiveBudgetLease::new(lease),
            )),
            telemetry,
        }
    };
    let cleanup = RunCleanupState::new();
    let completion = CompletionPayload::new(
        run_id,
        0,
        None,
        None,
        sandbox_id,
        CompletionAuth::sandbox_token(run_id, "completion-token".to_owned()),
    )
    .complete_claimed_run(&provider, finalized, &status, active_run_guard, &cleanup);
    tokio::pin!(completion);
    tokio::time::timeout(Duration::from_secs(2), async {
        tokio::select! {
            _ = completion.as_mut() => panic!("completion must await provider reporting"),
            _ = provider.report_started.notified() => {}
        }
    })
    .await
    .expect("finalization must reach provider reporting");
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(status_active_run_count(&status_path).await, 1);
    assert!(active_runs.contains(run_id));
    assert_eq!(
        cleanup.disposition(),
        RunCleanupDisposition::ActiveOrUnknown
    );
    provider.report_release.as_ref().unwrap().notify_one();
    let result = completion.await;
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

async fn assert_dropped_completion_keeps_recovery_status(poll_finalization: bool) {
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
        report_release: None,
    };
    let http = HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".into(),
        vercel_bypass: None,
        client_session_id: "completion-drop-test".to_owned(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let telemetry = JobTelemetry::new(http, run_id, "completion-token".to_owned(), None);
    let constructions = Arc::new(AtomicUsize::new(0));
    let construction_count = Arc::clone(&constructions);
    let entered = Arc::new(tokio::sync::Notify::new());
    let finalizer_entered = Arc::clone(&entered);
    let make_finalization = move || {
        construction_count.fetch_add(1, Ordering::SeqCst);
        async move {
            let ready =
                FinalizationReady::new(BudgetOwnership::active(ActiveBudgetLease::new(lease)));
            finalizer_entered.notify_one();
            std::future::pending::<()>().await;
            FinalizedJob {
                finalization_ready: ready,
                telemetry,
            }
        }
    };
    let cleanup = RunCleanupState::new();
    {
        let completion = CompletionPayload::new(
            run_id,
            0,
            None,
            None,
            sandbox_id,
            CompletionAuth::sandbox_token(run_id, "completion-token".to_owned()),
        )
        .complete_claimed_run(
            &provider,
            make_finalization,
            &status,
            active_run_guard,
            &cleanup,
        );
        tokio::pin!(completion);
        assert_eq!(constructions.load(Ordering::SeqCst), 0);
        if poll_finalization {
            tokio::time::timeout(Duration::from_secs(2), async {
                tokio::select! {
                    _ = completion.as_mut() => panic!("finalization must remain pending"),
                    _ = entered.notified() => {}
                }
            })
            .await
            .expect("finalization must start when completion is polled");
        }
        assert_eq!(budget.allocated().2, 1);
        assert_eq!(status_active_run_count(&status_path).await, 1);
        assert!(active_runs.contains(run_id));
    }
    assert_eq!(
        constructions.load(Ordering::SeqCst),
        usize::from(poll_finalization)
    );
    assert_eq!(reports.load(Ordering::SeqCst), 0);
    assert_eq!(budget.allocated().2, 0);
    assert!(!active_runs.contains(run_id));
    assert_eq!(status_active_run_count(&status_path).await, 1);
    assert_eq!(
        cleanup.disposition(),
        RunCleanupDisposition::ActiveOrUnknown
    );
}

#[tokio::test]
async fn unpolled_completion_drops_inputs_without_finalizing_or_clearing_recovery_status() {
    assert_dropped_completion_keeps_recovery_status(false).await;
}

#[tokio::test]
async fn pending_completion_drops_finalizer_without_clearing_recovery_status() {
    assert_dropped_completion_keeps_recovery_status(true).await;
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
        runner_lifecycle::idle_pool::IdlePool::new(runner_lifecycle::idle_pool::IdlePoolConfig {
            max_idle: 2,
        }),
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
    let failure_reason = Arc::new(std::sync::Mutex::new(None));
    let provider = CompletionAuthProvider {
        auth_matches: Arc::clone(&auth_matches),
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
        CompletionAuth::sandbox_token(run_id, "completion-token".to_string()),
    )
    .report(&provider)
    .await;

    assert!(
        auth_matches.load(Ordering::SeqCst),
        "completion payload auth must be forwarded to provider.complete"
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
