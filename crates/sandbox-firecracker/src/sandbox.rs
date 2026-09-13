use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use guest_contracts::workspace_mount::WORKSPACE_DRIVE_MOUNT_REQUEST_DEADLINE;
use guest_control_client::{
    ExecOwnedCapturedOutput, FencedExecError, FrameWriteObserver, GuestControlClient,
    GuestStateRestoreResult, GuestStorageManifestResult, NormalOperationFence,
    NormalOperationFenceRejection, SupervisedExecControl, SupervisedExecRequest,
    SupervisedExecStartTiming, WorkspaceDriveMountResult,
};
use guest_control_proto::{
    ExecOutputPolicy, ExecProcessRole, ExecTimeoutPolicy,
    GuestStateRestoreTimezone as ProtoGuestStateRestoreTimezone,
};
use sandbox::{
    CodexSessionCleanupRequest, CopyFileOptions, CopyFileResult, DEFAULT_PROCESS_START_TIMEOUT,
    ExecRequest, ExecResult, GuestAgentProcessHandle, GuestAgentStartTiming, GuestMemorySnapshot,
    GuestProcessCancelHandle, GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter,
    GuestStateRestoreRequest, GuestStateRestoreTimezone, ProcessControlAck,
    ProcessControlFailureKind, ProcessControlGuestStatus, ProcessControlOutcome,
    ProcessControlWriteState, ProcessExit, ProcessOutputMode, Sandbox, SandboxConfig, SandboxError,
    SandboxFinalExecParkHandoff, SandboxFinalExecParkHandoffOutcome,
    SandboxFinalExecParkHandoffPoint, SandboxFinalExecParkObserver, SandboxFinalExecParkOutcome,
    SandboxFinalExecParkStage, SandboxFinalExecParkSubstage, SandboxFinalExecParkSubstageOutcome,
    SandboxIdleTransition, SandboxInvalidStateContext, SandboxOperation, SandboxOperationReason,
    SandboxParkNonReusableReason, SandboxParkOutcome, SandboxStartObserver, SandboxStartStage,
    SessionHistoryIdentityVerifyRequest, SevereMemoryRetentionDiagnostics,
    StartAgentProcessRequest, StartProcessRequest, StorageManifestRequest, WriteFileEntry,
};
use tokio::io::AsyncRead;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::api::BalloonStatistics;
use crate::duration::duration_ms;
use nbd_cow::PooledNbdCowDevice;

use crate::api::ApiClient;
use crate::balloon;
use crate::boot_config::{BootConfigInput, FirecrackerBootConfig};
use crate::config::{FirecrackerConfig, FirecrackerDeviceRateLimits};
use crate::control;
use crate::exec_operation_result::{
    captured_exec_output_bytes, exec_termination_from_vsock_termination, reject_stream_overflow,
    validate_exec_capture_timeout,
};
use crate::factory::InvariantConfig;
use crate::firecracker_process::spawn_firecracker;
use crate::guest_dns_failure_diagnostics::{
    GuestDnsFailureDiagnosticContext, capture_guest_dns_failure_diagnostics,
};
use crate::guest_dns_readiness::wait_for_guest_dns_readiness;
use crate::guest_operations::{GuestOperationStartError, GuestOperationStartGate};
use crate::host_cpu_cgroup::{GuestCpuCgroupLease, HostCpuCgroupManager};
use crate::leaked_resources::LeakedResources;
use crate::network::{NetnsInfo, NetnsLease};
use crate::park_coordinator::{
    CoordinatorState, DirtyReason, OperationStartRejection, ParkAttempt, ParkCoordinator,
    PrepareParkError, PrepareParkEvidence, RunControlBindError,
};
use crate::paths::{SandboxPaths, SockPaths};
use crate::process::{ChildExitNotifier, ProcessExitCompletion, kill_process_group};
use crate::process_log::{
    PROCESS_LOG_RECORD_MAX_BYTES, PROCESS_LOG_RECORD_TRUNCATED, ProcessLogRecord,
    read_process_log_records,
};
use crate::runtime_dirs::{prepare_private_runtime_vsock_dir, set_private_runtime_socket_mode};
use crate::snapshot_mount_namespace::{BindMount, SnapshotMountMode, build_command};

mod guest_connection_timing;
mod snapshot_restore;
mod state;

use snapshot_restore::{ensure_snapshot_drive_bind_target, load_snapshot_and_apply_rate_limits};
pub(crate) use state::SandboxState;
use state::{
    publish_process_state, publish_watch_state, state_publish_guard, transition_process_state,
    wait_for_backend_crash, wait_for_process_exit,
};

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for graceful shutdown via vsock.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for Firecracker API socket readiness after process spawn.
const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Short grace period for Firecracker stdout/stderr log readers after child exit.
const PROCESS_LOG_READER_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);

/// Timeout for guest lifecycle acknowledgements during same-session park/unpark.
const GUEST_PARK_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnparkPurpose {
    Reuse,
    BlankReuse,
    TerminalOperations,
}

/// Independent deadline for terminal diagnostics on an already-severe park.
const GUEST_MEMORY_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(1);

/// Elevated-latency signal below the production-equivalent 750 ms bound.
const PROCESS_CONTROL_LATENCY_INFO_THRESHOLD: Duration = Duration::from_millis(250);
/// Firecracker-calibrated upper bound for process-control delivery under load.
const PROCESS_CONTROL_LATENCY_WARN_THRESHOLD: Duration = Duration::from_millis(750);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessControlLatencyLevel {
    Info,
    Warn,
}

fn process_control_latency_level(elapsed: Duration) -> Option<ProcessControlLatencyLevel> {
    if elapsed >= PROCESS_CONTROL_LATENCY_WARN_THRESHOLD {
        Some(ProcessControlLatencyLevel::Warn)
    } else if elapsed >= PROCESS_CONTROL_LATENCY_INFO_THRESHOLD {
        Some(ProcessControlLatencyLevel::Info)
    } else {
        None
    }
}

fn process_control_outcome_label(outcome: &ProcessControlOutcome) -> &'static str {
    match outcome {
        ProcessControlOutcome::Delivered(_) => "delivered",
        ProcessControlOutcome::GuestStatus { status, .. } => match status {
            ProcessControlGuestStatus::Inactive => "guest_inactive",
            ProcessControlGuestStatus::NonceMismatch => "guest_nonce_mismatch",
            ProcessControlGuestStatus::Unsupported => "guest_unsupported",
            ProcessControlGuestStatus::Rejected => "guest_rejected",
            ProcessControlGuestStatus::SinkUnavailable => "guest_sink_unavailable",
            ProcessControlGuestStatus::SinkTimeout => "guest_sink_timeout",
            ProcessControlGuestStatus::QueueFull => "guest_queue_full",
            ProcessControlGuestStatus::SinkError => "guest_sink_error",
            ProcessControlGuestStatus::SinkClosed => "guest_sink_closed",
        },
        ProcessControlOutcome::GuestError(_) => "guest_error",
        ProcessControlOutcome::Failed {
            kind: ProcessControlFailureKind::Operation,
            ..
        } => "operation_failed",
        ProcessControlOutcome::Failed {
            kind: ProcessControlFailureKind::BackendCrashed,
            ..
        } => "backend_crashed",
    }
}

fn log_process_control_latency(
    elapsed: Duration,
    timeout: Duration,
    outcome: &ProcessControlOutcome,
) {
    let Some(level) = process_control_latency_level(elapsed) else {
        return;
    };
    let elapsed_ms = duration_ms(elapsed);
    let timeout_ms = duration_ms(timeout);
    let outcome = process_control_outcome_label(outcome);
    match level {
        ProcessControlLatencyLevel::Info => info!(
            elapsed_ms,
            timeout_ms, outcome, "process control latency elevated"
        ),
        ProcessControlLatencyLevel::Warn => warn!(
            elapsed_ms,
            timeout_ms, outcome, "process control latency exceeded calibrated bound"
        ),
    }
}

struct SandboxStartTiming<'a> {
    observer: Option<&'a mut dyn SandboxStartObserver>,
}

impl<'a> SandboxStartTiming<'a> {
    fn new(observer: Option<&'a mut dyn SandboxStartObserver>) -> Self {
        Self { observer }
    }

    fn record(&mut self, stage: SandboxStartStage, started: Instant, success: bool) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.record_stage(stage, started.elapsed(), success);
        }
    }
}

impl SandboxStartObserver for SandboxStartTiming<'_> {
    fn record_stage(&mut self, stage: SandboxStartStage, duration: Duration, success: bool) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.record_stage(stage, duration, success);
        }
    }

    fn record_dns_readiness_attempt(&mut self, attempt: sandbox::SandboxDnsReadinessAttempt) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.record_dns_readiness_attempt(attempt);
        }
    }
}

struct SandboxFinalExecParkTiming<'a> {
    observer: Option<&'a mut dyn SandboxFinalExecParkObserver>,
}

impl<'a> SandboxFinalExecParkTiming<'a> {
    fn new(observer: Option<&'a mut dyn SandboxFinalExecParkObserver>) -> Self {
        Self { observer }
    }

    fn record(&mut self, stage: SandboxFinalExecParkStage, started: Instant, success: bool) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.record_stage(stage, started.elapsed(), success);
        }
    }
}

struct SandboxFinalExecParkSubstageEvents<'a> {
    observer: Option<&'a mut dyn SandboxFinalExecParkObserver>,
}

impl<'a> SandboxFinalExecParkSubstageEvents<'a> {
    fn new(observer: Option<&'a mut dyn SandboxFinalExecParkObserver>) -> Self {
        Self { observer }
    }

    fn record(
        &mut self,
        substage: SandboxFinalExecParkSubstage,
        duration: Duration,
        success: bool,
        outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.record_substage(substage, duration, success, outcome);
        }
    }

    fn into_observer(self) -> Option<&'a mut dyn SandboxFinalExecParkObserver> {
        self.observer
    }
}

struct SnapshotLoadPaths {
    snapshot: String,
    memory: String,
}

pub(crate) fn build_fresh_boot_firecracker_config(
    invariant: &InvariantConfig,
    resources: &sandbox::ResourceLimits,
    kernel_path: String,
    cow_device_path: String,
    workspace_device_path: Option<String>,
    vsock_path: String,
    device_rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> sandbox::Result<FirecrackerBootConfig> {
    let config = FirecrackerBootConfig::new(BootConfigInput {
        invariant,
        vcpu_count: resources.cpu_count,
        memory_mb: resources.memory_mb,
        kernel_path,
        rootfs_path: cow_device_path,
        workspace_path: workspace_device_path,
        vsock_path,
    });
    match device_rate_limits {
        Some(rate_limits) => config
            .with_device_rate_limits(rate_limits)
            .map_err(|error| SandboxError::Start {
                message: format!("build drive rate limiter: {error}"),
            }),
        None => Ok(config),
    }
}

struct ProcessMonitorHandle {
    kill_tx: mpsc::Sender<control::ProcessTerminationRequest>,
    task: tokio::task::JoinHandle<()>,
    exit: ProcessExitCompletion,
}

impl ProcessMonitorHandle {
    fn kill(&self) {
        let _ = self
            .kill_tx
            .try_send(control::ProcessTerminationRequest::fire_and_forget());
    }

    fn termination_handle(
        &self,
        park_coordinator: ParkCoordinator,
    ) -> control::ProcessTerminationHandle {
        control::ProcessTerminationHandle::with_park_coordinator(
            self.kill_tx.clone(),
            park_coordinator,
        )
    }

    async fn wait(self) {
        let _ = self.task.await;
    }
}

#[derive(Default)]
struct SandboxRuntimeHandles {
    process: Option<ProcessMonitorHandle>,
    // Retained even when kill_process's consuming monitor wait is cancelled.
    process_exit: Option<ProcessExitCompletion>,
    control: Option<control::ControlServerHandle>,
    balloon: Option<balloon::ControllerHandle>,
}

impl SandboxRuntimeHandles {
    fn set_process(&mut self, process: ProcessMonitorHandle) {
        self.process_exit = Some(process.exit.clone());
        self.process = Some(process);
    }

    fn set_control(&mut self, control: control::ControlServerHandle) {
        self.control = Some(control);
    }

    fn set_balloon(&mut self, balloon: balloon::ControllerHandle) {
        self.balloon = Some(balloon);
    }

    fn process_termination_handle(
        &self,
        park_coordinator: ParkCoordinator,
    ) -> Option<control::ProcessTerminationHandle> {
        self.process
            .as_ref()
            .map(|process| process.termination_handle(park_coordinator))
    }

    fn balloon_mut(&mut self) -> &mut Option<balloon::ControllerHandle> {
        &mut self.balloon
    }

    async fn shutdown_services(&mut self) {
        if let Some(mut control) = self.control.take() {
            control.shutdown().await;
        }
        if let Some(balloon) = self.balloon.take() {
            balloon.abort();
        }
    }

    async fn kill_process(&mut self) {
        if let Some(process) = self.process.take() {
            process.kill();
            process.wait().await;
        }
    }

    fn abort_for_drop(&mut self) {
        if let Some(mut control) = self.control.take() {
            control.abort();
        }
        if let Some(balloon) = self.balloon.take() {
            balloon.abort();
        }
        if let Some(process) = self.process.take() {
            // Ask the monitor to kill the process group before it reaps the
            // child. This avoids signalling by a cached PID after the child
            // could have exited and been reused by the OS.
            process.kill();
        }
    }
}

#[derive(Clone, Copy)]
enum ProcessLogStream {
    Stdout,
    Stderr,
}

impl ProcessLogStream {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }

    fn log(self, id: &str, record: ProcessLogRecord<'_>) {
        match (self, record) {
            (Self::Stdout, ProcessLogRecord::Line(line)) => info!(id = %id, "{line}"),
            (Self::Stderr, ProcessLogRecord::Line(line)) => warn!(id = %id, "stderr: {line}"),
            (_, ProcessLogRecord::Truncated) => warn!(
                id = %id,
                stream = self.name(),
                limit_bytes = PROCESS_LOG_RECORD_MAX_BYTES,
                PROCESS_LOG_RECORD_TRUNCATED
            ),
        }
    }
}

struct ProcessLogReaders {
    stdout: Option<tokio::task::JoinHandle<()>>,
    stderr: Option<tokio::task::JoinHandle<()>>,
}

impl ProcessLogReaders {
    fn from_child(id: &str, child: &mut process_launch::asynchronous::Child) -> Self {
        Self {
            stdout: child
                .stdout
                .take()
                .map(|stdout| process_log_reader(id, ProcessLogStream::Stdout, stdout)),
            stderr: child
                .stderr
                .take()
                .map(|stderr| process_log_reader(id, ProcessLogStream::Stderr, stderr)),
        }
    }

    #[cfg(test)]
    fn new_for_test(
        stdout: Option<tokio::task::JoinHandle<()>>,
        stderr: Option<tokio::task::JoinHandle<()>>,
    ) -> Self {
        Self { stdout, stderr }
    }

    async fn drain_or_abort(mut self) {
        let stdout =
            drain_or_abort_process_log_reader(ProcessLogStream::Stdout, self.stdout.take());
        let stderr =
            drain_or_abort_process_log_reader(ProcessLogStream::Stderr, self.stderr.take());
        let _ = tokio::join!(stdout, stderr);
    }
}

fn process_log_reader<R>(
    id: &str,
    stream: ProcessLogStream,
    reader: R,
) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let id = id.to_owned();
    tokio::spawn(async move {
        let _ = read_process_log_records(reader, |record| stream.log(&id, record)).await;
    })
}

async fn drain_or_abort_process_log_reader(
    stream: ProcessLogStream,
    handle: Option<tokio::task::JoinHandle<()>>,
) {
    let Some(mut handle) = handle else {
        return;
    };

    match tokio::time::timeout(PROCESS_LOG_READER_DRAIN_TIMEOUT, &mut handle).await {
        Ok(result) => log_process_log_reader_join(stream, result, false),
        Err(_) => {
            info!(
                stream = stream.name(),
                timeout_ms = PROCESS_LOG_READER_DRAIN_TIMEOUT.as_millis() as u64,
                "process log reader did not drain before timeout; aborting"
            );
            handle.abort();
            log_process_log_reader_join(stream, handle.await, true);
        }
    }
}

fn log_process_log_reader_join(
    stream: ProcessLogStream,
    result: Result<(), tokio::task::JoinError>,
    after_abort: bool,
) {
    if let Err(e) = result
        && !(after_abort && e.is_cancelled())
    {
        warn!(
            stream = stream.name(),
            error = %e,
            "process log reader task exited unexpectedly"
        );
    }
}

struct ProcessMonitorContext {
    state: Arc<AtomicU8>,
    state_publish_lock: Arc<Mutex<()>>,
    state_tx: watch::Sender<SandboxState>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    runtime_cancel: CancellationToken,
    guest_cpu_cgroup: Option<GuestCpuCgroupLease>,
}

enum ProcessMonitorExit {
    NaturalPreReap,
    Reaped(io::Result<std::process::ExitStatus>),
}

/// Firecracker-backed implementation of [`sandbox::Sandbox`].
///
/// A `FirecrackerSandbox` owns the host-side resources for one Firecracker
/// sandbox lifecycle, including the VM process once started. Callers normally
/// obtain instances through [`crate::FirecrackerRuntime`] and
/// [`sandbox::SandboxFactory::create`] rather than constructing this type
/// directly.
///
/// Use the [`sandbox::Sandbox`] trait methods for sandbox operations and release
/// instances through [`sandbox::SandboxFactory::destroy`]. `Drop` only provides
/// best-effort emergency leak cleanup if explicit destruction is missed; it is
/// not a substitute for successful factory destruction.
pub struct FirecrackerSandbox {
    pub(crate) config: SandboxConfig,
    factory_config: FirecrackerConfig,
    /// Cached `config.id.to_string()`.
    pub(crate) id: String,
    /// Workspace paths (config, COW — persistent data).
    pub(crate) sandbox_paths: SandboxPaths,
    /// Runtime socket paths (api.sock, vsock).
    pub(crate) sock_paths: SockPaths,
    /// Pooled network namespace metadata plus cleanup ownership.
    pub(crate) network: SandboxNetwork,
    /// NBD COW device (torn down on destroy).
    pub(crate) cow_device: Option<PooledNbdCowDevice>,
    /// Firecracker-local device rate limiters for this sandbox lifecycle.
    device_rate_limits: Option<FirecrackerDeviceRateLimits>,
    /// Per-sandbox runtime task handles.
    runtime: SandboxRuntimeHandles,
    /// Process-group leader PID for the spawned Firecracker wrapper.
    /// Captured at spawn time for cleanup and best-effort host-side OOM
    /// correlation.
    process_group_pid: Option<u32>,
    /// Lifecycle state, shared with the process monitor for crash detection.
    state: Arc<AtomicU8>,
    /// Serializes updates to `state` and `state_tx` so the durable watch state
    /// cannot be overwritten by an older lifecycle transition after the process
    /// monitor publishes a terminal state.
    state_publish_lock: Arc<Mutex<()>>,
    /// Durable lifecycle state stream. Unlike `Notify`, late subscribers see
    /// the latest value, which keeps crash/startup-exit classification
    /// deterministic after the process monitor has already observed exit.
    state_tx: watch::Sender<SandboxState>,
    /// Guest control connection, shared with the process monitor so it can
    /// drop the connection immediately when the process exits unexpectedly.
    /// Wrapped in `Arc` so operations can clone the handle and release the
    /// mutex immediately, allowing concurrent vsock operations.
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    /// Host-side park coordinator for same-session idle park safety.
    park_coordinator: ParkCoordinator,
    /// Sender for leaked resource cleanup. When Drop fires without prior
    /// `factory.destroy()`, pool resources are sent here for async cleanup.
    leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    delete_workspace_on_leak_cleanup: bool,
    /// Set to `true` by `factory.destroy()` to suppress Drop-based leak recovery.
    pub(crate) destroyed: bool,
    /// Tracks whether the sandbox has completed the park transition into the
    /// idle/parked lifecycle state. A successful park pauses vCPUs, but this
    /// flag does not prove that a large VM's balloon reached its target:
    /// reclaim may be partial, skipped, or interrupted by an exact-successor
    /// handoff. The separate `park_outcome` records reuse eligibility, so a
    /// sandbox can be parked but non-reusable after severe memory retention.
    /// Set by `park()` after the pause succeeds and cleared by a completed
    /// `unpark()`. Used to make both methods idempotent, to let `unpark()` know
    /// whether it should touch the balloon controller, and to let `stop()`
    /// skip vsock graceful shutdown (a paused guest cannot respond).
    is_parked: bool,
    /// Eligibility returned by the completed park that set `is_parked`.
    /// Retained so an idempotent repeated park cannot upgrade a non-reusable
    /// sandbox to reusable.
    park_outcome: Option<SandboxParkOutcome>,
    /// Memory policy of the completed park; consumed by the next unpark.
    park_memory_policy: ParkMemoryPolicy,
    /// Host-side normal-operation fence held while this sandbox is parked.
    park_fence: Option<NormalOperationFence>,
    guest_rpc_endpoint: Option<crate::guest_rpc::GuestRpcEndpoint>,
    runtime_cancel: CancellationToken,
    /// Optional managed host CPU placement for the Firecracker process.
    host_cpu_cgroup: Option<Arc<HostCpuCgroupManager>>,
}

