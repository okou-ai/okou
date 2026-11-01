use super::*;
use std::sync::Arc;
use std::time::Duration;

use sandbox::SandboxId;

use crate::http::{HttpClient, HttpClientConfig};
use crate::idle_lifecycle::SharedIdlePool;
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult,
    test_support::ParkedIdleCandidateBuilder,
};
use crate::idle_reuse_preparation::mock_sandbox_ready_for_idle_reuse;
use crate::job_lifecycle::{RunCleanupDisposition, RunCleanupState};
use crate::orphan_reap::OrphanedActiveRuns;
use crate::resource_budget::ResourceBudget;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::status::StatusTracker;
use runner_lifecycle::active_runs::ActiveRuns;
use runner_provider::RunCancellationRegistry;
use runner_types::ids::RunId;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

fn test_http_client() -> HttpClient {
    HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".into(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap()
}

fn test_budget_lease() -> (Arc<ResourceBudget>, BudgetLease) {
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    (budget, lease)
}

fn assert_telemetry_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|op| op.0 == action && op.1),
        "expected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_failed_telemetry_action(telemetry: &JobTelemetry, action: &str, error: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter()
            .any(|op| op.0 == action && !op.1 && op.2.as_deref() == Some(error)),
        "expected failed telemetry action {action} with {error}, got: {ops:?}"
    );
}

fn assert_no_telemetry_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().all(|op| op.0 != action),
        "unexpected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_telemetry_outcome(telemetry: &JobTelemetry, action: &str, outcome: Option<&str>) {
    let outcomes = telemetry.pending_ops_with_outcome_snapshot();
    assert!(
        outcomes
            .iter()
            .any(|op| op.0 == action && op.2.as_deref() == outcome),
        "expected telemetry action {action} with outcome {outcome:?}, got: {outcomes:?}"
    );
}

struct FinalizationTelemetryFixture {
    _dir: tempfile::TempDir,
    status: Arc<StatusTracker>,
    idle_pool: SharedIdlePool,
    parking_gate: ParkingGate,
    reuse_state_notify: Arc<tokio::sync::Notify>,
    active_runs: ActiveRuns,
    active_run_guards: std::sync::Mutex<Vec<ActiveRunGuard>>,
}

impl FinalizationTelemetryFixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let status = Arc::new(StatusTracker::new(
            dir.path().join("status.json"),
            4,
            None,
            None,
        ));
        status.write_initial().await.unwrap();
        let parking_gate = ParkingGate::new_open();
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new_with_parking_gate(
            IdlePoolConfig { max_idle: 10 },
            parking_gate.clone(),
        )));

        let reuse_state_notify = Arc::new(tokio::sync::Notify::new());
        let active_runs = ActiveRuns::new(Arc::clone(&reuse_state_notify));
        Self {
            _dir: dir,
            status,
            idle_pool,
            parking_gate,
            reuse_state_notify,
            active_runs,
            active_run_guards: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn finalization_phase(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        session_id: &str,
        active_lease: BudgetLease,
        cleanup_state: RunCleanupState,
    ) -> FinalizationPhase {
        let active_run_guard =
            self.active_runs
                .register(run_id, Some(session_id.into()), "vm0/default".into());
        let active_run_reuse = active_run_guard.reuse_publisher();
        self.active_run_guards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(active_run_guard);
        FinalizationPhase {
            active_sandbox: ActiveSandboxIdentity::new(sandbox_id),
            orphaned_active_runs: OrphanedActiveRuns::new(),
            run_id,
            runner_id: "runner-test".into(),
            active_lease,
            reuse_result: SandboxReuseResult::PoolMiss,
            home_disk_mb: 0,
            profile_name: "vm0/default".into(),
            rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            reuse_key: Some(session_id.into()),
            cli_agent_session_id: Some(session_id.into()),
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            device_rate_limits: None,
            factory: Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
            idle_pool: Arc::clone(&self.idle_pool),
            idle_destroy_tracker: IdleDestroyTracker::new(Arc::clone(&self.reuse_state_notify)),
            status: Arc::clone(&self.status),
            reuse_state_notify: Arc::clone(&self.reuse_state_notify),
            home_cache_snapshot: HomeCacheStateSnapshot::new(),
            parking_gate: self.parking_gate.clone(),
            network_log_drain: NetworkLogDrainCoordinator::noop(),
            cancel: RunCancellationHandle::new(),
            cleanup_state,
            active_run_reuse,
            outer_job_panic: None,
            test_observer: StartLoopTestObserver::default(),
        }
    }
}

