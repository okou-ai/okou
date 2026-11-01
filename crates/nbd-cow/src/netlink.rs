//! NBD device setup via generic netlink.
//!
//! This module handles creating and destroying `/dev/nbdN` devices using the
//! kernel's NBD generic netlink interface. This is the modern approach (vs ioctl)
//! and supports multi-connection.
//!
//! Timeouts set on every connect:
//! - `NBD_ATTR_TIMEOUT = 30s`: per-request timeout. On expiry the kernel
//!   retries on another connection (multi-conn). Enables the dead-connection
//!   auto-disconnect path in the kernel's `nbd_xmit_timeout`.
//! - `NBD_ATTR_DEAD_CONN_TIMEOUT = 30s`: after all connections are dead for
//!   this long, the kernel auto-disconnects the device. Combined with the
//!   per-request timeout, orphaned devices (SIGKILL, no Drop) are reclaimed
//!   by the kernel within ~60s if there is pending I/O. Idle orphans still
//!   require `runner gc`.

use std::os::fd::{AsRawFd, OwnedFd};
use std::path::Path;
use std::time::Instant;

use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
use uuid::Uuid;

use crate::device::{NbdNetlinkConnectStage, NbdNetlinkConnectTiming};
use crate::error::{NbdCowError, Result};

mod socket;
mod wire;

// NBD generic netlink command constants (from include/uapi/linux/nbd-netlink.h)
const NBD_CMD_CONNECT: u8 = 1;
const NBD_CMD_DISCONNECT: u8 = 2;

// NBD generic netlink attribute types
const NBD_ATTR_INDEX: u16 = 1;
const NBD_ATTR_SIZE_BYTES: u16 = 2;
const NBD_ATTR_BLOCK_SIZE_BYTES: u16 = 3;
const NBD_ATTR_SERVER_FLAGS: u16 = 5;
const NBD_ATTR_SOCKETS: u16 = 7;
const NBD_ATTR_TIMEOUT: u16 = 4;
const NBD_ATTR_DEAD_CONN_TIMEOUT: u16 = 8;
const NBD_ATTR_BACKEND_IDENTIFIER: u16 = 10;

// NBD socket item attribute types (nested inside NBD_ATTR_SOCKETS)
const NBD_SOCK_ITEM: u16 = 1;
const NBD_SOCK_FD: u16 = 1;

// NBD server flags
const NBD_FLAG_HAS_FLAGS: u64 = 1 << 0;
const NBD_FLAG_SEND_FLUSH: u64 = 1 << 2;
const NBD_FLAG_SEND_TRIM: u64 = 1 << 5;
const NBD_FLAG_CAN_MULTI_CONN: u64 = 1 << 8;

// Generic netlink control family constants.
const GENL_ID_CTRL: u16 = 0x10;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_FAMILY_ID: u16 = 1;

/// Timeout (seconds) used for both `NBD_ATTR_TIMEOUT` and `NBD_ATTR_DEAD_CONN_TIMEOUT`.
const TIMEOUT_SECS: u64 = 30;

// NBD genl family version (from kernel: NBD_GENL_VERSION = 0x1)
const NBD_GENL_VERSION: u8 = 1;

/// Create a Unix socketpair for NBD communication.
pub fn create_socketpair() -> Result<(OwnedFd, OwnedFd)> {
    socketpair(
        AddressFamily::Unix,
        SockType::Stream,
        None,
        SockFlag::SOCK_CLOEXEC,
    )
    .map_err(|err| NbdCowError::Io(err.into()))
}

/// Read the kernel's nbds_max parameter to know how many devices are available.
///
/// Falls back to 256 when the sysfs parameter is unreadable (module not loaded).
/// The actual limit is set by ansible (`modprobe nbd nbds_max=4096`).
pub fn nbds_max() -> u32 {
    nbds_max_from_path(Path::new("/sys/module/nbd/parameters/nbds_max"))
}

fn nbds_max_from_path(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(256)
}

/// Generate a random offset in `0..max` for device scanning.
///
/// Uses `RandomState` (OS-seeded) to avoid pulling in an external RNG crate.
pub fn random_offset(max: u32) -> u32 {
    if max == 0 {
        return 0;
    }
    use std::hash::{BuildHasher, Hasher, RandomState};
    (RandomState::new().build_hasher().finish() % max as u64) as u32
}

