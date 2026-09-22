use tokio::runtime::Handle;
use tracing::warn;

/// Retains a child through an async reap and its cancellation fallback.
pub struct ChildReaper {
    label: &'static str,
    child: Option<tokio::process::Child>,
}

impl ChildReaper {
    pub fn new(label: &'static str, child: tokio::process::Child) -> Self {
        Self {
            label,
            child: Some(child),
        }
    }

    pub async fn reap(mut self) -> std::io::Result<()> {
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| std::io::Error::other("child reaper lost its owned child"))?;
        let _progress = crate::cleanup_progress::CleanupProgress::start(
            self.label,
            "child_reap",
            crate::cleanup_progress::CleanupIdentity::Process(child.id()),
        );
        if let Err(error) = child.start_kill() {
            warn!(label = self.label, pid = child.id(), %error, "failed to kill child before reaping");
        }
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
mod tests {
    use super::*;
    use crate::process::read_process_stat;
    use std::time::Duration;

    async fn process_identity(pid: u32) -> Option<(char, u64)> {
        read_process_stat(pid)
            .await
            .map(|stat| (stat.state, stat.starttime))
    }

    async fn wait_for_process_starttime(pid: u32) -> u64 {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some((_, starttime)) = process_identity(pid).await {
                    return starttime;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to appear"))
    }

    async fn wait_for_process_exit(pid: u32, starttime: u64) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match process_identity(pid).await {
                    Some((_, observed_starttime)) if observed_starttime == starttime => {}
                    _ => break,
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for pid {pid} to be reaped"));
    }

    async fn wait_for_process_state(pid: u32, starttime: u64, expected_state: char) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if process_identity(pid).await == Some((expected_state, starttime)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!("timed out waiting for pid {pid} to enter state {expected_state}")
        });
    }

    #[tokio::test]
    async fn drop_cleanup_kills_and_reaps_running_child() {
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let starttime = wait_for_process_starttime(pid).await;
        let mut child = Some(child);

        kill_and_reap_child_on_drop("test-running-child", &mut child);

        assert!(child.is_none());
        wait_for_process_exit(pid, starttime).await;
    }

    #[tokio::test]
    async fn drop_cleanup_reaps_already_exited_child() {
        let child = tokio::process::Command::new("true").spawn().unwrap();
        let pid = child.id().unwrap();
        let starttime = wait_for_process_starttime(pid).await;
        let mut child = Some(child);

        wait_for_process_state(pid, starttime, 'Z').await;
        kill_and_reap_child_on_drop("test-exited-child", &mut child);

        assert!(child.is_none());
        wait_for_process_exit(pid, starttime).await;
    }
}
