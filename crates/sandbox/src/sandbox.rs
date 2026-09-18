use std::any::Any;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::Notify;

use crate::error::{Result, SandboxError, SandboxIdleTransition};
use crate::types::{
    CodexSessionCleanupRequest, CopyFileOptions, CopyFileResult, ExecRequest, ExecResult,
    GuestAgentProcessHandle, GuestProcessHandle, GuestStateRestoreRequest, ProcessExit,
    SessionHistoryIdentityVerifyRequest, StartAgentProcessRequest, StartProcessRequest,
    StorageManifestRequest, WriteFileEntry,
};

/// Ephemeral file-transfer encoding, explicitly selected by the business caller.
/// The bytes and format stored inside the guest are unchanged.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FileCompression {
    #[default]
    /// Use the ordinary uncompressed transfer.
    None,
    /// Stream a checksummed zstd frame at the transport's fast compression level.
    Zstd,
}

/// Measurements from one successfully completed file write, using Host clocks.
/// Payload bytes exclude protocol framing. Request time includes transport and
/// Guest work; encoder pipeline time overlaps it and includes backpressure.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FileWriteMeasurements {
    pub wire_payload_bytes: u64,
    pub requests: u64,
    pub file_gate_wait: Duration,
    pub requests_elapsed: Duration,
    pub encoder_pipeline_elapsed: Duration,
    pub publication_elapsed: Duration,
}

/// Eligibility result after a sandbox successfully reaches the parked state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxParkOutcome {
    /// The parked sandbox may be admitted to an idle pool for later reuse.
    Reusable,
    /// The sandbox is validly parked but must be destroyed instead of reused.
    NonReusable(SandboxParkNonReusableReason),
}

/// Completed final guest exec together with the resulting parked state.
///
/// The exec result is transport-complete but may still be semantically
/// unacceptable to the lifecycle owner. The sandbox is validly parked in
/// either case and must be admitted or destroyed through a parked cleanup path.
pub struct SandboxFinalExecParkOutcome {
    /// Terminal result of the lifecycle-owned final guest exec.
    pub exec_result: ExecResult,
    /// Eligibility reported after the sandbox reached the parked state.
    pub park_outcome: SandboxParkOutcome,
}

/// Point where an exact successor shortened physical park preparation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxFinalExecParkHandoffPoint {
    /// The request was accepted before submitting the park-time balloon target.
    BeforeBalloon,
    /// The request interrupted the bounded balloon-settle wait.
    DuringBalloonSettle,
    /// The request interrupted pre-pause deflation or arrived before vCPU pause.
    DuringDeflation,
}

/// Completed final guest exec and either physical park or fenced running
/// ownership for an already-claimed exact successor.
pub enum SandboxFinalExecParkHandoffOutcome {
    /// No handoff request interrupted provider compaction.
    Parked(SandboxFinalExecParkOutcome),
    /// The sandbox is still running with Guest operations quiesced and fenced.
    /// The old lifecycle writer has retired and balloon deflation has started.
    /// It must be delivered only to the accepted exact successor or destroyed.
    /// The successor must bind run control and call `unpark` to finish memory
    /// readiness and reopen Guest operations without a vCPU resume.
    Handoff {
        /// Terminal result of the lifecycle-owned final guest exec.
        exec_result: ExecResult,
        /// Provider boundary where the request shortened physical park.
        point: SandboxFinalExecParkHandoffPoint,
    },
}

const HANDOFF_OPEN: u8 = 0;
const HANDOFF_REQUESTED: u8 = 1;
const HANDOFF_ACCEPTED: u8 = 2;
const HANDOFF_CANCELLED: u8 = 3;

struct SandboxFinalExecParkHandoffState {
    state: AtomicU8,
    changed: Notify,
}

/// Monotonic one-shot coordination between an exact successor and physical
/// sandbox parking.
///
/// A lifecycle owner creates one signal for an active run. At most one exact
/// successor may request it. The provider may accept that request before or
/// during idle compaction; cancellation before acceptance permanently closes
/// the signal so another successor cannot inherit the request.
#[derive(Clone)]
pub struct SandboxFinalExecParkHandoff {
    inner: Arc<SandboxFinalExecParkHandoffState>,
}

