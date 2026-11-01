use std::time::{Duration, Instant};

use crate::pool::DeviceAcquireSource;

const NBD_COW_CREATE_STAGE_COUNT: usize = NbdCowCreateStage::ALL.len();
const NBD_NETLINK_CONNECT_STAGE_COUNT: usize = NbdNetlinkConnectStage::ALL.len();

/// Fixed aggregate stages inside one NBD COW device creation.
///
/// Repeated attempts contribute to one duration per entered stage. A nested
/// stage overlaps its parent and must not be added to the parent as independent
/// time. [`Self::DeviceScan`] is nested inside [`Self::DeviceAcquire`], and
/// [`NbdNetlinkConnectStage`] records are nested inside
/// [`Self::NetlinkConnect`]. Every other stage is a peer contribution to the
/// enclosing NBD create operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdCowCreateStage {
    /// Constructs the copy-on-write storage layer for the device.
    CowLayerCreate,
    /// Waits for a device lease from the NBD device pool.
    ///
    /// A demand scan, when needed, occurs inside this stage and is also
    /// reported as [`Self::DeviceScan`].
    DeviceAcquire,
    /// Scans host NBD devices during a demand-based device acquisition.
    ///
    /// This duration is nested inside [`Self::DeviceAcquire`] and is not
    /// entered when a cooled device claim satisfies the acquisition.
    DeviceScan,
    /// Creates the socket pairs and starts the request-dispatch tasks for an
    /// NBD connect attempt.
    DispatchSetup,
    /// Connects the prepared sockets to the claimed kernel NBD device through
    /// generic netlink.
    ///
    /// [`NbdNetlinkConnectStage`] records provide nested details for this
    /// stage.
    NetlinkConnect,
    /// Verifies the kernel-reported device size after a successful connect.
    SizeVerify,
    /// Cleans up after a retryable `EBUSY` connect or zero-size verification.
    RetryCleanup,
    /// Waits before retrying a device whose reported size was zero.
    RetryDelay,
}

impl NbdCowCreateStage {
    /// All stages in stable emission order.
    ///
    /// An observer receives only the stages entered by a create operation.
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

/// Fixed aggregate stages nested inside
/// [`NbdCowCreateStage::NetlinkConnect`].
///
/// Repeated connect attempts contribute to one duration per entered stage.
/// These durations overlap the enclosing netlink-connect duration and must not
/// be added to it as independent time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdNetlinkConnectStage {
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

impl NbdNetlinkConnectStage {
    /// All netlink-connect stages in stable emission order.
    ///
    /// An observer receives only the stages entered by at least one connect
    /// attempt.
    pub const ALL: [Self; 4] = [
        Self::BlockingTaskQueue,
        Self::SocketSetup,
        Self::FamilyResolve,
        Self::ConnectCommand,
    ];
}

/// Fixed low-cardinality outcome signals for one NBD COW device creation.
///
/// This enum contains three independent signal families rather than one
/// mutually exclusive result. Acquisition-source variants are deduplicated
/// presence signals: an ordinary completed create can emit neither, either, or
/// both of them. When both are present, [`Self::AcquireSourceDemandScan`]
/// precedes [`Self::AcquireSourceCooledClaim`]. Exactly one `EBUSY` retry bucket
/// and one size-zero retry bucket are emitted after every ordinary success or
/// error, including their `None` variants.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NbdCowCreateOutcome {
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

/// Receives aggregate timing and bounded outcomes for one NBD COW create.
///
/// Stage records are buffered until creation reaches an ordinary success or
/// error. Retry work is accumulated into one contribution per entered stage
/// instead of emitting one sample per attempt. The observer first receives
/// entered [`NbdCowCreateStage`] records in [`NbdCowCreateStage::ALL`] order,
/// then entered [`NbdNetlinkConnectStage`] records in
/// [`NbdNetlinkConnectStage::ALL`] order. Present acquisition-source outcomes
/// follow, then the `EBUSY` retry bucket, then the size-zero retry bucket. This
/// callback grouping is not chronological: nested durations overlap their
/// parents.
///
/// If the create eventually succeeds, every aggregate stage is successful even
/// when it includes a recovered failed attempt. If the create returns an error,
/// only a stage attributed as the terminal failure is unsuccessful. Dropping or
/// cancelling the create future before it returns discards the buffered records
/// and does not invoke observer code from `Drop`.
pub trait NbdCowCreateObserver: Send {
    /// Records one entered aggregate NBD create stage.
    ///
    /// - `stage` identifies the measured operation.
    /// - `duration` is the saturating sum of all attempts that entered it.
    /// - `success` is `false` only when this stage is attributed as the
    ///   terminal failure of an unsuccessful create. It does not indicate that
    ///   every contributing attempt succeeded.
    ///
    /// This required callback is invoked at most once per entered stage when
    /// the create reaches an ordinary success or error.
    fn record_stage(&mut self, stage: NbdCowCreateStage, duration: Duration, success: bool);