fn executor_phase_outcome(
    run_id: RunId,
    sandbox_name: &str,
    restored_session_identity: Option<RestoredSessionIdentity>,
) -> ExecutorPhaseOutcome {
    executor_phase_outcome_with_sandbox(
        run_id,
        Box::new(mock_sandbox_ready_for_idle_reuse(sandbox_name)),
        restored_session_identity,
    )
}

fn executor_phase_outcome_with_sandbox(
    run_id: RunId,
    sandbox: Box<dyn sandbox::Sandbox>,
    restored_session_identity: Option<RestoredSessionIdentity>,
) -> ExecutorPhaseOutcome {
    ExecutorPhaseOutcome {
        outcome: executor::ExecuteOutcome {
            failure: None,
            storage_fingerprints: StorageFingerprints::default(),
            sandbox_reuse_disposition: executor::SandboxReuseDisposition::Eligible(
                executor::SandboxReuseTerminal::Success,
            ),
            sandbox: Some(sandbox),
            source_ip: "10.0.0.1".into(),
            network_log_session: None,
            home_image: None,
            home_reuse_result: None,
            startup_report: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity,
        },
        exit_code: 0,
        err: None,
        telemetry: JobTelemetry::new(test_http_client(), run_id, "sandbox-token".into(), None),
    }
}

fn executor_phase_outcome_without_sandbox(run_id: RunId) -> ExecutorPhaseOutcome {
    ExecutorPhaseOutcome {
        outcome: executor::ExecuteOutcome {
            failure: None,
            storage_fingerprints: StorageFingerprints::default(),
            sandbox_reuse_disposition: executor::SandboxReuseDisposition::default(),
            sandbox: None,
            source_ip: String::new(),
            network_log_session: None,
            home_image: None,
            home_reuse_result: None,
            startup_report: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
        },
        exit_code: 1,
        err: Some("sandbox unavailable".into()),
        telemetry: JobTelemetry::new(test_http_client(), run_id, "sandbox-token".into(), None),
    }
}

#[test]
fn generic_zero_exit_code_normalizes_to_generic_failure() {
    let failure = executor::ExecutionFailure::new(0, "", None);

    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, "Agent exited with code 1");
    assert_eq!(failure.kind, executor::ExecutionFailureKind::Generic);
}

#[test]
fn runner_job_timeout_zero_exit_code_normalizes_to_timeout_failure() {
    let failure = executor::ExecutionFailure::runner_job_timeout(
        0,
        "",
        None,
        Duration::from_secs(7200),
        Duration::from_secs(7201),
        None,
    );

    assert_eq!(failure.exit_code, 124);
    assert_eq!(failure.error, "Agent exited with code 124");
    match failure.kind {
        executor::ExecutionFailureKind::RunnerJobTimeout {
            timeout_ms,
            elapsed_ms,
            guest_duration_ms,
        } => {
            assert_eq!(timeout_ms, 7_200_000);
            assert_eq!(elapsed_ms, 7_201_000);
            assert_eq!(guest_duration_ms, None);
        }
        executor::ExecutionFailureKind::Generic => {
            panic!("expected runner job timeout failure kind")
        }
    }
}