/// Check if a device index appears free by inspecting its pid file.
pub fn device_appears_free(index: u32) -> bool {
    let pid_path = format!("/sys/block/nbd{index}/pid");
    device_pid_appears_free(Path::new(&pid_path), || {
        Path::new(&format!("/dev/nbd{index}")).exists()
    })
}

fn device_pid_appears_free<F>(pid_path: &Path, device_exists: F) -> bool
where
    F: FnOnce() -> bool,
{
    match std::fs::read_to_string(pid_path) {
        Ok(contents) => {
            let pid = contents.trim();
            pid == "-1" || pid == "0" || pid.is_empty()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => device_exists(),
        Err(_) => false, // Can't read pid file; EBUSY fallback will catch free devices.
    }
}

/// Successful NBD connect metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConnectDeviceSuccess {
    /// Unique identity exposed by the kernel in `/sys/block/nbdN/backend`.
    pub(crate) connection_id: Uuid,
}

/// Error state for `NBD_CMD_CONNECT`.
///
/// `NBD_CMD_CONNECT` has a kernel commit boundary: after the command is sent,
/// userspace may fail to observe completion even though the kernel accepted the
/// connection. Callers that own an NBD device lease need this state to decide
/// whether ownership-checked cleanup is required.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConnectDeviceError {
    /// The connect command was not sent to the kernel.
    #[error("NBD connect failed before sending command: {source}")]
    NotSent {
        /// Underlying error.
        source: NbdCowError,
    },
    /// The connect command was sent and the kernel returned a definitive error.
    #[error("NBD connect failed definitively after sending command: {source}")]
    DefiniteAfterSend {
        /// Underlying kernel/netlink error.
        source: NbdCowError,
    },
    /// The connect command was sent, but userspace could not observe completion.
    #[error("NBD connect completion is ambiguous after sending command: {source}")]
    AmbiguousAfterSend {
        /// Unique identity included in the connect command.
        connection_id: Uuid,
        /// Underlying completion-observation error.
        source: NbdCowError,
    },
}

impl ConnectDeviceError {
    /// Return the underlying error for legacy callers that do not need state.
    pub(crate) fn into_source(self) -> NbdCowError {
        match self {
            Self::NotSent { source }
            | Self::DefiniteAfterSend { source }
            | Self::AmbiguousAfterSend { source, .. } => source,
        }
    }
}

/// Connect to a specific NBD device by index.
///
/// The caller provides the device index (typically from a `DevicePool`).
/// Returns `Ok(())` on success, or an error. In
/// particular, `NbdCowError::NetlinkErrno { errno: EBUSY }` means the device
/// was grabbed by another process between validation and connect.
pub fn connect_device(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u64,
) -> Result<()> {
    connect_device_with_state(device_index, client_fds, size, block_size)
        .map(|_| ())
        .map_err(ConnectDeviceError::into_source)
}

/// Connect to a specific NBD device and preserve post-send ambiguity state.
pub(crate) fn connect_device_with_state(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u64,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    connect_device_with_state_timing(device_index, client_fds, size, block_size).0
}

