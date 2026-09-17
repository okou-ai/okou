use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig,
    SandboxCreateObserver, SandboxCreateStage, SandboxError, SandboxFactory,
    SandboxGuestConnectionPhase, SandboxId, SandboxInitializationPhase, SandboxNbdCowCreateOutcome,
    SandboxNbdCowCreateStage, SandboxNbdNetlinkConnectStage, SandboxOperation,
    SandboxOperationReason, SandboxOperationTimeoutStage, SandboxStartObserver, SandboxStartStage,
    StartProcessRequest, WriteFileEntry,
};
use sandbox_mock::{MockSandbox, MockSandboxFactory, MockSandboxOverrides};

use super::super::env::guest_connector_account_context_file_path;
use super::super::storage_baseline_observation::{
    BaselineObservationTestEvent, StorageBaselineObserver,
};
use super::super::telemetry::{
    RunnerPreSpawnPhase, elapsed_since_api_start_ms, record_api_startup_boundaries,
    record_reuse_result,
};
use super::super::{
    ExactReuseSpeculationTiming, ExecutionHooks, ExecutorConfig, FinalizingHandoffOutcome,
    FinalizingHandoffReason, JobParams, NewSandboxDispatch, RunnerPreSpawnConcurrency,
    RunnerPreSpawnOperationTiming, RunnerPreSpawnTiming, SandboxReuseDisposition,
    SandboxReuseRejection, SessionHistoryRestorePlan, execute_job, execute_job_reuse,
    execute_job_reuse_with_hooks, execute_job_with_prepared_notifier,
};
use super::support::{
    api_storage, context_with_env, default_params, make_reusable_idle_sandbox, minimal_context,
    test_budget_lease, test_executor_config,
};
use crate::guest_timezone::GuestTimezoneAssumption;
use crate::http::{HttpClient, HttpClientConfig};
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdleUnparkResult, ParkResult, ParkedIdleCandidate,
};
use crate::ids::RunId;
use crate::provider::ApiClaimTiming;
use crate::resource_budget::ResourceBudget;
use crate::run_cancellation::RunCancellationSignals;
use crate::storage_manifest::{StorageEntry, StorageManifest};
use crate::telemetry::{
    JobTelemetry, RunnerPreSpawnAttribution, RunnerPreSpawnConcurrencyBucket,
    RunnerResourceBudgetLeaseCountBucket, RunnerResourceBudgetOccupancy,
    RunnerResourceBudgetUtilizationBucket, RunnerStartupPath,
};
use crate::types::{ExecutionContext, SandboxReuseResult, WorkspaceReuseResult};
use crate::workspace_mount::ensure_workspace_drive_mounted;

#[test]
fn elapsed_since_api_start_ms_returns_elapsed_duration() {
    let duration = elapsed_since_api_start_ms(1_700_000_000_000, 1_700_000_001_250);

    assert_eq!(duration, Some(Duration::from_millis(1_250)));
}

#[test]
fn elapsed_since_api_start_ms_clamps_future_start_to_zero() {
    let duration = elapsed_since_api_start_ms(1_700_000_001_250, 1_700_000_000_000);

    assert_eq!(duration, Some(Duration::ZERO));
}

#[test]
fn elapsed_since_api_start_ms_rejects_seconds_shaped_start() {
    let duration = elapsed_since_api_start_ms(1_700_000_000, 1_700_000_001_250);

    assert_eq!(duration, None);
}

#[test]
fn pre_finalization_deadline_records_bounded_handoff_outcome() {
    let mut telemetry = new_telemetry();
    let mut timing = RunnerPreSpawnTiming::start_after_claim();

    timing.record_finalizing_handoff(
        FinalizingHandoffOutcome::PreFinalizationDeadline,
        Some(FinalizingHandoffReason::PreFinalizationDeadline),
    );
    timing
        .finalizing_diagnostics()
        .expect("pre-finalization diagnostics")
        .record(&mut telemetry);

    assert_action_outcome(
        &telemetry,
        "runner_claim_finalizing_handoff",
        false,
        Some("pre_finalization_deadline"),
    );
    assert!(
        telemetry
            .pending_ops_with_outcome_snapshot()
            .iter()
            .any(|operation| {
                operation.0 == "runner_claim_finalizing_handoff"
                    && operation.2.as_deref() == Some("pre_finalization_deadline")
                    && operation.3.as_deref() == Some("pre_finalization_deadline")
            })
    );
}

#[test]
fn api_startup_boundaries_record_the_effective_path_and_exact_reuse_result() {
    for (reuse_result, workspace_reuse_result, expected_path) in [
        (
            SandboxReuseResult::Reused,
            WorkspaceReuseResult::SandboxReused,
            RunnerStartupPath::Sandbox,
        ),
        (
            SandboxReuseResult::NoReuseKey,
            WorkspaceReuseResult::Reused,
            RunnerStartupPath::Workspace,
        ),
        (
            SandboxReuseResult::PoolMiss,
            WorkspaceReuseResult::CacheMiss,
            RunnerStartupPath::Cold,
        ),
    ] {
        let mut context = minimal_context();
        context.api_start_time =
            Some((chrono::Utc::now().timestamp_millis().max(0) as u64).saturating_sub(1_000));
        let mut telemetry = new_telemetry();
        let budget = Arc::new(ResourceBudget::new(4, 8192, 1.0, 0));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let mut attribution = RunnerPreSpawnAttribution::new(RunnerPreSpawnConcurrencyBucket::One);
        attribution.set_resource_budget_occupancy(RunnerResourceBudgetOccupancy::capture(&budget));
        telemetry.start_runner_pre_spawn_attribution(attribution);

        let agent_ready_at = Instant::now();
        let shell_started_at = agent_ready_at - Duration::from_millis(1);
        record_api_startup_boundaries(
            &context,
            &mut telemetry,
            reuse_result,
            workspace_reuse_result,
            shell_started_at,
            agent_ready_at,
        );
        telemetry.record("agent_execute", Duration::from_millis(10), true, None);

        let operations = telemetry.pending_ops_with_runner_startup_snapshot();
        let [spawn, ready, execute] = operations.as_slice() else {
            panic!("expected API spawn, ready, and execute operations, got {operations:?}");
        };
        assert_eq!(spawn.action_type, "api_to_spawn");
        assert_eq!(ready.action_type, "api_to_agent_ready");
        for operation in [spawn, ready] {
            assert_eq!(operation.runner_startup_path, Some(expected_path));
            assert_eq!(operation.sandbox_reuse_result, Some(reuse_result));
            assert_eq!(
                operation.runner_resource_budget_vcpu_utilization_bucket,
                Some(RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive),
            );
            assert_eq!(
                operation.runner_resource_budget_memory_utilization_bucket,
                Some(RunnerResourceBudgetUtilizationBucket::TwentySixToFifty),
            );
            assert_eq!(
                operation.runner_resource_budget_lease_count_bucket,
                Some(RunnerResourceBudgetLeaseCountBucket::One),
            );
        }
        assert_eq!(execute.action_type, "agent_execute");
        assert!(
            execute
                .runner_resource_budget_vcpu_utilization_bucket
                .is_none()
        );
        assert!(
            execute
                .runner_resource_budget_memory_utilization_bucket
                .is_none()
        );
        assert!(execute.runner_resource_budget_lease_count_bucket.is_none());
        let durations = telemetry.pending_ops_with_duration_snapshot();
        assert_eq!(durations[0].0, "api_to_spawn");
        assert_eq!(durations[1].0, "api_to_agent_ready");
        assert!(durations[1].1 > durations[0].1);
    }
}

// -----------------------------------------------------------------------
// Reuse-outcome telemetry (issue #10360: sandbox reuse success rate)
// -----------------------------------------------------------------------

