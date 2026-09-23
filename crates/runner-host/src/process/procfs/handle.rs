use std::ffi::{CStr, OsString};
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;
use std::path::PathBuf;

use rustix::fs::{Mode, OFlags};
use tokio::io::AsyncReadExt;

use super::{ProcessStatRead, classify_process_stat_read, parse_cmdline_bytes};

/// A retained kernel identity, not a reservation of the numeric PID.
///
/// Relative procfs reads and `pidfd_send_signal` use the same process object,
/// even if the process exits and its numeric PID is reused.
pub struct ProcfsProcessHandle {
    directory: OwnedFd,
}

impl ProcfsProcessHandle {
    pub fn open(pid: u32) -> io::Result<Self> {
        let directory = rustix::fs::open(
            format!("/proc/{pid}"),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        Ok(Self { directory })
    }

    async fn read_file(&self, name: &CStr) -> io::Result<Vec<u8>> {
        let fd = rustix::fs::openat(
            &self.directory,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        let mut file = tokio::fs::File::from_std(std::fs::File::from(fd));
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        Ok(bytes)
    }

    pub async fn read_stat(&self) -> ProcessStatRead {
        match self.read_file(c"stat").await {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => ProcessStatRead::Missing,
            result => classify_process_stat_read(result),
        }
    }

    pub async fn read_cmdline(&self) -> Option<Vec<String>> {
        parse_cmdline_bytes(&self.read_file(c"cmdline").await.ok()?)
    }

    pub fn read_cwd(&self) -> Option<PathBuf> {
        let cwd = rustix::fs::readlinkat(&self.directory, c"cwd", Vec::new()).ok()?;
        Some(PathBuf::from(OsString::from_vec(cwd.into_bytes())))
    }

    /// Kill the group of a verified process-group leader without a PID lookup.
    pub fn kill_process_group(&self) -> nix::Result<()> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;

            // Linux UAPI <linux/pidfd.h>, available since Linux 6.9. The pinned
            // rustix pidfd_send_signal wrapper only supports flags = 0.
            const PIDFD_SIGNAL_PROCESS_GROUP: libc::c_uint = 1 << 2;

            // SAFETY: Linux accepts an open /proc/PID directory for this syscall.
            // The descriptor remains owned through delivery, SIGKILL is valid,
            // and the null siginfo pointer requests kernel-generated metadata.
            let result = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.directory.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    PIDFD_SIGNAL_PROCESS_GROUP,
                )
            };
            nix::errno::Errno::result(result).map(|_| ())
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(nix::errno::Errno::ENOSYS)
        }
    }
}