pub(crate) struct FirecrackerSandboxInit {
    pub(crate) config: SandboxConfig,
    pub(crate) factory_config: FirecrackerConfig,
    pub(crate) sandbox_paths: SandboxPaths,
    pub(crate) sock_paths: SockPaths,
    pub(crate) network: NetnsLease,
    pub(crate) cow_device: PooledNbdCowDevice,
    pub(crate) device_rate_limits: Option<FirecrackerDeviceRateLimits>,
    pub(crate) leak_tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    pub(crate) host_cpu_cgroup: Option<Arc<HostCpuCgroupManager>>,
}

pub(crate) struct SandboxNetwork {
    info: NetnsInfo,
    lease: Option<NetnsLease>,
}

impl SandboxNetwork {
    fn from_lease(lease: NetnsLease) -> Self {
        Self {
            info: lease.info().clone(),
            lease: Some(lease),
        }
    }

    fn name(&self) -> &str {
        self.info.name()
    }

    fn peer_ip(&self) -> &str {
        self.info.peer_ip()
    }

    fn host_device(&self) -> &str {
        self.info.host_device()
    }

    fn mark_non_reusable(&mut self) -> sandbox::Result<()> {
        let lease = self.lease.as_mut().ok_or_else(|| SandboxError::Start {
            message: "network lease missing while marking attachment non-reusable".into(),
        })?;
        lease.mark_non_reusable();
        Ok(())
    }

    fn mark_reusable(&mut self) -> sandbox::Result<()> {
        let lease = self.lease.as_mut().ok_or_else(|| SandboxError::Start {
            message: "network lease missing while marking attachment reusable".into(),
        })?;
        lease.mark_reusable();
        Ok(())
    }

    pub(crate) fn lease_mut(&mut self) -> &mut Option<NetnsLease> {
        &mut self.lease
    }

    pub(crate) fn take_lease(&mut self) -> Option<NetnsLease> {
        self.lease.take()
    }

    pub(crate) fn has_lease(&self) -> bool {
        self.lease.is_some()
    }
}

struct ProcessStartContractRequest<'a> {
    command: &'a str,
    timeout_ms: u32,
    timeout_is_expected: bool,
    start_timeout: Duration,
    env: &'a [(&'a str, &'a str)],
    sudo: bool,
    output: ProcessOutputMode,
    label: &'a str,
}

