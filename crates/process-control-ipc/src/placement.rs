use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};

/// Write the kernel self-selector to a caller-owned cgroup placement descriptor.
///
/// The caller authenticates and validates the capability and owns any subsequent
/// membership checks or broker acknowledgement. This operation only writes `0`;
/// it does not consume the descriptor or change its close-on-exec flag.
/// It performs no allocation, locking or logging and can run in a pre-exec hook.
///
/// # Errors
///
/// Interrupted writes are retried. Other syscall errors are returned unchanged;
/// a write that makes no progress returns `EIO`.
pub fn write_self_to_cgroup(placement: BorrowedFd<'_>) -> io::Result<()> {
    loop {
        // SAFETY: the borrow keeps the descriptor open, and the one-byte buffer
        // is valid for the duration of this async-signal-safe syscall.
        let written = unsafe { libc::write(placement.as_raw_fd(), b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}
