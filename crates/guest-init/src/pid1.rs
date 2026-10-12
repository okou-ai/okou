//! Event-driven signal handling and child supervision for PID 1.
//!
//! `SIGCHLD`, `SIGTERM`, and `SIGINT` are blocked before `fork()` so PID 1 can
//! synchronously wait for them without a race between checking child state and
//! going to sleep. The child restores the pre-existing mask before running
//! `guest-control-server`.

use std::time::{Duration, Instant};

use nix::errno::Errno;
use nix::sys::signal::{SaFlags, SigAction, SigHandler, SigSet, SigmaskHow, Signal, sigaction};

/// Signals consumed synchronously by the PID 1 supervision loop.
pub struct SignalContext {
    wait_set: SigSet,
    child_mask: SigSet,
}

impl SignalContext {
    /// Configure inherited ignored dispositions and block supervised signals.
    ///
    /// This must run before `fork()` so a child exit or shutdown request cannot
    /// arrive before PID 1 is ready to wait for it.
    pub fn setup() -> Result<Self, Errno> {
        let ignore = SigAction::new(SigHandler::SigIgn, SaFlags::empty(), SigSet::empty());
        for signal in [Signal::SIGTTIN, Signal::SIGTTOU, Signal::SIGPIPE] {
            // SAFETY: the action contains SIG_IGN, so it cannot invoke an
            // invalid function pointer.
            unsafe {
                sigaction(signal, &ignore)?;
            }
        }

        Self::block()
    }

    fn block() -> Result<Self, Errno> {
        let wait_set = Signal::SIGCHLD | Signal::SIGTERM | Signal::SIGINT;
        let child_mask = wait_set.thread_swap_mask(SigmaskHow::SIG_BLOCK)?;
        Ok(Self {
            wait_set,
            child_mask,
        })
    }

    /// Restore the signal mask inherited by the child during `fork()`.
    pub fn restore_child_mask(&self) -> Result<(), Errno> {
        self.child_mask.thread_set_mask()
    }

    fn wait(&self) -> Result<Signal, Errno> {
        self.wait_set.wait()
    }

