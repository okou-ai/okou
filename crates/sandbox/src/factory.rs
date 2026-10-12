use async_trait::async_trait;
use std::time::Duration;

use crate::config::SandboxConfig;
use crate::error::Result;
use crate::sandbox::Sandbox;

/// Low-cardinality stages inside sandbox factory creation.
///
/// A provider can report only the stages that apply to its implementation. The
/// home seed-copy and fresh-format stages are nested inside home
/// drive preparation, and all NBD detail stages are nested inside NBD COW
/// creation. Nested durations overlap their parent and must not be added to it
/// as independent time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxCreateStage {
    /// Acquires a prepared COW file and connected device from the provider pool.
    CowPoolAcquire,
    /// Moves prepared COW backing files into the sandbox workspace.
    WorkspaceDirRename,
    /// Prepares the configured home drive image.
    ///
    /// [`Self::HomeSeedSparseCopy`] and
    /// [`Self::HomeFreshFormat`] are optional nested details.
    HomeDrivePrepare,
    /// Copies a home seed image while preserving sparse regions.
    ///
    /// This duration is nested inside [`Self::HomeDrivePrepare`].
    HomeSeedSparseCopy,
    /// Formats a newly allocated, unseeded home drive image.
    ///
    /// This duration is nested inside [`Self::HomeDrivePrepare`].
    HomeFreshFormat,
    /// Prepares the sandbox runtime socket directory.
    SockDirPrepare,
    /// Acquires a network namespace from the provider pool.
    NetnsAcquire,
    /// Creates the pooled NBD copy-on-write device for the sandbox.
    ///
    /// [`SandboxNbdCowCreateStage`] records are nested details of this stage.
    /// Providers that prepare connected devices in a background pool may omit
    /// this request-path stage.
    NbdCowCreate,
}

impl SandboxCreateStage {
    /// All create stages in stable catalog order.
    ///
    /// This order is used by typed mappings and tests. It does not define a
    /// universal provider callback sequence.
    pub const ALL: [Self; 8] = [
        Self::CowPoolAcquire,
        Self::WorkspaceDirRename,
        Self::HomeDrivePrepare,
        Self::HomeSeedSparseCopy,
        Self::HomeFreshFormat,
        Self::SockDirPrepare,
        Self::NetnsAcquire,
        Self::NbdCowCreate,
    ];
}

/// Fixed aggregate NBD COW details nested under
/// [`SandboxCreateStage::NbdCowCreate`].
///
/// Repeated attempts contribute to one duration per entered stage.
/// [`Self::DeviceScan`] is nested inside [`Self::DeviceAcquire`], and
/// [`SandboxNbdNetlinkConnectStage`] records are nested inside
/// [`Self::NetlinkConnect`]. Nested durations overlap their parent and must not
/// be added to it as independent time. Every other duration is a peer
/// contribution to the NBD create parent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdCowCreateStage {
    /// Constructs the copy-on-write storage layer for the device.
    CowLayerCreate,
    /// Waits for a device lease from the NBD device pool.
    ///
    /// A demand scan, when needed, occurs inside this stage and is also
    /// reported as [`Self::DeviceScan`].
    DeviceAcquire,
    /// Scans host NBD devices during a demand-based device acquisition.
    ///
    /// This duration is nested inside [`Self::DeviceAcquire`] and is absent
    /// when a cooled device claim satisfies the acquisition.
    DeviceScan,
    /// Creates the socket pairs and starts the request-dispatch tasks for an
    /// NBD connect attempt.
    DispatchSetup,
    /// Connects the prepared sockets to the claimed kernel NBD device through
    /// generic netlink.
    ///
    /// [`SandboxNbdNetlinkConnectStage`] records are nested details of this
    /// stage.
    NetlinkConnect,
    /// Verifies the kernel-reported device size after a successful connect.
    SizeVerify,
    /// Cleans up after a retryable `EBUSY` connect or zero-size verification.
    RetryCleanup,
    /// Waits before retrying a device whose reported size was zero.
    RetryDelay,
}

impl SandboxNbdCowCreateStage {
    /// All NBD COW detail stages in stable catalog order.
    ///
    /// A provider's observer contract determines which stages are emitted.
    pub const ALL: [Self; 8] = [
        Self::CowLayerCreate,
        Self::DeviceAcquire,
        Self::DeviceScan,
        Self::DispatchSetup,
        Self::NetlinkConnect,
        Self::SizeVerify,
        Self::RetryCleanup,
        Self::RetryDelay,
    ];
}

