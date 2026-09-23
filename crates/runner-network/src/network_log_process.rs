use tokio_util::sync::CancellationToken;
use tracing::{Instrument, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::network_log_drain::{DrainableLineReaderExit, NetworkLogDrainProducer};
use runner_host::child_cleanup::kill_and_reap_child_on_drop;

/// Owns the common post-spawn lifecycle of a required network-log process.
pub(crate) struct NetworkLogProcess {
    child_label: &'static str,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<DrainableLineReaderExit>>,
    child: Option<tokio::process::Child>,
    child_cleanup: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
    #[cfg(any(test, feature = "test-support"))]
    reap_gate: Option<crate::test_fixtures::ReapGate>,
    drain: NetworkLogDrainProducer,
}

impl NetworkLogProcess {
    pub(crate) fn new(
        child_label: &'static str,
        cancel: CancellationToken,
        task: tokio::task::JoinHandle<DrainableLineReaderExit>,
        child: tokio::process::Child,
        drain: NetworkLogDrainProducer,
    ) -> Self {
        Self {
            child_label,
            cancel,
            task: Some(task),
            child: Some(child),
            child_cleanup: None,
            #[cfg(any(test, feature = "test-support"))]
            reap_gate: None,
            drain,
        }
    }

    /// Await the monitor task, or pend forever after its completion has
    /// already been consumed.
    ///
    /// Keeping the task in the owner lets the runner reactor select on it
    /// without taking ownership unless it actually completes.
    pub(crate) async fn wait(&mut self) -> Result<DrainableLineReaderExit, tokio::task::JoinError> {
        let result = match self.task.as_mut() {
            Some(task) => task.await,
            None => std::future::pending().await,
        };
        self.task = None;
        result
    }

    /// Transfer child cleanup without blocking lifecycle publication. The
    /// handle is joined by stop; dropping it leaves the reaper progressing.
    pub(crate) fn start_child_cleanup(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let pid = child.id();
        let mut reaper = runner_host::child_cleanup::ChildReaper::new(self.child_label, child);
        #[cfg(any(test, feature = "test-support"))]
        let gate = self.reap_gate.take();
        self.child_cleanup = Some(tokio::spawn(
            async move {
                reaper.start_kill();
                #[cfg(any(test, feature = "test-support"))]
                if let Some(gate) = gate {
                    gate.wait().await;
                }
                reaper.reap().await
            }
            .instrument(tracing::info_span!(
                "network_log_child_cleanup",
                component = self.child_label,
                pid
            )),
        ));
    }

    /// Cancel the monitor task and wait for the child and task to finish.
    pub(crate) async fn stop(mut self) -> RunnerResult<()> {
        self.cancel.cancel();
        self.start_child_cleanup();
        let child_result = if let Some(task) = self.child_cleanup.take() {
            match task.await {
                Ok(result) => result.map_err(|error| {
                    RunnerError::Internal(format!(
                        "{} child cleanup failed: {error}",
                        self.child_label
                    ))
                }),
                Err(error) => Err(RunnerError::Internal(format!(
                    "{} child cleanup task failed: {error}",
                    self.child_label
                ))),
            }
        } else {
            Ok(())
        };
        let monitor_result = if let Some(task) = self.task.take() {
            task.await.map(|_| ()).map_err(|error| {
                RunnerError::Internal(format!(
                    "{} monitor cleanup failed: {error}",
                    self.child_label
                ))
            })
        } else {
            Ok(())
        };
        if child_result.is_err()
            && let Err(error) = &monitor_result
        {
            warn!(component = self.child_label, %error, "network-log monitor cleanup failed");
        }
        child_result.and(monitor_result)
    }

    pub(crate) fn drain_producer(&self) -> NetworkLogDrainProducer {
        self.drain.clone()
    }

    /// Create a lifecycle owner without a child process for runner tests.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn noop(child_label: &'static str, drain_source: &'static str) -> Self {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel(drain_source);
        Self {
            child_label,
            cancel,
            task: Some(tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = token.cancelled() => {
                            return DrainableLineReaderExit::Cancelled;
                        }
                        request = drain_rx.recv() => {
                            let Some(request) = request else {
                                return DrainableLineReaderExit::DrainChannelClosed;
                            };
                            request.ack();
                        }
                    }
                }
            })),
            child: None,
            child_cleanup: None,
            reap_gate: None,
            drain,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn set_reap_gate(&mut self, gate: crate::test_fixtures::ReapGate) {
        self.reap_gate = Some(gate);
    }

    /// Replace the monitor with a task that panics when triggered.
    #[cfg(any(test, feature = "test-support"))]
    #[allow(clippy::expect_used, clippy::panic)]
    pub async fn replace_monitor_with_panic_trigger_for_test(
        &mut self,
        drain_source: &'static str,
    ) -> std::sync::Arc<tokio::sync::Notify> {
        let task = self.task.take().expect("monitor task should exist");
        task.abort();
        let error = task
            .await
            .expect_err("aborted monitor task should return a join error");
        assert!(
            error.is_cancelled(),
            "aborted monitor task should be cancelled: {error}",
        );

        let token = self.cancel.clone();
        let trigger = std::sync::Arc::new(tokio::sync::Notify::new());
        let task_trigger = std::sync::Arc::clone(&trigger);
        let (drain, mut drain_rx) = NetworkLogDrainProducer::channel(drain_source);
        self.drain = drain;
        self.task = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = token.cancelled() => {
                        return DrainableLineReaderExit::Cancelled;
                    }
                    request = drain_rx.recv() => {
                        let Some(request) = request else {
                            return DrainableLineReaderExit::DrainChannelClosed;
                        };
                        request.ack();
                    }
                    _ = task_trigger.notified() => {
                        panic!("simulated network-log monitor task panic");
                    }
                }
            }
        }));
        trigger
    }
}

impl Drop for NetworkLogProcess {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop(self.child_label, &mut self.child);
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use runner_host::process::read_process_stat;
    use std::time::Duration;

    #[tokio::test]
    async fn drop_reaps_owned_child() {
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let starttime = read_process_stat(pid).await.unwrap().starttime;
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            task_cancel.cancelled().await;
            DrainableLineReaderExit::Cancelled
        });
        let (drain, _drain_rx) = NetworkLogDrainProducer::channel("drop-test");
        let process = NetworkLogProcess::new("drop-test", cancel, task, child, drain);

        drop(process);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let observed_starttime = read_process_stat(pid).await.map(|stat| stat.starttime);
                if observed_starttime != Some(starttime) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropped network-log process should reap its child");
    }
}
