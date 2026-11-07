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
    use std::os::fd::FromRawFd;

    // SAFETY: `pidfd_open` does not dereference user pointers. On success it
    // returns a new file descriptor owned by this process.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: `fd` is a fresh descriptor returned by `pidfd_open` above.
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) })
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
fn signal_pidfd(pidfd: &std::os::fd::OwnedFd, signal: libc::c_int) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    // SAFETY: best-effort cleanup of a test-owned background process.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result == 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(err)
}

#[cfg(target_os = "linux")]
pub(crate) fn kill_pidfd_and_wait(pidfd: &std::os::fd::OwnedFd) -> std::io::Result<()> {
    signal_pidfd(pidfd, libc::SIGKILL)?;
    if wait_for_pidfd_exit(pidfd, std::time::Duration::from_secs(1))? {
        return Ok(());
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "timed out waiting for pidfd process to exit after SIGKILL",
    ))
}
