use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::os::unix::net::UnixStream;

use crate::transport::{
    read_tool_placement_ack, read_tool_placement_confirmation, receive_tool_placement,
    send_tool_placement, write_tool_placement_ack, write_tool_placement_confirmation,
};

/// Apply the broker's placement descriptor and wait for its acknowledgement.
///
/// The caller owns the connection and timeouts. The placement descriptor
/// closes before the caller's check runs. A successful check permits sending
/// confirmation and waiting for ACK.
///
/// # Errors
/// Returns the first descriptor, check, or transport error.
pub fn apply_tool_placement(
    stream: &UnixStream,
    before_confirmation: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let placement = receive_tool_placement(stream)?;
    write_self_to_cgroup(placement.as_fd())?;
    drop(placement);
    before_confirmation()?;
    write_tool_placement_confirmation(stream)?;
    read_tool_placement_ack(stream)
}

/// Send a placement descriptor and acknowledge confirmed, validated placement.
///
/// The broker owns the descriptor, peer authentication, timeouts, and rollback.
/// Its check runs after reading the peer's confirmation and must succeed before
/// the acknowledgement is sent.
///
/// # Errors
/// Returns the first descriptor, check, or transport error.
pub fn offer_tool_placement(
    stream: &UnixStream,
    placement: BorrowedFd<'_>,
    before_ack: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    send_tool_placement(stream, placement)?;
    read_tool_placement_confirmation(stream)?;
    before_ack()?;
    write_tool_placement_ack(stream)
}

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
