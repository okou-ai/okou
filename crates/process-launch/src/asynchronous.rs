//! Tokio ownership for direct children without a waiting thread per process.

use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::io::unix::AsyncFd;
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};

use crate::{Command, SpawnOptions};

// Host managed launches share admission only through preparation and clone3.
// Guest synchronous launches do not participate in this queue.
static LAUNCH_ADMISSION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

enum Backend {
    Standard(tokio::process::Child),
    Direct {
        child: crate::Child,
        pidfd: AsyncFd<OwnedFd>,
    },
}

/// The child, its pipes, and the sole authority to reap it.
///
/// Dropping a direct child kills its process group and retains wait ownership
/// until it is reaped. Ordinary waits use pidfd readiness, not blocking threads.
pub struct Child {
    backend: Option<Backend>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl From<tokio::process::Child> for Child {
    fn from(mut child: tokio::process::Child) -> Self {
        Self {
            stdin: child.stdin.take(),
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            backend: Some(Backend::Standard(child)),
        }
    }
}

impl TryFrom<crate::Child> for Child {
    type Error = io::Error;

    /// Adopt an owned child into pidfd-backed Tokio ownership.
    ///
    /// The child must be unreaped and lead its own process group. Requires a
    /// current Tokio runtime with I/O enabled. Registration or pipe-conversion
    /// failure (including unwinding) kills and reaps the child before returning.
    fn try_from(child: crate::Child) -> io::Result<Self> {
        if child.is_reaped() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot adopt an already reaped child",
            ));
        }
        let mut guard = SpawnGuard(Some(child));
        let child = guard.0.as_mut().ok_or_else(missing_child)?;
        // SAFETY: AsyncFd owns the pidfd and keeps its descriptor unchanged until drop.
        let pidfd = unsafe { AsyncFd::register(open_pidfd(child.id())?) }?;
        let stdin = child.stdin.take().map(ChildStdin::from_std).transpose()?;
        let stdout = child.stdout.take().map(ChildStdout::from_std).transpose()?;
        let stderr = child.stderr.take().map(ChildStderr::from_std).transpose()?;
        let child = guard.0.take().ok_or_else(missing_child)?;
        Ok(Self {
            backend: Some(Backend::Direct { child, pidfd }),
            stdin,
            stdout,
            stderr,
        })
    }
}

/// Wait for cancellable admission, then create and adopt a direct child.
///
/// A single five-second budget covers queueing through exec acknowledgement.
/// Dropping a queued future prevents launch. Exec acknowledgement yields; a
/// cancelled pending child is killed and reaped before returning to its caller.
/// Synchronous preparation, clone and abnormal reap cannot be forcibly interrupted.
pub async fn spawn(
    command: Command,
    cgroup: BorrowedFd<'_>,
    options: SpawnOptions<'_>,
) -> io::Result<Child> {
    spawn_with_admission(
        command,
        cgroup,
        options,
        &LAUNCH_ADMISSION,
        Instant::now() + crate::spawn::EXEC_HANDSHAKE_TIMEOUT,
    )
    .await
}

async fn spawn_with_admission(
    command: Command,
    cgroup: BorrowedFd<'_>,
    options: SpawnOptions<'_>,
    admission: &tokio::sync::Mutex<()>,
    deadline: Instant,
) -> io::Result<Child> {
    tokio::runtime::Handle::try_current().map_err(io::Error::other)?;
    let permit =
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), admission.lock())
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "process launch admission timed out",
                )
            })?;
    let pending =
        crate::spawn::spawn_with_admission(command, cgroup, options, permit, Some(deadline))?;
    Child::try_from(acknowledge_exec(pending, deadline).await?)
}

async fn acknowledge_exec(
    pending: crate::spawn::PendingChild,
    deadline: Instant,
) -> io::Result<crate::Child> {
    let reader = &pending.error_reader;
    // Only the parent's error-pipe reader becomes nonblocking. The child's
    // distinct writer retains the existing atomic errno write protocol.
    // SAFETY: reader owns a live descriptor for both fcntl calls.
    let flags = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: reader borrows pending's live, unchanged pipe descriptor. The
    // registration is dropped before pending, including on cancellation.
    let pipe =
        unsafe { AsyncFd::register_with_interest(reader.as_fd(), tokio::io::Interest::READABLE) }?;
    loop {
        if Instant::now() >= deadline {
            return Err(exec_timeout());
        }
        let mut ready =
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), pipe.readable())
                .await
                .map_err(|_| exec_timeout())??;
        if Instant::now() >= deadline {
            return Err(exec_timeout());
        }
        match ready.try_io(|_| crate::spawn::read_exec_result(reader)) {
            Ok(Ok(result)) => {
                result.into_result()?;
                break;
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error),
            Err(_would_block) => {}
        }
    }
    drop(pipe);
    pending.finish()
}