impl FirecrackerSandbox {
    pub(crate) fn new(init: FirecrackerSandboxInit) -> Self {
        let FirecrackerSandboxInit {
            config,
            factory_config,
            sandbox_paths,
            sock_paths,
            network,
            cow_device,
            device_rate_limits,
            leak_tx,
            host_cpu_cgroup,
        } = init;
        let id = config.id.to_string();
        Self {
            config,
            factory_config,
            id,
            sandbox_paths,
            sock_paths,
            network: SandboxNetwork::from_lease(network),
            cow_device: Some(cow_device),
            device_rate_limits,
            runtime: SandboxRuntimeHandles::default(),
            process_group_pid: None,
            state: Arc::new(AtomicU8::new(SandboxState::Created as u8)),
            state_publish_lock: Arc::new(Mutex::new(())),
            state_tx: watch::channel(SandboxState::Created).0,
            guest: Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>)),
            park_coordinator: ParkCoordinator::new(),
            leak_tx,
            delete_workspace_on_leak_cleanup: true,
            destroyed: false,
            is_parked: false,
            park_outcome: None,
            park_memory_policy: ParkMemoryPolicy::Reclaim,
            park_fence: None,
            guest_rpc_endpoint: None,
            runtime_cancel: CancellationToken::new(),
            host_cpu_cgroup,
        }
    }

    pub(crate) fn cow_device(&self) -> sandbox::Result<&PooledNbdCowDevice> {
        self.cow_device.as_ref().ok_or_else(|| SandboxError::Start {
            message: "COW device missing before sandbox start".into(),
        })
    }

    pub(crate) fn preserve_workspace_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = false;
    }

    pub(crate) async fn terminate_process_for_cleanup(&mut self) -> bool {
        // A cancelled stop may leave Stopping with a live monitor. Cleanup
        // must still request termination when the public kill transition skips it.
        self.runtime.kill_process().await;
        self.process_exit_confirmed().await
    }

    async fn process_exit_confirmed(&self) -> bool {
        match &self.runtime.process_exit {
            Some(exit) => exit.confirmed().await,
            None => true, // No process was launched.
        }
    }

    pub(crate) fn allow_workspace_delete_on_leak_cleanup(&mut self) {
        self.delete_workspace_on_leak_cleanup = true;
    }

    fn current_state(&self) -> SandboxState {
        SandboxState::from_u8(self.state.load(Ordering::Acquire))
    }

    fn not_running_error(&self, operation: SandboxOperation) -> SandboxError {
        Self::operation_unavailable_error(operation, self.current_state())
    }

    fn operation_unavailable_error(
        operation: SandboxOperation,
        state: SandboxState,
    ) -> SandboxError {
        if state == SandboxState::Crashed {
            return Self::backend_crashed_error(operation);
        }

        SandboxError::InvalidState {
            context: SandboxInvalidStateContext::Operation(operation),
            state: state.to_string(),
            message: "sandbox not running".into(),
        }
    }

    fn backend_crashed_error(operation: SandboxOperation) -> SandboxError {
        SandboxError::Operation {
            operation,
            reason: SandboxOperationReason::BackendCrashed,
            message: "firecracker process crashed".into(),
        }
    }

    fn operation_error(
        operation: SandboxOperation,
        error: io::Error,
        backend_crashed: bool,
    ) -> SandboxError {
        if let Some(write) = error
            .get_ref()
            .and_then(|source| source.downcast_ref::<guest_control_client::RequestWriteError>())
        {
            let stage = match write.stage() {
                guest_control_client::RequestWriteStage::BeforeFrameWrite => {
                    if backend_crashed {
                        return Self::backend_crashed_error(operation);
                    }
                    sandbox::SandboxOperationWriteStage::BeforeFrameWrite
                }
                guest_control_client::RequestWriteStage::FrameWrite => {
                    sandbox::SandboxOperationWriteStage::FrameWrite
                }
            };
            // A coincident backend crash must not hide a possibly partial frame.
            return SandboxError::OperationWrite {
                operation,
                stage,
                source: error,
            };
        }
        if backend_crashed {
            return Self::backend_crashed_error(operation);
        }
        if let Some(timeout) = error
            .get_ref()
            .and_then(|source| source.downcast_ref::<guest_control_client::RequestTimeoutError>())
        {
            let stage = match timeout.stage() {
                guest_control_client::RequestTimeoutStage::BeforeFrameWrite => {
                    sandbox::SandboxOperationTimeoutStage::BeforeFrameWrite
                }
                guest_control_client::RequestTimeoutStage::FrameWrite => {
                    sandbox::SandboxOperationTimeoutStage::FrameWrite
                }
                guest_control_client::RequestTimeoutStage::AwaitingTerminalResponse => {
                    sandbox::SandboxOperationTimeoutStage::AwaitingTerminalResponse
                }
            };
            return SandboxError::OperationTimeout {
                operation,
                stage,
                timeout_ms: u64::try_from(timeout.timeout().as_millis()).unwrap_or(u64::MAX),
            };
        }
        let admission_rejection = error.get_ref().and_then(|source| {
            source.downcast_ref::<guest_control_client::NormalOperationRejection>()
        });
        let reason = if matches!(
            admission_rejection,
            Some(
                guest_control_client::NormalOperationRejection::NotParkable
                    | guest_control_client::NormalOperationRejection::Closed
            )
        ) {
            SandboxOperationReason::GuestConnectionUnavailable
        } else if error.kind() == io::ErrorKind::TimedOut {
            SandboxOperationReason::Timeout
        } else {
            SandboxOperationReason::Guest
        };
        SandboxError::Operation {
            operation,
            reason,
            message: error.to_string(),
        }
    }

    fn invalid_env_key_error(operation: SandboxOperation, key: &str) -> SandboxError {
        SandboxError::Operation {
            operation,
            reason: SandboxOperationReason::Other,
            message: format!("invalid environment variable name: {}", key.escape_debug()),
        }
    }

    fn validate_exec_env_keys(
        operation: SandboxOperation,
        env: &[(&str, &str)],
    ) -> sandbox::Result<()> {
        for (key, _) in env {
            if !guest_contracts::env::is_shell_identifier_env_key(key) {
                return Err(Self::invalid_env_key_error(operation, key));
            }
        }
        Ok(())
    }

    fn operation_gate_closed_error(
        operation: SandboxOperation,
        state: crate::park_coordinator::CoordinatorState,
    ) -> SandboxError {
        SandboxError::InvalidState {
            context: SandboxInvalidStateContext::Operation(operation),
            state: format!("{state:?}"),
            message: "sandbox operation gate closed".into(),
        }
    }

    fn operation_start_error(
        &self,
        operation: SandboxOperation,
        error: GuestOperationStartError,
    ) -> SandboxError {
        match error {
            GuestOperationStartError::BackendCrashed => Self::backend_crashed_error(operation),
            GuestOperationStartError::NotRunning { state } => {
                Self::operation_unavailable_error(operation, state)
            }
            GuestOperationStartError::NoGuest => self.not_running_error(operation),
            GuestOperationStartError::GateClosed { state } => {
                Self::operation_gate_closed_error(operation, state)
            }
        }
    }

    fn has_backend_crashed(&self) -> bool {
        self.current_state() == SandboxState::Crashed
    }

    fn publish_state(&self, state: SandboxState) {
        publish_process_state(&self.state, &self.state_publish_lock, &self.state_tx, state);
    }

    fn guest_operation_start_gate(&self) -> GuestOperationStartGate {
        GuestOperationStartGate::new(Arc::clone(&self.guest), self.park_coordinator.clone())
    }

    async fn begin_guest_operation(
        &self,
        operation: SandboxOperation,
    ) -> sandbox::Result<Arc<GuestControlClient>> {
        self.guest_operation_start_gate()
            .begin_sandbox_operation(|| self.current_state())
            .await
            .map_err(|error| self.operation_start_error(operation, error))
    }

    async fn run_bounded_guest_operation<T, Fut>(
        &self,
        operation: SandboxOperation,
        call: impl FnOnce(Arc<GuestControlClient>) -> Fut,
    ) -> sandbox::Result<T>
    where
        Fut: Future<Output = io::Result<T>>,
    {
        self.run_bounded_guest_operation_with_validation(operation, || Ok(()), call)
            .await
    }

    async fn run_bounded_guest_operation_with_validation<T, Fut>(
        &self,
        operation: SandboxOperation,
        validate: impl FnOnce() -> sandbox::Result<()>,
        call: impl FnOnce(Arc<GuestControlClient>) -> Fut,
    ) -> sandbox::Result<T>
    where
        Fut: Future<Output = io::Result<T>>,
    {
        enum GuestCallOutcome<T> {
            Returned(io::Result<T>),
            BackendCrashed,
        }

        let vsock = self.begin_guest_operation(operation).await?;
        validate()?;

        let outcome = tokio::select! {
            result = call(Arc::clone(&vsock)) => {
                GuestCallOutcome::Returned(result)
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                GuestCallOutcome::BackendCrashed
            }
        };

        match outcome {
            GuestCallOutcome::Returned(Ok(value)) => Ok(value),
            GuestCallOutcome::Returned(Err(error)) => {
                let backend_crashed = self.has_backend_crashed();
                self.log_private_write_timeout_diagnostic(&vsock, &error)
                    .await;
                Err(Self::operation_error(operation, error, backend_crashed))
            }
            GuestCallOutcome::BackendCrashed => Err(Self::backend_crashed_error(operation)),
        }
    }

    async fn log_private_write_timeout_diagnostic(
        &self,
        guest: &GuestControlClient,
        error: &io::Error,
    ) {
        let Some(sequence) = error
            .get_ref()
            .and_then(|source| source.downcast_ref::<guest_control_client::RequestTimeoutError>())
            .and_then(guest_control_client::RequestTimeoutError::private_write_sequence)
        else {
            return;
        };
        // The write has already expired and normal operations remain fenced.
        // This independent, read-only control probe must never replace the
        // initiating error or extend the write's original 60-second budget.
        match guest.file_write_status(Duration::from_secs(1)).await {
            Ok(status) => warn!(
                id = %self.id,
                write_sequence = sequence,
                observed_write_sequence = status.sequence,
                guest_write_stage = status.stage.label(),
                diagnostic_outcome = if status.sequence == sequence { "matched" } else { "different_request" },
                "private file-write timeout guest diagnostic"
            ),
            Err(diagnostic_error) => warn!(
                id = %self.id,
                write_sequence = sequence,
                diagnostic_outcome = "unavailable",
                diagnostic_error_kind = ?diagnostic_error.kind(),
                "private file-write timeout guest diagnostic"
            ),
        }
    }

    fn current_state_from(state: &AtomicU8) -> SandboxState {
        SandboxState::from_u8(state.load(Ordering::Acquire))
    }

    fn begin_process_control(
        coordinator: &ParkCoordinator,
        current_state: impl Fn() -> SandboxState,
    ) -> Result<(), GuestOperationStartError> {
        match current_state() {
            SandboxState::Running => {}
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        coordinator
            .ensure_operation_start_allowed()
            .map_err(|error| match error {
                OperationStartRejection::GateClosed { state } => {
                    GuestOperationStartError::GateClosed { state }
                }
            })?;

        match current_state() {
            SandboxState::Running => {}
            SandboxState::Crashed => return Err(GuestOperationStartError::BackendCrashed),
            state => return Err(GuestOperationStartError::NotRunning { state }),
        }

        Ok(())
    }

    fn operation_start_io_error(
        operation: SandboxOperation,
        error: GuestOperationStartError,
        current_state: SandboxState,
    ) -> io::Error {
        let error = match error {
            GuestOperationStartError::BackendCrashed => Self::backend_crashed_error(operation),
            GuestOperationStartError::NotRunning { state } => {
                Self::operation_unavailable_error(operation, state)
            }
            GuestOperationStartError::NoGuest => {
                Self::operation_unavailable_error(operation, current_state)
            }
            GuestOperationStartError::GateClosed { state } => {
                Self::operation_gate_closed_error(operation, state)
            }
        };
        io::Error::other(error)
    }

    fn process_control_guest_status(
        status: guest_control_proto::ExecControlStatus,
    ) -> io::Result<ProcessControlGuestStatus> {
        let status = match status {
            guest_control_proto::ExecControlStatus::Inactive => ProcessControlGuestStatus::Inactive,
            guest_control_proto::ExecControlStatus::NonceMismatch => {
                ProcessControlGuestStatus::NonceMismatch
            }
            guest_control_proto::ExecControlStatus::Unsupported => {
                ProcessControlGuestStatus::Unsupported
            }
            guest_control_proto::ExecControlStatus::Rejected => ProcessControlGuestStatus::Rejected,
            guest_control_proto::ExecControlStatus::SinkUnavailable => {
                ProcessControlGuestStatus::SinkUnavailable
            }
            guest_control_proto::ExecControlStatus::SinkTimeout => {
                ProcessControlGuestStatus::SinkTimeout
            }
            guest_control_proto::ExecControlStatus::QueueFull => {
                ProcessControlGuestStatus::QueueFull
            }
            guest_control_proto::ExecControlStatus::SinkError => {
                ProcessControlGuestStatus::SinkError
            }
            guest_control_proto::ExecControlStatus::SinkClosed => {
                ProcessControlGuestStatus::SinkClosed
            }
            guest_control_proto::ExecControlStatus::Delivered => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "delivered exec-control status used a guest-status outcome",
                ));
            }
        };
        Ok(status)
    }

    fn process_control_write_state(write_started: &AtomicBool) -> ProcessControlWriteState {
        if write_started.load(Ordering::Acquire) {
            ProcessControlWriteState::PossiblyWritten
        } else {
            ProcessControlWriteState::NotWritten
        }
    }

    fn process_control_failure(
        kind: ProcessControlFailureKind,
        write_started: &AtomicBool,
        error: io::Error,
    ) -> ProcessControlOutcome {
        ProcessControlOutcome::Failed {
            kind,
            write_state: Self::process_control_write_state(write_started),
            error,
        }
    }

    async fn exec_process_control(
        coordinator: ParkCoordinator,
        state: Arc<AtomicU8>,
        state_rx: watch::Receiver<SandboxState>,
        control: guest_control_client::ExecControlHandle,
        message_id: String,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> ProcessControlOutcome {
        enum ControlOutcome {
            Returned(io::Result<guest_control_client::ExecControlOutcome>),
            BackendCrashed,
        }

        let started = Instant::now();
        let operation = SandboxOperation::ProcessControl;
        let write_started = Arc::new(AtomicBool::new(false));
        if let Err(error) =
            Self::begin_process_control(&coordinator, || Self::current_state_from(&state))
        {
            let kind = if matches!(&error, GuestOperationStartError::BackendCrashed) {
                ProcessControlFailureKind::BackendCrashed
            } else {
                ProcessControlFailureKind::Operation
            };
            let outcome = Self::process_control_failure(
                kind,
                &write_started,
                Self::operation_start_io_error(operation, error, Self::current_state_from(&state)),
            );
            log_process_control_latency(started.elapsed(), timeout, &outcome);
            return outcome;
        }

        let write_observer = FrameWriteObserver::new({
            let write_started = Arc::clone(&write_started);
            move || {
                write_started.store(true, Ordering::Release);
                Ok(())
            }
        });

        let outcome = tokio::select! {
            result = control.control_owned_with_write_observer(
                message_id,
                payload,
                timeout,
                write_observer,
            ) => ControlOutcome::Returned(result),
            () = wait_for_backend_crash(state_rx) => ControlOutcome::BackendCrashed,
        };

        let outcome = match outcome {
            ControlOutcome::Returned(Ok(guest_control_client::ExecControlOutcome::Delivered(
                ack,
            ))) => ProcessControlOutcome::Delivered(ProcessControlAck {
                message_id: ack.message_id,
            }),
            ControlOutcome::Returned(Ok(
                guest_control_client::ExecControlOutcome::GuestStatus(status),
            )) => match Self::process_control_guest_status(status.status) {
                Ok(guest_status) => ProcessControlOutcome::GuestStatus {
                    status: guest_status,
                    diagnostic: status.diagnostic,
                },
                Err(error) => Self::process_control_failure(
                    ProcessControlFailureKind::Operation,
                    &write_started,
                    error,
                ),
            },
            ControlOutcome::Returned(Ok(guest_control_client::ExecControlOutcome::GuestError(
                message,
            ))) => ProcessControlOutcome::GuestError(message),
            ControlOutcome::Returned(Err(error)) => {
                if Self::current_state_from(&state) == SandboxState::Crashed {
                    Self::process_control_failure(
                        ProcessControlFailureKind::BackendCrashed,
                        &write_started,
                        io::Error::other(Self::backend_crashed_error(operation)),
                    )
                } else {
                    Self::process_control_failure(
                        ProcessControlFailureKind::Operation,
                        &write_started,
                        error,
                    )
                }
            }
            ControlOutcome::BackendCrashed => Self::process_control_failure(
                ProcessControlFailureKind::BackendCrashed,
                &write_started,
                io::Error::other(Self::backend_crashed_error(operation)),
            ),
        };
        log_process_control_latency(started.elapsed(), timeout, &outcome);
        outcome
    }

    /// Atomically transition between states using CAS. Returns `true` if the
    /// transition succeeded, `false` if the current state did not match `from`.
    fn transition(&self, from: SandboxState, to: SandboxState) -> bool {
        transition_process_state(
            &self.state,
            &self.state_publish_lock,
            &self.state_tx,
            from,
            to,
        )
    }

    /// Build the Firecracker JSON configuration for fresh boot.
    fn build_config(&self) -> sandbox::Result<FirecrackerBootConfig> {
        let invariant = InvariantConfig::new();
        let kernel_path = self.factory_config.kernel_path.display().to_string();
        let cow_device_path = self.cow_device()?.device_path().display().to_string();
        let workspace_device_path = self
            .config
            .workspace_drive
            .as_ref()
            .map(|_| self.sandbox_paths.workspace_image().display().to_string());
        let vsock_path = self.sock_paths.vsock().display().to_string();

        build_fresh_boot_firecracker_config(
            &invariant,
            &self.config.resources,
            kernel_path,
            cow_device_path,
            workspace_device_path,
            vsock_path,
            self.device_rate_limits.as_ref(),
        )
    }

    /// Spawn a prepared Firecracker command and adopt it into the sandbox runtime.
    ///
    /// Callers retain boot-mode-specific command arguments. Once spawning succeeds,
    /// this method installs runtime ownership before any later fallible operation;
    /// [`Sandbox::start`] remains responsible for cleanup when startup fails.
    async fn spawn_and_wait_for_api(
        &mut self,
        command: process_launch::Command,
        api_sock: &Path,
        runtime_cancel: CancellationToken,
        boot_mode: &str,
    ) -> sandbox::Result<ApiClient> {
        let guest_cpu_cgroup = self
            .host_cpu_cgroup
            .as_ref()
            .map(|manager| manager.acquire(self.config.id, self.config.resources.cpu_count))
            .transpose()?;
        let placement_directory = guest_cpu_cgroup
            .as_ref()
            .map(GuestCpuCgroupLease::clone_placement_directory)
            .transpose()
            .map_err(|e| SandboxError::Start {
                message: format!("clone Guest CPU cgroup placement descriptor: {e}"),
            })?;
        let child = spawn_firecracker(command, self.sandbox_paths.workspace(), placement_directory)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!(
                    "spawn firecracker: {e} (boot_mode={boot_mode}, api_sock={})",
                    api_sock.display()
                ),
            })?;

        self.process_group_pid = child.id();
        let context = ProcessMonitorContext {
            state: Arc::clone(&self.state),
            state_publish_lock: Arc::clone(&self.state_publish_lock),
            state_tx: self.state_tx.clone(),
            guest: Arc::clone(&self.guest),
            runtime_cancel,
            guest_cpu_cgroup,
        };
        self.runtime
            .set_process(monitor_process_with_context(&self.id, child, context));

        let client = ApiClient::new(api_sock).map_err(|e| SandboxError::Start {
            message: format!(
                "create API client: {e} (boot_mode={boot_mode}, api_sock={})",
                api_sock.display()
            ),
        })?;
        tokio::select! {
            result = client.wait_for_ready(API_READY_TIMEOUT) => {
                result.map_err(|e| {
                    let sock_dir_exists_after = api_sock.parent().is_some_and(Path::exists);
                    SandboxError::Start {
                        message: format!(
                            "API not ready: {e} (boot_mode={boot_mode}, api_sock={}, sock_dir_exists_after={sock_dir_exists_after})",
                            api_sock.display()
                        ),
                    }
                })?;
                set_private_runtime_socket_mode(api_sock).map_err(|e| SandboxError::Start {
                    message: format!(
                        "restrict API socket permissions: {e} (boot_mode={boot_mode}, api_sock={})",
                        api_sock.display()
                    ),
                })?;
            }
            state = wait_for_process_exit(self.state_tx.subscribe()) => {
                return Err(SandboxError::Start {
                    message: format!(
                        "firecracker process exited before API became ready (boot_mode={boot_mode}, state={state}, api_sock={})",
                        api_sock.display()
                    ),
                });
            }
        }

        Ok(client)
    }

    /// Start using a fresh boot with `--config-file --api-sock`.
    async fn start_fresh(
        &mut self,
        runtime_cancel: CancellationToken,
    ) -> sandbox::Result<ApiClient> {
        let config = self.build_config()?;
        let config_json =
            serde_json::to_string_pretty(&config).map_err(|e| SandboxError::Start {
                message: format!("serialize config: {e}"),
            })?;

        tokio::fs::write(self.sandbox_paths.config(), config_json.as_bytes())
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("write config: {e}"),
            })?;

        let api_sock = self.sock_paths.api_sock();

        let mut command = process_launch::Command::new("ip");
        command
            .args(["netns", "exec"])
            .arg(self.network.name())
            .arg(&self.factory_config.binary_path)
            .args(["--config-file"])
            .arg(self.sandbox_paths.config())
            .args(["--api-sock"])
            .arg(&api_sock);

        let client = self
            .spawn_and_wait_for_api(command, &api_sock, runtime_cancel, "fresh boot")
            .await?;

        info!(id = %self.id, "firecracker started (fresh boot)");
        Ok(client)
    }

    /// Launch from a snapshot using `--api-sock` and bind mounts.
    async fn launch_from_snapshot(
        &mut self,
        runtime_cancel: CancellationToken,
    ) -> sandbox::Result<(ApiClient, SnapshotLoadPaths)> {
        let snapshot =
            self.factory_config
                .snapshot
                .as_ref()
                .ok_or_else(|| SandboxError::Start {
                    message: "missing snapshot config".into(),
                })?;
        if self.config.workspace_drive.is_none() {
            return Err(SandboxError::Start {
                message: "snapshot restore requires a workspace drive".into(),
            });
        }

        // Ensure bind mount target directories exist.
        prepare_private_runtime_vsock_dir(&snapshot.vsock_bind_dir).map_err(|e| {
            SandboxError::Start {
                message: format!("prepare snapshot vsock dir: {e}"),
            }
        })?;

        ensure_snapshot_drive_bind_target(&snapshot.drive_bind_path).await?;
        ensure_snapshot_drive_bind_target(&snapshot.workspace_drive_bind_path).await?;

        // Verify sock dir exists before spawning — if this fails, we know
        // the directory was never created or was removed before spawn.
        let api_sock = self.sock_paths.api_sock();
        let sock_dir = self.sock_paths.dir();
        let sock_dir_exists = tokio::fs::try_exists(sock_dir).await.unwrap_or(false);
        if !sock_dir_exists {
            return Err(SandboxError::Start {
                message: format!("sock dir missing before spawn: {}", sock_dir.display()),
            });
        }
        let cow_device_path = self.cow_device()?.device_path();
        let workspace_image_path = self.sandbox_paths.workspace_image();
        info!(
            id = %self.id,
            api_sock = %api_sock.display(),
            sock_dir = %sock_dir.display(),
            cow_device = %cow_device_path.display(),
            workspace_image = %workspace_image_path.display(),
            netns = %self.network.name(),
            binary = %self.factory_config.binary_path.display(),
            "spawning firecracker (snapshot restore)"
        );

        // Bind mount targets are snapshot-level paths shared by all sandboxes.
        // Each sandbox runs inside `unshare --mount`, so bind mounts are
        // per-namespace and don't conflict.
        //
        // IMPORTANT: we must NOT `rm -f` the bind mount target.  The target
        // file is shared across all mount namespaces via the underlying
        // filesystem.  Deleting it would orphan bind mounts in other
        // namespaces (their mount is on the old dentry, but the directory
        // now points to a replacement dentry), causing Firecracker to
        // see an empty file instead of the dm device → Permission denied.
        //
        // `umount` clears any stale mount inherited from the parent
        // namespace (e.g. from a crashed snapshot creation).
        let snapshot_str = snapshot.snapshot_path.display().to_string();
        let memory_str = snapshot.memory_path.display().to_string();
        let command = build_command(
            SnapshotMountMode::Restore {
                vsock: BindMount::new(&self.sock_paths.vsock_dir(), &snapshot.vsock_bind_dir),
                rootfs: BindMount::new(cow_device_path, &snapshot.drive_bind_path),
                workspace: BindMount::new(
                    &workspace_image_path,
                    &snapshot.workspace_drive_bind_path,
                ),
            },
            self.network.name(),
            &self.factory_config.binary_path,
            &api_sock,
        );

        let client = self
            .spawn_and_wait_for_api(command, &api_sock, runtime_cancel, "snapshot restore")
            .await?;

        Ok((
            client,
            SnapshotLoadPaths {
                snapshot: snapshot_str,
                memory: memory_str,
            },
        ))
    }

    async fn start_with_optional_observer(
        &mut self,
        observer: Option<&mut dyn SandboxStartObserver>,
    ) -> sandbox::Result<()> {
        if self.current_state() != SandboxState::Created {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Sandbox,
                state: self.current_state().to_string(),
                message: "sandbox already started".into(),
            });
        }

        let mut timing = SandboxStartTiming::new(observer);
        let backend_started = Instant::now();
        if self.factory_config.dns_port.is_some()
            && let Err(error) = self.network.mark_non_reusable()
        {
            timing.record(SandboxStartStage::BackendLaunch, backend_started, false);
            return Err(error);
        }

        let runtime_cancel = self.runtime_cancel.clone();
        // Synchronous bind precedes BOTH fresh guest boot and snapshot resume.
        // Until successful startup, this local owner covers all error/cancel paths.
        let guest_rpc_endpoint =
            self.bind_guest_rpc_endpoint()
                .map_err(|error| SandboxError::Start {
                    message: format!("bind guest RPC transport: {error}"),
                })?;

        // Submit the vsock listener before launching Firecracker. The task
        // overlaps backend startup; submission is not a listener-bind barrier.
        let vsock_path = self.sock_paths.vsock().display().to_string();
        let observe_connection = timing.observer.is_some();
        let connection_submitted = Instant::now();
        let mut vsock_task = tokio::spawn(async move {
            if observe_connection {
                let (result, timing) = GuestControlClient::wait_for_connection_with_timing(
                    &vsock_path,
                    VSOCK_CONNECT_TIMEOUT,
                )
                .await;
                (result, Some(timing))
            } else {
                (
                    GuestControlClient::wait_for_connection(&vsock_path, VSOCK_CONNECT_TIMEOUT)
                        .await,
                    None,
                )
            }
        });

        let launch_result = if self.factory_config.snapshot.is_some() {
            self.launch_from_snapshot(runtime_cancel.clone())
                .await
                .map(|(client, paths)| (client, Some(paths)))
        } else {
            self.start_fresh(runtime_cancel.clone())
                .await
                .map(|client| (client, None))
        };

        let (client, snapshot_paths) = match launch_result {
            Ok(result) => {
                timing.record(SandboxStartStage::BackendLaunch, backend_started, true);
                result
            }
            Err(error) => {
                timing.record(SandboxStartStage::BackendLaunch, backend_started, false);
                abort_and_join(vsock_task).await;
                self.runtime.kill_process().await;
                return Err(error);
            }
        };

        if let Some(paths) = snapshot_paths {
            let snapshot_started = Instant::now();
            let snapshot_result = load_snapshot_and_apply_rate_limits(
                &client,
                &paths.snapshot,
                &paths.memory,
                self.device_rate_limits.as_ref(),
            )
            .await;
            match snapshot_result {
                Ok(()) => {
                    info!(id = %self.id, "snapshot loaded and resumed");
                    timing.record(
                        SandboxStartStage::SnapshotLoadResume,
                        snapshot_started,
                        true,
                    );
                }
                Err(error) => {
                    timing.record(
                        SandboxStartStage::SnapshotLoadResume,
                        snapshot_started,
                        false,
                    );
                    abort_and_join(vsock_task).await;
                    self.runtime.kill_process().await;
                    return Err(error);
                }
            }
        }

        // The listener overlaps backend startup. Measure only the remaining
        // critical-path wait after launch and optional snapshot restore.
        let guest_connection_started = Instant::now();
        let mut connection_timing = None;
        let (guest_connection_result, abort_vsock_on_failure) = tokio::select! {
            result = &mut vsock_task => {
                let result = match result {
                    Ok((result, observed_timing)) => {
                        connection_timing = observed_timing;
                        result.map_err(|error| SandboxError::Start {
                            message: format!("vsock connection: {error}"),
                        })
                    },
                    Err(error) => Err(SandboxError::Start {
                        message: format!("vsock task: {error}"),
                    }),
                };
                (result, false)
            }
            state = wait_for_process_exit(self.state_tx.subscribe()) => {
                (
                    Err(SandboxError::Start {
                        message: format!("process exited before vsock connected (state={state})"),
                    }),
                    true,
                )
            }
        };
        let connection_observed = Instant::now();
        timing.record(
            SandboxStartStage::GuestConnectionWait,
            guest_connection_started,
            guest_connection_result.is_ok(),
        );
        if let Some(connection_timing) = connection_timing
            && let Some(observer) = timing.observer.as_deref_mut()
        {
            guest_connection_timing::record_guest_connection_timing(
                observer,
                connection_timing,
                connection_submitted,
                guest_connection_started,
                connection_observed,
            );
        }
        let guest_control_client = match guest_connection_result {
            Ok(guest) => guest,
            Err(error) => {
                if abort_vsock_on_failure {
                    abort_and_join(vsock_task).await;
                }
                self.runtime.kill_process().await;
                return Err(error);
            }
        };

        let guest_control_client = Arc::new(guest_control_client);

        if let Some(dns_port) = self.factory_config.dns_port {
            let dns_started = Instant::now();
            match wait_for_guest_dns_readiness(&guest_control_client, &mut timing).await {
                Ok(()) => {
                    timing.record(SandboxStartStage::GuestDnsReadiness, dns_started, true);
                }
                Err(error) => {
                    timing.record(SandboxStartStage::GuestDnsReadiness, dns_started, false);
                    capture_guest_dns_failure_diagnostics(
                        guest_control_client.as_ref(),
                        GuestDnsFailureDiagnosticContext {
                            sandbox_id: &self.id,
                            profile: &self.factory_config.profile,
                            namespace: self.network.name(),
                            host_device: self.network.host_device(),
                            peer_ip: self.network.peer_ip(),
                            dns_port,
                            readiness_attempts: error.attempts,
                            startup_mode: if self.factory_config.snapshot.is_some() {
                                "snapshot_restore"
                            } else {
                                "fresh"
                            },
                        },
                    )
                    .await;
                    warn!(
                        id = %self.id,
                        profile = %self.factory_config.profile,
                        namespace = %self.network.name(),
                        peer_ip = %self.network.peer_ip(),
                        stage = "guest_dns_readiness",
                        outcome = %error.last_failure,
                        attempts = error.attempts,
                        elapsed_ms = duration_ms(error.elapsed),
                        "guest DNS readiness probe failed"
                    );
                    self.runtime.kill_process().await;
                    return Err(SandboxError::GuestDnsReadiness {
                        reason: error.last_failure.sandbox_reason(),
                        message: format!(
                            "guest DNS readiness for namespace {}: {error}",
                            self.network.name(),
                        ),
                    });
                }
            }
        }

        let finalize_started = Instant::now();
        if self.factory_config.dns_port.is_some()
            && let Err(error) = self.network.mark_reusable()
        {
            timing.record(SandboxStartStage::RuntimeFinalize, finalize_started, false);
            self.runtime.kill_process().await;
            return Err(error);
        }

        *self.guest.lock().await = Some(guest_control_client);

        let control_sock_path = self.sock_paths.control_sock();
        let Some(termination_handle) = self
            .runtime
            .process_termination_handle(self.park_coordinator.clone())
        else {
            timing.record(SandboxStartStage::RuntimeFinalize, finalize_started, false);
            self.guest.lock().await.take();
            self.runtime.kill_process().await;
            return Err(SandboxError::Start {
                message: "process monitor missing before control socket bind".into(),
            });
        };
        let control_server = match control::bind_server(
            control_sock_path.clone(),
            self.guest_operation_start_gate(),
            termination_handle,
        ) {
            Ok(server) => server,
            Err(error) => {
                timing.record(SandboxStartStage::RuntimeFinalize, finalize_started, false);
                self.guest.lock().await.take();
                self.runtime.kill_process().await;
                return Err(SandboxError::Start {
                    message: format!(
                        "control socket bind {}: {error}",
                        control_sock_path.display()
                    ),
                });
            }
        };

        // Use CAS to avoid overwriting Stopped if the process crashed between
        // spawn and vsock connect (the process monitor may have already
        // recorded process exit).
        if !self.transition(SandboxState::Created, SandboxState::Running) {
            timing.record(SandboxStartStage::RuntimeFinalize, finalize_started, false);
            self.guest.lock().await.take();
            control_server.close();
            self.runtime.kill_process().await;
            return Err(SandboxError::Start {
                message: "process exited during startup".into(),
            });
        }

        // Start control socket server for `runner exec` and host-side
        // termination requests.
        self.runtime
            .set_control(control_server.spawn(runtime_cancel));

        // Spawn balloon controller to reclaim unused guest memory.
        self.runtime.set_balloon(balloon::spawn(
            client,
            self.config.resources.memory_mb,
            self.state_tx.subscribe(),
        ));

        self.guest_rpc_endpoint = Some(guest_rpc_endpoint);

        info!(id = %self.id, "sandbox started");
        timing.record(SandboxStartStage::RuntimeFinalize, finalize_started, true);
        Ok(())
    }

    fn bind_guest_rpc_endpoint(&self) -> io::Result<crate::guest_rpc::GuestRpcEndpoint> {
        crate::guest_rpc::GuestRpcEndpoint::bind(
            self.sock_paths.guest_rpc(),
            crate::guest_rpc::GuestRpcContext {
                sandbox_id: self.id.clone(),
                state: Arc::clone(&self.state),
                guest: Arc::clone(&self.guest),
                coordinator: self.park_coordinator.clone(),
            },
            self.runtime_cancel.clone(),
        )
    }
}