    /// Records one entered aggregate stage nested inside netlink connect.
    ///
    /// - `stage` identifies the measured netlink operation.
    /// - `duration` is the saturating sum of all connect attempts that entered
    ///   it.
    /// - `success` is `false` only when netlink connect is the terminal failed
    ///   parent and the terminal connect attempt attributes failure to this
    ///   child. A childless terminal attempt leaves earlier child aggregates
    ///   successful.
    ///
    /// This callback is invoked at most once per entered stage. Its duration is
    /// nested inside [`NbdCowCreateStage::NetlinkConnect`]. The default
    /// implementation intentionally ignores the nested detail so existing
    /// observers only interested in parent stages remain valid.
    fn record_netlink_connect_stage(
        &mut self,
        _stage: NbdNetlinkConnectStage,
        _duration: Duration,
        _success: bool,
    ) {
    }

    /// Records one acquisition-source presence signal or retry bucket.
    ///
    /// `outcome` identifies the presence signal or bucket. This required
    /// callback follows the stage callbacks. See [`NbdCowCreateOutcome`] for
    /// the independent signal families and their cardinality.
    fn record_outcome(&mut self, outcome: NbdCowCreateOutcome);
}

#[derive(Clone, Copy, Default)]
struct StageTiming {
    duration: Duration,
    entered: bool,
}

#[derive(Default)]
pub(crate) struct NbdNetlinkConnectTiming {
    stages: [StageTiming; NBD_NETLINK_CONNECT_STAGE_COUNT],
    failed_stage: Option<NbdNetlinkConnectStage>,
}

impl NbdNetlinkConnectTiming {
    pub(crate) fn record_stage(
        &mut self,
        stage: NbdNetlinkConnectStage,
        started_at: Instant,
        success: bool,
    ) {
        self.record_stage_duration(stage, started_at.elapsed(), success);
    }

    pub(crate) fn record_stage_duration(
        &mut self,
        stage: NbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        let timing = self.stage_mut(stage);
        timing.duration = timing.duration.saturating_add(duration);
        timing.entered = true;
        if !success {
            self.failed_stage = Some(stage);
        }
    }

    fn stage(&self, stage: NbdNetlinkConnectStage) -> StageTiming {
        let [
            blocking_task_queue,
            socket_setup,
            family_resolve,
            connect_command,
        ] = &self.stages;
        *match stage {
            NbdNetlinkConnectStage::BlockingTaskQueue => blocking_task_queue,
            NbdNetlinkConnectStage::SocketSetup => socket_setup,
            NbdNetlinkConnectStage::FamilyResolve => family_resolve,
            NbdNetlinkConnectStage::ConnectCommand => connect_command,
        }
    }

    fn stage_mut(&mut self, stage: NbdNetlinkConnectStage) -> &mut StageTiming {
        let [
            blocking_task_queue,
            socket_setup,
            family_resolve,
            connect_command,
        ] = &mut self.stages;
        match stage {
            NbdNetlinkConnectStage::BlockingTaskQueue => blocking_task_queue,
            NbdNetlinkConnectStage::SocketSetup => socket_setup,
            NbdNetlinkConnectStage::FamilyResolve => family_resolve,
            NbdNetlinkConnectStage::ConnectCommand => connect_command,
        }
    }
}

pub(super) struct NbdCowCreateTiming<'a> {
    observer: Option<&'a mut dyn NbdCowCreateObserver>,
    stages: [StageTiming; NBD_COW_CREATE_STAGE_COUNT],
    failed_stage: Option<NbdCowCreateStage>,
    netlink_connect_stages: [StageTiming; NBD_NETLINK_CONNECT_STAGE_COUNT],
    failed_netlink_connect_stage: Option<NbdNetlinkConnectStage>,
    used_demand_scan: bool,
    used_cooled_claim: bool,
    ebusy_retries: u32,
    size_zero_retries: u32,
}

