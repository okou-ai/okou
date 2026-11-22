use std::io;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use guest_control_proto::ExecTermination;
use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};

use crate::drain::{BoundedDrainHandle, BoundedDrainResult, DrainCancellation};
use crate::process::{
    ChildProcess, extract_exit_code, kill_and_reap_child, kill_owned_child_process_group,
    process_signal_pid,
};
use crate::threading::spawn_scoped_named;

const WAIT_CANCEL_POLL_INTERVAL_MS: u64 = 50;
const THREAD_WAIT_OBSERVER: &str = "gctl-wait";

/// Outcome of child wait helpers.
pub(crate) enum WaitOutcome {
    /// Child exited with this status.
    Exited(ExitStatus),
    /// Child was killed after its timeout elapsed.
    TimedOut,
    /// Child was killed because its owning connection was cancelled.
    Cancelled,
    /// `wait()` itself failed; carries the error message.
    WaitFailed(String),
}

impl WaitOutcome {
    /// Project the common exec result before operation-specific cleanup policy.
    pub(crate) fn into_exec_result(self, wait_failure_context: &str) -> (ExecTermination, String) {
        match self {
            Self::Exited(status) => (
                ExecTermination::Exited {
                    exit_code: extract_exit_code(status),
                },
                String::new(),
            ),
            Self::TimedOut => (ExecTermination::TimedOut, String::new()),
            Self::Cancelled => (ExecTermination::Cancelled, String::new()),
            Self::WaitFailed(message) => (
                ExecTermination::WaitFailed,
                format!("{wait_failure_context}: {message}"),
            ),
        }
    }
}

enum KillReason {
    Timeout,
    Cancelled,
}

enum WaitDecision {
    Exited,
    Kill(KillReason),
}

/// Wait for drain workers to complete within the shared drain deadline, then
/// cancel any laggards.
pub(crate) fn await_drain_deadline(
    done_rx: &mpsc::Receiver<()>,
    expected: usize,
    cancel: &DrainCancellation,
    drain_deadline: Duration,
) -> usize {
    let deadline = Instant::now() + drain_deadline;
    let mut completed = 0usize;
    while completed < expected {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match done_rx.recv_timeout(remaining) {
            Ok(()) => completed += 1,
            Err(_) => break,
        }
    }
    cancel.cancel();
    completed
}

/// Collect fixed-helper output streams after cancelling lagging readers.
/// A completion notification does not replace any physical thread join.
pub(crate) fn collect_bounded_output<const N: usize>(
    drains: [BoundedDrainHandle; N],
    done_rx: &mpsc::Receiver<()>,
    cancel: &DrainCancellation,
    drain_deadline: Duration,
) -> [BoundedDrainResult; N] {
    let completed = await_drain_deadline(done_rx, N, cancel, drain_deadline);
    let results = drains.map(BoundedDrainHandle::join);
    let drains_incomplete = completed < N || results.iter().any(Result::is_err);
    results.map(|result| {
        let mut output = result.unwrap_or_default();
        if drains_incomplete {
            output.capture_truncated = true;
        }
        if output.captured.is_none() {
            output.captured = Some(Vec::new());
        }
        output
    })
}

/// Wait for a fixed helper while observing its owning connection cancellation.
/// On natural exit, signal its process group before reaping the direct child
/// so the child still owns the process-group identity.
pub(crate) fn wait_for_helper_with_group_cleanup(
    child: impl ChildProcess,
    timeout_ms: u32,
    connection_cancel: &AtomicBool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_connection_cancelled(child, timeout_ms, connection_cancel, || true)
}

/// Wait for `child` while observing its owning connection cancellation flag
/// and allowing direct-child-group cleanup before reap after natural exit.
pub(crate) fn wait_with_kill_timeout_or_connection_cancelled(
    child: impl ChildProcess,
    timeout_ms: u32,
    connection_cancel: &AtomicBool,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(
        child,
        timeout_ms,
        || connection_cancel.load(Ordering::Acquire),
        pre_reap_cleanup,
    )
}

/// Wait for `child` while observing either cancel flag.
///
/// Exec operations have both connection-level cancellation and request-level
/// cancellation.
pub(crate) fn wait_with_kill_timeout_or_cancelled_either(
    child: impl ChildProcess,
    timeout_ms: u32,
    first_cancel: &AtomicBool,
    second_cancel: &AtomicBool,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(
        child,
        timeout_ms,
        || first_cancel.load(Ordering::Acquire) || second_cancel.load(Ordering::Acquire),
        pre_reap_cleanup,
    )
}

