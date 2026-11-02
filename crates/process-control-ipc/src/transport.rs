use std::io::{self, Read, Write};
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::{Duration, Instant};

const ENDPOINT_PREFIX: &str = "vm0-process-control-";
const MAX_U32_DECIMAL_DIGITS: usize = 10;
const NONCE_HEX_LEN: usize = 16 * 2;
const WORKLOAD_PLACEMENT_MARKER: u8 = 0x57;
const WORKLOAD_PLACEMENT_CONFIRM_MARKER: u8 = 0x52;
const TOOL_PLACEMENT_MARKER: u8 = 0x54;
const TOOL_PLACEMENT_CONFIRM_MARKER: u8 = 0x43;
const TOOL_PLACEMENT_ACK_MARKER: u8 = 0x41;
const ANCILLARY_BUFFER_WORDS: usize = 8;
const LISTENER_BACKLOG: libc::c_int = 128;

/// Build the abstract socket name for an operation-control endpoint.
///
/// The name includes the guest operation sequence number and a hexadecimal
/// encoding of the 16-byte control nonce. The returned string is suitable for
/// [`bind_abstract_listener`], [`connect_abstract`], and
/// [`crate::CANONICAL_BOOTSTRAP_ENV`].
pub fn endpoint_name(seq: u32, nonce: &[u8; 16]) -> String {
    let mut out =
        String::with_capacity(ENDPOINT_PREFIX.len() + MAX_U32_DECIMAL_DIGITS + 1 + NONCE_HEX_LEN);
    out.push_str(ENDPOINT_PREFIX);
    push_decimal_u32(&mut out, seq);
    out.push('-');
    for byte in nonce {
        out.push(lower_hex_digit(byte >> 4));
        out.push(lower_hex_digit(byte & 0x0f));
    }
    out
}

fn push_decimal_u32(out: &mut String, mut value: u32) {
    let mut digits = [0_u8; MAX_U32_DECIMAL_DIGITS];
    let mut len = 0;
    for slot in digits.iter_mut().rev() {
        *slot = b'0' + (value % 10) as u8;
        len += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for digit in digits.iter().skip(MAX_U32_DECIMAL_DIGITS - len) {
        out.push(char::from(*digit));
    }
}

fn lower_hex_digit(nibble: u8) -> char {
    let digit = if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + (nibble - 10)
    };
    char::from(digit)
}

/// Bind a Linux abstract Unix listener for an operation-control endpoint name.
///
/// `name` is an abstract socket name, not a filesystem path. The resulting
/// listener is suitable for [`accept_with_timeout`].
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation, bind, and listen
/// failures are returned as operating-system `io::Error` values.
pub fn bind_abstract_listener(name: &str) -> io::Result<UnixListener> {
    let fd = create_unix_socket()?;
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    // SAFETY: fd is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid bound AF_UNIX socket.
    let ret = unsafe { libc::listen(fd.as_raw_fd(), LISTENER_BACKLOG) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a valid listener and ownership is transferred.
    Ok(unsafe { UnixListener::from_raw_fd(fd.into_raw_fd()) })
}

/// Connect to a Linux abstract Unix operation-local endpoint.
///
/// `name` is an abstract socket name, not a filesystem path. The caller must
/// perform the handshake required by the endpoint's protocol after connecting.
///
/// # Errors
///
/// Returns `InvalidInput` when `name` is empty, contains a NUL byte, or does
/// not fit in `sockaddr_un.sun_path`. Socket creation and connect failures are
/// returned as operating-system `io::Error` values.
pub fn connect_abstract(name: &str) -> io::Result<UnixStream> {
    connect_abstract_before(name, None)
}

/// Connect to a Linux abstract Unix endpoint within `timeout`.
///
/// The budget starts before socket setup and bounds waiting for space in the
/// listener's accept queue. The returned stream is blocking and close-on-exec,
/// with no read or write timeout; callers configure their own handshake limits.
///
/// # Errors
///
/// Returns `InvalidInput` for an invalid name or an overflowing deadline, and
/// `TimedOut` for an exhausted (including zero) timeout. Other socket errors,
/// including interruption, are returned without retrying the connection.
pub fn connect_abstract_with_timeout(name: &str, timeout: Duration) -> io::Result<UnixStream> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "connect timeout overflowed"))?;
    connect_abstract_before(name, Some(deadline))
}

