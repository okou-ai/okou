pub(crate) fn temp_dir(label: &str) -> (std::path::PathBuf, tempfile::TempDir) {
    use std::os::unix::fs::PermissionsExt;

    let guard = tempfile::Builder::new()
        .prefix(&format!("guest-control-server-{label}-"))
        .tempdir()
        .unwrap();
    let dir = guard.path().to_path_buf();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    (dir, guard)
}

#[cfg(target_os = "linux")]
pub(crate) fn open_pidfd(pid: libc::pid_t) -> std::io::Result<std::os::fd::OwnedFd> {
    let pid = Some(pid)
        .filter(|pid| *pid > 0)
        .and_then(rustix::process::Pid::from_raw)
        .ok_or_else(|| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())
        .map_err(std::io::Error::from)
}

#[cfg(target_os = "linux")]
pub(crate) fn wait_for_pidfd_exit(
    pidfd: &std::os::fd::OwnedFd,
    timeout: std::time::Duration,
) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;
    use std::time::Instant;

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout_ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let mut pollfd = libc::pollfd {
            fd: pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `pollfd` points to one initialized descriptor entry.
        let result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if result > 0 {
            let revents = pollfd.revents;
            if revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(std::io::Error::other("pidfd became invalid while polling"));
            }
            if revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                return Ok(true);
            }
            return Err(std::io::Error::other(format!(
                "unexpected pidfd poll revents: {revents:#x}"
            )));
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

#[cfg(target_os = "linux")]
fn signal_pidfd(
    pidfd: &std::os::fd::OwnedFd,
    signal: rustix::process::Signal,
) -> std::io::Result<()> {
    match rustix::process::pidfd_send_signal(pidfd, signal) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::SRCH => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn kill_pidfd_and_wait(pidfd: &std::os::fd::OwnedFd) -> std::io::Result<()> {
    signal_pidfd(pidfd, rustix::process::Signal::KILL)?;
    if wait_for_pidfd_exit(pidfd, std::time::Duration::from_secs(1))? {
        return Ok(());
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "timed out waiting for pidfd process to exit after SIGKILL",
    ))
}