impl SandboxFinalExecParkHandoff {
    /// Create an unrequested one-shot handoff signal.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SandboxFinalExecParkHandoffState {
                state: AtomicU8::new(HANDOFF_OPEN),
                changed: Notify::new(),
            }),
        }
    }

    /// Register the only exact-successor request.
    pub fn request(&self) -> bool {
        let requested = self
            .inner
            .state
            .compare_exchange(
                HANDOFF_OPEN,
                HANDOFF_REQUESTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        if requested {
            self.inner.changed.notify_waiters();
        }
        requested
    }

    /// Permanently close the signal before the provider accepts a request.
    pub fn cancel(&self) -> bool {
        loop {
            let state = self.inner.state.load(Ordering::Acquire);
            match state {
                HANDOFF_OPEN | HANDOFF_REQUESTED => {
                    if self
                        .inner
                        .state
                        .compare_exchange_weak(
                            state,
                            HANDOFF_CANCELLED,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        self.inner.changed.notify_waiters();
                        return true;
                    }
                }
                HANDOFF_ACCEPTED | HANDOFF_CANCELLED..=u8::MAX => return false,
            }
        }
    }

    /// Return whether the provider has already accepted the one-shot request.
    pub fn is_accepted(&self) -> bool {
        self.inner.state.load(Ordering::Acquire) == HANDOFF_ACCEPTED
    }

    /// Accept a pending request, or confirm that it was already accepted.
    pub fn accept_if_requested(&self) -> bool {
        loop {
            match self.inner.state.load(Ordering::Acquire) {
                HANDOFF_ACCEPTED => return true,
                HANDOFF_REQUESTED => {
                    if self
                        .inner
                        .state
                        .compare_exchange_weak(
                            HANDOFF_REQUESTED,
                            HANDOFF_ACCEPTED,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        self.inner.changed.notify_waiters();
                        return true;
                    }
                }
                _ => return false,
            }
        }
    }

    /// Wait for a request and accept it, returning false if it was cancelled.
    pub async fn wait_and_accept(&self) -> bool {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.inner.state.load(Ordering::Acquire) {
                HANDOFF_ACCEPTED => return true,
                HANDOFF_REQUESTED => return self.accept_if_requested(),
                HANDOFF_CANCELLED..=u8::MAX => return false,
                HANDOFF_OPEN => changed.as_mut().await,
            }
        }
    }

    /// Wait until the provider accepts the request or the request is cancelled.
    pub async fn wait_for_acceptance(&self) -> bool {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.inner.state.load(Ordering::Acquire) {
                HANDOFF_ACCEPTED => return true,
                HANDOFF_CANCELLED..=u8::MAX => return false,
                HANDOFF_OPEN | HANDOFF_REQUESTED => changed.as_mut().await,
            }
        }
    }
}

impl Default for SandboxFinalExecParkHandoff {
    fn default() -> Self {
        Self::new()
    }
}

/// Stable reason why a validly parked sandbox cannot be reused.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SandboxParkNonReusableReason {
    /// The guest retained too much memory after the bounded park-time reclaim.
    SevereMemoryRetention(Box<SevereMemoryRetentionDiagnostics>),
}

impl SandboxParkNonReusableReason {
    /// Stable low-cardinality value for lifecycle logs and cleanup context.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::SevereMemoryRetention(_) => "severe_memory_retention",
        }
    }
}

/// Aggregate guest memory counters captured after severe balloon retention.
///
/// Values are content-free byte counts from Linux `/proc/meminfo` at the
/// quiesced lifecycle boundary immediately before the VM is paused.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuestMemorySnapshot {
    /// Total memory visible to the guest.
    pub mem_total_bytes: u64,
    /// Completely unused memory.
    pub mem_free_bytes: u64,
    /// Estimated memory available for starting new applications.
    pub mem_available_bytes: u64,
    /// Block-device buffer memory.
    pub buffers_bytes: u64,
    /// Filesystem page-cache memory.
    pub cached_bytes: u64,
    /// Anonymous userspace pages.
    pub anon_pages_bytes: u64,
    /// File-backed pages mapped into processes.
    pub mapped_bytes: u64,
    /// Dirty pages waiting to be written.
    pub dirty_bytes: u64,
    /// Pages actively being written back.
    pub writeback_bytes: u64,
    /// Shared-memory pages.
    pub shmem_bytes: u64,
    /// Total kernel slab memory.
    pub slab_bytes: u64,
    /// Reclaimable kernel slab memory.
    pub slab_reclaimable_bytes: u64,
    /// Unreclaimable kernel slab memory.
    pub slab_unreclaimable_bytes: u64,
    /// Memory that cannot be reclaimed or swapped.
    pub unevictable_bytes: u64,
    /// Kernel stack memory.
    pub kernel_stack_bytes: u64,
    /// Page-table memory.
    pub page_tables_bytes: u64,
    /// Total configured swap.
    pub swap_total_bytes: u64,
    /// Unused configured swap.
    pub swap_free_bytes: u64,
}

/// Terminal evidence attached to a severe memory-retention park result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SevereMemoryRetentionDiagnostics {
    /// Balloon target requested by the provider, in MiB.
    pub requested_target_mib: u32,
    /// First target reported by Firecracker, in MiB.
    pub first_observed_target_mib: Option<u32>,
    /// Final target reported by Firecracker, in MiB.
    pub observed_target_mib: Option<u32>,
    /// Whether Firecracker reported the requested target at least once.
    pub target_observed: bool,
    /// First reported actual balloon size, in MiB.
    pub first_actual_mib: Option<u32>,
    /// Final reported actual balloon size, in MiB.
    pub actual_mib: Option<u32>,
    /// Maximum reported actual balloon size, in MiB.
    pub max_actual_mib: Option<u32>,
    /// Final difference between requested and actual size, in MiB.
    pub deficit_mib: Option<u32>,
    /// Change from first to final actual size, in MiB.
    pub actual_delta_mib: Option<i64>,
    /// Elapsed settle time in milliseconds.
    pub elapsed_ms: u64,
    /// Number of Firecracker statistics samples observed.
    pub sample_count: u32,
    /// Final guest free memory reported by Firecracker, in bytes.
    pub reported_free_memory_bytes: Option<i64>,
    /// Final guest available memory reported by Firecracker, in bytes.
    pub reported_available_memory_bytes: Option<i64>,
    /// Final guest total memory reported by Firecracker, in bytes.
    pub reported_total_memory_bytes: Option<i64>,
    /// Final cumulative guest swap-in reported by Firecracker, in bytes.
    pub reported_swap_in_bytes: Option<i64>,
    /// Final cumulative guest swap-out reported by Firecracker, in bytes.
    pub reported_swap_out_bytes: Option<i64>,
    /// Final cumulative major page-fault count reported by Firecracker.
    pub reported_major_faults: Option<i64>,
    /// Final cumulative minor page-fault count reported by Firecracker.
    pub reported_minor_faults: Option<i64>,
    /// Final disk-cache memory reported by Firecracker, in bytes.
    pub reported_disk_caches_bytes: Option<i64>,
    /// Terminal guest counters, absent when the diagnostic request failed.
    pub guest_memory_snapshot: Option<GuestMemorySnapshot>,
}

