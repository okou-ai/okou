//! Sandbox preparation, reuse, and post-run cleanup glue.

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use sandbox::{
    Sandbox, SandboxConfig, SandboxCreateObserver, SandboxCreateStage, SandboxError,
    SandboxFactory, SandboxGuestConnectionPhase, SandboxGuestDnsReadinessReason, SandboxId,
    SandboxNbdCowCreateOutcome, SandboxNbdCowCreateStage, SandboxNbdNetlinkConnectStage,
    SandboxStartObserver, SandboxStartStage,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::agent_run::{
    AgentExecutionResult, PreparedGuestRuntime, PreparedRunInputs, ProcessCancelTimeouts,
    RunControls, RunStart, run_in_sandbox_with_process_cancel_timeouts,
};
use super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::diagnostics::{
    AgentStdoutStreamDiagnostics, append_stdout_stream_diagnostics_to_stream_log,
    collect_agent_abnormal_exit_diagnostics, copy_guest_logs, explicit_enospc_evidence,
    read_guest_cli_agent_session_id,
};
use super::env::PreparedRunPayload;
use super::session_id::invalid_session_id_diagnostic_preview;
use super::telemetry::record_workspace_cache_result;
use super::workspace_session_history_materializer::WorkspaceSessionHistoryMaterializer;
use super::{
    ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch,
    PROCESS_CANCEL_TIMEOUTS, RunnerError, RunnerResult, SandboxPreparedNotifier,
    SandboxReuseDisposition, SandboxReuseRejection, SandboxReuseResult, SessionHistoryMaterializer,
    SessionHistoryRestorePlan,
};
use crate::dns::{DnsReadinessLogObservation, inspect_readiness_log_segment};
use crate::duration::duration_ms;
use crate::ids::RunId;
use crate::network_log_manager::NetworkLogSession;
use crate::provider::ConnectorRuntimeSyncRegistration;
use crate::proxy;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_cache::PreparedStorage;
use crate::storage_fingerprints::StorageFingerprints;
use crate::storage_plan::build_storage_plan;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, WorkspaceReuseResult};
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceImageLease, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareLockPolicy, WorkspaceImagePrepareRequest,
};
use crate::workspace_mount::ensure_workspace_drive_mounted;
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

const SLOW_PROXY_REGISTER_THRESHOLD: Duration = Duration::from_secs(3);
const WORKSPACE_DRIVE_MOUNT: &str = "workspace_drive_mount";
const WORKSPACE_DRIVE_MOUNT_GUEST_EXEC: &str = "workspace_drive_mount_guest_exec";
const WORKSPACE_DRIVE_MOUNT_GUEST_EXEC_UNAVAILABLE: &str =
    "workspace_drive_mount_guest_exec_unavailable";
const RUNNER_FRESH_WORKSPACE_IMAGE_PREPARE: &str = "runner_fresh_workspace_image_prepare";
const RUNNER_FRESH_PRE_SPAWN_ADMISSION_WAIT: &str = "runner_fresh_pre_spawn_admission_wait";
const RUNNER_FRESH_SANDBOX_FACTORY_CREATE: &str = "runner_fresh_sandbox_factory_create";
const RUNNER_FRESH_SANDBOX_FACTORY_COW_POOL_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_cow_pool_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DIR_RENAME: &str =
    "runner_fresh_sandbox_factory_workspace_dir_rename";
// `workspace_drive_prepare` contains the seed-copy/fresh-format child stages;
// downstream queries should not sum the parent and child durations together.
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DRIVE_PREPARE: &str =
    "runner_fresh_sandbox_factory_workspace_drive_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_SEED_SPARSE_COPY: &str =
    "runner_fresh_sandbox_factory_workspace_seed_sparse_copy";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_FRESH_FORMAT: &str =
    "runner_fresh_sandbox_factory_workspace_fresh_format";
const RUNNER_FRESH_SANDBOX_FACTORY_SOCK_DIR_PREPARE: &str =
    "runner_fresh_sandbox_factory_sock_dir_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_NETNS_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_netns_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_CREATE: &str =
    "runner_fresh_sandbox_factory_nbd_cow_create";
// NBD detail durations are children of `nbd_cow_create`. Device scan is nested
// again inside device acquire, and netlink details are nested inside netlink
// connect. Downstream queries must not add nested durations to their parents.
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_LAYER_CREATE: &str =
    "runner_fresh_sandbox_factory_nbd_cow_layer_create";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_nbd_device_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_SCAN: &str =
    "runner_fresh_sandbox_factory_nbd_device_scan";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DISPATCH_SETUP: &str =
    "runner_fresh_sandbox_factory_nbd_dispatch_setup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_connect";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_BLOCKING_TASK_QUEUE: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_blocking_task_queue";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_SOCKET_SETUP: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_socket_setup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_FAMILY_RESOLVE: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_family_resolve";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_COMMAND: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_connect_command";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_VERIFY: &str =
    "runner_fresh_sandbox_factory_nbd_size_verify";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_CLEANUP: &str =
    "runner_fresh_sandbox_factory_nbd_retry_cleanup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_DELAY: &str =
    "runner_fresh_sandbox_factory_nbd_retry_delay";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_DEMAND_SCAN: &str =
    "runner_fresh_sandbox_factory_nbd_acquire_source_demand_scan";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_COOLED_CLAIM: &str =
    "runner_fresh_sandbox_factory_nbd_acquire_source_cooled_claim";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_NONE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_none";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_ONE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_one";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_MULTIPLE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_multiple";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_NONE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_none";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_ONE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_one";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_MULTIPLE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_multiple";
const RUNNER_FRESH_SANDBOX_PROXY_REGISTER: &str = "runner_fresh_sandbox_proxy_register";
const RUNNER_FRESH_SANDBOX_START: &str = "runner_fresh_sandbox_start";
const RUNNER_FRESH_SANDBOX_START_BACKEND_LAUNCH: &str = "runner_fresh_sandbox_start_backend_launch";
const RUNNER_FRESH_SANDBOX_START_SNAPSHOT_LOAD_RESUME: &str =
    "runner_fresh_sandbox_start_snapshot_load_resume";
const RUNNER_FRESH_SANDBOX_START_GUEST_CONNECTION_WAIT: &str =
    "runner_fresh_sandbox_start_guest_connection_wait";
const RUNNER_FRESH_SANDBOX_START_GUEST_DNS_READINESS: &str =
    "runner_fresh_sandbox_start_guest_dns_readiness";
const RUNNER_FRESH_SANDBOX_START_RUNTIME_FINALIZE: &str =
    "runner_fresh_sandbox_start_runtime_finalize";
const RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE: &str =
    "runner_fresh_sandbox_retry_without_workspace_image";
const RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY: &str = "runner_fresh_sandbox_dns_readiness_retry";
const RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_CODEX_PREFETCH: &str =
    "runner_fresh_sandbox_retry_without_codex_prefetch";

const WORKSPACE_IMAGE_PREPARE_INVALID_WORKING_DIR: &str =
    "workspace_image_prepare_invalid_working_dir";
