use std::fmt;
use std::io;
use std::time::{Duration, SystemTime};

use guest_control_client::{GuestControlClient, GuestDnsReadinessResult};
use guest_control_proto::GuestDnsReadinessTermination;
use sandbox::{
    SandboxDnsReadinessAttempt, SandboxDnsReadinessOutcome, SandboxGuestDnsReadinessReason,
    SandboxStartObserver,
};
use tokio::time::Instant;

use crate::guest_dns_probe::{DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};

const PROCESS_TIMEOUT_MS: u32 = 1_100;
const OPERATION_START_AND_RESULT_GRACE_MS: u64 = 1_000;
const OPERATION_WAIT_TIMEOUT: Duration =
    Duration::from_millis(PROCESS_TIMEOUT_MS as u64 + OPERATION_START_AND_RESULT_GRACE_MS);

pub(crate) const GUEST_DNS_READINESS_MAX_ATTEMPTS: u16 = 3;

const PRODUCTION_POLICY: ReadinessPolicy = ReadinessPolicy {
    total_timeout: Duration::from_secs(7),
    attempt_timeout: OPERATION_WAIT_TIMEOUT,
    max_attempts: GUEST_DNS_READINESS_MAX_ATTEMPTS,
};

#[derive(Clone, Copy)]
struct ReadinessPolicy {
    total_timeout: Duration,
    attempt_timeout: Duration,
    max_attempts: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuestDnsReadinessFailure {
    Deadline,
    Transport(io::ErrorKind),
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
    ExitNonZero(i32),
    OutputTruncated,
    UnexpectedAnswer,
}

impl fmt::Display for GuestDnsReadinessFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deadline => f.write_str("deadline"),
            Self::Transport(kind) => write!(f, "transport_{kind:?}"),
            Self::TimedOut => f.write_str("process_timeout"),
            Self::Cancelled => f.write_str("process_cancelled"),
            Self::StartFailed => f.write_str("process_start_failed"),
            Self::WaitFailed => f.write_str("process_wait_failed"),
            Self::ExitNonZero(exit_code) => write!(f, "exit_nonzero_{exit_code}"),
            Self::OutputTruncated => f.write_str("output_truncated"),
            Self::UnexpectedAnswer => f.write_str("unexpected_answer"),
        }
    }
}

impl GuestDnsReadinessFailure {
    fn outcome(self) -> SandboxDnsReadinessOutcome {
        match self {
            Self::Deadline => SandboxDnsReadinessOutcome::Deadline,
            Self::Transport(_) => SandboxDnsReadinessOutcome::Transport,
            Self::TimedOut => SandboxDnsReadinessOutcome::ProcessTimeout,
            Self::Cancelled => SandboxDnsReadinessOutcome::ProcessCancelled,
            Self::StartFailed => SandboxDnsReadinessOutcome::StartFailed,
            Self::WaitFailed => SandboxDnsReadinessOutcome::WaitFailed,
            Self::ExitNonZero(_) => SandboxDnsReadinessOutcome::ExitNonZero,
            Self::OutputTruncated => SandboxDnsReadinessOutcome::OutputTruncated,
            Self::UnexpectedAnswer => SandboxDnsReadinessOutcome::UnexpectedAnswer,
        }
    }

    fn retryable(self) -> bool {
        matches!(
            self,
            Self::TimedOut | Self::ExitNonZero(2) | Self::UnexpectedAnswer
        )
    }

    pub(crate) fn sandbox_reason(self) -> SandboxGuestDnsReadinessReason {
        match self {
            Self::TimedOut => SandboxGuestDnsReadinessReason::ProcessTimeout,
            Self::Deadline => SandboxGuestDnsReadinessReason::Deadline,
            Self::ExitNonZero(2) | Self::UnexpectedAnswer => {
                SandboxGuestDnsReadinessReason::DnsPath
            }
            Self::Transport(_)
            | Self::Cancelled
            | Self::StartFailed
            | Self::WaitFailed
            | Self::ExitNonZero(_)
            | Self::OutputTruncated => SandboxGuestDnsReadinessReason::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GuestDnsReadinessError {
    pub(crate) attempts: u16,
    pub(crate) elapsed: Duration,
    pub(crate) last_failure: GuestDnsReadinessFailure,
}

impl fmt::Display for GuestDnsReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "outcome={} attempts={} elapsed_ms={}",
            self.last_failure,
            self.attempts,
            self.elapsed.as_millis(),
        )
    }
}

impl std::error::Error for GuestDnsReadinessError {}

// Buffer observations so observer work cannot delay a retry or alter its budget
// decision. Drop also preserves the completed prefix on host cancellation, but
// never owns guest cancellation, connection fencing or process cleanup.
struct AttemptObservations<'a> {
    observer: &'a mut dyn SandboxStartObserver,
    records: Vec<SandboxDnsReadinessAttempt>,
    current_started: Instant,
    in_flight: bool,
}