async fn abort_and_join<T>(task: tokio::task::JoinHandle<T>) {
    task.abort();
    let _ = task.await;
}

impl Drop for FirecrackerSandbox {
    fn drop(&mut self) {
        drop(self.guest_rpc_endpoint.take());
        self.runtime_cancel.cancel();
        // Drop cannot await async teardown, so fall back to synchronous
        // runtime aborts and ask the monitor to kill the process group.
        self.runtime.abort_for_drop();
        // Dropping the task handle detaches it; the monitor still owns and
        // reaps the `Child` while the runtime is alive.

        // If factory.destroy() was not called, send pool resources to the
        // async cleanup channel so they can be released without blocking.
        // The owned pooled COW device carries the pool lease; copied device
        // indices are diagnostics only and are not release authority.
        if !self.destroyed
            && let Some(tx) = self.leak_tx.take()
        {
            let resources = LeakedResources {
                sandbox_id: self.id.clone(),
                process_exit: self.runtime.process_exit.take(),
                cow_device: self.cow_device.take(),
                network: self.network.take_lease(),
                sock_dir: self.sock_paths.dir().to_owned(),
                workspace: self.sandbox_paths.workspace().to_owned(),
                delete_workspace: self.delete_workspace_on_leak_cleanup,
            };
            if tx.send(resources).is_err() {
                tracing::warn!(
                    id = %self.id,
                    "leak cleanup channel closed — resources will require runner gc"
                );
            }
        }
    }
}

/// Monitor the child process for exit and forward logs.
///
/// The process monitor owns the `Child`, so process exit is classified from
/// `wait()` rather than from stdout/stderr pipe EOF. Stdout and stderr readers
/// are only log forwarders.
#[cfg(test)]
fn monitor_process(
    id: &str,
    child: process_launch::asynchronous::Child,
    state: Arc<AtomicU8>,
    state_publish_lock: Arc<Mutex<()>>,
    state_tx: watch::Sender<SandboxState>,
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    runtime_cancel: CancellationToken,
) -> ProcessMonitorHandle {
    let context = ProcessMonitorContext {
        state,
        state_publish_lock,
        state_tx,
        guest,
        runtime_cancel,
        guest_cpu_cgroup: None,
    };
    monitor_process_with_context(id, child, context)
}

fn monitor_process_with_context(
    id: &str,
    mut child: process_launch::asynchronous::Child,
    context: ProcessMonitorContext,
) -> ProcessMonitorHandle {
    let readers = ProcessLogReaders::from_child(id, &mut child);
    monitor_process_with_log_readers(id, child, context, readers)
}

fn monitor_process_with_log_readers(
    id: &str,
    child: process_launch::asynchronous::Child,
    context: ProcessMonitorContext,
    readers: ProcessLogReaders,
) -> ProcessMonitorHandle {
    let exit_notifier = ChildExitNotifier::open(child.id());
    monitor_process_with_log_readers_and_exit_notifier(id, child, context, readers, exit_notifier)
}

fn monitor_process_with_log_readers_and_exit_notifier(
    id: &str,
    mut child: process_launch::asynchronous::Child,
    mut context: ProcessMonitorContext,
    readers: ProcessLogReaders,
    exit_notifier: ChildExitNotifier,
) -> ProcessMonitorHandle {
    let guest_cpu_cgroup = context.guest_cpu_cgroup.take();
    if let Some(reason) = exit_notifier.unavailable_reason() {
        warn!(
            id = %id,
            reason = %reason,
            "pidfd child exit notification unavailable; natural exit cleanup will not signal by cached PID after reap"
        );
    }
    let id = id.to_owned();
    let (kill_tx, mut kill_rx) = mpsc::channel::<control::ProcessTerminationRequest>(1);
    let (exit_tx, exit) = ProcessExitCompletion::channel();
    let task = tokio::spawn(async move {
        let exit = wait_for_process_monitor_exit(&mut child, &exit_notifier, &mut kill_rx).await;
        let (prev, status) = match exit {
            ProcessMonitorExit::NaturalPreReap => {
                let prev = publish_process_monitor_exit(&context);
                if prev == SandboxState::Running {
                    let _ = kill_process_group(child.id());
                }
                (prev, child.wait().await)
            }
            ProcessMonitorExit::Reaped(status) => (publish_process_monitor_exit(&context), status),
        };
        let _ = exit_tx.send(status.is_ok());

        if let Err(error) = &status {
            warn!(id = %id, %error, "process monitor failed to wait for child");
        }
        if let Some(guest_cpu_cgroup) = guest_cpu_cgroup
            && let Err(error) = guest_cpu_cgroup.release()
        {
            warn!(id = %id, %error, "failed to release Guest CPU cgroup after process reap");
        }
        context.runtime_cancel.cancel();

        match prev {
            SandboxState::Running => {
                match status {
                    Ok(status) => warn!(id = %id, %status, "process exited unexpectedly"),
                    Err(error) => warn!(id = %id, %error, "process wait failed unexpectedly"),
                }
                context.guest.lock().await.take();
            }
            SandboxState::Created | SandboxState::Stopping | SandboxState::Stopped => {}
            SandboxState::Crashed => {}
        }
        readers.drain_or_abort().await;
    });

    ProcessMonitorHandle {
        kill_tx,
        task,
        exit,
    }
}

async fn wait_for_process_monitor_exit(
    child: &mut process_launch::asynchronous::Child,
    exit_notifier: &ChildExitNotifier,
    kill_rx: &mut mpsc::Receiver<control::ProcessTerminationRequest>,
) -> ProcessMonitorExit {
    let has_exit_notifier = exit_notifier.is_available();
    tokio::select! {
        exit = exit_notifier.wait_for_exit(), if has_exit_notifier => {
            match exit {
                Ok(()) => ProcessMonitorExit::NaturalPreReap,
                Err(error) => {
                    warn!(%error, "pidfd child exit notification failed; falling back to wait-only cleanup");
                    ProcessMonitorExit::Reaped(child.wait().await)
                }
            }
        }
        status = child.wait(), if !has_exit_notifier => ProcessMonitorExit::Reaped(status),
        request = kill_rx.recv() => {
            ProcessMonitorExit::Reaped(wait_after_process_termination_request(child, kill_rx, request).await)
        }
    }
}

async fn wait_after_process_termination_request(
    child: &mut process_launch::asynchronous::Child,
    kill_rx: &mut mpsc::Receiver<control::ProcessTerminationRequest>,
    request: Option<control::ProcessTerminationRequest>,
) -> io::Result<std::process::ExitStatus> {
    if let Some(request) = request {
        let _ = kill_process_group(child.id());
        request.acknowledge();
        kill_rx.close();
        // Closed receivers can still observe sends that already reserved
        // capacity, so drain through `None` before wait.
        while let Some(request) = kill_rx.recv().await {
            request.acknowledge();
        }
    }
    child.wait().await
}

fn publish_process_monitor_exit(context: &ProcessMonitorContext) -> SandboxState {
    let _guard = state_publish_guard(&context.state_publish_lock);
    match context.state.compare_exchange(
        SandboxState::Running as u8,
        SandboxState::Crashed as u8,
        Ordering::AcqRel,
        Ordering::Acquire,
    ) {
        Ok(v) => {
            publish_watch_state(&context.state_tx, SandboxState::Crashed);
            SandboxState::from_u8(v)
        }
        Err(v) => {
            let prev = SandboxState::from_u8(v);
            if matches!(
                prev,
                SandboxState::Created | SandboxState::Stopping | SandboxState::Stopped
            ) {
                context
                    .state
                    .store(SandboxState::Stopped as u8, Ordering::Release);
                publish_watch_state(&context.state_tx, SandboxState::Stopped);
            }
            prev
        }
    }
}

fn process_timeout_policy(timeout_ms: u32) -> ExecTimeoutPolicy {
    if timeout_ms == 0 {
        ExecTimeoutPolicy::None
    } else {
        ExecTimeoutPolicy::Duration { timeout_ms }
    }
}

fn process_stdout_policy(output: ProcessOutputMode) -> ExecOutputPolicy {
    match output {
        ProcessOutputMode::Buffered { output_limits } => ExecOutputPolicy::Capture {
            limit_bytes: output_limits.stdout_limit_bytes,
        },
        ProcessOutputMode::Stream {
            stream_limit_bytes,
            chunk_limit_bytes,
            ..
        } => ExecOutputPolicy::Stream {
            limit_bytes: stream_limit_bytes,
            chunk_limit_bytes,
        },
    }
}

fn process_stderr_policy(output: ProcessOutputMode) -> ExecOutputPolicy {
    match output {
        ProcessOutputMode::Buffered { output_limits } => ExecOutputPolicy::Capture {
            limit_bytes: output_limits.stderr_limit_bytes,
        },
        ProcessOutputMode::Stream {
            stderr_capture_limit_bytes: Some(limit_bytes),
            ..
        } => ExecOutputPolicy::Capture { limit_bytes },
        ProcessOutputMode::Stream {
            stderr_capture_limit_bytes: None,
            ..
        } => ExecOutputPolicy::Discard,
    }
}

fn process_stream_queue_capacity(output: ProcessOutputMode) -> Option<usize> {
    match output {
        ProcessOutputMode::Buffered { .. } => None,
        ProcessOutputMode::Stream { queue_capacity, .. } => Some(queue_capacity),
    }
}

fn captured_output_bytes(output: ExecOwnedCapturedOutput) -> (Vec<u8>, bool) {
    match output {
        ExecOwnedCapturedOutput::Discarded => (Vec::new(), false),
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => (bytes, truncated),
    }
}

fn exec_result_from_operation_result(
    result: guest_control_client::ExecOperationResult,
) -> io::Result<ExecResult> {
    reject_stream_overflow(&result)?;

    let (stdout, stdout_truncated) = captured_exec_output_bytes("stdout", result.stdout)?;
    let (stderr, stderr_truncated) = captured_exec_output_bytes("stderr", result.stderr)?;

    Ok(ExecResult {
        termination: exec_termination_from_vsock_termination(result.termination),
        guest_duration_ms: Some(result.duration_ms),
        stdout,
        stderr,
        diagnostic: result.diagnostic,
        stdout_truncated,
        stderr_truncated,
    })
}

fn supervised_exec_result_to_process_exit(
    guest_pid: u32,
    result: guest_control_client::ExecOperationResult,
) -> ProcessExit {
    let (stdout, stdout_truncated) = captured_output_bytes(result.stdout);
    let (stderr, stderr_truncated) = captured_output_bytes(result.stderr);

    ProcessExit {
        guest_pid,
        termination: exec_termination_from_vsock_termination(result.termination),
        guest_duration_ms: Some(result.duration_ms),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: result.diagnostic,
        stream_overflowed: result.stream_overflowed,
    }
}

fn exec_capture_request<'a>(
    request: &ExecRequest<'a>,
    timeout_ms: u32,
    label: &'a str,
) -> guest_control_client::ExecCaptureRequest<'a> {
    let limits = request.output_limits;
    guest_control_client::ExecCaptureRequest {
        command: request.cmd,
        timeout_ms,
        env: request.env,
        sudo: request.sudo,
        label,
        stdout_limit_bytes: limits.stdout_limit_bytes,
        stderr_limit_bytes: limits.stderr_limit_bytes,
        expected_exit_codes: request.expected_exit_codes,
        stdin_bytes: request.stdin_bytes,
        wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
    }
}

impl FirecrackerSandbox {
    async fn start_process_with_contract(
        &self,
        request: ProcessStartContractRequest<'_>,
        operation: SandboxOperation,
        role: ExecProcessRole,
        control: SupervisedExecControl,
    ) -> sandbox::Result<(GuestProcessHandle, SupervisedExecStartTiming)> {
        let vsock = self.begin_guest_operation(operation).await?;
        Self::validate_exec_env_keys(operation, request.env)?;
        request.output.validate(operation)?;

        let start_future = async move {
            vsock
                .start_supervised_process(SupervisedExecRequest {
                    role,
                    timeout: process_timeout_policy(request.timeout_ms),
                    timeout_is_expected: request.timeout_is_expected,
                    command: request.command,
                    env: request.env,
                    sudo: request.sudo,
                    label: request.label,
                    stdout: process_stdout_policy(request.output),
                    stderr: process_stderr_policy(request.output),
                    expected_exit_codes: &[],
                    stdin_bytes: None,
                    control,
                    stream_queue_capacity: process_stream_queue_capacity(request.output),
                    start_timeout: request.start_timeout,
                })
                .await
        };

        tokio::select! {
            result = start_future => {
                let mut handle = match result {
                    Ok(handle) => handle,
                    Err(error) => {
                        let backend_crashed = self.has_backend_crashed();
                        return Err(Self::operation_error(operation, error, backend_crashed));
                    }
                };
                let guest_pid = handle.pid();
                let start_timing = handle.start_timing();
                let process_control = handle.control_handle().map(|control| {
                    let coordinator = self.park_coordinator.clone();
                    let state = Arc::clone(&self.state);
                    let state_rx = self.state_tx.subscribe();
                    GuestProcessControlHandle::new_with_outcome(
                        move |message_id, payload, timeout| {
                            let control = control.clone();
                            let coordinator = coordinator.clone();
                            let state = Arc::clone(&state);
                            let state_rx = state_rx.clone();
                            Box::pin(async move {
                                Self::exec_process_control(
                                    coordinator, state, state_rx, control, message_id, payload, timeout,
                                )
                                .await
                            })
                        },
                    )
                });
                let stdout_rx = if request.output.streams_stdout() {
                    handle.take_process_output_receiver()
                } else {
                    None
                };
                let process_cancel = handle.take_cancel_handle().map(|cancel| {
                    GuestProcessCancelHandle::new(move |timeout| {
                        Box::pin(async move { cancel.cancel(timeout).await })
                    })
                });
                let wait = GuestProcessWaiter::new(move |timeout| {
                    Box::pin(async move {
                        let result = handle.wait(timeout).await?;
                        Ok(supervised_exec_result_to_process_exit(guest_pid, result))
                    })
                });
                let mut public_handle =
                    GuestProcessHandle::new(guest_pid, stdout_rx, process_control, wait);
                if let Some(process_cancel) = process_cancel {
                    public_handle = public_handle.with_cancel_handle(process_cancel);
                }
                Ok((public_handle, start_timing))
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }

    async fn final_exec_and_park_with_optional_observer(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        handoff: Option<&SandboxFinalExecParkHandoff>,
        observer: Option<&mut dyn SandboxFinalExecParkObserver>,
    ) -> sandbox::Result<SandboxFinalExecParkHandoffOutcome> {
        if self.is_parked {
            return Err(idle_transition_error(
                SandboxIdleTransition::Park,
                "final guest exec cannot run on an already parked sandbox",
            ));
        }

        let operation = SandboxOperation::Exec;
        Self::validate_exec_env_keys(operation, request.env)?;
        let timeout_ms = request.timeout_ms();
        validate_exec_capture_timeout(timeout_ms)
            .map_err(|error| Self::operation_error(operation, error, self.has_backend_crashed()))?;

        let coordinator = self.park_coordinator.clone();
        let guest = Arc::clone(&self.guest);
        let final_exec_guest = Arc::clone(&guest);
        let physical_park_guest = Arc::clone(&guest);
        let id = self.id.clone();
        let park_id = id.clone();
        let is_parked = &mut self.is_parked;
        let memory_mb = self.config.resources.memory_mb;
        let balloon_controller = self.runtime.balloon_mut();
        let api_sock = self.sock_paths.api_sock();
        let final_exec_request = exec_capture_request(request, timeout_ms, diagnostic_label);
        let (normal_operations_fence, physical_outcome, exec_result) =
            park_with_ready_for_park_and_preparation_with_observer(
                &id,
                &coordinator,
                observer,
                || async move {
                    let guest =
                        final_exec_guest
                            .lock()
                            .await
                            .as_ref()
                            .cloned()
                            .ok_or_else(|| {
                                ParkNormalOperationFenceError::GuestUnavailable(io::Error::new(
                                    io::ErrorKind::NotConnected,
                                    "guest connection missing during final park operation",
                                ))
                            })?;
                    let (result, fence) = guest
                        .exec_operation_capture_with_fence(final_exec_request)
                        .await
                        .map_err(|error| match error {
                            FencedExecError::FenceRejected(error) => {
                                ParkNormalOperationFenceError::Rejected(error)
                            }
                            FencedExecError::Operation(error) => {
                                ParkNormalOperationFenceError::FinalOperation(error)
                            }
                        })?;
                    let result = exec_result_from_operation_result(result)
                        .map_err(ParkNormalOperationFenceError::FinalOperation)?;
                    Ok((fence, result))
                },
                || async move {
                    let guest = guest.lock().await.as_ref().cloned().ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::NotConnected,
                            "guest connection missing during park quiesce",
                        )
                    })?;
                    guest.quiesce_operations(GUEST_PARK_LIFECYCLE_TIMEOUT).await
                },
                |timing, events| async move {
                    let (events, result) = park_inner_with_guest_and_handoff(
                        is_parked,
                        memory_mb,
                        balloon_controller,
                        &api_sock,
                        &park_id,
                        PhysicalParkRequest {
                            guest: physical_park_guest,
                            handoff,
                            memory_policy: ParkMemoryPolicy::Reclaim,
                        },
                        events,
                    )
                    .await;
                    (timing, events, result)
                },
            )
            .await?;
        self.park_fence = Some(normal_operations_fence);
        drop(self.guest_rpc_endpoint.take());
        self.park_memory_policy = ParkMemoryPolicy::Reclaim;
        match physical_outcome {
            PhysicalParkOutcome::Idle(park_outcome) => {
                self.park_outcome = Some(park_outcome.clone());
                Ok(SandboxFinalExecParkHandoffOutcome::Parked(
                    SandboxFinalExecParkOutcome {
                        exec_result,
                        park_outcome,
                    },
                ))
            }
            PhysicalParkOutcome::Handoff(point) => {
                self.park_outcome = None;
                Ok(SandboxFinalExecParkHandoffOutcome::Handoff { exec_result, point })
            }
        }
    }

    async fn park_with_memory_policy(
        &mut self,
        memory_policy: ParkMemoryPolicy,
    ) -> sandbox::Result<SandboxParkOutcome> {
        if self.is_parked {
            if self.park_fence.is_none() {
                let message = "sandbox is parked without a normal-operation fence";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(SandboxIdleTransition::Park, message));
            }
            let Some(outcome) = self.park_outcome.clone() else {
                let message = "sandbox is parked without a recorded park outcome";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(SandboxIdleTransition::Park, message));
            };
            ensure_park_noop_state(&self.park_coordinator)?;
            return Ok(outcome);
        }

        let coordinator = self.park_coordinator.clone();
        let guest = Arc::clone(&self.guest);
        let fence_guest = Arc::clone(&guest);
        let physical_park_guest = Arc::clone(&guest);
        let id = self.id.clone();
        let api_sock = self.sock_paths.api_sock();
        let (normal_operations_fence, outcome) = park_with_ready_for_park(
            &id,
            &coordinator,
            || async move {
                let guest = fence_guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    ParkNormalOperationFenceError::GuestUnavailable(io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during park fence",
                    ))
                })?;
                guest
                    .try_fence_normal_operations()
                    .map_err(ParkNormalOperationFenceError::Rejected)
            },
            || async move {
                let guest = guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during park quiesce",
                    )
                })?;
                guest.quiesce_operations(GUEST_PARK_LIFECYCLE_TIMEOUT).await
            },
            || async {
                let (_, result) = park_inner_with_guest(
                    &mut self.is_parked,
                    self.config.resources.memory_mb,
                    self.runtime.balloon_mut(),
                    &api_sock,
                    &id,
                    PhysicalParkRequest {
                        guest: physical_park_guest,
                        handoff: None,
                        memory_policy,
                    },
                    SandboxFinalExecParkSubstageEvents::new(None),
                )
                .await;
                result
            },
        )
        .await?;
        self.park_fence = Some(normal_operations_fence);
        self.park_outcome = Some(outcome.clone());
        self.park_memory_policy = memory_policy;
        drop(self.guest_rpc_endpoint.take());
        Ok(outcome)
    }

    async fn unpark_with_purpose(&mut self, purpose: UnparkPurpose) -> sandbox::Result<()> {
        if !self.is_parked {
            if self.park_fence.is_some() {
                let message = "sandbox has a normal-operation fence while unpark is a no-op";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(
                    SandboxIdleTransition::Unpark,
                    message,
                ));
            }
            if self.park_outcome.is_some() {
                let message = "sandbox has a recorded park outcome while unpark is a no-op";
                self.park_coordinator.mark_dirty(DirtyReason::new(message));
                return Err(idle_transition_error(
                    SandboxIdleTransition::Unpark,
                    message,
                ));
            }
            return ensure_unpark_noop_state(&self.park_coordinator);
        }
        if self.park_fence.is_none() {
            let message = "sandbox is parked without a normal-operation fence";
            self.park_coordinator.mark_dirty(DirtyReason::new(message));
            return Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ));
        }

        let guest_rpc_endpoint = self.bind_guest_rpc_endpoint().map_err(|error| {
            idle_transition_error(
                SandboxIdleTransition::Unpark,
                format!("bind guest RPC transport: {error}"),
            )
        })?;
        let coordinator = self.park_coordinator.clone();
        let guest = Arc::clone(&self.guest);
        let id = self.id.clone();
        let api_sock = self.sock_paths.api_sock();
        let memory_mb = self.config.resources.memory_mb;
        let state_rx = self.state_tx.subscribe();
        let is_parked = &mut self.is_parked;
        let balloon_controller = self.runtime.balloon_mut();
        let park_fence = &mut self.park_fence;
        let purpose = if purpose == UnparkPurpose::Reuse
            && self.park_memory_policy == ParkMemoryPolicy::Preserve
        {
            UnparkPurpose::BlankReuse
        } else {
            purpose
        };
        unpark_with_ready_for_operations(
            &id,
            &coordinator,
            || {
                unpark_inner(
                    is_parked,
                    memory_mb,
                    balloon_controller,
                    &api_sock,
                    state_rx,
                    &id,
                    purpose,
                )
            },
            || async move {
                let guest = guest.lock().await.as_ref().cloned().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotConnected,
                        "guest connection missing during unpark resume",
                    )
                })?;
                guest.resume_operations(GUEST_PARK_LIFECYCLE_TIMEOUT).await
            },
            || {
                drop(park_fence.take());
            },
        )
        .await?;
        self.park_outcome = None;
        self.park_memory_policy = ParkMemoryPolicy::Reclaim;
        self.guest_rpc_endpoint = Some(guest_rpc_endpoint);
        Ok(())
    }
}