fn new_telemetry() -> JobTelemetry {
    let http = HttpClient::new(HttpClientConfig {
        api_url: "http://localhost".to_string(),
        vercel_bypass: None,
        client_session_id: "runner-session-test".to_string(),
    })
    .unwrap();
    JobTelemetry::new(http, RunId::nil(), "tok".to_string(), None)
}

fn assert_has_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().any(|op| op.0 == action),
        "expected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_lacks_action(telemetry: &JobTelemetry, action: &str) {
    let ops = telemetry.pending_ops_snapshot();
    assert!(
        ops.iter().all(|op| op.0 != action),
        "unexpected telemetry action {action}, got: {ops:?}"
    );
}

fn assert_action_success(telemetry: &JobTelemetry, action: &str, success: bool) {
    let ops = telemetry.pending_ops_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, success, "{action} success flag");
}

fn assert_action_outcome(
    telemetry: &JobTelemetry,
    action: &str,
    success: bool,
    error: Option<&str>,
) {
    let ops = telemetry.pending_ops_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, success, "{action} success flag");
    assert_eq!(op.2.as_deref(), error, "{action} error");
}

fn assert_action_bounded_outcome(telemetry: &JobTelemetry, action: &str, expected_outcome: &str) {
    let operations = telemetry.pending_ops_with_outcome_snapshot();
    let mut matching = operations.iter().filter(|operation| operation.0 == action);
    let operation = matching
        .next()
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {operations:?}"));
    assert!(
        matching.next().is_none(),
        "expected one telemetry action {action}, got: {operations:?}"
    );
    assert!(!operation.1, "{action} success flag");
    assert_eq!(operation.2.as_deref(), Some(expected_outcome));
    assert_eq!(operation.3, None, "{action} reason");
    assert_action_outcome(telemetry, action, false, None);
}

fn successful_bounded_outcome(telemetry: &JobTelemetry, action: &str) -> String {
    let operations = telemetry.pending_ops_with_outcome_snapshot();
    let mut matching = operations.iter().filter(|operation| operation.0 == action);
    let operation = matching
        .next()
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {operations:?}"));
    assert!(
        matching.next().is_none(),
        "expected one telemetry action {action}, got: {operations:?}"
    );
    assert!(operation.1, "{action} success flag");
    assert_eq!(operation.3, None, "{action} reason");
    operation
        .2
        .clone()
        .unwrap_or_else(|| panic!("expected {action} outcome"))
}

fn baseline_storage(name: &str, mount_path: &str, version: &str) -> StorageEntry {
    let mut storage = api_storage(
        name,
        mount_path,
        version,
        "https://private-storage.invalid/archive.tar.gz",
    );
    storage.baseline_candidate = true;
    storage
}

fn context_with_baseline(cli_agent_type: &str, storages: Vec<StorageEntry>) -> ExecutionContext {
    let mut context = minimal_context();
    context.cli_agent_type = cli_agent_type.to_string();
    context.storage_manifest = Some(StorageManifest {
        storages,
        artifacts: Vec::new(),
    });
    context
}

async fn execute_cancelled_observation(
    config: &ExecutorConfig,
    context: ExecutionContext,
    params: &JobParams,
) -> JobTelemetry {
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    execute_job(
        &MockSandboxFactory::new(),
        context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        config,
        params,
        cancel,
    )
    .await
    .1
}

fn assert_action_duration(telemetry: &JobTelemetry, action: &str, duration_ms: u64) {
    let ops = telemetry.pending_ops_with_duration_snapshot();
    let op = ops
        .iter()
        .find(|op| op.0 == action)
        .unwrap_or_else(|| panic!("expected telemetry action {action}, got: {ops:?}"));
    assert_eq!(op.1, duration_ms, "{action} duration");
}

fn assert_action_once_with_duration(telemetry: &JobTelemetry, action: &str, duration_ms: u64) {
    let ops = telemetry.pending_ops_with_duration_snapshot();
    let matching: Vec<_> = ops.iter().filter(|op| op.0 == action).collect();
    assert_eq!(matching.len(), 1, "expected one {action}, got: {ops:?}");
    assert_eq!(matching[0].1, duration_ms, "{action} duration");
}

fn assert_lacks_api_claim_timing(telemetry: &JobTelemetry) {
    for action in [
        "runner_claim_http_request",
        "runner_claim_request_to_response_headers",
        "runner_claim_response_body_read",
        "runner_claim_response_decode",
    ] {
        assert_lacks_action(telemetry, action);
    }
}

struct ObservedStartSandbox {
    inner: Box<dyn Sandbox>,
    failed_stage: Option<SandboxStartStage>,
    omit_optional_stages: bool,
}

