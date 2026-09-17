use std::io;
use std::os::fd::OwnedFd;
use std::time::Duration;

use rustix::process::{Pid, PidfdFlags, Signal};
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};

const SESSION_SCAN_INTERVAL: Duration = Duration::from_millis(10);

pub(super) struct CommandSession {
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

enum ProcessStatRead {
    Found(ProcessStat),
    Missing,
    Unreadable(io::Error),
    Invalid,
}

impl CommandSession {
    pub(super) fn configure(command: &mut Command) {
        // SAFETY: `setsid` is async-signal-safe and the closure performs no
        // work beyond that syscall and converting its errno on failure.
        unsafe {
            command.pre_exec(|| rustix::process::setsid().map(drop).map_err(io::Error::from));
        }
    }

    pub(super) fn from_child(child: &Child) -> io::Result<Self> {
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

    pub(super) async fn wait_for_exit(&self) -> io::Result<()> {
        // The caller keeps Child owned and unpolled until session cleanup ends.
        // Readiness observes exit without reaping the leader and releasing its SID.
        let pidfd = rustix::process::pidfd_open(self.session_id, PidfdFlags::empty())?;
        let pidfd = AsyncFd::new(pidfd)?;
        pidfd.readable().await.map(drop)
    }

    pub(super) async fn kill_members(
        &self,
        deadline: tokio::time::Instant,
        cleanup_timeout: Duration,
    ) -> Result<(), String> {
        let mut first_error = None;

        loop {
            let scan = match tokio::time::timeout_at(
                deadline,
                scan_session_members(self.session_id),
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

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
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

async fn scan_session_members(session_id: Pid) -> Result<SessionScan, String> {
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

        let before = match read_process_stat(pid).await {
            ProcessStatRead::Found(stat) if process_stat_is_live(stat) => stat,
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            ProcessStatRead::Invalid => {
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

        match read_process_stat(pid).await {
            ProcessStatRead::Found(stat)
                if process_stat_is_live(stat) && stat.starttime == before.starttime => {}
            ProcessStatRead::Found(_) | ProcessStatRead::Missing => continue,
            ProcessStatRead::Unreadable(error) => {
                record_owned_stat_error(
                    pid,
                    session_id,
                    format!("re-read /proc/{pid}/stat: {error}"),
                    &mut live_pids,
                    &mut first_error,
                );
                continue;
            }
            ProcessStatRead::Invalid => {
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

pub(crate) fn session_id_matches_target(
    target_session_id: Pid,
    observed_session_id: Result<libc::pid_t, nix::errno::Errno>,
) -> bool {
    observed_session_id == Ok(target_session_id.as_raw_pid())
}

fn process_session_id(pid: Pid) -> Result<libc::pid_t, nix::errno::Errno> {
    nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(pid.as_raw_pid())))
        .map(nix::unistd::Pid::as_raw)
}

async fn read_process_stat(pid: Pid) -> ProcessStatRead {
    let path = format!("/proc/{pid}/stat");
    match tokio::fs::read(path).await {
        Ok(content) => match parse_process_stat(&content) {
            Some(stat) => ProcessStatRead::Found(stat),
            None => ProcessStatRead::Invalid,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => ProcessStatRead::Missing,
        Err(error) => ProcessStatRead::Unreadable(error),
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