/// Fixed aggregate details nested under
/// [`SandboxNbdCowCreateStage::NetlinkConnect`].
///
/// Repeated connect attempts contribute to one duration per entered stage.
/// These durations overlap the enclosing netlink-connect duration and must not
/// be added to it as independent time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdNetlinkConnectStage {
    /// Waits from submission of the blocking connect work until that work
    /// begins executing.
    BlockingTaskQueue,
    /// Validates the socket set and opens and configures the generic-netlink
    /// socket.
    SocketSetup,
    /// Resolves the NBD generic-netlink family.
    FamilyResolve,
    /// Builds, sends, and waits for completion of the NBD connect command.
    ConnectCommand,
}

impl SandboxNbdNetlinkConnectStage {
    /// All NBD netlink-connect stages in stable catalog order.
    ///
    /// A provider's observer contract determines which stages are emitted.
    pub const ALL: [Self; 4] = [
        Self::BlockingTaskQueue,
        Self::SocketSetup,
        Self::FamilyResolve,
        Self::ConnectCommand,
    ];
}

/// Fixed low-cardinality NBD COW outcome signals for sandbox-create telemetry.
///
/// This enum contains three independent signal families rather than one
/// mutually exclusive result. Acquisition-source variants are deduplicated
/// presence signals: an ordinary completed NBD create can emit neither, either,
/// or both. When both are present in the aggregate batch,
/// [`Self::AcquireSourceDemandScan`] precedes
/// [`Self::AcquireSourceCooledClaim`]. A provider that reports the aggregate
/// NBD outcome batch emits exactly one `EBUSY` retry bucket and one size-zero
/// retry bucket, including their `None` variants.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxNbdCowCreateOutcome {
    /// At least one device acquisition used an on-demand device scan.
    AcquireSourceDemandScan,
    /// At least one device acquisition reused a claim after its cooldown.
    AcquireSourceCooledClaim,
    /// No connect retry followed an `EBUSY` result.
    EbusyRetriesNone,
    /// Exactly one connect retry followed an `EBUSY` result.
    EbusyRetriesOne,
    /// Two or more connect retries followed `EBUSY` results.
    EbusyRetriesMultiple,
    /// No retry followed a zero-size device verification.
    SizeZeroRetriesNone,
    /// Exactly one retry followed a zero-size device verification.
    SizeZeroRetriesOne,
    /// Two or more retries followed zero-size device verifications.
    SizeZeroRetriesMultiple,
}

/// Receives optional low-cardinality sandbox factory create telemetry.
///
/// Factories choose which applicable boundaries they expose; the default
/// [`SandboxFactory::create_with_observer`] implementation invokes no
/// callbacks. Consumers must not assume that every stage is present or that
/// [`SandboxCreateStage::ALL`] defines callback arrival order.
///
/// The Firecracker provider reports completed outer stages as they finish, so
/// cancellation can leave a partial set of outer records. It forwards NBD
/// detail and outcome callbacks only after NBD creation reaches an ordinary
/// success or error: entered NBD parent stages in
/// [`SandboxNbdCowCreateStage::ALL`] order, entered netlink children in
/// [`SandboxNbdNetlinkConnectStage::ALL`] order, then outcomes. Those NBD
/// durations aggregate retries, and their callback order is grouping rather
/// than chronology. Cancelling NBD creation before it reaches an ordinary
/// result emits no NBD detail or outcome batch, and cleanup `Drop` paths invoke
/// no observer callbacks. No nested duration is independent of its parent.
pub trait SandboxCreateObserver: Send {
    /// Records one completed outer sandbox-create stage.
    ///
    /// - `stage` identifies the provider operation.
    /// - `duration` measures that single outer operation.
    /// - `success` reports that operation's result, not the final result of the
    ///   complete sandbox create. Earlier successful stages can precede a later
    ///   create failure.
    ///
    /// A provider invokes this required callback at most once for each outer
    /// boundary it exposes. Cancellation can leave completed callbacks without
    /// a complete create-stage sequence.
    fn record_stage(&mut self, stage: SandboxCreateStage, duration: Duration, success: bool);

