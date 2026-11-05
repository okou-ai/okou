//! Synchronous ownership of direct child processes used by test fixtures.

use std::io::Read;
use std::process::{Child, ExitStatus, Output};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// Kills and synchronously waits for an owned direct child when dropped.
///
/// Cleanup errors are ignored, including when the child has already been reaped.
/// The inner child remains accessible for IO, PID queries and explicit waiting.
/// This owner does not signal descendants or process groups.
pub struct KillAndWaitChild(pub std::process::Child);

impl Drop for KillAndWaitChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Result of observing, terminating and receiving the status of an owned child.
///
/// `ReapTimedOut` and error results can return while the background reaper still
/// owns the child. This protocol does not signal descendants or process groups.
pub enum DirectChildWaitOutcome {
    Exited(ExitStatus),
    TimedOut(ExitStatus),
    ReapTimedOut,
    KillFailed(std::io::Error),
    ReapFailed(std::io::Error),
    WaitFailed(std::io::Error),
}

/// Waits for a direct child, killing it after the original observation budget.
///
/// Foreground receipt of the killed child's status is bounded by `kill_timeout`;
/// a timed-out receipt leaves physical reaping with its background owner.
pub fn wait_child_with_timeout(
    child: Child,
    timeout: Duration,
    kill_timeout: Duration,
) -> DirectChildWaitOutcome {
    wait_child_with_timeout_before_kill(child, timeout, kill_timeout, |_| {})
}

/// Waits with a fixture gate between observing timeout and killing the child.
///
/// The gate receives the still-owned child's ID and must not reap that child.
/// This lets a caller synchronize an exit race without transferring kill or
/// reaping authority to another owner.
pub fn wait_child_with_timeout_before_kill(
    mut child: Child,
    timeout: Duration,
    kill_timeout: Duration,
    before_kill: impl FnOnce(u32),
) -> DirectChildWaitOutcome {
    // This function alone owns exit observation and signaling. The child only
    // moves to another waiter after signaling authority has been consumed.
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return DirectChildWaitOutcome::Exited(status),
            Ok(None) => {}
            Err(error) => {
                // A wait error can mean another actor reaped the child without
                // caching its status here, so a later numeric-PID kill is unsafe.
                spawn_child_reaper(child);
                return DirectChildWaitOutcome::WaitFailed(error);
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
    }

    before_kill(child.id());
    let kill_result = child.kill();
    let reaper_rx = spawn_child_reaper(child);
    if let Err(error) = kill_result {
        return DirectChildWaitOutcome::KillFailed(error);
    }

    match reaper_rx.recv_timeout(kill_timeout) {
        Ok(Ok(status)) => DirectChildWaitOutcome::TimedOut(status),
        Ok(Err(error)) => DirectChildWaitOutcome::ReapFailed(error),
        Err(mpsc::RecvTimeoutError::Timeout) => DirectChildWaitOutcome::ReapTimedOut,
        Err(mpsc::RecvTimeoutError::Disconnected) => DirectChildWaitOutcome::ReapFailed(
            std::io::Error::other("child reaper exited without status"),
        ),
    }
}

/// Transfers an owned child to a detached thread that reports its wait result.
///
/// The caller must finish any PID-based signaling before this handoff. Dropping
/// the receiver or timing out does not cancel the reaper's physical ownership.
pub fn spawn_child_reaper(mut child: Child) -> Receiver<std::io::Result<ExitStatus>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    rx
}

/// Concurrent pipe draining for synchronous child-process fixtures.
///
/// The reader owns its pipe until EOF. Collection observes completion through a
/// channel, so an inherited open pipe cannot extend the foreground deadline.
pub struct ChildOutputReader {
    rx: Receiver<std::io::Result<Vec<u8>>>,
}

impl ChildOutputReader {
    /// Starts draining one owned pipe on a dedicated thread.
    pub fn spawn(mut pipe: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let _ = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(result);
        });
        Self { rx }
    }

    fn finish(self, stream: &str, deadline: Instant) -> std::io::Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = match self.rx.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{stream} did not close before the child output deadline"),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(std::io::Error::other(format!(
                    "{stream} reader exited without output"
                )));
            }
        };
        result.map_err(|error| {
            std::io::Error::new(error.kind(), format!("read child {stream}: {error}"))
        })
    }
}

/// Collects stdout before stderr using the same absolute output deadline.
///
/// Reader timeouts and errors retain their original stream context and IO kind.
/// A timeout returns without joining a reader still waiting for EOF.
pub fn collect_child_output(
    status: ExitStatus,
    stdout_reader: ChildOutputReader,
    stderr_reader: ChildOutputReader,
    deadline: Instant,
) -> std::io::Result<Output> {
    let stdout = stdout_reader.finish("stdout", deadline)?;
    let stderr = stderr_reader.finish("stderr", deadline)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests;
