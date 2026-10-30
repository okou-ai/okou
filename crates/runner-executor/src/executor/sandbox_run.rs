//! Sandbox preparation, reuse, and post-run cleanup glue.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;
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
    AgentExecutionResult, AgentRunLifecycle, PreparedGuestRuntime, PreparedRunInputs,
    ProcessCancelTimeouts, RunControls, RunStart, run_in_sandbox_with_process_cancel_timeouts,
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
use super::{
    ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch,
    PROCESS_CANCEL_TIMEOUTS, RunnerError, RunnerResult, SandboxPreparedNotifier,
    SandboxReuseDisposition, SandboxReuseRejection, SandboxReuseResult,
};
use crate::dns::{DnsReadinessLogObservation, inspect_readiness_log_segment};
use crate::duration::duration_ms;
use crate::home_image_cache::{
    HomeCacheCheckoutResult, HomeImageLease, HomeImageLeaseIdentity, HomeImagePreparePolicy,
    HomeImagePrepareRequest,
};
use crate::home_mount::ensure_home_drive_mounted;
use crate::network_log_manager::NetworkLogSession;
use crate::proxy;
use crate::storage_cache::PreparedStorage;
use crate::storage_fingerprints::StorageFingerprints;
use crate::storage_plan::build_storage_plan;
use crate::telemetry::JobTelemetry;
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use runner_provider::ConnectorRuntimeSyncRegistration;
use runner_types::ids::RunId;
use runner_types::types::{ExecutionContext, HomeReuseResult};

const SLOW_PROXY_REGISTER_THRESHOLD: Duration = Duration::from_secs(3);
const HOME_DRIVE_MOUNT: &str = "home_drive_mount";
const HOME_DRIVE_MOUNT_GUEST_EXEC: &str = "home_drive_mount_guest_exec";
const HOME_DRIVE_MOUNT_GUEST_EXEC_UNAVAILABLE: &str = "home_drive_mount_guest_exec_unavailable";
const RUNNER_FRESH_HOME_IMAGE_PREPARE: &str = "runner_fresh_home_image_prepare";
const RUNNER_FRESH_PRE_SPAWN_ADMISSION_WAIT: &str = "runner_fresh_pre_spawn_admission_wait";
const RUNNER_FRESH_SANDBOX_FACTORY_CREATE: &str = "runner_fresh_sandbox_factory_create";
const RUNNER_FRESH_SANDBOX_FACTORY_COW_POOL_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_cow_pool_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DIR_RENAME: &str =
    "runner_fresh_sandbox_factory_workspace_dir_rename";
// `home_drive_prepare` contains the seed-copy/fresh-format child stages;
// downstream queries should not sum the parent and child durations together.
const RUNNER_FRESH_SANDBOX_FACTORY_HOME_DRIVE_PREPARE: &str =
    "runner_fresh_sandbox_factory_home_drive_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_HOME_SEED_SPARSE_COPY: &str =
    "runner_fresh_sandbox_factory_home_seed_sparse_copy";
const RUNNER_FRESH_SANDBOX_FACTORY_HOME_FRESH_FORMAT: &str =
    "runner_fresh_sandbox_factory_home_fresh_format";
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
const RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY: &str = "runner_fresh_sandbox_dns_readiness_retry";
const RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_CODEX_PREFETCH: &str =
    "runner_fresh_sandbox_retry_without_codex_prefetch";

const HOME_IMAGE_PREPARE_INVALID_WORKING_DIR: &str = "home_image_prepare_invalid_working_dir";
const HOME_IMAGE_PREPARE_LOCK_BUSY: &str = "home_image_prepare_lock_busy";
const HOME_IMAGE_PREPARE_INVALID_METADATA: &str = "home_image_prepare_invalid_metadata";
const HOME_IMAGE_PREPARE_DISK_PRESSURE: &str = "home_image_prepare_disk_pressure";
const SANDBOX_FACTORY_CREATE_FAILED: &str = "sandbox_factory_create_failed";
const SANDBOX_FACTORY_CREATE_STAGE_FAILED: &str = "sandbox_factory_create_stage_failed";
pub(super) const SANDBOX_PROXY_REGISTER_FAILED: &str = "sandbox_proxy_register_failed";
const SANDBOX_START_FAILED: &str = "sandbox_start_failed";
const SANDBOX_START_STAGE_FAILED: &str = "sandbox_start_stage_failed";
const DNS_READINESS_RETRY_PREPARE_FAILED: &str = "replacement_prepare_failed";
const SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN: &str = "cleanup_uncertain";

