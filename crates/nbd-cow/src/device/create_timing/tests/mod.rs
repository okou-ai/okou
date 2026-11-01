use super::*;

#[derive(Default)]
struct RecordingObserver {
    stages: Vec<(NbdCowCreateStage, Duration, bool)>,
    netlink_connect_stages: Vec<(NbdNetlinkConnectStage, Duration, bool)>,
    outcomes: Vec<NbdCowCreateOutcome>,
}

impl NbdCowCreateObserver for RecordingObserver {
    fn record_stage(&mut self, stage: NbdCowCreateStage, duration: Duration, success: bool) {
        self.stages.push((stage, duration, success));
    }

    fn record_netlink_connect_stage(
        &mut self,
        stage: NbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        self.netlink_connect_stages.push((stage, duration, success));
    }

    fn record_outcome(&mut self, outcome: NbdCowCreateOutcome) {
        self.outcomes.push(outcome);
    }
}

fn netlink_timing(records: &[(NbdNetlinkConnectStage, u64, bool)]) -> NbdNetlinkConnectTiming {
    let mut timing = NbdNetlinkConnectTiming::default();
    for &(stage, duration_ms, success) in records {
        timing.record_stage_duration(stage, Duration::from_millis(duration_ms), success);
    }
    timing
}

#[test]
fn timing_aggregates_retries_and_deduplicates_sources() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::DeviceAcquire,
        Duration::from_millis(7),
        true,
    );
    timing.record_stage_duration(
        NbdCowCreateStage::DeviceAcquire,
        Duration::from_millis(11),
        true,
    );
    timing.record_acquisition(
        DeviceAcquireSource::DemandScan,
        Some(Duration::from_millis(3)),
    );
    timing.record_acquisition(
        DeviceAcquireSource::DemandScan,
        Some(Duration::from_millis(5)),
    );
    timing.record_acquisition(DeviceAcquireSource::CooledClaim, None);
    timing.record_ebusy_retry();
    timing.record_size_zero_retry();
    timing.record_size_zero_retry();
    timing.finish(true);

    assert_eq!(
        observer.stages,
        vec![
            (
                NbdCowCreateStage::DeviceAcquire,
                Duration::from_millis(18),
                true,
            ),
            (
                NbdCowCreateStage::DeviceScan,
                Duration::from_millis(8),
                true,
            ),
        ]
    );
    assert_eq!(
        observer.outcomes,
        vec![
            NbdCowCreateOutcome::AcquireSourceDemandScan,
            NbdCowCreateOutcome::AcquireSourceCooledClaim,
            NbdCowCreateOutcome::EbusyRetriesOne,
            NbdCowCreateOutcome::SizeZeroRetriesMultiple,
        ]
    );
}

#[test]
fn timing_marks_only_terminal_stage_failed() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::DeviceAcquire,
        Duration::from_millis(4),
        false,
    );
    timing.record_stage_duration(
        NbdCowCreateStage::RetryCleanup,
        Duration::from_millis(2),
        true,
    );
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(6),
        false,
    );
    timing.finish(false);

    assert_eq!(
        observer.stages,
        vec![
            (
                NbdCowCreateStage::DeviceAcquire,
                Duration::from_millis(4),
                true,
            ),
            (
                NbdCowCreateStage::NetlinkConnect,
                Duration::from_millis(6),
                false,
            ),
            (
                NbdCowCreateStage::RetryCleanup,
                Duration::from_millis(2),
                true,
            ),
        ]
    );
    assert_eq!(
        observer.outcomes,
        vec![
            NbdCowCreateOutcome::EbusyRetriesNone,
            NbdCowCreateOutcome::SizeZeroRetriesNone,
        ]
    );
}