pub(crate) fn connect_device_with_state_timing(
    device_index: u32,
    client_fds: &[OwnedFd],
    size: u64,
    block_size: u64,
) -> (
    std::result::Result<ConnectDeviceSuccess, ConnectDeviceError>,
    NbdNetlinkConnectTiming,
) {
    let setup_started_at = Instant::now();
    let mut timing = NbdNetlinkConnectTiming::default();
    let setup_result = (|| {
        let sockets_payload_len = validate_connect_socket_count(client_fds.len())?;
        let sock =
            socket::open_genl_socket().map_err(|source| ConnectDeviceError::NotSent { source })?;
        Ok((sockets_payload_len, sock))
    })();
    timing.record_stage(
        NbdNetlinkConnectStage::SocketSetup,
        setup_started_at,
        setup_result.is_ok(),
    );
    let (sockets_payload_len, sock) = match setup_result {
        Ok(setup) => setup,
        Err(error) => return (Err(error), timing),
    };

    let family_started_at = Instant::now();
    let family_result =
        resolve_nbd_family(&sock).map_err(|source| ConnectDeviceError::NotSent { source });
    timing.record_stage(
        NbdNetlinkConnectStage::FamilyResolve,
        family_started_at,
        family_result.is_ok(),
    );
    let family_id = match family_result {
        Ok(family_id) => family_id,
        Err(error) => return (Err(error), timing),
    };

    let command_started_at = Instant::now();
    let sockets_nla = build_sockets_nla(client_fds, sockets_payload_len);
    let connection_id = Uuid::new_v4();
    let backend_identifier = format!("{connection_id}\0");
    let flags =
        NBD_FLAG_HAS_FLAGS | NBD_FLAG_SEND_FLUSH | NBD_FLAG_SEND_TRIM | NBD_FLAG_CAN_MULTI_CONN;

    let mut attrs = Vec::new();
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_INDEX,
        &device_index.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(NBD_ATTR_SIZE_BYTES, &size.to_ne_bytes()));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_BLOCK_SIZE_BYTES,
        &block_size.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_SERVER_FLAGS,
        &flags.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_TIMEOUT,
        &TIMEOUT_SECS.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_DEAD_CONN_TIMEOUT,
        &TIMEOUT_SECS.to_ne_bytes(),
    ));
    attrs.extend_from_slice(&wire::build_nla(
        NBD_ATTR_BACKEND_IDENTIFIER,
        backend_identifier.as_bytes(),
    ));
    attrs.extend_from_slice(&sockets_nla);

    let result = match send_nbd_genl_msg(&sock, family_id, NBD_CMD_CONNECT, &attrs) {
        Ok(seq) => finish_connect_after_send(&sock, seq, connection_id),
        Err(source) => Err(ConnectDeviceError::NotSent { source }),
    };
    timing.record_stage(
        NbdNetlinkConnectStage::ConnectCommand,
        command_started_at,
        result.is_ok(),
    );

    (result, timing)
}

