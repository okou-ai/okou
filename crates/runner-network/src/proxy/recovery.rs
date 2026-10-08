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
        if !self.retry_deadline().is_some_and(|at| Instant::now() >= at) {
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
                mitm.complete_restart(child);
                self.backoff = BACKOFF_INITIAL;
                self.consecutive_failures = 0;
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
                mitm.complete_restart(child);
                self.backoff = BACKOFF_INITIAL;
                self.consecutive_failures = 0;
            }
            Err(error) => warn!(error = %error, "mitmproxy restart failed during shutdown"),
        }
        Ok(())
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
mod tests {
    use super::*;

    fn unmanaged_child(command: &str, arg: Option<&str>) -> ManagedMitmdump {
        let mut child = tokio::process::Command::new(command);
        if let Some(arg) = arg {
            child.arg(arg);
        }
        ManagedMitmdump::unmanaged(child.spawn().unwrap())
    }

    async fn panicking_restart() -> Result<ManagedMitmdump, MitmRestartError> {
        panic!("old child cleanup panicked");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn single_flight_drains_duplicate_crashes_and_retries_startup_failure() {
        let (mut mitm, _) = MitmProxy::noop();
        let (tx, mut crash_rx) = mpsc::channel(1);
        let mut recovery = MitmRecovery::new();
        tx.try_send(()).unwrap();
        recovery.restart_at = Some(Instant::now() + Duration::from_secs(60));
        let future_deadline = recovery.retry_deadline();
        recovery.maybe_start(&mut mitm, &mut crash_rx);
        assert_eq!(recovery.retry_deadline(), future_deadline);
        assert!(recovery.task.is_none());
        assert_eq!(crash_rx.try_recv(), Ok(()));

        tx.try_send(()).unwrap();
        recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
        recovery.maybe_start(&mut mitm, &mut crash_rx);
        assert!(recovery.retry_deadline().is_none());
        assert_eq!(crash_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty));
        let id = recovery.task.as_ref().unwrap().id();
        tx.try_send(()).unwrap();
        recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
        recovery.maybe_start(&mut mitm, &mut crash_rx);
        assert_eq!(recovery.task.as_ref().unwrap().id(), id);
        assert!(
            recovery.retry_deadline().is_none(),
            "in-flight timer must not spin"
        );
        assert_eq!(crash_rx.try_recv(), Ok(()));
        let failure_handled_at = Instant::now();
        recovery.wait(&mut mitm).await.unwrap();
        assert_eq!(recovery.consecutive_failures, 1);
        assert!(recovery.retry_deadline().unwrap() >= failure_handled_at + BACKOFF_INITIAL);
        assert_eq!(recovery.backoff, BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn cancelled_wait_retains_in_flight_replacement() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        let (tx, rx) = tokio::sync::oneshot::channel();
        recovery.task = Some(tokio::spawn(async move {
            rx.await.unwrap();
            Ok(unmanaged_child("true", None))
        }));
        let task_id = recovery.task.as_ref().unwrap().id();
        tokio::select! {
            biased;
            result = recovery.wait(&mut mitm) => panic!("blocked restart unexpectedly completed: {result:?}"),
            () = std::future::ready(()) => {}
        }
        assert_eq!(recovery.task.as_ref().unwrap().id(), task_id);
        tx.send(()).unwrap();
        recovery.wait(&mut mitm).await.unwrap();
        assert!(recovery.task.is_none());
        mitm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn success_resets_backoff_and_adopts_child() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.backoff = Duration::from_secs(16);
        recovery.consecutive_failures = 5;
        recovery.task = Some(tokio::spawn(async { Ok(unmanaged_child("true", None)) }));
        recovery.wait(&mut mitm).await.unwrap();
        assert_eq!(recovery.backoff, BACKOFF_INITIAL);
        assert_eq!(recovery.consecutive_failures, 0);
        mitm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn startup_failure_schedules_retry_with_backoff() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.task = Some(tokio::spawn(async {
            Err(MitmRestartError::Startup(RunnerError::Internal(
                "spawn failed".into(),
            )))
        }));
        recovery.wait(&mut mitm).await.unwrap();
        assert_eq!(recovery.consecutive_failures, 1);
        assert!(recovery.retry_deadline().is_some());
        assert_eq!(recovery.backoff, BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn backoff_caps_at_max() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.backoff = BACKOFF_MAX;
        recovery.consecutive_failures = 10;
        recovery.task = Some(tokio::spawn(async {
            Err(MitmRestartError::Startup(RunnerError::Internal(
                "spawn failed".into(),
            )))
        }));
        recovery.wait(&mut mitm).await.unwrap();
        assert_eq!(recovery.backoff, BACKOFF_MAX);
        assert!(recovery.retry_deadline().is_some());
    }

    #[tokio::test]
    async fn circuit_breaker_stops_after_twenty_failures() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.backoff = BACKOFF_MAX;
        recovery.consecutive_failures = 19;
        recovery.restart_at = Some(Instant::now() - Duration::from_secs(1));
        recovery.task = Some(tokio::spawn(async {
            Err(MitmRestartError::Startup(RunnerError::Internal(
                "binary missing".into(),
            )))
        }));
        recovery.wait(&mut mitm).await.unwrap();
        assert_eq!(recovery.consecutive_failures, 20);
        assert!(recovery.retry_deadline().is_none());
        recovery.on_crash();
        assert!(
            recovery.retry_deadline().is_none(),
            "breaker must remain open"
        );
    }

    #[tokio::test]
    async fn shutdown_adopts_in_flight_child() {
        let (mut mitm, _) = MitmProxy::noop();
        let dir = tempfile::tempdir().unwrap();
        let mut recovery = MitmRecovery::new();
        recovery.task = Some(tokio::spawn(async {
            Ok(unmanaged_child("sleep", Some("60")))
        }));
        recovery.finish_before_shutdown(&mut mitm).await.unwrap();
        assert!(recovery.task.is_none());
        mitm.set_control_directory_for_test(dir.path().to_path_buf());
        assert!(mitm.usage_flush_target().is_some());
        mitm.stop().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_does_not_retry_startup_failure() {
        let (mut mitm, _) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.task = Some(tokio::spawn(async {
            Err(MitmRestartError::Startup(RunnerError::Internal(
                "spawn failed".into(),
            )))
        }));
        recovery.finish_before_shutdown(&mut mitm).await.unwrap();
        assert!(recovery.task.is_none());
        assert!(recovery.retry_deadline().is_none());
        assert!(mitm.usage_flush_target().is_none());
    }

    #[tokio::test]
    async fn cleanup_failure_and_task_panic_are_fatal() {
        let (mut mitm, mut crash_rx) = MitmProxy::noop();
        let mut recovery = MitmRecovery::new();
        recovery.task = Some(tokio::spawn(async {
            Err(MitmRestartError::Cleanup(RunnerError::Internal(
                "unknown cleanup".into(),
            )))
        }));
        let error = recovery.wait(&mut mitm).await.unwrap_err();
        assert!(error.to_string().contains("old mitmdump cleanup failed"));
        recovery.stop_retries(&mut crash_rx);
        assert!(recovery.retry_deadline().is_none());
        recovery.task = Some(tokio::spawn(panicking_restart()));
        let error = recovery.wait(&mut mitm).await.unwrap_err();
        assert!(error.to_string().contains("mitmproxy recovery task failed"));
    }
}