#[tokio::test]
async fn finalization_records_identity_parked_when_idle_pool_receives_restored_identity() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let identity = RestoredSessionIdentity::claude_code_for_test("history-hash-a");
    let finalization = fixture.finalization_phase(
        run_id,
        sandbox_id,
        "thread:restore-plan",
        lease,
        cleanup_state.clone(),
    );

    let finalized = finalization
        .finalize(executor_phase_outcome(
            run_id,
            "identity-parked",
            Some(identity.clone()),
        ))
        .await;

    assert_telemetry_action(
        &finalized.telemetry,
        "runner_host_finalization_reusable_sandbox",
    );
    assert_telemetry_action(
        &finalized.telemetry,
        "runner_terminal_sandbox_reuse_eligible_success",
    );
    for action in [
        "runner_host_finalization_started",
        "runner_host_reuse_preparation",
        "runner_host_physical_park",
        "runner_host_idle_publication",
        "runner_host_physical_park_balloon_setup",
        "runner_host_physical_park_balloon_settle",
        "runner_host_physical_park_vcpu_pause",
    ] {
        assert_telemetry_action(&finalized.telemetry, action);
    }
    assert_telemetry_outcome(
        &finalized.telemetry,
        "runner_host_physical_park_balloon_setup",
        Some("skipped"),
    );
    assert_telemetry_outcome(
        &finalized.telemetry,
        "runner_host_physical_park_balloon_settle",
        Some("skipped"),
    );
    assert_telemetry_outcome(
        &finalized.telemetry,
        "runner_host_physical_park_vcpu_pause",
        None,
    );
    assert_telemetry_action(&finalized.telemetry, "session_history_identity_parked");
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );
    let entry = fixture
        .idle_pool
        .lock()
        .await
        .take("thread:restore-plan")
        .expect("parked sandbox should be in idle pool");
    let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark_for_run(RunId::new_v4()).await
    else {
        panic!("parked sandbox should unpark");
    };
    assert_eq!(sandbox.restored_session_identity(), Some(&identity));
}

#[tokio::test]
async fn cooperative_cancellation_reuse_does_not_record_hard_cancellation_marker() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let session_id = "sess-cooperative-cancellation";
    let cleanup_state = RunCleanupState::new();
    let finalization =
        fixture.finalization_phase(run_id, sandbox_id, session_id, lease, cleanup_state.clone());
    finalization
        .cancel
        .request_cooperative_user_cancellation()
        .await;
    let mut executor_result = executor_phase_outcome(run_id, "cooperative-cancellation", None);
    executor_result.outcome.sandbox_reuse_disposition = executor::SandboxReuseDisposition::Eligible(
        executor::SandboxReuseTerminal::CooperativeCancellation,
    );

    let finalized = finalization.finalize(executor_result).await;

    assert_telemetry_action(
        &finalized.telemetry,
        "runner_host_finalization_reusable_sandbox",
    );
    assert_telemetry_action(
        &finalized.telemetry,
        "runner_terminal_sandbox_reuse_eligible_cooperative_cancellation",
    );
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_finalization_cancelled");
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );
    assert!(fixture.idle_pool.lock().await.take(session_id).is_some());
}

#[tokio::test]
async fn hard_cancellation_records_finalization_cancellation_marker() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let finalization = fixture.finalization_phase(
        run_id,
        sandbox_id,
        "sess-hard-cancellation",
        lease,
        cleanup_state.clone(),
    );
    finalization.cancel.request_hard_cancellation().await;
    let mut executor_result = executor_phase_outcome(run_id, "hard-cancellation", None);
    executor_result.outcome.sandbox_reuse_disposition =
        executor::SandboxReuseDisposition::Ineligible(
            executor::SandboxReuseRejection::HardCancellation,
        );

    let finalized = finalization.finalize(executor_result).await;

    assert_failed_telemetry_action(
        &finalized.telemetry,
        "runner_host_finalization_cancelled",
        "cancelled",
    );
    assert_telemetry_action(
        &finalized.telemetry,
        "runner_terminal_sandbox_reuse_rejected_hard_cancellation",
    );
    assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_reuse_preparation");
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_physical_park");
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::DestroyCompleted,
    );
}

