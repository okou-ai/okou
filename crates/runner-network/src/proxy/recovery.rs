//! Single-flight mitmdump recovery and retry ownership.

use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use super::{ManagedMitmdump, MitmProxy, MitmRestartError};
use crate::error::{RunnerError, RunnerResult};

const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const MAX_CONSECUTIVE_FAILURES: u32 = 20;

type RestartTask = JoinHandle<Result<ManagedMitmdump, MitmRestartError>>;

/// Owns an in-flight proxy replacement and the policy for retrying startup failures.
/// The Runner reactor retains crash observation, timer scheduling, and fatal shutdown.
pub struct MitmRecovery {
    task: Option<RestartTask>,
    restart_at: Option<Instant>,
    backoff: Duration,
    consecutive_failures: u32,
}

impl Default for MitmRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl MitmRecovery {
    pub fn new() -> Self {
        Self {
            task: None,
            restart_at: None,
            backoff: BACKOFF_INITIAL,
            consecutive_failures: 0,
        }
    }

    /// A crash schedules a restart after the current backoff, even during a
    /// replacement; buffered notifications are drained before that task starts.
    pub fn on_crash(&mut self) {
        if self.consecutive_failures < MAX_CONSECUTIVE_FAILURES {
            self.restart_at = Some(Instant::now() + self.backoff);
        }
    }

    /// None while a task is in flight: an expired timer must not spin the reactor.
    pub fn retry_deadline(&self) -> Option<Instant> {
        self.restart_at.filter(|_| self.task.is_none())
    }

    pub fn maybe_start(&mut self, mitm: &mut MitmProxy, crash_rx: &mut mpsc::Receiver<()>) {
        if self.retry_deadline().is_none_or(|at| Instant::now() < at) {
            return;
        }
        self.restart_at = None;
        // Clear buffered notifications from the same crash before starting a
        // new child. begin_restart silences the old child's monitor.
        while crash_rx.try_recv().is_ok() {}
        self.task = Some(tokio::spawn(mitm.begin_restart().spawn()));
    }

    /// Wait without consuming the JoinHandle if a select branch is cancelled.
    /// Startup errors schedule retries; cleanup and task failures are fatal.
    pub async fn wait(&mut self, mitm: &mut MitmProxy) -> RunnerResult<()> {
        match self.join().await? {
            Ok(child) => {
                if self.consecutive_failures > 0 {
                    info!(
                        attempts = self.consecutive_failures,
                        "mitmproxy restarted after failures"
                    );
                } else {
                    info!("mitmproxy restarted");
                }
                self.adopt_replacement(mitm, child);
            }
            Err(error) => self.on_startup_failure(error),
        }
        Ok(())
    }

    /// A fatal cleanup result closes the crash channel and cancels future
    /// retries without dropping any in-flight replacement task.
    pub fn stop_retries(&mut self, crash_rx: &mut mpsc::Receiver<()>) {
        crash_rx.close();
        while crash_rx.try_recv().is_ok() {}
        self.restart_at = None;
    }

    /// Join an in-flight replacement before the normal usage flush and proxy
    /// stop. Do not schedule another startup attempt during shutdown.
    pub async fn finish_before_shutdown(&mut self, mitm: &mut MitmProxy) -> RunnerResult<()> {
        if self.task.is_none() {
            return Ok(());
        }
        info!("waiting for in-flight mitmproxy restart before shutdown");
        match self.join().await? {
            Ok(child) => {
                info!("mitmproxy restart completed during shutdown");
                self.adopt_replacement(mitm, child);
            }
            Err(error) => warn!(error = %error, "mitmproxy restart failed during shutdown"),
        }
        Ok(())
    }

    fn adopt_replacement(&mut self, mitm: &mut MitmProxy, child: ManagedMitmdump) {
        mitm.complete_restart(child);
        self.backoff = BACKOFF_INITIAL;
        self.consecutive_failures = 0;
    }

    async fn join(&mut self) -> RunnerResult<Result<ManagedMitmdump, String>> {
        let Some(task) = self.task.as_mut() else {
            return std::future::pending().await;
        };
        let result = task.await;
        self.task = None;
        match result {
            Ok(Ok(child)) => Ok(Ok(child)),
            Ok(Err(MitmRestartError::Startup(error))) => Ok(Err(error.to_string())),
            Ok(Err(MitmRestartError::Cleanup(error))) => Err(RunnerError::Internal(format!(
                "old mitmdump cleanup failed: {error}"
            ))),
            Err(error) => Err(RunnerError::Internal(format!(
                "mitmproxy recovery task failed: {error}"
            ))),
        }
    }

    fn on_startup_failure(&mut self, error: String) {
        let next_secs = self.backoff.as_secs();
        self.consecutive_failures += 1;
        if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            self.restart_at = None;
            error!(error = %error, failures = self.consecutive_failures,
                "mitmproxy restart abandoned after too many failures");
            return;
        }
        self.on_crash();
        self.backoff = (self.backoff * 2).min(BACKOFF_MAX);
        if self.consecutive_failures >= 5 {
            error!(error = %error, failures = self.consecutive_failures, next_attempt_secs = next_secs,
                "mitmproxy restart failing persistently");
        } else {
            warn!(error = %error, next_attempt_secs = next_secs, "mitmproxy restart failed");
        }
    }
}

#[cfg(test)]
mod tests;
