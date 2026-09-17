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
        let pidfd = AsyncFd::new(open_pidfd(child.id())?)?;
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
    // The borrowed descriptor cannot outlive pending. Registration and its
    // destructor run while the child/pipe owner still guards cancellation.
    let pipe = AsyncFd::with_interest(reader.as_fd(), tokio::io::Interest::READABLE)?;
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
mod tests {
    use super::*;
    use crate::Stdio;
    use std::fs::File;
    use std::future::{Future, poll_fn};
    use std::io::Read;
    use std::os::fd::AsFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::pin::Pin;
    use std::task::Poll;
    use std::time::Duration;

    #[tokio::test]
    async fn exit_notification_can_be_cancelled_and_repeated_before_wait() {
        use tokio::io::AsyncWriteExt;

        let process = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "read -r line && test \"$line\" = go && exit 23; exit 42",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut child = Child::try_from(crate::Child::from(process)).unwrap();
        let pid = child.id().unwrap();
        let mut notification = Box::pin(child.exit_notification().unwrap());
        poll_fn(|cx| {
            assert!(notification.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(notification);

        // Cancellation must leave stdin usable and the child owned by its caller.
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"go\n")
            .await
            .unwrap();
        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(2), child.exit_notification().unwrap())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(child.id(), Some(pid));
        // SAFETY: waitid observes this exact child without consuming its status.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            0
        );
        // SAFETY: successful waitid initialized the child status fields.
        assert_eq!(unsafe { info.si_pid() }, pid as i32);
        assert_eq!(unsafe { info.si_status() }, 23);

        let status = child.wait().await.unwrap();
        assert_eq!(status.code(), Some(23));
        assert_eq!(child.wait().await.unwrap(), status);
        assert!(child.exit_notification().is_none());
        assert_reaped(pid);
    }

    #[tokio::test]
    async fn standard_child_keeps_its_explicit_wait_policy() {
        let process = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 17"])
            .spawn()
            .unwrap();
        let mut child = Child::from(process);
        assert!(child.exit_notification().is_none());
        assert_eq!(child.wait().await.unwrap().code(), Some(17));
    }