#[async_trait]
impl Sandbox for ObservedStartSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn host_process_pid(&self) -> Option<u32> {
        self.inner.host_process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn start_with_observer(
        &mut self,
        observer: &mut dyn SandboxStartObserver,
    ) -> sandbox::Result<()> {
        for (index, stage) in SandboxStartStage::ALL.iter().copied().enumerate() {
            if self.omit_optional_stages
                && matches!(
                    stage,
                    SandboxStartStage::SnapshotLoadResume | SandboxStartStage::GuestDnsReadiness
                )
            {
                continue;
            }
            let success = self.failed_stage != Some(stage);
            if stage == SandboxStartStage::GuestDnsReadiness {
                for (attempt, duration, guest_duration_ms, outcome) in [
                    (1, 4, 0, sandbox::SandboxDnsReadinessOutcome::ProcessTimeout),
                    (
                        2,
                        9,
                        6,
                        if success {
                            sandbox::SandboxDnsReadinessOutcome::Success
                        } else {
                            sandbox::SandboxDnsReadinessOutcome::WaitFailed
                        },
                    ),
                ] {
                    observer.record_dns_readiness_attempt(sandbox::SandboxDnsReadinessAttempt {
                        attempt,
                        final_attempt: attempt == 2,
                        duration: Duration::from_millis(duration),
                        guest_duration_ms: Some(guest_duration_ms),
                        outcome,
                        completed_at: std::time::SystemTime::now(),
                    });
                }
            }
            observer.record_stage(stage, Duration::from_millis(index as u64 + 30), success);
            if stage == SandboxStartStage::GuestConnectionWait && !self.omit_optional_stages {
                for (index, phase) in SandboxGuestConnectionPhase::ALL.into_iter().enumerate() {
                    if !success && phase == SandboxGuestConnectionPhase::ClientSetup {
                        continue;
                    }
                    observer.record_guest_connection_phase(
                        phase,
                        Duration::from_millis(index as u64 + 1),
                        Duration::from_millis(u64::from(index >= 5)),
                        success || phase != SandboxGuestConnectionPhase::Pong,
                    );
                }
            }
            if !success {
                return Err(SandboxError::Start {
                    message: "observed mock start failure".to_string(),
                });
            }
        }
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn exec_with_diagnostic_label(
        &self,
        request: &ExecRequest<'_>,
        label: &'static str,
    ) -> sandbox::Result<ExecResult> {
        self.inner.exec_with_diagnostic_label(request, label).await
    }

    async fn apply_storage_manifest(
        &self,
        request: &sandbox::StorageManifestRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.apply_storage_manifest(request).await
    }

    async fn mount_workspace_drive(&self) -> sandbox::Result<ExecResult> {
        let mut result = self.inner.mount_workspace_drive().await?;
        result.guest_duration_ms = Some(23);
        Ok(result)
    }

    async fn restore_guest_state(
        &self,
        request: &sandbox::GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        self.inner.restore_guest_state(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: sandbox::FileCompression,
    ) -> sandbox::Result<Option<sandbox::FileWriteMeasurements>> {
        self.inner
            .write_file_with_compression(path, content, compression)
            .await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_private_file(path, content).await
    }

    async fn write_private_files(&self, files: &[WriteFileEntry<'_>]) -> sandbox::Result<()> {
        self.inner.write_private_files(files).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn start_agent_process(
        &self,
        request: &sandbox::StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestAgentProcessHandle> {
        self.inner.start_agent_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

struct ObservedMockSandboxFactory {
    inner: MockSandboxFactory,
    failed_stage: Option<SandboxCreateStage>,
    failed_nbd_cow_stage: Option<SandboxNbdCowCreateStage>,
    failed_nbd_netlink_connect_stage: Option<SandboxNbdNetlinkConnectStage>,
    failed_start_stage: Option<SandboxStartStage>,
    omit_optional_start_stages: bool,
}

impl ObservedMockSandboxFactory {
    fn new() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_stage(stage: SandboxCreateStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: Some(stage),
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_nbd_cow_stage(stage: SandboxNbdCowCreateStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: Some(stage),
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_nbd_netlink_connect_stage(stage: SandboxNbdNetlinkConnectStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: Some(stage),
            failed_start_stage: None,
            omit_optional_start_stages: false,
        }
    }

    fn with_failed_start_stage(stage: SandboxStartStage) -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: Some(stage),
            omit_optional_start_stages: false,
        }
    }

    fn without_optional_start_stages() -> Self {
        Self {
            inner: MockSandboxFactory::new(),
            failed_stage: None,
            failed_nbd_cow_stage: None,
            failed_nbd_netlink_connect_stage: None,
            failed_start_stage: None,
            omit_optional_start_stages: true,
        }
    }
}

#[async_trait]
impl SandboxFactory for ObservedMockSandboxFactory {
    fn name(&self) -> &str {
        "observed-mock"
    }

    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        let inner = self.inner.create(config).await?;
        Ok(Box::new(ObservedStartSandbox {
            inner,
            failed_stage: self.failed_start_stage,
            omit_optional_stages: self.omit_optional_start_stages,
        }))
    }

    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        if let Some(stage) = self.failed_stage {
            observer.record_stage(stage, Duration::from_millis(1), false);
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock create failure".to_string(),
            });
        }

        if let Some(stage) = self.failed_nbd_cow_stage {
            observer.record_nbd_cow_stage(stage, Duration::from_millis(1), false);
            observer.record_stage(
                SandboxCreateStage::NbdCowCreate,
                Duration::from_millis(2),
                false,
            );
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock NBD COW detail failure".to_string(),
            });
        }

        if let Some(stage) = self.failed_nbd_netlink_connect_stage {
            observer.record_nbd_netlink_connect_stage(stage, Duration::from_millis(1), false);
            observer.record_nbd_cow_stage(
                SandboxNbdCowCreateStage::NetlinkConnect,
                Duration::from_millis(2),
                false,
            );
            observer.record_stage(
                SandboxCreateStage::NbdCowCreate,
                Duration::from_millis(3),
                false,
            );
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "observed mock NBD netlink detail failure".to_string(),
            });
        }

        for (index, stage) in SandboxCreateStage::ALL.iter().copied().enumerate() {
            observer.record_stage(stage, Duration::from_millis(index as u64 + 1), true);
        }
        for (index, stage) in SandboxNbdCowCreateStage::ALL.iter().copied().enumerate() {
            observer.record_nbd_cow_stage(stage, Duration::from_millis(index as u64 + 10), true);
        }
        for (index, stage) in SandboxNbdNetlinkConnectStage::ALL
            .iter()
            .copied()
            .enumerate()
        {
            observer.record_nbd_netlink_connect_stage(
                stage,
                Duration::from_millis(index as u64 + 20),
                true,
            );
        }
        for outcome in [
            SandboxNbdCowCreateOutcome::AcquireSourceDemandScan,
            SandboxNbdCowCreateOutcome::EbusyRetriesNone,
            SandboxNbdCowCreateOutcome::SizeZeroRetriesNone,
        ] {
            observer.record_nbd_cow_outcome(outcome);
        }
        self.create(config).await
    }

    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

const FRESH_SANDBOX_FACTORY_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_cow_pool_acquire",
    "runner_fresh_sandbox_factory_workspace_dir_rename",
    "runner_fresh_sandbox_factory_workspace_drive_prepare",
    "runner_fresh_sandbox_factory_workspace_seed_sparse_copy",
    "runner_fresh_sandbox_factory_workspace_fresh_format",
    "runner_fresh_sandbox_factory_sock_dir_prepare",
    "runner_fresh_sandbox_factory_netns_acquire",
    "runner_fresh_sandbox_factory_nbd_cow_create",
];

const FRESH_SANDBOX_FACTORY_NBD_COW_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_cow_layer_create",
    "runner_fresh_sandbox_factory_nbd_device_acquire",
    "runner_fresh_sandbox_factory_nbd_device_scan",
    "runner_fresh_sandbox_factory_nbd_dispatch_setup",
    "runner_fresh_sandbox_factory_nbd_netlink_connect",
    "runner_fresh_sandbox_factory_nbd_size_verify",
    "runner_fresh_sandbox_factory_nbd_retry_cleanup",
    "runner_fresh_sandbox_factory_nbd_retry_delay",
];

const FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_netlink_blocking_task_queue",
    "runner_fresh_sandbox_factory_nbd_netlink_socket_setup",
    "runner_fresh_sandbox_factory_nbd_netlink_family_resolve",
    "runner_fresh_sandbox_factory_nbd_netlink_connect_command",
];

const FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_factory_nbd_acquire_source_demand_scan",
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_none",
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_none",
];

const FRESH_SANDBOX_START_STAGE_ACTIONS: &[&str] = &[
    "runner_fresh_sandbox_start_backend_launch",
    "runner_fresh_sandbox_start_snapshot_load_resume",
    "runner_fresh_sandbox_start_guest_connection_wait",
    "runner_fresh_sandbox_start_guest_dns_readiness",
    "runner_fresh_sandbox_start_runtime_finalize",
];

const GUEST_CONNECTION_PHASE_NAMES: [&str; 8] = [
    "task_schedule",
    "listener_setup",
    "accept",
    "ready",
    "ping",
    "pong",
    "client_setup",
    "task_handoff",
];

const RUNNER_PRE_SPAWN_PHASE_CASES: &[(RunnerPreSpawnPhase, &str, u64)] = &[
    (
        RunnerPreSpawnPhase::ResumeSessionValidation,
        "runner_claim_resume_session_validation",
        1,
    ),
    (
        RunnerPreSpawnPhase::FinalizingWait,
        "runner_claim_finalizing_wait",
        2,
    ),
    (
        RunnerPreSpawnPhase::SessionHistoryMaterializerStart,
        "runner_claim_session_history_materializer_start",
        3,
    ),
    (
        RunnerPreSpawnPhase::DeviceRateLimits,
        "runner_claim_device_rate_limits",
        4,
    ),
    (
        RunnerPreSpawnPhase::IdleReuseLookup,
        "runner_claim_idle_reuse_lookup",
        5,
    ),
    (
        RunnerPreSpawnPhase::WorkspaceCacheStateLookup,
        "runner_claim_workspace_cache_state_lookup",
        6,
    ),
    (
        RunnerPreSpawnPhase::WorkspacePromotionValidation,
        "runner_claim_workspace_promotion_validation",
        7,
    ),
    (
        RunnerPreSpawnPhase::IdleUnpark,
        "runner_claim_idle_unpark",
        8,
    ),
    (
        RunnerPreSpawnPhase::ActiveStatusPublish,
        "runner_claim_active_status_publish",
        9,
    ),
    (
        RunnerPreSpawnPhase::SpawnJobSetup,
        "runner_claim_spawn_job_setup",
        10,
    ),
];

fn assert_pre_spawn_phase_actions_succeeded(telemetry: &JobTelemetry) {
    for &(_, action, duration_ms) in RUNNER_PRE_SPAWN_PHASE_CASES {
        assert_action_success(telemetry, action, true);
        assert_action_once_with_duration(telemetry, action, duration_ms);
    }
    assert_action_success(telemetry, "runner_claim_task_schedule_wait", true);
}

