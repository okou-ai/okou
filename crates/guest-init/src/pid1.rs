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
mod tests;
