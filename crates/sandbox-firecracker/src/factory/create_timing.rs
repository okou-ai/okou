use std::fmt;
use std::time::{Duration, Instant};

use nbd_cow::{NbdCowCreateOutcome, NbdCowCreateStage, NbdNetlinkConnectStage};
use sandbox::{
    SandboxCreateStage, SandboxNbdCowCreateOutcome, SandboxNbdCowCreateStage,
    SandboxNbdNetlinkConnectStage,
};
use tracing::{info, warn};

use crate::duration::duration_ms;
use crate::home_drive_image::{HomeDriveImagePrepareObserver, HomeDriveImagePrepareStage};

pub(super) const SLOW_SANDBOX_CREATE_THRESHOLD: Duration = Duration::from_secs(3);

macro_rules! emit_success_summary_event {
    ($emit:ident, $timing:expr, $total_elapsed:expr, $message:literal) => {
        $emit!(
            stage = "sandbox_create",
            total_elapsed_ms = duration_ms($total_elapsed),
            threshold_ms = duration_ms(SLOW_SANDBOX_CREATE_THRESHOLD),
            success = true,
            sandbox_id = ($timing).sandbox_id.as_str(),
            profile = ($timing).profile.as_str(),
            home_drive_present = ($timing).home_drive_present,
            home_seed_image_used = ($timing).home_seed_image_used,
            cow_pool_acquire_ms = ($timing).stage_duration_ms(SandboxCreateStage::CowPoolAcquire),
            workspace_dir_rename_ms =
                ($timing).stage_duration_ms(SandboxCreateStage::WorkspaceDirRename),
            home_drive_prepare_ms =
                ($timing).stage_duration_ms(SandboxCreateStage::HomeDrivePrepare),
            home_seed_sparse_copy_ms =
                ($timing).stage_duration_ms(SandboxCreateStage::HomeSeedSparseCopy),
            home_fresh_format_ms = ($timing).stage_duration_ms(SandboxCreateStage::HomeFreshFormat),
            sock_dir_prepare_ms = ($timing).stage_duration_ms(SandboxCreateStage::SockDirPrepare),
            netns_acquire_ms = ($timing).stage_duration_ms(SandboxCreateStage::NetnsAcquire),
            nbd_cow_create_ms = ($timing).stage_duration_ms(SandboxCreateStage::NbdCowCreate),
            $message
        );
    };
}

const SANDBOX_CREATE_STAGE_COUNT: usize = SandboxCreateStage::ALL.len();

fn sandbox_create_stage_name(stage: SandboxCreateStage) -> &'static str {
    match stage {
        SandboxCreateStage::CowPoolAcquire => "cow_pool_acquire",
        SandboxCreateStage::WorkspaceDirRename => "workspace_dir_rename",
        SandboxCreateStage::HomeDrivePrepare => "home_drive_prepare",
        SandboxCreateStage::HomeSeedSparseCopy => "home_seed_sparse_copy",
        SandboxCreateStage::HomeFreshFormat => "home_fresh_format",
        SandboxCreateStage::SockDirPrepare => "sock_dir_prepare",
        SandboxCreateStage::NetnsAcquire => "netns_acquire",
        SandboxCreateStage::NbdCowCreate => "nbd_cow_create",
    }
}

#[cfg(test)]
fn sandbox_create_stage_summary_field_name(stage: SandboxCreateStage) -> &'static str {
    match stage {
        SandboxCreateStage::CowPoolAcquire => "cow_pool_acquire_ms",
        SandboxCreateStage::WorkspaceDirRename => "workspace_dir_rename_ms",
        SandboxCreateStage::HomeDrivePrepare => "home_drive_prepare_ms",
        SandboxCreateStage::HomeSeedSparseCopy => "home_seed_sparse_copy_ms",
        SandboxCreateStage::HomeFreshFormat => "home_fresh_format_ms",
        SandboxCreateStage::SockDirPrepare => "sock_dir_prepare_ms",
        SandboxCreateStage::NetnsAcquire => "netns_acquire_ms",
        SandboxCreateStage::NbdCowCreate => "nbd_cow_create_ms",
    }
}

struct SandboxCreateStageDurations {
    values: [Option<Duration>; SANDBOX_CREATE_STAGE_COUNT],
}