fn pre_spawn_timing_with_phases() -> RunnerPreSpawnTiming {
    let concurrency = RunnerPreSpawnConcurrency::default();
    pre_spawn_timing_with_phases_and_concurrency(&concurrency)
}

fn pre_spawn_timing_with_phases_and_concurrency(
    concurrency: &RunnerPreSpawnConcurrency,
) -> RunnerPreSpawnTiming {
    let mut timing = RunnerPreSpawnTiming::start_at(
        Instant::now(),
        Some(ApiClaimTiming::new(
            Duration::from_millis(42),
            Duration::from_millis(11),
            Duration::from_millis(7),
            Duration::from_millis(3),
        )),
        concurrency,
    );
    for &(phase, _, duration_ms) in RUNNER_PRE_SPAWN_PHASE_CASES {
        timing.record_phase(phase, Duration::from_millis(duration_ms));
    }
    timing.record_finalizing_handoff_outcome(FinalizingHandoffOutcome::Accepted);
    timing.mark_task_enqueued();
    timing
}

fn assert_pre_spawn_concurrency_bucket(
    telemetry: &JobTelemetry,
    action: &str,
    expected: Option<RunnerPreSpawnConcurrencyBucket>,
) {
    let operations = telemetry.pending_ops_with_runner_startup_snapshot();
    let matching: Vec<_> = operations
        .iter()
        .filter(|operation| operation.action_type == action)
        .collect();
    let [operation] = matching.as_slice() else {
        panic!("expected one {action} operation, got {operations:?}");
    };
    assert_eq!(operation.runner_pre_spawn_concurrency_bucket, expected);
}

fn assert_resource_budget_occupancy(
    telemetry: &JobTelemetry,
    action: &str,
    expected: Option<(
        RunnerResourceBudgetUtilizationBucket,
        RunnerResourceBudgetUtilizationBucket,
        RunnerResourceBudgetLeaseCountBucket,
    )>,
) {
    let operations = telemetry.pending_ops_with_runner_startup_snapshot();
    let matching: Vec<_> = operations
        .iter()
        .filter(|operation| operation.action_type == action)
        .collect();
    let [operation] = matching.as_slice() else {
        panic!("expected one {action} operation, got {operations:?}");
    };
    let expected = expected.map_or((None, None, None), |(vcpu, memory, leases)| {
        (Some(vcpu), Some(memory), Some(leases))
    });
    assert_eq!(
        (
            operation.runner_resource_budget_vcpu_utilization_bucket,
            operation.runner_resource_budget_memory_utilization_bucket,
            operation.runner_resource_budget_lease_count_bucket,
        ),
        expected,
    );
}

fn pre_spawn_timing_with_exact_reuse_speculation() -> RunnerPreSpawnTiming {
    let mut timing = RunnerPreSpawnTiming::start_after_claim();
    timing.record_exact_reuse_speculation(ExactReuseSpeculationTiming {
        unpark: RunnerPreSpawnOperationTiming {
            duration: Duration::from_millis(3),
            succeeded: true,
        },
        guest_restore: Some(RunnerPreSpawnOperationTiming {
            duration: Duration::from_millis(41),
            succeeded: true,
        }),
        claim_overlap: Duration::from_millis(39),
        post_claim_remainder: Duration::from_millis(2),
        timezone_correction: Some(RunnerPreSpawnOperationTiming {
            duration: Duration::from_millis(5),
            succeeded: true,
        }),
        timezone_assumption: Some(GuestTimezoneAssumption::Mismatch),
    });
    timing
}

#[test]
fn record_reuse_result_emits_hit_for_reuse() {
    let mut telemetry = new_telemetry();
    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    let ops = telemetry.pending_ops_snapshot();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].0, "sandbox_reuse_hit");
}

#[test]
fn record_reuse_result_emits_miss_for_every_miss_variant() {
    let variants = [
        SandboxReuseResult::NoReuseKey,
        SandboxReuseResult::PoolMiss,
        SandboxReuseResult::ProfileMismatch,
        SandboxReuseResult::DeviceLimitMismatch,
        SandboxReuseResult::UnparkFailed,
    ];
    for variant in variants {
        let mut telemetry = new_telemetry();
        record_reuse_result(&mut telemetry, variant);
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), 1, "{variant:?}");
        assert_eq!(ops[0].0, "sandbox_reuse_miss", "{variant:?}");
    }
}

#[tokio::test]
async fn execute_job_records_sandbox_reuse_miss_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_miss");
    assert_lacks_action(&telemetry, "runner_claim_to_executor_start");
    assert_lacks_api_claim_timing(&telemetry);
    assert_lacks_action(&telemetry, "runner_claim_resume_session_validation");
    assert_lacks_action(&telemetry, "runner_claim_task_schedule_wait");
    assert_action_success(&telemetry, "runner_fresh_sandbox_start", true);
    assert_action_success(
        &telemetry,
        "workspace_drive_mount_guest_exec_unavailable",
        true,
    );
    assert_lacks_action(&telemetry, "workspace_drive_mount_guest_exec");
    for action in FRESH_SANDBOX_START_STAGE_ACTIONS {
        assert_lacks_action(&telemetry, action);
    }
}

#[tokio::test]
async fn execute_job_reuse_records_sandbox_reuse_hit_in_telemetry() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let (_outcome, telemetry) = execute_job_reuse(
        idle_sandbox,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage("seed", "/seed", "version")],
        ),
        &config,
        &default_params(),
        cancel,
    )
    .await;

    let ops = telemetry.pending_ops_snapshot();
    let reuse_events: Vec<_> = ops
        .iter()
        .filter(|op| op.0.starts_with("sandbox_reuse_"))
        .collect();
    assert_eq!(reuse_events.len(), 1);
    assert_eq!(reuse_events[0].0, "sandbox_reuse_hit");
    assert_eq!(
        successful_bounded_outcome(&telemetry, "runner_storage_baseline_candidate_stability"),
        "first"
    );
}

#[tokio::test]
async fn execute_job_observes_exact_baseline_stability_per_profile_and_framework() {
    const STABILITY: &str = "runner_storage_baseline_candidate_stability";
    const CANDIDATES: &str = "runner_storage_baseline_candidate_count";
    const ADDED: &str = "runner_storage_baseline_added_count";
    const REMOVED: &str = "runner_storage_baseline_removed_count";
    const CHANGED_AT_PATH: &str = "runner_storage_baseline_changed_at_path_count";

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let default_profile = default_params();

    let first = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/seed-path",
                "private-version-1",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&first, STABILITY), "first");
    assert_eq!(successful_bounded_outcome(&first, CANDIDATES), "1");
    assert_eq!(successful_bounded_outcome(&first, ADDED), "0");
    assert_eq!(successful_bounded_outcome(&first, REMOVED), "0");
    assert_eq!(successful_bounded_outcome(&first, CHANGED_AT_PATH), "0");

    let same = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/seed-path",
                "private-version-1",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&same, STABILITY), "same");

    let changed_version = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/seed-path",
                "private-version-2",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(
        successful_bounded_outcome(&changed_version, STABILITY),
        "changed"
    );
    assert_eq!(
        successful_bounded_outcome(&changed_version, CHANGED_AT_PATH),
        "1"
    );

    let added = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![
                baseline_storage(
                    "private-seed-name",
                    "/private/seed-path",
                    "private-version-2",
                ),
                baseline_storage(
                    "second-private-seed",
                    "/private/second-path",
                    "second-private-version",
                ),
            ],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&added, STABILITY), "changed");
    assert_eq!(successful_bounded_outcome(&added, CANDIDATES), "2");
    assert_eq!(successful_bounded_outcome(&added, ADDED), "1");

    let removed = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/seed-path",
                "private-version-2",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&removed, STABILITY), "changed");
    assert_eq!(successful_bounded_outcome(&removed, REMOVED), "1");

    let changed_mount = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/renamed-seed-path",
                "private-version-2",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(
        successful_bounded_outcome(&changed_mount, STABILITY),
        "changed"
    );
    assert_eq!(successful_bounded_outcome(&changed_mount, ADDED), "1");
    assert_eq!(successful_bounded_outcome(&changed_mount, REMOVED), "1");
    assert_eq!(
        successful_bounded_outcome(&changed_mount, CHANGED_AT_PATH),
        "0"
    );

    let none = execute_cancelled_observation(
        &config,
        context_with_baseline("claude-code", Vec::new()),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&none, STABILITY), "none");
    let after_none = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/renamed-seed-path",
                "private-version-2",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&after_none, STABILITY), "same");

    let codex = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "codex",
            vec![baseline_storage(
                "private-seed-name",
                "/private/renamed-seed-path",
                "private-version-2",
            )],
        ),
        &default_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&codex, STABILITY), "first");

    let other_profile = JobParams {
        profile_name: "vm0/other".into(),
        ..default_params()
    };
    let profile = execute_cancelled_observation(
        &config,
        context_with_baseline(
            "claude-code",
            vec![baseline_storage(
                "private-seed-name",
                "/private/renamed-seed-path",
                "private-version-2",
            )],
        ),
        &other_profile,
    )
    .await;
    assert_eq!(successful_bounded_outcome(&profile, STABILITY), "first");

    let observation_snapshot = same.pending_ops_with_outcome_snapshot();
    let serialized = format!("{observation_snapshot:?}");
    for private_value in [
        "private-seed-name",
        "/private/seed-path",
        "private-version-1",
        "private-storage.invalid",
    ] {
        assert!(
            !serialized.contains(private_value),
            "leaked {private_value}"
        );
    }
}