const WORKSPACE_IMAGE_PREPARE_LOCK_BUSY: &str = "workspace_image_prepare_lock_busy";
const WORKSPACE_IMAGE_PREPARE_INVALID_METADATA: &str = "workspace_image_prepare_invalid_metadata";
const WORKSPACE_IMAGE_PREPARE_DISK_PRESSURE: &str = "workspace_image_prepare_disk_pressure";
const SANDBOX_FACTORY_CREATE_FAILED: &str = "sandbox_factory_create_failed";
const SANDBOX_FACTORY_CREATE_STAGE_FAILED: &str = "sandbox_factory_create_stage_failed";
const SANDBOX_PROXY_REGISTER_FAILED: &str = "sandbox_proxy_register_failed";
const SANDBOX_START_FAILED: &str = "sandbox_start_failed";
const SANDBOX_START_STAGE_FAILED: &str = "sandbox_start_stage_failed";
const DNS_READINESS_RETRY_PREPARE_FAILED: &str = "replacement_prepare_failed";
const SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN: &str = "cleanup_uncertain";

struct DnsReadinessReplacement {
    started: Instant,
    workspace_fallback: bool,
}

impl DnsReadinessReplacement {
    fn new(workspace_fallback: bool) -> Self {
        Self {
            started: Instant::now(),
            workspace_fallback,
        }
    }

    fn complete(
        self,
        context: &ExecutionContext,
        sandbox_id: SandboxId,
        telemetry: &mut JobTelemetry,
        success: bool,
    ) {
        telemetry.record(
            RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY,
            self.started.elapsed(),
            success,
            (!success).then_some(DNS_READINESS_RETRY_PREPARE_FAILED),
        );
        warn!(
            run_id = %context.run_id,
            sandbox_id = %sandbox_id,
            success,
            workspace_fallback = self.workspace_fallback,
            "guest DNS readiness replacement completed"
        );
    }
}

struct FreshSandboxFactoryCreateObserver<'a> {
    telemetry: &'a mut JobTelemetry,
}

struct FreshSandboxStartObserver<'a> {
    telemetry: &'a mut JobTelemetry,
}

impl SandboxStartObserver for FreshSandboxStartObserver<'_> {
    fn record_dns_readiness_attempt(&mut self, attempt: sandbox::SandboxDnsReadinessAttempt) {
        self.telemetry.record_dns_readiness_attempt(attempt);
    }

    fn record_stage(&mut self, stage: SandboxStartStage, duration: Duration, success: bool) {
        let error = (!success).then_some(SANDBOX_START_STAGE_FAILED);
        self.telemetry.record(
            fresh_sandbox_start_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_guest_connection_phase(
        &mut self,
        phase: SandboxGuestConnectionPhase,
        duration: Duration,
        remaining: Duration,
        success: bool,
    ) {
        let (full_action, remaining_action) = guest_connection_phase_actions(phase);
        let error = (!success).then_some(SANDBOX_START_STAGE_FAILED);
        self.telemetry.record(full_action, duration, success, error);
        self.telemetry
            .record(remaining_action, remaining, success, error);
    }
}

fn guest_connection_phase_actions(
    phase: SandboxGuestConnectionPhase,
) -> (&'static str, &'static str) {
    match phase {
        SandboxGuestConnectionPhase::TaskSchedule => (
            "runner_fresh_sandbox_start_guest_connection_task_schedule_full",
            "runner_fresh_sandbox_start_guest_connection_task_schedule_remaining",
        ),
        SandboxGuestConnectionPhase::ListenerSetup => (
            "runner_fresh_sandbox_start_guest_connection_listener_setup_full",
            "runner_fresh_sandbox_start_guest_connection_listener_setup_remaining",
        ),
        SandboxGuestConnectionPhase::Accept => (
            "runner_fresh_sandbox_start_guest_connection_accept_full",
            "runner_fresh_sandbox_start_guest_connection_accept_remaining",
        ),
        SandboxGuestConnectionPhase::Ready => (
            "runner_fresh_sandbox_start_guest_connection_ready_full",
            "runner_fresh_sandbox_start_guest_connection_ready_remaining",
        ),
        SandboxGuestConnectionPhase::Ping => (
            "runner_fresh_sandbox_start_guest_connection_ping_full",
            "runner_fresh_sandbox_start_guest_connection_ping_remaining",
        ),
        SandboxGuestConnectionPhase::Pong => (
            "runner_fresh_sandbox_start_guest_connection_pong_full",
            "runner_fresh_sandbox_start_guest_connection_pong_remaining",
        ),
        SandboxGuestConnectionPhase::ClientSetup => (
            "runner_fresh_sandbox_start_guest_connection_client_setup_full",
            "runner_fresh_sandbox_start_guest_connection_client_setup_remaining",
        ),
        SandboxGuestConnectionPhase::TaskHandoff => (
            "runner_fresh_sandbox_start_guest_connection_task_handoff_full",
            "runner_fresh_sandbox_start_guest_connection_task_handoff_remaining",
        ),
    }
}

fn fresh_sandbox_start_stage_action(stage: SandboxStartStage) -> &'static str {
    match stage {
        SandboxStartStage::BackendLaunch => RUNNER_FRESH_SANDBOX_START_BACKEND_LAUNCH,
        SandboxStartStage::SnapshotLoadResume => RUNNER_FRESH_SANDBOX_START_SNAPSHOT_LOAD_RESUME,
        SandboxStartStage::GuestConnectionWait => RUNNER_FRESH_SANDBOX_START_GUEST_CONNECTION_WAIT,
        SandboxStartStage::GuestDnsReadiness => RUNNER_FRESH_SANDBOX_START_GUEST_DNS_READINESS,
        SandboxStartStage::RuntimeFinalize => RUNNER_FRESH_SANDBOX_START_RUNTIME_FINALIZE,
    }
}

impl SandboxCreateObserver for FreshSandboxFactoryCreateObserver<'_> {
    fn record_stage(&mut self, stage: SandboxCreateStage, duration: Duration, success: bool) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_cow_stage(
        &mut self,
        stage: SandboxNbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_nbd_cow_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_netlink_connect_stage(
        &mut self,
        stage: SandboxNbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_nbd_netlink_connect_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_cow_outcome(&mut self, outcome: SandboxNbdCowCreateOutcome) {
        self.telemetry.record(
            fresh_sandbox_factory_nbd_cow_outcome_action(outcome),
            Duration::ZERO,
            true,
            None,
        );
    }
}

fn fresh_sandbox_factory_stage_action(stage: SandboxCreateStage) -> &'static str {
    match stage {
        SandboxCreateStage::CowPoolAcquire => RUNNER_FRESH_SANDBOX_FACTORY_COW_POOL_ACQUIRE,
        SandboxCreateStage::WorkspaceDirRename => RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DIR_RENAME,
        SandboxCreateStage::WorkspaceDrivePrepare => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DRIVE_PREPARE
        }
        SandboxCreateStage::WorkspaceSeedSparseCopy => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_SEED_SPARSE_COPY
        }
        SandboxCreateStage::WorkspaceFreshFormat => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_FRESH_FORMAT
        }
        SandboxCreateStage::SockDirPrepare => RUNNER_FRESH_SANDBOX_FACTORY_SOCK_DIR_PREPARE,
        SandboxCreateStage::NetnsAcquire => RUNNER_FRESH_SANDBOX_FACTORY_NETNS_ACQUIRE,
        SandboxCreateStage::NbdCowCreate => RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_CREATE,
    }
}