#[async_trait]
impl Sandbox for FirecrackerSandbox {
    // -- identity --

    fn id(&self) -> &str {
        &self.id
    }

    fn guest_rpc(&self, expected_run_id: &str) -> Option<Arc<dyn sandbox::GuestRpcAcceptor>> {
        self.guest_rpc_endpoint
            .as_ref()
            .map(|endpoint| endpoint.acceptor(expected_run_id))
    }

    fn source_ip(&self) -> &str {
        self.network.peer_ip()
    }

    fn host_process_pid(&self) -> Option<u32> {
        self.process_group_pid
    }

    fn bind_run_control(&mut self, run_id: &str) -> sandbox::Result<()> {
        if run_id.is_empty() {
            return Err(SandboxError::Configuration {
                message: "run control identity must not be empty".into(),
            });
        }

        let sandbox_state = self.current_state();
        let valid_boundary = (sandbox_state == SandboxState::Created && !self.is_parked)
            || (sandbox_state == SandboxState::Running && self.is_parked);
        if !valid_boundary {
            return Err(SandboxError::InvalidState {
                context: SandboxInvalidStateContext::Sandbox,
                state: sandbox_state.to_string(),
                message: "run control identity must be bound before start or while parked".into(),
            });
        }

        self.park_coordinator
            .bind_run_control(run_id)
            .map_err(|error| match error {
                RunControlBindError::AlreadyBound => SandboxError::InvalidState {
                    context: SandboxInvalidStateContext::Sandbox,
                    state: format!("{:?}", self.park_coordinator.state()),
                    message: "run control identity is already bound".into(),
                },
                RunControlBindError::InvalidState { state } => SandboxError::InvalidState {
                    context: SandboxInvalidStateContext::Sandbox,
                    state: format!("{state:?}"),
                    message: "run control identity cannot be bound at this lifecycle state".into(),
                },
            })
    }

    // -- lifecycle --

    async fn start(&mut self) -> sandbox::Result<()> {
        self.start_with_optional_observer(None).await
    }

    async fn start_with_observer(
        &mut self,
        observer: &mut dyn SandboxStartObserver,
    ) -> sandbox::Result<()> {
        self.start_with_optional_observer(Some(observer)).await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        drop(self.guest_rpc_endpoint.take());
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            if self.current_state() == SandboxState::Crashed {
                self.runtime.shutdown_services().await;
                self.guest.lock().await.take();
                release_park_state_for_termination(
                    &mut self.is_parked,
                    &mut self.park_outcome,
                    &mut self.park_fence,
                );
                self.runtime.kill_process().await;
            }
            return Ok(());
        }

        self.runtime.shutdown_services().await;
        // The control server is awaited so its socket path becomes
        // undiscoverable before teardown continues. The balloon controller is
        // only aborted: stop() is about to kill the FC process entirely, so
        // any in-flight controller PATCH against the dying API socket is
        // harmless.

        // Skip vsock graceful shutdown for parked sandboxes — vCPUs are
        // paused and cannot process the message. No in-flight user work
        // to clean up. Go straight to force-kill.
        //
        // Edge case: after a partial unpark failure (resume succeeded but
        // deflate failed), is_parked is true but vCPUs are actually running.
        // Skipping graceful shutdown is still correct — the sandbox was idle
        // with no user workload.
        let was_parked = self.is_parked;
        let guest = self.guest.lock().await.take();
        if !was_parked && let Some(guest) = guest {
            let started_at = tokio::time::Instant::now();
            if let Err(error) = guest.shutdown(SHUTDOWN_TIMEOUT).await {
                let failure_kind = match error.kind() {
                    io::ErrorKind::TimedOut => "timeout",
                    io::ErrorKind::InvalidData => "unexpected_response",
                    _ => "request_failure",
                };
                warn!(
                    sandbox_id = %self.id,
                    timeout_ms = duration_ms(SHUTDOWN_TIMEOUT),
                    elapsed_ms = duration_ms(started_at.elapsed()),
                    failure_kind,
                    error = %error,
                    "graceful shutdown failed"
                );
            }
        }
        release_park_state_for_termination(
            &mut self.is_parked,
            &mut self.park_outcome,
            &mut self.park_fence,
        );

        self.runtime.kill_process().await;
        self.publish_state(SandboxState::Stopped);
        info!(id = %self.id, "sandbox stopped");
        Ok(())
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        drop(self.guest_rpc_endpoint.take());
        if !self.transition(SandboxState::Running, SandboxState::Stopping) {
            if self.current_state() == SandboxState::Crashed {
                self.runtime.shutdown_services().await;
                self.guest.lock().await.take();
                release_park_state_for_termination(
                    &mut self.is_parked,
                    &mut self.park_outcome,
                    &mut self.park_fence,
                );
                self.runtime.kill_process().await;
            }
            return Ok(());
        }
        self.runtime.shutdown_services().await;
        self.guest.lock().await.take();
        release_park_state_for_termination(
            &mut self.is_parked,
            &mut self.park_outcome,
            &mut self.park_fence,
        );
        self.runtime.kill_process().await;
        self.publish_state(SandboxState::Stopped);
        info!(id = %self.id, "sandbox killed");
        Ok(())
    }

    // -- idle transitions --
    //
    // `park()` is called by the runner when a sandbox is handed off to the
    // idle pool. It stops the reactive balloon controller and, for large VMs,
    // requests balloon inflation to reclaim guest memory. It makes a bounded
    // settle attempt before pausing vCPUs to eliminate idle CPU overhead
    // (timer ticks, kernel scheduling). Settling may finish at the target,
    // within tolerance, under guest memory pressure, at the deadline (with at
    // most one bounded progress grace period), or after a non-fatal stats
    // error. These outcomes still reach the paused boundary; severe memory
    // retention is reported as parked but non-reusable. An exact-successor
    // handoff may skip balloon setup or interrupt the settle wait, shortening
    // idle-only compaction before the pause. Ordering: attempt inflation and
    // settling before pause — the guest balloon driver needs running vCPUs to
    // process the inflate.
    //
    // Blank preparation uses the same park fences and vCPU pause, but skips
    // aggressive idle inflation while its caller retains the full budget.
    //
    // `unpark()` is called when the runner pulls the sandbox back out of
    // the idle pool. It resumes vCPUs, deflates the balloon, and respawns
    // the reactive controller so active workload is served with full
    // memory again. Ordering: resume before deflate — the guest needs
    // running vCPUs to process the deflate.
    // `unpark_for_terminal_operations()` shares that readiness sequence but
    // omits the reactive controller because the lifecycle owner must destroy
    // the sandbox after its bounded preservation work.
    //
    // Park first closes the sandbox policy gate, then acquires a host-side
    // vsock normal-operation fence before guest lifecycle quiesce. Unpark
    // resumes the guest, releases the vsock fence, then reopens the policy
    // gate. Both methods propagate guest lifecycle, operation-gate, fence, and
    // Firecracker PATCH failures as `IdleTransition(Park|Unpark)` errors. On
    // failure the caller (runner) destroys the sandbox and falls through to
    // fresh-create. Firecracker accepts repeated target-state requests, so
    // partial retries do not require suppressing API errors.
    //
    // For profiles where `memory_mb <= MIN_GUEST_MIB` there is no memory
    // to reclaim (balloon is skipped), but vCPUs are still paused — timer
    // ticks waste CPU regardless of memory size.
    //
    // The `is_parked` flag handles healthy idempotent calls and lets unpark
    // skip the abort+respawn dance when park was a no-op. The operation
    // coordinator is still checked on no-op paths so Dirty/desynchronised gates
    // cannot be silently reused.

    async fn park(&mut self) -> sandbox::Result<SandboxParkOutcome> {
        self.park_with_memory_policy(ParkMemoryPolicy::Reclaim)
            .await
    }

    async fn park_for_blank_pool(&mut self) -> sandbox::Result<SandboxParkOutcome> {
        self.park_with_memory_policy(ParkMemoryPolicy::Preserve)
            .await
    }

    async fn final_exec_and_park(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
    ) -> sandbox::Result<SandboxFinalExecParkOutcome> {
        match self
            .final_exec_and_park_with_optional_observer(request, diagnostic_label, None, None)
            .await?
        {
            SandboxFinalExecParkHandoffOutcome::Parked(outcome) => Ok(outcome),
            SandboxFinalExecParkHandoffOutcome::Handoff { .. } => Err(idle_transition_error(
                SandboxIdleTransition::Park,
                "provider accepted a handoff without a handoff signal",
            )),
        }
    }

    async fn final_exec_and_park_with_observer(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> sandbox::Result<SandboxFinalExecParkOutcome> {
        match self
            .final_exec_and_park_with_optional_observer(
                request,
                diagnostic_label,
                None,
                Some(observer),
            )
            .await?
        {
            SandboxFinalExecParkHandoffOutcome::Parked(outcome) => Ok(outcome),
            SandboxFinalExecParkHandoffOutcome::Handoff { .. } => Err(idle_transition_error(
                SandboxIdleTransition::Park,
                "provider accepted a handoff without a handoff signal",
            )),
        }
    }

    async fn final_exec_and_park_for_handoff(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        handoff: &SandboxFinalExecParkHandoff,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> sandbox::Result<SandboxFinalExecParkHandoffOutcome> {
        self.final_exec_and_park_with_optional_observer(
            request,
            diagnostic_label,
            Some(handoff),
            Some(observer),
        )
        .await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.unpark_with_purpose(UnparkPurpose::Reuse).await
    }

    async fn unpark_for_terminal_operations(&mut self) -> sandbox::Result<()> {
        self.unpark_with_purpose(UnparkPurpose::TerminalOperations)
            .await
    }

    // -- operations --
    //
    // Each operation races the vsock call against the durable lifecycle stream.
    // Late subscribers observe `Crashed` immediately, so crash classification
    // does not depend on catching a one-shot notification while select! is
    // already polling.

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.exec_with_diagnostic_label(request, "sandbox-exec")
            .await
    }

    async fn exec_with_diagnostic_label(
        &self,
        request: &ExecRequest<'_>,
        label: &'static str,
    ) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::Exec;
        let timeout_ms = request.timeout_ms();

        self.run_bounded_guest_operation_with_validation(
            operation,
            || Self::validate_exec_env_keys(operation, request.env),
            |guest| async move {
                validate_exec_capture_timeout(timeout_ms)?;
                guest
                    .exec_operation_capture(exec_capture_request(request, timeout_ms, label))
                    .await
                    .and_then(exec_result_from_operation_result)
            },
        )
        .await
    }

    async fn apply_storage_manifest(
        &self,
        request: &StorageManifestRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::Exec;
        let timeout_ms = request.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            validate_exec_capture_timeout(timeout_ms)?;
            guest
                .guest_storage_manifest(
                    request.manifest_json,
                    request.run_id,
                    request.runtime_dir,
                    timeout_ms,
                    Duration::from_millis(u64::from(timeout_ms) + 5_000),
                )
                .await
                .map(|result| {
                    result.log_resources(&self.id);
                    storage_manifest_exec_result(result)
                })
        })
        .await
    }

    async fn mount_workspace_drive(&self) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::MountWorkspaceDrive;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest
                .mount_workspace_drive(WORKSPACE_DRIVE_MOUNT_REQUEST_DEADLINE)
                .await
                .map(workspace_drive_mount_exec_result)
        })
        .await
    }

    async fn verify_session_history_identity(
        &self,
        request: &SessionHistoryIdentityVerifyRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::VerifySessionHistoryIdentity;
        let timeout_ms = request.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            validate_exec_capture_timeout(timeout_ms)?;
            guest
                .verify_session_history_identity(
                    guest_control_client::SessionHistoryIdentityVerifyRequest {
                        metadata_path: request.metadata_path,
                        runtime_dir: request.runtime_dir,
                        framework: request.framework,
                        session_id_hash: request.session_id_hash,
                        history_ref_kind: request.history_ref_kind,
                        history_hash: request.history_hash,
                        history_size_bytes: request.history_size_bytes,
                        timeout_ms,
                        wait_timeout: Duration::from_millis(u64::from(timeout_ms) + 5_000),
                    },
                )
                .await
                .and_then(exec_result_from_operation_result)
        })
        .await
    }

    async fn cleanup_codex_session(
        &self,
        request: &CodexSessionCleanupRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::CleanupCodexSession;
        let timeout_ms = request.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            validate_exec_capture_timeout(timeout_ms)?;
            guest
                .cleanup_codex_session(guest_control_client::CodexSessionCleanupRequest {
                    session_id: request.session_id,
                    fallback_relative_path: request.fallback_relative_path,
                    timeout_ms,
                    wait_timeout: Duration::from_millis(u64::from(timeout_ms) + 5_000),
                })
                .await
                .and_then(exec_result_from_operation_result)
        })
        .await
    }

    async fn restore_guest_state(
        &self,
        request: &GuestStateRestoreRequest<'_>,
    ) -> sandbox::Result<ExecResult> {
        let operation = SandboxOperation::Exec;
        let timeout_ms = request.timeout_ms();
        let timezone = match request.timezone {
            GuestStateRestoreTimezone::None => ProtoGuestStateRestoreTimezone::None,
            GuestStateRestoreTimezone::BestEffort(timezone) => {
                ProtoGuestStateRestoreTimezone::BestEffort(timezone)
            }
            GuestStateRestoreTimezone::Required(timezone) => {
                ProtoGuestStateRestoreTimezone::Required(timezone)
            }
        };

        self.run_bounded_guest_operation(operation, |guest| async move {
            validate_exec_capture_timeout(timeout_ms)?;
            guest
                .guest_state_restore(
                    request.unix_seconds,
                    request.unix_nanoseconds,
                    request.entropy,
                    timezone,
                    timeout_ms,
                    Duration::from_millis(u64::from(timeout_ms) + 5_000),
                )
                .await
                .map(guest_state_restore_exec_result)
        })
        .await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        let operation = SandboxOperation::ReadFile;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.read_file(path, max_bytes, 5000).await
        })
        .await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<CopyFileResult> {
        let operation = SandboxOperation::CopyFile;
        let timeout_ms = options.timeout_ms();

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest
                .copy_file(
                    path,
                    host_path,
                    guest_control_client::CopyFileOptions {
                        max_bytes: options.max_bytes,
                        timeout_ms,
                        missing_ok: options.missing_ok,
                    },
                )
                .await
                .map(|result| CopyFileResult {
                    bytes_copied: result.bytes_copied,
                })
        })
        .await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.write_file(path, content, false).await
        })
        .await
    }

    async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;
        let files = files
            .iter()
            .map(|file| guest_control_client::WriteFileEntry {
                path: file.path,
                content: file.content,
            })
            .collect::<Vec<_>>();

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.write_files(&files).await
        })
        .await
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.write_private_file(path, content).await
        })
        .await
    }

    async fn write_private_files(&self, files: &[WriteFileEntry<'_>]) -> sandbox::Result<()> {
        let operation = SandboxOperation::WriteFile;
        let files = files
            .iter()
            .map(|file| guest_control_client::WriteFileEntry {
                path: file.path,
                content: file.content,
            })
            .collect::<Vec<_>>();

        self.run_bounded_guest_operation(operation, |guest| async move {
            guest.write_private_files(&files).await
        })
        .await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<GuestProcessHandle> {
        let (process, _) = self
            .start_process_with_contract(
                ProcessStartContractRequest {
                    command: request.cmd,
                    timeout_ms: request.timeout_ms(),
                    start_timeout: request.start_timeout,
                    timeout_is_expected: request.timeout_is_expected,
                    env: request.env,
                    sudo: request.sudo,
                    output: request.output,
                    label: request.cmd,
                },
                SandboxOperation::StartProcess,
                ExecProcessRole::Workload,
                SupervisedExecControl::Disabled,
            )
            .await?;
        Ok(process)
    }

    async fn start_agent_process(
        &self,
        request: &StartAgentProcessRequest<'_>,
    ) -> sandbox::Result<GuestAgentProcessHandle> {
        let (process, timing) = self
            .start_process_with_contract(
                ProcessStartContractRequest {
                    command: "",
                    timeout_ms: request.timeout_ms(),
                    start_timeout: DEFAULT_PROCESS_START_TIMEOUT,
                    timeout_is_expected: false,
                    env: request.env,
                    sudo: false,
                    output: request.output,
                    label: "guest-agent",
                },
                SandboxOperation::StartAgentProcess,
                ExecProcessRole::Agent,
                SupervisedExecControl::Enabled { sink: true },
            )
            .await?;
        let ready_at = timing.agent_ready_at.ok_or_else(|| {
            Self::operation_error(
                SandboxOperation::StartAgentProcess,
                io::Error::other("guest Agent start completed without readiness timestamp"),
                self.has_backend_crashed(),
            )
        })?;
        let ready = timing.agent_ready.ok_or_else(|| {
            Self::operation_error(
                SandboxOperation::StartAgentProcess,
                io::Error::other("guest Agent start completed without readiness timing"),
                self.has_backend_crashed(),
            )
        })?;
        let handle = GuestAgentProcessHandle::try_from_process(
            process,
            GuestAgentStartTiming {
                shell_started_at: timing.shell_started_at,
                ready_at,
                containment_create: Duration::from_micros(u64::from(ready.containment_create_us)),
                placement_broker_setup: Duration::from_micros(u64::from(
                    ready.placement_broker_setup_us,
                )),
                shell_spawn: Duration::from_micros(u64::from(ready.shell_spawn_us)),
                bootstrap_ready_wait: Duration::from_micros(u64::from(
                    ready.bootstrap_ready_wait_us,
                )),
            },
        )?;
        if let Some(controller) = &self.runtime.balloon {
            controller.notify_agent_ready();
        }
        Ok(handle)
    }

    async fn wait_process(
        &self,
        mut handle: GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let operation = SandboxOperation::WaitProcess;
        let waiter = handle.take_waiter().ok_or_else(|| {
            Self::operation_error(
                operation,
                std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "start_process handle already consumed",
                ),
                self.has_backend_crashed(),
            )
        })?;
        // `wait_process` consumes the handle; an unclaimed stream receiver can no
        // longer be observed by the caller and would otherwise buffer forever.
        handle.drop_unclaimed_stdout();
        let mut wait = waiter.wait(timeout);

        tokio::select! {
            biased;
            result = &mut wait => {
                result.map_err(|e| Self::operation_error(operation, e, self.has_backend_crashed()))
            }
            () = wait_for_backend_crash(self.state_tx.subscribe()) => {
                Err(Self::backend_crashed_error(operation))
            }
        }
    }
}

