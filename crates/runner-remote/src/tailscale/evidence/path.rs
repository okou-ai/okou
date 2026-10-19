//! Finite metadata at owned packet/IO boundaries; packet bodies never enter reports.

use serde::Serialize;
use std::time::Instant;
use ts_netstack_smoltcp_core::smoltcp::wire::{
    IpProtocol, IpVersion, Ipv4Packet, Ipv6Packet, TcpPacket,
};

use super::{Detail, Trace};

#[derive(Clone, Copy)]
pub(in crate::tailscale) enum Flow {
    TcpSyn,
    TcpReply,
    TcpSynAck,
    TcpReset,
    EncryptedOutput,
    RelayQueued,
    RelayFlushed,
    LabelledInput,
    WireGuard { received: bool, kind: WireKind },
}

#[derive(Clone, Copy)]
pub(in crate::tailscale) enum WireKind {
    Initiation,
    Response,
    Cookie,
    Transport,
}

impl WireKind {
    /// Shape/header observations only. The SDK alone authenticates these frames.
    pub(in crate::tailscale) fn observed(bytes: &[u8]) -> Option<Self> {
        match (bytes.get(..4)?, bytes.len()) {
            ([1, 0, 0, 0], 148) => Some(Self::Initiation),
            ([2, 0, 0, 0], 92) => Some(Self::Response),
            ([3, 0, 0, 0], 64) => Some(Self::Cookie),
            ([4, 0, 0, 0], length) if length >= 32 => Some(Self::Transport),
            _ => None,
        }
    }
}

#[derive(Clone, Default, Serialize)]
struct WireProgress {
    produced: WireCounts,
    received: WireCounts,
}

#[derive(Clone, Default, Serialize)]
struct WireCounts {
    #[serde(skip_serializing_if = "Count::empty")]
    initiation: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    response: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    cookie: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    transport: Count,
}

impl WireCounts {
    fn empty(&self) -> bool {
        [
            &self.initiation,
            &self.response,
            &self.cookie,
            &self.transport,
        ]
        .into_iter()
        .all(Count::empty)
    }

    fn count_mut(&mut self, kind: WireKind) -> &mut Count {
        match kind {
            WireKind::Initiation => &mut self.initiation,
            WireKind::Response => &mut self.response,
            WireKind::Cookie => &mut self.cookie,
            WireKind::Transport => &mut self.transport,
        }
    }
}

impl WireProgress {
    fn empty(&self) -> bool {
        self.produced.empty() && self.received.empty()
    }
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct Count {
    pub(crate) count: u32,
    pub(crate) last_ms: u64,
}

impl Count {
    fn empty(&self) -> bool {
        self.count == 0
    }
}

#[derive(Clone, Serialize)]
pub(crate) struct Progress {
    pub(crate) elapsed_ms: u64,
    #[serde(skip_serializing_if = "Count::empty")]
    syn: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    replies: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    syn_ack: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    reset: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    encrypted: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    queued: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    flushed: Count,
    #[serde(skip_serializing_if = "Count::empty")]
    labelled: Count,
    #[serde(skip_serializing_if = "WireProgress::empty")]
    wireguard: WireProgress,
    #[serde(skip)]
    started: Instant,
}

impl Default for Progress {
    fn default() -> Self {
        Self {
            elapsed_ms: 0,
            syn: Count::default(),
            replies: Count::default(),
            syn_ack: Count::default(),
            reset: Count::default(),
            encrypted: Count::default(),
            queued: Count::default(),
            flushed: Count::default(),
            labelled: Count::default(),
            wireguard: WireProgress::default(),
            started: Instant::now(),
        }
    }
}

impl Progress {
    pub(crate) fn reset_observed(&self) -> bool {
        self.reset.count != 0
    }
    pub(super) fn freeze(&mut self) {
        self.elapsed_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    }
    pub(super) fn record(&mut self, flow: Flow, count: usize) {
        let value = match flow {
            Flow::TcpSyn => &mut self.syn,
            Flow::TcpReply => &mut self.replies,
            Flow::TcpSynAck => &mut self.syn_ack,
            Flow::TcpReset => &mut self.reset,
            Flow::EncryptedOutput => &mut self.encrypted,
            Flow::RelayQueued => &mut self.queued,
            Flow::RelayFlushed => &mut self.flushed,
            Flow::LabelledInput => &mut self.labelled,
            Flow::WireGuard { received, kind } => {
                let counts = if received {
                    &mut self.wireguard.received
                } else {
                    &mut self.wireguard.produced
                };
                counts.count_mut(kind)
            }
        };
        value.count = value
            .count
            .saturating_add(count.min(u32::MAX as usize) as u32);
        value.last_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    }

