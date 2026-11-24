//! Owned process sessions and pidfd-backed descendant cleanup.

use std::future::Future;
use std::io;
use std::os::fd::OwnedFd;
use std::process::ExitStatus;
use std::time::Duration;

use rustix::process::{Pid, PidfdFlags, Signal};
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};
use tokio::time::Instant;

const SESSION_SCAN_INTERVAL: Duration = Duration::from_millis(10);

/// The Linux session of a test command's unreaped leader.
pub struct CommandSession {
    session_id: Pid,
}

struct SessionMember {
    pid: Pid,
    pidfd: OwnedFd,
}

struct SessionScan {
    live_pids: Vec<Pid>,
    members: Vec<SessionMember>,
    error: Option<String>,
}

#[derive(Clone, Copy)]
struct ProcessStat {
    state: u8,
    starttime: u64,
}

/// The process generation and liveness facts needed by session cleanup.
pub enum SessionMemberState {
    Live {
        starttime: u64,
    },
    /// A terminal process or a process whose proc entry disappeared.
    Gone,
    Unreadable(io::Error),
    Invalid,
}

impl CommandSession {
    /// Start the command in a separate session.
    pub fn configure(command: &mut Command) {
        // SAFETY: `setsid` is async-signal-safe and the closure performs no
        // work beyond that syscall and converting its errno on failure.
        unsafe {
            command.pre_exec(|| rustix::process::setsid().map(drop).map_err(io::Error::from));
        }
    }

    /// Identify the session of a child spawned with [Self::configure].
    pub fn from_child(child: &Child) -> io::Result<Self> {
        let child_pid = child.id().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "spawned command PID is unavailable",
            )
        })?;
        let raw_pid = i32::try_from(child_pid).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "spawned command PID does not fit in pid_t",
            )
        })?;
        let session_id = Pid::from_raw(raw_pid).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "spawned command PID cannot identify a session",
            )
        })?;
        Ok(Self { session_id })
    }

    /// The leader PID and session ID are the same while the child is unreaped.
    pub fn leader_pid(&self) -> Pid {
        self.session_id
    }

    pub(super) async fn wait_for_exit(&self) -> io::Result<()> {
        // The caller keeps Child owned and unpolled until session cleanup ends.
        // Readiness observes exit without reaping the leader and releasing its SID.
        let pidfd = rustix::process::pidfd_open(self.session_id, PidfdFlags::empty())?;
        // SAFETY: AsyncFd owns the pidfd and keeps its descriptor unchanged until drop.
        let pidfd = unsafe { AsyncFd::register(pidfd) }?;
        pidfd.readable().await.map(drop)
    }

    /// Retire session members and reap the leader under one cleanup deadline.
    ///
    /// Pass the same unreaped child used to identify this session and call this
    /// once. Its unreaped PID reserves the SID until the member sweep finishes.
    pub async fn retire<F, Fut>(
        &self,
        child: &mut Child,
        cleanup_timeout: Duration,
        wait_context: &str,
        read_member_state: F,
    ) -> Result<ExitStatus, String>
    where
        F: Fn(Pid) -> Fut,
        Fut: Future<Output = SessionMemberState>,
    {
        let kill_error = child.start_kill().err();
        let deadline = Instant::now() + cleanup_timeout;
        let session_error = self
            .kill_members(deadline, cleanup_timeout, &read_member_state)
            .await
            .err();
        let wait_result =
            wait_for_child_until(child, deadline, cleanup_timeout, wait_context).await;

        match (session_error, wait_result) {
            (None, Ok(status)) => Ok(status),
            (Some(session_error), Ok(status)) => Err(cleanup_error(
                kill_error,
                Some(session_error),
                format!("killed child status: {status}"),
            )),
            (session_error, Err(wait_error)) => {
                Err(cleanup_error(kill_error, session_error, wait_error))
            }
        }
    }

    async fn kill_members<F, Fut>(
        &self,
        deadline: Instant,
        cleanup_timeout: Duration,
        read_member_state: &F,
    ) -> Result<(), String>
    where
        F: Fn(Pid) -> Fut,
        Fut: Future<Output = SessionMemberState>,
    {
        let mut first_error = None;

        loop {
            let scan = match tokio::time::timeout_at(
                deadline,
                scan_session_members(self.session_id, read_member_state),
            )
            .await
            {
                Ok(Ok(scan)) => scan,
                Ok(Err(error)) => {
                    return Err(combine_errors(first_error, error));
                }
                Err(_) => {
                    let timeout = format!(
                        "session {} scan timed out after {}ms",
                        self.session_id,
                        cleanup_timeout.as_millis()
                    );
                    return Err(combine_errors(first_error, timeout));
                }
            };
            if first_error.is_none() {
                first_error = scan.error;
            }
            if scan.live_pids.is_empty() {
                return match first_error {
                    Some(error) => Err(error),
                    None => Ok(()),
                };
            }

            for member in scan.members {
                if let Err(error) = rustix::process::pidfd_send_signal(&member.pidfd, Signal::KILL)
                    && error != rustix::io::Errno::SRCH
                    && first_error.is_none()
                {
                    first_error = Some(format!(
                        "pidfd signal failed for session {} member {}: {error}",
                        self.session_id, member.pid
                    ));
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let live_pids = scan
                    .live_pids
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                let timeout = format!(
                    "session {} remained live after {}ms (pids: {live_pids})",
                    self.session_id,
                    cleanup_timeout.as_millis()
                );
                return Err(combine_errors(first_error, timeout));
            }
            tokio::time::sleep(remaining.min(SESSION_SCAN_INTERVAL)).await;
        }
    }
}