fn storage_manifest_exec_result(result: GuestStorageManifestResult) -> ExecResult {
    ExecResult {
        termination: exec_termination_from_vsock_termination(result.termination),
        guest_duration_ms: Some(result.duration_ms),
        stdout: result.stdout,
        stderr: result.stderr,
        diagnostic: result.diagnostic,
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
    }
}

fn workspace_drive_mount_exec_result(result: WorkspaceDriveMountResult) -> ExecResult {
    ExecResult {
        termination: exec_termination_from_vsock_termination(result.termination),
        guest_duration_ms: Some(result.duration_ms),
        stdout: result.stdout,
        stderr: result.stderr,
        diagnostic: result.diagnostic,
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
    }
}

fn guest_state_restore_exec_result(result: GuestStateRestoreResult) -> ExecResult {
    ExecResult {
        termination: exec_termination_from_vsock_termination(result.termination),
        guest_duration_ms: Some(result.duration_ms),
        stdout: Vec::new(),
        stderr: result.stderr,
        diagnostic: result.diagnostic,
        stdout_truncated: false,
        stderr_truncated: result.stderr_truncated,
    }
}

enum ParkBoundaryGuardState {
    Closing,
    NormalOperationsFenced,
    GuestQuiesceStarted,
    ReadyForPark,
    Disarmed,
}

enum ParkNormalOperationFenceError {
    GuestUnavailable(io::Error),
    Rejected(NormalOperationFenceRejection),
    FinalOperation(io::Error),
}

struct ParkBoundaryGuard<Fence> {
    coordinator: ParkCoordinator,
    attempt: ParkAttempt,
    state: ParkBoundaryGuardState,
    normal_operations_fence: Option<Fence>,
}

impl<Fence> ParkBoundaryGuard<Fence> {
    fn new(coordinator: ParkCoordinator, attempt: ParkAttempt) -> Self {
        Self {
            coordinator,
            attempt,
            state: ParkBoundaryGuardState::Closing,
            normal_operations_fence: None,
        }
    }

    fn mark_normal_operations_fenced(&mut self, fence: Fence) {
        self.normal_operations_fence = Some(fence);
        self.state = ParkBoundaryGuardState::NormalOperationsFenced;
    }

    fn mark_guest_quiesce_started(&mut self) {
        self.state = ParkBoundaryGuardState::GuestQuiesceStarted;
    }

    fn complete_prepare(&mut self) -> Result<(), PrepareParkError> {
        self.coordinator
            .complete_prepare_park(&self.attempt, PrepareParkEvidence::AgentQuiesced)?;
        self.state = ParkBoundaryGuardState::ReadyForPark;
        Ok(())
    }

    fn mark_dirty(mut self, reason: impl Into<String>) {
        self.coordinator.mark_dirty(DirtyReason::new(reason));
        self.state = ParkBoundaryGuardState::Disarmed;
    }

    fn mark_parked(mut self) -> Result<Fence, PrepareParkError> {
        match self.coordinator.mark_parked(&self.attempt) {
            Ok(()) => {
                self.state = ParkBoundaryGuardState::Disarmed;
                match self.normal_operations_fence.take() {
                    Some(fence) => Ok(fence),
                    None => {
                        let reason =
                            DirtyReason::new("park completed without a normal-operation fence");
                        self.coordinator.mark_dirty(reason.clone());
                        Err(PrepareParkError::Dirty { reason })
                    }
                }
            }
            Err(error) => {
                let message = format!(
                    "park policy failed to mark parked after Firecracker park: {}",
                    prepare_park_error_message(&error)
                );
                self.coordinator
                    .mark_dirty(DirtyReason::new(message.clone()));
                self.state = ParkBoundaryGuardState::Disarmed;
                Err(error)
            }
        }
    }
}

impl<Fence> Drop for ParkBoundaryGuard<Fence> {
    fn drop(&mut self) {
        match self.state {
            ParkBoundaryGuardState::Closing => {
                let _ = self.coordinator.abort_prepare_park(&self.attempt);
            }
            ParkBoundaryGuardState::NormalOperationsFenced => {
                drop(self.normal_operations_fence.take());
                let _ = self.coordinator.abort_prepare_park(&self.attempt);
            }
            ParkBoundaryGuardState::GuestQuiesceStarted => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "park attempt dropped after guest quiesce started",
                ));
            }
            ParkBoundaryGuardState::ReadyForPark => {
                self.coordinator
                    .mark_dirty(DirtyReason::new("park attempt dropped after ReadyForPark"));
            }
            ParkBoundaryGuardState::Disarmed => {}
        }
    }
}

enum UnparkBoundaryGuardState {
    FirecrackerResumeStarted,
    FirecrackerResumed,
    Disarmed,
}

struct UnparkBoundaryGuard {
    coordinator: ParkCoordinator,
    state: UnparkBoundaryGuardState,
}

impl UnparkBoundaryGuard {
    fn new(coordinator: ParkCoordinator) -> Self {
        Self {
            coordinator,
            state: UnparkBoundaryGuardState::FirecrackerResumeStarted,
        }
    }

    fn mark_firecracker_resumed(&mut self) {
        self.state = UnparkBoundaryGuardState::FirecrackerResumed;
    }

    fn mark_dirty(mut self, reason: impl Into<String>) {
        self.coordinator.mark_dirty(DirtyReason::new(reason));
        self.state = UnparkBoundaryGuardState::Disarmed;
    }

    fn disarm(&mut self) {
        self.state = UnparkBoundaryGuardState::Disarmed;
    }
}

impl Drop for UnparkBoundaryGuard {
    fn drop(&mut self) {
        match self.state {
            UnparkBoundaryGuardState::FirecrackerResumeStarted => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "unpark attempt dropped during Firecracker resume before guest operations reopened",
                ));
            }
            UnparkBoundaryGuardState::FirecrackerResumed => {
                self.coordinator.mark_dirty(DirtyReason::new(
                    "unpark attempt dropped after Firecracker resume before guest operations reopened",
                ));
            }
            UnparkBoundaryGuardState::Disarmed => {}
        }
    }
}

fn release_park_state_for_termination<Fence>(
    is_parked: &mut bool,
    park_outcome: &mut Option<SandboxParkOutcome>,
    park_fence: &mut Option<Fence>,
) {
    *is_parked = false;
    *park_outcome = None;
    drop(park_fence.take());
}

async fn park_with_ready_for_park<Fence, Outcome, F, FF, Q, QF, P, PF>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    fence_normal_operations: F,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<(Fence, Outcome)>
where
    F: FnOnce() -> FF,
    FF: Future<Output = Result<Fence, ParkNormalOperationFenceError>>,
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce() -> PF,
    PF: Future<Output = sandbox::Result<Outcome>>,
{
    let (fence, outcome, ()) = park_with_ready_for_park_and_preparation(
        log_id,
        coordinator,
        || async move { fence_normal_operations().await.map(|fence| (fence, ())) },
        quiesce_guest,
        park_firecracker,
    )
    .await?;
    Ok((fence, outcome))
}

async fn park_with_ready_for_park_and_preparation<
    Fence,
    Outcome,
    Preparation,
    F,
    FF,
    Q,
    QF,
    P,
    PF,
>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    fence_and_prepare: F,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<(Fence, Outcome, Preparation)>
where
    F: FnOnce() -> FF,
    FF: Future<Output = Result<(Fence, Preparation), ParkNormalOperationFenceError>>,
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce() -> PF,
    PF: Future<Output = sandbox::Result<Outcome>>,
{
    park_with_ready_for_park_and_preparation_with_observer(
        log_id,
        coordinator,
        None,
        fence_and_prepare,
        quiesce_guest,
        |timing, events| async move {
            let result = park_firecracker().await;
            (timing, events, result)
        },
    )
    .await
}

async fn park_with_ready_for_park_and_preparation_with_observer<
    'observer,
    Fence,
    Outcome,
    Preparation,
    F,
    FF,
    Q,
    QF,
    P,
    PF,
>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    observer: Option<&'observer mut dyn SandboxFinalExecParkObserver>,
    fence_and_prepare: F,
    quiesce_guest: Q,
    park_firecracker: P,
) -> sandbox::Result<(Fence, Outcome, Preparation)>
where
    F: FnOnce() -> FF,
    FF: Future<Output = Result<(Fence, Preparation), ParkNormalOperationFenceError>>,
    Q: FnOnce() -> QF,
    QF: Future<Output = io::Result<()>>,
    P: FnOnce(
        SandboxFinalExecParkTiming<'observer>,
        SandboxFinalExecParkSubstageEvents<'observer>,
    ) -> PF,
    PF: Future<
        Output = (
            SandboxFinalExecParkTiming<'observer>,
            SandboxFinalExecParkSubstageEvents<'observer>,
            sandbox::Result<Outcome>,
        ),
    >,
{
    let mut timing = SandboxFinalExecParkTiming::new(observer);
    let preparation_started = Instant::now();
    info!(
        id = %log_id,
        transition = "park",
        phase = "prepare",
        "sandbox park lifecycle prepare started"
    );
    let attempt = match coordinator.begin_prepare_park() {
        Ok(attempt) => attempt,
        Err(error) => {
            let reason_kind = prepare_park_error_reason_kind(&error);
            let error_message = prepare_park_error_message(&error);
            if matches!(
                error,
                PrepareParkError::InvalidState { .. } | PrepareParkError::StaleAttempt { .. }
            ) {
                coordinator.mark_dirty(DirtyReason::new(format!(
                    "park policy failed to start park prepare: {}",
                    error_message
                )));
            }
            warn!(
                id = %log_id,
                transition = "park",
                phase = "prepare",
                reason_kind = reason_kind,
                error = %error_message,
                "sandbox park lifecycle prepare rejected"
            );
            timing.record(
                SandboxFinalExecParkStage::ReusePreparation,
                preparation_started,
                false,
            );
            return Err(prepare_park_error(SandboxIdleTransition::Park, error));
        }
    };
    let mut guard = ParkBoundaryGuard::new(coordinator.clone(), attempt);

    info!(
        id = %log_id,
        transition = "park",
        phase = "normal_operations_fence",
        "sandbox park lifecycle normal-operation fence started"
    );
    let preparation = match fence_and_prepare().await {
        Ok((fence, preparation)) => {
            guard.mark_normal_operations_fenced(fence);
            preparation
        }
        Err(ParkNormalOperationFenceError::Rejected(NormalOperationFenceRejection::Busy)) => {
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = "busy",
                "sandbox park lifecycle normal-operation fence rejected"
            );
            timing.record(
                SandboxFinalExecParkStage::ReusePreparation,
                preparation_started,
                false,
            );
            return Err(idle_transition_error(
                SandboxIdleTransition::Park,
                "normal operations busy while preparing park",
            ));
        }
        Err(ParkNormalOperationFenceError::Rejected(error)) => {
            let message = format!(
                "normal operation fence failed while preparing park: {}",
                normal_operation_fence_rejection_message(error)
            );
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = normal_operation_fence_rejection_reason_kind(error),
                error = %message,
                "sandbox park lifecycle normal-operation fence failed"
            );
            guard.mark_dirty(message.clone());
            timing.record(
                SandboxFinalExecParkStage::ReusePreparation,
                preparation_started,
                false,
            );
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
        Err(ParkNormalOperationFenceError::GuestUnavailable(error)) => {
            let message = format!("guest connection unavailable while fencing park: {error}");
            warn!(
                id = %log_id,
                transition = "park",
                phase = "normal_operations_fence",
                reason_kind = "protocol_or_transport",
                error = %error,
                "sandbox park lifecycle normal-operation fence failed"
            );
            guard.mark_dirty(message.clone());
            timing.record(
                SandboxFinalExecParkStage::ReusePreparation,
                preparation_started,
                false,
            );
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
        Err(ParkNormalOperationFenceError::FinalOperation(error)) => {
            let message = format!("final guest operation failed while preparing park: {error}");
            warn!(
                id = %log_id,
                transition = "park",
                phase = "final_guest_operation",
                reason_kind = "protocol_or_transport",
                error = %error,
                "sandbox park lifecycle final guest operation failed"
            );
            guard.mark_dirty(message.clone());
            timing.record(
                SandboxFinalExecParkStage::ReusePreparation,
                preparation_started,
                false,
            );
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
    };

    info!(
        id = %log_id,
        transition = "park",
        phase = "guest_quiesce",
        "sandbox park lifecycle guest quiesce started"
    );
    guard.mark_guest_quiesce_started();
    if let Err(error) = quiesce_guest().await {
        let message = format!("guest quiesce failed during park: {error}");
        warn!(
            id = %log_id,
            transition = "park",
            phase = "guest_quiesce",
            reason_kind = "protocol_or_transport",
            error = %error,
            "sandbox park lifecycle guest quiesce failed"
        );
        guard.mark_dirty(message.clone());
        timing.record(
            SandboxFinalExecParkStage::ReusePreparation,
            preparation_started,
            false,
        );
        return Err(idle_transition_error(SandboxIdleTransition::Park, message));
    }

    if let Err(error) = guard.complete_prepare() {
        let reason_kind = prepare_park_error_reason_kind(&error);
        let error_message = prepare_park_error_message(&error);
        let message = format!(
            "park policy failed to enter ReadyForPark: {}",
            error_message
        );
        warn!(
            id = %log_id,
            transition = "park",
            phase = "ready_for_park",
            reason_kind = reason_kind,
            error = %error_message,
            "sandbox park lifecycle failed to enter ReadyForPark"
        );
        guard.mark_dirty(message.clone());
        timing.record(
            SandboxFinalExecParkStage::ReusePreparation,
            preparation_started,
            false,
        );
        return Err(idle_transition_error(SandboxIdleTransition::Park, message));
    }

    timing.record(
        SandboxFinalExecParkStage::ReusePreparation,
        preparation_started,
        true,
    );
    info!(
        id = %log_id,
        transition = "park",
        phase = "ready_for_park",
        "sandbox park lifecycle ReadyForPark reached"
    );
    let physical_park_started = Instant::now();
    let observer = timing.observer.take();
    let events = SandboxFinalExecParkSubstageEvents::new(observer);
    let (mut timing, events, park_result) = park_firecracker(timing, events).await;
    timing.observer = events.into_observer();
    let outcome = match park_result {
        Ok(outcome) => {
            timing.record(
                SandboxFinalExecParkStage::PhysicalPark,
                physical_park_started,
                true,
            );
            outcome
        }
        Err(error) => {
            warn!(
                id = %log_id,
                transition = "park",
                phase = "firecracker_park",
                reason_kind = "firecracker",
                error = %error,
                "sandbox park lifecycle Firecracker park failed after ReadyForPark"
            );
            guard.mark_dirty(format!(
                "Firecracker park failed after ReadyForPark: {error}"
            ));
            timing.record(
                SandboxFinalExecParkStage::PhysicalPark,
                physical_park_started,
                false,
            );
            return Err(error);
        }
    };

    let normal_operations_fence = match guard.mark_parked() {
        Ok(fence) => fence,
        Err(error) => {
            let reason_kind = prepare_park_error_reason_kind(&error);
            let error_message = prepare_park_error_message(&error);
            let message = format!(
                "park policy failed to mark parked after Firecracker park: {}",
                error_message
            );
            warn!(
                id = %log_id,
                transition = "park",
                phase = "parked",
                reason_kind = reason_kind,
                error = %error_message,
                "sandbox park lifecycle failed to mark parked"
            );
            return Err(idle_transition_error(SandboxIdleTransition::Park, message));
        }
    };

    info!(
        id = %log_id,
        transition = "park",
        phase = "parked",
        "sandbox park lifecycle marked parked"
    );
    Ok((normal_operations_fence, outcome, preparation))
}

async fn unpark_with_ready_for_operations<U, UF, R, RF, F>(
    log_id: &str,
    coordinator: &ParkCoordinator,
    unpark_firecracker: U,
    resume_guest: R,
    release_normal_operations_fence: F,
) -> sandbox::Result<()>
where
    U: FnOnce() -> UF,
    UF: Future<Output = sandbox::Result<()>>,
    R: FnOnce() -> RF,
    RF: Future<Output = io::Result<()>>,
    F: FnOnce(),
{
    info!(
        id = %log_id,
        transition = "unpark",
        phase = "start",
        "sandbox unpark lifecycle started"
    );
    let pre_unpark_state = coordinator.state();
    if let Err(error) = ensure_parked_before_unpark(coordinator) {
        let reason_kind = match pre_unpark_state {
            CoordinatorState::Dirty { .. } => "dirty",
            _ => "invalid_state",
        };
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "start",
            reason_kind = reason_kind,
            error = %error,
            "sandbox unpark lifecycle rejected before Firecracker resume"
        );
        return Err(error);
    }

    let mut guard = UnparkBoundaryGuard::new(coordinator.clone());
    if let Err(error) = unpark_firecracker().await {
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "firecracker_unpark",
            reason_kind = "firecracker",
            error = %error,
            "sandbox unpark lifecycle Firecracker unpark failed"
        );
        guard.disarm();
        return Err(error);
    }
    guard.mark_firecracker_resumed();

    info!(
        id = %log_id,
        transition = "unpark",
        phase = "firecracker_resumed",
        "sandbox unpark lifecycle Firecracker resumed"
    );
    if let Err(error) = resume_guest().await {
        let message = format!("guest resume failed during unpark: {error}");
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "guest_resume",
            reason_kind = "protocol_or_transport",
            error = %error,
            "sandbox unpark lifecycle guest resume failed"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            message,
        ));
    }

    release_normal_operations_fence();

    if let Err(error) = coordinator.reopen_after_unpark() {
        let reason_kind = prepare_park_error_reason_kind(&error);
        let error_message = prepare_park_error_message(&error);
        let message = format!(
            "park policy failed to reopen after unpark: {}",
            error_message
        );
        warn!(
            id = %log_id,
            transition = "unpark",
            phase = "ready_for_operations",
            reason_kind = reason_kind,
            error = %error_message,
            "sandbox unpark lifecycle failed to enter ReadyForOperations"
        );
        guard.mark_dirty(message.clone());
        return Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            message,
        ));
    }

    guard.disarm();
    info!(
        id = %log_id,
        transition = "unpark",
        phase = "ready_for_operations",
        "sandbox unpark lifecycle ReadyForOperations reached"
    );
    Ok(())
}

