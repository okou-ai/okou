use std::io;
use std::process::{Child, Command, ExitStatus};

use crate::log::log;

/// Common ownership operations for standard and directly contained children.
pub(crate) trait ChildProcess {
    fn id(&self) -> u32;
    fn kill(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

impl ChildProcess for Child {
    fn id(&self) -> u32 {
        self.id()
    }

    fn kill(&mut self) -> io::Result<()> {
        self.kill()
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.wait()
    }
}

pub(crate) use process_launch::private_descriptor;

/// Extract exit code from ExitStatus, mapping signals to 128 + signal number.
#[cfg(unix)]
pub(crate) fn extract_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| status.signal().map(|sig| 128 + sig).unwrap_or(1))
}

#[cfg(not(unix))]
pub(crate) fn extract_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Spawn a command as the leader of a new process group on Unix.
///
/// Timeout killing targets the process group by child PID, so every child path
/// that uses the shared wait helpers must preserve this spawn invariant.
pub(crate) fn spawn_in_own_process_group(command: &mut Command) -> io::Result<Child> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0).spawn()
    }
    #[cfg(not(unix))]
    {
        command.spawn()
    }
}

pub(crate) fn process_signal_pid(pid: u32) -> Option<libc::pid_t> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    (pid > 0).then_some(pid)
}

fn process_group_signal_pid(pgid: u32) -> Option<libc::pid_t> {
    let pgid = process_signal_pid(pgid)?;
    (pgid > 1).then_some(-pgid)
}

/// Kill the direct child's process group while its identity is still owned.
///
/// # Safety
///
/// `child_id` must come from an owned direct-child spawn, and
/// that child must not have been reaped. Keeping the child unreaped prevents
/// its PID, and therefore its process-group ID, from being reused.
pub(crate) unsafe fn kill_owned_child_process_group(child_id: u32) -> bool {
    if let Some(signal_pid) = process_group_signal_pid(child_id) {
        let ret = unsafe { libc::kill(signal_pid, libc::SIGKILL) };
        if ret != 0 {
            let err = io::Error::last_os_error();
            log(
                "WARN",
                &format!("child-group kill(-{child_id}, SIGKILL) failed: {err}"),
            );
        }
        ret == 0
    } else {
        log(
            "WARN",
            &format!("child-group kill skipped invalid process group id {child_id}"),
        );
        false
    }
}

/// Kill the direct child's process group and reap the direct child.
pub(crate) fn kill_and_reap_child(mut child: impl ChildProcess) {
    let child_id = child.id();
    // SAFETY: child_id comes from an owned, unreaped direct child.
    let group_killed = unsafe { kill_owned_child_process_group(child_id) };
    let child_killed = child.kill().is_ok();
    if !group_killed && !child_killed {
        log(
            "WARN",
            &format!("failed to signal child process group for pid={child_id}"),
        );
    }

    if let Err(e) = child.wait() {
        log("WARN", &format!("failed to reap child pid={child_id}: {e}"));
    }
}

#[cfg(test)]
mod tests;
