use std::io;
use std::time::Duration;

#[cfg(target_os = "linux")]
use std::os::fd::OwnedFd;

use tokio::process::Child;

const FALLBACK_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

pub(super) struct ChildExitNotifier {
    #[cfg(target_os = "linux")]
    pidfd: tokio::io::unix::AsyncFd<OwnedFd>,
}

impl ChildExitNotifier {
    pub(super) fn open(child: &Child) -> io::Result<Self> {
        let pid = child.id().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "child PID is unavailable for pidfd notification",
            )
        })?;
        Self::open_for_pid(pid)
    }

    pub(super) async fn wait_for_exit(&self) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            let _ready = self.pidfd.readable().await?;
            Ok(())
        }

        #[cfg(not(target_os = "linux"))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "pidfd child exit notification is unavailable",
            ))
        }
    }

    #[cfg(target_os = "linux")]
    fn open_for_pid(pid: u32) -> io::Result<Self> {
        let pidfd = open_pidfd(pid)
            .map_err(|error| io::Error::new(error.kind(), format!("pidfd_open failed: {error}")))?;
        Ok(Self {
            pidfd: tokio::io::unix::AsyncFd::new(pidfd).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("pidfd async registration failed: {error}"),
                )
            })?,
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn open_for_pid(_pid: u32) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "pidfd child exit notification is unavailable",
        ))
    }
}

pub(super) async fn wait_for_child_exit_without_reaping(child_id: u32) -> io::Result<()> {
    loop {
        if child_exited_without_reaping(child_id)? {
            return Ok(());
        }
        tokio::time::sleep(FALLBACK_EXIT_POLL_INTERVAL).await;
    }
}

#[cfg(unix)]
pub(super) fn child_exited_without_reaping(child_id: u32) -> io::Result<bool> {
    let child_pid = libc::pid_t::try_from(child_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "child PID cannot be represented as libc::pid_t",
        )
    })?;
    let child_wait_id = libc::id_t::try_from(child_pid).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "child PID cannot be represented as libc::id_t",
        )
    })?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: child_wait_id names a direct child still owned by the caller.
        // WNOWAIT observes terminal state without releasing its PID identity.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child_wait_id,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            // SAFETY: zero is valid for siginfo_t, and waitid may have updated
            // it. Zero initialization keeps si_pid() at zero when WNOHANG
            // observes no status.
            let info = unsafe { info.assume_init() };
            return Ok(unsafe { info.si_pid() } != 0);
        }

        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(not(unix))]
pub(super) fn child_exited_without_reaping(_child_id: u32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "non-reaping child exit observation is unavailable",
    ))
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: u32) -> io::Result<OwnedFd> {
    let pid = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "child PID cannot be represented as rustix::process::Pid",
            )
        })?;

    rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()).map_err(io::Error::from)
}