impl<'a> NbdCowCreateTiming<'a> {
    pub(super) fn new(observer: Option<&'a mut dyn NbdCowCreateObserver>) -> Self {
        Self {
            observer,
            stages: [StageTiming::default(); NBD_COW_CREATE_STAGE_COUNT],
            failed_stage: None,
            netlink_connect_stages: [StageTiming::default(); NBD_NETLINK_CONNECT_STAGE_COUNT],
            failed_netlink_connect_stage: None,
            used_demand_scan: false,
            used_cooled_claim: false,
            ebusy_retries: 0,
            size_zero_retries: 0,
        }
    }

    pub(super) fn record_stage(
        &mut self,
        stage: NbdCowCreateStage,
        started_at: Instant,
        success: bool,
    ) {
        self.record_stage_duration(stage, started_at.elapsed(), success);
    }

    pub(super) fn record_stage_duration(
        &mut self,
        stage: NbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        let timing = self.stage_mut(stage);
        timing.duration = timing.duration.saturating_add(duration);
        timing.entered = true;
        if !success {
            self.failed_stage = Some(stage);
        }
    }

    pub(super) fn record_acquisition(
        &mut self,
        source: DeviceAcquireSource,
        scan_duration: Option<Duration>,
    ) {
        match source {
            DeviceAcquireSource::DemandScan => self.used_demand_scan = true,
            DeviceAcquireSource::CooledClaim => self.used_cooled_claim = true,
        }
        if let Some(duration) = scan_duration {
            self.record_stage_duration(NbdCowCreateStage::DeviceScan, duration, true);
        }
    }

    pub(super) fn record_netlink_connect_timing(&mut self, timing: NbdNetlinkConnectTiming) {
        for stage in NbdNetlinkConnectStage::ALL {
            let attempt_timing = timing.stage(stage);
            if !attempt_timing.entered {
                continue;
            }

            let aggregate_timing = self.netlink_connect_stage_mut(stage);
            aggregate_timing.duration = aggregate_timing
                .duration
                .saturating_add(attempt_timing.duration);
            aggregate_timing.entered = true;
        }

        // Failure attribution belongs to the latest connect attempt. Clearing
        // a recovered or childless attempt prevents an earlier retry failure
        // from being reported as the terminal child.
        self.failed_netlink_connect_stage = timing.failed_stage;
    }

    pub(super) fn record_ebusy_retry(&mut self) {
        self.ebusy_retries = self.ebusy_retries.saturating_add(1);
    }

    pub(super) fn record_size_zero_retry(&mut self) {
        self.size_zero_retries = self.size_zero_retries.saturating_add(1);
    }

    pub(super) fn finish(mut self, create_success: bool) {
        let Some(observer) = self.observer.take() else {
            return;
        };

        for stage in NbdCowCreateStage::ALL {
            let timing = self.stage(stage);
            if !timing.entered {
                continue;
            }
            observer.record_stage(
                stage,
                timing.duration,
                create_success || self.failed_stage != Some(stage),
            );
        }

        let failed_netlink_connect_stage =
            if !create_success && self.failed_stage == Some(NbdCowCreateStage::NetlinkConnect) {
                self.failed_netlink_connect_stage
            } else {
                None
            };
        for stage in NbdNetlinkConnectStage::ALL {
            let timing = self.netlink_connect_stage(stage);
            if !timing.entered {
                continue;
            }
            observer.record_netlink_connect_stage(
                stage,
                timing.duration,
                failed_netlink_connect_stage != Some(stage),
            );
        }

        if self.used_demand_scan {
            observer.record_outcome(NbdCowCreateOutcome::AcquireSourceDemandScan);
        }
        if self.used_cooled_claim {
            observer.record_outcome(NbdCowCreateOutcome::AcquireSourceCooledClaim);
        }
        observer.record_outcome(ebusy_retry_outcome(self.ebusy_retries));
        observer.record_outcome(size_zero_retry_outcome(self.size_zero_retries));
    }