struct DnsReadinessReplacement {
    started: Instant,
    home_fallback: bool,
}

impl DnsReadinessReplacement {
    fn new(home_fallback: bool) -> Self {
        Self {
            started: Instant::now(),
            home_fallback,
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
            home_fallback = self.home_fallback,
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
        SandboxCreateStage::HomeDrivePrepare => RUNNER_FRESH_SANDBOX_FACTORY_HOME_DRIVE_PREPARE,
        SandboxCreateStage::HomeSeedSparseCopy => {
            RUNNER_FRESH_SANDBOX_FACTORY_HOME_SEED_SPARSE_COPY
        }
        SandboxCreateStage::HomeFreshFormat => RUNNER_FRESH_SANDBOX_FACTORY_HOME_FRESH_FORMAT,
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
        let mut plan = build_storage_plan(manifest, previous_storage)?;
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
            return Err(error);
        }
    };
    controls.pre_spawn_admission_lease = Some(admission_lease);
    let prepare_started = Instant::now();
    let mut home_image = if preparation == FreshPreparation::DiskReplacement {
        None
    } else {
        prepare_home_image(context, sandbox_id, config, params, telemetry).await
    };
    let prepared_storage = prepare_storage(
        context,
        home_image
            .as_ref()
            .and_then(HomeImageLease::previous_storage),
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
            return Err(error);
        }
    }
    controls.home_history_proof = home_image
        .as_ref()
        .filter(|image| image.is_cache_hit())
        .and_then(|image| image.history_proof_binding().cloned());
    let mut used_retry = preparation != FreshPreparation::Initial;
    let mut used_home_fallback = preparation == FreshPreparation::DiskReplacement;
    let mut codex_model_catalog_prefetch = preparation == FreshPreparation::Initial;
    let mut dns_replacement: Option<DnsReadinessReplacement> = None;
    let prepared = 'preparation: {
        let error = loop {
            if controls.cancel.is_cancelled() {
                cancel_prepared_storage(&mut controls, telemetry).await;
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
                    home_image: home_image.as_mut(),
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
                Ok(prepared) => break 'preparation prepared,
                Err(failure) => failure,
            };
            if !failure.cleanup_completed
                && let Some(recovery) = controls.sandbox_recovery.as_ref()
            {
                recovery.uncertain(context.run_id, sandbox_id);
            }

            let cache_hit = home_image
                .as_ref()
                .is_some_and(HomeImageLease::is_cache_hit);
            if let Some(image) = home_image.as_ref().filter(|image| image.is_cache_hit()) {
                telemetry.observe_home(image.consumption_observation(
                    Some(context.run_id),
                    runner_host::home_observation::HomeObservationOutcome::Failed,
                    Some(
                        if !used_retry
                            && !failure.cleanup_completed
                            && failure.retry == SandboxPrepareRetry::WithoutHomeImage
                        {
                            SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN
                        } else {
                            "sandbox_prepare_failed"
                        },
                    ),
                ));
            }
            if failure.invalidate_consumed_home_cache && cache_hit {
                controls.home_history_proof = None;
                invalidate_home_cache_hit(
                    home_image.as_ref(),
                    context.run_id,
                    "sandbox_prepare_failed",
                )
                .await;
            }
            if used_retry {
                break failure.error;
            }
            let retry_guest_dns = failure.retry == SandboxPrepareRetry::GuestDnsReadiness;
            let retry_without_home_image =
                failure.retry == SandboxPrepareRetry::WithoutHomeImage && cache_hit;
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
                } else if retry_without_home_image {
                    warn!(
                        run_id = %context.run_id,
                        sandbox_id = %sandbox_id,
                        "home image fallback suppressed after uncertain cleanup"
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
                break failure.error;
            }
            if !retry_guest_dns && !retry_without_home_image && !retry_without_codex_prefetch {
                break failure.error;
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
                let reason = if retry_guest_dns {
                    "guest_dns_replacement"
                } else if retry_without_codex_prefetch {
                    "codex_prefetch_replacement"
                } else {
                    "home_preparation_failed"
                };
                telemetry.set_home_non_reuse_reason(reason);
                if let Some(image) = &home_image {
                    telemetry.observe_home(image.consumption_observation(
                        Some(context.run_id),
                        runner_host::home_observation::HomeObservationOutcome::Fallback,
                        Some(reason),
                    ));
                }
                used_home_fallback = true;
                controls.home_history_proof = None;
                cancel_prepared_storage(&mut controls, telemetry).await;
                invalidate_home_cache_hit(
                    home_image.as_ref(),
                    context.run_id,
                    "sandbox_prepare_failed",
                )
                .await;
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    error = %failure.error,
                    "home image cache hit failed during sandbox preparation; retrying with fresh home image"
                );
                home_image = None;
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
                        return Err(error);
                    }
                }
            }
            used_retry = true;
        };
        telemetry.record(
            "runner_fresh_sandbox_prepare",
            prepare_started.elapsed(),
            false,
            Some(&error.to_string()),
        );
        cancel_prepared_storage(&mut controls, telemetry).await;
        return Err(error);
    };
    telemetry.record(
        "runner_fresh_sandbox_prepare",
        prepare_started.elapsed(),
        true,
        None,
    );

    let home_reuse_result = final_home_reuse_result(
        home_image.as_ref().map(HomeImageLease::result),
        used_home_fallback,
    );
    telemetry.set_home_startup_source(
        home_image
            .as_ref()
            .filter(|_| home_reuse_result == HomeReuseResult::Reused)
            .and_then(HomeImageLease::source_identity),
    );

    let attempt = execute_prepared_sandbox_attempt(
        prepared,
        context,
        config,
        RunStart {
            restore_guest_state: params.restore_guest_state,
            reuse_result,
            home_reuse_result,
            sandbox_startup_path: if home_reuse_result == HomeReuseResult::Reused {
                runner_types::types::SandboxStartupPath::Home
            } else {
                runner_types::types::SandboxStartupPath::Cold
            },
            prev_storage: home_image
                .as_ref()
                .and_then(HomeImageLease::previous_storage),
        },
        telemetry,
        PreparedRunInputs::new(controls, prepared_run_payload),
    )
    .await;
    if preparation != FreshPreparation::DiskReplacement && attempt.retry_inputs.is_some() {
        return Ok(Box::pin(replace_disk_full_sandbox(
            factory,
            context,
            config,
            params,
            telemetry,
            DiskReplacement {
                dispatch: NewSandboxDispatch {
                    id: sandbox_id,
                    reuse_result,
                },
                attempt,
                home_image,
            },
        ))
        .await);
    }
    let mut outcome = attempt.outcome;
    outcome.home_image = home_image;
    Ok(outcome)
}

