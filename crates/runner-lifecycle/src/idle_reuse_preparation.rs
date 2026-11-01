//! Guest cleanup and rootfs admission policy before idle parking.

use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use guest_contracts::guest_binary::AGENT_PATH;
use guest_contracts::home_mount::HOME_MOUNT_PATH;
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED, REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
    REUSE_PREPARATION_EXIT_INVALID_REQUEST, ReusePreparationReport, ReusePreparationRequest,
};
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult, ExecTermination};
use tracing::{info, warn};

use crate::helper_exec::{
    format_helper_exec_failure, helper_exec_succeeded, helper_exec_termination_label,
};
use crate::home_mount::HOME_MOUNT_TIMEOUT;
use runner_types::ids::RunId;

const REUSE_PREPARATION_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_REUSE_ROOTFS_AVAILABLE_BYTES: u64 = 128 * 1024 * 1024;
const MIN_REUSE_ROOTFS_AVAILABLE_INODES: u64 = 1024;

#[derive(Clone, Copy)]
enum ReuseRejectionReason {
    InvalidRequest,
    InspectionFailed,
    CleanupFailed,
    ContainmentFailed,
    HomeMountFailed,
    HelperFailed,
    InvalidReport,
    LowBytes,
    LowInodes,
    LowBytesAndInodes,
}

impl ReuseRejectionReason {
    const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InspectionFailed => "inspection_failed",
            Self::CleanupFailed => "cleanup_failed",
            Self::ContainmentFailed => "containment_failed",
            Self::HomeMountFailed => "home_mount_failed",
            Self::HelperFailed => "helper_failed",
            Self::InvalidReport => "invalid_report",
            Self::LowBytes => "low_bytes",
            Self::LowInodes => "low_inodes",
            Self::LowBytesAndInodes => "low_bytes_and_inodes",
        }
    }
}

#[derive(Debug)]
pub struct IdleReusePreparationFailure {
    error: String,
    expected_capacity_rejection: bool,
}

impl std::fmt::Display for IdleReusePreparationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.error)
    }
}

impl IdleReusePreparationFailure {
    pub fn is_expected_capacity_rejection(&self) -> bool {
        self.expected_capacity_rejection
    }
}

pub struct IdleReusePreparation {
    operation_run_id: RunId,
    sandbox_id: String,
    command: String,
    request_bytes: Vec<u8>,
}

impl IdleReusePreparation {
    pub fn new(
        sandbox_id: &str,
        operation_run_id: RunId,
        current_runtime_run_id: RunId,
        retained_runtime_dir: Option<&str>,
    ) -> Result<Self, IdleReusePreparationFailure> {
        let current_runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(
            CANONICAL_GUEST_HOME_DIR,
            &current_runtime_run_id.to_string(),
        )
        .map_err(|error| {
            reject_without_exec(
                sandbox_id,
                operation_run_id,
                ReuseRejectionReason::InvalidRequest,
                format!("resolve current runtime directory: {error}"),
            )
        })?
        .to_string_lossy()
        .into_owned();
        let request = ReusePreparationRequest {
            current_runtime_dir,
            retained_runtime_dir: retained_runtime_dir.map(str::to_owned),
        };
        let request_bytes = serde_json::to_vec(&request).map_err(|error| {
            reject_without_exec(
                sandbox_id,
                operation_run_id,
                ReuseRejectionReason::InvalidRequest,
                format!("serialize reuse-preparation request: {error}"),
            )
        })?;
        let helper_command = format!("{AGENT_PATH} prepare-for-reuse");
        let command = compose_reuse_preparation_command(&helper_command, HOME_MOUNT_PATH);
        Ok(Self {
            operation_run_id,
            sandbox_id: sandbox_id.to_owned(),
            command,
            request_bytes,
        })
    }

    pub fn exec_request(&self) -> ExecRequest<'_> {
        ExecRequest {
            cmd: &self.command,
            timeout: REUSE_PREPARATION_TIMEOUT + HOME_MOUNT_TIMEOUT,
            env: &[],
            sudo: true,
            expected_exit_codes: &[],
            stdin_bytes: Some(&self.request_bytes),
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        }
    }

    pub fn validate_result(
        &self,
        result: &ExecResult,
    ) -> Result<ReusePreparationReport, IdleReusePreparationFailure> {
        if !helper_exec_succeeded(result) {
            let reason = helper_failure_reason(result);
            return Err(reject_with_result(
                &self.sandbox_id,
                self.operation_run_id,
                reason,
                result,
                format_helper_exec_failure("reuse preparation", result),
            ));
        }

        let report =
            serde_json::from_slice::<ReusePreparationReport>(&result.stdout).map_err(|error| {
                reject_with_result(
                    &self.sandbox_id,
                    self.operation_run_id,
                    ReuseRejectionReason::InvalidReport,
                    result,
                    format!("reuse preparation returned an invalid report: {error}"),
                )
            })?;
        let low_bytes = report.after.available_bytes < MIN_REUSE_ROOTFS_AVAILABLE_BYTES;
        if let Some(reason) = report.home.home_rejection_reason() {
            log_report(
                &self.sandbox_id,
                self.operation_run_id,
                reason,
                result,
                report,
                false,
            );
            return Err(IdleReusePreparationFailure {
                error: format!(
                    "guest home below reuse reserve: {} bytes and {} inodes available",
                    report.home.available_bytes, report.home.available_inodes
                ),
                expected_capacity_rejection: true,
            });
        }
        let low_inodes = report.after.available_inodes < MIN_REUSE_ROOTFS_AVAILABLE_INODES;
        if low_bytes || low_inodes {
            let reason = if low_bytes && low_inodes {
                ReuseRejectionReason::LowBytesAndInodes
            } else if low_bytes {
                ReuseRejectionReason::LowBytes
            } else {
                ReuseRejectionReason::LowInodes
            };
            log_report(
                &self.sandbox_id,
                self.operation_run_id,
                reason.as_str(),
                result,
                report,
                false,
            );
            return Err(IdleReusePreparationFailure {
                error: format!(
                    "guest rootfs below reuse reserve: {} bytes and {} inodes available",
                    report.after.available_bytes, report.after.available_inodes
                ),
                expected_capacity_rejection: true,
            });
        }

        log_report(
            &self.sandbox_id,
            self.operation_run_id,
            "ready",
            result,
            report,
            true,
        );
        Ok(report)
    }
}

