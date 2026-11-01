use std::collections::BTreeSet;
use std::time::Duration;

use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

use super::*;

#[derive(Default)]
struct RecordingCreateObserver {
    records: Vec<(sandbox::SandboxCreateStage, Duration, bool)>,
    nbd_cow_records: Vec<(sandbox::SandboxNbdCowCreateStage, Duration, bool)>,
    nbd_netlink_connect_records: Vec<(sandbox::SandboxNbdNetlinkConnectStage, Duration, bool)>,
    nbd_cow_outcomes: Vec<sandbox::SandboxNbdCowCreateOutcome>,
}

impl sandbox::SandboxCreateObserver for RecordingCreateObserver {
    fn record_stage(
        &mut self,
        stage: sandbox::SandboxCreateStage,
        duration: Duration,
        success: bool,
    ) {
        self.records.push((stage, duration, success));
    }

    fn record_nbd_cow_stage(
        &mut self,
        stage: sandbox::SandboxNbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        self.nbd_cow_records.push((stage, duration, success));
    }

    fn record_nbd_netlink_connect_stage(
        &mut self,
        stage: sandbox::SandboxNbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        self.nbd_netlink_connect_records
            .push((stage, duration, success));
    }

    fn record_nbd_cow_outcome(&mut self, outcome: sandbox::SandboxNbdCowCreateOutcome) {
        self.nbd_cow_outcomes.push(outcome);
    }
}

const SUCCESS_SUMMARY_FIELD_NAMES: &[&str] = &[
    "cow_pool_acquire_ms",
    "message",
    "nbd_cow_create_ms",
    "netns_acquire_ms",
    "profile",
    "sandbox_id",
    "sock_dir_prepare_ms",
    "stage",
    "success",
    "threshold_ms",
    "total_elapsed_ms",
    "workspace_dir_rename_ms",
    "home_drive_prepare_ms",
    "home_drive_present",
    "home_fresh_format_ms",
    "home_seed_image_used",
    "home_seed_sparse_copy_ms",
];

const SUCCESS_SUMMARY_STAGE_FIELDS: &[(SandboxCreateStage, &str)] = &[
    (SandboxCreateStage::CowPoolAcquire, "cow_pool_acquire_ms"),
    (
        SandboxCreateStage::WorkspaceDirRename,
        "workspace_dir_rename_ms",
    ),
    (
        SandboxCreateStage::HomeDrivePrepare,
        "home_drive_prepare_ms",
    ),
    (
        SandboxCreateStage::HomeSeedSparseCopy,
        "home_seed_sparse_copy_ms",
    ),
    (SandboxCreateStage::HomeFreshFormat, "home_fresh_format_ms"),
    (SandboxCreateStage::SockDirPrepare, "sock_dir_prepare_ms"),
    (SandboxCreateStage::NetnsAcquire, "netns_acquire_ms"),
    (SandboxCreateStage::NbdCowCreate, "nbd_cow_create_ms"),
];

fn capture_events(action: impl FnOnce()) -> Vec<CapturedEvent> {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    tracing::subscriber::with_default(subscriber, action);
    captured.entries()
}

fn capture_success_summary_event(
    timing: &SandboxCreateTiming,
    total_elapsed: Duration,
) -> CapturedEvent {
    let events = capture_events(|| {
        timing.emit_success_summary_with_total(total_elapsed);
    });
    assert_eq!(events.len(), 1, "events: {events:#?}");
    events
        .into_iter()
        .next()
        .expect("success summary event should be captured")
}

fn event_field_names(event: &CapturedEvent) -> BTreeSet<&str> {
    event.fields.keys().map(String::as_str).collect()
}

fn assert_success_summary_field_names(event: &CapturedEvent) {
    let expected: BTreeSet<&str> = SUCCESS_SUMMARY_FIELD_NAMES.iter().copied().collect();
    let actual = event_field_names(event);
    assert_eq!(actual, expected, "field names mismatch; event={event:#?}");
}

fn assert_field(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .fields
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
    assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
}

fn assert_field_kind(event: &CapturedEvent, field: &str, expected: &str) {
    let actual = event
        .field_kinds
        .get(field)
        .unwrap_or_else(|| panic!("missing field kind {field}; event={event:#?}"));
    assert_eq!(
        actual, &expected,
        "field kind {field} mismatch; event={event:#?}"
    );
}

fn assert_success_summary_representative_field_kinds(event: &CapturedEvent) {
    assert_field_kind(event, "stage", "str");
    assert_field_kind(event, "total_elapsed_ms", "u64");
    assert_field_kind(event, "success", "bool");
}