pub(super) struct PreparedSandboxRun {
    pub(super) sandbox: Box<dyn Sandbox>,
    pub(super) source_ip: String,
    pub(super) network_log_session: NetworkLogSession,
    pub(super) prepared_guest_runtime: Option<PreparedGuestRuntime>,
}

pub(super) struct PreparationRetirement {
    unregister_completed: bool,
    pub(super) destroy_completed: bool,
}

impl PreparationRetirement {
    pub(super) fn is_completed(&self) -> bool {
        self.unregister_completed && self.destroy_completed
    }
}

impl PreparedSandboxRun {
    pub(super) async fn retire_after_preparation_failure(
        self,
        factory: &dyn SandboxFactory,
        context: &ExecutionContext,
        config: &ExecutorConfig,
        telemetry: &mut JobTelemetry,
        require_backing: bool,
        report_unregister_failure: impl FnOnce(RunnerError),
    ) -> PreparationRetirement {
        let Self {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime,
        } = self;
        if let Some(runtime) = prepared_guest_runtime {
            runtime.finish(sandbox.as_ref(), telemetry).await;
        }
        let unregister_completed =
            match unregister_proxy_registry(config, &source_ip, context.run_id).await {
                Ok(()) => true,
                Err(error) => {
                    report_unregister_failure(error);
                    false
                }
            };
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        let has_required_backing = !require_backing || sandbox.backing_process().is_some();
        let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
            .await
            .is_completed()
            && has_required_backing;
        PreparationRetirement {
            unregister_completed,
            destroy_completed,
        }
    }
}