async fn wait_for_child_until(
    child: &mut Child,
    deadline: Instant,
    cleanup_timeout: Duration,
    wait_context: &str,
) -> Result<ExitStatus, String> {
    match child.try_wait() {
        Ok(Some(status)) => return Ok(status),
        Ok(None) => {}
        Err(error) => return Err(format!("{wait_context} failed: {error}")),
    }

    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!("{wait_context} failed: {error}")),
        Err(_) => Err(format!(
            "{wait_context} timed out after {}ms",
            cleanup_timeout.as_millis()
        )),
    }
}

fn cleanup_error(
    kill_error: Option<io::Error>,
    session_error: Option<String>,
    wait_result: String,
) -> String {
    let mut errors = Vec::new();
    if let Some(kill_error) = kill_error {
        errors.push(format!("start kill failed: {kill_error}"));
    }
    if let Some(session_error) = session_error {
        errors.push(format!("session cleanup failed: {session_error}"));
    }
    errors.push(wait_result);
    errors.join("; ")
}

async fn scan_session_members<F, Fut>(
    session_id: Pid,
    read_member_state: &F,
) -> Result<SessionScan, String>
where
    F: Fn(Pid) -> Fut,
    Fut: Future<Output = SessionMemberState>,
{
    let mut entries = tokio::fs::read_dir("/proc")
        .await
        .map_err(|error| format!("read /proc for session {session_id}: {error}"))?;
    let mut live_pids = Vec::new();
    let mut members = Vec::new();
    let mut first_error = None;

    loop {
        let entry = entries
            .next_entry()
            .await
            .map_err(|error| format!("iterate /proc for session {session_id}: {error}"))?;
        let Some(entry) = entry else {
            break;
        };
        let Some(pid_text) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(raw_pid) = pid_text.parse::<i32>() else {
            continue;
        };
        let Some(pid) = Pid::from_raw(raw_pid) else {
            continue;
        };

        let starttime = match read_member_state(pid).await {
            SessionMemberState::Live { starttime } => starttime,
            SessionMemberState::Gone => continue,
            SessionMemberState::Unreadable(error) => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            SessionMemberState::Invalid => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("parse /proc/{pid}/stat"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
        };
        if !session_id_matches_target(session_id, process_session_id(pid)) {
            continue;
        }

        let pidfd = match rustix::process::pidfd_open(pid, PidfdFlags::empty()) {
            Ok(pidfd) => pidfd,
            Err(rustix::io::Errno::SRCH) => continue,
            Err(error) => {
                live_pids.push(pid);
                if first_error.is_none() {
                    first_error = Some(format!(
                        "pidfd_open failed for session {session_id} member {pid}: {error}"
                    ));
                }
                continue;
            }
        };

        match read_member_state(pid).await {
            SessionMemberState::Live {
                starttime: observed,
            } if observed == starttime => {}
            SessionMemberState::Live { .. } | SessionMemberState::Gone => continue,
            SessionMemberState::Unreadable(error) => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("re-read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            SessionMemberState::Invalid => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("re-parse /proc/{pid}/stat"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
        }
        if !session_id_matches_target(session_id, process_session_id(pid)) {
            continue;
        }

        live_pids.push(pid);
        members.push(SessionMember { pid, pidfd });
    }

    Ok(SessionScan {
        live_pids,
        members,
        error: first_error,
    })
}

fn record_owned_stat_error(
    pid: Pid,
    session_id: Pid,
    error: String,
    live_pids: &mut Vec<Pid>,
    first_error: &mut Option<String>,
) {
    if !session_id_matches_target(session_id, process_session_id(pid)) {
        return;
    }
    live_pids.push(pid);
    if first_error.is_none() {
        *first_error = Some(format!(
            "session {session_id} member {pid} process state unavailable: {error}"
        ));
    }
}

pub fn session_id_matches_target(
    target_session_id: Pid,
    observed_session_id: Result<libc::pid_t, nix::errno::Errno>,
) -> bool {
    observed_session_id == Ok(target_session_id.as_raw_pid())
}

fn process_session_id(pid: Pid) -> Result<libc::pid_t, nix::errno::Errno> {
    nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(pid.as_raw_pid())))
        .map(nix::unistd::Pid::as_raw)
}

pub(super) async fn read_member_state(pid: Pid) -> SessionMemberState {
    let path = format!("/proc/{pid}/stat");
    match tokio::fs::read(path).await {
        Ok(content) => match parse_process_stat(&content) {
            Some(stat) if process_stat_is_live(stat) => SessionMemberState::Live {
                starttime: stat.starttime,
            },
            Some(_) => SessionMemberState::Gone,
            None => SessionMemberState::Invalid,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => SessionMemberState::Gone,
        Err(error) => SessionMemberState::Unreadable(error),
    }
}

fn parse_process_stat(content: &[u8]) -> Option<ProcessStat> {
    let comm_end = content.iter().rposition(|byte| *byte == b')')?;
    let fields = content.get(comm_end.checked_add(2)?..)?;
    let mut fields = fields
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty());
    let state_field = fields.next()?;
    if state_field.len() != 1 {
        return None;
    }
    let state = *state_field.first()?;
    let starttime = std::str::from_utf8(fields.nth(18)?).ok()?.parse().ok()?;
    Some(ProcessStat { state, starttime })
}

fn process_stat_is_live(stat: ProcessStat) -> bool {
    !matches!(stat.state, b'Z' | b'X' | b'x')
}

fn combine_errors(first_error: Option<String>, error: String) -> String {
    match first_error {
        Some(first_error) => format!("{first_error}; {error}"),
        None => error,
    }
}