#[test]
fn success_summary_contract_includes_every_stage_field() {
    assert_eq!(
        SUCCESS_SUMMARY_STAGE_FIELDS.len(),
        SANDBOX_CREATE_STAGE_COUNT
    );
    let stage_fields: BTreeSet<&str> = SUCCESS_SUMMARY_STAGE_FIELDS
        .iter()
        .map(|(_, field)| *field)
        .collect();

    assert_eq!(stage_fields.len(), SANDBOX_CREATE_STAGE_COUNT);
    for stage in SandboxCreateStage::ALL {
        let Some((_, field)) = SUCCESS_SUMMARY_STAGE_FIELDS
            .iter()
            .find(|(candidate, _)| *candidate == stage)
        else {
            panic!("missing success summary field contract for {stage:?}");
        };
        assert_eq!(sandbox_create_stage_summary_field_name(stage), *field);
        assert!(
            SUCCESS_SUMMARY_FIELD_NAMES.contains(field),
            "missing success summary field for {stage:?}"
        );
    }
}

#[test]
fn fast_success_emits_info_summary() {
    let timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);

    let event = capture_success_summary_event(&timing, SLOW_SANDBOX_CREATE_THRESHOLD / 2);

    assert_eq!(event.level, Level::INFO);
    assert_success_summary_field_names(&event);
    assert_success_summary_representative_field_kinds(&event);
    assert_field(&event, "message", "sandbox create timing");
    assert_field(&event, "stage", "sandbox_create");
    assert_field(&event, "success", "true");
    assert_field(&event, "sandbox_id", "sandbox-1");
    assert_field(&event, "profile", "vm0/default");
    assert_field(&event, "total_elapsed_ms", "1500");
    assert_field(&event, "threshold_ms", "3000");
    assert_field(&event, "home_drive_present", "false");
    assert_field(&event, "home_seed_image_used", "false");
    assert_field(&event, "cow_pool_acquire_ms", "0");
    assert_field(&event, "workspace_dir_rename_ms", "0");
    assert_field(&event, "home_drive_prepare_ms", "0");
    assert_field(&event, "home_seed_sparse_copy_ms", "0");
    assert_field(&event, "home_fresh_format_ms", "0");
    assert_field(&event, "sock_dir_prepare_ms", "0");
    assert_field(&event, "netns_acquire_ms", "0");
    assert_field(&event, "nbd_cow_create_ms", "0");
}

#[test]
fn success_summary_fast_and_slow_field_sets_match() {
    let fast_timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);
    let slow_timing = SandboxCreateTiming::new("sandbox-2".into(), "vm0/default".into(), None);

    let fast_event = capture_success_summary_event(&fast_timing, SLOW_SANDBOX_CREATE_THRESHOLD / 2);
    let slow_event = capture_success_summary_event(&slow_timing, SLOW_SANDBOX_CREATE_THRESHOLD);

    assert_eq!(
        event_field_names(&fast_event),
        event_field_names(&slow_event),
        "fast and slow success summary fields should stay in sync"
    );
}

#[test]
fn slow_success_emits_summary_with_stable_fields() {
    let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);
    timing.mark_home_drive_present();
    timing.mark_home_seed_image_used();
    for (index, (stage, _)) in SUCCESS_SUMMARY_STAGE_FIELDS.iter().copied().enumerate() {
        let duration_ms = (index as u64 + 1) * 10;
        timing.record_stage_duration(stage, Duration::from_millis(duration_ms));
    }

    let event = capture_success_summary_event(&timing, SLOW_SANDBOX_CREATE_THRESHOLD);

    assert_eq!(event.level, Level::WARN);
    assert_success_summary_field_names(&event);
    assert_success_summary_representative_field_kinds(&event);
    assert_field(&event, "message", "slow sandbox create");
    assert_field(&event, "stage", "sandbox_create");
    assert_field(&event, "success", "true");
    assert_field(&event, "sandbox_id", "sandbox-1");
    assert_field(&event, "profile", "vm0/default");
    assert_field(&event, "total_elapsed_ms", "3000");
    assert_field(&event, "threshold_ms", "3000");
    assert_field(&event, "home_drive_present", "true");
    assert_field(&event, "home_seed_image_used", "true");
    for (index, (_, field)) in SUCCESS_SUMMARY_STAGE_FIELDS.iter().copied().enumerate() {
        let expected = ((index as u64 + 1) * 10).to_string();
        assert_field(&event, field, &expected);
    }
}

