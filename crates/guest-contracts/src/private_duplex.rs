//! Version 1 private, run-assignment Guest duplex wire limits.
//! One Guest-initiated vsock stream per logical channel: one activation byte,
//! then four-byte big-endian length-prefixed opaque data in each direction.
//! EOF half-closes the corresponding direction; errors reset the connection.

/// One private Guest-to-host listener shared with existing Guest RPC.
pub const VSOCK_PORT: u32 = 52001;
/// Reserved first byte of a duplex connection. Valid RPC request lengths cannot begin with 0xff.
pub const PREFACE: u8 = 0xff;
/// Non-authorizing ingress acknowledgement: the host recognized this preface.
pub const READY: u8 = 2;
/// One-byte host acceptance marker sent only after assignment admission.
pub const ACTIVATE: u8 = 1;
/// Maximum payload in one direction's length-prefixed frame.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Maximum active duplex stream workers per run/sandbox.
pub const MAX_STREAMS_PER_RUN: usize = 8;