fn connect_abstract_before(name: &str, deadline: Option<Instant>) -> io::Result<UnixStream> {
    let addr = abstract_sockaddr(name)?;
    let len = sockaddr_len(name);
    let stream = UnixStream::from(create_unix_socket()?);
    if let Some(deadline) = deadline {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(connect_timed_out)?;
        // Linux applies SO_SNDTIMEO to blocking connect, including AF_UNIX
        // accept-queue backpressure. A zero socket timeout would disable it.
        stream.set_write_timeout(Some(remaining))?;
    }
    // SAFETY: stream is a valid AF_UNIX socket, addr/len describe a sockaddr_un.
    let ret = unsafe {
        libc::connect(
            stream.as_raw_fd(),
            &addr as *const _ as *const libc::sockaddr,
            len,
        )
    };
    if ret != 0 {
        let error = io::Error::last_os_error();
        if deadline.is_some()
            && (error.kind() == io::ErrorKind::WouldBlock
                || error.raw_os_error() == Some(libc::EINPROGRESS))
        {
            return Err(connect_timed_out());
        }
        return Err(error);
    }
    if deadline.is_some() {
        stream.set_write_timeout(None)?;
    }
    Ok(stream)
}

fn connect_timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "control endpoint connect timed out",
    )
}

/// Send one workload-placement descriptor over a connected control stream.
///
/// The descriptor is transferred with `SCM_RIGHTS` alongside a one-byte
/// bootstrap marker. The sender retains ownership of its descriptor. This is
/// used on a dedicated authenticated bootstrap connection so the root guest
/// supervisor never has to make the capability inheritable across a
/// sandbox-user transition.
///
/// # Errors
///
/// Socket errors are returned as standard [`io::Error`] values. A short send
/// is reported as [`io::ErrorKind::WriteZero`].
pub fn send_workload_placement(stream: &UnixStream, placement: BorrowedFd<'_>) -> io::Result<()> {
    send_placement(stream, placement, WORKLOAD_PLACEMENT_MARKER)
}

/// Send one tool-placement descriptor over an authenticated broker stream.
///
/// # Errors
///
/// Socket and ancillary-data errors are returned as standard [`io::Error`]
/// values.
pub fn send_tool_placement(stream: &UnixStream, placement: BorrowedFd<'_>) -> io::Result<()> {
    send_placement(stream, placement, TOOL_PLACEMENT_MARKER)
}

fn send_placement(stream: &UnixStream, placement: BorrowedFd<'_>, marker: u8) -> io::Result<()> {
    let marker = [marker];
    let mut iov = libc::iovec {
        iov_base: marker.as_ptr().cast_mut().cast(),
        iov_len: marker.len(),
    };
    let mut ancillary = [0_usize; ANCILLARY_BUFFER_WORDS];
    let control_len = cmsg_space_for_one_fd();
    if control_len > std::mem::size_of_val(&ancillary) {
        return Err(io::Error::other(
            "workload placement ancillary buffer is too small",
        ));
    }
    // SAFETY: a zeroed msghdr is initialized below before sendmsg reads it.
    let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = ancillary_length(control_len)?;

    // SAFETY: message owns a suitably aligned ancillary buffer large enough
    // for one cmsghdr plus one RawFd payload.
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    if header.is_null() {
        return Err(io::Error::other(
            "workload placement ancillary header is unavailable",
        ));
    }
    // SAFETY: header points into the initialized ancillary buffer and its data
    // region is large enough for one RawFd.
    unsafe {
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = ancillary_length(cmsg_len_for_one_fd())?;
        std::ptr::write_unaligned(
            libc::CMSG_DATA(header).cast::<libc::c_int>(),
            placement.as_raw_fd(),
        );
    }

    loop {
        // SAFETY: message references live marker, iovec, and ancillary buffers
        // for the duration of this call.
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
        if sent == 1 {
            return Ok(());
        }
        if sent < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "workload placement bootstrap marker was not sent",
        ));
    }
}

/// Receive one workload-placement descriptor from a connected control stream.
///
/// The returned descriptor has close-on-exec set atomically by
/// `MSG_CMSG_CLOEXEC`. Exactly one `SCM_RIGHTS` descriptor and the expected
/// one-byte bootstrap marker are required; malformed ancillary data is rejected
/// and any received descriptors are closed before returning an error.
///
/// # Errors
///
/// Socket errors are returned as standard [`io::Error`] values. Missing,
/// truncated, or malformed descriptor bootstrap data returns
/// [`io::ErrorKind::InvalidData`].
pub fn receive_workload_placement(stream: &UnixStream) -> io::Result<OwnedFd> {
    receive_placement(stream, WORKLOAD_PLACEMENT_MARKER)
}

/// Receive one close-on-exec tool-placement descriptor.
///
/// # Errors
///
/// Socket errors and malformed ancillary data are returned as standard
/// [`io::Error`] values.
pub fn receive_tool_placement(stream: &UnixStream) -> io::Result<OwnedFd> {
    receive_placement(stream, TOOL_PLACEMENT_MARKER)
}