fn fresh_sandbox_factory_nbd_cow_stage_action(stage: SandboxNbdCowCreateStage) -> &'static str {
    match stage {
        SandboxNbdCowCreateStage::CowLayerCreate => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_LAYER_CREATE
        }
        SandboxNbdCowCreateStage::DeviceAcquire => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_ACQUIRE,
        SandboxNbdCowCreateStage::DeviceScan => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_SCAN,
        SandboxNbdCowCreateStage::DispatchSetup => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DISPATCH_SETUP,
        SandboxNbdCowCreateStage::NetlinkConnect => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT
        }
        SandboxNbdCowCreateStage::SizeVerify => RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_VERIFY,
        SandboxNbdCowCreateStage::RetryCleanup => RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_CLEANUP,
        SandboxNbdCowCreateStage::RetryDelay => RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_DELAY,
    }
}

fn fresh_sandbox_factory_nbd_netlink_connect_stage_action(
    stage: SandboxNbdNetlinkConnectStage,
) -> &'static str {
    match stage {
        SandboxNbdNetlinkConnectStage::BlockingTaskQueue => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_BLOCKING_TASK_QUEUE
        }
        SandboxNbdNetlinkConnectStage::SocketSetup => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_SOCKET_SETUP
        }
        SandboxNbdNetlinkConnectStage::FamilyResolve => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_FAMILY_RESOLVE
        }
        SandboxNbdNetlinkConnectStage::ConnectCommand => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_COMMAND
        }
    }
}

fn fresh_sandbox_factory_nbd_cow_outcome_action(
    outcome: SandboxNbdCowCreateOutcome,
) -> &'static str {
    match outcome {
        SandboxNbdCowCreateOutcome::AcquireSourceDemandScan => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_DEMAND_SCAN
        }
        SandboxNbdCowCreateOutcome::AcquireSourceCooledClaim => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_COOLED_CLAIM
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesNone => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_NONE
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesOne => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_ONE
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesMultiple => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_MULTIPLE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesNone => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_NONE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesOne => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_ONE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesMultiple => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_MULTIPLE
        }
    }
}

#[cfg(test)]
pub(super) async fn execute_new_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    cancel: tokio_util::sync::CancellationToken,
) -> RunnerResult<ExecuteOutcome> {
    let prepared_run_payload = super::env::prepare_run_payload_for_run(context)?;
    execute_new_sandbox_with_prepared_notifier(
        factory,
        context,
        dispatch,
        config,
        params,
        telemetry,
        NewSandboxHooks {
            preparation: crate::executor::sandbox_run::FreshPreparation::Initial,
            controls: RunControls::new(cancel, None),
            prepared_run_payload,
            sandbox_prepared: None,
        },
    )
    .await
}

pub(super) async fn prepare_storage(
    context: &ExecutionContext,
    previous_storage: Option<&StorageFingerprints>,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<PreparedStorage>> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(None);
    };
    let apply_started = Instant::now();
    let result: RunnerResult<Option<PreparedStorage>> = async {
        let runtime_dir = super::guest_runtime_dir(context.run_id)?;
        let mut plan = build_storage_plan(manifest, runtime_dir.as_str(), previous_storage)?;
        let delivery = crate::storage_cache::prepare_fresh_archive_delivery(
            &mut plan,
            &config.home,
            &config.fresh_archive_delivery,
            cancel,
            telemetry,
            Some(&config.decoded_cache),
        )
        .await?;
        Ok(Some(PreparedStorage { plan, delivery }))
    }
    .await;
    if let Err(error) = &result {
        telemetry.record(
            "runner_storage_manifest_apply",
            apply_started.elapsed(),
            false,
            Some(&error.to_string()),
        );
    }
    result
}

pub(super) async fn cancel_prepared_storage(
    controls: &mut RunControls,
    telemetry: &mut JobTelemetry,
) {
    if let Some(mut prepared) = controls.prepared_storage.take() {
        prepared.delivery.cancel_and_drain(telemetry).await;
    }
}