fn exec_timeout() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "process exec handshake timed out")
}

struct SpawnGuard(Option<crate::Child>);

impl Drop for SpawnGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            // Adoption has not transferred the caller's placement lease yet.
            // As with PendingChild, finish reaping before returning or unwinding
            // so registration/pipe failures cannot release an occupied cgroup.
            let _ = child.kill_and_reap();
        }
    }
}

fn missing_child() -> io::Error {
    io::Error::other("child ownership already released")
}

impl Child {
    pub fn id(&self) -> Option<u32> {
        match self.backend.as_ref()? {
            Backend::Standard(child) => child.id(),
            Backend::Direct { child, .. } => (!child.is_reaped()).then(|| child.id()),
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self.backend_mut()? {
            Backend::Standard(child) => child.try_wait(),
            Backend::Direct { child, .. } => child.try_wait(),
        }
    }

    /// Borrow notification of exit without reaping or closing stdin.
    ///
    /// Direct children reuse their registered pidfd without opening, duplicating,
    /// or registering another descriptor. Standard Tokio children and already
    /// reaped children return `None`; callers retain their explicit wait policy.
    /// The future is cancellation-safe and may be recreated after cancellation
    /// or completion. The child remains the sole reaper and must still be waited
    /// on after any cleanup that requires its unreaped process-group identity.
    pub fn exit_notification(&self) -> Option<impl Future<Output = io::Result<()>> + '_> {
        match self.backend.as_ref()? {
            Backend::Direct { child, pidfd } if !child.is_reaped() => {
                Some(observe_exit(pidfd, child.id()))
            }
            _ => None,
        }
    }

    /// Cancellation-safe: readiness never consumes the exit status.
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        drop(self.stdin.take());
        match self.backend_mut()? {
            Backend::Standard(child) => child.wait().await,
            Backend::Direct { child, pidfd } => loop {
                if let Some(status) = child.try_wait()? {
                    return Ok(status);
                }
                let mut ready = pidfd.readable().await?;
                if let Some(status) = child.try_wait()? {
                    return Ok(status);
                }
                ready.clear_ready();
            },
        }
    }

    pub fn start_kill(&mut self) -> io::Result<()> {
        match self.backend_mut()? {
            Backend::Standard(child) => child.start_kill(),
            Backend::Direct { child, .. } => child.kill(),
        }
    }

    pub async fn kill(&mut self) -> io::Result<()> {
        self.start_kill()?;
        self.wait().await?;
        Ok(())
    }

    fn backend_mut(&mut self) -> io::Result<&mut Backend> {
        self.backend.as_mut().ok_or_else(missing_child)
    }
}

async fn observe_exit(pidfd: &AsyncFd<OwnedFd>, pid: u32) -> io::Result<()> {
    loop {
        let mut ready = pidfd.readable().await?;
        // SAFETY: waitid initializes this plain C output structure. WNOWAIT
        // observes only our unreaped child and does not consume its exit status.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // SAFETY: a successful waitid initializes the child-status fields.
        if unsafe { info.si_pid() } != 0 {
            return Ok(());
        }
        // Tokio readiness may be spurious; only actual exit permits cleanup.
        ready.clear_ready();
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        let Some(Backend::Direct { child, .. }) = self.backend.take() else {
            return;
        };
        kill_and_reap_on_drop(child);
    }
}

fn kill_and_reap_on_drop(mut child: crate::Child) {
    if child.is_reaped() {
        return;
    }
    // SAFETY: this unreaped child still owns the process-group ID.
    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
    let _ = child.kill();
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    // A failed thread creation drops its closure. Keep a second owner of
    // the handoff slot so that failure cannot discard an unreaped child.
    let pending = Arc::new(Mutex::new(Some(child)));
    let worker = Arc::clone(&pending);
    if std::thread::Builder::new()
        .name("process-launch-reap".into())
        .spawn(move || reap_pending(&worker))
        .is_err()
    {
        reap_pending(&pending);
    }
}

fn reap_pending(pending: &Mutex<Option<crate::Child>>) {
    let child = pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(mut child) = child {
        let _ = child.wait();
    }
}

/// Open a pre-reap notification descriptor for a PID still owned by the caller.
pub fn open_pidfd(pid: u32) -> io::Result<OwnedFd> {
    let pid = i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid child PID"))?;
    // SAFETY: pidfd_open has no pointer arguments and transfers a fresh FD.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful syscall returned a new, uniquely owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) })
}

#[cfg(test)]
mod tests;