#[tokio::test]
async fn execute_job_shares_baseline_observations_across_sequential_jobs() {
    const STABILITY: &str = "runner_storage_baseline_candidate_stability";

    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let first_params = default_params();
    let second_params = default_params();
    let first_context = context_with_baseline(
        "claude-code",
        vec![baseline_storage("seed", "/seed", "version")],
    );
    let second_context = context_with_baseline(
        "claude-code",
        vec![baseline_storage("seed", "/seed", "version")],
    );

    let first = execute_cancelled_observation(&config, first_context, &first_params).await;
    let second = execute_cancelled_observation(&config, second_context, &second_params).await;
    assert_eq!(successful_bounded_outcome(&first, STABILITY), "first");
    assert_eq!(successful_bounded_outcome(&second, STABILITY), "same");
}

#[test]
fn baseline_observation_serializes_parallel_callers() {
    const WAIT: Duration = Duration::from_secs(5);
    const STABILITY: &str = "runner_storage_baseline_candidate_stability";

    let (events, observations) = mpsc::channel();
    let (release_first, first_release) = mpsc::channel();
    let first_release = Mutex::new(Some(first_release));
    let observer = StorageBaselineObserver::with_test_probe(move |event| match event {
        BaselineObservationTestEvent::BeforeLock { .. } => events.send(event).unwrap(),
        BaselineObservationTestEvent::BeforeFirstInsert => {
            // Pause only the first caller, even if a split-lock regression lets
            // another caller also observe a missing key.
            let release = first_release.lock().unwrap().take();
            if let Some(release) = release {
                events.send(event).unwrap();
                assert_ne!(
                    release.recv_timeout(WAIT),
                    Err(mpsc::RecvTimeoutError::Timeout)
                );
            }
        }
    });
    let context = context_with_baseline(
        "claude-code",
        vec![baseline_storage("seed", "/seed", "version")],
    );
    let params = default_params();
    let record = |mut telemetry: JobTelemetry| {
        observer.record(&context, &params, &mut telemetry);
        telemetry
    };
    // Keep HTTP-client construction outside the coordinated contention window.
    let first_telemetry = new_telemetry();
    let second_telemetry = new_telemetry();

    let (first, second) = std::thread::scope(|scope| {
        // Own the sender inside the scope callback: unwinding disconnects the
        // paused worker before scope cleanup joins it.
        let release_first = release_first;
        let first = scope.spawn(|| record(first_telemetry));
        assert_eq!(
            observations.recv_timeout(WAIT).unwrap(),
            BaselineObservationTestEvent::BeforeLock { contended: false }
        );
        assert_eq!(
            observations.recv_timeout(WAIT).unwrap(),
            BaselineObservationTestEvent::BeforeFirstInsert
        );

        // The first caller has read the absent key but has not inserted it.
        // A separate OS thread now enters the same production observer.
        let second = scope.spawn(|| record(second_telemetry));
        let second_entry = observations.recv_timeout(WAIT);
        let released = release_first.send(());
        drop(release_first);
        let first = first.join();
        let second = second.join();

        assert_eq!(
            second_entry.unwrap(),
            BaselineObservationTestEvent::BeforeLock { contended: true },
            "the first observation must hold the state lock between lookup and insertion"
        );
        released.unwrap();
        (first.unwrap(), second.unwrap())
    });

    let mut outcomes = [
        successful_bounded_outcome(&first, STABILITY),
        successful_bounded_outcome(&second, STABILITY),
    ];
    outcomes.sort();
    assert_eq!(outcomes, ["first", "same"]);

    let subsequent = record(new_telemetry());
    assert_eq!(successful_bounded_outcome(&subsequent, STABILITY), "same");
    for telemetry in [&first, &second, &subsequent] {
        for (action, expected) in [
            ("runner_storage_baseline_candidate_count", "1"),
            ("runner_storage_baseline_added_count", "0"),
            ("runner_storage_baseline_removed_count", "0"),
            ("runner_storage_baseline_changed_at_path_count", "0"),
        ] {
            assert_eq!(successful_bounded_outcome(telemetry, action), expected);
        }
    }
}

#[tokio::test]
async fn execute_job_records_runner_pre_spawn_and_fresh_path_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::new();
    let mut context = minimal_context();
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    for action in [
        "runner_claim_http_request",
        "runner_claim_request_to_response_headers",
        "runner_claim_response_body_read",
        "runner_claim_response_decode",
        "runner_claim_to_executor_start",
        "runner_executor_start_to_spawn",
        "runner_claim_to_spawn",
        "runner_executor_start_to_agent_ready",
        "runner_claim_to_agent_ready",
        "runner_claim_finalizing_handoff",
        "runner_fresh_sandbox_prepare",
        "runner_fresh_sandbox_factory_create",
        "runner_fresh_sandbox_proxy_register",
        "runner_fresh_sandbox_start",
        "runner_guest_timezone_sync",
        "runner_required_private_files_write",
        "runner_agent_env_build",
        "runner_agent_start_process",
        "runner_agent_start_to_ready",
        "runner_agent_containment_create",
        "runner_agent_placement_broker_setup",
        "runner_agent_shell_spawn",
        "runner_agent_bootstrap_ready_wait",
        "api_to_sandbox_start",
        "sandbox_reuse_miss",
        "sandbox_create",
        "workspace_drive_mount",
        "workspace_drive_mount_guest_exec",
        "agent_execute",
    ] {
        assert_has_action(&telemetry, action);
    }
    assert_action_once_with_duration(&telemetry, "runner_claim_http_request", 42);
    assert_action_once_with_duration(&telemetry, "runner_claim_request_to_response_headers", 11);
    assert_action_once_with_duration(&telemetry, "runner_claim_response_body_read", 7);
    assert_action_once_with_duration(&telemetry, "runner_claim_response_decode", 3);
    assert_action_duration(&telemetry, "workspace_drive_mount_guest_exec", 23);
    assert_lacks_action(&telemetry, "workspace_drive_mount_guest_exec_unavailable");
    assert!(
        telemetry
            .pending_ops_with_outcome_snapshot()
            .iter()
            .any(|operation| {
                operation.0 == "runner_claim_finalizing_handoff"
                    && operation.2.as_deref() == Some("accepted")
            })
    );
    for action in FRESH_SANDBOX_FACTORY_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_STAGE_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS {
        assert_action_success(&telemetry, action, true);
    }
    for (index, action) in FRESH_SANDBOX_START_STAGE_ACTIONS.iter().enumerate() {
        assert_action_success(&telemetry, action, true);
        assert_action_duration(&telemetry, action, index as u64 + 30);
    }
    for (index, phase) in GUEST_CONNECTION_PHASE_NAMES.into_iter().enumerate() {
        for (kind, duration) in [
            ("full", index as u64 + 1),
            ("remaining", u64::from(index >= 5)),
        ] {
            let action = format!("runner_fresh_sandbox_start_guest_connection_{phase}_{kind}");
            assert_action_once_with_duration(&telemetry, &action, duration);
            assert_action_success(&telemetry, &action, true);
        }
    }
    let operations = telemetry.pending_ops_with_duration_snapshot();
    for action in FRESH_SANDBOX_FACTORY_NBD_COW_OUTCOME_ACTIONS {
        let matching: Vec<_> = operations
            .iter()
            .filter(|operation| operation.0 == *action)
            .collect();
        assert_eq!(matching.len(), 1, "outcome {action}: {operations:?}");
        assert_eq!(matching[0].1, 0, "outcome {action} duration");
    }
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_reused_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_workspace_image_prepare");
    assert_lacks_action(&telemetry, "runner_guest_state_restore");
}