    fn wait_timeout(&self, timeout: Duration) -> Result<SignalWait, Errno> {
        let timeout = libc::timespec {
            tv_sec: timeout.as_secs().try_into().map_err(|_| Errno::EINVAL)?,
            tv_nsec: timeout.subsec_nanos().into(),
        };
        // SAFETY: wait_set and timeout are initialized and remain valid for the
        // duration of the call. The signal information is intentionally unused.
        let result =
            unsafe { libc::sigtimedwait(self.wait_set.as_ref(), std::ptr::null_mut(), &timeout) };
        if result >= 0 {
            return Signal::try_from(result)
                .map(SignalWait::Received)
                .map_err(|_| Errno::EINVAL);
        }

        match Errno::last() {
            Errno::EAGAIN => Ok(SignalWait::TimedOut),
            error => Err(error),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SignalWait {
    Received(Signal),
    TimedOut,
}

fn decode_wait_status(status: libc::c_int) -> i32 {
    // SAFETY: libc status macros are used only with a status produced by waitpid.
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

fn wait_blocking_with<F>(pid: libc::pid_t, mut wait: F) -> Result<i32, Errno>
where
    F: FnMut(&mut libc::c_int) -> Result<libc::pid_t, Errno>,
{
    loop {
        let mut status: libc::c_int = 0;
        match wait(&mut status) {
            Ok(result) if result == pid => return Ok(decode_wait_status(status)),
            Ok(_) => return Err(Errno::ECHILD),
            Err(Errno::EINTR) => {}
            Err(error) => return Err(error),
        }
    }
}

fn wait_blocking(pid: libc::pid_t) -> Result<i32, Errno> {
    wait_blocking_with(pid, |status| {
        // SAFETY: pid is a valid child PID; status is written on success.
        let result = unsafe { libc::waitpid(pid, status, 0) };
        if result == -1 {
            Err(Errno::last())
        } else {
            Ok(result)
        }
    })
}

fn reap_zombies(watched_pid: libc::pid_t) -> Result<Option<i32>, Errno> {
    let mut watched_exit = None;

    loop {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid(-1) is valid; status is initialized before use on success.
        let result = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if result > 0 {
            if result == watched_pid {
                watched_exit = Some(decode_wait_status(status));
            }
            continue;
        }
        if result == 0 {
            return Ok(watched_exit);
        }

        match Errno::last() {
            Errno::ECHILD => return Ok(watched_exit),
            Errno::EINTR => {}
            error => return Err(error),
        }
    }
}

fn send_signal(pid: libc::pid_t, signal: Signal) -> Result<(), Errno> {
    // SAFETY: pid identifies the supervised child and signal is valid.
    let result = unsafe { libc::kill(pid, signal as libc::c_int) };
    if result == 0 {
        Ok(())
    } else {
        Err(Errno::last())
    }
}

fn shutdown(
    signals: &SignalContext,
    child_pid: libc::pid_t,
    grace_period: Duration,
) -> Result<i32, Errno> {
    eprintln!("[guest-init] Shutdown requested, sending SIGTERM to guest-control-server");
    let deadline = Instant::now() + grace_period;
    send_signal(child_pid, Signal::SIGTERM)?;

    if let Some(exit_code) = reap_zombies(child_pid)? {
        return Ok(exit_code);
    }

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        match signals.wait_timeout(remaining) {
            Ok(SignalWait::Received(Signal::SIGCHLD)) => {
                if let Some(exit_code) = reap_zombies(child_pid)? {
                    return Ok(exit_code);
                }
            }
            Ok(SignalWait::Received(Signal::SIGTERM | Signal::SIGINT)) | Err(Errno::EINTR) => {}
            Ok(SignalWait::TimedOut) => break,
            Ok(SignalWait::Received(_)) => return Err(Errno::EINVAL),
            Err(error) => return Err(error),
        }
    }

    if let Some(exit_code) = reap_zombies(child_pid)? {
        return Ok(exit_code);
    }

    eprintln!("[guest-init] guest-control-server did not exit after SIGTERM, sending SIGKILL");
    send_signal(child_pid, Signal::SIGKILL)?;
    wait_blocking(child_pid)
}

/// Wait for the supervised child to exit while reaping all orphaned children.
pub fn supervise(
    signals: &SignalContext,
    child_pid: libc::pid_t,
    grace_period: Duration,
) -> Result<i32, Errno> {
    loop {
        match signals.wait()? {
            Signal::SIGCHLD => {
                if let Some(exit_code) = reap_zombies(child_pid)? {
                    return Ok(exit_code);
                }
            }
            Signal::SIGTERM | Signal::SIGINT => {
                // Prefer an already-available child exit over initiating
                // shutdown when exit and shutdown signals arrive together.
                if let Some(exit_code) = reap_zombies(child_pid)? {
                    return Ok(exit_code);
                }
                return shutdown(signals, child_pid, grace_period);
            }
            _ => return Err(Errno::EINVAL),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::process::Command;
    use std::sync::{Mutex, mpsc};
    use std::thread;

    static PID1_TEST_LOCK: Mutex<()> = Mutex::new(());
    const SIGNAL_SETUP_CHILD_TEST: &str = "pid1::tests::setup_ignores_inherited_signals_child";

    struct ChildGuard {
        pid: libc::pid_t,
        reaped: bool,
    }

    impl ChildGuard {
        fn new(pid: libc::pid_t) -> Self {
            Self { pid, reaped: false }
        }

        fn pid(&self) -> libc::pid_t {
            self.pid
        }

        fn disarm(&mut self) {
            self.reaped = true;
        }
    }

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if self.reaped {
                return;
            }
            // SAFETY: pid belongs to a child created by this test helper. Cleanup
            // is best-effort and handles already-exited or already-reaped children.
            unsafe {
                let _ = libc::kill(self.pid, libc::SIGKILL);
                let mut status: libc::c_int = 0;
                loop {
                    let result = libc::waitpid(self.pid, &mut status, 0);
                    if result == self.pid {
                        break;
                    }
                    if result == -1 && Errno::last() == Errno::EINTR {
                        continue;
                    }
                    break;
                }
            }
        }
    }

    fn fork_exiting_child(exit_code: libc::c_int) -> ChildGuard {
        // SAFETY: the child calls only _exit after fork.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed with errno {}", Errno::last());
        if pid == 0 {
            // SAFETY: _exit is async-signal-safe and avoids running Rust destructors
            // in the forked child.
            unsafe {
                libc::_exit(exit_code);
            }
        }
        ChildGuard::new(pid)
    }

    fn fork_paused_child(child_mask: &SigSet, ignore_sigterm: bool) -> ChildGuard {
        let mut fds = [0; 2];
        // SAFETY: fds points to two valid integers for pipe to initialize.
        let pipe_result = unsafe { libc::pipe(fds.as_mut_ptr()) };
        assert_eq!(pipe_result, 0, "pipe failed with errno {}", Errno::last());

        // SAFETY: the child uses only async-signal-safe libc calls before _exit.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            // SAFETY: both fds were initialized by pipe above.
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            panic!("fork failed with errno {}", Errno::last());
        }

        if pid == 0 {
            // SAFETY: this is the forked child path. It uses raw libc calls and
            // exits through _exit to avoid running Rust destructors.
            unsafe {
                libc::close(fds[0]);
                if libc::sigprocmask(libc::SIG_SETMASK, child_mask.as_ref(), std::ptr::null_mut())
                    != 0
                {
                    libc::_exit(124);
                }
                let sigterm_disposition = if ignore_sigterm {
                    libc::SIG_IGN
                } else {
                    libc::SIG_DFL
                };
                if libc::signal(libc::SIGTERM, sigterm_disposition) == libc::SIG_ERR {
                    libc::_exit(125);
                }
                let ready = [1_u8];
                let written = libc::write(fds[1], ready.as_ptr().cast(), ready.len());
                libc::close(fds[1]);
                if written != 1 {
                    libc::_exit(126);
                }
                loop {
                    libc::pause();
                }
            }
        }

        // SAFETY: parent owns both raw fds after fork; close the unused write end.
        unsafe {
            libc::close(fds[1]);
        }
        // SAFETY: parent still owns the read fd and transfers it to OwnedFd.
        let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        let child = ChildGuard::new(pid);
        wait_for_child_ready(&read_fd);
        child
    }

    fn wait_for_child_ready(read_fd: &OwnedFd) {
        let mut ready = [0_u8];
        // SAFETY: read_fd is a valid pipe read end and ready points to writable memory.
        let result =
            unsafe { libc::read(read_fd.as_raw_fd(), ready.as_mut_ptr().cast(), ready.len()) };
        assert_eq!(result, 1, "read failed with errno {}", Errno::last());
    }

    fn wait_until_waitable(pid: libc::pid_t) -> Result<(), Errno> {
        loop {
            // SAFETY: zeroed siginfo_t is valid for waitid to fill.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: pid is a child created by this test. WNOWAIT observes its
            // waitable status without reaping it.
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(());
            }
            match Errno::last() {
                Errno::EINTR => {}
                error => return Err(error),
            }
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    enum ReapCheck {
        AlreadyReaped,
        ReapedDuringCheck,
        StillPresent,
    }

    fn check_child_reaped(pid: libc::pid_t) -> ReapCheck {
        let mut status: libc::c_int = 0;
        // SAFETY: pid was created by this test. WNOHANG prevents blocking if a
        // regression leaves the child unreaped.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == -1 && Errno::last() == Errno::ECHILD {
            ReapCheck::AlreadyReaped
        } else if result == pid {
            ReapCheck::ReapedDuringCheck
        } else {
            ReapCheck::StillPresent
        }
    }

    fn send_thread_signal(signal: Signal) {
        // SAFETY: pthread_self identifies the calling test thread and signal is
        // blocked there before this helper is used.
        let result = unsafe { libc::pthread_kill(libc::pthread_self(), signal as libc::c_int) };
        assert_eq!(result, 0, "pthread_kill failed with errno {result}");
    }

    fn drain_pending_signals(signals: &SignalContext) {
        loop {
            match signals.wait_timeout(Duration::ZERO) {
                Ok(SignalWait::Received(_)) | Err(Errno::EINTR) => {}
                Ok(SignalWait::TimedOut) => return,
                Err(error) => panic!("sigtimedwait failed with errno {error}"),
            }
        }
    }

    fn finish_signal_test(signals: &SignalContext) {
        drain_pending_signals(signals);
        signals.restore_child_mask().unwrap();
    }

    struct SignalTestCleanup<'a>(&'a SignalContext);

    impl Drop for SignalTestCleanup<'_> {
        fn drop(&mut self) {
            while let Ok(SignalWait::Received(_)) | Err(Errno::EINTR) =
                self.0.wait_timeout(Duration::ZERO)
            {}
            let _ = self.0.restore_child_mask();
        }
    }