impl Default for SandboxCreateStageDurations {
    fn default() -> Self {
        Self {
            values: [None; SANDBOX_CREATE_STAGE_COUNT],
        }
    }
}

impl SandboxCreateStageDurations {
    fn set(&mut self, stage: SandboxCreateStage, duration: Duration) {
        *self.slot_mut(stage) = Some(duration);
    }

    fn get(&self, stage: SandboxCreateStage) -> Option<Duration> {
        *self.slot(stage)
    }

    fn slot(&self, stage: SandboxCreateStage) -> &Option<Duration> {
        let [
            cow_pool_acquire,
            workspace_dir_rename,
            home_drive_prepare,
            home_seed_sparse_copy,
            home_fresh_format,
            sock_dir_prepare,
            netns_acquire,
            nbd_cow_create,
        ] = &self.values;
        match stage {
            SandboxCreateStage::CowPoolAcquire => cow_pool_acquire,
            SandboxCreateStage::WorkspaceDirRename => workspace_dir_rename,
            SandboxCreateStage::HomeDrivePrepare => home_drive_prepare,
            SandboxCreateStage::HomeSeedSparseCopy => home_seed_sparse_copy,
            SandboxCreateStage::HomeFreshFormat => home_fresh_format,
            SandboxCreateStage::SockDirPrepare => sock_dir_prepare,
            SandboxCreateStage::NetnsAcquire => netns_acquire,
            SandboxCreateStage::NbdCowCreate => nbd_cow_create,
        }
    }

    fn slot_mut(&mut self, stage: SandboxCreateStage) -> &mut Option<Duration> {
        let [
            cow_pool_acquire,
            workspace_dir_rename,
            home_drive_prepare,
            home_seed_sparse_copy,
            home_fresh_format,
            sock_dir_prepare,
            netns_acquire,
            nbd_cow_create,
        ] = &mut self.values;
        match stage {
            SandboxCreateStage::CowPoolAcquire => cow_pool_acquire,
            SandboxCreateStage::WorkspaceDirRename => workspace_dir_rename,
            SandboxCreateStage::HomeDrivePrepare => home_drive_prepare,
            SandboxCreateStage::HomeSeedSparseCopy => home_seed_sparse_copy,
            SandboxCreateStage::HomeFreshFormat => home_fresh_format,
            SandboxCreateStage::SockDirPrepare => sock_dir_prepare,
            SandboxCreateStage::NetnsAcquire => netns_acquire,
            SandboxCreateStage::NbdCowCreate => nbd_cow_create,
        }
    }
}

pub(crate) struct SandboxCreateTiming<'a> {
    sandbox_id: String,
    profile: String,
    started_at: Instant,
    durations: SandboxCreateStageDurations,
    observer: Option<&'a mut dyn sandbox::SandboxCreateObserver>,
    home_drive_present: bool,
    home_seed_image_used: bool,
    failure_logged: bool,
}

impl<'a> SandboxCreateTiming<'a> {
    pub(super) fn new(
        sandbox_id: String,
        profile: String,
        observer: Option<&'a mut dyn sandbox::SandboxCreateObserver>,
    ) -> Self {
        Self {
            sandbox_id,
            profile,
            started_at: Instant::now(),
            durations: SandboxCreateStageDurations::default(),
            observer,
            home_drive_present: false,
            home_seed_image_used: false,
            failure_logged: false,
        }
    }

    pub(super) fn mark_home_drive_present(&mut self) {
        self.home_drive_present = true;
    }

    pub(super) fn mark_home_seed_image_used(&mut self) {
        self.home_seed_image_used = true;
    }

    pub(super) fn record_stage_result<T, E>(
        &mut self,
        stage: SandboxCreateStage,
        started_at: Instant,
        result: Result<T, E>,
    ) -> Result<T, E>
    where
        E: fmt::Display,
    {
        let elapsed = started_at.elapsed();
        self.record_stage_duration(stage, elapsed);
        match result {
            Ok(value) => {
                self.record_observer_stage(stage, elapsed, true);
                Ok(value)
            }
            Err(error) => {
                self.record_observer_stage(stage, elapsed, false);
                let message = error.to_string();
                self.emit_stage_failure(stage, elapsed, &message);
                Err(error)
            }
        }
    }

    pub(super) fn emit_success_summary(&self) {
        self.emit_success_summary_with_total(self.started_at.elapsed());
    }