/// Fixed low-cardinality stages on the sandbox start critical path.
///
/// Providers report only stages that apply to a start. The snapshot stage is
/// absent for a fresh boot, and the DNS stage is absent when the provider does
/// not perform a guest DNS readiness check. On a successful start, reported
/// stages are ordered, non-overlapping wall-clock intervals. Concurrent work
/// belongs to the interval that contains it; for example, guest connection
/// waiting measures only the residual wait after backend startup completes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxStartStage {
    /// Prepares and launches the backend through its control API readiness.
    BackendLaunch,
    /// Loads and resumes an applicable backend snapshot.
    SnapshotLoadResume,
    /// Waits for the residual guest control connection after backend startup.
    GuestConnectionWait,
    /// Proves that the configured guest DNS path is ready.
    GuestDnsReadiness,
    /// Publishes the guest and starts the remaining host runtime services.
    RuntimeFinalize,
}

impl SandboxStartStage {
    /// All start stages in stable catalog order.
    ///
    /// Providers can omit stages that do not apply. This order describes the
    /// successful critical path, not a completeness guarantee after failure or
    /// cancellation.
    pub const ALL: [Self; 5] = [
        Self::BackendLaunch,
        Self::SnapshotLoadResume,
        Self::GuestConnectionWait,
        Self::GuestDnsReadiness,
        Self::RuntimeFinalize,
    ];
}

/// Receives optional low-cardinality sandbox start timing records.
///
/// Providers that override [`Sandbox::start_with_observer`] invoke the callback
/// for every applicable stage when it resolves, before running failure
/// diagnostics or cleanup. Earlier successful callbacks remain valid when a
/// later stage fails. Cancellation can leave a completed prefix without a
/// callback for the in-progress stage. Implementations using the default method
/// report no stages.
///
/// For an overriding implementation, successful start stages are
/// non-overlapping and cover the provider start critical path after lifecycle
/// precondition checks. A failed parent start can additionally include
/// diagnostics and cleanup after the failed stage callback. Observer callbacks
/// are informational and never own lifecycle transitions or cleanup.
pub trait SandboxStartObserver: Send {
    /// Records one completed start stage.
    ///
    /// `success` is the result of this stage, not the final result of the full
    /// start. A provider invokes this callback at most once per applicable
    /// stage.
    fn record_stage(&mut self, stage: SandboxStartStage, duration: Duration, success: bool);

    /// Records a child attempt inside the guest DNS readiness stage.
    ///
    /// Providers may buffer these callbacks until the invocation ends to avoid
    /// observer work between retries. Children overlap their parent, and must
    /// not be added to it. Cancellation may report an incomplete child without
    /// a completed parent; this callback never owns cancellation or cleanup.
    fn record_dns_readiness_attempt(&mut self, _attempt: crate::SandboxDnsReadinessAttempt) {}

    /// Records optional guest-connection detail, separately from critical-path stages.
    ///
    /// `duration` covers the full host-observed phase, including work overlapping
    /// backend startup. `remaining` is its intersection with this same start's
    /// residual guest-connection wait. Never add full durations to start stages.
    /// A phase is emitted at most once; missing detail after cancellation, panic,
    /// or an earlier startup failure is not a zero-duration observation.
    fn record_guest_connection_phase(
        &mut self,
        _phase: SandboxGuestConnectionPhase,
        _duration: Duration,
        _remaining: Duration,
        _success: bool,
    ) {
    }
}

/// Fixed host-side guest connection phases, not guest-internal execution times.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxGuestConnectionPhase {
    /// Task submission through the connection operation's first poll.
    TaskSchedule,
    /// Deadline/path preparation, stale socket removal and listener bind.
    ListenerSetup,
    /// Bound listener through successful accept, or the accept error.
    Accept,
    /// Accept through READY decode, including listener unlinking and decoder setup.
    Ready,
    /// READY decode through complete PING frame write.
    Ping,
    /// PING write through decode of the matching PONG.
    Pong,
    /// PONG decode through client initialization and reader task submission.
    ClientSetup,
    /// Connection operation completion through the startup caller's observation.
    TaskHandoff,
}