#[test]
fn success_summary_saturates_large_durations() {
    let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);
    timing.record_stage_duration(SandboxCreateStage::CowPoolAcquire, Duration::MAX);

    let event = capture_success_summary_event(&timing, Duration::MAX);

    assert_eq!(event.level, Level::WARN);
    assert_field(&event, "message", "slow sandbox create");
    assert_field(&event, "total_elapsed_ms", &u64::MAX.to_string());
    assert_field(&event, "cow_pool_acquire_ms", &u64::MAX.to_string());
    assert_field(&event, "threshold_ms", "3000");
}

#[test]
fn home_drive_image_observer_maps_to_sandbox_create_timing() {
    let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);

    HomeDriveImagePrepareObserver::mark_home_drive_present(&mut timing);
    HomeDriveImagePrepareObserver::mark_home_seed_image_used(&mut timing);
    HomeDriveImagePrepareObserver::record_stage_result(
        &mut timing,
        HomeDriveImagePrepareStage::SeedSparseCopy,
        Instant::now(),
        Ok(()),
    )
    .unwrap();
    HomeDriveImagePrepareObserver::record_stage_result(
        &mut timing,
        HomeDriveImagePrepareStage::FreshFormat,
        Instant::now(),
        Ok(()),
    )
    .unwrap();

    assert!(timing.home_drive_present);
    assert!(timing.home_seed_image_used);
    assert!(
        timing
            .stage_duration_for_test(SandboxCreateStage::HomeSeedSparseCopy)
            .is_some()
    );
    assert!(
        timing
            .stage_duration_for_test(SandboxCreateStage::HomeFreshFormat)
            .is_some()
    );
}

#[test]
fn stage_results_forward_to_external_observer() {
    let mut observer = RecordingCreateObserver::default();
    {
        let mut timing = SandboxCreateTiming::new(
            "sandbox-1".into(),
            "vm0/default".into(),
            Some(&mut observer),
        );
        for stage in SandboxCreateStage::ALL {
            timing
                .record_stage_result(stage, Instant::now(), Ok::<(), &str>(()))
                .unwrap();
        }
    }

    let stages: Vec<_> = observer.records.iter().map(|record| record.0).collect();
    assert_eq!(
        stages,
        vec![
            sandbox::SandboxCreateStage::CowPoolAcquire,
            sandbox::SandboxCreateStage::WorkspaceDirRename,
            sandbox::SandboxCreateStage::HomeDrivePrepare,
            sandbox::SandboxCreateStage::HomeSeedSparseCopy,
            sandbox::SandboxCreateStage::HomeFreshFormat,
            sandbox::SandboxCreateStage::SockDirPrepare,
            sandbox::SandboxCreateStage::NetnsAcquire,
            sandbox::SandboxCreateStage::NbdCowCreate,
        ]
    );
    assert!(observer.records.iter().all(|record| record.2));
}

#[test]
fn nbd_cow_details_map_to_external_observer() {
    let mut observer = RecordingCreateObserver::default();
    {
        let mut timing = SandboxCreateTiming::new(
            "sandbox-1".into(),
            "vm0/default".into(),
            Some(&mut observer),
        );
        for stage in NbdCowCreateStage::ALL {
            nbd_cow::NbdCowCreateObserver::record_stage(
                &mut timing,
                stage,
                Duration::from_millis(5),
                stage != NbdCowCreateStage::NetlinkConnect,
            );
        }
        for stage in NbdNetlinkConnectStage::ALL {
            nbd_cow::NbdCowCreateObserver::record_netlink_connect_stage(
                &mut timing,
                stage,
                Duration::from_millis(3),
                stage != NbdNetlinkConnectStage::FamilyResolve,
            );
        }
        for outcome in [
            NbdCowCreateOutcome::AcquireSourceDemandScan,
            NbdCowCreateOutcome::AcquireSourceCooledClaim,
            NbdCowCreateOutcome::EbusyRetriesNone,
            NbdCowCreateOutcome::EbusyRetriesOne,
            NbdCowCreateOutcome::EbusyRetriesMultiple,
            NbdCowCreateOutcome::SizeZeroRetriesNone,
            NbdCowCreateOutcome::SizeZeroRetriesOne,
            NbdCowCreateOutcome::SizeZeroRetriesMultiple,
        ] {
            nbd_cow::NbdCowCreateObserver::record_outcome(&mut timing, outcome);
        }
    }

    assert_eq!(
        observer
            .nbd_cow_records
            .iter()
            .map(|record| record.0)
            .collect::<Vec<_>>(),
        SandboxNbdCowCreateStage::ALL,
    );
    assert!(
        observer
            .nbd_cow_records
            .iter()
            .all(|record| { record.2 == (record.0 != SandboxNbdCowCreateStage::NetlinkConnect) })
    );
    assert_eq!(
        observer
            .nbd_netlink_connect_records
            .iter()
            .map(|record| record.0)
            .collect::<Vec<_>>(),
        SandboxNbdNetlinkConnectStage::ALL,
    );
    assert!(
        observer.nbd_netlink_connect_records.iter().all(|record| {
            record.2 == (record.0 != SandboxNbdNetlinkConnectStage::FamilyResolve)
        })
    );
    assert_eq!(
        observer.nbd_cow_outcomes,
        vec![
            SandboxNbdCowCreateOutcome::AcquireSourceDemandScan,
            SandboxNbdCowCreateOutcome::AcquireSourceCooledClaim,
            SandboxNbdCowCreateOutcome::EbusyRetriesNone,
            SandboxNbdCowCreateOutcome::EbusyRetriesOne,
            SandboxNbdCowCreateOutcome::EbusyRetriesMultiple,
            SandboxNbdCowCreateOutcome::SizeZeroRetriesNone,
            SandboxNbdCowCreateOutcome::SizeZeroRetriesOne,
            SandboxNbdCowCreateOutcome::SizeZeroRetriesMultiple,
        ],
    );
}