pub(super) struct SandboxPrepareError {
    error: RunnerError,
    retry: SandboxPrepareRetry,
    cleanup_completed: bool,
    invalidate_consumed_home_cache: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SandboxPrepareRetry {
    None,
    WithoutHomeImage,
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
    /// The blank has already consumed the prefetch preparation replacement.
    WithoutCodexPrefetchReplacement,
    /// A confirmed pre-Agent disk failure already spent the replacement budget.
    DiskReplacement,
}

struct StartSandboxOptions<'a> {
    home_image: Option<&'a mut HomeImageLease>,
    sandbox_prepared: Option<&'a SandboxPreparedNotifier>,
    reuse_result: SandboxReuseResult,
    cancel: &'a CancellationToken,
    codex_model_catalog_prefetch: bool,
}

impl SandboxPrepareError {
    fn retry_without_home_image(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::WithoutHomeImage,
            cleanup_completed,
            invalidate_consumed_home_cache: false,
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
            invalidate_consumed_home_cache: suppress_replacement,
        }
    }

    fn without_codex_model_catalog_prefetch(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::WithoutCodexModelCatalogPrefetch,
            cleanup_completed,
            invalidate_consumed_home_cache: false,
        }
    }

    fn fatal(error: RunnerError) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::None,
            cleanup_completed: false,
            invalidate_consumed_home_cache: false,
        }
    }

    fn fatal_after_cleanup(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::None,
            cleanup_completed,
            invalidate_consumed_home_cache: false,
        }
    }
}

pub(super) async fn prepare_home_image(
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
) -> Option<HomeImageLease> {
    let cache = config.home_cache.as_ref()?;
    let cache = cache.clone().with_first_run(context.is_first_run);
    let prepare_started = Instant::now();
    let reuse_key = context.reuse_key();
    let request = HomeImagePrepareRequest {
        identity: HomeImageLeaseIdentity {
            run_id: context.run_id,
            sandbox_id,
            profile_name: &params.profile_name,
            rootfs_hash: &params.rootfs_hash,
            reuse_key,
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.home_disk_mb) * 1024 * 1024,
        },
        home_drive_required: true,
    };
    let lease = if let Some(source) = params.required_home_source_run_id {
        cache
            .prepare_from_source(request, source, params.home_image_prepare_policy)
            .await
    } else {
        match params.home_image_prepare_policy {
            HomeImagePreparePolicy::TryCacheWithLockWait => cache.prepare(request).await,
            HomeImagePreparePolicy::TryCacheWithoutLockWait | HomeImagePreparePolicy::SkipCache => {
                cache
                    .prepare_with_policy(request, params.home_image_prepare_policy)
                    .await
            }
        }
    };
    let prepare_error = home_image_prepare_error(lease.result());
    telemetry.record(
        RUNNER_FRESH_HOME_IMAGE_PREPARE,
        prepare_started.elapsed(),
        prepare_error.is_none(),
        prepare_error,
    );
    if let Some(observation) = lease.checkout_observation() {
        telemetry.observe_home(observation);
    }
    Some(lease)
}

fn home_image_prepare_error(result: HomeCacheCheckoutResult) -> Option<&'static str> {
    match result {
        HomeCacheCheckoutResult::Hit
        | HomeCacheCheckoutResult::Miss
        | HomeCacheCheckoutResult::NoReuseKey => None,
        HomeCacheCheckoutResult::InvalidWorkingDir => Some(HOME_IMAGE_PREPARE_INVALID_WORKING_DIR),
        HomeCacheCheckoutResult::LockBusy => Some(HOME_IMAGE_PREPARE_LOCK_BUSY),
        HomeCacheCheckoutResult::InvalidMetadata => Some(HOME_IMAGE_PREPARE_INVALID_METADATA),
        HomeCacheCheckoutResult::DiskPressure => Some(HOME_IMAGE_PREPARE_DISK_PRESSURE),
    }
}