impl SandboxGuestConnectionPhase {
    /// Stable phase order; errors may produce only a completed prefix and failed phase.
    pub const ALL: [Self; 8] = [
        Self::TaskSchedule,
        Self::ListenerSetup,
        Self::Accept,
        Self::Ready,
        Self::Ping,
        Self::Pong,
        Self::ClientSetup,
        Self::TaskHandoff,
    ];
}

/// Fixed low-cardinality stages of the final reuse preparation and park path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxFinalExecParkStage {
    /// Fences normal operations, runs the final guest preparation, and reaches
    /// the provider's safe pre-park boundary.
    ReusePreparation,
    /// Completes provider-specific park or running handoff after preparation.
    PhysicalPark,
}

/// Fixed low-cardinality provider operations inside the final physical park.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxFinalExecParkSubstage {
    /// Submits the park-time balloon target under lifecycle ownership.
    BalloonSetup,
    /// Waits for the guest balloon to reach the existing settle policy.
    BalloonSettle,
    /// Returns the guest balloon target to zero before vCPU pause.
    BalloonDeflate,
    /// Pauses guest vCPUs after balloon handling completes.
    VcpuPause,
}

/// Bounded terminal classification for a final physical-park sub-stage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxFinalExecParkSubstageOutcome {
    /// The provider operation was not needed, such as a zero balloon target.
    Skipped,
    /// The requested balloon target was observed.
    TargetReached,
    /// The balloon deficit was within the existing tolerance.
    WithinTolerance,
    /// Guest pressure limited reclaim and the existing policy proceeded.
    PressureLimited,
    /// The existing settle deadline elapsed.
    Deadline,
    /// Balloon statistics were unavailable and the existing policy proceeded.
    StatsUnavailable,
    /// Exact-successor demand shortened idle-only memory compaction.
    HandoffRequested,
    /// The provider operation failed.
    Failed,
}

impl SandboxFinalExecParkSubstageOutcome {
    /// Stable low-cardinality value for telemetry dimensions.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Skipped => "skipped",
            Self::TargetReached => "target_reached",
            Self::WithinTolerance => "within_tolerance",
            Self::PressureLimited => "pressure_limited",
            Self::Deadline => "deadline",
            Self::StatsUnavailable => "stats_unavailable",
            Self::HandoffRequested => "handoff_requested",
            Self::Failed => "failed",
        }
    }
}

/// Receives optional final preparation and physical-park timing records.
///
/// Callbacks describe completed stages only and are informational: they never
/// own lifecycle transitions, cleanup, or cancellation. A cancelled attempt
/// can therefore omit the stage that was in progress. Implementations using
/// the default observer-aware method report no stages.
///
/// An overriding implementation reports each applicable stage at most once.
/// `PhysicalPark` is reported only after a successful `ReusePreparation`;
/// either failed stage ends the sequence.
pub trait SandboxFinalExecParkObserver: Send {
    /// Records one completed final-exec/park stage.
    fn record_stage(&mut self, stage: SandboxFinalExecParkStage, duration: Duration, success: bool);

    /// Records one completed provider operation inside the physical-park stage.
    ///
    /// `success` remains independent from `outcome`: settle deadlines and
    /// unavailable statistics can be completed, non-error provider paths.
    /// Providers invoke this at most once for each applicable sub-stage; a
    /// cancellation can omit the sub-stage that was still in progress.
    /// Implementations that do not need sub-stage timing can use the default
    /// no-op method for source compatibility.
    fn record_substage(
        &mut self,
        _substage: SandboxFinalExecParkSubstage,
        _duration: Duration,
        _success: bool,
        _outcome: Option<SandboxFinalExecParkSubstageOutcome>,
    ) {
    }
}

/// A process-isolation environment that runs guest workloads for the runner.
///
/// Implementations are created by a [`SandboxFactory`](crate::SandboxFactory)
/// and consumed as `Box<dyn Sandbox>`.
///
/// # Lifecycle
/// ```text
///   created  ──start()──▶  running  ──stop()/kill()──▶  stopped
///                             │  ▲
///                             └──┤ park()/unpark()
/// ```
/// - [`start`](Self::start) boots the guest; it must be called exactly
///   once and must precede any operation.
/// - [`stop`](Self::stop) asks the guest to shut down gracefully, then
///   kills the backing process. [`kill`](Self::kill) skips the graceful
///   step. Both are idempotent and both end in the stopped state.
/// - [`park`](Self::park) / [`unpark`](Self::unpark) reclaim guest
///   resources while idle; a parked sandbox must be unparked before
///   further operations.
///
/// # Operations
/// Once running, callers invoke [`exec`](Self::exec) /
/// [`read_file`](Self::read_file) / [`copy_file`](Self::copy_file) /
/// [`write_file`](Self::write_file) / [`start_process`](Self::start_process) /
/// [`wait_process`](Self::wait_process) via the host-to-guest IPC channel
/// (vsock, in the Firecracker backend). Operations race against a crash
/// notifier so that a dying backend process surfaces as
/// [`BackendCrashed`](crate::SandboxOperationReason::BackendCrashed)
/// instead of an opaque IPC timeout.
///
/// # Thread-safety and trait objects
/// Implementations are consumed as `Box<dyn Sandbox>` and shared across
/// tasks, hence `Send + Sync`. The `Any` bound allows
/// [`SandboxFactory::destroy()`](crate::SandboxFactory::destroy) to
/// downcast back to the concrete type for backend-specific cleanup.
///
/// # Panic/drop cleanup contract
/// Production backends must make dropping an active sandbox a best-effort
/// emergency cleanup path. If runner-side code unwinds before calling
/// [`SandboxFactory::destroy()`](crate::SandboxFactory::destroy), `Drop`
/// must not silently leave a backing process and associated host resources alive.
/// This fallback is only a safety net: callers must not treat drop-triggered
/// cleanup as proof that explicit destroy completed.
#[async_trait]
pub trait Sandbox: Send + Sync + Any {
    // -- identity --