#[test]
fn failed_stage_result_forwards_failure_to_external_observer() {
    let mut observer = RecordingCreateObserver::default();
    {
        let mut timing = SandboxCreateTiming::new(
            "sandbox-1".into(),
            "vm0/default".into(),
            Some(&mut observer),
        );
        let result =
            timing.record_stage_result(SandboxCreateStage::NbdCowCreate, Instant::now(), {
                Err::<(), _>("nbd failed")
            });
        assert!(result.is_err());
    }

    let [(stage, _duration, success)] = observer.records.as_slice() else {
        panic!("expected one observer record, got {:?}", observer.records);
    };
    assert_eq!(*stage, sandbox::SandboxCreateStage::NbdCowCreate);
    assert!(!success);
}

#[test]
fn stage_failure_emits_warning_once() {
    let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);

    let events = capture_events(|| {
        timing.emit_stage_failure(
            SandboxCreateStage::HomeSeedSparseCopy,
            Duration::from_millis(25),
            "copy failed",
        );
        timing.emit_stage_failure(
            SandboxCreateStage::HomeDrivePrepare,
            Duration::from_millis(30),
            "outer failed",
        );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_eq!(event.level, Level::WARN);
    assert_field(event, "message", "sandbox create stage failed");
    assert_field(event, "stage", "home_seed_sparse_copy");
    assert_field(event, "elapsed_ms", "25");
    assert_field(event, "success", "false");
    assert_field(event, "sandbox_id", "sandbox-1");
    assert_field(event, "profile", "vm0/default");
    assert_field(event, "error", "copy failed");
}

#[test]
fn stage_failure_redacts_paths_and_command_argv() {
    let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into(), None);

    let events = capture_events(|| {
        timing.emit_stage_failure(
                SandboxCreateStage::HomeSeedSparseCopy,
                Duration::from_millis(25),
                "sandbox sandbox allocation initialization failed: copy home seed image: command failed: cp --sparse=always -- /tmp/source.ext4 /tmp/target.ext4\nsecret stderr",
            );
    });

    assert_eq!(events.len(), 1, "events: {events:#?}");
    let event = &events[0];
    assert_field(
        event,
        "error",
        "sandbox sandbox allocation initialization failed: copy home seed image: command failed",
    );
    assert!(!event.fields["error"].contains("/tmp"), "event={event:#?}");
    assert!(!event.fields["error"].contains("cp --"), "event={event:#?}");
    assert!(
        !event.fields["error"].contains("secret stderr"),
        "event={event:#?}"
    );
}

#[test]
fn stage_failure_redacts_command_argv_without_prefix() {
    let error = sanitize_error_for_timing("command failed: cp /tmp/source /tmp/target");

    assert_eq!(error, "command failed");
}

#[test]
fn stage_failure_redacts_path_tokens() {
    let error = sanitize_error_for_timing(
        "home seed image size mismatch for /tmp/seed.ext4: expected 1 bytes, got 0 bytes",
    );

    assert_eq!(
        error,
        "home seed image size mismatch for <path> expected 1 bytes, got 0 bytes"
    );
}

#[test]
fn stage_failure_redacts_relative_image_path_tokens() {
    let error = sanitize_error_for_timing(
        "home seed image size mismatch for seed.ext4: expected 1 bytes, got 0 bytes",
    );

    assert_eq!(
        error,
        "home seed image size mismatch for <path> expected 1 bytes, got 0 bytes"
    );
}