fn receive_placement(stream: &UnixStream, expected_marker: u8) -> io::Result<OwnedFd> {
    let mut marker = [0_u8; 1];
    let mut iov = libc::iovec {
        iov_base: marker.as_mut_ptr().cast(),
        iov_len: marker.len(),
    };
    let mut ancillary = [0_usize; ANCILLARY_BUFFER_WORDS];
    // SAFETY: a zeroed msghdr is initialized below before recvmsg writes it.
    let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = ancillary_length(std::mem::size_of_val(&ancillary))?;

    let received = loop {
        // SAFETY: message references writable marker, iovec, and ancillary
        // buffers for the duration of this call.
        let received =
            unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
        if received >= 0 {
            break received;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    };

    let descriptors = received_rights_descriptors(&message);
    let valid = received == 1
        && marker == [expected_marker]
        && message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) == 0
        && descriptors.len() == 1;
    if !valid {
        close_raw_descriptors(&descriptors);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid workload placement descriptor bootstrap",
        ));
    }

    let descriptor = descriptors.into_iter().next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "workload placement descriptor bootstrap was empty",
        )
    })?;
    // SAFETY: recvmsg installed this descriptor for the receiving process, it
    // appears exactly once in the validated rights message, and ownership is
    // transferred to the returned OwnedFd.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

/// Confirm that Guest Agent validated and adopted the workload placement.
///
/// # Errors
///
/// Stream write errors are returned unchanged.
pub fn write_workload_placement_confirmation(stream: &UnixStream) -> io::Result<()> {
    write_marker(stream, WORKLOAD_PLACEMENT_CONFIRM_MARKER)
}

/// Read Guest Agent's workload-placement adoption confirmation.
///
/// # Errors
///
/// EOF, stream errors, and an unexpected marker are returned as
/// [`io::Error`] values.
pub fn read_workload_placement_confirmation(stream: &UnixStream) -> io::Result<()> {
    read_marker(stream, WORKLOAD_PLACEMENT_CONFIRM_MARKER)
}

/// Confirm that the launcher wrote itself into the supplied tool cgroup.
///
/// # Errors
///
/// Stream write errors are returned unchanged.
pub fn write_tool_placement_confirmation(stream: &UnixStream) -> io::Result<()> {
    write_marker(stream, TOOL_PLACEMENT_CONFIRM_MARKER)
}

/// Read the launcher's tool-placement confirmation.
///
/// # Errors
///
/// EOF, stream errors, and an unexpected marker are returned as
/// [`io::Error`] values.
pub fn read_tool_placement_confirmation(stream: &UnixStream) -> io::Result<()> {
    read_marker(stream, TOOL_PLACEMENT_CONFIRM_MARKER)
}

/// Acknowledge that root revalidated the launcher's tool membership.
///
/// # Errors
///
/// Stream write errors are returned unchanged.
pub fn write_tool_placement_ack(stream: &UnixStream) -> io::Result<()> {
    write_marker(stream, TOOL_PLACEMENT_ACK_MARKER)
}

/// Wait for root to acknowledge exact tool placement.
///
/// # Errors
///
/// EOF, stream errors, and an unexpected marker are returned as
/// [`io::Error`] values.
pub fn read_tool_placement_ack(stream: &UnixStream) -> io::Result<()> {
    read_marker(stream, TOOL_PLACEMENT_ACK_MARKER)
}

fn write_marker(stream: &UnixStream, marker: u8) -> io::Result<()> {
    let mut stream = stream;
    stream.write_all(&[marker])
}

fn read_marker(stream: &UnixStream, expected: u8) -> io::Result<()> {
    let mut stream = stream;
    let mut marker = [0_u8; 1];
    stream.read_exact(&mut marker)?;
    if marker == [expected] {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid placement handshake marker",
        ))
    }
}

fn cmsg_space_for_one_fd() -> usize {
    // SAFETY: CMSG_SPACE performs only the platform alignment calculation.
    unsafe { libc::CMSG_SPACE(std::mem::size_of::<libc::c_int>() as _) as usize }
}

fn cmsg_len_for_one_fd() -> usize {
    // SAFETY: CMSG_LEN performs only the platform alignment calculation.
    unsafe { libc::CMSG_LEN(std::mem::size_of::<libc::c_int>() as _) as usize }
}

