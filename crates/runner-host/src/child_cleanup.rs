use tokio::runtime::Handle;
use tracing::warn;

/// Retains a child through an async reap and its cancellation fallback.
pub struct ChildReaper {
    label: &'static str,
    child: Option<tokio::process::Child>,
    kill_started: bool,
}

impl ChildReaper {
    pub fn new(label: &'static str, child: tokio::process::Child) -> Self {
        Self {
            label,
            child: Some(child),
            kill_started: false,
        }
    }

    /// Signal the owned child before awaiting its exit.
    ///
    /// This is idempotent so lifecycle owners can separate the signal boundary
    /// from a later, still-owned reap without exposing a test-only control.
    pub fn start_kill(&mut self) {
        if self.kill_started {
            return;
        }
        self.kill_started = true;
        let Some(child) = self.child.as_mut() else {
            return;
        };
        if let Err(error) = child.start_kill() {
            warn!(label = self.label, pid = child.id(), %error, "failed to kill child before reaping");
        }
    }

    pub async fn reap(mut self) -> std::io::Result<()> {
        let pid = self
            .child
            .as_ref()
            .ok_or_else(|| std::io::Error::other("child reaper lost its owned child"))?
            .id();
        let _progress = crate::cleanup_progress::CleanupProgress::start(
            self.label,
            "child_reap",
            crate::cleanup_progress::CleanupIdentity::Process(pid),
        );
        self.start_kill();
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| std::io::Error::other("child reaper lost its owned child"))?;
        child.wait().await?;
        self.child = None;
        Ok(())
    }
}

impl Drop for ChildReaper {
    fn drop(&mut self) {
        kill_and_reap_child_on_drop(self.label, &mut self.child);
    }
}

/// Kill a child from a synchronous drop fallback and reap it on the active runtime.
///
/// Normal async shutdown paths should still use explicit `wait().await`. This
/// helper exists for abnormal drop/cancellation fallback paths where awaiting
/// directly is impossible.
pub fn kill_and_reap_child_on_drop(label: &'static str, child: &mut Option<tokio::process::Child>) {
    let Some(mut child) = child.take() else {
        return;
    };
    let pid = child.id();

    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(error) => {
            warn!(label, ?pid, error = %error, "failed to check child status during drop cleanup");
        }
    }

    if let Err(error) = child.start_kill() {
        warn!(label, ?pid, error = %error, "failed to kill child during drop cleanup");
    }

    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(error) => {
            warn!(label, ?pid, error = %error, "failed to recheck child status during drop cleanup");
        }
    }

    let Ok(handle) = Handle::try_current() else {
        warn!(
            label,
            ?pid,
            "cannot spawn child reaper without an active tokio runtime"
        );
        return;
    };

    handle.spawn(async move {
        if let Err(error) = child.wait().await {
            warn!(label, ?pid, error = %error, "failed to reap child after drop cleanup");
        }
    });
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests;