    fn wait_for_child_event(
        read_fd: &OwnedFd,
        expected: u8,
        timeout: Duration,
    ) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("timed out waiting for child event {expected}"));
            }
            let timeout_ms =
                remaining.as_millis().clamp(1, libc::c_int::MAX as u128) as libc::c_int;
            let mut pollfd = libc::pollfd {
                fd: read_fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: pollfd is initialized and read_fd remains open during poll.
            let result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
            if result == 0 || (result == -1 && Errno::last() == Errno::EINTR) {
                continue;
            }
            if result == -1 {
                return Err(format!("poll failed with errno {}", Errno::last()));
            }

            let mut event = 0_u8;
            // SAFETY: read_fd is a valid pipe and event is writable for one byte.
            let result =
                unsafe { libc::read(read_fd.as_raw_fd(), (&mut event as *mut u8).cast(), 1) };
            if result == -1 && Errno::last() == Errno::EINTR {
                continue;
            }
            if result != 1 || event != expected {
                return Err(format!(
                    "expected child event {expected}, read returned {result} with event {event}"
                ));
            }
            return Ok(());
        }
    }

    fn fork_sigterm_observing_child(child_mask: &SigSet) -> (ChildGuard, OwnedFd) {
        let mut fds = [0; 2];
        // SAFETY: fds points to two integers for pipe to initialize.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: pipe initialized these descriptors; each is owned exactly once.
        let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        // SAFETY: the write end is distinct from the owned read end above.
        let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
        let mut mask = *child_mask;
        mask.add(Signal::SIGTERM);
        let mut sigterm = SigSet::empty();
        sigterm.add(Signal::SIGTERM);

        // SAFETY: the child uses only async-signal-safe libc operations before _exit.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed with errno {}", Errno::last());
        if pid == 0 {
            // SAFETY: only raw libc calls run in this child, not Rust destructors
            // or signal-disposition changes in the multithreaded parent.
            unsafe {
                libc::close(read_fd.as_raw_fd());
                if libc::sigprocmask(libc::SIG_SETMASK, mask.as_ref(), std::ptr::null_mut()) != 0
                    || libc::signal(libc::SIGTERM, libc::SIG_DFL) == libc::SIG_ERR
                {
                    libc::_exit(124);
                }
                let ready = 1_u8;
                if libc::write(write_fd.as_raw_fd(), (&ready as *const u8).cast(), 1) != 1 {
                    libc::_exit(125);
                }
                // SIGTERM stays blocked: acknowledge forwarding without exiting
                // or installing an async handler in the test harness.
                loop {
                    let received = libc::sigwaitinfo(sigterm.as_ref(), std::ptr::null_mut());
                    if received == libc::SIGTERM {
                        break;
                    }
                    if received != -1 || *libc::__errno_location() != libc::EINTR {
                        libc::_exit(126);
                    }
                }
                let acknowledged = 2_u8;
                if libc::write(write_fd.as_raw_fd(), (&acknowledged as *const u8).cast(), 1) != 1 {
                    libc::_exit(127);
                }
                libc::close(write_fd.as_raw_fd());
                loop {
                    libc::pause();
                }
            }
        }

        drop(write_fd);
        let child = ChildGuard::new(pid);
        wait_for_child_event(&read_fd, 1, Duration::from_secs(5)).unwrap();
        (child, read_fd)
    }

    fn drive_repeated_shutdown_signals(
        supervisor_thread: libc::pthread_t,
        child_pid: libc::pid_t,
        acknowledgement: OwnedFd,
        finished: mpsc::Receiver<()>,
        grace_period: Duration,
    ) -> Result<usize, String> {
        let result = (|| {
            wait_for_child_event(&acknowledgement, 2, Duration::from_secs(5))?;
            // A generous independent bound, not a tight elapsed-time assertion.
            // It must never be reset by the shutdown events being injected.
            let deadline = Instant::now() + grace_period * 4;
            let mut sent = 0;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("shutdown exceeded the fixed-deadline watchdog".to_owned());
                }
                let signal = if sent % 2 == 0 {
                    Signal::SIGTERM
                } else {
                    Signal::SIGINT
                };
                // SAFETY: the blocked supervisor thread stays alive until this
                // scoped helper is joined, before its original mask is restored.
                let error = unsafe { libc::pthread_kill(supervisor_thread, signal as libc::c_int) };
                if error != 0 {
                    return Err(format!("pthread_kill failed with errno {error}"));
                }
                sent += 1;
                // Cancellation both paces the next event and promptly stops
                // delivery when supervise returns; there are no fixture sleeps.
                match finished.recv_timeout(remaining.min(Duration::from_millis(20))) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(sent),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        })();

        if result.is_err() {
            // Release supervision even when the deadline-reset mutant would
            // otherwise hang. This kill is always reported as a test failure.
            let _ = send_signal(child_pid, Signal::SIGKILL);
            let _ = wait_until_waitable(child_pid);
            // SAFETY: supervisor_thread remains alive and has SIGCHLD blocked.
            unsafe {
                let _ = libc::pthread_kill(supervisor_thread, libc::SIGCHLD);
            }
        }
        result
    }

    #[test]
    fn setup_ignores_inherited_signals_in_isolated_process() {
        // Other PID 1 tests call waitpid(-1), so serialize ownership of this child.
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(SIGNAL_SETUP_CHILD_TEST)
            .arg("--ignored")
            .arg("--nocapture")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(
            stdout.contains(SIGNAL_SETUP_CHILD_TEST),
            "isolated signal setup test did not run\nstatus: {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
            output.status,
        );
        assert!(
            output.status.success(),
            "isolated signal setup test failed\nstatus: {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
            output.status,
        );
    }

    #[test]
    #[ignore = "run through the process-isolated parent test"]
    fn setup_ignores_inherited_signals_child() {
        let default = SigAction::new(SigHandler::SigDfl, SaFlags::empty(), SigSet::empty());
        for signal in [Signal::SIGTTIN, Signal::SIGTTOU, Signal::SIGPIPE] {
            // SAFETY: the action contains SIG_DFL, so it cannot invoke an
            // invalid function pointer.
            unsafe {
                sigaction(signal, &default).unwrap();
            }
        }

        let _signals = SignalContext::setup().unwrap();

        for signal in [Signal::SIGTTIN, Signal::SIGTTOU, Signal::SIGPIPE] {
            // SAFETY: the action contains SIG_DFL, so it cannot invoke an
            // invalid function pointer. The returned action was installed by
            // SignalContext::setup().
            let configured = unsafe { sigaction(signal, &default).unwrap() };
            assert!(
                matches!(configured.handler(), SigHandler::SigIgn),
                "{signal:?} was not configured as SIG_IGN",
            );
        }
    }

    #[test]
    fn blocking_and_restoring_signals_preserves_the_original_mask() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let original_mask = SigSet::thread_get_mask().unwrap();
        let signals = SignalContext::block().unwrap();
        let blocked_mask = SigSet::thread_get_mask().unwrap();
        let mut expected_mask = original_mask;
        expected_mask.add(Signal::SIGCHLD);
        expected_mask.add(Signal::SIGTERM);
        expected_mask.add(Signal::SIGINT);

        assert_eq!(blocked_mask, expected_mask);

        signals.restore_child_mask().unwrap();
        assert_eq!(SigSet::thread_get_mask().unwrap(), original_mask);
    }

    #[test]
    fn synchronously_waits_for_shutdown_signals() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let signals = SignalContext::block().unwrap();

        send_thread_signal(Signal::SIGTERM);
        assert_eq!(signals.wait().unwrap(), Signal::SIGTERM);
        send_thread_signal(Signal::SIGINT);
        assert_eq!(signals.wait().unwrap(), Signal::SIGINT);

        finish_signal_test(&signals);
    }

    #[test]
    fn wait_loop_retries_after_eintr() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut calls = 0;

        let exit_code = wait_blocking_with(123, |status| {
            calls += 1;
            if calls == 1 {
                Err(Errno::EINTR)
            } else {
                *status = 0;
                Ok(123)
            }
        });

        assert_eq!(exit_code, Ok(0));
        assert_eq!(calls, 2);
    }

    #[test]
    fn wait_loop_propagates_non_eintr_error() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();

        let exit_code = wait_blocking_with(123, |_status| Err(Errno::ECHILD));

        assert_eq!(exit_code, Err(Errno::ECHILD));
    }

    #[test]
    fn wait_blocking_returns_normal_child_exit_code() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut child = fork_exiting_child(42);

        let exit_code = wait_blocking(child.pid());
        child.disarm();

        assert_eq!(exit_code, Ok(42));
    }

    #[test]
    fn wait_blocking_maps_signal_exit_code() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let child_mask = SigSet::thread_get_mask().unwrap();
        let mut child = fork_paused_child(&child_mask, false);
        // SAFETY: pid belongs to the paused child created by this test.
        let kill_result = unsafe { libc::kill(child.pid(), libc::SIGKILL) };
        assert_eq!(kill_result, 0, "kill failed with errno {}", Errno::last());

        let exit_code = wait_blocking(child.pid());
        child.disarm();

        assert_eq!(exit_code, Ok(128 + libc::SIGKILL));
    }

    #[test]
    fn reap_zombies_reaps_unrelated_child_without_watched_result() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let child_mask = SigSet::thread_get_mask().unwrap();
        let watched = fork_paused_child(&child_mask, false);
        let mut unrelated = fork_exiting_child(17);
        wait_until_waitable(unrelated.pid()).unwrap();

        let result = reap_zombies(watched.pid());
        let unrelated_state = check_child_reaped(unrelated.pid());
        if unrelated_state != ReapCheck::StillPresent {
            unrelated.disarm();
        }

        assert_eq!(result, Ok(None));
        assert_eq!(unrelated_state, ReapCheck::AlreadyReaped);
    }

    #[test]
    fn supervision_reaps_all_waitable_children_on_one_event() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let signals = SignalContext::block().unwrap();
        let mut watched = fork_exiting_child(23);
        let mut unrelated = fork_exiting_child(17);
        wait_until_waitable(watched.pid()).unwrap();
        wait_until_waitable(unrelated.pid()).unwrap();
        send_thread_signal(Signal::SIGCHLD);

        let exit_code = supervise(&signals, watched.pid(), Duration::from_secs(1)).unwrap();
        watched.disarm();
        let unrelated_state = check_child_reaped(unrelated.pid());
        if unrelated_state != ReapCheck::StillPresent {
            unrelated.disarm();
        }
        finish_signal_test(&signals);

        assert_eq!(exit_code, 23);
        assert_eq!(unrelated_state, ReapCheck::AlreadyReaped);
    }

    #[test]
    fn shutdown_forwards_sigterm_and_returns_child_status() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let signals = SignalContext::block().unwrap();
        let mut child = fork_paused_child(&signals.child_mask, false);
        // SAFETY: pthread_self returns the calling test thread identifier.
        let supervisor_thread = unsafe { libc::pthread_self() };
        let child_pid = child.pid();
        let notifier = thread::spawn(move || match wait_until_waitable(child_pid) {
            Ok(()) => {
                // SAFETY: supervisor_thread remains alive until this thread is
                // joined and SIGCHLD is blocked in that thread.
                let result = unsafe {
                    libc::pthread_kill(supervisor_thread, Signal::SIGCHLD as libc::c_int)
                };
                assert_eq!(result, 0, "pthread_kill failed with errno {result}");
            }
            Err(Errno::ECHILD) => {}
            Err(error) => panic!("waitid failed with errno {error}"),
        });
        send_thread_signal(Signal::SIGTERM);

        let exit_code = supervise(&signals, child.pid(), Duration::from_secs(1)).unwrap();
        child.disarm();
        notifier.join().unwrap();
        finish_signal_test(&signals);

        assert_eq!(exit_code, 128 + libc::SIGTERM);
    }

    #[test]
    fn shutdown_escalates_to_sigkill_after_the_fixed_deadline() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let signals = SignalContext::block().unwrap();
        let mut child = fork_paused_child(&signals.child_mask, true);
        send_thread_signal(Signal::SIGINT);

        let exit_code = supervise(&signals, child.pid(), Duration::ZERO).unwrap();
        child.disarm();
        finish_signal_test(&signals);

        assert_eq!(exit_code, 128 + libc::SIGKILL);
    }

    #[test]
    fn shutdown_repeated_signals_do_not_extend_the_positive_grace_period() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let original_mask = SigSet::thread_get_mask().unwrap();
        let signals = SignalContext::block().unwrap();
        // Declared before the child: unwind cleanup kills/reaps first, then
        // drains selected signals and restores this thread's original mask.
        let signal_cleanup = SignalTestCleanup(&signals);
        let (mut child, acknowledgement) = fork_sigterm_observing_child(&signals.child_mask);
        let child_pid = child.pid();
        let grace_period = Duration::from_millis(500);
        // SAFETY: pthread_self identifies this blocked supervisor thread.
        let supervisor_thread = unsafe { libc::pthread_self() };

        let (exit_code, driver_result) = thread::scope(|scope| {
            let (finished_tx, finished_rx) = mpsc::channel();
            let driver = scope.spawn(move || {
                drive_repeated_shutdown_signals(
                    supervisor_thread,
                    child_pid,
                    acknowledgement,
                    finished_rx,
                    grace_period,
                )
            });
            send_thread_signal(Signal::SIGINT);
            let exit_code = supervise(&signals, child_pid, grace_period);
            let _ = finished_tx.send(());
            (exit_code, driver.join())
        });

        let child_state = check_child_reaped(child_pid);
        if child_state != ReapCheck::StillPresent {
            child.disarm();
        }
        // Do all cleanup before assertions, including on a watchdog failure.
        drop(child);
        drop(signal_cleanup);

        assert_eq!(SigSet::thread_get_mask().unwrap(), original_mask);
        let additional_signals = driver_result.unwrap().unwrap();
        assert!(
            additional_signals >= 2,
            "both SIGTERM and SIGINT must be injected"
        );
        assert_eq!(exit_code, Ok(128 + libc::SIGKILL));
        assert_eq!(child_state, ReapCheck::AlreadyReaped);
    }
}