fn compose_reuse_preparation_command(helper_command: &str, mount_command: &str) -> String {
    format!(
        "set +e\n(\nset -eu\n{mount_command}\n) </dev/null >/dev/null\nmount_status=$?\nset -e\nif [ \"$mount_status\" -ne 0 ]; then\n  exit {REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED}\nfi\n{helper_command}"
    )
}

#[cfg(any(test, feature = "test-support"))]
pub fn healthy_reuse_preparation_report() -> ReusePreparationReport {
    use guest_contracts::reuse_preparation::FilesystemCapacity;

    ReusePreparationReport {
        before: FilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
        after: FilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
        removed_entries: 0,
        home: FilesystemCapacity {
            available_bytes: 256 * 1024 * 1024,
            available_inodes: 2048,
        },
    }
}

#[cfg(any(test, feature = "test-support"))]
pub fn add_healthy_reuse_preparation_matcher(overrides: &sandbox_mock::MockSandboxOverrides) {
    overrides.add_persistent_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".to_string(),
        exit_code: 0,
        stdout: serde_json::to_vec(&healthy_reuse_preparation_report()).unwrap(),
        stderr: Vec::new(),
    });
}

#[cfg(any(test, feature = "test-support"))]
pub fn mock_sandbox_ready_for_idle_reuse(name: impl Into<String>) -> sandbox_mock::MockSandbox {
    let overrides = std::sync::Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    sandbox_mock::MockSandbox::with_overrides(name, overrides)
}

fn helper_failure_reason(result: &ExecResult) -> ReuseRejectionReason {
    match result.termination {
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_INVALID_REQUEST,
        } => ReuseRejectionReason::InvalidRequest,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
        } => ReuseRejectionReason::InspectionFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        } => ReuseRejectionReason::CleanupFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
        } => ReuseRejectionReason::ContainmentFailed,
        ExecTermination::Exited {
            exit_code: REUSE_PREPARATION_EXIT_HOME_MOUNT_FAILED,
        } => ReuseRejectionReason::HomeMountFailed,
        ExecTermination::Exited { .. }
        | ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => ReuseRejectionReason::HelperFailed,
    }
}

fn reject_without_exec(
    sandbox_id: &str,
    run_id: RunId,
    reason: ReuseRejectionReason,
    error: String,
) -> IdleReusePreparationFailure {
    warn!(
        run_id = %run_id,
        sandbox_id,
        reason = reason.as_str(),
        error = %error,
        "sandbox rejected from idle reuse"
    );
    IdleReusePreparationFailure {
        error,
        expected_capacity_rejection: false,
    }
}

fn reject_with_result(
    sandbox_id: &str,
    run_id: RunId,
    reason: ReuseRejectionReason,
    result: &ExecResult,
    error: String,
) -> IdleReusePreparationFailure {
    warn!(
        run_id = %run_id,
        sandbox_id,
        reason = reason.as_str(),
        helper_termination = helper_exec_termination_label(result),
        helper_stdout_len = result.stdout.len(),
        helper_stderr_len = result.stderr.len(),
        helper_stdout_truncated = result.stdout_truncated,
        helper_stderr_truncated = result.stderr_truncated,
        error = %error,
        "sandbox rejected from idle reuse"
    );
    IdleReusePreparationFailure {
        error,
        expected_capacity_rejection: false,
    }
}

fn log_report(
    sandbox_id: &str,
    run_id: RunId,
    reason: &'static str,
    result: &ExecResult,
    report: ReusePreparationReport,
    ready: bool,
) {
    let reclaimed_bytes = report
        .after
        .available_bytes
        .saturating_sub(report.before.available_bytes);
    let reclaimed_inodes = report
        .after
        .available_inodes
        .saturating_sub(report.before.available_inodes);
    if ready {
        info!(
            run_id = %run_id,
            sandbox_id,
            reason,
            helper_termination = helper_exec_termination_label(result),
            removed_entries = report.removed_entries,
            before_available_bytes = report.before.available_bytes,
            after_available_bytes = report.after.available_bytes,
            home_available_bytes = report.home.available_bytes,
            home_available_inodes = report.home.available_inodes,
            reclaimed_bytes,
            before_available_inodes = report.before.available_inodes,
            after_available_inodes = report.after.available_inodes,
            reclaimed_inodes,
            "sandbox prepared for idle reuse"
        );
    } else {
        info!(
            run_id = %run_id,
            sandbox_id,
            reason,
            helper_termination = helper_exec_termination_label(result),
            removed_entries = report.removed_entries,
            before_available_bytes = report.before.available_bytes,
            after_available_bytes = report.after.available_bytes,
            home_available_bytes = report.home.available_bytes,
            home_available_inodes = report.home.available_inodes,
            reclaimed_bytes,
            before_available_inodes = report.before.available_inodes,
            after_available_inodes = report.after.available_inodes,
            reclaimed_inodes,
            "sandbox rejected from idle reuse"
        );
    }
}

#[cfg(test)]
mod tests;
