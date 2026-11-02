//! Process-group signaling for guest-agent CLI children.
//!
//! Callers construct these values only for children spawned with
//! `Command::process_group(0)`, where the child PID is also the process-group
//! ID. This module owns the unsafe `kill(-pgid, signal)` boundary; it does not
//! own child lifecycle, wait, drain, or termination policy.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ChildProcessGroup {
    pgid: i32,
}

impl ChildProcessGroup {
    pub(super) fn from_group_leader_child(child: &tokio::process::Child) -> Option<Self> {
        Self::from_group_leader_child_id(child.id())
    }

    pub(super) fn from_group_leader_child_id(child_id: Option<u32>) -> Option<Self> {
        child_id.and_then(Self::from_raw_child_id)
    }

    fn from_raw_child_id(child_id: u32) -> Option<Self> {
        let pgid = i32::try_from(child_id).ok()?;
        Self::from_raw_pgid(pgid)
    }

    fn from_raw_pgid(pgid: i32) -> Option<Self> {
        is_signalable_child_pgid(pgid).then_some(Self { pgid })
    }

    pub(super) fn raw_pgid(self) -> i32 {
        self.pgid
    }

    pub(super) fn sigterm(self) {
        self.signal(libc::SIGTERM);
    }

    pub(super) fn sigkill(self) {
        self.signal(libc::SIGKILL);
    }

    fn signal(self, signal: libc::c_int) {
        // Best-effort by design: ESRCH is expected if the child exits between
        // the caller's state check and this signal, and other failures are not
        // recoverable inside guest-agent.
        unsafe {
            libc::kill(-self.pgid, signal);
        }
    }
}

fn is_signalable_child_pgid(pgid: i32) -> bool {
    pgid > 1 && pgid != current_process_group()
}

fn current_process_group() -> i32 {
    unsafe { libc::getpgrp() }
}

#[cfg(test)]
mod tests;