    /// Stable identifier for this sandbox, unique within the runner
    /// process. Used in logs, metrics, and socket/path derivation.
    fn id(&self) -> &str;
    /// The network-visible source IP address for this sandbox.
    /// Used as the key for proxy sandbox registration.
    fn source_ip(&self) -> &str;
    /// Host-side PID of the sandbox backing process (e.g. firecracker).
    /// Used for host diagnostics like OOM detection.
    fn host_process_pid(&self) -> Option<u32> {
        None
    }

    /// Bind the opaque full run identity used to guard remote run-scoped
    /// controls for this sandbox assignment.
    ///
    /// Lifecycle owners must call this before a fresh sandbox starts serving
    /// controls and while a reused sandbox is still parked, before unpark.
    /// Providers without assignment-aware out-of-process controls may retain
    /// this no-op implementation.
    fn bind_run_control(&mut self, _run_id: &str) -> Result<()> {
        Ok(())
    }

    /// Optional Guest-to-Runner RPC for this exact host-derived Run assignment.
    /// Providers without guest RPC support, including local mode, return `None`.
    /// Obtaining a capability does not authorize a destination or start guest RPC.
    fn guest_rpc(&self, _expected_run_id: &str) -> Option<Arc<dyn crate::GuestRpcAcceptor>> {
        None
    }

    // -- lifecycle --

    /// Boot the guest and make the sandbox ready to serve operations.
    ///
    /// Must only be called once per instance. Implementations must leave
    /// no leaked processes, sockets, or mounts on failure — a failed
    /// `start` is equivalent to a sandbox that was never started, and
    /// the caller may drop the instance without calling `stop`/`kill`.
    async fn start(&mut self) -> Result<()>;
    /// Start the sandbox while reporting provider-supported phase timings.
    ///
    /// This has the same lifecycle, success, failure, and cleanup contract as
    /// [`start`](Self::start). An overriding implementation reports each stage
    /// applicable to its provider and must not use observer callbacks as
    /// cleanup authority. The default implementation preserves existing
    /// provider behavior and emits no callbacks.
    async fn start_with_observer(
        &mut self,
        _observer: &mut dyn SandboxStartObserver,
    ) -> Result<()> {
        self.start().await
    }
    /// Shut the guest down gracefully, then terminate the backing process.
    ///
    /// The guest is first notified via the IPC channel (with an
    /// implementation-defined timeout) so user workloads can clean up;
    /// the backing process is killed regardless of whether the guest
    /// acknowledged. For a parked sandbox the graceful step is skipped
    /// (vCPUs are paused and cannot process the message) and the
    /// sandbox goes straight to force-kill — no user workload is lost
    /// because a parked sandbox is idle by definition.
    ///
    /// Idempotent: calling `stop` on an already-stopped (or concurrently
    /// stopping) sandbox returns `Ok(())` without side effects.
    async fn stop(&mut self) -> Result<()>;
    /// Terminate the backing process immediately, without a graceful
    /// guest shutdown. Prefer [`stop`](Self::stop) for normal teardown;
    /// reach for `kill` when the guest is unresponsive or the caller is
    /// already abandoning any in-flight work.
    ///
    /// Idempotent: calling `kill` on an already-stopped (or concurrently
    /// stopping) sandbox returns `Ok(())` without side effects.
    async fn kill(&mut self) -> Result<()>;

    // -- idle transitions --

    /// Transition the sandbox into the idle/parked state.
    ///
    /// Implementations may reclaim guest memory (e.g. balloon inflate)
    /// and pause vCPUs to eliminate idle CPU overhead. A parked sandbox's
    /// `stop()` must handle the paused state (e.g. skip graceful guest
    /// shutdown and go straight to force-kill, since vCPUs cannot process
    /// vsock messages).
    ///
    /// Note: after a partial `unpark()` failure (e.g. vCPU resume
    /// succeeded but balloon deflate failed), the sandbox is flagged as
    /// "still parked" even though vCPUs may actually be running. `stop()`
    /// implementations must tolerate this — skipping graceful shutdown is
    /// still correct because the sandbox was idle with no user workload.
    ///
    /// On success, the returned [`SandboxParkOutcome`] states whether the
    /// validly parked sandbox may enter an idle pool. A non-reusable outcome is
    /// not an operational failure; the lifecycle owner must destroy the parked
    /// sandbox through its parked cleanup path.
    ///
    /// Must be idempotent for a healthy already-parked sandbox: calling
    /// `park()` again returns the same successful eligibility outcome without
    /// side effects. Implementations may still return `Err` if lifecycle guards
    /// detect that the sandbox is internally dirty or otherwise not safe to
    /// reuse.
    ///
    /// On `Err`, the caller must not dispatch further work to the sandbox.
    /// The sandbox may be partially parked or marked internally dirty; the
    /// lifecycle owner should destroy it, or perform an explicit retry only
    /// when the implementation documents that retry as safe.
    async fn park(&mut self) -> Result<SandboxParkOutcome> {
        Ok(SandboxParkOutcome::Reusable)
    }