pub(super) async fn execute_new_sandbox_with_prepared_notifier(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    hooks: NewSandboxHooks<'_>,
) -> RunnerResult<ExecuteOutcome> {
    let NewSandboxDispatch {
        id: sandbox_id,
        reuse_result,
    } = dispatch;
    let NewSandboxHooks {
        preparation,
        mut controls,
        prepared_run_payload,
        sandbox_prepared,
    } = hooks;
    // The gate intentionally starts before every fresh preparation stage and remains held through
    // the authenticated Agent-ready boundary. Current production tails span both factory work and
    // the later mount/restore/storage/bootstrap stages, so a narrower Firecracker-only gate would
    // allow the same cohort to reconverge before Agent readiness completes.
    let admission_started = Instant::now();
    let admission_lease = match config
        .pre_spawn_admission
        .acquire(params.vcpu, &controls.cancel)
        .await
    {
        Ok(lease) => {
            let elapsed = admission_started.elapsed();
            telemetry.record(RUNNER_FRESH_PRE_SPAWN_ADMISSION_WAIT, elapsed, true, None);
            let metadata = lease.metadata();
            info!(
                run_id = %context.run_id,
                requested_tokens = metadata.requested_tokens,
                effective_tokens = metadata.effective_tokens,
                total_tokens = metadata.total_tokens,
                contended = metadata.contended,
                duration_ms = duration_ms(elapsed),
                "fresh pre-spawn admission acquired"
            );
            lease
        }
        Err(error) => {
            telemetry.record(
                RUNNER_FRESH_PRE_SPAWN_ADMISSION_WAIT,
                admission_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(error);
        }
    };
    controls.pre_spawn_admission_lease = Some(admission_lease);
    let prepare_started = Instant::now();
    let mut workspace_image = prepare_workspace_image(
        context,
        sandbox_id,
        config,
        &params.profile_name,
        params.workspace_disk_mb,
        params.workspace_image_prepare_lock_policy,
        telemetry,
    )
    .await;
    let prepared_storage = prepare_storage(
        context,
        workspace_image
            .as_ref()
            .and_then(WorkspaceImageLease::previous_storage),
        config,
        &controls.cancel,
        telemetry,
    )
    .await;
    match prepared_storage {
        Ok(prepared_storage) => controls.prepared_storage = prepared_storage,
        Err(error) => {
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(error);
        }
    }
    controls.session_history_restore_plan = resolve_fresh_session_history_restore_plan(
        std::mem::take(&mut controls.session_history_restore_plan),
        workspace_image.as_ref(),
        context,
        config,
        controls.cancel.clone(),
        telemetry,
    )
    .await;
    let mut used_retry = preparation == FreshPreparation::WithoutCodexPrefetchReplacement;
    let mut used_workspace_fallback = false;
    let mut codex_model_catalog_prefetch = preparation == FreshPreparation::Initial;
    let mut dns_replacement: Option<DnsReadinessReplacement> = None;
    let prepared = loop {
        if controls.cancel.is_cancelled() {
            cancel_prepared_storage(&mut controls, telemetry).await;
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(RunnerError::Cancelled);
        }
        let result = create_started_sandbox(
            factory,
            context,
            sandbox_id,
            config,
            params,
            telemetry,
            StartSandboxOptions {
                workspace_image: workspace_image.as_ref(),
                sandbox_prepared,
                reuse_result,
                cancel: &controls.cancel,
                codex_model_catalog_prefetch,
            },
        )
        .await;

        if let Some(replacement) = dns_replacement.take() {
            let success = result.is_ok();
            replacement.complete(context, sandbox_id, telemetry, success);
        }

        let failure = match result {
            Ok(prepared) => break prepared,
            Err(failure) => failure,
        };

        let cache_hit = workspace_image
            .as_ref()
            .is_some_and(WorkspaceImageLease::is_cache_hit);
        if failure.invalidate_consumed_workspace_cache && cache_hit {
            controls.session_history_restore_plan = cancel_local_sidecar_restore_plan(
                std::mem::take(&mut controls.session_history_restore_plan),
            )
            .await;
            invalidate_workspace_cache_hit(
                workspace_image.as_ref(),
                context.run_id,
                "sandbox_prepare_failed",
            )
            .await;
        }
        if used_retry {
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(error);
        }
        let retry_guest_dns = failure.retry == SandboxPrepareRetry::GuestDnsReadiness;
        let retry_without_workspace =
            failure.retry == SandboxPrepareRetry::WithoutWorkspaceImage && cache_hit;
        let retry_without_codex_prefetch =
            failure.retry == SandboxPrepareRetry::WithoutCodexModelCatalogPrefetch;
        if !failure.cleanup_completed {
            if retry_guest_dns {
                telemetry.record(
                    RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY,
                    Duration::ZERO,
                    false,
                    Some(SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN),
                );
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    "guest DNS readiness replacement suppressed after uncertain cleanup"
                );
            } else if retry_without_workspace {
                telemetry.record(
                    RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE,
                    Duration::ZERO,
                    false,
                    Some(SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN),
                );
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    "workspace image fallback suppressed after uncertain cleanup"
                );
            } else if retry_without_codex_prefetch {
                telemetry.record(
                    RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_CODEX_PREFETCH,
                    Duration::ZERO,
                    false,
                    Some(SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN),
                );
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    "Codex prefetch sandbox replacement suppressed after uncertain cleanup"
                );
            }
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(error);
        }
        if !retry_guest_dns && !retry_without_workspace && !retry_without_codex_prefetch {
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            std::mem::take(&mut controls.session_history_restore_plan)
                .cancel_and_drain()
                .await;
            return Err(error);
        }

        if retry_guest_dns {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %failure.error,
                "guest DNS readiness failed; retrying with a fresh sandbox attachment"
            );
            dns_replacement = Some(DnsReadinessReplacement::new(cache_hit));
        }

        if retry_without_codex_prefetch {
            info!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %failure.error,
                "Codex prefetch start crossed the write boundary; retrying with prefetch disabled"
            );
            telemetry.record(
                RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_CODEX_PREFETCH,
                Duration::ZERO,
                true,
                None,
            );
            codex_model_catalog_prefetch = false;
        }

        if cache_hit {
            used_workspace_fallback = true;
            controls.session_history_restore_plan =
                replace_local_sidecar_restore_plan_for_workspace_retry(
                    std::mem::take(&mut controls.session_history_restore_plan),
                    context,
                    config,
                    controls.cancel.clone(),
                    telemetry,
                )
                .await;
            cancel_prepared_storage(&mut controls, telemetry).await;
            invalidate_workspace_cache_hit(
                workspace_image.as_ref(),
                context.run_id,
                "sandbox_prepare_failed",
            )
            .await;
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %failure.error,
                "workspace image cache hit failed during sandbox preparation; retrying with fresh workspace image"
            );
            telemetry.record(
                RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE,
                Duration::ZERO,
                true,
                None,
            );
            workspace_image = None;
            match prepare_storage(context, None, config, &controls.cancel, telemetry).await {
                Ok(prepared_storage) => controls.prepared_storage = prepared_storage,
                Err(error) => {
                    if let Some(replacement) = dns_replacement.take() {
                        replacement.complete(context, sandbox_id, telemetry, false);
                    }
                    telemetry.record(
                        "runner_fresh_sandbox_prepare",
                        prepare_started.elapsed(),
                        false,
                        Some(&error.to_string()),
                    );
                    std::mem::take(&mut controls.session_history_restore_plan)
                        .cancel_and_drain()
                        .await;
                    return Err(error);
                }
            }
        }
        used_retry = true;
    };
    telemetry.record(
        "runner_fresh_sandbox_prepare",
        prepare_started.elapsed(),
        true,
        None,
    );

    let workspace_reuse_result = final_workspace_reuse_result(
        workspace_image.as_ref().map(WorkspaceImageLease::result),
        used_workspace_fallback,
    );

    let mut outcome = execute_prepared_sandbox_run(
        prepared,
        context,
        config,
        RunStart {
            restore_guest_state: params.restore_guest_state,
            reuse_result,
            workspace_reuse_result,
            prev_storage: workspace_image
                .as_ref()
                .and_then(WorkspaceImageLease::previous_storage),
        },
        telemetry,
        PreparedRunInputs::new(controls, prepared_run_payload),
    )
    .await;
    outcome.workspace_image = workspace_image;
    Ok(outcome)
}

pub(super) struct PreparedSandboxRun {
    pub(super) sandbox: Box<dyn Sandbox>,
    pub(super) source_ip: String,
    pub(super) network_log_session: NetworkLogSession,
    pub(super) prepared_guest_runtime: Option<PreparedGuestRuntime>,
}

pub(super) struct SandboxPrepareError {
    error: RunnerError,
    retry: SandboxPrepareRetry,
    cleanup_completed: bool,
    invalidate_consumed_workspace_cache: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SandboxPrepareRetry {
    None,
    WithoutWorkspaceImage,
    GuestDnsReadiness,
    WithoutCodexModelCatalogPrefetch,
}

pub(super) struct NewSandboxHooks<'a> {
    pub(super) preparation: FreshPreparation,
    pub(super) controls: RunControls,
    pub(super) prepared_run_payload: PreparedRunPayload,
    pub(super) sandbox_prepared: Option<&'a SandboxPreparedNotifier>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FreshPreparation {
    Initial,
    /// The blank has already consumed the only replacement attempt.
    WithoutCodexPrefetchReplacement,
}

struct StartSandboxOptions<'a> {
    workspace_image: Option<&'a WorkspaceImageLease>,
    sandbox_prepared: Option<&'a SandboxPreparedNotifier>,
    reuse_result: SandboxReuseResult,
    cancel: &'a CancellationToken,
    codex_model_catalog_prefetch: bool,
}

