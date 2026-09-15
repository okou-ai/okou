//! In-process job execution for the runner.
//!
//! `cmd/start/job_spawn.rs::spawn_job` calls this module after a provider claim and
//! budget reservation. The executor owns the sandbox-side run flow, while the
//! caller owns provider completion and the final sandbox lifecycle decision.
//!
//! The fresh path starts and prepares a new Firecracker VM and can notify the
//! caller once the sandbox is ready to run the job. The reuse path runs in a
//! kept-alive idle sandbox. An unusable blank can be retired before Agent start
//! and replaced once through fresh preparation; exact reuse does not prefetch.
//!
//! Both paths return `ExecuteOutcome` plus a pending `JobTelemetry`
//! buffer. When `ExecuteOutcome::sandbox` is `Some`, the executor transfers
//! ownership of a still-live sandbox that the caller must finalize through the
//! runner's park-or-destroy path. Presence alone does not mean the sandbox can
//! be parked. The caller also flushes telemetry after firing
//! `provider.complete`, so the user-visible completion signal is not blocked on
//! best-effort uploads.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use guest_contracts::diagnostics::FailureDiagnostic;
use sandbox::{Sandbox, SandboxFactory, SandboxId};
#[cfg(test)]
use tokio_util::sync::CancellationToken;

mod active_input;
mod agent_run;
mod cli_framework;
mod codex_model_catalog_prefetch;
mod diagnostics;
mod env;
mod guest_state;
mod reused_sandbox;
mod sandbox_run;
mod session_history_cpu;
mod session_history_download;
mod session_history_restore_plan;
mod session_id;
mod session_restore;
mod storage;
mod storage_baseline_observation;
mod telemetry;
mod workspace_session_history_materializer;

pub(crate) use crate::restored_session_identity::RestoredSessionIdentity;
pub(crate) use cli_framework::effective_cli_framework;
pub(crate) use guest_state::{
    GuestTimezoneSyncOutcome, is_shell_safe_guest_timezone_name, restore_guest_state_with_intent,
    restore_guest_state_with_timezone, try_sync_guest_timezone_intent,
};
pub(crate) use session_history_cpu::SessionHistoryCpuPool;
pub(crate) use session_history_download::{SessionHistoryMaterializer, SessionHistoryProbe};
pub(crate) use session_history_restore_plan::{
    SessionHistoryRestoreFallback, SessionHistoryRestorePlan, SessionHistoryRestorePlanInput,
    build_session_history_restore_plan,
};

use crate::active_input::ActiveInputSource;
use agent_run::{PreparedRunInputs, ProcessCancelTimeouts, RunControls, RunStart};
use env::validate_execution_context_before_sandbox;
pub(crate) use env::validate_resume_session_id;
use reused_sandbox::{ReusedSandboxRun, execute_reused_sandbox};
use sandbox_run::{FreshPreparation, NewSandboxHooks, execute_new_sandbox_with_prepared_notifier};
pub(crate) use telemetry::{
    ExactReuseSpeculationTiming, FinalizingDiagnostics, FinalizingExactIdleLookup,
    FinalizingHandoffOutcome, FinalizingHandoffReason, RunnerPreSpawnConcurrency,
    RunnerPreSpawnOperationTiming, RunnerPreSpawnPhase, RunnerPreSpawnTiming,
};
use telemetry::{RunnerSpawnTiming, record_api_latency, record_reuse_result};

use crate::ids::RunId;
use crate::run_cancellation::RunCancellationSignals;
use api_contracts::generated::constants::runners::{
    AGENT_EXECUTION_TIMEOUT_SECONDS, RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
    paths::{CANONICAL_GUEST_HOME_DIR, CANONICAL_WORKING_DIR},
};
use guest_contracts::exec_terminal::EXEC_TERMINAL_CLEANUP_BUDGET;

/// Maximum guest-side runtime budget for a single agent process.
const JOB_TIMEOUT: Duration = Duration::from_secs(AGENT_EXECUTION_TIMEOUT_SECONDS);
/// Exit code used when the runner's job timeout stops an agent process.
const JOB_TIMEOUT_EXIT_CODE: i32 = guest_contracts::diagnostics::AGENT_EXECUTION_TIMEOUT_EXIT_CODE;
/// Bounded best-effort window after the execution budget for recovery
/// checkpointing and final telemetry. This covers normal checkpoint latency
/// plus a full presigned-upload timeout without letting an unavailable backend
/// hold runner capacity indefinitely.
const JOB_FINALIZATION_GRACE_TIMEOUT: Duration = Duration::from_secs(90);
/// Host-owned allowance beyond guest terminal cleanup for scheduling,
/// observation, and terminal proof delivery after the supervisor timeout.
const JOB_TERMINAL_HOST_SLACK: Duration = Duration::from_millis(3_250);
const JOB_TERMINAL_GRACE_TIMEOUT: Duration =
    EXEC_TERMINAL_CLEANUP_BUDGET.saturating_add(JOB_TERMINAL_HOST_SLACK);