impl AttemptObservations<'_> {
    fn finish(
        &mut self,
        guest_duration_ms: Option<u32>,
        outcome: SandboxDnsReadinessOutcome,
        final_attempt: bool,
    ) {
        self.records.push(SandboxDnsReadinessAttempt {
            attempt: self.records.len() as u16 + 1,
            final_attempt,
            duration: self.current_started.elapsed(),
            guest_duration_ms,
            outcome,
            completed_at: SystemTime::now(),
        });
        self.in_flight = false;
    }
}

impl Drop for AttemptObservations<'_> {
    fn drop(&mut self) {
        if self.in_flight {
            self.finish(None, SandboxDnsReadinessOutcome::HostCancelled, true);
        }
        for record in &self.records {
            self.observer.record_dns_readiness_attempt(*record);
        }
    }
}

pub(crate) async fn wait_for_guest_dns_readiness(
    guest: &GuestControlClient,
    observer: &mut dyn SandboxStartObserver,
) -> Result<(), GuestDnsReadinessError> {
    wait_for_guest_dns_readiness_with_policy(guest, PRODUCTION_POLICY, observer).await
}

async fn wait_for_guest_dns_readiness_with_policy(
    guest: &GuestControlClient,
    policy: ReadinessPolicy,
    observer: &mut dyn SandboxStartObserver,
) -> Result<(), GuestDnsReadinessError> {
    let started = Instant::now();
    let deadline = started + policy.total_timeout;
    let mut attempts = 0;
    let mut observations = AttemptObservations {
        observer,
        records: Vec::with_capacity(usize::from(policy.max_attempts)),
        current_started: started,
        in_flight: false,
    };

    loop {
        attempts += 1;
        observations.current_started = Instant::now();
        observations.in_flight = true;
        let (result, guest_duration_ms) = probe_guest_dns_once(guest, policy.attempt_timeout).await;
        let failure = match result {
            Ok(()) => {
                observations.finish(guest_duration_ms, SandboxDnsReadinessOutcome::Success, true);
                return Ok(());
            }
            Err(failure) => failure,
        };

        let complete_retry_fits =
            deadline.saturating_duration_since(Instant::now()) >= policy.attempt_timeout;
        let final_attempt =
            !failure.retryable() || attempts >= policy.max_attempts || !complete_retry_fits;
        observations.finish(guest_duration_ms, failure.outcome(), final_attempt);
        if final_attempt {
            return Err(GuestDnsReadinessError {
                attempts,
                elapsed: started.elapsed(),
                last_failure: failure,
            });
        }
    }
}

async fn probe_guest_dns_once(
    guest: &GuestControlClient,
    wait_timeout: Duration,
) -> (Result<(), GuestDnsReadinessFailure>, Option<u32>) {
    match guest
        .guest_dns_readiness(DNS_READINESS_HOSTNAME, PROCESS_TIMEOUT_MS, wait_timeout)
        .await
    {
        Ok(result) => {
            let duration_ms = result.duration_ms;
            (validate_result(result), Some(duration_ms))
        }
        Err(error) if error.kind() == io::ErrorKind::TimedOut => {
            (Err(GuestDnsReadinessFailure::Deadline), None)
        }
        Err(error) => (Err(GuestDnsReadinessFailure::Transport(error.kind())), None),
    }
}

fn validate_result(result: GuestDnsReadinessResult) -> Result<(), GuestDnsReadinessFailure> {
    let GuestDnsReadinessResult {
        termination,
        answer,
        output_truncated,
        ..
    } = result;

    match termination {
        GuestDnsReadinessTermination::Exited { exit_code: 0 } => {}
        GuestDnsReadinessTermination::Exited { exit_code } => {
            return Err(GuestDnsReadinessFailure::ExitNonZero(exit_code));
        }
        GuestDnsReadinessTermination::TimedOut => {
            return Err(GuestDnsReadinessFailure::TimedOut);
        }
        GuestDnsReadinessTermination::Cancelled => {
            return Err(GuestDnsReadinessFailure::Cancelled);
        }
        GuestDnsReadinessTermination::StartFailed => {
            return Err(GuestDnsReadinessFailure::StartFailed);
        }
        GuestDnsReadinessTermination::WaitFailed => {
            return Err(GuestDnsReadinessFailure::WaitFailed);
        }
    }

    if output_truncated {
        return Err(GuestDnsReadinessFailure::OutputTruncated);
    }

    let expected = DNS_READINESS_IPV4.to_string();
    if answer
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            line.split(|byte| byte.is_ascii_whitespace())
                .find(|field| !field.is_empty())
        })
        .any(|address| address == expected.as_bytes())
    {
        Ok(())
    } else {
        Err(GuestDnsReadinessFailure::UnexpectedAnswer)
    }
}

#[cfg(test)]
mod tests;