#[test]
fn netlink_timing_aggregates_recovered_attempts_once() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(17),
        false,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[
        (NbdNetlinkConnectStage::BlockingTaskQueue, 2, true),
        (NbdNetlinkConnectStage::SocketSetup, 3, true),
        (NbdNetlinkConnectStage::FamilyResolve, 5, true),
        (NbdNetlinkConnectStage::ConnectCommand, 7, false),
    ]));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(60),
        true,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[
        (NbdNetlinkConnectStage::BlockingTaskQueue, 11, true),
        (NbdNetlinkConnectStage::SocketSetup, 13, true),
        (NbdNetlinkConnectStage::FamilyResolve, 17, true),
        (NbdNetlinkConnectStage::ConnectCommand, 19, true),
    ]));
    timing.finish(true);

    assert_eq!(
        observer.netlink_connect_stages,
        vec![
            (
                NbdNetlinkConnectStage::BlockingTaskQueue,
                Duration::from_millis(13),
                true,
            ),
            (
                NbdNetlinkConnectStage::SocketSetup,
                Duration::from_millis(16),
                true,
            ),
            (
                NbdNetlinkConnectStage::FamilyResolve,
                Duration::from_millis(22),
                true,
            ),
            (
                NbdNetlinkConnectStage::ConnectCommand,
                Duration::from_millis(26),
                true,
            ),
        ]
    );
}

#[test]
fn netlink_timing_marks_only_latest_terminal_child_failed() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(17),
        false,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[
        (NbdNetlinkConnectStage::BlockingTaskQueue, 2, true),
        (NbdNetlinkConnectStage::SocketSetup, 3, true),
        (NbdNetlinkConnectStage::FamilyResolve, 5, true),
        (NbdNetlinkConnectStage::ConnectCommand, 7, false),
    ]));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(49),
        false,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[
        (NbdNetlinkConnectStage::BlockingTaskQueue, 11, true),
        (NbdNetlinkConnectStage::SocketSetup, 13, true),
        (NbdNetlinkConnectStage::FamilyResolve, 17, false),
    ]));
    timing.finish(false);

    assert_eq!(
        observer.netlink_connect_stages,
        vec![
            (
                NbdNetlinkConnectStage::BlockingTaskQueue,
                Duration::from_millis(13),
                true,
            ),
            (
                NbdNetlinkConnectStage::SocketSetup,
                Duration::from_millis(16),
                true,
            ),
            (
                NbdNetlinkConnectStage::FamilyResolve,
                Duration::from_millis(22),
                false,
            ),
            (
                NbdNetlinkConnectStage::ConnectCommand,
                Duration::from_millis(7),
                true,
            ),
        ]
    );
}

#[test]
fn netlink_timing_clears_recovered_child_before_childless_failure() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(7),
        false,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[(
        NbdNetlinkConnectStage::ConnectCommand,
        7,
        false,
    )]));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(1),
        false,
    );
    timing.record_netlink_connect_timing(NbdNetlinkConnectTiming::default());
    timing.finish(false);

    assert_eq!(
        observer.netlink_connect_stages,
        vec![(
            NbdNetlinkConnectStage::ConnectCommand,
            Duration::from_millis(7),
            true,
        )]
    );
}

#[test]
fn netlink_timing_keeps_children_successful_for_other_terminal_parent() {
    let mut observer = RecordingObserver::default();
    let mut timing = NbdCowCreateTiming::new(Some(&mut observer));
    timing.record_stage_duration(
        NbdCowCreateStage::NetlinkConnect,
        Duration::from_millis(7),
        false,
    );
    timing.record_netlink_connect_timing(netlink_timing(&[(
        NbdNetlinkConnectStage::ConnectCommand,
        7,
        false,
    )]));
    timing.record_stage_duration(
        NbdCowCreateStage::SizeVerify,
        Duration::from_millis(5),
        false,
    );
    timing.finish(false);

    assert_eq!(
        observer.netlink_connect_stages,
        vec![(
            NbdNetlinkConnectStage::ConnectCommand,
            Duration::from_millis(7),
            true,
        )]
    );
}