    pub(crate) fn observations(&self) -> [(&'static str, &Count, bool); 16] {
        [
            ("TCP SYN produced", &self.syn, false),
            ("authenticated TCP packets received", &self.replies, false),
            ("authenticated TCP SYN-ACK received", &self.syn_ack, false),
            ("authenticated TCP RST received", &self.reset, false),
            ("WireGuard frames produced", &self.encrypted, true),
            ("relay frames queued", &self.queued, true),
            ("relay frames flushed locally", &self.flushed, true),
            ("peer-labelled frames received", &self.labelled, true),
            (
                "WireGuard initiation produced",
                &self.wireguard.produced.initiation,
                true,
            ),
            (
                "WireGuard response produced",
                &self.wireguard.produced.response,
                true,
            ),
            (
                "WireGuard cookie produced",
                &self.wireguard.produced.cookie,
                true,
            ),
            (
                "WireGuard transport-data produced",
                &self.wireguard.produced.transport,
                true,
            ),
            (
                "WireGuard initiation header received",
                &self.wireguard.received.initiation,
                true,
            ),
            (
                "WireGuard response header received",
                &self.wireguard.received.response,
                true,
            ),
            (
                "WireGuard cookie header received",
                &self.wireguard.received.cookie,
                true,
            ),
            (
                "WireGuard transport-data header received",
                &self.wireguard.received.transport,
                true,
            ),
        ]
    }

    pub(crate) fn handshake_only_output(&self) -> bool {
        self.wireguard.produced.initiation.count != 0
            && self.wireguard.produced.transport.count == 0
    }
}

impl Trace {
    /// Call only after exact-tuple and authenticated source admission for receive.
    pub(in crate::tailscale) fn tcp_packet(&self, bytes: &[u8], received: bool) {
        if self.state.is_none() {
            return;
        }
        let flags = match IpVersion::of_packet(bytes).ok() {
            Some(IpVersion::Ipv4) => {
                let Ok(ip) = Ipv4Packet::new_checked(bytes) else {
                    return;
                };
                if ip.next_header() != IpProtocol::Tcp || ip.more_frags() || ip.frag_offset() != 0 {
                    return;
                }
                tcp_flags(ip.payload())
            }
            Some(IpVersion::Ipv6) => {
                let Ok(ip) = Ipv6Packet::new_checked(bytes) else {
                    return;
                };
                if ip.next_header() != IpProtocol::Tcp {
                    return;
                }
                tcp_flags(ip.payload())
            }
            _ => None,
        };
        let Some((syn, ack, rst)) = flags else {
            return;
        };
        if received {
            self.flow(Flow::TcpReply, 1);
        }
        if !received && syn && !ack {
            self.flow(Flow::TcpSyn, 1);
        }
        if received && syn && ack {
            self.flow(Flow::TcpSynAck, 1);
        }
        if received && rst {
            self.flow(Flow::TcpReset, 1);
        }
    }
}

fn tcp_flags(bytes: &[u8]) -> Option<(bool, bool, bool)> {
    let tcp = TcpPacket::new_checked(bytes).ok()?;
    Some((tcp.syn(), tcp.ack(), tcp.rst()))
}

impl Detail {
    pub(in crate::tailscale) fn io(error: &std::io::Error) -> Self {
        use std::io::ErrorKind as E;
        match error.kind() {
            E::ConnectionRefused => Self::Refused,
            E::ConnectionReset | E::ConnectionAborted => Self::Reset,
            E::TimedOut => Self::TimedOut,
            E::UnexpectedEof => Self::EndOfStream,
            E::HostUnreachable | E::NetworkUnreachable => Self::Unreachable,
            E::InvalidData | E::InvalidInput => Self::Invalid,
            E::PermissionDenied => Self::Rejected,
            _ => Self::Io,
        }
    }

    pub(in crate::tailscale) fn netstack(error: ts_netstack_smoltcp_core::Error) -> Self {
        use ts_netstack_smoltcp_core::Error as E;
        match error {
            E::ConnectionReset => Self::ResetOrClosed,
            E::BadRequest(_) => Self::InvalidRequest,
            E::Internal(_) => Self::Internal,
        }
    }

    pub(in crate::tailscale) fn derp(error: &ts_derp::Error) -> Self {
        match error {
            ts_derp::Error::IoFailure(error) => Self::io(error),
            ts_derp::Error::BadUrl(_) | ts_derp::Error::Deserialize(_) => Self::Invalid,
            _ => Self::Protocol,
        }
    }
}
