//! Guest state repair helpers used before agent execution.

use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, GuestStateRestoreRequest,
    GuestStateRestoreTimezone, Sandbox,
};

use super::{DEFAULT_EXEC_TIMEOUT, RunnerError, RunnerResult};
use crate::guest_timezone::{GuestTimezoneIntent, is_shell_safe_name};
use crate::helper_exec::{
    format_command_output_excerpt, format_helper_exec_failure, helper_exec_succeeded,
    helper_exec_termination_label,
};
use runner_types::ids::RunId;
use runner_types::types::ExecutionContext;

const ENTROPY_SIZE: usize = 256;
const TIMEZONE_SYNC_MODE_ARG: &str = "--sync-timezone";
const TIMEZONE_SYNC_FAILED_MARKER: &str = "guest timezone sync failed";
const TIMEZONE_UNAVAILABLE_MARKER: &str = "guest timezone unavailable";

#[derive(Clone, Copy)]
enum GuestTimezone<'a> {
    BestEffort { name: &'a str, run_id: RunId },
    Required { name: &'a str },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuestTimezoneSyncOutcome {
    Applied,
    Unavailable,
    Failed,
    NotRequested,
}

fn helper_exec_exit_code(result: &sandbox::ExecResult) -> Option<i32> {
    match result.termination {
        ExecTermination::Exited { exit_code } => Some(exit_code),
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => None,
    }
}

fn host_unix_timestamp() -> std::time::Duration {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
}

fn read_host_entropy() -> RunnerResult<[u8; ENTROPY_SIZE]> {
    use std::io::Read;

    let mut entropy = [0u8; ENTROPY_SIZE];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut entropy))
        .map_err(|e| RunnerError::Internal(format!("read host entropy: {e}")))?;
    Ok(entropy)
}

pub fn is_shell_safe_guest_timezone_name(tz: &str) -> bool {
    is_shell_safe_name(tz)
}

fn timezone_sync_command(tz: &str) -> String {
    format!(
        "{} {TIMEZONE_SYNC_MODE_ARG} {tz}",
        guest_contracts::guest_binary::STATE_RESTORE_PATH
    )
}

fn stderr_contains_marker(result: &sandbox::ExecResult, marker: &str) -> bool {
    result
        .stderr
        .windows(marker.len())
        .any(|window| window == marker.as_bytes())
}

fn classify_timezone_sync_result(result: &sandbox::ExecResult) -> GuestTimezoneSyncOutcome {
    if !helper_exec_succeeded(result) || stderr_contains_marker(result, TIMEZONE_SYNC_FAILED_MARKER)
    {
        GuestTimezoneSyncOutcome::Failed
    } else if stderr_contains_marker(result, TIMEZONE_UNAVAILABLE_MARKER) {
        GuestTimezoneSyncOutcome::Unavailable
    } else {
        GuestTimezoneSyncOutcome::Applied
    }
}

fn log_timezone_sync_failure(
    run_id: RunId,
    tz: &str,
    result: &sandbox::ExecResult,
    outcome: GuestTimezoneSyncOutcome,
) {
    if matches!(
        outcome,
        GuestTimezoneSyncOutcome::Applied | GuestTimezoneSyncOutcome::NotRequested
    ) {
        return;
    }
    let stderr_excerpt =
        format_command_output_excerpt("stderr", &result.stderr, result.stderr_truncated);
    let stdout_excerpt =
        format_command_output_excerpt("stdout", &result.stdout, result.stdout_truncated);
    let exit_code = if helper_exec_succeeded(result) {
        None
    } else {
        helper_exec_exit_code(result)
    };
    if let Some(exit_code) = exit_code {
        tracing::warn!(
            run_id = %run_id,
            tz = %tz,
            termination = helper_exec_termination_label(result),
            exit_code,
            stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
            stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
            "failed to set guest timezone"
        );
    } else {
        tracing::warn!(
            run_id = %run_id,
            tz = %tz,
            termination = helper_exec_termination_label(result),
            stderr_excerpt = %stderr_excerpt.as_deref().unwrap_or(""),
            stdout_excerpt = %stdout_excerpt.as_deref().unwrap_or(""),
            "failed to set guest timezone"
        );
    }
}

/// Restores snapshot-sensitive guest state in one fixed operation before the
/// agent starts.
///
/// On ARM64 with kernel 6.1, VMGenID does not work (the driver only supports
/// ACPI; DeviceTree support requires kernel 6.10+). All VMs restored from the
/// same snapshot share identical CRNG state, producing identical random output.
///
/// This syncs the frozen guest clock, injects fresh host entropy, and folds in
/// best-effort system timezone sync when a user timezone is configured. The
/// entropy step ensures each VM produces unique random numbers from the first
/// `getrandom()` call.
pub(crate) async fn restore_guest_state(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
) -> RunnerResult<()> {
    let intent = GuestTimezoneIntent::from_context(context);
    if matches!(intent, GuestTimezoneIntent::Unknown) {
        tracing::warn!(run_id = %context.run_id, "rejected unsafe timezone name");
    }
    let timezone = intent.guest_name().map(|name| GuestTimezone::BestEffort {
        name,
        run_id: context.run_id,
    });
    restore_guest_state_inner(sandbox, timezone).await
}

