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
mod tests;