    /// Records one entered aggregate NBD COW detail stage.
    ///
    /// - `stage` identifies the measured NBD operation.
    /// - `duration` is the saturating sum across attempts.
    /// - `success` is `false` only when `stage` is attributed as the terminal
    ///   failure of an unsuccessful NBD create; it is not the result of every
    ///   contributing attempt.
    ///
    /// An eventually successful create reports recovered attempt failures as
    /// successful. The callback is invoked at most once per entered stage, and
    /// its duration is nested inside
    /// [`SandboxCreateStage::NbdCowCreate`].
    ///
    /// The default implementation intentionally ignores NBD detail records.
    fn record_nbd_cow_stage(
        &mut self,
        _stage: SandboxNbdCowCreateStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    /// Records one entered aggregate stage nested inside NBD netlink connect.
    ///
    /// - `stage` identifies the measured netlink operation.
    /// - `duration` is the saturating sum across connect attempts.
    /// - `success` is `false` only when netlink connect is the terminal failed
    ///   NBD parent and its terminal attempt attributes failure to `stage`; a
    ///   childless terminal attempt leaves earlier child aggregates successful.
    ///
    /// The callback is invoked at most once per entered stage.
    ///
    /// The default implementation intentionally ignores nested netlink detail.
    fn record_nbd_netlink_connect_stage(
        &mut self,
        _stage: SandboxNbdNetlinkConnectStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    /// Records one acquisition-source presence signal or retry bucket.
    ///
    /// `outcome` identifies the presence signal or bucket. See
    /// [`SandboxNbdCowCreateOutcome`] for the independent signal families and
    /// their cardinality. The default implementation intentionally ignores NBD
    /// outcomes.
    fn record_nbd_cow_outcome(&mut self, _outcome: SandboxNbdCowCreateOutcome) {}
}

/// Creates and owns the normal teardown path for sandboxes in one profile.
///
/// A factory is the per-profile object produced by
/// [`SandboxRuntime`](crate::SandboxRuntime) from a
/// [`FactoryConfig`](crate::FactoryConfig). It converts per-sandbox
/// [`SandboxConfig`] values into provider-specific [`Sandbox`] instances and
/// owns the normal explicit cleanup path for those instances.
///
/// # Lifecycle
///
/// Callers normally create a runtime, ask it for one or more factories, create
/// sandboxes through those factories, release each sandbox with
/// [`destroy`](Self::destroy), shut down each factory with
/// [`shutdown`](Self::shutdown), and only then shut down the runtime that
/// created the factories.
///
/// Dropping a sandbox may provide backend-specific emergency leak cleanup, but
/// it is not the normal lifecycle path and must not be treated as evidence that
/// explicit factory teardown completed successfully.
///
/// # Sharing and shutdown
///
/// Factories are `Send + Sync` so runner lifecycle code can share trait
/// objects across async tasks while sandboxes are active. Final shutdown still
/// requires `&mut self`, so callers that wrap a factory in shared ownership
/// must first stop concurrent use and recover exclusive ownership.
#[async_trait]
pub trait SandboxFactory: Send + Sync {
    /// Human-readable name for this factory implementation (e.g. "firecracker").
    fn name(&self) -> &str;
    /// Deterministic hash of internal configuration that affects snapshot output.
    ///
    /// Used by the runner to build a composite cache key for pre-warmed
    /// snapshots. The hash covers boot args, guest network parameters, and
    /// any other factory-specific settings baked into the snapshot. It must not
    /// include random values or secrets.
    fn config_hash(&self) -> String;
    /// Create a new sandbox instance with the given per-sandbox configuration.
    ///
    /// If `config` uses [`crate::HomeDriveSeedImage::Move`], this method
    /// may return an error after source ownership has transferred to the
    /// provider. Callers must not infer source availability from the final
    /// result.
    ///
    /// The returned sandbox belongs to this factory's lifecycle and should be
    /// released through [`destroy`](Self::destroy) on the normal teardown path.
    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>>;
    /// Create a sandbox while reporting create-stage timings to `observer`.
    ///
    /// Seed-image ownership and failure semantics match [`Self::create`].
    ///
    /// Implementations can report only the boundaries applicable to their
    /// provider. Callers must not assume a complete callback set after an error
    /// or cancellation. The default implementation preserves existing factory
    /// behavior by calling [`Self::create`] and ignoring `observer`.
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        _observer: &mut dyn SandboxCreateObserver,
    ) -> Result<Box<dyn Sandbox>> {
        self.create(config).await
    }

    /// Explicitly tear down a sandbox created by this factory.
    ///
    /// This is the normal resource-release path for sandbox-owned provider
    /// resources such as processes, devices, directories, and factory pools.
    async fn destroy(&self, sandbox: Box<dyn Sandbox>);
    /// Release all factory-level resources.
    ///
    /// Requires exclusive ownership: callers sharing via `Arc` must
    /// first recover ownership (e.g. `Arc::try_unwrap`) after all
    /// concurrent users have been dropped.
    async fn shutdown(&mut self);
}