    #[cfg(test)]
    pub(super) fn stage_duration_for_test(&self, stage: SandboxCreateStage) -> Option<Duration> {
        self.durations.get(stage)
    }

    fn record_stage_duration(&mut self, stage: SandboxCreateStage, duration: Duration) {
        self.durations.set(stage, duration);
    }

    fn record_observer_stage(
        &mut self,
        stage: SandboxCreateStage,
        duration: Duration,
        success: bool,
    ) {
        let Some(observer) = self.observer.as_deref_mut() else {
            return;
        };
        observer.record_stage(stage, duration, success);
    }

    fn stage_duration_ms(&self, stage: SandboxCreateStage) -> u64 {
        optional_duration_ms(self.durations.get(stage))
    }

    fn emit_stage_failure(&mut self, stage: SandboxCreateStage, elapsed: Duration, error: &str) {
        if self.failure_logged {
            return;
        }
        self.failure_logged = true;
        let safe_error = sanitize_error_for_timing(error);
        warn!(
            stage = sandbox_create_stage_name(stage),
            elapsed_ms = duration_ms(elapsed),
            success = false,
            sandbox_id = self.sandbox_id.as_str(),
            profile = self.profile.as_str(),
            error = safe_error.as_str(),
            "sandbox create stage failed"
        );
    }

    fn emit_success_summary_with_total(&self, total_elapsed: Duration) {
        if total_elapsed < SLOW_SANDBOX_CREATE_THRESHOLD {
            emit_success_summary_event!(info, self, total_elapsed, "sandbox create timing");
            return;
        }
        emit_success_summary_event!(warn, self, total_elapsed, "slow sandbox create");
    }
}

impl nbd_cow::NbdCowCreateObserver for SandboxCreateTiming<'_> {
    fn record_stage(&mut self, stage: NbdCowCreateStage, duration: Duration, success: bool) {
        let Some(observer) = self.observer.as_deref_mut() else {
            return;
        };
        observer.record_nbd_cow_stage(sandbox_nbd_cow_stage(stage), duration, success);
    }

    fn record_netlink_connect_stage(
        &mut self,
        stage: NbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        let Some(observer) = self.observer.as_deref_mut() else {
            return;
        };
        observer.record_nbd_netlink_connect_stage(
            sandbox_nbd_netlink_connect_stage(stage),
            duration,
            success,
        );
    }

    fn record_outcome(&mut self, outcome: NbdCowCreateOutcome) {
        let Some(observer) = self.observer.as_deref_mut() else {
            return;
        };
        observer.record_nbd_cow_outcome(sandbox_nbd_cow_outcome(outcome));
    }
}

fn sandbox_nbd_cow_stage(stage: NbdCowCreateStage) -> SandboxNbdCowCreateStage {
    match stage {
        NbdCowCreateStage::CowLayerCreate => SandboxNbdCowCreateStage::CowLayerCreate,
        NbdCowCreateStage::DeviceAcquire => SandboxNbdCowCreateStage::DeviceAcquire,
        NbdCowCreateStage::DeviceScan => SandboxNbdCowCreateStage::DeviceScan,
        NbdCowCreateStage::DispatchSetup => SandboxNbdCowCreateStage::DispatchSetup,
        NbdCowCreateStage::NetlinkConnect => SandboxNbdCowCreateStage::NetlinkConnect,
        NbdCowCreateStage::SizeVerify => SandboxNbdCowCreateStage::SizeVerify,
        NbdCowCreateStage::RetryCleanup => SandboxNbdCowCreateStage::RetryCleanup,
        NbdCowCreateStage::RetryDelay => SandboxNbdCowCreateStage::RetryDelay,
    }
}

fn sandbox_nbd_netlink_connect_stage(
    stage: NbdNetlinkConnectStage,
) -> SandboxNbdNetlinkConnectStage {
    match stage {
        NbdNetlinkConnectStage::BlockingTaskQueue => {
            SandboxNbdNetlinkConnectStage::BlockingTaskQueue
        }
        NbdNetlinkConnectStage::SocketSetup => SandboxNbdNetlinkConnectStage::SocketSetup,
        NbdNetlinkConnectStage::FamilyResolve => SandboxNbdNetlinkConnectStage::FamilyResolve,
        NbdNetlinkConnectStage::ConnectCommand => SandboxNbdNetlinkConnectStage::ConnectCommand,
    }
}