pub async fn restore_guest_state_with_intent(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    intent: &GuestTimezoneIntent,
) -> RunnerResult<()> {
    let timezone = intent
        .guest_name()
        .map(|name| GuestTimezone::BestEffort { name, run_id });
    restore_guest_state_inner(sandbox, timezone).await
}

pub async fn restore_guest_state_with_timezone(
    sandbox: &dyn Sandbox,
    timezone: &str,
) -> RunnerResult<()> {
    if !is_shell_safe_guest_timezone_name(timezone) {
        return Err(RunnerError::Config(format!(
            "invalid timezone {timezone:?}: expected a non-empty guest zoneinfo name containing only ASCII letters, digits, '/', '_', '-', or '+'"
        )));
    }
    restore_guest_state_inner(sandbox, Some(GuestTimezone::Required { name: timezone })).await
}

async fn restore_guest_state_inner(
    sandbox: &dyn Sandbox,
    timezone: Option<GuestTimezone<'_>>,
) -> RunnerResult<()> {
    let timestamp = host_unix_timestamp();
    let entropy = read_host_entropy()?;
    let request_timezone = match timezone {
        None => GuestStateRestoreTimezone::None,
        Some(GuestTimezone::BestEffort { name, .. }) => GuestStateRestoreTimezone::BestEffort(name),
        Some(GuestTimezone::Required { name }) => GuestStateRestoreTimezone::Required(name),
    };
    let result = sandbox
        .restore_guest_state(&GuestStateRestoreRequest {
            unix_seconds: timestamp.as_secs(),
            unix_nanoseconds: timestamp.subsec_nanos(),
            entropy: &entropy,
            timezone: request_timezone,
            timeout: DEFAULT_EXEC_TIMEOUT,
        })
        .await?;

    if let Some(GuestTimezone::Required { name }) = timezone
        && stderr_contains_marker(&result, TIMEZONE_UNAVAILABLE_MARKER)
    {
        return Err(RunnerError::Config(format!(
            "guest timezone {name:?} is unavailable: /usr/share/zoneinfo/{name} is not a file"
        )));
    }
    if !helper_exec_succeeded(&result) {
        return Err(RunnerError::Internal(format_helper_exec_failure(
            "guest state restore",
            &result,
        )));
    }
    if let Some(GuestTimezone::BestEffort { name, run_id }) = timezone {
        let outcome = classify_timezone_sync_result(&result);
        log_timezone_sync_failure(run_id, name, &result, outcome);
    }

    Ok(())
}

/// Set system timezone inside the guest to match the user's preference.
///
/// Configures timezone at two levels so every process sees the correct time:
///
/// - `/etc/timezone` + `/etc/localtime` — filesystem-level (read by libc)
/// - `TZ` in `/etc/environment` — inherited by all login shells via PAM
///
/// The agent process also receives `TZ` via its environment. This standalone
/// helper keeps the fresh non-snapshot path unchanged when no timezone is
/// configured; full reused-VM restoration applies the explicit UTC default.
pub(super) async fn sync_guest_timezone(sandbox: &dyn Sandbox, context: &ExecutionContext) {
    let intent = GuestTimezoneIntent::from_context(context);
    match intent {
        GuestTimezoneIntent::Configured(_) => {
            sync_guest_timezone_intent(sandbox, context.run_id, &intent).await;
        }
        GuestTimezoneIntent::Default => {}
        GuestTimezoneIntent::Unknown => {
            tracing::warn!(run_id = %context.run_id, "rejected unsafe timezone name");
        }
    }
}

pub(crate) async fn sync_guest_timezone_intent(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    intent: &GuestTimezoneIntent,
) {
    let _ = try_sync_guest_timezone_intent(sandbox, run_id, intent).await;
}

pub async fn try_sync_guest_timezone_intent(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    intent: &GuestTimezoneIntent,
) -> RunnerResult<GuestTimezoneSyncOutcome> {
    let Some(tz) = intent.guest_name() else {
        return Ok(GuestTimezoneSyncOutcome::NotRequested);
    };
    let cmd = timezone_sync_command(tz);
    // Best-effort: don't fail the run if timezone setup fails.
    let result = match sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd: &cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &[],
                sudo: true,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            "guest-timezone-sync",
        )
        .await
    {
        Ok(result) => result,
        Err(e) => {
            tracing::warn!(run_id = %run_id, tz = %tz, error = %e, "failed to set guest timezone");
            return Err(e.into());
        }
    };
    let outcome = classify_timezone_sync_result(&result);
    log_timezone_sync_failure(run_id, tz, &result, outcome);
    Ok(outcome)
}