#[tokio::test]
async fn execute_job_attributes_overlapping_pre_spawn_work_and_releases_membership() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::new();
    let concurrency = RunnerPreSpawnConcurrency::default();
    let mut held_timings = Vec::new();

    for (held_count, expected_bucket) in [
        (0, RunnerPreSpawnConcurrencyBucket::One),
        (1, RunnerPreSpawnConcurrencyBucket::Two),
        (2, RunnerPreSpawnConcurrencyBucket::ThreeToFour),
        (3, RunnerPreSpawnConcurrencyBucket::ThreeToFour),
        (4, RunnerPreSpawnConcurrencyBucket::FiveToEight),
        (7, RunnerPreSpawnConcurrencyBucket::FiveToEight),
        (8, RunnerPreSpawnConcurrencyBucket::NinePlus),
    ] {
        while held_timings.len() < held_count {
            held_timings.push(RunnerPreSpawnTiming::start_at(
                Instant::now(),
                None,
                &concurrency,
            ));
        }
        let mut context = minimal_context();
        context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
        let cancel = tokio_util::sync::CancellationToken::new();
        let (_outcome, telemetry) = execute_job_with_prepared_notifier(
            &factory,
            context,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            RunCancellationSignals::hard_only(cancel),
            ExecutionHooks {
                sandbox_prepared: None,
                active_input_source: None,
                pre_spawn_timing: Some(pre_spawn_timing_with_phases_and_concurrency(&concurrency)),
                session_history_restore_plan: SessionHistoryRestorePlan::Default,
            },
        )
        .await;

        for action in [
            "runner_claim_to_executor_start",
            "runner_fresh_sandbox_prepare",
            "runner_agent_start_process",
            "api_to_spawn",
            "api_to_agent_ready",
        ] {
            assert_pre_spawn_concurrency_bucket(&telemetry, action, Some(expected_bucket));
        }
        assert_pre_spawn_concurrency_bucket(&telemetry, "agent_execute", None);
    }

    drop(held_timings);

    let mut baseline_context = minimal_context();
    baseline_context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, baseline_telemetry) = execute_job_with_prepared_notifier(
        &factory,
        baseline_context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases_and_concurrency(&concurrency)),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    assert_pre_spawn_concurrency_bucket(
        &baseline_telemetry,
        "api_to_spawn",
        Some(RunnerPreSpawnConcurrencyBucket::One),
    );
    assert_pre_spawn_concurrency_bucket(
        &baseline_telemetry,
        "api_to_agent_ready",
        Some(RunnerPreSpawnConcurrencyBucket::One),
    );
}

#[tokio::test]
async fn execute_job_attributes_resource_budget_occupancy_until_agent_ready() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::new();
    let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 0));
    let _current_lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let _idle_lease = ResourceBudget::try_reserve_lease(&budget, 3, 12288).unwrap();
    let mut pre_spawn_timing = pre_spawn_timing_with_phases();
    pre_spawn_timing.record_resource_budget_occupancy(&budget);
    let mut context = minimal_context();
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let cancel = tokio_util::sync::CancellationToken::new();

    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    let expected = Some((
        RunnerResourceBudgetUtilizationBucket::FiftyOneToSeventyFive,
        RunnerResourceBudgetUtilizationBucket::TwentySixToFifty,
        RunnerResourceBudgetLeaseCountBucket::Two,
    ));
    for action in [
        "runner_claim_to_executor_start",
        "runner_fresh_sandbox_prepare",
        "runner_agent_start_process",
        "api_to_spawn",
        "api_to_agent_ready",
    ] {
        assert_resource_budget_occupancy(&telemetry, action, expected);
    }
    assert_resource_budget_occupancy(&telemetry, "agent_execute", None);
}

#[tokio::test]
async fn execute_job_records_exact_reuse_speculation_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_exact_reuse_speculation()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    for (action, duration_ms) in [
        ("runner_exact_reuse_preclaim_unpark", 3),
        ("runner_exact_reuse_preclaim_guest_restore", 41),
        ("runner_exact_reuse_claim_overlap", 39),
        ("runner_exact_reuse_postclaim_remainder", 2),
        ("runner_exact_reuse_timezone_correction", 5),
    ] {
        assert_action_success(&telemetry, action, true);
        assert_action_duration(&telemetry, action, duration_ms);
    }
    assert_action_success(
        &telemetry,
        "runner_exact_reuse_timezone_assumption_mismatch",
        true,
    );
    assert_lacks_action(&telemetry, "runner_exact_reuse_timezone_assumption_match");
    assert_lacks_action(&telemetry, "runner_exact_reuse_timezone_assumption_unknown");
}

#[tokio::test]
async fn execute_job_keeps_dns_attempt_failures_inside_the_successful_start() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        tokio_util::sync::CancellationToken::new(),
    )
    .await;
    let attempts: Vec<_> = telemetry
        .pending_ops_with_duration_snapshot()
        .into_iter()
        .filter(|(action, _, _, _)| {
            action == "runner_fresh_sandbox_start_guest_dns_readiness_attempt"
        })
        .map(|(_, duration, success, error)| (duration, success, error))
        .collect();
    assert_eq!(
        attempts,
        vec![(4, false, Some("process_timeout".into())), (9, true, None)]
    );
    assert_action_duration(
        &telemetry,
        "runner_fresh_sandbox_start_guest_dns_readiness",
        33,
    );
    assert_action_success(
        &telemetry,
        "runner_fresh_sandbox_start_guest_dns_readiness",
        true,
    );
    assert_action_success(&telemetry, "runner_agent_start_process", true);
}

#[tokio::test]
async fn execute_job_omits_inapplicable_sandbox_start_stages() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::without_optional_start_stages();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    for action in [
        "runner_fresh_sandbox_start_backend_launch",
        "runner_fresh_sandbox_start_guest_connection_wait",
        "runner_fresh_sandbox_start_runtime_finalize",
    ] {
        assert_action_success(&telemetry, action, true);
    }
    assert_lacks_action(
        &telemetry,
        "runner_fresh_sandbox_start_snapshot_load_resume",
    );
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_guest_dns_readiness");
    assert_lacks_action(
        &telemetry,
        "runner_fresh_sandbox_start_guest_dns_readiness_attempt",
    );
    assert_action_success(&telemetry, "runner_fresh_sandbox_start", true);
    for phase in GUEST_CONNECTION_PHASE_NAMES {
        for kind in ["full", "remaining"] {
            assert_lacks_action(
                &telemetry,
                &format!("runner_fresh_sandbox_start_guest_connection_{phase}_{kind}"),
            );
        }
    }
}