fn sandbox_nbd_cow_outcome(outcome: NbdCowCreateOutcome) -> SandboxNbdCowCreateOutcome {
    match outcome {
        NbdCowCreateOutcome::AcquireSourceDemandScan => {
            SandboxNbdCowCreateOutcome::AcquireSourceDemandScan
        }
        NbdCowCreateOutcome::AcquireSourceCooledClaim => {
            SandboxNbdCowCreateOutcome::AcquireSourceCooledClaim
        }
        NbdCowCreateOutcome::EbusyRetriesNone => SandboxNbdCowCreateOutcome::EbusyRetriesNone,
        NbdCowCreateOutcome::EbusyRetriesOne => SandboxNbdCowCreateOutcome::EbusyRetriesOne,
        NbdCowCreateOutcome::EbusyRetriesMultiple => {
            SandboxNbdCowCreateOutcome::EbusyRetriesMultiple
        }
        NbdCowCreateOutcome::SizeZeroRetriesNone => SandboxNbdCowCreateOutcome::SizeZeroRetriesNone,
        NbdCowCreateOutcome::SizeZeroRetriesOne => SandboxNbdCowCreateOutcome::SizeZeroRetriesOne,
        NbdCowCreateOutcome::SizeZeroRetriesMultiple => {
            SandboxNbdCowCreateOutcome::SizeZeroRetriesMultiple
        }
    }
}

impl HomeDriveImagePrepareObserver for SandboxCreateTiming<'_> {
    fn mark_home_drive_present(&mut self) {
        SandboxCreateTiming::mark_home_drive_present(self);
    }

    fn mark_home_seed_image_used(&mut self) {
        SandboxCreateTiming::mark_home_seed_image_used(self);
    }

    fn record_stage_result(
        &mut self,
        stage: HomeDriveImagePrepareStage,
        started_at: Instant,
        result: sandbox::Result<()>,
    ) -> sandbox::Result<()> {
        let sandbox_stage = match stage {
            HomeDriveImagePrepareStage::SeedSparseCopy => SandboxCreateStage::HomeSeedSparseCopy,
            HomeDriveImagePrepareStage::FreshFormat => SandboxCreateStage::HomeFreshFormat,
        };
        self.record_stage_result(sandbox_stage, started_at, result)
    }
}

fn optional_duration_ms(duration: Option<Duration>) -> u64 {
    duration.map_or(0, duration_ms)
}

fn sanitize_error_for_timing(error: &str) -> String {
    let first_line = error.lines().next().unwrap_or_default().trim();
    let command_redacted = if let Some((prefix, _)) = first_line.split_once("command failed:") {
        let prefix = prefix.trim_end();
        if prefix.is_empty() {
            "command failed".to_owned()
        } else {
            format!("{prefix} command failed")
        }
    } else {
        first_line.to_owned()
    };
    redact_path_tokens(&command_redacted)
}

fn redact_path_tokens(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            if is_path_like_token(token) {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_path_like_token(token: &str) -> bool {
    let token =
        token.trim_matches(|c: char| matches!(c, ':' | ',' | ';' | ')' | '(' | '"' | '\'' | '`'));
    token.contains('/')
        || token.contains('\\')
        || token.starts_with('.')
        || token.ends_with(".ext4")
        || token.ends_with(".img")
        || token.ends_with(".qcow2")
        || token.ends_with(".raw")
}

#[cfg(test)]
mod tests {
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

        let fast_event =
            capture_success_summary_event(&fast_timing, SLOW_SANDBOX_CREATE_THRESHOLD / 2);
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
            observer.nbd_cow_records.iter().all(|record| {
                record.2 == (record.0 != SandboxNbdCowCreateStage::NetlinkConnect)
            })
        );
        assert_eq!(
            observer
                .nbd_netlink_connect_records
                .iter()
                .map(|record| record.0)
                .collect::<Vec<_>>(),
            SandboxNbdNetlinkConnectStage::ALL,
        );
        assert!(observer.nbd_netlink_connect_records.iter().all(|record| {
            record.2 == (record.0 != SandboxNbdNetlinkConnectStage::FamilyResolve)
        }));
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
}