    /// Park a tenant-free sandbox prepared for the blank pool.
    ///
    /// The caller retains the full profile resource budget. Providers may
    /// preserve guest memory to avoid reclaiming it only to return it during
    /// startup. All fencing, idempotency, failure and cleanup requirements of
    /// [`park`](Self::park) still apply. Providers without a distinct blank
    /// memory policy use ordinary parking.
    async fn park_for_blank_pool(&mut self) -> Result<SandboxParkOutcome> {
        self.park().await
    }

    /// Run one final normal guest exec and park without reopening operation
    /// admission between the exec and pause.
    ///
    /// Implementations must close admission to new normal/control operations
    /// before atomically ordering `request` after every previously admitted
    /// normal operation. A successful exec must remain fenced through guest
    /// quiesce and the completed park transition. A competing earlier operation
    /// may reject this transition, but it must not run after the final exec and
    /// still allow this method to succeed.
    ///
    /// A completed non-zero or otherwise semantically unacceptable exec result
    /// may still be returned after a valid park; the lifecycle owner decides
    /// whether to admit or destroy that parked sandbox. On `Err`, callers must
    /// not dispatch further work and should destroy the sandbox.
    ///
    /// Unlike [`park`](Self::park), this operation is not idempotent because its
    /// final exec must run exactly once on an active sandbox.
    async fn final_exec_and_park(
        &mut self,
        _request: &ExecRequest<'_>,
        _diagnostic_label: &'static str,
    ) -> Result<SandboxFinalExecParkOutcome> {
        Err(SandboxError::IdleTransition {
            transition: SandboxIdleTransition::Park,
            message: "final guest exec during park is not supported by this sandbox provider"
                .to_string(),
        })
    }