#[tokio::test]
async fn finalization_records_identity_park_missing_when_parked_without_restored_identity() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let session_id = "sess-park-missing";
    let finalization =
        fixture.finalization_phase(run_id, sandbox_id, session_id, lease, cleanup_state.clone());

    let finalized = finalization
        .finalize(executor_phase_outcome(
            run_id,
            "identity-park-missing",
            None,
        ))
        .await;

    assert_telemetry_action(
        &finalized.telemetry,
        "session_history_identity_park_missing",
    );
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::IdlePoolOwned,
    );
    let entry = fixture
        .idle_pool
        .lock()
        .await
        .take(session_id)
        .expect("parked sandbox should be in idle pool");
    let IdleUnparkResult::Reused { sandbox, .. } = entry.try_unpark_for_run(RunId::new_v4()).await
    else {
        panic!("parked sandbox should unpark");
    };
    assert!(sandbox.restored_session_identity().is_none());
}

#[tokio::test]
async fn finalization_delivers_requested_exact_handoff_without_idle_publication() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let successor_run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = "thread:direct-finalization-handoff";
    let cleanup_state = RunCleanupState::new();
    let finalization =
        fixture.finalization_phase(run_id, sandbox_id, reuse_key, lease, cleanup_state.clone());
    let proof = fixture
        .active_runs
        .finalizing_predecessor(run_id, reuse_key, "vm0/default")
        .expect("registered predecessor should be available");
    let mut handoff = proof
        .request_handoff(successor_run_id)
        .expect("exact successor should register one handoff");

    let outcome = executor_phase_outcome(run_id, "direct-handoff", None);

    let local = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(local.clone()));
    let finalized = finalization.finalize(outcome).await;
    drop(guard);

    assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
    assert_eq!(
        cleanup_state.disposition(),
        RunCleanupDisposition::HandoffOwned
    );
    assert_eq!(fixture.idle_pool.lock().await.len(), 0);
    assert!(handoff.accepted().await);
    let facts = finalized.telemetry.pending_home_snapshot();
    assert_eq!(facts.len(), 1);
    assert_eq!(
        facts[0].kind,
        runner_host::home_observation::HomeObservationKind::Preservation,
    );
    assert_eq!(
        facts[0].outcome,
        runner_host::home_observation::HomeObservationOutcome::Retained,
    );
    assert_eq!(facts[0].run_id, Some(run_id));
    assert_eq!(facts[0].reuse_key.as_deref(), Some(reuse_key));
    assert_eq!(facts[0].reason.as_deref(), Some("exact_handoff"));
    assert_eq!(facts[0].handoff_path.as_deref(), Some("after_full_park"));
    assert!(facts[0].image_generation.is_none());
    let local_facts: Vec<_> = local
        .entries()
        .into_iter()
        .filter(|event| {
            event.fields.get("op_type").map(String::as_str) == Some("runner_home_preservation")
        })
        .collect();
    assert_eq!(local_facts.len(), 1);
    assert_eq!(local_facts[0].fields["run_id"], run_id.to_string());
    assert_eq!(local_facts[0].fields["outcome"], "retained");
    assert_eq!(local_facts[0].fields["handoff_path"], "after_full_park");
    let candidate = handoff
        .receive()
        .await
        .expect("accepted exact handoff should deliver its sandbox");
    candidate
        .into_destroy_job()
        .run_with_context("test_direct_handoff_cleanup")
        .await;
}

#[tokio::test]
async fn finalization_records_no_resource_when_execution_has_no_sandbox() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let finalization = fixture.finalization_phase(
        run_id,
        sandbox_id,
        "sess-no-sandbox",
        lease,
        RunCleanupState::new(),
    );

    let finalized = finalization
        .finalize(executor_phase_outcome_without_sandbox(run_id))
        .await;

    assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
}