/// Maximum time to spend writing a guest control or cancellation frame.
const PROCESS_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
/// Host-owned allowance beyond guest terminal cleanup after cancel is sent.
const PROCESS_CANCEL_TERMINAL_HOST_SLACK: Duration = Duration::from_millis(1_250);
const PROCESS_CANCEL_TERMINAL_GRACE_TIMEOUT: Duration =
    EXEC_TERMINAL_CLEANUP_BUDGET.saturating_add(PROCESS_CANCEL_TERMINAL_HOST_SLACK);
const _: () = assert!(
    JOB_TERMINAL_GRACE_TIMEOUT.as_nanos() == 10_000_000_000,
    "job terminal grace changed; review guest cleanup and host slack"
);
const _: () = assert!(
    PROCESS_CANCEL_TERMINAL_GRACE_TIMEOUT.as_nanos() == 8_000_000_000,
    "process cancellation terminal grace changed; review guest cleanup and host slack"
);
const PROCESS_CANCEL_TIMEOUTS: ProcessCancelTimeouts = ProcessCancelTimeouts {
    write: PROCESS_CANCEL_WRITE_TIMEOUT,
    terminal_grace: PROCESS_CANCEL_TERMINAL_GRACE_TIMEOUT,
    cooperative_grace: Duration::from_millis(RUNNER_CANCELLATION_RECOVERY_GRACE_MS),
};
/// Exit code when a process is killed by SIGKILL (128 + 9).
const EXIT_SIGKILL: i32 = 137;
/// Raw SIGKILL signal number.
const EXIT_SIGNAL_KILL: i32 = 9;
/// Default timeout for guest commands (5 minutes).
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(300);
const AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_ENV_KEY_DIAGNOSTIC_LIMIT: usize = 128;
const SMALL_GUEST_FILE_MAX_BYTES: u64 = 64 * 1024;
const GUEST_LOG_COPY_MAX_BYTES: u64 = 64 * 1024 * 1024;
const STDOUT_STREAM_LIMIT_MARKER: &[u8] =
    b"[runner] stdout stream reached the guest stream limit; later output was omitted\n";
const STDOUT_STREAM_OVERFLOW_MARKER: &[u8] =
    b"[runner] stdout stream overflowed the host queue; some output was dropped\n";
const STDOUT_STREAM_INCOMPLETE_MARKER: &[u8] =
    b"[runner] stdout stream capture ended before clean EOF; some output may be missing\n";
fn job_supervisor_timeout() -> Duration {
    JOB_TIMEOUT + JOB_FINALIZATION_GRACE_TIMEOUT
}

fn job_terminal_wait_timeout() -> Duration {
    job_supervisor_timeout() + JOB_TERMINAL_GRACE_TIMEOUT
}
const BOOTSTRAP_SENSITIVE_ENV_KEYS: &[&str] = &[
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "BASHOPTS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "NODE_OPTIONS",
];
const AGENT_ABNORMAL_EXIT_DIAGNOSTIC_SCRIPT: &str =
    include_str!("../../scripts/agent-abnormal-exit-diagnostics.sh");

use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::idle_pool::{IdleSandboxKind, ReusableIdleSandbox, ReusableIdleSandboxParts};
use crate::network_log_drain::NetworkLogDrainCoordinator;
use crate::network_log_manager::NetworkLogManager;
use crate::network_log_manager::NetworkLogSession;
use crate::paths::{HomePaths, LogPaths};
use crate::proxy::{MitmJsonlFlushHandle, ProxyRegistryHandle};
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, SandboxReuseResult, WorkspaceReuseResult};
use crate::workspace_image_cache::{
    WorkspaceImageActiveLeaseRequest, WorkspaceImageCache, WorkspaceImageLease,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareLockPolicy, WorkspaceImagePromotionContext,
    WorkspaceImagePromotionIdentityFailure, WorkspaceImagePromotionIdentityMismatch,
    WorkspaceImagePromotionIdentityRequest,
};
use crate::workspace_promotion::abandon_unpublished_workspace_promotion;