/// Check whether the device has the expected size via sysfs.
///
/// Returns `true` if the size matches within a brief polling window.
/// On reconnect (same index after a recent disconnect), the kernel may
/// briefly report the old (zero) capacity before the new config takes
/// effect. A few milliseconds of polling handles this.
///
/// Uses sync `std::fs::read_to_string` for sysfs reads; these are
/// kernel-memory backed and complete in microseconds, so they do not
/// meaningfully block the tokio worker thread.
pub async fn verify_device_size(device_index: u32, expected_size: u64) -> bool {
    debug_assert!(
        expected_size.is_multiple_of(512),
        "expected_size must be 512-aligned"
    );
    let expected_sectors = expected_size / 512;
    let size_path = format!("/sys/block/nbd{device_index}/size");
    for _ in 0..5 {
        if let Ok(content) = std::fs::read_to_string(&size_path) {
            let sectors: u64 = content.trim().parse().unwrap_or(0);
            if sectors == expected_sectors {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

/// Disconnect an NBD device via generic netlink.
pub fn disconnect(device_index: u32) -> Result<()> {
    let sock = socket::open_genl_socket()?;
    let family_id = resolve_nbd_family(&sock)?;

    let attrs = wire::build_nla(NBD_ATTR_INDEX, &device_index.to_ne_bytes());
    let seq = send_nbd_genl_msg(&sock, family_id, NBD_CMD_DISCONNECT, &attrs)?;
    recv_genl_completion(&sock, seq)?;

    Ok(())
}

// --- Internal netlink helpers ---

fn resolve_nbd_family(sock: &socket::GenlSocket) -> Result<u16> {
    let request_attrs = wire::build_nla(CTRL_ATTR_FAMILY_NAME, b"nbd\0");
    // The family reply itself confirms success. Requesting a success ACK here
    // would leave an extra datagram queued before the following NBD command.
    let seq = socket::send_genl_msg(
        sock,
        GENL_ID_CTRL,
        CTRL_CMD_GETFAMILY,
        1,
        &request_attrs,
        false,
    )?;

    let mut buf = vec![0u8; 4096];
    let n = socket::recv_for_seq(sock, &mut buf, seq)?;
    let reply_attrs = match wire::parse_genl_response(&buf, n)? {
        wire::GenlResponse::Reply { attrs } => attrs,
        wire::GenlResponse::Ack => {
            return Err(NbdCowError::Netlink(
                "unexpected ACK while resolving NBD family".into(),
            ));
        }
    };

    wire::find_nla_u16(reply_attrs, CTRL_ATTR_FAMILY_ID, "truncated family id")?
        .ok_or_else(|| NbdCowError::Netlink("NBD family ID not found in response".into()))
}

fn send_nbd_genl_msg(
    sock: &socket::GenlSocket,
    family_id: u16,
    cmd: u8,
    attrs: &[u8],
) -> Result<u32> {
    socket::send_genl_msg(sock, family_id, cmd, NBD_GENL_VERSION, attrs, true)
}

fn recv_genl_completion(sock: &socket::GenlSocket, expected_seq: u32) -> Result<()> {
    let mut buf = vec![0u8; 4096];
    let n = socket::recv_for_seq(sock, &mut buf, expected_seq)?;
    parse_genl_completion(&buf, n)
}

fn finish_connect_after_send(
    sock: &socket::GenlSocket,
    expected_seq: u32,
    connection_id: Uuid,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    classify_connect_completion(connection_id, recv_genl_completion(sock, expected_seq))
}

fn classify_connect_completion(
    connection_id: Uuid,
    completion: Result<()>,
) -> std::result::Result<ConnectDeviceSuccess, ConnectDeviceError> {
    match completion {
        Ok(()) => Ok(ConnectDeviceSuccess { connection_id }),
        Err(source @ NbdCowError::NetlinkErrno { .. }) => {
            Err(ConnectDeviceError::DefiniteAfterSend { source })
        }
        Err(source) => Err(ConnectDeviceError::AmbiguousAfterSend {
            connection_id,
            source,
        }),
    }
}

fn parse_genl_completion(buf: &[u8], n: usize) -> Result<()> {
    match wire::parse_genl_response(buf, n)? {
        // NBD connect returns a genetlink reply on success; other commands may
        // complete with a netlink ACK. Non-zero NLMSG_ERROR is handled above.
        wire::GenlResponse::Ack | wire::GenlResponse::Reply { .. } => Ok(()),
    }
}

fn validate_connect_socket_count(
    socket_count: usize,
) -> std::result::Result<usize, ConnectDeviceError> {
    sockets_payload_len(socket_count).map_err(|source| ConnectDeviceError::NotSent { source })
}

fn sockets_payload_len(socket_count: usize) -> Result<usize> {
    let Some(fd_nla_len) = wire::aligned_nla_len_for_payload(std::mem::size_of::<u32>()) else {
        return Err(NbdCowError::Netlink(
            "NBD socket fd attribute too large".into(),
        ));
    };
    let Some(item_nla_len) = wire::aligned_nla_len_for_payload(fd_nla_len) else {
        return Err(NbdCowError::Netlink(
            "NBD socket item attribute too large".into(),
        ));
    };
    let Some(payload_len) = item_nla_len.checked_mul(socket_count) else {
        return Err(NbdCowError::Netlink("NBD socket list too large".into()));
    };
    if payload_len > wire::MAX_NLA_PAYLOAD_LEN {
        return Err(NbdCowError::Netlink("NBD socket list too large".into()));
    }
    Ok(payload_len)
}

/// Build the nested NBD_ATTR_SOCKETS NLA from a list of client fds.
fn build_sockets_nla(client_fds: &[OwnedFd], sockets_payload_len: usize) -> Vec<u8> {
    let mut sockets_payload = Vec::with_capacity(sockets_payload_len);
    for fd in client_fds {
        let raw_fd = fd.as_raw_fd() as u32;
        let fd_nla = wire::build_nla(NBD_SOCK_FD, &raw_fd.to_ne_bytes());
        let item_nla = wire::build_nested_nla(NBD_SOCK_ITEM, &fd_nla);
        sockets_payload.extend_from_slice(&item_nla);
    }
    wire::build_nested_nla(NBD_ATTR_SOCKETS, &sockets_payload)
}

#[cfg(test)]
mod tests;
