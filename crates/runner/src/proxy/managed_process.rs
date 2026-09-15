//! Ownership and shutdown of one managed mitmdump process tree.

use std::sync::Arc;
use std::time::Duration;

use tracing::{info, warn};

use super::runtime::{MitmdumpRuntime, preserve_launch};
use crate::error::{RunnerError, RunnerResult};

/// Timeout for graceful shutdown before SIGKILL.
///
/// Usage webhook drain is handled before SIGTERM. Leave room for the addon's
/// ten-second model-provider report drain, final JSONL flush, and process exit.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// Owns the direct PyInstaller bootloader, its process group, and the private
/// directory containing its one-file extraction.
pub(crate) struct ManagedMitmdump {
    child: Option<tokio::process::Child>,
    process_group: Option<nix::unistd::Pid>,
    leader_reaped: bool,
    launch: Option<tempfile::TempDir>,
    runtime: Option<Arc<MitmdumpRuntime>>,
    #[cfg(test)]
    reap_gate: Option<crate::child_cleanup::ReapGate>,
}

impl ManagedMitmdump {
    pub(super) fn new(
        child: tokio::process::Child,
        launch: tempfile::TempDir,
        runtime: Arc<MitmdumpRuntime>,
    ) -> RunnerResult<Self> {
        let pid = child.id().ok_or_else(|| {
            RunnerError::Internal("spawned mitmdump has no process id".to_string())
        })?;
        let pid = i32::try_from(pid).map_err(|error| {
            RunnerError::Internal(format!("convert mitmdump process id: {error}"))
        })?;
        Ok(Self {
            child: Some(child),
            process_group: Some(nix::unistd::Pid::from_raw(pid)),
            leader_reaped: false,
            launch: Some(launch),
            runtime: Some(runtime),
            #[cfg(test)]
            reap_gate: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn unmanaged(child: tokio::process::Child) -> Self {
        Self {
            child: Some(child),
            process_group: None,
            leader_reaped: false,
            launch: None,
            runtime: None,
            reap_gate: None,
        }
    }

    pub(super) fn id(&self) -> Option<u32> {
        self.child.as_ref()?.id()
    }

    pub(super) fn control_directory(&self) -> Option<&std::path::Path> {
        self.launch.as_ref().map(|launch| launch.path())
    }

    pub(super) fn child(&self) -> Option<&tokio::process::Child> {
        self.child.as_ref()
    }

    pub(super) fn child_mut(&mut self) -> Option<&mut tokio::process::Child> {
        self.child.as_mut()
    }

    pub(super) fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = match self.child.as_mut() {
            Some(child) => child.try_wait()?,
            None => None,
        };
        if status.is_some() {
            self.leader_reaped = true;
        }
        Ok(status)
    }

    pub(super) async fn force_stop(mut self) -> RunnerResult<()> {
        let _progress = crate::cleanup_progress::CleanupProgress::start(
            "mitmdump",
            "force_stop",
            crate::cleanup_progress::CleanupIdentity::Process(self.id()),
        );
        let is_running = self
            .try_wait()
            .map_err(|error| RunnerError::Internal(format!("check mitmdump process: {error}")))?
            .is_none();
        if is_running {
            self.signal_force()?;
            self.wait_for_leader().await?;
        }
        self.close_launch().await
    }

    pub(super) async fn stop_gracefully(mut self) -> RunnerResult<()> {
        let Some(child) = self.child.as_mut() else {
            return self.close_launch().await;
        };
        info!("stopping mitmdump");
        send_sigterm(child);

        match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => {
                self.leader_reaped = true;
                info!(code = status.code(), "mitmdump stopped");
            }
            Ok(Err(error)) => {
                return Err(RunnerError::Internal(format!(
                    "wait for mitmdump shutdown: {error}"
                )));
            }
            Err(_) => {
                warn!("mitmdump did not exit in time, sending SIGKILL");
                self.signal_force()?;
                self.wait_for_leader().await?;
            }
        }
        self.close_launch().await
    }

    fn signal_force(&mut self) -> RunnerResult<()> {
        if let Some(process_group) = self.process_group {
            return match nix::sys::signal::killpg(process_group, nix::sys::signal::Signal::SIGKILL)
            {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
                Err(error) => Err(RunnerError::Internal(format!(
                    "kill mitmdump process group {}: {error}",
                    process_group.as_raw()
                ))),
            };
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        match child.start_kill() {
            Ok(()) => Ok(()),
            Err(error) => Err(RunnerError::Internal(format!(
                "kill mitmdump process: {error}"
            ))),
        }
    }

    async fn wait_for_leader(&mut self) -> RunnerResult<()> {
        if self.leader_reaped {
            return Ok(());
        }
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        #[cfg(test)]
        if let Some(gate) = self.reap_gate.take() {
            gate.wait().await;
        }
        child.wait().await.map_err(|error| {
            RunnerError::Internal(format!("wait for killed mitmdump process: {error}"))
        })?;
        self.leader_reaped = true;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn set_reap_gate(&mut self, gate: crate::child_cleanup::ReapGate) {
        self.reap_gate = Some(gate);
    }

    async fn close_launch(&mut self) -> RunnerResult<()> {
        let Some(launch) = self.launch.take() else {
            return Ok(());
        };
        let Some(runtime) = self.runtime.as_ref() else {
            preserve_launch(launch, &"missing mitmdump runtime owner");
            return Err(RunnerError::Internal(
                "missing mitmdump runtime owner".to_string(),
            ));
        };
        runtime.close_launch(launch).await
    }
}

impl Drop for ManagedMitmdump {
    fn drop(&mut self) {
        if let Err(error) = self.try_wait() {
            warn!(error = %error, "failed to query mitmdump during drop cleanup");
        }
        if !self.leader_reaped
            && let Err(error) = self.signal_force()
        {
            warn!(error = %error, "failed to signal mitmdump during drop cleanup");
        }

        let mut child = self.child.take();
        if !self.leader_reaped
            && let Some(child) = child.as_mut()
            && let Err(error) = child.start_kill()
        {
            warn!(error = %error, "failed to kill direct mitmdump child during drop cleanup");
        }
        let Some(launch) = self.launch.take() else {
            crate::child_cleanup::kill_and_reap_child_on_drop("mitmdump", &mut child);
            return;
        };
        let Some(runtime) = self.runtime.take() else {
            preserve_launch(launch, &"missing mitmdump runtime owner during drop");
            crate::child_cleanup::kill_and_reap_child_on_drop("mitmdump", &mut child);
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            preserve_launch(launch, &"no active tokio runtime during mitmdump drop");
            crate::child_cleanup::kill_and_reap_child_on_drop("mitmdump", &mut child);
            return;
        };
        // Persist before handing ownership to the task. If runtime shutdown
        // cancels it, startup reconciliation can still recover the directory.
        let launch_path = launch.keep();
        handle.spawn(async move {
            if let Some(mut child) = child
                && let Err(error) = child.wait().await
            {
                warn!(error = %error, "failed to reap mitmdump during drop cleanup");
            }
            if let Err(error) = runtime.close_launch_path(launch_path).await {
                warn!(error = %error, "failed to close mitmdump launch during drop cleanup");
            }
        });
    }
}

fn send_sigterm(child: &tokio::process::Child) {
    if let Some(pid) = child.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
}