fn final_home_reuse_result(
    checkout_result: Option<HomeCacheCheckoutResult>,
    used_home_fallback: bool,
) -> HomeReuseResult {
    if used_home_fallback {
        return HomeReuseResult::SandboxPrepareFallback;
    }
    match checkout_result {
        Some(HomeCacheCheckoutResult::Hit) => HomeReuseResult::Reused,
        Some(HomeCacheCheckoutResult::Miss) => HomeReuseResult::CacheMiss,
        Some(HomeCacheCheckoutResult::NoReuseKey) => HomeReuseResult::NoReuseKey,
        Some(HomeCacheCheckoutResult::InvalidWorkingDir) => HomeReuseResult::InvalidWorkingDir,
        Some(HomeCacheCheckoutResult::LockBusy) => HomeReuseResult::LockBusy,
        Some(HomeCacheCheckoutResult::InvalidMetadata) => HomeReuseResult::InvalidMetadata,
        Some(HomeCacheCheckoutResult::DiskPressure) => HomeReuseResult::DiskPressure,
        None => HomeReuseResult::NotConfigured,
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
        home_image,
        sandbox_prepared,
        reuse_result,
        cancel,
        codex_model_catalog_prefetch,
    } = options;
    let home_drive = match home_image {
        Some(image) => image
            .home_drive_config()
            .await
            .map_err(|error| SandboxPrepareError::retry_without_home_image(error.into(), true))?,
        None => Some(sandbox::HomeDriveConfig {
            size_mb: params.home_disk_mb,
            seed_image: None,
            space_reserve: runner_lifecycle::home_image_cache::HOME_IMAGE_SPACE_RESERVE,
        }),
    };
    if cancel.is_cancelled() {
        return Err(SandboxPrepareError::fatal_after_cleanup(
            RunnerError::Cancelled,
            true,
        ));
    }
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: params.vcpu,
            memory_mb: params.memory_mb,
        },
        device_rate_limits: params.device_rate_limits.clone(),
        home_drive,
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
            return Err(SandboxPrepareError::retry_without_home_image(
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
            None => SandboxPrepareError::retry_without_home_image(error, cleanup_completed),
        });
    }
    telemetry.record(
        RUNNER_FRESH_SANDBOX_START,
        sandbox_start_started.elapsed(),
        true,
        None,
    );
    telemetry.record("sandbox_create", t.elapsed(), true, None);

    let (mut error, unregister_warning, prepared_guest_runtime) = 'prepare: {
        let prepared_guest_runtime = if codex_model_catalog_prefetch {
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
        let prepared_guest_runtime = match prepared_guest_runtime {
            Some(PreparedGuestRuntime::SandboxUnusable(error)) => {
                break 'prepare (
                    SandboxPrepareError::without_codex_model_catalog_prefetch(error, false),
                    "failed to unregister sandbox from proxy after unsafe Codex prefetch start failure",
                    None,
                );
            }
            prepared_guest_runtime => prepared_guest_runtime,
        };

        let mount_started = Instant::now();
        let mount_result = ensure_home_drive_mounted(sandbox.as_ref(), context.run_id).await;
        let mount_duration = mount_started.elapsed();
        let guest_duration = match mount_result {
            Ok(guest_duration) => guest_duration,
            Err(e) => {
                telemetry.record(
                    HOME_DRIVE_MOUNT,
                    mount_duration,
                    false,
                    Some(&e.error.to_string()),
                );
                record_home_drive_mount_guest_exec(telemetry, e.guest_duration, false);
                break 'prepare (
                    SandboxPrepareError::retry_without_home_image(e.error.into(), false),
                    "failed to unregister sandbox from proxy after home mount failure",
                    prepared_guest_runtime,
                );
            }
        };
        telemetry.record(HOME_DRIVE_MOUNT, mount_duration, true, None);
        record_home_drive_mount_guest_exec(telemetry, guest_duration, true);
        if let Some(notifier) = sandbox_prepared
            && let Err(error) = notifier.notify(context.run_id, sandbox_id).await
        {
            break 'prepare (
                SandboxPrepareError::fatal_after_cleanup(error, false),
                "failed to unregister sandbox from proxy after ownership publication failure",
                prepared_guest_runtime,
            );
        }

        return Ok(PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
            prepared_guest_runtime,
        });
    };

    error.cleanup_completed = PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
        prepared_guest_runtime,
    }
    .retire_after_preparation_failure(
        factory,
        context,
        config,
        telemetry,
        false,
        |unregister_error| {
            warn!(
                run_id = %context.run_id,
                error = %unregister_error,
                "{unregister_warning}"
            );
        },
    )
    .await
    .is_completed();
    Err(error)
}

