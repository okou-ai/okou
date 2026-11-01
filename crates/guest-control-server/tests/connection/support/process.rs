use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

use super::temp_paths::{TempPathGuard, unique_pid_path};

pub(crate) struct OrphanProcessGuard {
    pid_file: TempPathGuard,
}

impl OrphanProcessGuard {
    pub(crate) fn new(label: &str) -> Self {
        Self {
            pid_file: unique_pid_path(label),
        }
    }

    pub(crate) fn pid_path(&self) -> &str {
        self.pid_file.as_str()
    }
}

impl Drop for OrphanProcessGuard {
    fn drop(&mut self) {
        let Ok(pid_text) = std::fs::read_to_string(self.pid_file.as_str()) else {
            return;
        };
        let Ok(pid) = pid_text.trim().parse::<libc::pid_t>() else {
            return;
        };
        if pid > 0 {
            // SAFETY: pid is written by the shell as `$!` for this test's
            // background `sleep` process; failures are best-effort cleanup.
            unsafe {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

pub(crate) fn orphan_sleep_command(marker: &str, pid_path: &str) -> String {
    format!("sleep 30 & echo $! > {pid_path}; echo {marker}")
}

fn read_pid_file(path: &str) -> u32 {
    let path = Path::new(path);
    let deadline = Instant::now() + Duration::from_secs(3);
    let watcher = DirectoryWatcher::new(
        path.parent()
            .unwrap_or_else(|| panic!("pid path has no parent: {}", path.display())),
    )
    .unwrap_or_else(|e| panic!("failed to watch pid path parent {}: {e}", path.display()));

    loop {
        match try_read_pid_file(path) {
            Ok(Some(pid)) => return pid,
            Ok(None) => {}
            Err(e) => panic!("failed to read pid file {}: {e}", path.display()),
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "pid file {} was not created",
            path.display()
        );
        let changed = watcher
            .wait(remaining)
            .unwrap_or_else(|e| panic!("failed waiting for pid file {}: {e}", path.display()));
        assert!(changed, "pid file {} was not created", path.display());
    }
}

fn try_read_pid_file(path: &Path) -> std::io::Result<Option<u32>> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents.trim().parse().ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn kill_pid_group(pid: u32) {
    // SAFETY: best-effort cleanup for a pid produced by a test child process.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

pub(crate) struct ProcessGroupFileGuard<'a> {
    pid_path: &'a str,
    pid: Option<u32>,
    armed: bool,
}

impl<'a> ProcessGroupFileGuard<'a> {
    pub(crate) fn new(pid_path: &'a str) -> Self {
        Self {
            pid_path,
            pid: None,
            armed: true,
        }
    }

    pub(crate) fn read_pid(&mut self) -> u32 {
        let pid = read_pid_file(self.pid_path);
        self.observe_pid(pid);
        pid
    }

    pub(crate) fn observe_pid(&mut self, pid: u32) {
        self.pid = Some(pid);
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupFileGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pid = self.pid.or_else(|| {
            std::fs::read_to_string(self.pid_path)
                .ok()
                .and_then(|contents| contents.trim().parse().ok())
        });
        let Some(pid) = pid else {
            return;
        };
        if pid > 0 && pid_alive(pid) {
            kill_pid_group(pid);
        }
    }
}

pub(crate) fn wait_for_pid_exit(pid: u32, context: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
}

#[derive(Clone, Copy)]
struct ProcStat {
    state: char,
    pgid: u32,
}

fn parse_proc_stat(stat: &str) -> Option<ProcStat> {
    let fields_start = stat.rfind(") ")? + 2;
    let mut fields = stat[fields_start..].split_whitespace();
    let state = fields.next()?.chars().next()?;
    let _ppid = fields.next()?;
    let pgid = fields.next()?.parse().ok()?;
    Some(ProcStat { state, pgid })
}

fn proc_stat(pid: u32) -> Option<ProcStat> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_proc_stat(&stat)
}

fn process_group_has_live_member(pgid: u32) -> bool {
    !process_group_live_members(pgid).is_empty()
}

fn process_group_live_members(pgid: u32) -> Vec<u32> {
    if pgid == 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![pgid];
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            let Some(stat) = proc_stat(*pid) else {
                return false;
            };
            if stat.pgid != pgid || stat.state == 'Z' {
                return false;
            }
            // SAFETY: `kill` with sig=0 is a no-op existence check.
            unsafe { libc::kill(*pid as i32, 0) == 0 }
        })
        .collect()
}

/// Returns true iff `pid` is still running and signalable by the test owner.
/// Zombie leaders are dead, but their process group can still contain live
/// children, so wait/cleanup only treat the group as exited once no live member
/// remains. Some CI containers leave reparented zombies visible to
/// `kill(pid, 0)` until PID 1 reaps them.
pub(crate) fn pid_alive(pid: u32) -> bool {
    // SAFETY: `kill` with sig=0 is a no-op existence check.
    if unsafe { libc::kill(pid as i32, 0) != 0 } {
        return process_group_has_live_member(pid);
    }
    match proc_stat(pid) {
        Some(stat) if stat.state == 'Z' => process_group_has_live_member(stat.pgid),
        Some(_) => true,
        None => true,
    }
}

struct DirectoryWatcher {
    fd: OwnedFd,
}

impl DirectoryWatcher {
    fn new(dir: &Path) -> std::io::Result<Self> {
        // SAFETY: `inotify_init1` does not dereference user pointers and
        // returns a fresh file descriptor on success.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        // SAFETY: `fd` is a fresh descriptor returned by `inotify_init1`.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let dir = CString::new(dir.as_os_str().as_bytes()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "watch directory contains a NUL byte",
            )
        })?;
        let mask = libc::IN_CREATE | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE;
        // SAFETY: `fd` is a valid inotify descriptor and `dir` is a
        // NUL-terminated directory path.
        let wd = unsafe { libc::inotify_add_watch(fd.as_raw_fd(), dir.as_ptr(), mask) };
        if wd < 0 {
            return Err(std::io::Error::last_os_error());
        }

        Ok(Self { fd })
    }

    fn wait(&self, timeout: Duration) -> std::io::Result<bool> {
        let pollfd = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        match poll_until(&mut [pollfd], timeout)? {
            true => {
                drain_fd(self.fd.as_raw_fd());
                Ok(true)
            }
            false => Ok(false),
        }
    }
}

fn poll_until(pollfds: &mut [libc::pollfd], timeout: Duration) -> std::io::Result<bool> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: `pollfds` points to initialized pollfd entries and the len
        // argument matches the slice length.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as _, timeout_ms) };
        if result > 0 {
            return Ok(true);
        }
        if result == 0 {
            return Ok(false);
        }
        let err = std::io::Error::last_os_error();
        if err.kind() != std::io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn drain_fd(fd: std::os::fd::RawFd) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: `fd` is a valid non-blocking descriptor owned by the caller;
        // `buf` is valid writable memory for the requested length.
        let result = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}

#[cfg(test)]
mod tests;