#[tokio::test]
async fn execute_job_records_failed_sandbox_start_stage_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory =
        ObservedMockSandboxFactory::with_failed_start_stage(SandboxStartStage::GuestConnectionWait);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert!(
        outcome
            .error()
            .is_some_and(|error| error.contains("observed mock start failure"))
    );

    for action in [
        "runner_fresh_sandbox_start_backend_launch",
        "runner_fresh_sandbox_start_snapshot_load_resume",
    ] {
        assert_action_success(&telemetry, action, true);
    }
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_start_guest_connection_wait",
        false,
        Some("sandbox_start_stage_failed"),
    );
    assert_action_duration(
        &telemetry,
        "runner_fresh_sandbox_start_guest_connection_wait",
        32,
    );
    for kind in ["full", "remaining"] {
        assert_action_outcome(
            &telemetry,
            &format!("runner_fresh_sandbox_start_guest_connection_pong_{kind}"),
            false,
            Some("sandbox_start_stage_failed"),
        );
        assert_lacks_action(
            &telemetry,
            &format!("runner_fresh_sandbox_start_guest_connection_client_setup_{kind}"),
        );
        assert_action_success(
            &telemetry,
            &format!("runner_fresh_sandbox_start_guest_connection_task_handoff_{kind}"),
            true,
        );
    }
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_guest_dns_readiness");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start_runtime_finalize");
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_start",
        false,
        Some("sandbox_start_failed"),
    );
}

#[tokio::test]
async fn execute_job_records_failed_fresh_sandbox_factory_stage_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_stage(SandboxCreateStage::NbdCowCreate);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_cow_create",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
    assert_action_success(&telemetry, "sandbox_create", false);
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
}

#[tokio::test]
async fn execute_job_records_failed_nbd_cow_detail_and_parent_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_nbd_cow_stage(
        SandboxNbdCowCreateStage::NetlinkConnect,
    );

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_netlink_connect",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_nbd_cow_create",
        false,
        Some("sandbox_factory_create_stage_failed"),
    );
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
}

#[tokio::test]
async fn execute_job_records_failed_nbd_netlink_detail_and_parent_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = ObservedMockSandboxFactory::with_failed_nbd_netlink_connect_stage(
        SandboxNbdNetlinkConnectStage::ConnectCommand,
    );

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;

    for action in [
        "runner_fresh_sandbox_factory_nbd_netlink_connect_command",
        "runner_fresh_sandbox_factory_nbd_netlink_connect",
        "runner_fresh_sandbox_factory_nbd_cow_create",
    ] {
        assert_action_outcome(
            &telemetry,
            action,
            false,
            Some("sandbox_factory_create_stage_failed"),
        );
    }
    assert_action_outcome(
        &telemetry,
        "runner_fresh_sandbox_factory_create",
        false,
        Some("sandbox_factory_create_failed"),
    );
}

#[tokio::test]
async fn execute_job_reuse_records_runner_pre_spawn_and_reuse_path_timing() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let factory = MockSandboxFactory::new();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, _telemetry) = execute_job(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        cancel,
    )
    .await;
    let sandbox = outcome.sandbox.expect("sandbox should be alive");

    let cancel = tokio_util::sync::CancellationToken::new();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, outcome.source_ip, "test-session").await;
    let mut context = minimal_context();
    context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let (_outcome, telemetry) = execute_job_reuse_with_hooks(
        crate::executor::ReusedSandboxDispatch {
            factory: &MockSandboxFactory::new(),
            idle_sandbox,
            reuse_result: SandboxReuseResult::Reused,
        },
        context,
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    for action in [
        "runner_claim_http_request",
        "runner_claim_request_to_response_headers",
        "runner_claim_response_body_read",
        "runner_claim_response_decode",
        "runner_claim_to_executor_start",
        "runner_executor_start_to_spawn",
        "runner_claim_to_spawn",
        "runner_executor_start_to_agent_ready",
        "runner_claim_to_agent_ready",
        "runner_reused_sandbox_prepare",
        "runner_guest_state_restore",
        "runner_required_private_files_write",
        "runner_agent_env_build",
        "runner_agent_start_process",
        "runner_agent_start_to_ready",
        "runner_agent_containment_create",
        "runner_agent_placement_broker_setup",
        "runner_agent_shell_spawn",
        "runner_agent_bootstrap_ready_wait",
        "api_to_sandbox_start",
        "sandbox_reuse_hit",
        "agent_execute",
    ] {
        assert_has_action(&telemetry, action);
    }
    assert_action_once_with_duration(&telemetry, "runner_claim_http_request", 42);
    assert_action_once_with_duration(&telemetry, "runner_claim_request_to_response_headers", 11);
    assert_action_once_with_duration(&telemetry, "runner_claim_response_body_read", 7);
    assert_action_once_with_duration(&telemetry, "runner_claim_response_decode", 3);
    assert_pre_spawn_phase_actions_succeeded(&telemetry);
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_prepare");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_factory_create");
    for action in FRESH_SANDBOX_FACTORY_STAGE_ACTIONS {
        assert_lacks_action(&telemetry, action);
    }
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_proxy_register");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
    assert_lacks_action(&telemetry, "runner_guest_timezone_sync");
    assert_lacks_action(&telemetry, "workspace_drive_mount");
    assert_lacks_action(&telemetry, "workspace_drive_mount_guest_exec");
    assert_lacks_action(&telemetry, "workspace_drive_mount_guest_exec_unavailable");
}

#[tokio::test]
async fn execute_job_claims_blank_sandbox_without_changing_cold_path_attribution() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let params = default_params();
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(MockSandboxFactory::new()));
    let sandbox_id = SandboxId::new_v4();
    let mut sandbox = factory
        .create(SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            workspace_drive: Some(sandbox::WorkspaceDriveConfig {
                size_mb: params.workspace_disk_mb,
                seed_image: None,
            }),
        })
        .await
        .unwrap();
    sandbox.start().await.unwrap();
    ensure_workspace_drive_mounted(sandbox.as_ref(), sandbox_id)
        .await
        .unwrap();
    assert_eq!(
        sandbox.park().await.unwrap(),
        sandbox::SandboxParkOutcome::Reusable
    );

    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 0 });
    let candidate = ParkedIdleCandidate::blank(
        sandbox,
        Arc::clone(&factory),
        test_budget_lease(),
        sandbox_id,
        "vm0/default".into(),
        None,
    );
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let reserved = pool
        .reserve_blank("vm0/default", &None)
        .expect("blank sandbox should be compatible");
    let (idle_sandbox, budget_lease) = match reserved.try_unpark_for_run(RunId::new_v4()).await {
        IdleUnparkResult::Reused {
            sandbox,
            budget_lease,
        } => (*sandbox, budget_lease),
        IdleUnparkResult::Failed { error, .. } => {
            panic!("blank sandbox should unpark: {error}");
        }
    };

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, telemetry) = execute_job_reuse_with_hooks(
        crate::executor::ReusedSandboxDispatch {
            factory: &MockSandboxFactory::new(),
            idle_sandbox,
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        minimal_context(),
        &config,
        &params,
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks::none(),
    )
    .await;

    assert!(outcome.failure.is_none());
    assert_eq!(
        outcome.workspace_reuse_result,
        Some(WorkspaceReuseResult::NotConfigured)
    );
    assert_has_action(&telemetry, "sandbox_reuse_miss");
    assert_has_action(&telemetry, "sandbox_blank_pool_hit");
    assert_lacks_action(&telemetry, "sandbox_reuse_hit");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_factory_create");
    assert_lacks_action(&telemetry, "runner_fresh_sandbox_start");
    assert_lacks_action(&telemetry, "runner_guest_state_restore");

    let mut sandbox = outcome.sandbox.expect("sandbox should remain alive");
    sandbox.stop().await.unwrap();
    factory.destroy(sandbox).await;
    drop(budget_lease);
}