    #[test]
    fn adoption_registration_panic_reaps_the_owned_child() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let process = std::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = process.id();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async { Child::try_from(crate::Child::from(process)) })
        }));
        assert!(result.is_err());
        assert_reaped(pid);
    }

    fn pending_child() -> (crate::spawn::PendingChild, File, u32) {
        let (reader, writer) = std::io::pipe().unwrap();
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        (
            crate::spawn::PendingChild::new(child.into(), File::from(OwnedFd::from(reader))),
            File::from(OwnedFd::from(writer)),
            pid,
        )
    }

    fn assert_reaped(pid: u32) {
        // SAFETY: waitpid only observes the exact test-owned child; WNOHANG
        // bounds a failed assertion. Cleanup must already have consumed status.
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }

    #[tokio::test]
    async fn pending_acknowledgement_yields_and_transfers_child_on_eof() {
        let (pending, writer, pid) = pending_child();
        let mut ack = Box::pin(acknowledge_exec(
            pending,
            Instant::now() + Duration::from_secs(5),
        ));
        poll_fn(|cx| {
            assert!(ack.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        // On this single-thread runtime, the writer can only be closed if the
        // pending acknowledgement released the worker.
        tokio::spawn(async move { drop(writer) }).await.unwrap();
        let child = ack.await.unwrap();
        assert_eq!(child.id(), pid);
        child.kill_and_reap().unwrap();
        assert_reaped(pid);
    }

    #[tokio::test]
    async fn dropping_pending_acknowledgement_reaps_before_returning() {
        let (pending, _writer, pid) = pending_child();
        let mut ack = Box::pin(acknowledge_exec(
            pending,
            Instant::now() + Duration::from_secs(5),
        ));
        poll_fn(|cx| {
            assert!(ack.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(ack);
        assert_reaped(pid);
    }

    #[test]
    fn failed_adoption_reaps_before_returning_or_unwinding() {
        for unwind in [false, true] {
            let (pending, writer, pid) = pending_child();
            drop(writer);
            let child = pending.finish().unwrap();
            let result = std::panic::catch_unwind(|| {
                let _guard = SpawnGuard(Some(child));
                if unwind {
                    panic!("adoption failed before ownership transfer");
                }
                Err::<(), _>(io::Error::other("adoption failed"))
            });
            if unwind {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().is_err());
            }
            assert_reaped(pid);
        }
    }

    #[tokio::test]
    async fn pending_acknowledgement_deadline_kills_and_reaps() {
        let (pending, _writer, pid) = pending_child();
        let error = acknowledge_exec(pending, Instant::now() + Duration::from_millis(50))
            .await
            .err()
            .expect("held exec pipe must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_reaped(pid);

        let (pending, writer, pid) = pending_child();
        drop(writer);
        let error = acknowledge_exec(pending, Instant::now() - Duration::from_secs(1))
            .await
            .err()
            .expect("ready EOF must not override an expired budget");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_reaped(pid);
    }

    #[tokio::test]
    async fn exec_error_records_reject_and_reap_the_pending_child() {
        use std::io::Write;

        for bytes in [
            libc::ENOENT.to_ne_bytes().to_vec(),
            libc::EINTR.to_ne_bytes().to_vec(),
            libc::EAGAIN.to_ne_bytes().to_vec(),
            vec![1, 2],
        ] {
            let (pending, mut writer, pid) = pending_child();
            writer.write_all(&bytes).unwrap();
            drop(writer);
            let error = acknowledge_exec(pending, Instant::now() + Duration::from_secs(5))
                .await
                .err()
                .expect("exec failure must not return a child");
            if bytes.len() == size_of::<i32>() {
                assert_eq!(
                    error.raw_os_error(),
                    Some(i32::from_ne_bytes(bytes.try_into().unwrap()))
                );
            } else {
                assert_eq!(error.to_string(), "incomplete process exec error");
            }
            assert_reaped(pid);
        }
    }

    #[tokio::test]
    async fn aborting_pending_acknowledgement_reaps_before_join() {
        let (pending, _writer, pid) = pending_child();
        let (queued, observed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut ack = Box::pin(acknowledge_exec(
                pending,
                Instant::now() + Duration::from_secs(5),
            ));
            poll_fn(|cx| {
                assert!(ack.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            queued.send(()).unwrap();
            ack.await
        });
        observed.await.unwrap();
        task.abort();
        assert!(
            task.await
                .err()
                .expect("pending task must be cancelled")
                .is_cancelled()
        );
        assert_reaped(pid);
    }

    #[test]
    fn reactor_registration_panic_reaps_pending_child() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let (pending, _writer, pid) = pending_child();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(acknowledge_exec(
                pending,
                Instant::now() + Duration::from_secs(5),
            ))
        }));
        assert!(result.is_err());
        assert_reaped(pid);
    }

    async fn poll_queued(future: Pin<&mut impl Future<Output = io::Result<Child>>>) {
        let mut future = future;
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    fn command_with_owned_pipe() -> (Command, UnixStream) {
        let (owned, peer) = UnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        let mut command = Command::new("/bin/true");
        command.stdin(Stdio::Owned(owned.into()));
        (command, peer)
    }

    async fn assert_pipe_closed(peer: UnixStream) {
        use tokio::io::AsyncReadExt;

        // Concurrent process tests can inherit a CLOEXEC descriptor briefly
        // between fork and exec. Observe closure with a bound instead of assuming
        // no other test has a transient copy when this task finishes dropping it.
        let mut peer = tokio::net::UnixStream::from_std(peer).unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte))
                .await
                .expect("cancelled launch must release its pipe")
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn dropping_a_queued_launch_releases_its_resources() {
        let directory = File::open("/").unwrap();
        let admission = tokio::sync::Mutex::new(());
        let held = admission.lock().await;
        let (command, mut peer) = command_with_owned_pipe();
        let mut spawn = Box::pin(spawn_with_admission(
            command,
            directory.as_fd(),
            SpawnOptions::default(),
            &admission,
            Instant::now() + Duration::from_secs(5),
        ));
        poll_queued(spawn.as_mut()).await;
        assert_eq!(
            peer.read(&mut [0]).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );

        drop(spawn);
        assert_pipe_closed(peer).await;
        drop(held);
        assert!(admission.try_lock().is_ok());
    }

    #[tokio::test]
    async fn queued_launch_times_out_without_waiting_for_admission_release() {
        let directory = File::open("/").unwrap();
        let admission = tokio::sync::Mutex::new(());
        let held = admission.lock().await;
        let (command, peer) = command_with_owned_pipe();
        let mut spawn = Box::pin(spawn_with_admission(
            command,
            directory.as_fd(),
            SpawnOptions::default(),
            &admission,
            Instant::now() + Duration::from_millis(50),
        ));
        poll_queued(spawn.as_mut()).await;
        let error = tokio::time::timeout(Duration::from_secs(1), spawn)
            .await
            .expect("queue deadline must resolve while the permit is held")
            .err()
            .expect("queued launch must time out");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_pipe_closed(peer).await;
        drop(held);
        assert!(admission.try_lock().is_ok());
    }

    #[tokio::test]
    async fn aborting_a_queued_task_does_not_leave_a_detached_spawn() {
        let admission = Arc::new(tokio::sync::Mutex::new(()));
        let held = admission.lock().await;
        let task_admission = Arc::clone(&admission);
        let (command, peer) = command_with_owned_pipe();
        let (queued, observed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let directory = File::open("/").unwrap();
            let mut spawn = Box::pin(spawn_with_admission(
                command,
                directory.as_fd(),
                SpawnOptions::default(),
                &task_admission,
                Instant::now() + Duration::from_secs(5),
            ));
            poll_queued(spawn.as_mut()).await;
            queued.send(()).unwrap();
            spawn.await
        });
        observed.await.unwrap();
        task.abort();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("abort must complete while the permit is held")
            .err()
            .expect("queued task must be cancelled");
        assert!(error.is_cancelled());
        assert_pipe_closed(peer).await;
        drop(held);
        assert!(admission.try_lock().is_ok());
    }

    #[tokio::test]
    async fn ready_admission_does_not_override_an_expired_deadline() {
        let directory = File::open("/").unwrap();
        let admission = tokio::sync::Mutex::new(());
        let mut command = Command::new("/bin/true");
        command.arg("invalid\0argument");
        let error = spawn_with_admission(
            command,
            directory.as_fd(),
            SpawnOptions::default(),
            &admission,
            Instant::now() - Duration::from_secs(1),
        )
        .await
        .err()
        .expect("expired admission must not prepare or spawn");
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(admission.try_lock().is_ok());
    }

    #[tokio::test]
    async fn preparation_and_clone_errors_release_admission() {
        let directory = File::open("/").unwrap();
        let admission = tokio::sync::Mutex::new(());
        for malformed in [true, false] {
            let mut command = Command::new("/bin/true");
            if malformed {
                command.arg("invalid\0argument");
            }
            let error = spawn_with_admission(
                command,
                directory.as_fd(),
                SpawnOptions::default(),
                &admission,
                Instant::now() + Duration::from_secs(5),
            )
            .await
            .err()
            .expect("malformed input or non-cgroup directory must reject launch");
            if malformed {
                assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            } else {
                assert!(error.raw_os_error().is_some(), "{error}");
            }
            assert!(admission.try_lock().is_ok());
        }
    }
}