impl SandboxPrepareError {
    fn retry_without_workspace_image(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::WithoutWorkspaceImage,
            cleanup_completed,
            invalidate_consumed_workspace_cache: false,
        }
    }

    fn guest_dns_readiness(
        error: RunnerError,
        cleanup_completed: bool,
        reason: SandboxGuestDnsReadinessReason,
    ) -> Self {
        let suppress_replacement = matches!(
            reason,
            SandboxGuestDnsReadinessReason::ProcessTimeout
                | SandboxGuestDnsReadinessReason::Deadline
        );
        Self {
            error,
            retry: if suppress_replacement {
                SandboxPrepareRetry::None
            } else {
                SandboxPrepareRetry::GuestDnsReadiness
            },
            cleanup_completed,
            invalidate_consumed_workspace_cache: suppress_replacement,
        }
    }

    fn without_codex_model_catalog_prefetch(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::WithoutCodexModelCatalogPrefetch,
            cleanup_completed,
            invalidate_consumed_workspace_cache: false,
        }
    }

    fn fatal(error: RunnerError) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::None,
            cleanup_completed: false,
            invalidate_consumed_workspace_cache: false,
        }
    }

    fn fatal_after_cleanup(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::None,
            cleanup_completed,
            invalidate_consumed_workspace_cache: false,
        }
    }
}

pub(super) async fn prepare_workspace_image(
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    profile_name: &str,
    workspace_disk_mb: u32,
    lock_policy: WorkspaceImagePrepareLockPolicy,
    telemetry: &mut JobTelemetry,
) -> Option<WorkspaceImageLease> {
    let cache = config.workspace_cache.as_ref()?;
    let prepare_started = Instant::now();
    let reuse_key = context.reuse_key();
    let request = WorkspaceImagePrepareRequest {
        identity: WorkspaceImageLeaseIdentity {
            run_id: context.run_id,
            sandbox_id,
            profile_name,
            reuse_key,
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
        },
        workspace_drive_required: true,
    };
    let lease = match lock_policy {
        WorkspaceImagePrepareLockPolicy::WaitForTransientContention => cache.prepare(request).await,
        WorkspaceImagePrepareLockPolicy::ImmediateFallback => {
            cache.prepare_with_lock_policy(request, lock_policy).await
        }
    };
    let prepare_error = workspace_image_prepare_error(lease.result());
    telemetry.record(
        RUNNER_FRESH_WORKSPACE_IMAGE_PREPARE,
        prepare_started.elapsed(),
        prepare_error.is_none(),
        prepare_error,
    );
    record_workspace_cache_result(telemetry, &lease);
    Some(lease)
}

async fn resolve_fresh_session_history_restore_plan(
    plan: SessionHistoryRestorePlan,
    workspace_image: Option<&WorkspaceImageLease>,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
) -> SessionHistoryRestorePlan {
    let fallback = match plan {
        SessionHistoryRestorePlan::DeferredHashBacked { fallback } => fallback,
        other => return other,
    };
    let Some(workspace_image) = workspace_image else {
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    };
    if !workspace_image.is_cache_hit() {
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    }
    let Some(expected) = RestoredSessionIdentity::from_context(context) else {
        telemetry.record(
            "session_history_workspace_cache_miss",
            Duration::ZERO,
            true,
            Some("identity_mismatch"),
        );
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    };
    let probe_started = Instant::now();
    telemetry.record(
        "session_history_workspace_cache_probe",
        Duration::ZERO,
        true,
        None,
    );
    match workspace_image
        .probe_session_history_sidecar(&expected)
        .await
    {
        Ok(sidecar) => {
            telemetry.record(
                "session_history_workspace_cache_hit",
                probe_started.elapsed(),
                true,
                None,
            );
            let materializer = WorkspaceSessionHistoryMaterializer::start(
                sidecar,
                context.resume_session.as_ref(),
                effective_cli_framework(&context.cli_agent_type),
                &config.session_history_cpu,
                cancel,
            )
            .await;
            SessionHistoryRestorePlan::LocalSidecar {
                materializer,
                fallback,
            }
        }
        Err(reason) => {
            telemetry.record(
                "session_history_workspace_cache_miss",
                probe_started.elapsed(),
                true,
                Some(reason.as_str()),
            );
            start_fresh_session_history_materializer(context, config, cancel, telemetry, fallback)
        }
    }
}

async fn cancel_local_sidecar_restore_plan(
    plan: SessionHistoryRestorePlan,
) -> SessionHistoryRestorePlan {
    match plan {
        SessionHistoryRestorePlan::LocalSidecar {
            materializer,
            fallback,
        } => {
            materializer.cancel().await;
            SessionHistoryRestorePlan::DeferredHashBacked { fallback }
        }
        other => other,
    }
}

async fn replace_local_sidecar_restore_plan_for_workspace_retry(
    plan: SessionHistoryRestorePlan,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
) -> SessionHistoryRestorePlan {
    let fallback = match plan {
        SessionHistoryRestorePlan::LocalSidecar {
            materializer,
            fallback,
        } => {
            materializer.cancel().await;
            fallback
        }
        SessionHistoryRestorePlan::DeferredHashBacked { fallback } => fallback,
        other => return other,
    };
    telemetry.record(
        "session_history_workspace_cache_miss",
        Duration::ZERO,
        true,
        Some("sandbox_retry_without_workspace_image"),
    );
    start_fresh_session_history_materializer(context, config, cancel, telemetry, fallback)
}

fn start_fresh_session_history_materializer(
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
    fallback: Option<super::SessionHistoryRestoreFallback>,
) -> SessionHistoryRestorePlan {
    let started = Instant::now();
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        context.resume_session.as_ref(),
        effective_cli_framework(&context.cli_agent_type),
        cancel,
        Some(&config.session_history_probe),
    );
    telemetry.record(
        "runner_fresh_session_history_materializer_start",
        started.elapsed(),
        true,
        None,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
}

fn workspace_image_prepare_error(result: WorkspaceCacheCheckoutResult) -> Option<&'static str> {
    match result {
        WorkspaceCacheCheckoutResult::Hit
        | WorkspaceCacheCheckoutResult::Miss
        | WorkspaceCacheCheckoutResult::NoReuseKey => None,
        WorkspaceCacheCheckoutResult::InvalidWorkingDir => {
            Some(WORKSPACE_IMAGE_PREPARE_INVALID_WORKING_DIR)
        }
        WorkspaceCacheCheckoutResult::LockBusy => Some(WORKSPACE_IMAGE_PREPARE_LOCK_BUSY),
        WorkspaceCacheCheckoutResult::InvalidMetadata => {
            Some(WORKSPACE_IMAGE_PREPARE_INVALID_METADATA)
        }
        WorkspaceCacheCheckoutResult::DiskPressure => Some(WORKSPACE_IMAGE_PREPARE_DISK_PRESSURE),
    }
}

fn final_workspace_reuse_result(
    checkout_result: Option<WorkspaceCacheCheckoutResult>,
    used_workspace_fallback: bool,
) -> WorkspaceReuseResult {
    if used_workspace_fallback {
        return WorkspaceReuseResult::SandboxPrepareFallback;
    }
    match checkout_result {
        Some(WorkspaceCacheCheckoutResult::Hit) => WorkspaceReuseResult::Reused,
        Some(WorkspaceCacheCheckoutResult::Miss) => WorkspaceReuseResult::CacheMiss,
        Some(WorkspaceCacheCheckoutResult::NoReuseKey) => WorkspaceReuseResult::NoReuseKey,
        Some(WorkspaceCacheCheckoutResult::InvalidWorkingDir) => {
            WorkspaceReuseResult::InvalidWorkingDir
        }
        Some(WorkspaceCacheCheckoutResult::LockBusy) => WorkspaceReuseResult::LockBusy,
        Some(WorkspaceCacheCheckoutResult::InvalidMetadata) => {
            WorkspaceReuseResult::InvalidMetadata
        }
        Some(WorkspaceCacheCheckoutResult::DiskPressure) => WorkspaceReuseResult::DiskPressure,
        None => WorkspaceReuseResult::NotConfigured,
    }
}