fn record_home_drive_mount_guest_exec(
    telemetry: &mut JobTelemetry,
    guest_duration: Option<Duration>,
    success: bool,
) {
    match guest_duration {
        Some(duration) => telemetry.record(HOME_DRIVE_MOUNT_GUEST_EXEC, duration, success, None),
        None => telemetry.record_bounded_outcome(
            HOME_DRIVE_MOUNT_GUEST_EXEC_UNAVAILABLE,
            success,
            "unavailable",
            None,
        ),
    }
}

pub(super) async fn invalidate_home_cache_hit(
    home_image: Option<&HomeImageLease>,
    run_id: RunId,
    reason: &str,
) {
    let Some(home_image) = home_image else {
        return;
    };
    if !home_image.is_cache_hit() {
        return;
    }
    if let Err(e) = home_image.invalidate(run_id, reason).await {
        warn!(
            run_id = %run_id,
            reason,
            error = %e,
            "failed to invalidate home image cache entry"
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
    let backing = sandbox.backing_process();
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("sandbox destroy panicked after start failure");
        DestroySandboxOutcome::Uncertain
    } else if backing.is_some() && !crate::idle_pool::confirm_backing_exit(backing).await {
        warn!("sandbox destroy returned without confirmed backing exit");
        DestroySandboxOutcome::Uncertain
    } else {
        DestroySandboxOutcome::Completed
    }
}

pub(super) struct PreparedSandboxAttempt {
    pub(super) outcome: ExecuteOutcome,
    pub(super) retry_inputs: Option<Box<PreparedRunInputs>>,
}

pub(super) struct DiskReplacement {
    pub(super) dispatch: NewSandboxDispatch,
    pub(super) attempt: PreparedSandboxAttempt,
    pub(super) home_image: Option<HomeImageLease>,
}

pub(super) async fn replace_disk_full_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    replacement: DiskReplacement,
) -> ExecuteOutcome {
    let DiskReplacement {
        dispatch,
        mut attempt,
        home_image,
    } = replacement;
    let Some(mut inputs) = attempt.retry_inputs.take() else {
        return attempt.outcome;
    };
    let diagnostics = attempt
        .outcome
        .failure
        .as_ref()
        .and_then(|failure| failure.resource_diagnostics.as_ref());
    let home_full = diagnostics.is_some_and(super::diagnostics::home_is_clearly_full);
    let rootfs_full = diagnostics.is_some_and(super::diagnostics::rootfs_is_clearly_full);
    let reason = match (home_full, rootfs_full) {
        (true, true) => "bootstrap_home_and_rootfs_disk_full",
        (true, false) => "bootstrap_home_disk_full",
        (false, true) => "bootstrap_rootfs_disk_full",
        (false, false) => "bootstrap_disk_full",
    };
    if let Some(image) = home_image.as_ref().filter(|image| image.is_cache_hit()) {
        telemetry.observe_home(image.consumption_observation(
            Some(context.run_id),
            runner_host::home_observation::HomeObservationOutcome::Failed,
            Some(reason),
        ));
    }
    // Checkout already revoked the consumed generation's discoverability. Purge
    // only that lease, never a newer cache baseline or an unrelated miss.
    if home_full {
        invalidate_home_cache_hit(home_image.as_ref(), context.run_id, reason).await;
    }
    drop(home_image);
    if let Some(log) = attempt.outcome.network_log_session.take() {
        log.close_for_upload(context.run_id, &config.network_log_drain)
            .await;
    }
    let destroyed = match attempt.outcome.sandbox.take() {
        Some(sandbox) => {
            let has_backing = sandbox.backing_process().is_some();
            destroy_sandbox_panic_safe(factory, sandbox)
                .await
                .is_completed()
                && has_backing
        }
        None => false,
    };
    if !destroyed || inputs.controls.cancel.is_cancelled() {
        if !destroyed && let Some(source) = inputs.controls.sandbox_recovery.as_ref() {
            source.uncertain(context.run_id, dispatch.id);
        }
        telemetry.record_with_outcome(
            "runner_bootstrap_disk_replacement",
            Duration::ZERO,
            false,
            None,
            Some(if destroyed {
                "cancelled"
            } else {
                "cleanup_uncertain"
            }),
        );
        if inputs.controls.cancel.is_cancelled() {
            attempt.outcome.mark_cancelled();
        }
        return attempt.outcome;
    }
    // The old burst lease must not deadlock reacquisition by the pristine VM.
    drop(inputs.controls.pre_spawn_admission_lease.take());
    if let Some(source) = inputs.controls.sandbox_recovery.as_ref()
        && let Err(error) = source.retired(context.run_id, dispatch.id).await
    {
        return ExecuteOutcome::preparation_failure(error);
    }
    telemetry.set_home_startup_source(None);
    let try_blank = !inputs.controls.disk_recovery;
    if !inputs.controls.disk_recovery {
        telemetry.set_home_non_reuse_reason(reason);
    }
    inputs.controls.disk_recovery = true;
    telemetry.record_with_outcome(
        "runner_bootstrap_disk_replacement",
        Duration::ZERO,
        true,
        None,
        Some(reason),
    );
    let cancel = inputs.controls.cancel.clone();
    if try_blank && let Some(source) = inputs.controls.sandbox_recovery.as_ref() {
        let acquired = source
            .acquire(context.run_id, dispatch.id, cancel.clone())
            .await;
        match acquired {
            Ok(Some(blank)) => {
                let sandbox_id = blank.sandbox_id();
                let parts = blank.into_parts();
                telemetry.record_with_outcome(
                    "runner_disk_replacement_blank",
                    Duration::ZERO,
                    true,
                    None,
                    Some("available"),
                );
                return Box::pin(super::reused_sandbox::execute_reused_sandbox(
                    super::reused_sandbox::ReusedSandboxRun {
                        sandbox_id,
                        factory,
                        params,
                        sandbox: parts.sandbox,
                        source_ip: parts.source_ip,
                        home_image: None,
                        kind: crate::idle_pool::IdleSandboxKind::Blank,
                    },
                    context,
                    config,
                    RunStart {
                        restore_guest_state: params.restore_guest_state,
                        reuse_result: dispatch.reuse_result,
                        home_reuse_result: HomeReuseResult::SandboxPrepareFallback,
                        sandbox_startup_path: runner_types::types::SandboxStartupPath::Blank,
                        prev_storage: None,
                    },
                    telemetry,
                    PreparedRunInputs::new(
                        inputs
                            .controls
                            .with_guest_state_prepared(parts.guest_state_prepared),
                        inputs.run_payload,
                    ),
                ))
                .await;
            }
            Ok(None) => telemetry.record_with_outcome(
                "runner_disk_replacement_blank",
                Duration::ZERO,
                false,
                None,
                Some("unavailable"),
            ),
            Err(error) => {
                telemetry.record_with_outcome(
                    "runner_disk_replacement_blank",
                    Duration::ZERO,
                    false,
                    None,
                    Some("activation_unsafe"),
                );
                let mut outcome = ExecuteOutcome::preparation_failure(error);
                if cancel.is_cancelled() {
                    outcome.mark_cancelled();
                }
                return outcome;
            }
        }
    }
    let prepared_notifier = inputs
        .controls
        .sandbox_recovery
        .as_ref()
        .and_then(|source| source.prepared.clone());
    let mut outcome = execute_new_sandbox_with_prepared_notifier(
        factory,
        context,
        dispatch,
        config,
        params,
        telemetry,
        NewSandboxHooks {
            preparation: FreshPreparation::DiskReplacement,
            controls: inputs.controls.with_guest_state_prepared(false),
            prepared_run_payload: inputs.run_payload,
            sandbox_prepared: prepared_notifier.as_ref(),
        },
    )
    .await
    .unwrap_or_else(ExecuteOutcome::preparation_failure);
    if cancel.is_cancelled() {
        outcome.mark_cancelled();
    }
    outcome
}

