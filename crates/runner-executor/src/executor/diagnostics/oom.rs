use std::time::Duration;

use rustix::time::{ClockId, clock_gettime};
use tokio::process::Command;
use tracing::warn;

use runner_host::bounded_command::{
    BoundedCommandError, BoundedCommandOutcome, CommandOutputPolicy, run_output_bounded,
};

const HOST_OOM_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MICROSECONDS_PER_SECOND: i128 = 1_000_000;

/// Boot-relative monotonic timestamp used as the lower bound for host OOM evidence.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(in crate::executor) struct HostOomEvidenceSince(i128);

impl HostOomEvidenceSince {
    pub(in crate::executor) const fn from_micros(micros: i128) -> Self {
        Self(micros)
    }
}

/// Checks host `dmesg` output for OOM evidence naming a specific Firecracker process.
///
/// Invokes `dmesg` directly under the runner's current privileges and accepts
/// only raw-timestamped records at or after `since`. After a five-second
/// execution deadline, the child is terminated and reaped before returning.
/// Returns `false` when the command exits unsuccessfully, execution fails, the
/// operation times out, or record freshness cannot be established.
pub(in crate::executor) async fn check_host_oom(pid: u32, since: HostOomEvidenceSince) -> bool {
    let mut command = Command::new("dmesg");
    command.arg("--time-format=raw");
    check_host_oom_command(pid, since, command, HOST_OOM_CHECK_TIMEOUT).await
}

async fn check_host_oom_command(
    pid: u32,
    since: HostOomEvidenceSince,
    command: Command,
    timeout: Duration,
) -> bool {
    match run_output_bounded(
        command,
        "dmesg",
        CommandOutputPolicy::semantic_stdout(),
        timeout,
    )
    .await
    {
        Ok(BoundedCommandOutcome::Exited(output)) if output.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&output.stdout), pid, since)
        }
        Ok(BoundedCommandOutcome::Exited(output)) => {
            warn!(pid, exit_code = output.status.code(), "dmesg failed");
            false
        }
        Ok(BoundedCommandOutcome::TimedOut) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
        Err(BoundedCommandError::Spawn(error) | BoundedCommandError::Wait(error)) => {
            warn!(pid, error = %error, "failed to run dmesg for OOM check");
            false
        }
        Err(BoundedCommandError::Lifecycle(error)) => {
            warn!(pid, error = %error, "failed to run dmesg for OOM check");
            false
        }
        Err(BoundedCommandError::OutputTooLarge { stream, limit }) => {
            warn!(pid, stream, limit, "failed to run dmesg for OOM check");
            false
        }
    }
}

/// Capture the host monotonic clock used by raw kernel-log timestamps.
pub(in crate::executor) fn host_oom_evidence_since_now() -> HostOomEvidenceSince {
    let timestamp = clock_gettime(ClockId::Monotonic);
    HostOomEvidenceSince::from_micros(
        i128::from(timestamp.tv_sec) * MICROSECONDS_PER_SECOND
            + i128::from(timestamp.tv_nsec) / 1_000,
    )
}

fn parse_raw_dmesg_record(line: &str) -> Option<(HostOomEvidenceSince, &str)> {
    let (timestamp, message) = line.trim_start().strip_prefix('[')?.split_once(']')?;
    let (seconds, micros) = timestamp.trim().split_once('.')?;
    if seconds.is_empty()
        || !seconds.bytes().all(|byte| byte.is_ascii_digit())
        || micros.len() != 6
        || !micros.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let micros = seconds
        .parse::<i128>()
        .ok()?
        .checked_mul(MICROSECONDS_PER_SECOND)?
        .checked_add(micros.parse::<i128>().ok()?)?;
    Some((HostOomEvidenceSince::from_micros(micros), message))
}

fn record_has_firecracker_pid(record: &str, pid: u32) -> bool {
    let needle = format!("task=firecracker,pid={pid}");
    let mut start = 0;
    while let Some(pos) = record[start..].find(&needle) {
        let abs = start + pos + needle.len();
        match record.as_bytes().get(abs) {
            Some(c) if c.is_ascii_digit() => {
                start = abs;
            }
            _ => return true,
        }
    }
    false
}

/// Returns `true` when one fresh host `dmesg` record contains both the
/// case-sensitive `oom-kill` marker and the exact
/// `task=firecracker,pid=<pid>` substring.
///
/// Records without the raw boot-relative timestamp are rejected. The
/// predicate does not require a memory-cgroup constraint marker. The character
/// after the PID must not be a digit, avoiding prefix matches such as
/// `pid=1234` matching `pid=12345`.
pub(in crate::executor) fn host_dmesg_indicates_oom(
    dmesg: &str,
    pid: u32,
    since: HostOomEvidenceSince,
) -> bool {
    dmesg.lines().any(|line| {
        let Some((timestamp, record)) = parse_raw_dmesg_record(line) else {
            return false;
        };
        timestamp >= since && record.contains("oom-kill") && record_has_firecracker_pid(record, pid)
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timed_out_command_is_not_oom_evidence() {
        let mut command = Command::new("sleep");
        command.arg("60");

        assert!(
            !check_host_oom_command(
                42,
                HostOomEvidenceSince::from_micros(0),
                command,
                Duration::ZERO,
            )
            .await
        );
    }

    #[tokio::test]
    async fn unsuccessful_command_is_not_oom_evidence() {
        let command = Command::new("false");

        assert!(
            !check_host_oom_command(
                42,
                HostOomEvidenceSince::from_micros(0),
                command,
                Duration::from_secs(2),
            )
            .await
        );
    }

    #[tokio::test]
    async fn successful_command_captures_stdout_for_oom_detection() {
        let mut command = Command::new("printf");
        command.arg("[42.000000] oom-kill:task=firecracker,pid=42");

        assert!(
            check_host_oom_command(
                42,
                HostOomEvidenceSince::from_micros(42_000_000),
                command,
                Duration::from_secs(2),
            )
            .await
        );
    }
}