async fn create_started_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    options: StartSandboxOptions<'_>,
) -> Result<PreparedSandboxRun, SandboxPrepareError> {
    let StartSandboxOptions {
        workspace_image,
        sandbox_prepared,
        reuse_result,
        cancel,
        codex_model_catalog_prefetch,
    } = options;
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: params.vcpu,
            memory_mb: params.memory_mb,
        },
        device_rate_limits: params.device_rate_limits.clone(),
        workspace_drive: workspace_image.map_or_else(
            || {
                Some(sandbox::WorkspaceDriveConfig {
                    size_mb: params.workspace_disk_mb,
                    seed_image: None,
                })
            },
            WorkspaceImageLease::workspace_drive_config,
        ),
    };

    info!(run_id = %context.run_id, sandbox_id = %sandbox_id, "creating sandbox");
    let t = Instant::now();
    let factory_create_started = Instant::now();
    let create_result = {
        let mut observer = FreshSandboxFactoryCreateObserver { telemetry };
        factory
            .create_with_observer(sandbox_config, &mut observer)
            .await
    };
    let mut sandbox = match create_result {
        Ok(s) => {
            telemetry.record(
                RUNNER_FRESH_SANDBOX_FACTORY_CREATE,
                factory_create_started.elapsed(),
                true,
                None,
            );
            s
        }
        Err(e) => {
            telemetry.record(
                RUNNER_FRESH_SANDBOX_FACTORY_CREATE,
                factory_create_started.elapsed(),
                false,
                Some(SANDBOX_FACTORY_CREATE_FAILED),
            );
            telemetry.record("sandbox_create", t.elapsed(), false, Some(&e.to_string()));
            return Err(SandboxPrepareError::retry_without_workspace_image(
                e.into(),
                true,
            ));
        }
    };

    if let Err(error) = sandbox.bind_run_control(&context.run_id.to_string()) {
        telemetry.record(
            "sandbox_create",
            t.elapsed(),
            false,
            Some(&error.to_string()),
        );
        let _ = destroy_sandbox_panic_safe(factory, sandbox).await;
        return Err(SandboxPrepareError::fatal(error.into()));
    }

    let source_ip = sandbox.source_ip().to_string();
    let proxy_register_started = Instant::now();
    let network_log_session = match register_proxy(config, context, &source_ip).await {
        Ok(session) => {
            let proxy_register_elapsed = proxy_register_started.elapsed();
            telemetry.record(
                RUNNER_FRESH_SANDBOX_PROXY_REGISTER,
                proxy_register_elapsed,
                true,
                None,
            );
            log_proxy_register_success(
                context.run_id,
                sandbox_id,
                &params.profile_name,
                proxy_register_elapsed,
            );
            session
        }
        Err(e) => {
            let proxy_register_elapsed = proxy_register_started.elapsed();
            telemetry.record(
                RUNNER_FRESH_SANDBOX_PROXY_REGISTER,
                proxy_register_elapsed,
                false,
                Some(SANDBOX_PROXY_REGISTER_FAILED),
            );
            log_proxy_register_failure(
                context.run_id,
                sandbox_id,
                &params.profile_name,
                proxy_register_elapsed,
                &e.to_string(),
            );
            telemetry.record("sandbox_create", t.elapsed(), false, Some(&e.to_string()));
            let _ = destroy_sandbox_panic_safe(factory, sandbox).await;
            return Err(SandboxPrepareError::fatal(e));
        }
    };

    let network_log_path = config.log_paths.network_log(context.run_id);
    let network_log_start_offset = match tokio::fs::metadata(&network_log_path).await {
        Ok(metadata) => Some(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
        Err(error) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                io_kind = ?error.kind(),
                "failed to capture network log offset before sandbox start"
            );
            None
        }
    };
    let sandbox_start_started = Instant::now();
    let start_result = {
        let mut observer = FreshSandboxStartObserver { telemetry };
        sandbox.start_with_observer(&mut observer).await
    };
    if let Err(e) = start_result {
        let guest_dns_readiness_reason = match &e {
            SandboxError::GuestDnsReadiness { reason, .. } => Some(*reason),
            _ => None,
        };
        telemetry.record(
            RUNNER_FRESH_SANDBOX_START,
            sandbox_start_started.elapsed(),
            false,
            Some(SANDBOX_START_FAILED),
        );
        telemetry.record("sandbox_create", t.elapsed(), false, Some(&e.to_string()));
        let unregister_completed =
            match unregister_proxy_registry(config, &source_ip, context.run_id).await {
                Ok(()) => true,
                Err(unregister_error) => {
                    warn!(
                        run_id = %context.run_id,
                        error = %unregister_error,
                        "failed to unregister sandbox from proxy after sandbox start failure"
                    );
                    false
                }
            };
        let network_log_observation = network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        if guest_dns_readiness_reason.is_some() {
            let observation = match network_log_start_offset {
                Some(start_offset) => {
                    inspect_readiness_log_segment(&network_log_path, start_offset).await
                }
                None => DnsReadinessLogObservation::unavailable(),
            };
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                source_ip,
                query_observed = observation.query_observed,
                result_observed = observation.result_observed,
                scan_status = observation.status.as_str(),
                dns_drain_status = network_log_observation.drain_status("dns"),
                kmsg_drain_status = network_log_observation.drain_status("kmsg"),
                writer_backpressure_observed = network_log_observation.writer_backpressure_observed(),
                writer_failed = network_log_observation.writer_failed(),
                "guest DNS readiness network log observation"
            );
        }
        let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
            .await
            .is_completed();
        let cleanup_completed = unregister_completed && destroy_completed;
        let error = e.into();
        return Err(match guest_dns_readiness_reason {
            Some(reason) => {
                SandboxPrepareError::guest_dns_readiness(error, cleanup_completed, reason)
            }
            None => SandboxPrepareError::retry_without_workspace_image(error, cleanup_completed),
        });
    }
    telemetry.record(
        RUNNER_FRESH_SANDBOX_START,
        sandbox_start_started.elapsed(),
        true,
        None,
    );
    telemetry.record("sandbox_create", t.elapsed(), true, None);

    let mut prepared_guest_runtime = if codex_model_catalog_prefetch {
        PreparedGuestRuntime::prepare_for_codex_model_catalog_prefetch(
            sandbox.as_ref(),
            context,
            params.restore_guest_state,
            reuse_result,
            cancel,
            telemetry,
        )
        .await
    } else {
        Some(
            PreparedGuestRuntime::prepare_without_codex_model_catalog_prefetch(
                sandbox.as_ref(),
                context,
                params.restore_guest_state,
                cancel,
                telemetry,
            )
            .await,
        )
    };
    prepared_guest_runtime = match prepared_guest_runtime {
        Some(PreparedGuestRuntime::SandboxUnusable(error)) => {
            let unregister_completed = match unregister_proxy_registry(
                config,
                &source_ip,
                context.run_id,
            )
            .await
            {
                Ok(()) => true,
                Err(unregister_error) => {
                    warn!(
                        run_id = %context.run_id,
                        error = %unregister_error,
                        "failed to unregister sandbox from proxy after unsafe Codex prefetch start failure"
                    );
                    false
                }
            };
            network_log_session
                .close_for_upload(context.run_id, &config.network_log_drain)
                .await;
            let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
                .await
                .is_completed();
            return Err(SandboxPrepareError::without_codex_model_catalog_prefetch(
                error,
                unregister_completed && destroy_completed,
            ));
        }
        prepared_guest_runtime => prepared_guest_runtime,
    };

    let mount_started = Instant::now();
    let mount_result = ensure_workspace_drive_mounted(sandbox.as_ref(), context.run_id).await;
    let mount_duration = mount_started.elapsed();
    let guest_duration = match mount_result {
        Ok(guest_duration) => guest_duration,
        Err(e) => {
            telemetry.record(
                WORKSPACE_DRIVE_MOUNT,
                mount_duration,
                false,
                Some(&e.error.to_string()),
            );
            record_workspace_drive_mount_guest_exec(telemetry, e.guest_duration, false);
            if let Some(prepared_guest_runtime) = prepared_guest_runtime.take() {
                prepared_guest_runtime
                    .finish(sandbox.as_ref(), telemetry)
                    .await;
            }
            let unregister_completed =
                match unregister_proxy_registry(config, &source_ip, context.run_id).await {
                    Ok(()) => true,
                    Err(unregister_error) => {
                        warn!(
                            run_id = %context.run_id,
                            error = %unregister_error,
                            "failed to unregister sandbox from proxy after workspace mount failure"
                        );
                        false
                    }
                };
            network_log_session
                .close_for_upload(context.run_id, &config.network_log_drain)
                .await;
            let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
                .await
                .is_completed();
            return Err(SandboxPrepareError::retry_without_workspace_image(
                e.error,
                unregister_completed && destroy_completed,
            ));
        }
    };
    telemetry.record(WORKSPACE_DRIVE_MOUNT, mount_duration, true, None);
    record_workspace_drive_mount_guest_exec(telemetry, guest_duration, true);
    if let Some(notifier) = sandbox_prepared
        && let Err(error) = notifier.notify(context.run_id, sandbox_id).await
    {
        if let Some(prepared_guest_runtime) = prepared_guest_runtime.take() {
            prepared_guest_runtime
                .finish(sandbox.as_ref(), telemetry)
                .await;
        }
        let unregister_completed = match unregister_proxy_registry(
            config,
            &source_ip,
            context.run_id,
        )
        .await
        {
            Ok(()) => true,
            Err(unregister_error) => {
                warn!(
                    run_id = %context.run_id,
                    error = %unregister_error,
                    "failed to unregister sandbox from proxy after ownership publication failure"
                );
                false
            }
        };
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
            .await
            .is_completed();
        return Err(SandboxPrepareError::fatal_after_cleanup(
            error,
            unregister_completed && destroy_completed,
        ));
    }

    Ok(PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
        prepared_guest_runtime,
    })
}

