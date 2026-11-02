use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

/// Keep a private launch descriptor out of the standard descriptor slots.
pub fn private_descriptor(fd: OwnedFd) -> io::Result<OwnedFd> {
    if fd.as_raw_fd() > libc::STDERR_FILENO {
        return Ok(fd);
    }
    fd.try_clone()
}