    /// Run the final guest preparation and park while reporting provider stages.
    ///
    /// This has the same lifecycle and error contract as
    /// [`final_exec_and_park`](Self::final_exec_and_park). The default method
    /// preserves provider behavior and emits no callbacks.
    async fn final_exec_and_park_with_observer(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        _observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<SandboxFinalExecParkOutcome> {
        self.final_exec_and_park(request, diagnostic_label).await
    }

    /// Run final guest preparation and either physically park or transfer a
    /// still-running, fenced sandbox to one already-claimed exact successor.
    ///
    /// The default implementation preserves provider compatibility by fully
    /// parking and never accepting the handoff signal.
    async fn final_exec_and_park_for_handoff(
        &mut self,
        request: &ExecRequest<'_>,
        diagnostic_label: &'static str,
        _handoff: &SandboxFinalExecParkHandoff,
        observer: &mut dyn SandboxFinalExecParkObserver,
    ) -> Result<SandboxFinalExecParkHandoffOutcome> {
        self.final_exec_and_park_with_observer(request, diagnostic_label, observer)
            .await
            .map(SandboxFinalExecParkHandoffOutcome::Parked)
    }

    /// Transition the sandbox back to the active state.
    ///
    /// A successful running handoff also requires this call: finish deflation
    /// and resume Guest operations while leaving already-running vCPUs alone.
    ///
    /// Must be called before any further work is dispatched via `exec` /
    /// `start_process` on a previously parked sandbox. Implementations
    /// should restore whatever state `park()` altered (resume vCPUs,
    /// balloon deflate, respawn background tickers, etc).
    ///
    /// Must be idempotent for a healthy active sandbox: calling `unpark()`
    /// on a sandbox that was never parked — or calling it repeatedly —
    /// returns `Ok(())` without side effects. Implementations may still
    /// return `Err` if lifecycle guards detect that the sandbox is internally
    /// dirty or otherwise not safe to reuse.
    ///
    /// On `Err`, the caller must not dispatch further work to the sandbox.
    /// The sandbox may still be parked, partially unparked, or marked
    /// internally dirty; the lifecycle owner should destroy it, or perform an
    /// explicit retry only when the implementation documents that retry as
    /// safe.
    async fn unpark(&mut self) -> Result<()> {
        Ok(())
    }

    /// Unpark only for terminal guest operations before destroying the sandbox.
    ///
    /// This has the same operation-readiness contract as [`unpark`](Self::unpark),
    /// but providers may omit background work whose only purpose is serving a
    /// future active workload. After this call succeeds, the lifecycle owner
    /// must run only the bounded terminal operations needed to preserve state,
    /// then terminate and destroy the sandbox without returning it to a pool or
    /// binding another run.
    ///
    /// Providers that do not distinguish terminal finalization from normal
    /// reuse preserve compatibility by performing a full unpark.
    async fn unpark_for_terminal_operations(&mut self) -> Result<()> {
        self.unpark().await
    }

    // -- operations --
    //
    // Operations that start new guest work require the sandbox to be running
    // (post-`start`, pre-`stop`/`kill`) and, if it was previously parked,
    // unparked. They use the trait-level backend-crash classification
    // contract documented above.
    //
    // `wait_process` is the exception: it consumes a `GuestProcessHandle` returned by
    // `start_process` and observes that handle's already-started backend exit
    // operation instead of starting new guest work.

    /// Run `request.cmd` in the guest, block until it exits or the
    /// request timeout expires, and return the captured output.
    ///
    /// Returns an error if the sandbox is not running or if the backing
    /// process crashes during execution.
    ///
    /// Implementations must honor the selected capture budget or report
    /// truncation explicitly in [`ExecResult`].
    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult>;

    /// Run [`exec`](Self::exec) with a stable low-cardinality label for
    /// backend diagnostics.
    ///
    /// Labels must describe the operation type, not the raw command. Do not
    /// include user input, environment values, request payloads, or any other
    /// high-cardinality data.
    async fn exec_with_diagnostic_label(
        &self,
        request: &ExecRequest<'_>,
        _label: &'static str,
    ) -> Result<ExecResult> {
        self.exec(request).await
    }

    /// Apply a bounded canonical storage manifest through the provider's fixed
    /// guest helper operation.
    ///
    /// Implementations must preserve helper timeout and cancellation, bounded
    /// stdout/stderr capture, structured termination, and backend-crash
    /// classification. The caller owns any oversized-manifest fallback.
    async fn apply_storage_manifest(
        &self,
        request: &StorageManifestRequest<'_>,
    ) -> Result<ExecResult>;

    /// Mount the fixed workspace drive through the provider's typed guest
    /// operation.
    ///
    /// The provider and guest select the executable, root identity, canonical
    /// workspace path, device, mountinfo source, timeout, output bounds,
    /// containment, and cleanup. Callers supply no operation input.
    async fn mount_workspace_drive(&self) -> Result<ExecResult> {
        Err(SandboxError::Operation {
            operation: crate::SandboxOperation::MountWorkspaceDrive,
            reason: crate::SandboxOperationReason::Other,
            message: "fixed workspace drive mount is unsupported".to_string(),
        })
    }

    /// Verify live final session-history identity through the provider's fixed
    /// Guest Agent helper operation.
    ///
    /// Implementations select the executable and fixed subcommand and must not
    /// expose arbitrary command, environment, sudo, stdin, output, or lifecycle
    /// authority. Helper and transport failures remain ordinary typed results
    /// or sandbox errors for the lifecycle owner to fail closed.
    async fn verify_session_history_identity(
        &self,
        _request: &SessionHistoryIdentityVerifyRequest<'_>,
    ) -> Result<ExecResult> {
        Err(SandboxError::Operation {
            operation: crate::SandboxOperation::VerifySessionHistoryIdentity,
            reason: crate::SandboxOperationReason::Other,
            message: "fixed session history identity verifier is unsupported".to_string(),
        })
    }

    /// Clean retained Codex rollout files through the provider's fixed helper.
    ///
    /// Implementations select the executable and fixed subcommand and must not
    /// expose arbitrary command, environment, sudo, stdin, output, or lifecycle
    /// authority. The result stdout remains untrusted and must be validated by
    /// the session-restore owner before it becomes a write destination.
    async fn cleanup_codex_session(
        &self,
        _request: &CodexSessionCleanupRequest<'_>,
    ) -> Result<ExecResult> {
        Err(SandboxError::Operation {
            operation: crate::SandboxOperation::CleanupCodexSession,
            reason: crate::SandboxOperationReason::Other,
            message: "fixed Codex session cleanup is unsupported".to_string(),
        })
    }

    /// Restore snapshot-sensitive clock, CRNG, and optional timezone state
    /// through the provider's fixed guest helper operation.
    ///
    /// Implementations must preserve helper timeout and cancellation, bounded
    /// stderr capture, structured termination, and backend-crash
    /// classification. The entropy payload is always exactly 256 bytes.
    async fn restore_guest_state(
        &self,
        request: &GuestStateRestoreRequest<'_>,
    ) -> Result<ExecResult>;

    /// Read a small file from the guest.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    /// `max_bytes` must be positive and is subject to the backend read limit.
    ///
    /// Returns `Ok(None)` when the backend's guest-filesystem check cannot
    /// establish that the path resolves to a regular file. This includes
    /// missing paths, paths to non-regular filesystem objects, broken
    /// symlinks, and paths whose guest filesystem metadata cannot be
    /// inspected. Symlinks that resolve to regular files are followed and
    /// read.
    ///
    /// A read that races with a path transition can also return `Ok(None)` if
    /// regular-file status can no longer be established. Invalid input,
    /// guest-operation or capture failures, size-limit violations, and read
    /// failures for a path still established as regular return an error.
    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Option<Vec<u8>>>;

    /// Stream a guest file to a host path and publish copied contents.
    ///
    /// A successful copy creates missing host parent directories as needed and
    /// atomically replaces an existing non-directory destination with a newly
    /// created private regular file. On Unix hosts, the published file has mode
    /// `0o600`. Metadata from an existing destination is not preserved.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    ///
    /// If [`CopyFileOptions::missing_ok`] is enabled, a backend result that
    /// reports the path does not resolve to a regular file is treated as
    /// success with `bytes_copied == 0` without publishing a host file or
    /// replacing an existing host file. Host-side setup and validation errors
    /// can still fail the operation, and setup may leave newly created parent
    /// directories behind.
    ///
    /// Failures before host publication leave an existing destination
    /// unchanged. An error reported after publication does not imply that the
    /// destination was rolled back.
    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> Result<CopyFileResult>;

    /// Write `content` to `path` inside the guest, creating parent
    /// directories and truncating the file as needed. Returns an error if
    /// the sandbox is not running or if the backing process crashes.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;

    /// Write ordinary file bytes using the caller's immutable transport choice.
    /// Implementations must honor it without sampling, switching codecs or retrying raw.
    /// Successful backends with a measured transport return its diagnostics;
    /// backends without a wire transport (such as the mock) return `None`.
    async fn write_file_with_compression(
        &self,
        path: &str,
        content: &[u8],
        compression: FileCompression,
    ) -> Result<Option<FileWriteMeasurements>>;

    /// Write multiple ordinary files inside the guest.
    ///
    /// Each entry has the same semantics as [`write_file`](Self::write_file):
    /// create parent directories, create or truncate the target file, and write
    /// the provided content without sudo or private runtime-file semantics.
    /// Every guest path must be non-empty and must not contain NUL bytes. An
    /// empty batch is accepted as a no-op.
    /// Callers are responsible for bounding the number of files and total
    /// content size. The default implementation preserves compatibility by
    /// writing entries sequentially with [`write_file`](Self::write_file).
    async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        for file in files {
            self.write_file(file.path, file.content).await?;
        }
        Ok(())
    }

