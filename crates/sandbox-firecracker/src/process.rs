use std::fmt;
use std::io;

use futures_util::{FutureExt, future::Shared};
use tokio::sync::oneshot;

#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;

/// Retains the child-wait result independently of a consuming monitor waiter.
/// Clones share the terminal result, including across cancellation and Drop.
#[derive(Clone)]
pub(crate) struct ProcessExitCompletion {
    completion: Shared<oneshot::Receiver<bool>>,
}

impl ProcessExitCompletion {
    /// The monitor sends true only after a successful child wait. A nonzero
    /// exit status still confirms exit; a wait error does not.
    pub(crate) fn channel() -> (oneshot::Sender<bool>, Self) {
        let (tx, rx) = oneshot::channel();
        (
            tx,
            Self {
                completion: rx.shared(),
            },
        )
    }

    pub(crate) async fn confirmed(&self) -> bool {
        // A lost producer (including monitor panic/abort) cannot confirm exit.
        self.completion.clone().await.unwrap_or(false)
    }
}

/// Kill the entire process group of `child` via `killpg(SIGKILL)`.
///
/// Requires the child to have been spawned with `process_group(0)` so that its
/// PGID equals its PID. No-op if the child has already exited or the PID cannot
/// be represented as `i32`.
pub(crate) fn kill_process_group(pid: Option<u32>) -> nix::Result<()> {
    if let Some(pid) = pid {
        kill_process_group_by_pid(pid)
    } else {
        Ok(())
    }
}

/// Kill the process group whose PGID equals `pid`.
///
/// Callers should prefer [`kill_process_group`] when they still own the child;
/// that avoids signalling from a PID after the child has been reaped.
pub(crate) fn kill_process_group_by_pid(pid: u32) -> nix::Result<()> {
    if let Ok(pid) = i32::try_from(pid) {
        let pgid = nix::unistd::Pid::from_raw(pid);
        nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL)
    } else {
        Ok(())
    }
}

/// Best-effort notification that a child process has exited without reaping it.
///
/// On Linux, this uses a pidfd registered with Tokio. A successful
/// [`Self::wait_for_exit`] result is only a pre-reap observation: it does not
/// consume the child's exit status or call [`tokio::process::Child::wait`]. The
/// caller retains ownership of the child and must still reap it explicitly.
///
/// Pidfd notification can be unavailable because the child has no PID, the
/// platform does not support pidfds, or pidfd setup fails. Callers must provide
/// an explicit fallback when [`Self::is_available`] is false.
pub(crate) struct ChildExitNotifier {
    inner: ChildExitNotifierInner,
}

enum ChildExitNotifierInner {
    #[cfg(target_os = "linux")]
    PidFd(tokio::io::unix::AsyncFd<OwnedFd>),
    Unavailable(ChildExitNotifierUnavailable),
}

#[derive(Debug)]
/// Explains why a [`ChildExitNotifier`] cannot provide pidfd-backed notification.
///
/// An unavailable notifier is not an exit result. Callers must choose an
/// explicit fallback, such as waiting on the child directly, and can use this
/// value for diagnostics through [`ChildExitNotifier::unavailable_reason`].
pub(crate) enum ChildExitNotifierUnavailable {
    /// The child did not expose a PID when the notifier was opened.
    MissingPid,
    #[cfg(not(target_os = "linux"))]
    /// The current platform does not provide pidfd-based notification.
    Unsupported,
    #[cfg(target_os = "linux")]
    /// Opening a pidfd for the child failed.
    OpenFailed(io::Error),
    #[cfg(target_os = "linux")]
    /// Registering the pidfd with Tokio's async runtime failed.
    RegisterFailed(io::Error),
    #[cfg(test)]
    /// The unavailable state was forced by a test.
    ForcedForTest,
}