fn received_rights_descriptors(message: &libc::msghdr) -> Vec<libc::c_int> {
    let mut descriptors = Vec::new();
    // SAFETY: message and its ancillary buffer were initialized by recvmsg;
    // CMSG_FIRSTHDR/CMSG_NXTHDR stay within msg_controllen.
    let mut header = unsafe { libc::CMSG_FIRSTHDR(message) };
    while !header.is_null() {
        // SAFETY: header is a valid ancillary header returned by the CMSG
        // traversal helpers.
        let current = unsafe { &*header };
        let current_len = ancillary_length_usize(current.cmsg_len);
        if current.cmsg_level == libc::SOL_SOCKET
            && current.cmsg_type == libc::SCM_RIGHTS
            && current_len >= cmsg_len_for_one_fd()
        {
            let payload_bytes = current_len
                .saturating_sub(cmsg_len_for_one_fd() - std::mem::size_of::<libc::c_int>());
            let count = payload_bytes / std::mem::size_of::<libc::c_int>();
            // SAFETY: CMSG_DATA points at `count` complete RawFd values inside
            // the current ancillary record.
            let data = unsafe { libc::CMSG_DATA(header).cast::<libc::c_int>() };
            for index in 0..count {
                // SAFETY: index is bounded by the validated ancillary payload.
                descriptors.push(unsafe { std::ptr::read_unaligned(data.add(index)) });
            }
        }
        // SAFETY: header belongs to message's ancillary buffer.
        header = unsafe { libc::CMSG_NXTHDR(message, header) };
    }
    descriptors
}

fn close_raw_descriptors(descriptors: &[libc::c_int]) {
    for descriptor in descriptors {
        // SAFETY: each descriptor was installed by recvmsg and is discarded on
        // the malformed-bootstrap path.
        unsafe { libc::close(*descriptor) };
    }
}

#[cfg(target_env = "musl")]
fn ancillary_length(length: usize) -> io::Result<libc::socklen_t> {
    libc::socklen_t::try_from(length).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "workload placement ancillary length is out of range",
        )
    })
}

#[cfg(not(target_env = "musl"))]
fn ancillary_length(length: usize) -> io::Result<usize> {
    Ok(length)
}

#[cfg(target_env = "musl")]
fn ancillary_length_usize(length: libc::socklen_t) -> usize {
    length as usize
}

#[cfg(not(target_env = "musl"))]
fn ancillary_length_usize(length: usize) -> usize {
    length
}

/// Accept one stream from an operation-control listener before `timeout` elapses.
///
/// The listener is expected to come from [`bind_abstract_listener`].
///
/// # Errors
///
/// Returns `InvalidInput` if the timeout deadline overflows. Returns
/// `TimedOut` if no connection is accepted before the deadline. Poll and accept
/// failures are returned as operating-system `io::Error` values.
pub fn accept_with_timeout(listener: &UnixListener, timeout: Duration) -> io::Result<UnixStream> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "accept timeout overflowed"))?;
    loop {
        match poll_fd(listener.as_raw_fd(), libc::POLLIN, deadline)? {
            true => {
                // SAFETY: listener fd is valid and accept4 initializes addr/len.
                let fd = unsafe {
                    libc::accept4(
                        listener.as_raw_fd(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        libc::SOCK_CLOEXEC,
                    )
                };
                if fd >= 0 {
                    // SAFETY: fd is a connected stream returned by accept4.
                    return Ok(unsafe { UnixStream::from_raw_fd(fd) });
                }
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(err);
            }
            false => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control endpoint accept timed out",
                ));
            }
        }
    }
}

fn create_unix_socket() -> io::Result<OwnedFd> {
    // SAFETY: socket arguments are constants for an AF_UNIX stream socket.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a newly-created socket owned by this function.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn abstract_sockaddr(name: &str) -> io::Result<libc::sockaddr_un> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() + 1 > sockaddr_un_path_len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid abstract socket name",
        ));
    }

    // SAFETY: zeroed sockaddr_un is a valid starting point before fields are set.
    let mut addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    addr.sun_path[0] = 0;
    for (index, byte) in bytes.iter().enumerate() {
        let Some(slot) = addr.sun_path.get_mut(index + 1) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid abstract socket name",
            ));
        };
        *slot = *byte as libc::c_char;
    }
    Ok(addr)
}

fn sockaddr_un_path_len() -> usize {
    // SAFETY: zeroed sockaddr_un is only used to inspect array length.
    let addr = unsafe { MaybeUninit::<libc::sockaddr_un>::zeroed().assume_init() };
    addr.sun_path.len()
}

fn sockaddr_len(name: &str) -> libc::socklen_t {
    (size_of::<libc::sa_family_t>() + 1 + name.len()) as libc::socklen_t
}

fn poll_fd(fd: libc::c_int, events: libc::c_short, deadline: Instant) -> io::Result<bool> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let remaining = deadline.duration_since(now);
        let timeout_ms = i32::try_from(remaining.as_millis())
            .unwrap_or(i32::MAX)
            .max(1);
        let mut pfd = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: pfd points to a valid pollfd for one descriptor.
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret > 0 {
            return Ok((pfd.revents & events) != 0);
        }
        if ret == 0 {
            return Ok(false);
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

#[cfg(test)]
mod tests;