#[cfg(test)]
pub(super) async fn execute_prepared_sandbox_run(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
) -> ExecuteOutcome {
    execute_prepared_sandbox_attempt(run, context, config, start, telemetry, inputs)
        .await
        .outcome
}

pub(super) async fn execute_prepared_sandbox_attempt(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
) -> PreparedSandboxAttempt {
    execute_prepared_sandbox_attempt_with_process_cancel_timeouts(
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

#[cfg(test)]
pub(super) async fn execute_prepared_sandbox_run_with_process_cancel_timeouts(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> ExecuteOutcome {
    execute_prepared_sandbox_attempt_with_process_cancel_timeouts(
        run,
        context,
        config,
        start,
        telemetry,
        inputs,
        process_cancel_timeouts,
    )
    .await
    .outcome
}

async fn execute_prepared_sandbox_attempt_with_process_cancel_timeouts(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    inputs: PreparedRunInputs,
    process_cancel_timeouts: ProcessCancelTimeouts,
) -> PreparedSandboxAttempt {
    let PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
        prepared_guest_runtime,
    } = run;
    let cleanup_cancel = inputs.controls.cancel.clone();
    let guest_rpc = config
        .guest_rpc
        .as_ref()
        .and_then(|runtime| runtime.install(sandbox.as_ref(), context, &cleanup_cancel));
    let reuse_result = start.reuse_result;
    let home_reuse_result = start.home_reuse_result;

    let mut inputs = inputs;
    inputs.controls.prepared_guest_runtime = prepared_guest_runtime;
    let mut lifecycle = AgentRunLifecycle::new(process_cancel_timeouts);
    let result = run_in_sandbox_with_process_cancel_timeouts(
        sandbox.as_ref(),
        context,
        config,
        start,
        telemetry,
        inputs,
        &mut lifecycle,
    )
    .await;

    let remote_cleanup = match guest_rpc {
        Some(guest_rpc) => guest_rpc.shutdown().await,
        None => Ok(()),
    };

    let collect_pre_process_diagnostics = result
        .as_ref()
        .err()
        .is_some_and(|error| explicit_enospc_evidence([error.to_string().as_str()]));
    let pre_process_resource_diagnostics = if collect_pre_process_diagnostics {
        collect_agent_abnormal_exit_diagnostics(
            sandbox.as_ref(),
            context.run_id,
            sandbox.id(),
            reuse_result,
            1,
        )
        .await
    } else {
        None
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
    let cleanup_completed = remote_cleanup.is_ok() && cleanup_result.is_ok();
    if let Err(error) = remote_cleanup {
        if agent_result.failure.is_none() {
            agent_result.failure = Some(ExecutionFailure::from_error(error.to_string()));
        }
        agent_result.sandbox_reuse_disposition =
            SandboxReuseDisposition::Ineligible(SandboxReuseRejection::PostJobCleanupFailure);
    }
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
    let retry_inputs = agent_result
        .pre_agent_retry
        .take()
        .filter(|_| cleanup_completed);
    let discovered_cli_agent_session_id =
        if retry_inputs.is_none() && context.cli_agent_session_id().is_none() {
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

    PreparedSandboxAttempt {
        retry_inputs,
        outcome: ExecuteOutcome {
            failure: agent_result.failure,
            sandbox_reuse_disposition: agent_result.sandbox_reuse_disposition,
            storage_fingerprints: runner_types::content_bundle::fingerprints(context),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: Some(network_log_session),
            home_image: None,
            home_reuse_result: lifecycle.startup_report.as_ref().map(|_| home_reuse_result),
            startup_report: lifecycle.startup_report,
            discovered_cli_agent_session_id,
            restored_session_identity,
        },
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
        model_usage_long_context_min_total_input_tokens: context
            .model_usage_long_context_min_total_input_tokens,
        pi_model_config: context.pi_model_config.as_ref(),
    };
    let publication = config
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
                registry: Arc::new(crate::network_provider_adapter::ProviderRegistryAdapter(
                    config.registry.clone(),
                )),
                targets: &context.connector_runtime_targets,
                refreshes: context.network_policy_refreshes.as_ref(),
            })
            .await;
    }
    config.registry.observe_registration(publication);
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
    let publication = result?;
    publication.observe().await;
    Ok(())
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
