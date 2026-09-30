//! Guest init process for Firecracker.
//!
//! Runs as PID 1 inside a Firecracker VM. PID 1 synchronously waits for blocked
//! child and shutdown signals, then reaps every available zombie.
//!
//! Like tini, guest-init forks a child process (PID 2) to run Guest services.
//! PID 1 then enters an event-driven supervision loop, waiting for the child to
//! exit while also reaping orphaned zombie processes.
//!
//! This architecture separates wait domains and supervision phases:
//! - PID 1 blocks `SIGCHLD`, `SIGTERM`, and `SIGINT` before `fork()` and waits
//!   for them synchronously, eliminating polling and lost-wakeup windows.
//! - On `SIGCHLD`, PID 1 calls `waitpid(-1, WNOHANG)` until every available
//!   PID 2 or orphaned process has been reaped.
//! - After escalating shutdown to SIGKILL, PID 1 switches to blocking
//!   `waitpid(child_pid, 0)` to reap PID 2.
//! - PID 2 (guest-control-server) calls `waitpid(pid)` for the commands it spawns. While
//!   PID 2 owns those children, PID 1 cannot reap them, so the processes do not
//!   race and PID 2 does not see `ECHILD` from PID 1's reaper.
//! - PID 1's generic and targeted waits run sequentially in the same thread, so
//!   they cannot race with each other.
//!
//! Startup sequence:
//! 1. Initialize guest filesystems, environment, and cgroup v2 exec containment.
//!    Failure is fatal before the Guest services child is forked.
//! 2. Configure PID 1 signals and block supervised signals
//! 3. Fork child process
//! 4. Child (PID 2): restore its inherited signal mask, run private duplex and guest control
//! 5. Parent (PID 1): wait for child and shutdown events

mod init;
mod pid1;
mod private_duplex;

use std::time::Duration;

const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(1);

fn main() {
    eprintln!("[guest-init] Starting...");

    // Step 1: Initialize guest filesystems, environment, and exec containment.
    if let Err(e) = init::init_filesystem() {
        eprintln!("[guest-init] FATAL: Filesystem init failed: {}", e);
        std::process::exit(1);
    }

    // Step 2: Configure and block PID 1 signals before fork.
    let signal_context = match pid1::SignalContext::setup() {
        Ok(context) => context,
        Err(error) => {
            eprintln!("[guest-init] FATAL: Signal setup failed: {error}");
            std::process::exit(1);
        }
    };
    eprintln!("[guest-init] PID 1 signals configured");

    // Step 3: Fork child process for the Guest services
    // SAFETY: fork() is called before any threads are spawned, so it is safe.
    // The child will run Guest services; the parent stays as PID 1 reaper.
    let child_pid = unsafe { libc::fork() };
    if child_pid < 0 {
        eprintln!("[guest-init] FATAL: fork() failed");
        std::process::exit(1);
    }

    if child_pid == 0 {
        // Step 4: Child (PID 2) — restore the mask from before PID 1 blocked
        // supervised signals. Ignored SIGTTIN/SIGTTOU/SIGPIPE dispositions
        // intentionally survive fork.
        if let Err(error) = signal_context.restore_child_mask() {
            eprintln!("[guest-init] FATAL: Child signal mask restore failed: {error}");
            // SAFETY: _exit() is the correct way to terminate a forked child.
            unsafe {
                libc::_exit(1);
            }
        }

        let code = match run_guest_services() {
            Ok(()) => 0,
            Err(e) => {
                guest_control_server::log("ERROR", &format!("Fatal: {e}"));
                1
            }
        };

        // SAFETY: _exit() is the correct way to terminate a forked child.
        // Using std::process::exit() would run atexit handlers and flush
        // shared stdio buffers, potentially corrupting parent output.
        unsafe {
            libc::_exit(code);
        }
    }

    // === Parent process (PID 1) ===
    eprintln!("[guest-init] guest services forked as pid={child_pid}");

    // Step 5: Wait for child and shutdown events while reaping orphans.
    match pid1::supervise(&signal_context, child_pid, SHUTDOWN_GRACE_PERIOD) {
        Ok(exit_code) => {
            eprintln!("[guest-init] guest services exited with code {exit_code}");
            std::process::exit(exit_code);
        }
        Err(error) => {
            eprintln!("[guest-init] FATAL: Child supervision failed: {error}");
            std::process::exit(1);
        }
    }
}

/// Compose both private Guest services in PID 2. Start no threads before fork;
/// failing to start the duplex worker is fatal before entering the control loop.
fn run_guest_services() -> std::io::Result<()> {
    let _duplex_worker = std::thread::Builder::new()
        .name("gdup-connect".into())
        .spawn(private_duplex::run)?;
    guest_control_server::run(None)
}