    fn stage(&self, stage: NbdCowCreateStage) -> StageTiming {
        let [
            cow_layer_create,
            device_acquire,
            device_scan,
            dispatch_setup,
            netlink_connect,
            size_verify,
            retry_cleanup,
            retry_delay,
        ] = &self.stages;
        *match stage {
            NbdCowCreateStage::CowLayerCreate => cow_layer_create,
            NbdCowCreateStage::DeviceAcquire => device_acquire,
            NbdCowCreateStage::DeviceScan => device_scan,
            NbdCowCreateStage::DispatchSetup => dispatch_setup,
            NbdCowCreateStage::NetlinkConnect => netlink_connect,
            NbdCowCreateStage::SizeVerify => size_verify,
            NbdCowCreateStage::RetryCleanup => retry_cleanup,
            NbdCowCreateStage::RetryDelay => retry_delay,
        }
    }

    fn stage_mut(&mut self, stage: NbdCowCreateStage) -> &mut StageTiming {
        let [
            cow_layer_create,
            device_acquire,
            device_scan,
            dispatch_setup,
            netlink_connect,
            size_verify,
            retry_cleanup,
            retry_delay,
        ] = &mut self.stages;
        match stage {
            NbdCowCreateStage::CowLayerCreate => cow_layer_create,
            NbdCowCreateStage::DeviceAcquire => device_acquire,
            NbdCowCreateStage::DeviceScan => device_scan,
            NbdCowCreateStage::DispatchSetup => dispatch_setup,
            NbdCowCreateStage::NetlinkConnect => netlink_connect,
            NbdCowCreateStage::SizeVerify => size_verify,
            NbdCowCreateStage::RetryCleanup => retry_cleanup,
            NbdCowCreateStage::RetryDelay => retry_delay,
        }
    }

    fn netlink_connect_stage(&self, stage: NbdNetlinkConnectStage) -> StageTiming {
        let [
            blocking_task_queue,
            socket_setup,
            family_resolve,
            connect_command,
        ] = &self.netlink_connect_stages;
        *match stage {
            NbdNetlinkConnectStage::BlockingTaskQueue => blocking_task_queue,
            NbdNetlinkConnectStage::SocketSetup => socket_setup,
            NbdNetlinkConnectStage::FamilyResolve => family_resolve,
            NbdNetlinkConnectStage::ConnectCommand => connect_command,
        }
    }

    fn netlink_connect_stage_mut(&mut self, stage: NbdNetlinkConnectStage) -> &mut StageTiming {
        let [
            blocking_task_queue,
            socket_setup,
            family_resolve,
            connect_command,
        ] = &mut self.netlink_connect_stages;
        match stage {
            NbdNetlinkConnectStage::BlockingTaskQueue => blocking_task_queue,
            NbdNetlinkConnectStage::SocketSetup => socket_setup,
            NbdNetlinkConnectStage::FamilyResolve => family_resolve,
            NbdNetlinkConnectStage::ConnectCommand => connect_command,
        }
    }
}

fn ebusy_retry_outcome(count: u32) -> NbdCowCreateOutcome {
    match count {
        0 => NbdCowCreateOutcome::EbusyRetriesNone,
        1 => NbdCowCreateOutcome::EbusyRetriesOne,
        _ => NbdCowCreateOutcome::EbusyRetriesMultiple,
    }
}

fn size_zero_retry_outcome(count: u32) -> NbdCowCreateOutcome {
    match count {
        0 => NbdCowCreateOutcome::SizeZeroRetriesNone,
        1 => NbdCowCreateOutcome::SizeZeroRetriesOne,
        _ => NbdCowCreateOutcome::SizeZeroRetriesMultiple,
    }
}

#[cfg(test)]
mod tests;