#[tokio::test]
async fn finalization_records_reuse_preparation_failure_without_physical_park() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let sandbox = sandbox_mock::MockSandbox::new("reuse-preparation-failed");
    sandbox.push_exec_result(Err(sandbox::SandboxError::Operation {
        operation: sandbox::SandboxOperation::Exec,
        reason: sandbox::SandboxOperationReason::Guest,
        message: "reuse preparation disconnected".into(),
    }));
    let finalization = fixture.finalization_phase(
        run_id,
        sandbox_id,
        "sess-reuse-preparation-failed",
        lease,
        cleanup_state,
    );

    let finalized = finalization
        .finalize(executor_phase_outcome_with_sandbox(
            run_id,
            Box::new(sandbox),
            None,
        ))
        .await;

    assert_failed_telemetry_action(
        &finalized.telemetry,
        "runner_host_reuse_preparation",
        "reuse preparation failed",
    );
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_physical_park");
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
    assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
}

#[tokio::test]
async fn finalization_records_physical_park_failure_after_reuse_preparation() {
    let fixture = FinalizationTelemetryFixture::new().await;
    let (_budget, lease) = test_budget_lease();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let cleanup_state = RunCleanupState::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Park,
        message: "physical park failed".into(),
    }));
    let finalization = fixture.finalization_phase(
        run_id,
        sandbox_id,
        "sess-physical-park-failed",
        lease,
        cleanup_state,
    );

    let finalized = finalization
        .finalize(executor_phase_outcome_with_sandbox(
            run_id,
            Box::new(sandbox_mock::MockSandbox::with_overrides(
                "physical-park-failed",
                overrides,
            )),
            None,
        ))
        .await;

    assert_telemetry_action(&finalized.telemetry, "runner_host_reuse_preparation");
    assert_failed_telemetry_action(
        &finalized.telemetry,
        "runner_host_physical_park",
        "physical park failed",
    );
    assert_no_telemetry_action(&finalized.telemetry, "runner_host_idle_publication");
    assert_telemetry_action(&finalized.telemetry, "runner_host_finalization_no_resource");
}

async fn status_idle_reuse_keys_and_active_runs(
    status_path: &std::path::Path,
) -> (Vec<String>, Vec<String>) {
    let raw = tokio::fs::read_to_string(status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let mut reuse_keys: Vec<String> = status
        .get("idle_sandboxes")
        .and_then(|v| v.as_array())
        .map(|idle_sandboxes| {
            idle_sandboxes
                .iter()
                .filter_map(|sandbox| {
                    sandbox
                        .get("reuse_key")
                        .and_then(|reuse_key| reuse_key.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    reuse_keys.sort_unstable();
    let mut run_ids: Vec<String> = status["active_runs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|run| {
            run.get("run_id")
                .and_then(|run_id| run_id.as_str())
                .map(str::to_string)
        })
        .collect();
    run_ids.sort_unstable();
    (reuse_keys, run_ids)
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

struct CleanupPanickedJobFixture {
    status_path: std::path::PathBuf,
    status: Arc<StatusTracker>,
    idle_pool: SharedIdlePool,
    tokens: RunCancellationRegistry,
    orphans: OrphanedActiveRuns,
    _dir: tempfile::TempDir,
}

impl CleanupPanickedJobFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = Arc::new(StatusTracker::new(status_path.clone(), 4, None, None));
        let idle_pool: SharedIdlePool =
            Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                max_idle: 10,
            })));
        let tokens = RunCancellationRegistry::new();
        let orphans = OrphanedActiveRuns::new();

        Self {
            status_path,
            status,
            idle_pool,
            tokens,
            orphans,
            _dir: dir,
        }
    }

    async fn cleanup(&self, run_id: RunId, sandbox_id: SandboxId, cleanup_state: RunCleanupState) {
        let cancellation = self.tokens.register(run_id).await.unwrap();
        self.cleanup_with_registration(run_id, sandbox_id, cleanup_state, cancellation)
            .await;
    }

    async fn cleanup_with_registration(
        &self,
        run_id: RunId,
        sandbox_id: SandboxId,
        cleanup_state: RunCleanupState,
        cancellation: RunCancellationRegistration,
    ) {
        cleanup_panicked_job(
            run_id,
            sandbox_id,
            cancellation,
            Arc::clone(&self.status),
            Arc::clone(&self.idle_pool),
            cleanup_state,
            self.orphans.clone(),
        )
        .await;
    }
}

