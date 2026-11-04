//! Home drive mount and terminal freeze boundaries.
//!
//! The mount helper accepts an existing mount only when `/home/user` is
//! backed by `/dev/vdb`. It rejects symlink path components, unrelated
//! mountpoints, and a home device mounted elsewhere.
//!
//! Home image promotion uses the freeze helper as a terminal consistency
//! boundary. The helper verifies the same path and device identity before it
//! freezes ext4, flushing completed writes and blocking further modifications.
//! A sandbox that crosses this boundary must be stopped and destroyed; it must
//! never be thawed or returned to the idle pool.

use std::time::Duration;

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecResult, Sandbox};
use shell_quote::quote_shell_arg;

use crate::error::{LifecycleError, LifecycleResult};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};

pub const HOME_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const HOME_FREEZE_TIMEOUT: Duration = Duration::from_secs(30);
const HOME_DEVICE: &str = "/dev/vdb";
const HOME_FSFREEZE_PATH: &str = "/usr/sbin/fsfreeze";
const HOME_FREEZE_SCRIPT: &str = include_str!("../scripts/freeze-home-drive.sh");

#[derive(Debug)]
pub struct HomeDriveMountError {
    pub error: LifecycleError,
    pub guest_duration: Option<Duration>,
}

pub async fn ensure_home_drive_mounted(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> Result<Option<Duration>, HomeDriveMountError> {
    let result = sandbox
        .mount_home_drive()
        .await
        .map_err(|error| HomeDriveMountError {
            error: LifecycleError::from(error),
            guest_duration: None,
        })?;
    interpret_home_drive_result(&result, diagnostic_id, "mount home drive")
}

pub async fn freeze_home_drive(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> LifecycleResult<()> {
    run_home_drive_command(
        sandbox,
        diagnostic_id,
        &home_freeze_command(),
        "freeze home drive",
        "home-freeze",
        HOME_FREEZE_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(|error| error.error)
}

async fn run_home_drive_command(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
    cmd: &str,
    operation: &'static str,
    label: &'static str,
    timeout: Duration,
) -> Result<Option<Duration>, HomeDriveMountError> {
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd,
                timeout,
                env: &[],
                sudo: true,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            label,
        )
        .await
        .map_err(|error| HomeDriveMountError {
            error: LifecycleError::from(error),
            guest_duration: None,
        })?;
    interpret_home_drive_result(&result, diagnostic_id, operation)
}

fn interpret_home_drive_result(
    result: &ExecResult,
    diagnostic_id: impl std::fmt::Display,
    operation: &'static str,
) -> Result<Option<Duration>, HomeDriveMountError> {
    let guest_duration = result
        .guest_duration_ms
        .map(|duration_ms| Duration::from_millis(u64::from(duration_ms)));
    if helper_exec_succeeded(result) {
        return Ok(guest_duration);
    }

    let mut message = format_helper_exec_failure(operation, result);
    message.push_str(&format!("; diagnostic id: {diagnostic_id}"));
    Err(HomeDriveMountError {
        error: LifecycleError::Internal(message),
        guest_duration,
    })
}

fn home_freeze_command() -> String {
    home_freeze_command_for("/home/user", HOME_DEVICE, HOME_FSFREEZE_PATH)
}

fn home_freeze_command_for(home_dir: &str, home_device: &str, home_fsfreeze_path: &str) -> String {
    let home_dir = quote_shell_arg(home_dir);
    let home_device = quote_shell_arg(home_device);
    let home_fsfreeze_path = quote_shell_arg(home_fsfreeze_path);
    format!(
        "home_dir={home_dir}\nhome_device={home_device}\nhome_fsfreeze_path={home_fsfreeze_path}\n{HOME_FREEZE_SCRIPT}"
    )
}

#[cfg(test)]
mod tests;