async fn assert_reused_private_write_timeout_telemetry(
    context: crate::types::ExecutionContext,
    stage: SandboxOperationTimeoutStage,
    expected_outcome: &str,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let sandbox = Box::new(MockSandbox::with_overrides(
        "private-write-timeout",
        Arc::clone(&overrides),
    ));
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    overrides.push_private_write_files_result(Err(SandboxError::OperationTimeout {
        operation: SandboxOperation::WriteFile,
        stage,
        timeout_ms: 60_000,
    }));

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, telemetry) = execute_job_reuse_with_hooks(
        crate::executor::ReusedSandboxDispatch {
            factory: &MockSandboxFactory::new(),
            idle_sandbox,
            reuse_result: SandboxReuseResult::Reused,
        },
        context,
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    assert!(outcome.failure.is_some());
    assert!(outcome.sandbox.is_some());
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ExecutionUncertain)
    );
    assert_action_bounded_outcome(
        &telemetry,
        "runner_required_private_files_write",
        expected_outcome,
    );
    assert_lacks_action(&telemetry, "runner_agent_start_process");
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.private_write_file_calls().is_empty());
    assert_eq!(overrides.private_write_files_calls().len(), 1);
}

async fn assert_reused_required_private_batch_failure(
    error: SandboxError,
    expected_outcome: Option<&str>,
) {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let expected_failure = format!("sandbox error: {error}");
    overrides.push_private_write_files_result(Err(error));
    let sandbox = Box::new(MockSandbox::with_overrides(
        "required-private-batch-failure",
        Arc::clone(&overrides),
    ));
    let source_ip = sandbox.source_ip().to_string();
    let (idle_sandbox, _lease) =
        make_reusable_idle_sandbox(sandbox, source_ip, "test-session").await;
    let context = minimal_context();
    let expected_connector_context_path =
        guest_connector_account_context_file_path(context.run_id).unwrap();

    let cancel = tokio_util::sync::CancellationToken::new();
    let (outcome, telemetry) = execute_job_reuse_with_hooks(
        crate::executor::ReusedSandboxDispatch {
            factory: &MockSandboxFactory::new(),
            idle_sandbox,
            reuse_result: SandboxReuseResult::Reused,
        },
        context,
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases()),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    let operations = telemetry.pending_ops_with_outcome_snapshot();
    let matching: Vec<_> = operations
        .iter()
        .filter(|operation| operation.0 == "runner_required_private_files_write")
        .collect();
    assert_eq!(matching.len(), 1);
    assert!(!matching[0].1);
    assert_eq!(matching[0].2.as_deref(), expected_outcome);
    assert_eq!(matching[0].3, None);
    assert_action_outcome(
        &telemetry,
        "runner_required_private_files_write",
        false,
        None,
    );

    assert!(outcome.sandbox.is_some());
    let failure = outcome
        .failure
        .expect("required private batch failure should stop the run");
    assert_eq!(failure.error, expected_failure);
    assert_eq!(
        outcome.sandbox_reuse_disposition,
        SandboxReuseDisposition::Ineligible(SandboxReuseRejection::ExecutionUncertain)
    );
    assert_lacks_action(&telemetry, "runner_agent_start_process");
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(overrides.private_write_file_calls().is_empty());
    let private_batches = overrides.private_write_files_calls();
    assert_eq!(private_batches.len(), 1);
    assert_eq!(private_batches[0].files.len(), 3);
    assert_eq!(
        private_batches[0].files[0].path,
        expected_connector_context_path
    );
}

#[tokio::test]
async fn reused_required_private_batch_guest_failure_stops() {
    assert_reused_required_private_batch_failure(
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: "permission denied".into(),
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn reused_required_private_batch_before_frame_timeout_stops() {
    assert_reused_required_private_batch_failure(
        SandboxError::OperationTimeout {
            operation: SandboxOperation::WriteFile,
            stage: SandboxOperationTimeoutStage::BeforeFrameWrite,
            timeout_ms: 60_000,
        },
        Some("before_frame_write"),
    )
    .await;
}

#[tokio::test]
async fn reused_required_private_batch_frame_write_timeout_stops() {
    assert_reused_required_private_batch_failure(
        SandboxError::OperationTimeout {
            operation: SandboxOperation::WriteFile,
            stage: SandboxOperationTimeoutStage::FrameWrite,
            timeout_ms: 60_000,
        },
        Some("frame_write"),
    )
    .await;
}

#[tokio::test]
async fn reused_required_private_batch_terminal_response_timeout_stops() {
    assert_reused_required_private_batch_failure(
        SandboxError::OperationTimeout {
            operation: SandboxOperation::WriteFile,
            stage: SandboxOperationTimeoutStage::AwaitingTerminalResponse,
            timeout_ms: 60_000,
        },
        Some("await_terminal_response"),
    )
    .await;
}

#[tokio::test]
async fn reused_required_private_batch_backend_crash_stops() {
    assert_reused_required_private_batch_failure(
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::BackendCrashed,
            message: "firecracker process crashed".into(),
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn reused_required_private_files_timeout_records_bounded_stage_before_agent_start() {
    let context = context_with_env(HashMap::from([(
        "CUSTOM_ENV".to_string(),
        "value".to_string(),
    )]));

    assert_reused_private_write_timeout_telemetry(
        context,
        SandboxOperationTimeoutStage::FrameWrite,
        "frame_write",
    )
    .await;
}

#[tokio::test]
async fn start_process_failure_records_phase_failure_without_spawn_completion() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let concurrency = RunnerPreSpawnConcurrency::default();
    let overrides = std::sync::Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_start_process_error(SandboxError::Operation {
        operation: SandboxOperation::StartProcess,
        reason: SandboxOperationReason::Guest,
        message: "agent spawn failed".into(),
    });
    let factory = MockSandboxFactory::with_overrides(overrides);

    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, telemetry) = execute_job_with_prepared_notifier(
        &factory,
        minimal_context(),
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(RunnerPreSpawnTiming::start_at(
                Instant::now(),
                None,
                &concurrency,
            )),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;

    assert_action_success(&telemetry, "runner_agent_start_process", false);
    assert_action_success(&telemetry, "agent_execute", false);
    assert_lacks_api_claim_timing(&telemetry);
    assert_lacks_action(&telemetry, "runner_executor_start_to_spawn");
    assert_lacks_action(&telemetry, "runner_claim_to_spawn");
    assert_lacks_action(&telemetry, "runner_executor_start_to_agent_ready");
    assert_lacks_action(&telemetry, "runner_claim_to_agent_ready");
    assert_lacks_action(&telemetry, "runner_agent_start_to_ready");
    assert_pre_spawn_concurrency_bucket(
        &telemetry,
        "runner_agent_start_process",
        Some(RunnerPreSpawnConcurrencyBucket::One),
    );

    let mut recovery_context = minimal_context();
    recovery_context.api_start_time = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
    let recovery_factory = MockSandboxFactory::new();
    let cancel = tokio_util::sync::CancellationToken::new();
    let (_outcome, recovery_telemetry) = execute_job_with_prepared_notifier(
        &recovery_factory,
        recovery_context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::PoolMiss,
        },
        &config,
        &default_params(),
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: Some(pre_spawn_timing_with_phases_and_concurrency(&concurrency)),
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        },
    )
    .await;
    assert_pre_spawn_concurrency_bucket(
        &recovery_telemetry,
        "api_to_spawn",
        Some(RunnerPreSpawnConcurrencyBucket::One),
    );
    assert_pre_spawn_concurrency_bucket(
        &recovery_telemetry,
        "api_to_agent_ready",
        Some(RunnerPreSpawnConcurrencyBucket::One),
    );
}