fn ensure_parked_before_unpark(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Parked => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            format!("park policy dirty while unpark is starting: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while unpark is starting");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ))
        }
    }
}

fn ensure_park_noop_state(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Parked => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Park,
            format!("park policy dirty while park is a no-op: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while park is a no-op");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(SandboxIdleTransition::Park, message))
        }
    }
}

fn ensure_unpark_noop_state(coordinator: &ParkCoordinator) -> sandbox::Result<()> {
    match coordinator.state() {
        CoordinatorState::Open => Ok(()),
        CoordinatorState::Dirty { reason } => Err(idle_transition_error(
            SandboxIdleTransition::Unpark,
            format!("park policy dirty while unpark is a no-op: {reason}"),
        )),
        state => {
            let message = format!("park policy is {state:?} while unpark is a no-op");
            coordinator.mark_dirty(DirtyReason::new(message.clone()));
            Err(idle_transition_error(
                SandboxIdleTransition::Unpark,
                message,
            ))
        }
    }
}

fn prepare_park_error(transition: SandboxIdleTransition, error: PrepareParkError) -> SandboxError {
    idle_transition_error(transition, prepare_park_error_message(&error))
}

fn prepare_park_error_message(error: &PrepareParkError) -> String {
    match error {
        PrepareParkError::Dirty { reason } => format!("park policy dirty: {reason}"),
        PrepareParkError::InvalidState { state } => {
            format!("park policy state {state:?} cannot continue park lifecycle")
        }
        PrepareParkError::StaleAttempt { attempt_id, state } => {
            format!("stale park attempt {attempt_id:?} while park policy is {state:?}")
        }
    }
}

fn prepare_park_error_reason_kind(error: &PrepareParkError) -> &'static str {
    match error {
        PrepareParkError::Dirty { .. } => "dirty",
        PrepareParkError::InvalidState { .. } => "invalid_state",
        PrepareParkError::StaleAttempt { .. } => "stale_attempt",
    }
}

fn normal_operation_fence_rejection_message(error: NormalOperationFenceRejection) -> &'static str {
    match error {
        NormalOperationFenceRejection::Busy => "normal operations busy",
        NormalOperationFenceRejection::AlreadyFenced => "normal operations already fenced",
        NormalOperationFenceRejection::NotParkable => "normal operations not parkable",
        NormalOperationFenceRejection::Closed => "guest connection closed",
    }
}

fn normal_operation_fence_rejection_reason_kind(
    error: NormalOperationFenceRejection,
) -> &'static str {
    match error {
        NormalOperationFenceRejection::Busy => "busy",
        NormalOperationFenceRejection::AlreadyFenced => "already_fenced",
        NormalOperationFenceRejection::NotParkable => "not_parkable",
        NormalOperationFenceRejection::Closed => "closed",
    }
}

fn idle_transition_error(
    transition: SandboxIdleTransition,
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::IdleTransition {
        transition,
        message: message.into(),
    }
}

// -- idle transition helpers --
//
// Extracted from `impl Sandbox for FirecrackerSandbox` as free functions so
// that tests can drive them against a mock Unix-domain API socket without
// building a fully-initialised `FirecrackerSandbox` (which pulls in the
// network pool, NBD COW device, firecracker child process, etc.).

/// Initial time to wait for balloon inflation before considering an extension.
const BALLOON_SETTLE_INITIAL_TIMEOUT: Duration = Duration::from_secs(5);
/// Additional wait when the balloon is still making progress and the
/// guest reports enough unused memory to finish reclaiming safely.
const BALLOON_SETTLE_PROGRESS_GRACE: Duration = Duration::from_secs(5);
/// Absolute upper bound for balloon inflation across all progress extensions.
const BALLOON_SETTLE_MAX_TIMEOUT: Duration = Duration::from_secs(30);
/// Fast-start poll intervals while waiting for balloon inflation.
const BALLOON_SETTLE_FAST_POLL_INTERVALS: [Duration; 7] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(200),
];
/// Maximum poll interval while waiting for balloon inflation.
const BALLOON_SETTLE_MAX_POLL: Duration = Duration::from_millis(200);
/// Upper bound for accepting residual differences between requested and
/// reported balloon size. Current 4 GiB production profiles commonly settle
/// with low-hundreds MiB residuals when the guest reports little available
/// memory.
const BALLOON_SETTLE_TOLERANCE_CAP_MIB: u32 = 256;
/// Keep the settle tolerance proportional for smaller profiles so tiny balloon
/// targets are not fully swallowed by the 4 GiB cap.
const BALLOON_SETTLE_TOLERANCE_TARGET_DIVISOR: u32 = 8;
const BALLOON_SEVERE_DEFICIT_MIN_MIB: u32 = 256;
const BALLOON_PRESSURE_LIMITED_REASON: &str = "pressure_limited_partial_reclaim";
const BYTES_PER_MIB: i64 = 1024 * 1024;

fn balloon_settle_tolerance_mib(target_mib: u32) -> u32 {
    BALLOON_SETTLE_TOLERANCE_CAP_MIB.min(target_mib / BALLOON_SETTLE_TOLERANCE_TARGET_DIVISOR)
}

#[derive(Debug)]
struct BalloonSettleSummary {
    requested_target_mib: u32,
    started_at: tokio::time::Instant,
    sample_count: u32,
    first_observed_target_mib: Option<u32>,
    last_observed_target_mib: Option<u32>,
    target_observed: bool,
    first_actual_mib: Option<u32>,
    previous_actual_mib: Option<u32>,
    last_actual_mib: Option<u32>,
    max_actual_mib: Option<u32>,
    last_deficit_mib: Option<u32>,
    last_free_memory_bytes: Option<i64>,
    last_available_memory_bytes: Option<i64>,
    last_total_memory_bytes: Option<i64>,
    last_swap_in_bytes: Option<i64>,
    last_swap_out_bytes: Option<i64>,
    last_major_faults: Option<i64>,
    last_minor_faults: Option<i64>,
    last_disk_caches_bytes: Option<i64>,
}

impl BalloonSettleSummary {
    fn new(requested_target_mib: u32) -> Self {
        Self {
            requested_target_mib,
            started_at: tokio::time::Instant::now(),
            sample_count: 0,
            first_observed_target_mib: None,
            last_observed_target_mib: None,
            target_observed: false,
            first_actual_mib: None,
            previous_actual_mib: None,
            last_actual_mib: None,
            max_actual_mib: None,
            last_deficit_mib: None,
            last_free_memory_bytes: None,
            last_available_memory_bytes: None,
            last_total_memory_bytes: None,
            last_swap_in_bytes: None,
            last_swap_out_bytes: None,
            last_major_faults: None,
            last_minor_faults: None,
            last_disk_caches_bytes: None,
        }
    }

    fn observe(&mut self, stats: &BalloonStatistics) -> u32 {
        let deficit_mib = self.requested_target_mib.saturating_sub(stats.actual_mib);
        self.sample_count = self.sample_count.saturating_add(1);
        self.first_observed_target_mib
            .get_or_insert(stats.target_mib);
        self.last_observed_target_mib = Some(stats.target_mib);
        self.target_observed |= stats.target_mib == self.requested_target_mib;
        self.first_actual_mib.get_or_insert(stats.actual_mib);
        self.previous_actual_mib = self.last_actual_mib;
        self.last_actual_mib = Some(stats.actual_mib);
        self.max_actual_mib = Some(
            self.max_actual_mib
                .map_or(stats.actual_mib, |max| max.max(stats.actual_mib)),
        );
        self.last_deficit_mib = Some(deficit_mib);
        self.last_free_memory_bytes = stats.free_memory;
        self.last_available_memory_bytes = stats.available_memory;
        self.last_total_memory_bytes = stats.total_memory;
        self.last_swap_in_bytes = stats.swap_in;
        self.last_swap_out_bytes = stats.swap_out;
        self.last_major_faults = stats.major_faults;
        self.last_minor_faults = stats.minor_faults;
        self.last_disk_caches_bytes = stats.disk_caches;
        deficit_mib
    }

    fn elapsed_ms(&self) -> u64 {
        duration_ms(self.started_at.elapsed())
    }

    fn actual_delta_mib(&self) -> Option<i64> {
        match (self.first_actual_mib, self.last_actual_mib) {
            (Some(first), Some(last)) => Some(i64::from(last) - i64::from(first)),
            _ => None,
        }
    }

    fn reported_free_mib(&self) -> Option<i64> {
        self.last_free_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    fn reported_available_mib(&self) -> Option<i64> {
        self.last_available_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    fn reported_total_mib(&self) -> Option<i64> {
        self.last_total_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    fn reason(&self) -> &'static str {
        if self.sample_count == 0 {
            return "stats_unavailable";
        }

        if !self.target_observed {
            return "target_not_observed";
        }

        if self.is_severe_deficit() {
            return "severe_deficit";
        }

        if matches!(
            (self.first_actual_mib, self.last_actual_mib),
            (Some(first), Some(last)) if last > first
        ) {
            return "actual_progressing_timeout";
        }

        "actual_stalled"
    }

    fn is_severe_deficit(&self) -> bool {
        self.target_observed
            && self
                .last_deficit_mib
                .is_some_and(|deficit| deficit >= self.severe_deficit_threshold_mib())
    }

    fn can_extend_for_progress(&self) -> bool {
        let (
            Some(previous_actual_mib),
            Some(last_actual_mib),
            Some(deficit_mib),
            Some(free_mib),
            Some(available_mib),
        ) = (
            self.previous_actual_mib,
            self.last_actual_mib,
            self.last_deficit_mib,
            self.reported_free_mib(),
            self.reported_available_mib(),
        )
        else {
            return false;
        };

        self.is_severe_deficit()
            && self.last_observed_target_mib == Some(self.requested_target_mib)
            && last_actual_mib > previous_actual_mib
            && free_mib >= i64::from(deficit_mib)
            && available_mib >= i64::from(deficit_mib) + balloon::PRESSURE_AVAILABLE_MIB
    }

    fn park_outcome(&self) -> SandboxParkOutcome {
        if self.is_severe_deficit() {
            SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention(
                Box::new(SevereMemoryRetentionDiagnostics {
                    requested_target_mib: self.requested_target_mib,
                    first_observed_target_mib: self.first_observed_target_mib,
                    observed_target_mib: self.last_observed_target_mib,
                    target_observed: self.target_observed,
                    first_actual_mib: self.first_actual_mib,
                    actual_mib: self.last_actual_mib,
                    max_actual_mib: self.max_actual_mib,
                    deficit_mib: self.last_deficit_mib,
                    actual_delta_mib: self.actual_delta_mib(),
                    elapsed_ms: self.elapsed_ms(),
                    sample_count: self.sample_count,
                    reported_free_memory_bytes: self.last_free_memory_bytes,
                    reported_available_memory_bytes: self.last_available_memory_bytes,
                    reported_total_memory_bytes: self.last_total_memory_bytes,
                    reported_swap_in_bytes: self.last_swap_in_bytes,
                    reported_swap_out_bytes: self.last_swap_out_bytes,
                    reported_major_faults: self.last_major_faults,
                    reported_minor_faults: self.last_minor_faults,
                    reported_disk_caches_bytes: self.last_disk_caches_bytes,
                    guest_memory_snapshot: None,
                }),
            ))
        } else {
            SandboxParkOutcome::Reusable
        }
    }

    fn is_pressure_limited_partial_reclaim(&self, deficit_mib: u32, tolerance_mib: u32) -> bool {
        deficit_mib > tolerance_mib
            && deficit_mib < self.severe_deficit_threshold_mib()
            && self.target_observed
            && self.is_guest_memory_pressure_limited()
    }

    fn is_guest_memory_pressure_limited(&self) -> bool {
        self.reported_available_mib()
            .is_some_and(|available_mib| available_mib < balloon::PRESSURE_AVAILABLE_MIB)
    }

    fn severe_deficit_threshold_mib(&self) -> u32 {
        BALLOON_SEVERE_DEFICIT_MIN_MIB.max(self.requested_target_mib / 5)
    }
}

fn log_balloon_settle_timeout(
    log_id: &str,
    target_mib: u32,
    tolerance_mib: u32,
    settle_timeout: Duration,
    summary: &BalloonSettleSummary,
    outcome: &SandboxParkOutcome,
) {
    macro_rules! emit_timeout {
        ($level:expr) => {
            tracing::event!(
                $level,
                id = %log_id,
                actual = ?summary.last_actual_mib,
                target = target_mib,
                deficit_mib = ?summary.last_deficit_mib,
                tolerance_mib,
                elapsed_ms = summary.elapsed_ms(),
                sample_count = summary.sample_count,
                requested_target_mib = summary.requested_target_mib,
                first_observed_target_mib = ?summary.first_observed_target_mib,
                observed_target_mib = ?summary.last_observed_target_mib,
                target_observed = summary.target_observed,
                first_actual_mib = ?summary.first_actual_mib,
                max_actual_mib = ?summary.max_actual_mib,
                actual_delta_mib = ?summary.actual_delta_mib(),
                reported_free_mib = ?summary.reported_free_mib(),
                reported_available_mib = ?summary.reported_available_mib(),
                reported_total_mib = ?summary.reported_total_mib(),
                reason = summary.reason(),
                admission_action = park_admission_action(outcome),
                "balloon inflate incomplete after {}s, pausing anyway",
                settle_timeout.as_secs()
            );
        };
    }

    if summary.reason() == "actual_progressing_timeout"
        && matches!(outcome, SandboxParkOutcome::Reusable)
    {
        emit_timeout!(tracing::Level::INFO);
    } else {
        emit_timeout!(tracing::Level::WARN);
    }
}

fn log_balloon_settle_progress_grace(
    log_id: &str,
    target_mib: u32,
    progress_grace: Duration,
    summary: &BalloonSettleSummary,
) {
    info!(
        id = %log_id,
        actual = ?summary.last_actual_mib,
        target = target_mib,
        deficit_mib = ?summary.last_deficit_mib,
        elapsed_ms = summary.elapsed_ms(),
        sample_count = summary.sample_count,
        previous_actual_mib = ?summary.previous_actual_mib,
        reported_free_mib = ?summary.reported_free_mib(),
        reported_available_mib = ?summary.reported_available_mib(),
        grace_ms = duration_ms(progress_grace),
        "balloon inflation still progressing, extending settle deadline"
    );
}

fn park_admission_action(outcome: &SandboxParkOutcome) -> &'static str {
    match outcome {
        SandboxParkOutcome::Reusable => "reuse",
        SandboxParkOutcome::NonReusable(_) => "reject_and_destroy",
    }
}

#[derive(Debug)]
struct BalloonSettleResult {
    park_outcome: SandboxParkOutcome,
    telemetry_outcome: SandboxFinalExecParkSubstageOutcome,
}

enum BalloonSettleWaitResult {
    Settled(BalloonSettleResult),
    Handoff,
}

enum PhysicalParkOutcome {
    Idle(SandboxParkOutcome),
    Handoff(SandboxFinalExecParkHandoffPoint),
}

/// Wait until the guest balloon driver inflates close enough to `target_mib`.
///
/// The guest needs running vCPUs to inflate, so this must be called
/// **before** pausing. Returns when `actual_mib >= target_mib`, when
/// the remaining deficit is within [`balloon_settle_tolerance_mib`],
/// when guest pressure indicates further reclaim is unsafe, or after
/// [`BALLOON_SETTLE_INITIAL_TIMEOUT`]. A severe deficit that is still progressing
/// with enough unused guest memory gets repeated
/// [`BALLOON_SETTLE_PROGRESS_GRACE`] extensions up to
/// [`BALLOON_SETTLE_MAX_TIMEOUT`]. The returned outcome rejects only the existing
/// severe-deficit classification. Errors from stats fetching are non-fatal —
/// we log and proceed to pause.
#[cfg(test)]
async fn wait_for_balloon_with_outcome(
    client: &ApiClient,
    target_mib: u32,
    log_id: &str,
) -> BalloonSettleResult {
    match wait_for_balloon_with_optional_handoff(client, target_mib, log_id, None).await {
        BalloonSettleWaitResult::Settled(result) => result,
        BalloonSettleWaitResult::Handoff => panic!("handoff signal was not provided"),
    }
}