fn record_workspace_drive_mount_guest_exec(
    telemetry: &mut JobTelemetry,
    guest_duration: Option<Duration>,
    success: bool,
) {
    match guest_duration {
        Some(duration) => {
            telemetry.record(WORKSPACE_DRIVE_MOUNT_GUEST_EXEC, duration, success, None)
        }
        None => telemetry.record_bounded_outcome(
            WORKSPACE_DRIVE_MOUNT_GUEST_EXEC_UNAVAILABLE,
            success,
            "unavailable",
            None,
        ),
    }
}

pub(super) async fn invalidate_workspace_cache_hit(
    workspace_image: Option<&WorkspaceImageLease>,
    run_id: RunId,
    reason: &str,
) {
    let Some(workspace_image) = workspace_image else {
        return;
    };
    if !workspace_image.is_cache_hit() {
        return;
    }
    if let Err(e) = workspace_image.invalidate(run_id, reason).await {
        warn!(
            run_id = %run_id,
            reason,
            error = %e,
            "failed to invalidate workspace image cache entry"
        );
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DestroySandboxOutcome {
    Completed,
    Uncertain,
}

impl DestroySandboxOutcome {
    pub(super) fn is_completed(self) -> bool {
        matches!(self, Self::Completed)
    }
}

pub(super) async fn destroy_sandbox_panic_safe(
    factory: &dyn SandboxFactory,
    sandbox: Box<dyn Sandbox>,
) -> DestroySandboxOutcome {
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("sandbox destroy panicked after start failure");
        DestroySandboxOutcome::Uncertain
    } else {
        DestroySandboxOutcome::Completed
    }
}

pub(super) async fn execute_prepared_sandbox_run(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
) -> ExecuteOutcome {
    execute_prepared_sandbox_run_with_process_cancel_timeouts(
        run,
        context,
        config,
        start,
        telemetry,
        inputs,
        PROCESS_CANCEL_TIMEOUTS,
    )
    .await
}

pub(super) async fn execute_prepared_sandbox_run_with_process_cancel_timeouts(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> ExecuteOutcome {
    let PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
        prepared_guest_runtime,
    } = run;
    let cleanup_cancel = inputs.controls.cancel.clone();
    let ssh = config
        .ssh
        .as_ref()
        .and_then(|runtime| runtime.install(sandbox.as_ref(), context.run_id, &cleanup_cancel));
    let reuse_result = start.reuse_result;
    let workspace_reuse_result = start.workspace_reuse_result;

    let mut inputs = inputs;
    inputs.controls.prepared_guest_runtime = prepared_guest_runtime;
    let result = run_in_sandbox_with_process_cancel_timeouts(
        sandbox.as_ref(),
        context,
        config,
        start,
        telemetry,
        inputs,
        process_cancel_timeouts,
    )
    .await;

    if let Some(ssh) = ssh {
        ssh.shutdown().await;
    }

    let pre_process_resource_diagnostics = match result.as_ref() {
        Err(error) if explicit_enospc_evidence([error.to_string().as_str()]) => {
            collect_agent_abnormal_exit_diagnostics(
                sandbox.as_ref(),
                context.run_id,
                sandbox.id(),
                reuse_result,
                1,
            )
            .await
        }
        Ok(_) | Err(_) => None,
    };

    let stdout_stream_diagnostics = result.as_ref().map_or_else(
        |_| AgentStdoutStreamDiagnostics::default(),
        |result| result.stdout_stream_diagnostics,
    );
    let restored_session_identity = result
        .as_ref()
        .ok()
        .and_then(|result| result.reusable_session_identity.clone());

    let cleanup_result = post_job_cleanup(
        sandbox.as_ref(),
        config,
        context,
        &source_ip,
        cleanup_cancel.is_cancelled(),
        stdout_stream_diagnostics,
    )
    .await;

    let mut agent_result = match result {
        Ok(result) => result,
        Err(e) => AgentExecutionResult::failure_from_error(e.to_string())
            .with_resource_diagnostics(pre_process_resource_diagnostics),
    };
    if let Err(e) = cleanup_result {
        warn!(
            run_id = %context.run_id,
            error = %e,
            "post-job proxy cleanup failed"
        );
        if agent_result.failure.is_none() {
            agent_result.failure = Some(ExecutionFailure::from_error(format!(
                "post-job proxy cleanup failed: {e}"
            )));
        }
        agent_result.sandbox_reuse_disposition =
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::PostJobCleanupFailure);
    }

    // Read the CLI-generated session ID after execution only when no ID was supplied.
    let discovered_cli_agent_session_id = if context.cli_agent_session_id().is_none() {
        let id = read_guest_cli_agent_session_id(sandbox.as_ref(), context.run_id)
            .await
            .and_then(|id| normalize_guest_cli_agent_session_id(context, id));
        if let Some(ref sid) = id {
            info!(
                run_id = %context.run_id,
                session_id = %sid,
                "read guest CLI agent session ID after execution"
            );
        }
        id
    } else {
        None
    };

    ExecuteOutcome {
        failure: agent_result.failure,
        active_input_delivery_ids: agent_result.active_input_delivery_ids,
        sandbox_reuse_disposition: agent_result.sandbox_reuse_disposition,
        sandbox: Some(sandbox),
        source_ip,
        network_log_session: Some(network_log_session),
        workspace_image: None,
        workspace_reuse_result: Some(workspace_reuse_result),
        discovered_cli_agent_session_id,
        restored_session_identity,
    }
}

