//! Version 1 private, run-assignment Guest duplex wire limits.
//! One Guest-initiated vsock stream per logical channel: host `READY` acknowledges
//! a pending slot, then host `ACTIVATE` admits the exact run assignment.
//! Guest `ACTIVATED` confirms a started, initialized worker before attachment
//! succeeds. Both directions then use four-byte big-endian length-prefixed opaque data.
//! EOF half-closes its direction; framing errors invalidate the channel and
//! require its owner to close the stream.

/// Dedicated private Guest-to-host listener, independent of control and RPC.
pub const VSOCK_PORT: u32 = 52002;
/// Non-authorizing ingress acknowledgement: the host reserved the pending slot.
pub const READY: u8 = 2;
/// One-byte host acceptance marker sent only after assignment admission.
pub const ACTIVATE: u8 = 1;
/// Guest worker readiness marker, sent after thread startup and buffer initialization.
pub const ACTIVATED: u8 = 3;
/// Maximum payload in one direction's length-prefixed frame.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Maximum active duplex stream workers per run/sandbox.
pub const MAX_STREAMS_PER_RUN: usize = 8;