async fn wait_for_balloon_with_optional_handoff(
    client: &ApiClient,
    target_mib: u32,
    log_id: &str,
    handoff: Option<&SandboxFinalExecParkHandoff>,
) -> BalloonSettleWaitResult {
    let tolerance_mib = balloon_settle_tolerance_mib(target_mib);
    let mut summary = BalloonSettleSummary::new(target_mib);
    let mut settle_timeout = BALLOON_SETTLE_INITIAL_TIMEOUT;
    let mut deadline = summary.started_at + settle_timeout;
    let max_deadline = summary.started_at + BALLOON_SETTLE_MAX_TIMEOUT;
    let mut fast_poll_intervals = BALLOON_SETTLE_FAST_POLL_INTERVALS.into_iter();
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            if now < max_deadline && summary.can_extend_for_progress() {
                let progress_grace = BALLOON_SETTLE_PROGRESS_GRACE.min(max_deadline - now);
                deadline = now + progress_grace;
                settle_timeout = deadline - summary.started_at;
                log_balloon_settle_progress_grace(log_id, target_mib, progress_grace, &summary);
            } else {
                let outcome = summary.park_outcome();
                log_balloon_settle_timeout(
                    log_id,
                    target_mib,
                    tolerance_mib,
                    settle_timeout,
                    &summary,
                    &outcome,
                );
                return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                    park_outcome: outcome,
                    telemetry_outcome: SandboxFinalExecParkSubstageOutcome::Deadline,
                });
            }
        }

        let statistics = match handoff {
            Some(handoff) => {
                tokio::select! {
                    biased;
                    accepted = handoff.wait_and_accept() => {
                        if accepted {
                            return BalloonSettleWaitResult::Handoff;
                        }
                        tokio::time::timeout_at(deadline, client.get_balloon_statistics()).await
                    }
                    statistics = tokio::time::timeout_at(deadline, client.get_balloon_statistics()) => statistics,
                }
            }
            None => tokio::time::timeout_at(deadline, client.get_balloon_statistics()).await,
        };
        match statistics {
            Ok(Ok(stats)) => {
                let deficit_mib = summary.observe(&stats);
                if deficit_mib == 0 {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        "balloon fully inflated, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::TargetReached,
                    });
                }

                if deficit_mib <= tolerance_mib {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        "balloon inflated within tolerance, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::WithinTolerance,
                    });
                }

                if summary.is_pressure_limited_partial_reclaim(deficit_mib, tolerance_mib) {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        reason = BALLOON_PRESSURE_LIMITED_REASON,
                        "balloon pressure-limited partial reclaim, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::PressureLimited,
                    });
                }

                // Balloon timing tests advance paused time only after a completed stats sample.
                #[cfg(test)]
                tracing::event!(tracing::Level::TRACE, "waiting for balloon");
            }
            Ok(Err(e)) => {
                let outcome = summary.park_outcome();
                warn!(
                    id = %log_id,
                    actual = ?summary.last_actual_mib,
                    target = target_mib,
                    deficit_mib = ?summary.last_deficit_mib,
                    tolerance_mib,
                    elapsed_ms = summary.elapsed_ms(),
                    sample_count = summary.sample_count,
                    requested_target_mib = summary.requested_target_mib,
                    first_observed_target_mib = ?summary.first_observed_target_mib,
                    observed_target_mib = ?summary.last_observed_target_mib,
                    target_observed = summary.target_observed,
                    first_actual_mib = ?summary.first_actual_mib,
                    max_actual_mib = ?summary.max_actual_mib,
                    actual_delta_mib = ?summary.actual_delta_mib(),
                    reported_free_mib = ?summary.reported_free_mib(),
                    reported_available_mib = ?summary.reported_available_mib(),
                    reported_total_mib = ?summary.reported_total_mib(),
                    reason = summary.reason(),
                    admission_action = park_admission_action(&outcome),
                    %e,
                    "balloon stats unavailable, proceeding to pause"
                );
                return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                    park_outcome: outcome,
                    telemetry_outcome: SandboxFinalExecParkSubstageOutcome::StatsUnavailable,
                });
            }
            Err(_) => {
                let outcome = summary.park_outcome();
                log_balloon_settle_timeout(
                    log_id,
                    target_mib,
                    tolerance_mib,
                    settle_timeout,
                    &summary,
                    &outcome,
                );
                return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                    park_outcome: outcome,
                    telemetry_outcome: SandboxFinalExecParkSubstageOutcome::Deadline,
                });
            }
        }

        let poll_interval = fast_poll_intervals
            .next()
            .unwrap_or(BALLOON_SETTLE_MAX_POLL);
        let next_poll = tokio::time::Instant::now() + poll_interval;
        let sleep = tokio::time::sleep_until(if next_poll < deadline {
            next_poll
        } else {
            deadline
        });
        tokio::pin!(sleep);
        match handoff {
            Some(handoff) => {
                tokio::select! {
                    biased;
                    accepted = handoff.wait_and_accept() => {
                        if accepted {
                            return BalloonSettleWaitResult::Handoff;
                        }
                        sleep.as_mut().await;
                    }
                    () = sleep.as_mut() => {}
                }
            }
            None => sleep.as_mut().await,
        }
    }
}

fn guest_memory_snapshot(snapshot: guest_control_proto::MemorySnapshot) -> GuestMemorySnapshot {
    GuestMemorySnapshot {
        mem_total_bytes: snapshot.mem_total_bytes,
        mem_free_bytes: snapshot.mem_free_bytes,
        mem_available_bytes: snapshot.mem_available_bytes,
        buffers_bytes: snapshot.buffers_bytes,
        cached_bytes: snapshot.cached_bytes,
        anon_pages_bytes: snapshot.anon_pages_bytes,
        mapped_bytes: snapshot.mapped_bytes,
        dirty_bytes: snapshot.dirty_bytes,
        writeback_bytes: snapshot.writeback_bytes,
        shmem_bytes: snapshot.shmem_bytes,
        slab_bytes: snapshot.slab_bytes,
        slab_reclaimable_bytes: snapshot.slab_reclaimable_bytes,
        slab_unreclaimable_bytes: snapshot.slab_unreclaimable_bytes,
        unevictable_bytes: snapshot.unevictable_bytes,
        kernel_stack_bytes: snapshot.kernel_stack_bytes,
        page_tables_bytes: snapshot.page_tables_bytes,
        swap_total_bytes: snapshot.swap_total_bytes,
        swap_free_bytes: snapshot.swap_free_bytes,
    }
}

async fn terminal_guest_memory_snapshot(
    guest: &Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    log_id: &str,
) -> Option<GuestMemorySnapshot> {
    let Some(guest) = guest.lock().await.as_ref().cloned() else {
        warn!(
            id = %log_id,
            reason = "guest_unavailable",
            "guest memory snapshot unavailable after severe balloon retention"
        );
        return None;
    };
    match guest.memory_snapshot(GUEST_MEMORY_SNAPSHOT_TIMEOUT).await {
        Ok(snapshot) => Some(guest_memory_snapshot(snapshot)),
        Err(error) => {
            warn!(
                id = %log_id,
                reason = "snapshot_request_failed",
                %error,
                "guest memory snapshot unavailable after severe balloon retention"
            );
            None
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ParkMemoryPolicy {
    Reclaim,
    Preserve,
}

struct PhysicalParkRequest<'handoff> {
    guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    handoff: Option<&'handoff SandboxFinalExecParkHandoff>,
    memory_policy: ParkMemoryPolicy,
}

async fn park_inner_with_guest_and_handoff<'observer>(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    log_id: &str,
    request: PhysicalParkRequest<'_>,
    mut events: SandboxFinalExecParkSubstageEvents<'observer>,
) -> (
    SandboxFinalExecParkSubstageEvents<'observer>,
    sandbox::Result<PhysicalParkOutcome>,
) {
    let PhysicalParkRequest {
        guest,
        handoff,
        memory_policy,
    } = request;
    if *is_parked {
        return (
            events,
            Ok(PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)),
        );
    }

    let target = memory_mb.saturating_sub(balloon::MIN_GUEST_MIB);
    let client = match ApiClient::new(api_sock) {
        Ok(client) => client,
        Err(e) => {
            events.record(
                SandboxFinalExecParkSubstage::BalloonSetup,
                Duration::ZERO,
                false,
                Some(SandboxFinalExecParkSubstageOutcome::Failed),
            );
            return (
                events,
                Err(SandboxError::IdleTransition {
                    transition: SandboxIdleTransition::Park,
                    message: format!("create API client: {e}"),
                }),
            );
        }
    };

    // Blank preparation retains its full budget and avoids an idle-only
    // inflate/deflate cycle. Stop the writer before pausing even when its
    // current target is retained; unpark still owns target-zero recovery.
    if memory_policy == ParkMemoryPolicy::Preserve
        && let Some(controller) = balloon_controller.take()
    {
        controller.abort_and_join().await;
    }

    let reclaim_memory = target > 0 && memory_policy == ParkMemoryPolicy::Reclaim;
    let outcome = if reclaim_memory {
        // Stop the reactive controller so we're the sole writer to /balloon.
        // abort() + await ensures any in-flight PATCH from the controller
        // completes (or is cancelled) before ours lands.
        //
        // Ordering note: we abort BEFORE the PATCH (rather than after) because
        // the controller's reactive logic would otherwise see the post-inflate
        // drop in `available_memory` as memory pressure and immediately deflate
        // back, undoing our work.
        //
        // Failure-mode invariant: if patch_balloon or pause returns Err, the
        // controller is gone and `is_parked` stays false. This is an
        // intentional "transient inconsistent" state — the runner's only
        // failure handling is `stop_and_destroy_sandbox`, so the sandbox is
        // dropped (and Drop ensures any leftover handles are aborted) before
        // any further operations can observe the missing controller.
        let balloon_setup_started = Instant::now();
        if let Some(controller) = balloon_controller.take() {
            controller.abort_and_join().await;
        }

        if handoff.is_some_and(SandboxFinalExecParkHandoff::accept_if_requested) {
            events.record(
                SandboxFinalExecParkSubstage::BalloonSetup,
                balloon_setup_started.elapsed(),
                true,
                Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested),
            );
            events.record(
                SandboxFinalExecParkSubstage::BalloonSettle,
                Duration::ZERO,
                true,
                Some(SandboxFinalExecParkSubstageOutcome::Skipped),
            );
            PhysicalParkOutcome::Handoff(SandboxFinalExecParkHandoffPoint::BeforeBalloon)
        } else {
            if let Err(e) = client.patch_balloon(target).await {
                events.record(
                    SandboxFinalExecParkSubstage::BalloonSetup,
                    balloon_setup_started.elapsed(),
                    false,
                    Some(SandboxFinalExecParkSubstageOutcome::Failed),
                );
                return (
                    events,
                    Err(SandboxError::IdleTransition {
                        transition: SandboxIdleTransition::Park,
                        message: format!("balloon inflate: {e}"),
                    }),
                );
            }
            events.record(
                SandboxFinalExecParkSubstage::BalloonSetup,
                balloon_setup_started.elapsed(),
                true,
                None,
            );

            // Wait for the guest to inflate the balloon close enough before
            // pausing vCPUs. The guest balloon driver needs running vCPUs to
            // process the inflate — pausing immediately would negate the memory
            // savings.
            let balloon_settle_started = Instant::now();
            let settle_result =
                wait_for_balloon_with_optional_handoff(&client, target, log_id, handoff).await;
            match settle_result {
                BalloonSettleWaitResult::Handoff => {
                    events.record(
                        SandboxFinalExecParkSubstage::BalloonSettle,
                        balloon_settle_started.elapsed(),
                        true,
                        Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested),
                    );
                    PhysicalParkOutcome::Handoff(
                        SandboxFinalExecParkHandoffPoint::DuringBalloonSettle,
                    )
                }
                BalloonSettleWaitResult::Settled(BalloonSettleResult {
                    mut park_outcome,
                    telemetry_outcome,
                }) => {
                    match &mut park_outcome {
                        SandboxParkOutcome::NonReusable(
                            SandboxParkNonReusableReason::SevereMemoryRetention(diagnostics),
                        ) => {
                            diagnostics.guest_memory_snapshot =
                                terminal_guest_memory_snapshot(&guest, log_id).await;
                        }
                        SandboxParkOutcome::Reusable => {}
                    }
                    events.record(
                        SandboxFinalExecParkSubstage::BalloonSettle,
                        balloon_settle_started.elapsed(),
                        true,
                        Some(telemetry_outcome),
                    );
                    PhysicalParkOutcome::Idle(park_outcome)
                }
            }
        }
    } else {
        let handoff_requested =
            handoff.is_some_and(SandboxFinalExecParkHandoff::accept_if_requested);
        events.record(
            SandboxFinalExecParkSubstage::BalloonSetup,
            Duration::ZERO,
            true,
            Some(if handoff_requested {
                SandboxFinalExecParkSubstageOutcome::HandoffRequested
            } else {
                SandboxFinalExecParkSubstageOutcome::Skipped
            }),
        );
        events.record(
            SandboxFinalExecParkSubstage::BalloonSettle,
            Duration::ZERO,
            true,
            Some(SandboxFinalExecParkSubstageOutcome::Skipped),
        );
        if handoff_requested {
            PhysicalParkOutcome::Handoff(SandboxFinalExecParkHandoffPoint::BeforeBalloon)
        } else {
            PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
        }
    };

    // Pause vCPUs to eliminate idle CPU overhead (timer ticks, kernel
    // scheduling). Small VMs and blank preparation skip idle inflation
    // but still pause — timer ticks waste CPU regardless of memory size.
    let vcpu_pause_started = Instant::now();
    if let Err(e) = client.pause().await {
        events.record(
            SandboxFinalExecParkSubstage::VcpuPause,
            vcpu_pause_started.elapsed(),
            false,
            Some(SandboxFinalExecParkSubstageOutcome::Failed),
        );
        return (
            events,
            Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Park,
                message: format!("vm pause: {e}"),
            }),
        );
    }
    events.record(
        SandboxFinalExecParkSubstage::VcpuPause,
        vcpu_pause_started.elapsed(),
        true,
        None,
    );

    *is_parked = true;
    match &outcome {
        PhysicalParkOutcome::Handoff(_) => {
            info!(id = %log_id, "sandbox parked for exact-successor handoff");
        }
        PhysicalParkOutcome::Idle(_) if reclaim_memory => {
            info!(
                id = %log_id,
                target_mib = target,
                admission_action = physical_park_admission_action(&outcome),
                "sandbox parked (balloon settled, vCPUs paused)"
            );
        }
        PhysicalParkOutcome::Idle(_) => {
            info!(
                id = %log_id,
                admission_action = physical_park_admission_action(&outcome),
                "sandbox parked (vCPUs paused, balloon skipped)"
            );
        }
    }
    (events, Ok(outcome))
}

fn physical_park_admission_action(outcome: &PhysicalParkOutcome) -> &'static str {
    match outcome {
        PhysicalParkOutcome::Idle(outcome) => park_admission_action(outcome),
        PhysicalParkOutcome::Handoff(_) => "exact_handoff",
    }
}

async fn park_inner_with_guest<'observer>(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    log_id: &str,
    request: PhysicalParkRequest<'_>,
    events: SandboxFinalExecParkSubstageEvents<'observer>,
) -> (
    SandboxFinalExecParkSubstageEvents<'observer>,
    sandbox::Result<SandboxParkOutcome>,
) {
    let (events, result) = park_inner_with_guest_and_handoff(
        is_parked,
        memory_mb,
        balloon_controller,
        api_sock,
        log_id,
        request,
        events,
    )
    .await;
    let result = result.and_then(|outcome| match outcome {
        PhysicalParkOutcome::Idle(outcome) => Ok(outcome),
        PhysicalParkOutcome::Handoff(_) => Err(idle_transition_error(
            SandboxIdleTransition::Park,
            "provider accepted a handoff without a handoff signal",
        )),
    });
    (events, result)
}

#[cfg(test)]
async fn park_inner(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    log_id: &str,
) -> sandbox::Result<SandboxParkOutcome> {
    let (_, result) = park_inner_with_guest(
        is_parked,
        memory_mb,
        balloon_controller,
        api_sock,
        log_id,
        PhysicalParkRequest {
            guest: Arc::new(tokio::sync::Mutex::new(None)),
            handoff: None,
            memory_policy: ParkMemoryPolicy::Reclaim,
        },
        SandboxFinalExecParkSubstageEvents::new(None),
    )
    .await;
    result
}

async fn unpark_inner(
    is_parked: &mut bool,
    memory_mb: u32,
    balloon_controller: &mut Option<balloon::ControllerHandle>,
    api_sock: &std::path::Path,
    state_rx: watch::Receiver<SandboxState>,
    log_id: &str,
    purpose: UnparkPurpose,
) -> sandbox::Result<()> {
    if !*is_parked {
        return Ok(());
    }

    // Resume vCPUs before any balloon work — the guest needs running
    // vCPUs to process the deflate PATCH.
    let client = ApiClient::new(api_sock).map_err(|e| SandboxError::IdleTransition {
        transition: SandboxIdleTransition::Unpark,
        message: format!("create API client: {e}"),
    })?;
    client
        .resume()
        .await
        .map_err(|e| SandboxError::IdleTransition {
            transition: SandboxIdleTransition::Unpark,
            message: format!("vm resume: {e}"),
        })?;

    let park_touched_controller = memory_mb > balloon::MIN_GUEST_MIB;

    if park_touched_controller {
        // By construction, park_inner left the slot None when it inflated
        // (and the is_parked guard above ensures we entered exactly one
        // park→unpark transition). Loudly catch invariant violations in
        // debug, and defensively take+abort in release so a violated
        // invariant doesn't leave an unexpected controller running.
        debug_assert!(
            balloon_controller.is_none(),
            "controller slot must be None when entering unpark from a parked state",
        );
        if let Some(controller) = balloon_controller.take() {
            controller.abort();
        }

        // Propagate deflate failure rather than swallow it. On a healthy
        // Firecracker, PATCH /balloon doesn't return transient errors —
        // any failure here (Connect / Http / Other) strongly suggests FC
        // is dead or unhealthy. Symmetric with park's failure mode: the
        // caller (runner take-site) destroys the sandbox and falls
        // through to fresh-create. Leaving is_parked=true and controller=None
        // is safe: the sandbox is about to be dropped; a hypothetical retry
        // would re-enter this branch and attempt deflate again.
        client
            .patch_balloon(0)
            .await
            .map_err(|e| SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                message: format!("balloon deflate: {e}"),
            })?;

        *balloon_controller = match purpose {
            UnparkPurpose::Reuse => Some(balloon::spawn_after_unpark_deflation(
                client,
                memory_mb,
                state_rx,
                log_id.to_owned(),
            )),
            UnparkPurpose::BlankReuse => Some(balloon::spawn_after_blank_unpark(
                client,
                memory_mb,
                state_rx,
                log_id.to_owned(),
            )),
            UnparkPurpose::TerminalOperations => None,
        };
    }

    *is_parked = false;
    info!(id = %log_id, "sandbox unparked (vCPUs resumed)");
    Ok(())
}

#[cfg(test)]
mod tests;