fn normalize_guest_cli_agent_session_id(
    context: &ExecutionContext,
    session_id: String,
) -> Option<String> {
    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::Codex => canonical_codex_thread_id(&session_id).or_else(|| {
            warn!(
                run_id = %context.run_id,
                framework = "codex",
                session_id = %invalid_session_id_diagnostic_preview(&session_id),
                "ignoring invalid guest session ID for framework"
            );
            None
        }),
        EffectiveCliFramework::ClaudeCode => {
            if is_valid_cli_agent_session_id(&session_id) {
                Some(session_id)
            } else {
                warn!(
                    run_id = %context.run_id,
                    framework = "claude-code",
                    session_id = %invalid_session_id_diagnostic_preview(&session_id),
                    "ignoring invalid guest session ID for framework"
                );
                None
            }
        }
        EffectiveCliFramework::Pi => {
            if is_valid_cli_agent_session_id(&session_id) {
                Some(session_id)
            } else {
                warn!(
                    run_id = %context.run_id,
                    framework = "pi",
                    session_id = %invalid_session_id_diagnostic_preview(&session_id),
                    "ignoring invalid guest session ID for framework"
                );
                None
            }
        }
    }
}

/// Register a sandbox in the proxy registry and network log manager.
pub(super) async fn register_proxy(
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
) -> RunnerResult<NetworkLogSession> {
    let network_log_path = config.log_paths.network_log(context.run_id);
    let proxy_log_path = config.log_paths.proxy_log(context.run_id);
    let run_id_str = context.run_id.to_string();
    let cli_agent_type = normalized_cli_agent_type(&context.cli_agent_type);
    let registration = proxy::SandboxRegistration {
        run_id: &run_id_str,
        cli_agent_type,
        sandbox_token: &context.sandbox_token,
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: context.firewalls.as_deref(),
        network_policies: context.network_policies.as_ref(),
        connector_runtime_targets: Some(&context.connector_runtime_targets),
        encrypted_secrets: context.encrypted_secrets.as_deref(),
        secret_connector_map: context.secret_connector_map.as_ref(),
        secret_connector_metadata_map: context.secret_connector_metadata_map.as_ref(),
        vars: context.vars.as_ref(),
        capture_network_bodies: context.capture_network_bodies.unwrap_or(false),
        billable_firewalls: &context.billable_firewalls,
        model_usage_provider: context.model_usage_provider.as_deref(),
    };
    config
        .registry
        .register_sandbox(source_ip, &registration)
        .await
        .map_err(|e| RunnerError::Internal(format!("register sandbox in proxy registry: {e}")))?;
    let network_log_session = config
        .network_log_manager
        .register_source_ip(source_ip, network_log_path)
        .await;
    if let Some(runtime_sync) = config.connector_runtime_sync.as_ref() {
        runtime_sync
            .register_run(ConnectorRuntimeSyncRegistration {
                run_id: context.run_id,
                source_ip,
                registry: config.registry.clone(),
                targets: &context.connector_runtime_targets,
                refreshes: context.network_policy_refreshes.as_ref(),
            })
            .await;
    }
    Ok(network_log_session)
}

pub(super) fn log_proxy_register_success(
    run_id: RunId,
    sandbox_id: SandboxId,
    profile: &str,
    elapsed: Duration,
) {
    if elapsed < SLOW_PROXY_REGISTER_THRESHOLD {
        info!(
            stage = "proxy_register",
            elapsed_ms = duration_ms(elapsed),
            threshold_ms = duration_ms(SLOW_PROXY_REGISTER_THRESHOLD),
            success = true,
            run_id = %run_id,
            sandbox_id = %sandbox_id,
            profile,
            "proxy register timing"
        );
        return;
    }
    warn!(
        stage = "proxy_register",
        elapsed_ms = duration_ms(elapsed),
        threshold_ms = duration_ms(SLOW_PROXY_REGISTER_THRESHOLD),
        success = true,
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        profile,
        "slow proxy register"
    );
}

pub(super) fn log_proxy_register_failure(
    run_id: RunId,
    sandbox_id: SandboxId,
    profile: &str,
    elapsed: Duration,
    error: &str,
) {
    warn!(
        stage = "proxy_register",
        elapsed_ms = duration_ms(elapsed),
        success = false,
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        profile,
        error,
        "proxy register failed"
    );
}

/// Unregister a sandbox from the proxy registry.
pub(super) async fn unregister_proxy_registry(
    config: &ExecutorConfig,
    source_ip: &str,
    run_id: RunId,
) -> RunnerResult<()> {
    let result = config
        .registry
        .unregister_sandbox(source_ip)
        .await
        .map_err(|e| RunnerError::Internal(format!("unregister sandbox from proxy registry: {e}")));
    if let Some(runtime_sync) = config.connector_runtime_sync.as_ref() {
        runtime_sync.unregister_run(run_id).await;
    }
    result
}

/// Post-job cleanup: copy logs, unregister proxy registry.
///
/// Called after `run_in_sandbox` completes, whether the sandbox will be
/// parked (keep-alive) or destroyed. Rust-side network-log attribution stays
/// open until `sandbox_finalization` quiesces the sandbox and closes the returned
/// `NetworkLogSession`; the HTTP upload remains deferred after `provider.complete`.
pub(super) async fn post_job_cleanup(
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
    cancelled: bool,
    stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
) -> RunnerResult<()> {
    copy_guest_logs(sandbox, context, &config.log_paths, cancelled).await;
    append_stdout_stream_diagnostics_to_stream_log(
        context.run_id,
        &config.log_paths.system_stream_log(context.run_id),
        stdout_stream_diagnostics,
    )
    .await;
    unregister_proxy_registry(config, source_ip, context.run_id).await
}