    /// Write `content` to a private runtime file inside the guest.
    ///
    /// Implementations should use guest runtime-private semantics: ensure
    /// parent directories are private, reject symlinked parent components, and
    /// write the file with private permissions. Generic workspace file writes
    /// should continue to use [`write_file`](Self::write_file).
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    async fn write_private_file(&self, path: &str, content: &[u8]) -> Result<()>;

    /// Write multiple private runtime files inside the guest.
    ///
    /// Each entry has the same private path, parent, ownership, and permission
    /// semantics as [`write_private_file`](Self::write_private_file). An empty
    /// batch is accepted as a no-op. A later failure can leave earlier entries
    /// complete, but the operation returns an error.
    ///
    /// The default implementation preserves compatibility by writing entries
    /// sequentially with [`write_private_file`](Self::write_private_file).
    async fn write_private_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        for file in files {
            self.write_private_file(file.path, file.content).await?;
        }
        Ok(())
    }

    /// Start `request.cmd` in the guest and return a handle for later
    /// supervision via [`wait_process`](Self::wait_process).
    ///
    /// `request.output` controls whether stdout is buffered into the final
    /// [`ProcessExit`] or streamed in real time through
    /// [`GuestProcessHandle::take_stdout_receiver`]. Callers that take the
    /// receiver are responsible for draining it while the process runs.
    async fn start_process(&self, request: &StartProcessRequest<'_>) -> Result<GuestProcessHandle>;
    /// Start the controlled guest Agent process.
    ///
    /// A successful result always includes process control and timing captured
    /// after the Agent has confirmed runtime placement.
    async fn start_agent_process(
        &self,
        request: &StartAgentProcessRequest<'_>,
    ) -> Result<GuestAgentProcessHandle>;
    /// Wait for the process behind `handle` to exit, up to `timeout`.
    ///
    /// Consumes the handle. If `stdout_rx` was not taken before waiting, the
    /// stream is discarded instead of being buffered without a reader. Returns
    /// an error if the backend exit operation is no longer available, if the
    /// backing process crashes before an exit result is delivered, or if the
    /// timeout elapses before the guest process exits.
    async fn wait_process(
        &self,
        handle: GuestProcessHandle,
        timeout: Duration,
    ) -> Result<ProcessExit>;
}

#[cfg(test)]
mod tests {
    use super::SandboxFinalExecParkHandoff;

    #[test]
    fn final_exec_park_handoff_accepts_only_one_request() {
        let handoff = SandboxFinalExecParkHandoff::new();

        assert!(handoff.request());
        assert!(!handoff.request());
        assert!(handoff.accept_if_requested());
        assert!(!handoff.cancel());
    }

    #[test]
    fn final_exec_park_handoff_cancellation_closes_unaccepted_request() {
        let handoff = SandboxFinalExecParkHandoff::new();

        assert!(handoff.request());
        assert!(handoff.cancel());
        assert!(!handoff.accept_if_requested());
        assert!(!handoff.request());
    }

    #[test]
    fn final_exec_park_handoff_cancellation_closes_before_request() {
        let handoff = SandboxFinalExecParkHandoff::new();

        assert!(handoff.cancel());
        assert!(!handoff.request());
        assert!(!handoff.accept_if_requested());
    }
}