fn guest_runtime_dir(run_id: RunId) -> RunnerResult<String> {
    let run_id = run_id.to_string();
    let path = guest_contracts::runtime_paths::run_dir_for_home(CANONICAL_GUEST_HOME_DIR, &run_id)
        .map_err(|e| RunnerError::Internal(format!("guest runtime dir: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

fn guest_runtime_path(
    run_id: RunId,
    path: impl FnOnce(PathBuf) -> PathBuf,
) -> RunnerResult<String> {
    let run_id = run_id.to_string();
    let run_dir =
        guest_contracts::runtime_paths::run_dir_for_home(CANONICAL_GUEST_HOME_DIR, &run_id)
            .map_err(|e| RunnerError::Internal(format!("guest runtime path: {e}")))?;
    Ok(path(run_dir).to_string_lossy().into_owned())
}

/// Shared configuration for all executions (profile-independent).
pub struct ExecutorConfig {
    pub api_url: String,
    pub runner_hostname: Option<String>,
    pub registry: ProxyRegistryHandle,
    pub http: HttpClient,
    pub log_paths: LogPaths,
    pub network_log_manager: NetworkLogManager,
    pub network_log_drain: NetworkLogDrainCoordinator,
    pub mitm_jsonl_flush: Option<MitmJsonlFlushHandle>,
    pub(crate) connector_runtime_sync: Option<crate::provider::ConnectorRuntimeSyncHandle>,
    pub(crate) ssh: Option<Arc<crate::ssh::SshRuntime>>,
    pub(crate) session_history_cpu: SessionHistoryCpuPool,
    pub(crate) session_history_probe: SessionHistoryProbe,
    pub(crate) fresh_archive_delivery: crate::storage_cache::FreshArchiveDeliveryAdmission,
    pub(crate) background_fill: crate::storage_cache::StorageCacheBackgroundFillCoordinator,
    pub(crate) decoded_cache: crate::storage_cache::decoded::DecodedCache,
    pub(crate) pre_spawn_admission: crate::pre_spawn_admission::PreSpawnAdmission,
    pub(crate) storage_baseline_observer: storage_baseline_observation::StorageBaselineObserver,
    pub home: HomePaths,
    pub workspace_cache: Option<WorkspaceImageCache>,
}

/// Per-job sandbox parameters resolved from the profile config.
pub struct JobParams {
    pub profile_name: String,
    pub vcpu: u32,
    pub memory_mb: u32,
    pub workspace_disk_mb: u32,
    pub restore_guest_state: bool,
    pub device_rate_limits: Option<sandbox::DeviceRateLimits>,
    pub(crate) workspace_image_prepare_lock_policy: WorkspaceImagePrepareLockPolicy,
}

#[derive(Clone)]
pub(crate) struct SandboxPreparedNotifier {
    callback: Arc<dyn Fn(RunId, SandboxId) -> BoxFuture<'static, RunnerResult<()>> + Send + Sync>,
}

impl SandboxPreparedNotifier {
    pub(crate) fn new(
        callback: impl Fn(RunId, SandboxId) -> BoxFuture<'static, RunnerResult<()>>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            callback: Arc::new(callback),
        }
    }

    async fn notify(&self, run_id: RunId, sandbox_id: SandboxId) -> RunnerResult<()> {
        (self.callback)(run_id, sandbox_id).await
    }
}

pub(crate) struct ExecutionHooks {
    pub(crate) sandbox_prepared: Option<SandboxPreparedNotifier>,
    pub(crate) active_input_source: Option<ActiveInputSource>,
    pub(crate) pre_spawn_timing: Option<RunnerPreSpawnTiming>,
    pub(crate) session_history_restore_plan: SessionHistoryRestorePlan,
}

impl ExecutionHooks {
    #[cfg(test)]
    fn none() -> Self {
        Self {
            sandbox_prepared: None,
            active_input_source: None,
            pre_spawn_timing: None,
            session_history_restore_plan: SessionHistoryRestorePlan::Default,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxReuseDisposition {
    Eligible(SandboxReuseTerminal),
    Ineligible(SandboxReuseRejection),
}

impl SandboxReuseDisposition {
    #[must_use]
    pub(crate) fn is_eligible(self) -> bool {
        matches!(self, Self::Eligible(_))
    }

    #[must_use]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Eligible(SandboxReuseTerminal::Success) => "eligible_success",
            Self::Eligible(SandboxReuseTerminal::NonzeroExit) => "eligible_nonzero_exit",
            Self::Eligible(SandboxReuseTerminal::ExecutionTimeout) => "eligible_execution_timeout",
            Self::Eligible(SandboxReuseTerminal::CooperativeCancellation) => {
                "eligible_cooperative_cancellation"
            }
            Self::Ineligible(SandboxReuseRejection::ExecutionUncertain) => "execution_uncertain",
            Self::Ineligible(SandboxReuseRejection::HardCancellation) => "hard_cancellation",
            Self::Ineligible(SandboxReuseRejection::UnconfirmedTimeout) => "unconfirmed_timeout",
            Self::Ineligible(SandboxReuseRejection::ResourceFailure) => "resource_failure",
            Self::Ineligible(SandboxReuseRejection::ControlPathFailure) => "control_path_failure",
            Self::Ineligible(SandboxReuseRejection::PostJobCleanupFailure) => {
                "post_job_cleanup_failure"
            }
        }
    }

    #[must_use]
    pub(crate) fn telemetry_action(self) -> &'static str {
        match self {
            Self::Eligible(SandboxReuseTerminal::Success) => {
                "runner_terminal_sandbox_reuse_eligible_success"
            }
            Self::Eligible(SandboxReuseTerminal::NonzeroExit) => {
                "runner_terminal_sandbox_reuse_eligible_nonzero_exit"
            }
            Self::Eligible(SandboxReuseTerminal::ExecutionTimeout) => {
                "runner_terminal_sandbox_reuse_eligible_execution_timeout"
            }
            Self::Eligible(SandboxReuseTerminal::CooperativeCancellation) => {
                "runner_terminal_sandbox_reuse_eligible_cooperative_cancellation"
            }
            Self::Ineligible(SandboxReuseRejection::ExecutionUncertain) => {
                "runner_terminal_sandbox_reuse_rejected_execution_uncertain"
            }
            Self::Ineligible(SandboxReuseRejection::HardCancellation) => {
                "runner_terminal_sandbox_reuse_rejected_hard_cancellation"
            }
            Self::Ineligible(SandboxReuseRejection::UnconfirmedTimeout) => {
                "runner_terminal_sandbox_reuse_rejected_unconfirmed_timeout"
            }
            Self::Ineligible(SandboxReuseRejection::ResourceFailure) => {
                "runner_terminal_sandbox_reuse_rejected_resource_failure"
            }
            Self::Ineligible(SandboxReuseRejection::ControlPathFailure) => {
                "runner_terminal_sandbox_reuse_rejected_control_path_failure"
            }
            Self::Ineligible(SandboxReuseRejection::PostJobCleanupFailure) => {
                "runner_terminal_sandbox_reuse_rejected_post_job_cleanup_failure"
            }
        }
    }
}

impl Default for SandboxReuseDisposition {
    fn default() -> Self {
        Self::Ineligible(SandboxReuseRejection::ExecutionUncertain)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxReuseTerminal {
    Success,
    NonzeroExit,
    ExecutionTimeout,
    CooperativeCancellation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SandboxReuseRejection {
    ExecutionUncertain,
    HardCancellation,
    UnconfirmedTimeout,
    ResourceFailure,
    ControlPathFailure,
    PostJobCleanupFailure,
}

/// Outcome of a job execution and ownership of any sandbox still alive afterward.
pub struct ExecuteOutcome {
    pub failure: Option<ExecutionFailure>,
    /// Backend-accepted active-input deliveries not already confirmed through
    /// the direct receipt route. Provider completion settles these IDs.
    pub(crate) active_input_delivery_ids: Vec<String>,
    pub(crate) sandbox_reuse_disposition: SandboxReuseDisposition,
    /// Sandbox ownership after execution.
    ///
    /// `Some` transfers a still-live sandbox to the caller for finalization; it
    /// does not imply the sandbox is eligible for reuse. Finalization consumes
    /// `sandbox_reuse_disposition` and still enforces hard cancellation, the
    /// parking gate, a reuse key, reuse preparation, and ownership transfer.
    ///
    /// `None` means no live sandbox ownership is returned, either because no
    /// sandbox was created or because executor-side cleanup already consumed
    /// it.
    pub sandbox: Option<Box<dyn Sandbox>>,
    pub source_ip: String,
    pub network_log_session: Option<NetworkLogSession>,
    pub workspace_image: Option<WorkspaceImageLease>,
    /// Final workspace-reuse outcome, when execution reached `RunStart`.
    pub workspace_reuse_result: Option<WorkspaceReuseResult>,
    /// CLI-generated session ID read from the guest after execution.
    /// Used for late session tracking and finalization when `resume_session`
    /// is absent.
    pub discovered_cli_agent_session_id: Option<String>,
    pub restored_session_identity: Option<RestoredSessionIdentity>,
}

impl ExecuteOutcome {
    fn preparation_failure(error: impl ToString) -> Self {
        Self {
            failure: Some(ExecutionFailure::from_error(error.to_string())),
            active_input_delivery_ids: Vec::new(),
            sandbox_reuse_disposition: SandboxReuseDisposition::default(),
            sandbox: None,
            source_ip: String::new(),
            network_log_session: None,
            workspace_image: None,
            workspace_reuse_result: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
        }
    }

    fn reused_sandbox_failure(
        failure: ExecutionFailure,
        sandbox: Box<dyn Sandbox>,
        source_ip: String,
        workspace_image: Option<WorkspaceImageLease>,
    ) -> Self {
        Self {
            failure: Some(failure),
            active_input_delivery_ids: Vec::new(),
            sandbox_reuse_disposition: SandboxReuseDisposition::default(),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: None,
            workspace_image,
            workspace_reuse_result: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
        }
    }

    #[must_use]
    pub fn exit_code(&self) -> i32 {
        self.failure.as_ref().map_or(0, |failure| failure.exit_code)
    }

    #[must_use]
    pub fn error(&self) -> Option<&str> {
        self.failure.as_ref().map(|failure| failure.error.as_str())
    }

    pub fn mark_cancelled(&mut self) {
        self.failure = Some(ExecutionFailure::cancelled());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionFailure {
    pub exit_code: i32,
    pub error: String,
    pub diagnostic: Option<FailureDiagnostic>,
    pub kind: ExecutionFailureKind,
    pub resource_diagnostics: Option<ResourceFailureDiagnostics>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionFailureKind {
    Generic,
    RunnerJobTimeout {
        timeout_ms: u128,
        elapsed_ms: u128,
        guest_duration_ms: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceFailureKind {
    GuestRootFilesystemFull,
    GuestMemoryOomKilled,
    HostMemoryOomKilled,
}

impl ResourceFailureKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GuestRootFilesystemFull => "guest_root_filesystem_full",
            Self::GuestMemoryOomKilled => "guest_memory_oom_killed",
            Self::HostMemoryOomKilled => "host_memory_oom_killed",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResourceFailureDiagnostics {
    pub failure_kind: Option<ResourceFailureKind>,
    pub guest_root_fs_used_percent: Option<u16>,
    pub guest_root_fs_available_kb: Option<u64>,
    pub guest_root_fs_inode_used_percent: Option<u16>,
    pub guest_root_fs_available_inodes: Option<u64>,
    pub guest_workspace_fs_used_percent: Option<u16>,
    pub guest_memory_available_mb: Option<u64>,
}

impl ResourceFailureDiagnostics {
    #[must_use]
    pub fn from_failure_kind(failure_kind: ResourceFailureKind) -> Self {
        Self {
            failure_kind: Some(failure_kind),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn is_empty(self) -> bool {
        self.failure_kind.is_none()
            && self.guest_root_fs_used_percent.is_none()
            && self.guest_root_fs_available_kb.is_none()
            && self.guest_root_fs_inode_used_percent.is_none()
            && self.guest_root_fs_available_inodes.is_none()
            && self.guest_workspace_fs_used_percent.is_none()
            && self.guest_memory_available_mb.is_none()
    }
}

impl ExecutionFailure {
    #[must_use]
    pub fn new(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
    ) -> Self {
        let exit_code = normalize_failure_exit_code(exit_code);
        let error = non_empty_failure_error(exit_code, error.into());
        Self {
            exit_code,
            error,
            diagnostic,
            kind: ExecutionFailureKind::Generic,
            resource_diagnostics: None,
        }
    }

    #[must_use]
    pub fn runner_job_timeout(
        exit_code: i32,
        error: impl Into<String>,
        diagnostic: Option<FailureDiagnostic>,
        timeout: Duration,
        elapsed: Duration,
        guest_duration_ms: Option<u32>,
    ) -> Self {
        let exit_code = normalize_timeout_failure_exit_code(exit_code);
        let error = non_empty_failure_error(exit_code, error.into());
        Self {
            exit_code,
            error,
            diagnostic,
            kind: ExecutionFailureKind::RunnerJobTimeout {
                timeout_ms: timeout.as_millis(),
                elapsed_ms: elapsed.as_millis(),
                guest_duration_ms,
            },
            resource_diagnostics: None,
        }
    }

    #[must_use]
    pub fn with_resource_diagnostics(
        mut self,
        resource_diagnostics: Option<ResourceFailureDiagnostics>,
    ) -> Self {
        self.resource_diagnostics =
            resource_diagnostics.filter(|diagnostics| !diagnostics.is_empty());
        self
    }

    #[must_use]
    pub fn from_error(error: impl Into<String>) -> Self {
        Self::new(1, error, None)
    }

    #[must_use]
    pub fn cancelled() -> Self {
        Self::new(EXIT_SIGKILL, "cancelled by user", None)
    }
}

fn normalize_failure_exit_code(exit_code: i32) -> i32 {
    if exit_code == 0 { 1 } else { exit_code }
}

fn normalize_timeout_failure_exit_code(exit_code: i32) -> i32 {
    if exit_code == 0 {
        JOB_TIMEOUT_EXIT_CODE
    } else {
        exit_code
    }
}

fn non_empty_failure_error(exit_code: i32, error: String) -> String {
    if error.trim().is_empty() {
        agent_exit_failure_message(exit_code)
    } else {
        error
    }
}

fn agent_exit_failure_message(exit_code: i32) -> String {
    format!("Agent exited with code {exit_code}")
}

/// uploads (~383 ms saved per job).
#[cfg(test)]
pub async fn execute_job(
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    execute_job_with_prepared_notifier(
        factory,
        context,
        dispatch,
        config,
        params,
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks::none(),
    )
    .await
}

pub(crate) async fn execute_job_with_prepared_notifier(
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    cancellation: RunCancellationSignals,
    hooks: ExecutionHooks,
) -> (ExecuteOutcome, JobTelemetry) {
    let ExecutionHooks {
        sandbox_prepared,
        active_input_source,
        pre_spawn_timing,
        session_history_restore_plan,
    } = hooks;
    let spawn_timing = RunnerSpawnTiming::start(pre_spawn_timing);
    let run_id = context.run_id;
    let mut telemetry = JobTelemetry::new(
        config.http.clone(),
        run_id,
        context.sandbox_token.clone(),
        config.runner_hostname.clone(),
    );
    spawn_timing.record_claim_to_executor_start(&mut telemetry);
    config
        .storage_baseline_observer
        .record(&context, params, &mut telemetry);

    record_reuse_result(&mut telemetry, dispatch.reuse_result);
    record_api_latency("api_to_sandbox_start", &context, &mut telemetry);

    let sandbox_id = dispatch.id.to_string();
    let outcome = match validate_execution_context_before_sandbox(
        &context,
        &config.api_url,
        &sandbox_id,
        dispatch.reuse_result,
    ) {
        Err(error) => ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(error)),
            active_input_delivery_ids: Vec::new(),
            sandbox_reuse_disposition: SandboxReuseDisposition::default(),
            sandbox: None,
            source_ip: String::new(),
            network_log_session: None,
            workspace_image: None,
            workspace_reuse_result: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
        },
        Ok(prepared_run_payload) => match execute_new_sandbox_with_prepared_notifier(
            factory,
            &context,
            dispatch,
            config,
            params,
            &mut telemetry,
            NewSandboxHooks {
                preparation: FreshPreparation::Initial,
                controls: RunControls::from_cancellation(cancellation, active_input_source)
                    .with_spawn_timing(spawn_timing)
                    .with_session_history_restore_plan(session_history_restore_plan),
                prepared_run_payload,
                sandbox_prepared: sandbox_prepared.as_ref(),
            },
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(e) => ExecuteOutcome {
                failure: Some(ExecutionFailure::from_error(e.to_string())),
                active_input_delivery_ids: Vec::new(),
                sandbox_reuse_disposition: SandboxReuseDisposition::default(),
                sandbox: None,
                source_ip: String::new(),
                network_log_session: None,
                workspace_image: None,
                workspace_reuse_result: None,
                discovered_cli_agent_session_id: None,
                restored_session_identity: None,
            },
        },
    };

    (outcome, telemetry)
}

/// Execute a single job inside a **reused** (kept-alive) sandbox.
///
/// Skips create + start. Re-registers proxy, fixes clock, then runs the agent.
/// Returns [`ExecuteOutcome`] with the sandbox still alive plus the pending
/// [`JobTelemetry`] buffer — the caller (`spawn_job` in `cmd/start/job_spawn.rs`)
/// must flush telemetry after firing `provider.complete`, matching the fresh
/// sandbox path's completion ordering.
#[cfg(test)]
pub async fn execute_job_reuse(
    idle_sandbox: ReusableIdleSandbox,
    context: ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    execute_job_reuse_with_hooks(
        ReusedSandboxDispatch {
            factory: &sandbox_mock::MockSandboxFactory::new(),
            idle_sandbox,
            reuse_result: SandboxReuseResult::Reused,
        },
        context,
        config,
        params,
        RunCancellationSignals::hard_only(cancel),
        ExecutionHooks::none(),
    )
    .await
}

pub(crate) struct ReusedSandboxDispatch<'a> {
    pub(crate) factory: &'a dyn SandboxFactory,
    pub(crate) idle_sandbox: ReusableIdleSandbox,
    pub(crate) reuse_result: SandboxReuseResult,
}

pub(crate) async fn execute_job_reuse_with_hooks(
    dispatch: ReusedSandboxDispatch<'_>,
    context: ExecutionContext,
    config: &ExecutorConfig,
    params: &JobParams,
    cancellation: RunCancellationSignals,
    hooks: ExecutionHooks,
) -> (ExecuteOutcome, JobTelemetry) {
    let ReusedSandboxDispatch {
        factory,
        idle_sandbox,
        reuse_result,
    } = dispatch;
    let ExecutionHooks {
        sandbox_prepared: _,
        active_input_source,
        pre_spawn_timing,
        session_history_restore_plan,
    } = hooks;
    let spawn_timing = RunnerSpawnTiming::start(pre_spawn_timing);
    let run_id = context.run_id;
    let mut telemetry = JobTelemetry::new(
        config.http.clone(),
        run_id,
        context.sandbox_token.clone(),
        config.runner_hostname.clone(),
    );
    spawn_timing.record_claim_to_executor_start(&mut telemetry);
    config
        .storage_baseline_observer
        .record(&context, params, &mut telemetry);

    let idle_kind = idle_sandbox.kind();
    record_reuse_result(&mut telemetry, reuse_result);
    if idle_kind == IdleSandboxKind::Blank {
        telemetry.record("sandbox_blank_pool_hit", Duration::ZERO, true, None);
    }
    record_api_latency("api_to_sandbox_start", &context, &mut telemetry);

    let sandbox_id = idle_sandbox.sandbox_id();
    let ReusableIdleSandboxParts {
        sandbox,
        identity,
        source_ip,
        storage_fingerprints: prev_storage,
        restored_session_identity: _restored_session_identity,
        workspace_promotion,
        guest_state_prepared,
    } = idle_sandbox.into_parts();

    let kind = identity.kind();
    let idle_reuse_key = identity.reuse_key();
    let resume_session_error = validate_resume_session_id(&context).err();
    let claimed_reuse_key = context.reuse_key();
    let expected_promotion_reuse_key = if resume_session_error.is_some() {
        idle_reuse_key
    } else {
        idle_reuse_key.map(|exact_key| claimed_reuse_key.unwrap_or(exact_key))
    };
    let workspace_image = match resolve_reused_workspace_promotion(
        config.workspace_cache.as_ref(),
        workspace_promotion,
        run_id,
        sandbox_id,
        params,
        expected_promotion_reuse_key,
    )
    .await
    {
        Ok(workspace_image) => workspace_image,
        Err(failure) => {
            return (
                ExecuteOutcome::reused_sandbox_failure(*failure, sandbox, source_ip, None),
                telemetry,
            );
        }
    };

    if let Some(error) = resume_session_error {
        return (
            ExecuteOutcome::reused_sandbox_failure(
                ExecutionFailure::from_error(error),
                sandbox,
                source_ip,
                workspace_image,
            ),
            telemetry,
        );
    }

    let workspace_image = match (config.workspace_cache.as_ref(), workspace_image) {
        (_, Some(workspace_image)) => Some(workspace_image),
        (Some(cache), None) => Some(
            cache
                .lease_active(WorkspaceImageActiveLeaseRequest {
                    identity: WorkspaceImageLeaseIdentity {
                        run_id,
                        sandbox_id,
                        profile_name: &params.profile_name,
                        reuse_key: claimed_reuse_key,
                        working_dir: CANONICAL_WORKING_DIR,
                        image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
                    },
                    workspace_drive_available: true,
                })
                .await,
        ),
        (None, None) => None,
    };

    // The reuse owner either returns a live sandbox for caller finalization or
    // retires an unusable blank before attempting its single replacement.
    let sandbox_id_string = sandbox_id.to_string();
    let outcome = match validate_execution_context_before_sandbox(
        &context,
        &config.api_url,
        &sandbox_id_string,
        reuse_result,
    ) {
        Err(error) => ExecuteOutcome::reused_sandbox_failure(
            ExecutionFailure::from_error(error),
            sandbox,
            source_ip,
            workspace_image,
        ),
        Ok(prepared_run_payload) => {
            execute_reused_sandbox(
                ReusedSandboxRun {
                    sandbox_id,
                    factory,
                    params,
                    sandbox,
                    source_ip,
                    workspace_image,
                    kind,
                },
                &context,
                config,
                RunStart {
                    restore_guest_state: match kind {
                        IdleSandboxKind::Exact => true,
                        IdleSandboxKind::Blank => params.restore_guest_state,
                    },
                    reuse_result,
                    workspace_reuse_result: match kind {
                        IdleSandboxKind::Exact => WorkspaceReuseResult::SandboxReused,
                        IdleSandboxKind::Blank => blank_workspace_reuse_result(&context, config),
                    },
                    prev_storage: (kind == IdleSandboxKind::Exact).then_some(&prev_storage),
                },
                &mut telemetry,
                PreparedRunInputs::new(
                    RunControls::from_cancellation(cancellation, active_input_source)
                        .with_spawn_timing(spawn_timing)
                        .with_session_history_restore_plan(session_history_restore_plan)
                        .with_guest_state_prepared(guest_state_prepared),
                    prepared_run_payload,
                ),
            )
            .await
        }
    };

    (outcome, telemetry)
}

fn blank_workspace_reuse_result(
    context: &ExecutionContext,
    config: &ExecutorConfig,
) -> WorkspaceReuseResult {
    if config.workspace_cache.is_none() {
        WorkspaceReuseResult::NotConfigured
    } else if context.reuse_key().is_some() {
        WorkspaceReuseResult::CacheMiss
    } else {
        WorkspaceReuseResult::NoReuseKey
    }
}

async fn resolve_reused_workspace_promotion(
    cache: Option<&WorkspaceImageCache>,
    promotion: Option<WorkspaceImagePromotionContext>,
    run_id: RunId,
    sandbox_id: SandboxId,
    params: &JobParams,
    reuse_key: Option<&str>,
) -> Result<Option<WorkspaceImageLease>, Box<ExecutionFailure>> {
    let Some(promotion) = promotion else {
        return Ok(None);
    };
    let Some(reuse_key) = reuse_key else {
        abandon_unpublished_workspace_promotion(
            Some(promotion),
            "reuse_workspace_promotion_mismatch",
        )
        .await;
        return Err(workspace_promotion_identity_failure(
            run_id,
            sandbox_id,
            &params.profile_name,
            WorkspaceImagePromotionIdentityMismatch::ReuseKey,
        )
        .into());
    };
    let Some(cache) = cache else {
        promotion
            .invalidate_current("reused sandbox ran without workspace image cache")
            .await
            .map_err(|error| {
                ExecutionFailure::from_error(format!(
                    "failed to invalidate workspace image cache before unconfigured-cache reuse: {error}"
                ))
            })?;
        return Ok(None);
    };

    match reused_promotion_into_active_lease(
        cache, promotion, run_id, sandbox_id, params, reuse_key,
    ) {
        Ok(lease) => Ok(Some(lease)),
        Err(identity_failure) => {
            let WorkspaceImagePromotionIdentityFailure {
                promotion,
                mismatch,
            } = *identity_failure;
            let failure = workspace_promotion_identity_failure(
                run_id,
                sandbox_id,
                &params.profile_name,
                mismatch,
            );
            abandon_unpublished_workspace_promotion(
                Some(promotion),
                "reuse_workspace_promotion_mismatch",
            )
            .await;
            Err(failure.into())
        }
    }
}

fn reused_promotion_into_active_lease(
    cache: &WorkspaceImageCache,
    promotion: WorkspaceImagePromotionContext,
    run_id: RunId,
    sandbox_id: SandboxId,
    params: &JobParams,
    reuse_key: &str,
) -> Result<WorkspaceImageLease, Box<WorkspaceImagePromotionIdentityFailure>> {
    let expected = match cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: &params.profile_name,
            reuse_key,
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(params.workspace_disk_mb) * 1024 * 1024,
        })
        .inspect_err(|mismatch| {
            tracing::warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name = %params.profile_name,
                mismatch = mismatch.as_str(),
                "workspace promotion expected identity could not be constructed"
            );
        }) {
        Ok(expected) => expected,
        Err(mismatch) => {
            return Err(Box::new(WorkspaceImagePromotionIdentityFailure {
                promotion,
                mismatch,
            }));
        }
    };
    promotion.try_into_active_lease_preserving_context(&expected, true)
}

fn workspace_promotion_identity_failure(
    run_id: RunId,
    sandbox_id: SandboxId,
    profile_name: &str,
    mismatch: WorkspaceImagePromotionIdentityMismatch,
) -> ExecutionFailure {
    tracing::warn!(
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        profile_name,
        mismatch = mismatch.as_str(),
        "workspace promotion identity mismatch during reused sandbox execution"
    );
    ExecutionFailure::from_error(format!(
        "workspace promotion identity mismatch during reused sandbox execution: {mismatch}"
    ))
}

/// Dispatch inputs for the fresh-create path. Holds the UUID for the new sandbox
/// and the categorized reason no idle sandbox was reused. The id is selected in job
/// discovery after the reuse decision, then forwarded by `job_spawn`; it becomes
/// the sandbox's identity, and the reuse result is forwarded to the guest for
/// /complete metadata.
pub struct NewSandboxDispatch {
    pub id: SandboxId,
    pub reuse_result: SandboxReuseResult,
}

#[cfg(test)]
mod tests;