fn wait_with_kill_timeout_or_cancelled_by(
    mut child: impl ChildProcess,
    timeout_ms: u32,
    is_cancelled: impl Fn() -> bool,
    mut pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let child_id = child.id();
    let deadline = if timeout_ms > 0 {
        let now = Instant::now();
        Some(
            now.checked_add(Duration::from_millis(u64::from(timeout_ms)))
                .unwrap_or(now),
        )
    } else {
        None
    };

    thread::scope(|scope| {
        let (observed_tx, observed_rx) = mpsc::channel::<()>();
        let observer = match spawn_scoped_named(scope, THREAD_WAIT_OBSERVER, move || {
            let result = wait_for_child_exit_without_reap(child_id);
            let _ = observed_tx.send(());
            result
        }) {
            Ok(observer) => observer,
            Err(e) => {
                // Without a non-reaping observer, natural exit cannot be
                // distinguished safely from timeout/cancel before reap.
                kill_and_reap_child(child);
                return WaitOutcome::WaitFailed(format!("failed to spawn wait observer: {e}"));
            }
        };

        let decision = apply_final_exit_priority(
            wait_for_exit_timeout_or_cancelled(&observed_rx, deadline, is_cancelled),
            &observed_rx,
        );

        match decision {
            WaitDecision::Exited => {
                let observed = match observer.join() {
                    Ok(observed) => observed,
                    Err(panic) => {
                        kill_and_reap_child(child);
                        std::panic::resume_unwind(panic);
                    }
                };
                if let Err(e) = observed {
                    kill_and_reap_child(child);
                    return WaitOutcome::WaitFailed(format!(
                        "failed to observe child exit without reaping: {e}"
                    ));
                }

                if pre_reap_cleanup() {
                    // SAFETY: the exit observer used WNOWAIT, so this owner
                    // still holds the unreaped direct child identity.
                    let _ = unsafe { kill_owned_child_process_group(child_id) };
                }

                match child.wait() {
                    Ok(status) => WaitOutcome::Exited(status),
                    Err(e) => WaitOutcome::WaitFailed(e.to_string()),
                }
            }
            WaitDecision::Kill(reason) => {
                let child_killed = kill_child(&mut child);
                let observed = observer.join();
                let status = child.wait();

                let observed = match observed {
                    Ok(observed) => observed,
                    Err(panic) => std::panic::resume_unwind(panic),
                };
                let status = match status {
                    Ok(status) => status,
                    Err(e) => return WaitOutcome::WaitFailed(e.to_string()),
                };
                if let Err(e) = observed {
                    return WaitOutcome::WaitFailed(format!(
                        "failed to observe child exit without reaping: {e}"
                    ));
                }
                if !child_killed {
                    return WaitOutcome::Exited(status);
                }
                match reason {
                    KillReason::Timeout => WaitOutcome::TimedOut,
                    KillReason::Cancelled => WaitOutcome::Cancelled,
                }
            }
        }
    })
}

fn wait_for_exit_timeout_or_cancelled(
    observed_rx: &mpsc::Receiver<()>,
    deadline: Option<Instant>,
    is_cancelled: impl Fn() -> bool,
) -> WaitDecision {
    let poll_interval = Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS);

    loop {
        if exit_observed(observed_rx) {
            return WaitDecision::Exited;
        }

        let now = Instant::now();
        let wait_for = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    return WaitDecision::Kill(KillReason::Timeout);
                }
                remaining.min(poll_interval)
            }
            None => poll_interval,
        };

        if is_cancelled() {
            return WaitDecision::Kill(KillReason::Cancelled);
        }

        match observed_rx.recv_timeout(wait_for) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return WaitDecision::Exited;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn exit_observed(observed_rx: &mpsc::Receiver<()>) -> bool {
    match observed_rx.try_recv() {
        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => true,
        Err(mpsc::TryRecvError::Empty) => false,
    }
}

fn apply_final_exit_priority(
    decision: WaitDecision,
    observed_rx: &mpsc::Receiver<()>,
) -> WaitDecision {
    match decision {
        WaitDecision::Kill(_) if exit_observed(observed_rx) => WaitDecision::Exited,
        decision => decision,
    }
}

fn wait_for_child_exit_without_reap(child_id: u32) -> io::Result<()> {
    let child_id = process_signal_pid(child_id)
        .and_then(Pid::from_raw)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid child pid"))?;
    loop {
        // Keep the owned child unreaped until the caller completes its cleanup.
        match waitid(
            WaitId::Pid(child_id),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        ) {
            Ok(_) => return Ok(()),
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

fn kill_child(child: &mut impl ChildProcess) -> bool {
    // SAFETY: this owner has not reaped child, so its PID/process group cannot
    // have been reused.
    let group_killed = unsafe { kill_owned_child_process_group(child.id()) };
    let child_killed = child.kill().is_ok();
    group_killed || child_killed
}

/// Probe readiness without releasing the identity owned by the final waiter.
pub(crate) fn child_has_exited_without_reap(child_id: u32) -> io::Result<bool> {
    let child_id = process_signal_pid(child_id)
        .and_then(Pid::from_raw)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid child pid"))?;
    loop {
        match waitid(
            WaitId::Pid(child_id),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
        ) {
            Ok(status) => return Ok(status.is_some()),
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests;