#[tokio::test]
async fn panic_cleanup_status_removed_only_clears_cancel_token() {
    let fixture = CleanupPanickedJobFixture::new();
    let cleanup_state = RunCleanupState::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    fixture.status.add_run(run_id, sandbox_id).await.unwrap();
    fixture
        .status
        .remove_run_if_matching(run_id, sandbox_id)
        .await
        .unwrap();
    cleanup_state.mark_status_removed();

    fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

    assert!(fixture.tokens.handle(run_id).await.is_none());
    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
    assert!(active_runs.is_empty());
    assert_eq!(fixture.orphans.len(), 0);
}

#[tokio::test]
async fn panic_cleanup_active_unknown_keeps_active_and_registers_orphan() {
    let fixture = CleanupPanickedJobFixture::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    fixture.status.add_run(run_id, sandbox_id).await.unwrap();
    fixture
        .cleanup(run_id, sandbox_id, RunCleanupState::new())
        .await;

    assert!(fixture.tokens.handle(run_id).await.is_none());
    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
    assert_eq!(active_runs, vec![run_id.to_string()]);
    assert_eq!(fixture.orphans.len(), 1);
}

#[tokio::test]
async fn panic_cleanup_destroy_completed_removes_active_run() {
    let fixture = CleanupPanickedJobFixture::new();
    let cleanup_state = RunCleanupState::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    fixture.status.add_run(run_id, sandbox_id).await.unwrap();
    cleanup_state.mark_destroy_completed();

    fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

    assert!(fixture.tokens.handle(run_id).await.is_none());
    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
    assert!(active_runs.is_empty());
    assert_eq!(fixture.orphans.len(), 0);
}

#[tokio::test]
async fn panic_cleanup_destroy_completed_does_not_remove_reinserted_active_run() {
    let fixture = CleanupPanickedJobFixture::new();
    let cleanup_state = RunCleanupState::new();
    let run_id = RunId::new_v4();
    let completed_sandbox_id = SandboxId::new_v4();
    let current_sandbox_id = SandboxId::new_v4();
    fixture
        .status
        .add_run(run_id, completed_sandbox_id)
        .await
        .unwrap();
    fixture
        .status
        .add_run(run_id, current_sandbox_id)
        .await
        .unwrap();
    let stale_cancellation = fixture.tokens.register(run_id).await.unwrap();
    assert!(stale_cancellation.unregister().await);
    let replacement_cancellation = fixture.tokens.register(run_id).await.unwrap();
    cleanup_state.mark_destroy_completed();

    fixture
        .cleanup_with_registration(
            run_id,
            completed_sandbox_id,
            cleanup_state,
            stale_cancellation,
        )
        .await;

    assert!(
        fixture.tokens.handle(run_id).await.is_some(),
        "stale panic cleanup must preserve the replacement registration",
    );
    assert_eq!(
        status_active_run_records(&fixture.status_path).await,
        vec![(run_id.to_string(), current_sandbox_id.to_string())],
    );
    assert_eq!(fixture.orphans.len(), 0);
    assert!(replacement_cancellation.unregister().await);
}

#[tokio::test]
async fn panic_cleanup_idle_pool_owned_refreshes_idle_status_before_removing_active() {
    let fixture = CleanupPanickedJobFixture::new();
    let cleanup_state = RunCleanupState::new();
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new("sess-idle-owned-cleanup", lease)
        .with_mock_sandbox_name("idle-owned-cleanup")
        .with_sandbox_id(sandbox_id)
        .build();
    assert!(matches!(
        fixture.idle_pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    fixture.status.add_run(run_id, sandbox_id).await.unwrap();
    cleanup_state.mark_idle_pool_owned();

    fixture.cleanup(run_id, sandbox_id, cleanup_state).await;

    assert!(fixture.tokens.handle(run_id).await.is_none());
    let (idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&fixture.status_path).await;
    assert_eq!(idle_reuse_keys, vec!["sess-idle-owned-cleanup"]);
    assert!(active_runs.is_empty());
    assert_eq!(fixture.orphans.len(), 0);
}