impl fmt::Display for ChildExitNotifierUnavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPid => f.write_str("child PID is unavailable"),
            #[cfg(not(target_os = "linux"))]
            Self::Unsupported => f.write_str("pidfd is unsupported on this platform"),
            #[cfg(target_os = "linux")]
            Self::OpenFailed(error) => write!(f, "pidfd_open failed: {error}"),
            #[cfg(target_os = "linux")]
            Self::RegisterFailed(error) => write!(f, "pidfd async registration failed: {error}"),
            #[cfg(test)]
            Self::ForcedForTest => f.write_str("pidfd forced unavailable for test"),
        }
    }
}

impl ChildExitNotifier {
    /// Opens a best-effort exit notifier for `child` without taking ownership of it.
    ///
    /// A missing PID or pidfd setup failure is represented by an unavailable
    /// notifier. On non-Linux platforms, the notifier is always unavailable.
    /// Callers must check [`Self::is_available`] and retain their explicit child
    /// wait fallback.
    pub(crate) fn open(pid: Option<u32>) -> Self {
        let Some(pid) = pid else {
            return Self::unavailable(ChildExitNotifierUnavailable::MissingPid);
        };
        Self::open_for_pid(pid)
    }

    /// Returns whether this notifier can provide pidfd-backed exit notification.
    ///
    /// `false` means that [`Self::wait_for_exit`] cannot be used as the exit
    /// observation path and does not mean that the child has exited.
    pub(crate) fn is_available(&self) -> bool {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(_) => true,
            ChildExitNotifierInner::Unavailable(_) => false,
        }
    }

    /// Returns the reason pidfd-backed notification is unavailable, if any.
    ///
    /// The reason is diagnostic only; it is not a child exit status or a
    /// replacement for waiting on the child.
    pub(crate) fn unavailable_reason(&self) -> Option<&ChildExitNotifierUnavailable> {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(_) => None,
            ChildExitNotifierInner::Unavailable(reason) => Some(reason),
        }
    }

    /// Waits for the child to reach the pre-reap exit-notification point.
    ///
    /// On Linux, pidfd readability indicates that the process has exited, but
    /// this method does not reap the child, consume its exit status, or transfer
    /// ownership of [`tokio::process::Child`]. The caller must still call
    /// [`tokio::process::Child::wait`] explicitly.
    ///
    /// This pre-reap point lets callers perform work that must happen before
    /// reaping, such as process-group cleanup or draining child output. If the
    /// notifier is unavailable, or notification fails, callers must use their
    /// explicit fallback instead.
    pub(crate) async fn wait_for_exit(&self) -> io::Result<()> {
        match &self.inner {
            #[cfg(target_os = "linux")]
            ChildExitNotifierInner::PidFd(pidfd) => {
                let _ready = pidfd.readable().await?;
                Ok(())
            }
            ChildExitNotifierInner::Unavailable(reason) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                reason.to_string(),
            )),
        }
    }

    fn unavailable(reason: ChildExitNotifierUnavailable) -> Self {
        Self {
            inner: ChildExitNotifierInner::Unavailable(reason),
        }
    }

    #[cfg(target_os = "linux")]
    fn open_for_pid(pid: u32) -> Self {
        match process_launch::asynchronous::open_pidfd(pid) {
            Ok(pidfd) => match tokio::io::unix::AsyncFd::new(pidfd) {
                Ok(pidfd) => Self {
                    inner: ChildExitNotifierInner::PidFd(pidfd),
                },
                Err(error) => {
                    Self::unavailable(ChildExitNotifierUnavailable::RegisterFailed(error))
                }
            },
            Err(error) => Self::unavailable(ChildExitNotifierUnavailable::OpenFailed(error)),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn open_for_pid(_pid: u32) -> Self {
        Self::unavailable(ChildExitNotifierUnavailable::Unsupported)
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_test() -> Self {
        Self::unavailable(ChildExitNotifierUnavailable::ForcedForTest)
    }

    #[cfg(test)]
    pub(crate) fn available_for_current_process_for_test() -> bool {
        Self::open_for_pid(std::process::id()).is_available()
    }
}
