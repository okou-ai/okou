#![deny(unsafe_code)]

use std::cell::Cell;
use std::os::fd::{AsRawFd, OwnedFd};

use nix::errno::Errno;
#[cfg(test)]
use nix::sys::socket::socketpair;
use nix::sys::socket::{
    AddressFamily, MsgFlags, NetlinkAddr, SockFlag, SockProtocol, SockType, bind, recv, send,
    setsockopt, socket, sockopt,
};
use nix::sys::time::{TimeVal, TimeValLike};

use crate::error::{NbdCowError, Result};

use super::wire;

pub(super) struct GenlSocket {
    fd: OwnedFd,
    next_seq: Cell<u32>,
}

impl GenlSocket {
    fn next_seq(&self) -> u32 {
        let seq = self.next_seq.get();
        self.next_seq.set(seq.wrapping_add(1).max(1));
        seq
    }
}

fn errno_to_io(err: Errno) -> NbdCowError {
    NbdCowError::Io(err.into())
}

pub(super) fn open_genl_socket() -> Result<GenlSocket> {
    let fd = socket(
        AddressFamily::Netlink,
        SockType::Datagram,
        SockFlag::SOCK_CLOEXEC,
        SockProtocol::NetlinkGeneric,
    )
    .map_err(errno_to_io)?;

    bind(fd.as_raw_fd(), &NetlinkAddr::new(0, 0)).map_err(errno_to_io)?;

    // Set a receive timeout so recv() doesn't block forever if the
    // kernel never sends a completion message (e.g., nbd module unloaded
    // mid-call).
    setsockopt(&fd, sockopt::ReceiveTimeout, &TimeVal::seconds(5)).map_err(errno_to_io)?;

    Ok(GenlSocket {
        fd,
        next_seq: Cell::new(1),
    })
}

pub(super) fn send_genl_msg(
    sock: &GenlSocket,
    msg_type: u16,
    cmd: u8,
    version: u8,
    attrs: &[u8],
    request_ack: bool,
) -> Result<u32> {
    let seq = sock.next_seq();
    let msg = wire::build_genl_msg(msg_type, cmd, version, attrs, seq, request_ack);
    send_nl(sock, &msg)?;
    Ok(seq)
}

pub(super) fn recv_for_seq(sock: &GenlSocket, buf: &mut [u8], expected_seq: u32) -> Result<usize> {
    loop {
        let n = recv_nl(sock, buf)?;
        if wire::parse_nl_header(buf, n)?.seq == expected_seq {
            return Ok(n);
        }
    }
}

fn send_nl(sock: &GenlSocket, msg: &[u8]) -> Result<()> {
    send(sock.fd.as_raw_fd(), msg, MsgFlags::empty()).map_err(errno_to_io)?;
    Ok(())
}

fn recv_nl(sock: &GenlSocket, buf: &mut [u8]) -> Result<usize> {
    loop {
        match recv(sock.fd.as_raw_fd(), buf, MsgFlags::empty()) {
            Ok(n) => return Ok(n),
            Err(Errno::EINTR) => {
                // EINTR — retry
            }
            Err(err) => return Err(errno_to_io(err)),
        }
    }
}

#[cfg(test)]
pub(super) fn test_genl_socket_pair() -> (GenlSocket, OwnedFd) {
    let (recv_fd, send_fd) = socketpair(
        AddressFamily::Unix,
        SockType::Datagram,
        None,
        SockFlag::empty(),
    )
    .unwrap();
    set_test_recv_timeout(&recv_fd);
    (
        GenlSocket {
            fd: recv_fd,
            next_seq: Cell::new(1),
        },
        send_fd,
    )
}

#[cfg(test)]
pub(super) fn send_test_nl(peer: &OwnedFd, msg: &[u8]) {
    assert_eq!(
        send(peer.as_raw_fd(), msg, MsgFlags::empty()).unwrap(),
        msg.len()
    );
}

#[cfg(test)]
fn set_test_recv_timeout(fd: &OwnedFd) {
    setsockopt(fd, sockopt::ReceiveTimeout, &TimeVal::microseconds(100_000)).unwrap();
}

#[cfg(test)]
mod tests;
