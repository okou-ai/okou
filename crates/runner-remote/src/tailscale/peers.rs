//! Exact assigned-address routes and TCP tuples under one owned SDK data plane.
//! All changes and packet admission are serialized by the native runtime owner.

#[cfg(test)]
use std::io;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::Context,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;
use ts_bart::{RoutingTable, Table};
use ts_control::{Node, NodeId, PeerUpdate, StateUpdate};
use ts_dataplane::DataPlane;
use ts_keys::{NodeKeyPair, NodePublicKey};
use ts_netstack_smoltcp_core::smoltcp::wire::{
    IpProtocol, IpVersion, Ipv4Packet, Ipv6Packet, TcpPacket,
};
use ts_packet::PacketMut;
use ts_packetfilter::{Filter, PacketInfo, filter::CapIter};
use ts_transport::{DynEndpoint, OverlayTransportId, PeerId, UnderlayTransportId};

use super::Failure;

const MAX_PEERS: usize = 256;
const MAX_CONNECTIONS: usize = 24;
const MAX_PACKETS: usize = 64;
const MTU: usize = 1280;
const INVENTORY_BYTES: usize = 4 * 1024 * 1024;
const POLICY_BYTES: usize = 1024 * 1024;
// Tailscale's Go zero time denotes a key without expiry.
const NO_KEY_EXPIRY: chrono::DateTime<chrono::Utc> =
    chrono::DateTime::from_timestamp(-62_135_596_800, 0).unwrap();
type Underlay = HashMap<(UnderlayTransportId, DynEndpoint), Vec<PacketMut>>;
pub(super) type Incoming = (Frames, Received);

struct Generation {
    epoch: AtomicU64,
    live: AtomicBool,
}

pub(super) struct FrameStamp {
    diagnostics: bool,
    generation: Weak<Generation>,
    epoch: u64,
    expires: Option<chrono::DateTime<chrono::Utc>>,
    pub(super) node: NodePublicKey,
    pub(super) peer: NodePublicKey,
    bindings: Vec<Weak<Binding>>,
    readers: [Pin<Box<dyn Future<Output = ()> + Send>>; 2],
}

impl FrameStamp {
    pub(super) fn observe(&self, flow: super::evidence::Flow) {
        if self.diagnostics && self.current() {
            for binding in self.bindings.iter().filter_map(Weak::upgrade) {
                binding.trace.flow(flow, 1);
            }
        }
    }
    pub(super) fn poll_current(&mut self, cx: &mut Context<'_>, writing: bool) -> bool {
        // Completion seals the frame even if a wall-clock adjustment makes
        // the absolute key expiry appear future again. Never repoll a finished
        // watcher; the raw IO gate poisons this packet on the first false.
        let [reading, writer] = &mut self.readers;
        let reader = if writing { writer } else { reading };
        reader.as_mut().poll(cx).is_pending() && self.current()
    }

    pub(super) fn current(&self) -> bool {
        self.generation.upgrade().is_some_and(|generation| {
            generation.live.load(Ordering::Acquire)
                && generation.epoch.load(Ordering::Acquire) == self.epoch
                && self
                    .bindings
                    .iter()
                    .all(|binding| binding.upgrade().is_some_and(|binding| binding.live()))
                && self
                    .expires
                    .is_none_or(|expires| expires > chrono::Utc::now())
        })
    }
}

/// The actual ciphertext and its permit move together into the final writer.
pub(super) struct Outbound {
    pub(super) destination: NodePublicKey,
    pub(super) bytes: PacketMut,
    pub(super) stamp: FrameStamp,
    pub(super) permit: OwnedSemaphorePermit,
}

/// Ciphertext stays opaque until the same serialized owner commits it to IO.
/// A retained batch reserves node capacity even while its writer is blocked.
pub(super) struct Frames {
    owner: Arc<()>,
    epoch: u64,
    packets: VecDeque<(UnderlayTransportId, DynEndpoint, PacketMut)>,
    permit: Option<OwnedSemaphorePermit>,
}

impl Frames {
    pub(super) fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }
    fn clear(&mut self) {
        self.packets.clear();
        self.permit.take();
    }
    #[cfg(test)]
    fn release_one(&mut self) {
        drop(self.permit.as_mut().and_then(|permit| permit.split(1)));
    }
}

/// Decrypted bytes also require current identity/tuple admission at delivery.
pub(super) struct Received {
    owner: Arc<()>,
    packets: VecDeque<(Arc<Binding>, PacketMut)>,
    permit: Option<OwnedSemaphorePermit>,
}

#[cfg(test)]
impl Received {
    pub(super) fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    id: NodeId,
    stable: ts_control::StableNodeId,
    key: NodePublicKey,
    hostname: String,
    tailnet: String,
    addresses: ts_control::TailnetAddress,
    expires: Option<chrono::DateTime<chrono::Utc>>,
}

impl Identity {
    fn from_node(node: &Node) -> Result<Self, Failure> {
        let tailnet = node.tailnet.as_deref().ok_or(Failure::DomainFailed)?;
        let hostname = canonical_name(&node.hostname)?;
        let tailnet = canonical_name(tailnet)?;
        let ipv4 = node.tailnet_address.ipv4;
        let ipv6 = node.tailnet_address.ipv6;
        let v4 = ipv4.addr().octets();
        let v6 = ipv6.addr().segments();
        if node.id <= 0
            || node.stable_id.0.is_empty()
            || node.stable_id.0.len() > 256
            || !node.stable_id.0.is_ascii()
            || hostname.contains('.')
            || !tailnet.ends_with(".ts.net")
            || hostname.len() + 1 + tailnet.len() > 253
            || ipv4.prefix_len() != 32
            || ipv6.prefix_len() != 128
            || v4[0] != 100
            || !(64..=127).contains(&v4[1])
            || v6[..3] != [0xfd7a, 0x115c, 0xa1e0]
            || node.node_key == NodePublicKey::from_bytes([0; 32])
        {
            return Err(Failure::DomainFailed);
        }
        if node.underlay_addresses.len() > 64
            || node.accepted_routes.len() > 256
            || node.tags.len() > 64
            || node.tags.iter().any(|tag| tag.len() > 256)
            || node
                .tailnet_lock_key_signature
                .as_ref()
                .is_some_and(|signature| signature.len() > 4096)
            || node.node_capabilities.len() > 64
            || node.node_capabilities.iter().any(|(key, values)| {
                key.len() > 256 || values.len() > 64 || values.iter().any(|value| value.len() > 256)
            })
            || node
                .node_capabilities
                .iter()
                .map(|(key, values)| key.len() + values.iter().map(String::len).sum::<usize>())
                .sum::<usize>()
                > 8192
        {
            return Err(Failure::DomainFailed);
        }
        Ok(Self {
            id: node.id,
            stable: node.stable_id.clone(),
            key: node.node_key,
            hostname,
            tailnet,
            addresses: node.tailnet_address.clone(),
            expires: node
                .node_key_expiry
                .filter(|expiry| *expiry != NO_KEY_EXPIRY),
        })
    }

    fn expired(&self) -> bool {
        self.expires
            .is_some_and(|expires| expires <= chrono::Utc::now())
    }
}

fn canonical_name(name: &str) -> Result<String, Failure> {
    let name = name.strip_suffix('.').unwrap_or(name);
    if name.len() > 253
        || name.is_empty()
        || !name.is_ascii()
        || name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err(Failure::DomainFailed);
    }
    Ok(name.to_ascii_lowercase())
}

struct Peer {
    node: Node,
    identity: Identity,
    handle: PeerId,
}

struct HeldBinding {
    binding: Weak<Binding>,
    handle: PeerId,
    retired: bool,
    // Conservative until this peer's SDK output proves the queue drained.
    pending_plaintext: bool,
}

pub(super) struct Binding {
    owner: Arc<()>,
    identity: Identity,
    handle: PeerId,
    local: SocketAddr,
    remote: SocketAddr,
    cancelled: CancellationToken,
    started: AtomicBool,
    trace: super::evidence::Trace,
}

impl Binding {
    pub(super) fn trace(&self) -> &super::evidence::Trace {
        &self.trace
    }
    pub(super) fn peer_key(&self) -> NodePublicKey {
        self.identity.key
    }
    pub(super) fn local(&self) -> SocketAddr {
        self.local
    }
    pub(super) fn remote(&self) -> SocketAddr {
        self.remote
    }
    pub(super) fn cancelled(&self) -> CancellationToken {
        self.cancelled.clone()
    }
    pub(super) fn live(&self) -> bool {
        !self.cancelled.is_cancelled() && !self.identity.expired()
    }
}
impl Drop for Binding {
    fn drop(&mut self) {
        self.cancelled.cancel();
    }
}

pub(super) struct Peers {
    diagnostics: bool,
    owner: Arc<()>,
    local: Identity,
    peers: HashMap<NodeId, Peer>,
    next_handle: u32,
    bindings: Vec<HeldBinding>,
    plane: DataPlane,
    policy: Arc<ts_packetfilter::HashbrownFilter>,
    frame_epoch: u64,
    generation: Arc<Generation>,
    frame_cancelled: CancellationToken,
    frame_budget: Arc<Semaphore>,
    receive_budget: Arc<Semaphore>,
    failed: bool,
}

impl Peers {
    pub(super) fn local_address(&self, ipv6: bool, port: u16) -> SocketAddr {
        SocketAddr::new(
            if ipv6 {
                IpAddr::V6(self.local.addresses.ipv6.addr())
            } else {
                IpAddr::V4(self.local.addresses.ipv4.addr())
            },
            port,
        )
    }

    pub(super) fn writable(&self) -> bool {
        self.frame_budget.available_permits() == MAX_PACKETS
    }

    pub(super) fn maintain(&mut self) -> Result<(), Failure> {
        self.reap_bindings();
        if self.failed || self.local.expired() {
            return self.fail();
        }
        Ok(())
    }
    pub(super) fn new(keys: NodeKeyPair, local: Node) -> Result<Self, Failure> {
        let local = Identity::from_node(&local)?;
        if local.key != keys.public || local.expired() {
            return Err(Failure::DomainFailed);
        }
        let mut plane = DataPlane::new(keys);
        let mut incoming = Table::default();
        for ip in [
            IpAddr::V4(local.addresses.ipv4.addr()),
            IpAddr::V6(local.addresses.ipv6.addr()),
        ] {
            incoming.insert(
                ipnet::IpNet::from(ip),
                ts_overlay_router::inbound::RouteAction::ToOverlay(OverlayTransportId(1)),
            );
        }
        plane.or_in.swap(incoming);
        Ok(Self {
            owner: Arc::new(()),
            diagnostics: super::evidence::Trace::current().enabled(),
            local,
            peers: HashMap::new(),
            next_handle: 0,
            bindings: Vec::new(),
            plane,
            policy: Default::default(),
            frame_epoch: 0,
            generation: Arc::new(Generation {
                epoch: AtomicU64::new(0),
                live: AtomicBool::new(true),
            }),
            frame_cancelled: CancellationToken::new(),
            frame_budget: Arc::new(Semaphore::new(MAX_PACKETS)),
            receive_budget: Arc::new(Semaphore::new(MAX_PACKETS)),
            failed: false,
        })
    }

    pub(super) fn update(&mut self, update: StateUpdate) -> Result<(), Failure> {
        if self.failed {
            return Err(Failure::DomainFailed);
        }
        if update
            .node
            .as_ref()
            .is_some_and(|node| Identity::from_node(node).map_or(true, |id| id != self.local))
        {
            return self.fail();
        }
        let result = self.update_peers(update.peer_update);
        if result.is_err() {
            return self.fail();
        }
        if self.diagnostics {
            for binding in self
                .bindings
                .iter()
                .filter_map(|held| held.binding.upgrade())
            {
                self.observe_status(&binding);
            }
        }
        if let Some((rules, named)) = update.packetfilter {
            // A changed provider policy has no proven per-stream byte cutoff. Seal
            // all old bindings and flush public peer queues before adopting it.
            let mut next = (*self.policy).clone();
            ts_packetfilter_state::apply_update(&mut next, rules, &named);
            if next.len() > 256
                || policy_cost(&next) > POLICY_BYTES
                || next.keys().any(|name| name.len() > 256)
                || next.values().map(Vec::len).sum::<usize>() > 4096
                || next.values().flatten().any(|rule| {
                    rule.src.pfxs.len() > 256
                        || rule.src.caps.len() > 64
                        || rule.src.caps.iter().any(|cap| cap.len() > 256)
                        || rule.protos.len() > 256
                        || rule.dst.len() > 256
                        || rule.dst.iter().any(|dst| dst.ips.len() > 256)
                })
            {
                return self.fail();
            }
            if next != *self.policy {
                self.seal_all();
                self.policy = Arc::new(next);
                self.plane.packet_filter = self.policy.clone();
            }
        }
        Ok(())
    }

    fn update_peers(&mut self, update: Option<PeerUpdate>) -> Result<(), Failure> {
        let Some(update) = update else {
            return Ok(());
        };
        let mut nodes = self
            .peers
            .iter()
            .map(|(id, peer)| (*id, peer.node.clone()))
            .collect::<HashMap<_, _>>();
        match update {
            PeerUpdate::Full(full) => {
                if full.len() > MAX_PEERS {
                    return Err(Failure::DomainFailed);
                }
                nodes.clear();
                for node in full {
                    if nodes.insert(node.id, node).is_some() {
                        return Err(Failure::DomainFailed);
                    }
                }
            }
            PeerUpdate::Delta {
                patch,
                upsert,
                remove,
            } => {
                if patch.len() > MAX_PEERS || upsert.len() > MAX_PEERS || remove.len() > MAX_PEERS {
                    return Err(Failure::DomainFailed);
                }
                // Match the control client's removal, complete-change, then patch order.
                for id in remove {
                    nodes.remove(&id);
                }
                for node in upsert {
                    nodes.insert(node.id, node);
                }
                for patch in patch {
                    if let Some(node) = nodes.get_mut(&patch.id) {
                        node.apply_update(&patch);
                    }
                }
            }
        }
        if nodes.len() > MAX_PEERS {
            return Err(Failure::DomainFailed);
        }
        let mut identities = HashMap::new();
        let mut stable = HashSet::new();
        let mut keys = HashSet::new();
        let mut addresses = HashSet::new();
        for ip in [
            IpAddr::V4(self.local.addresses.ipv4.addr()),
            IpAddr::V6(self.local.addresses.ipv6.addr()),
        ] {
            addresses.insert(ip);
        }
        stable.insert(self.local.stable.clone());
        keys.insert(self.local.key);
        let mut inventory_bytes = 0usize;
        for node in nodes.values() {
            let identity = Identity::from_node(node)?;
            inventory_bytes = inventory_bytes.saturating_add(node_cost(node));
            if inventory_bytes > INVENTORY_BYTES {
                return Err(Failure::ResourceExhausted);
            }
            if identity.id == self.local.id
                || !stable.insert(identity.stable.clone())
                || !keys.insert(identity.key)
                || !addresses.insert(IpAddr::V4(identity.addresses.ipv4.addr()))
                || !addresses.insert(IpAddr::V6(identity.addresses.ipv6.addr()))
            {
                return Err(Failure::DomainFailed);
            }
            identities.insert(node.id, identity);
        }
        let new_count = identities
            .iter()
            .filter(|(id, identity)| {
                self.peers
                    .get(id)
                    .is_none_or(|old| old.identity != **identity)
            })
            .count();
        self.next_handle
            .checked_add(u32::try_from(new_count).map_err(|_| Failure::DomainFailed)?)
            .ok_or(Failure::DomainFailed)?;
        if new_count != 0 || self.peers.keys().any(|id| !identities.contains_key(id)) {
            self.invalidate_frames();
        }
        // Seal and remove crypto before publishing replacement exact routes. Large
        // control IDs are not truncated to the SDK's u32 local handle namespace.
        for (id, old) in &self.peers {
            if identities
                .get(id)
                .is_none_or(|identity| *identity != old.identity)
            {
                for binding in self
                    .bindings
                    .iter()
                    .filter_map(|item| item.binding.upgrade())
                {
                    if binding.handle == old.handle {
                        binding.cancelled.cancel();
                    }
                }
                self.plane
                    .wireguard
                    .remove_peer(ts_tunnel::PeerId(old.handle.0));
                self.plane.ur_out.table.remove(&old.handle);
            }
        }
        let mut next = HashMap::new();
        for (id, node) in nodes {
            let identity = identities.remove(&id).ok_or(Failure::DomainFailed)?;
            let handle =
                if let Some(old) = self.peers.get(&id).filter(|old| old.identity == identity) {
                    old.handle
                } else {
                    self.next_handle += 1;
                    PeerId(self.next_handle)
                };
            if identity.tailnet == self.local.tailnet && !identity.expired() {
                self.plane.wireguard.upsert_peer(ts_tunnel::PeerConfig::new(
                    ts_tunnel::PeerId(handle.0),
                    identity.key,
                    [0; 32],
                ));
            }
            next.insert(
                id,
                Peer {
                    node,
                    identity,
                    handle,
                },
            );
        }
        self.peers = next;
        let mut routes = Table::default();
        let mut sources = Table::default();
        for peer in self
            .peers
            .values()
            .filter(|peer| peer.identity.tailnet == self.local.tailnet && !peer.identity.expired())
        {
            for ip in [
                IpAddr::V4(peer.identity.addresses.ipv4.addr()),
                IpAddr::V6(peer.identity.addresses.ipv6.addr()),
            ] {
                let prefix = ipnet::IpNet::from(ip);
                routes.insert(
                    prefix,
                    ts_overlay_router::outbound::RouteAction::Wireguard(peer.handle),
                );
                sources.insert(prefix, peer.handle);
            }
            // Advertised AllowedIPs, default routes and subnet prefixes never enter either table.
        }
        self.plane.or_out.swap(routes);
        self.plane.src_filter_in = Arc::new(sources);
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn bind(
        &mut self,
        target: &str,
        port: u16,
        local: SocketAddr,
    ) -> Result<Arc<Binding>, Failure> {
        self.bind_cancellable(target, port, local, CancellationToken::new())
    }

    pub(super) fn bind_cancellable(
        &mut self,
        target: &str,
        port: u16,
        local: SocketAddr,
        cancelled: CancellationToken,
    ) -> Result<Arc<Binding>, Failure> {
        self.reap_bindings();
        if self.failed
            || self.local.expired()
            || port == 0
            || local.port() == 0
            || !self.local.addresses.contains(local.ip())
            || cancelled.is_cancelled()
        {
            return Err(Failure::DomainFailed);
        }
        let literal = target.parse::<IpAddr>().ok();
        let name = if literal.is_none() {
            Some(canonical_name(target)?)
        } else {
            None
        };
        let mut matches = self.peers.values().filter(|peer| {
            let id = &peer.identity;
            id.tailnet == self.local.tailnet
                && !id.expired()
                && if let Some(ip) = literal {
                    id.addresses.contains(ip)
                } else {
                    name.as_deref().is_some_and(|name| {
                        if name.contains('.') {
                            name == format!("{}.{}", id.hostname, self.local.tailnet)
                        } else {
                            name == id.hostname
                        }
                    })
                }
        });
        let peer = matches.next().ok_or(Failure::DomainFailed)?;
        if matches.next().is_some() {
            return Err(Failure::DomainFailed);
        }
        let remote_ip = literal.unwrap_or_else(|| match local.ip() {
            IpAddr::V4(_) => IpAddr::V4(peer.identity.addresses.ipv4.addr()),
            IpAddr::V6(_) => IpAddr::V6(peer.identity.addresses.ipv6.addr()),
        });
        if remote_ip.is_ipv4() != local.ip().is_ipv4() {
            return Err(Failure::DomainFailed);
        }
        if self.bindings.len() >= MAX_CONNECTIONS {
            return Err(Failure::ResourceExhausted);
        }
        // Retiring bindings still reserve their physical tuple until their owner drops.
        if self
            .bindings
            .iter()
            .filter_map(|item| item.binding.upgrade())
            .any(|item| item.local == local)
        {
            return Err(Failure::ResourceExhausted);
        }
        let binding = Arc::new(Binding {
            owner: Arc::clone(&self.owner),
            identity: peer.identity.clone(),
            handle: peer.handle,
            local,
            remote: SocketAddr::new(remote_ip, port),
            cancelled,
            started: AtomicBool::new(false),
            trace: super::evidence::Trace::current(),
        });
        self.bindings.push(HeldBinding {
            binding: Arc::downgrade(&binding),
            handle: binding.handle,
            retired: false,
            pending_plaintext: false,
        });
        self.observe_status(&binding);
        Ok(binding)
    }

    pub(super) fn endpoint(
        &mut self,
        binding: &Binding,
        transport: UnderlayTransportId,
        endpoint: DynEndpoint,
    ) -> Result<(), Failure> {
        self.current(binding)?;
        if endpoint
            .as_derp()
            .is_some_and(|key| key != binding.identity.key)
        {
            return Err(Failure::DomainFailed);
        }
        self.plane
            .ur_out
            .table
            .insert(binding.handle, (transport, endpoint));
        Ok(())
    }

    fn current(&self, binding: &Binding) -> Result<(), Failure> {
        if self.failed
            || !Arc::ptr_eq(&self.owner, &binding.owner)
            || !binding.live()
            || self.local.expired()
            || self.peers.get(&binding.identity.id).is_none_or(|peer| {
                peer.identity != binding.identity || peer.handle != binding.handle
            })
        {
            return Err(Failure::Cancelled);
        }
        Ok(())
    }

    pub(super) fn outgoing(
        &mut self,
        binding: &Binding,
        packets: Vec<PacketMut>,
    ) -> Result<Frames, Failure> {
        self.reap_bindings();
        self.current(binding)?;
        if packets.len() > MAX_PACKETS
            || packets.iter().any(|packet| {
                packet.len() > MTU
                    || tcp_tuple(packet.as_ref()) != Some((binding.local, binding.remote))
            })
        {
            return Err(Failure::DomainFailed);
        }
        if !packets.is_empty() {
            binding.started.store(true, Ordering::Relaxed);
            self.bindings
                .iter_mut()
                .find(|item| std::ptr::eq(item.binding.as_ptr(), binding))
                .ok_or(Failure::Cancelled)?
                .pending_plaintext = true;
        }
        let output = self.plane.process_outbound(packets);
        if !output.loopback.is_empty() {
            return self.fail();
        }
        self.checked_output(output.to_peers)
    }

    pub(super) fn incoming(&mut self, packets: Vec<PacketMut>) -> Result<Incoming, Failure> {
        self.reap_bindings();
        if self.failed
            || self.local.expired()
            || packets.len() > MAX_PACKETS
            || packets.iter().any(|packet| packet.len() > 2048)
        {
            return self.fail();
        }
        // The SDK's stateless filter does not admit outgoing TCP replies. A
        // saved-target initiated connection admits only its authenticated peer's
        // exact IP/local port here; the full reverse TCP tuple is checked below,
        // and the private SDK Netstack still validates TCP state and sequence.
        let replies = self
            .bindings
            .iter()
            .filter_map(|item| item.binding.upgrade())
            .filter(|binding| {
                self.current(binding).is_ok() && binding.started.load(Ordering::Relaxed)
            })
            .map(|binding| PacketInfo {
                src: binding.remote.ip(),
                dst: binding.local.ip(),
                ip_proto: ts_packetfilter::IpProto::TCP,
                port: binding.local.port(),
            })
            .collect();
        self.plane.packet_filter = Arc::new(ReplyFilter {
            policy: Arc::clone(&self.policy),
            replies,
        });
        let mut output = self.plane.process_inbound(packets);
        // Disco/STUN are handled by the owned node, never delivered to a TCP bridge.
        let to_peers = self.checked_output(output.to_peers)?;
        let mut delivered = Vec::new();
        for packet in output
            .to_local
            .remove(&OverlayTransportId(1))
            .unwrap_or_default()
        {
            if packet.len() > MTU {
                return self.fail();
            }
            let Some((source, destination)) = tcp_tuple(packet.as_ref()) else {
                continue;
            };
            if let Some(binding) = self
                .bindings
                .iter()
                .filter_map(|item| item.binding.upgrade())
                .find(|binding| {
                    self.current(binding).is_ok()
                        && binding.remote == source
                        && binding.local == destination
                })
            {
                delivered.push((binding, packet));
            }
        }
        if delivered.len() > MAX_PACKETS {
            return self.fail();
        }
        let permit = Arc::clone(&self.receive_budget)
            .try_acquire_many_owned(delivered.len() as u32)
            .map_err(|_| Failure::ResourceExhausted)?;
        Ok((
            to_peers,
            Received {
                owner: Arc::clone(&self.owner),
                packets: delivered.into(),
                permit: Some(permit),
            },
        ))
    }

    // The pinned public SDK returns DynEndpoint keys backed by SmallBox's
    // storage UnsafeCell; endpoint identity is not mutated by this consumer.
    #[expect(clippy::mutable_key_type)]
    pub(super) fn events(&mut self) -> Result<Frames, Failure> {
        self.reap_bindings();
        if self.failed || self.local.expired() {
            return self.fail();
        }
        let result = self.plane.process_events();
        self.checked_output(result)
    }

    pub(super) fn incoming_derp(
        &mut self,
        source: NodePublicKey,
        packet: PacketMut,
    ) -> Result<Option<Incoming>, Failure> {
        if !self.peers.values().any(|peer| {
            peer.identity.key == source
                && peer.identity.tailnet == self.local.tailnet
                && !peer.identity.expired()
        }) {
            return Ok(None);
        }
        self.observe_peer(source, super::evidence::Flow::LabelledInput, 1);
        if self.diagnostics
            && let Some(kind) = super::evidence::WireKind::observed(packet.as_ref())
        {
            self.observe_peer(
                source,
                super::evidence::Flow::WireGuard {
                    received: true,
                    kind,
                },
                1,
            );
        }
        let (mut frames, mut received) = self.incoming(vec![packet])?;
        // DERP's source label is not a substitute for authenticated WireGuard
        // identity. Require both before an exact TCP stack adopts plaintext or
        // a handshake reply is submitted to the shared asynchronous writer.
        if frames
            .packets
            .iter()
            .any(|(_, endpoint, _)| endpoint.as_derp() != Some(source))
        {
            frames.clear();
        }
        let before = received.packets.len();
        received
            .packets
            .retain(|(binding, _)| binding.identity.key == source);
        if let Some(permit) = received.permit.as_mut() {
            drop(permit.split(before - received.packets.len()));
        }
        Ok(Some((frames, received)))
    }

    pub(super) fn relay_peers(&self) -> Vec<(NodePublicKey, Option<ts_derp::RegionId>)> {
        self.peers
            .values()
            .filter(|peer| !peer.identity.expired())
            .map(|peer| (peer.identity.key, peer.node.derp_region))
            .collect()
    }

    pub(super) fn region(&self, binding: &Binding) -> Option<ts_derp::RegionId> {
        self.peers
            .values()
            .find(|peer| peer.identity.key == binding.peer_key())
            .and_then(|peer| peer.node.derp_region)
    }

    fn observe_status(&self, binding: &Binding) {
        if self.diagnostics
            && self.current(binding).is_ok()
            && let Some(peer) = self.peers.get(&binding.identity.id)
        {
            binding.trace.peer_status(peer.node.status);
        }
    }

    pub(super) fn wait_writable(
        &self,
    ) -> impl Future<Output = Result<OwnedSemaphorePermit, tokio::sync::AcquireError>> + Send + use<>
    {
        Arc::clone(&self.frame_budget).acquire_many_owned(MAX_PACKETS as u32)
    }

    pub(super) fn next_delay(&self) -> Option<std::time::Duration> {
        let event = self
            .plane
            .next_event()
            .map(|at| at.saturating_duration_since(std::time::Instant::now()));
        let expiry = std::iter::once(self.local.expires)
            .chain(self.peers.values().map(|peer| peer.identity.expires))
            .flatten()
            .filter_map(|at| (at - chrono::Utc::now()).to_std().ok())
            .min();
        event.into_iter().chain(expiry).min()
    }

    // Consume the pinned SDK's endpoint map without mutating any key identity.
    #[expect(clippy::mutable_key_type)]
    fn checked_output(&mut self, output: Underlay) -> Result<Frames, Failure> {
        let count = output.values().map(Vec::len).sum::<usize>();
        if count > MAX_PACKETS || output.values().flatten().any(|packet| packet.len() > 2048) {
            return self.fail();
        }
        if self.diagnostics {
            for ((_, endpoint), packets) in &output {
                if let Some(peer) = endpoint.as_derp() {
                    self.observe_peer(peer, super::evidence::Flow::EncryptedOutput, packets.len());
                    let (mut initiation, mut response, mut cookie, mut transport) = (0, 0, 0, 0);
                    use super::evidence::WireKind;
                    for packet in packets {
                        let count = match WireKind::observed(packet.as_ref()) {
                            Some(WireKind::Initiation) => &mut initiation,
                            Some(WireKind::Response) => &mut response,
                            Some(WireKind::Cookie) => &mut cookie,
                            Some(WireKind::Transport) => &mut transport,
                            None => continue,
                        };
                        *count += 1;
                    }
                    // Classify once per SDK batch; traverse active bindings at
                    // most once per kind rather than once per transport packet.
                    for (kind, count) in [
                        (WireKind::Initiation, initiation),
                        (WireKind::Response, response),
                        (WireKind::Cookie, cookie),
                        (WireKind::Transport, transport),
                    ] {
                        if count != 0 {
                            self.observe_peer(
                                peer,
                                super::evidence::Flow::WireGuard {
                                    received: false,
                                    kind,
                                },
                                count,
                            );
                        }
                    }
                }
            }
        }
        for (destination, packets) in &output {
            if !packets.iter().any(|packet| {
                // Trusted SDK output: WireGuard type 4 has a 16-byte header
                // and a 16-byte authentication tag, including keepalives.
                packet.len() >= 32 && packet.as_ref().starts_with(&[4, 0, 0, 0])
            }) {
                continue;
            }
            let mut peers = self
                .plane
                .ur_out
                .table
                .iter()
                .filter(|(_, route)| *route == destination);
            if let Some((&handle, _)) = peers.next()
                && peers.next().is_none()
            {
                // The pinned SDK queues plaintext only without active crypto;
                // activation drains the whole queue before emitting transport
                // data. Only uniquely routed SDK output proves that peer drained.
                for item in &mut self.bindings {
                    if item.handle == handle {
                        item.pending_plaintext = false;
                    }
                }
            }
        }
        let permit = Arc::clone(&self.frame_budget)
            .try_acquire_many_owned(count as u32)
            .map_err(|_| Failure::ResourceExhausted)?;
        Ok(Frames {
            owner: Arc::clone(&self.owner),
            epoch: self.frame_epoch,
            packets: output
                .into_iter()
                .flat_map(|((transport, endpoint), packets)| {
                    packets
                        .into_iter()
                        .map(move |packet| (transport, endpoint.clone(), packet))
                })
                .collect(),
            permit: Some(permit),
        })
    }

    /// Transfer one DERP packet without releasing its physical writer budget.
    /// The stamp is checked again below TLS/HTTP/SDK codec buffering on each IO
    /// poll; cancelling an encoded partial frame poisons the entire relay IO.
    pub(super) fn prepare_derp(
        &mut self,
        output: &mut Frames,
    ) -> Result<Option<Outbound>, Failure> {
        self.reap_bindings();
        if self.failed
            || self.local.expired()
            || !Arc::ptr_eq(&self.owner, &output.owner)
            || output.epoch != self.frame_epoch
        {
            output.clear();
            return Err(Failure::Cancelled);
        }
        let Some((_, endpoint, _)) = output.packets.front() else {
            return Ok(None);
        };
        let destination = endpoint.as_derp().ok_or(Failure::DomainFailed)?;
        let peer = self
            .peers
            .values()
            .find(|peer| {
                peer.identity.key == destination
                    && peer.identity.tailnet == self.local.tailnet
                    && !peer.identity.expired()
            })
            .ok_or(Failure::Cancelled)?;
        let expires = [self.local.expires, peer.identity.expires]
            .into_iter()
            .flatten()
            .min();
        let bindings = self
            .bindings
            .iter()
            .filter_map(|held| held.binding.upgrade())
            .filter(|binding| binding.identity.key == destination && self.current(binding).is_ok())
            .map(|binding| Arc::downgrade(&binding))
            .collect::<Vec<_>>();
        let cancelled = bindings
            .iter()
            .filter_map(Weak::upgrade)
            .map(|binding| binding.cancelled())
            .collect::<Vec<_>>();
        let permit = output
            .permit
            .as_mut()
            .and_then(|permit| permit.split(1))
            .ok_or(Failure::DomainFailed)?;
        let (_, _, bytes) = output.packets.pop_front().ok_or(Failure::DomainFailed)?;
        Ok(Some(Outbound {
            destination,
            bytes,
            permit,
            stamp: FrameStamp {
                diagnostics: self.diagnostics,
                generation: Arc::downgrade(&self.generation),
                epoch: self.frame_epoch,
                expires,
                node: self.local.key,
                peer: destination,
                bindings,
                readers: [
                    frame_watcher(self.frame_cancelled.clone(), expires, cancelled.clone()),
                    frame_watcher(self.frame_cancelled.clone(), expires, cancelled),
                ],
            },
        }))
    }

    /// Only immediate, nonblocking IO belongs in this callback. A queued/async
    /// transport must retain Frames and call this again at its final write.
    /// No map mutation can interleave inside this owner's synchronous commit.
    #[cfg(test)]
    pub(super) fn try_emit(
        &mut self,
        output: &mut Frames,
        mut send: impl FnMut(UnderlayTransportId, &DynEndpoint, &[u8]) -> io::Result<()>,
    ) -> Result<bool, Failure> {
        self.reap_bindings();
        if self.failed
            || self.local.expired()
            || !Arc::ptr_eq(&self.owner, &output.owner)
            || output.epoch != self.frame_epoch
        {
            output.clear();
            return Err(Failure::Cancelled);
        }
        while !output.packets.is_empty() {
            self.reap_bindings();
            if self.failed || self.local.expired() || output.epoch != self.frame_epoch {
                output.clear();
                return Err(Failure::Cancelled);
            }
            let (transport, endpoint, packet) =
                output.packets.front().ok_or(Failure::DomainFailed)?;
            match send(*transport, endpoint, packet.as_ref()) {
                Ok(()) => {
                    output.packets.pop_front();
                    output.release_one();
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(_) => {
                    output.clear();
                    return Err(Failure::DomainFailed);
                }
            }
        }
        output.permit.take();
        Ok(true)
    }

    /// Admit each packet again immediately before its bounded connection device.
    pub(super) fn deliver(
        &mut self,
        mut input: Received,
        mut receive: impl FnMut(&Arc<Binding>, PacketMut) -> Result<(), Failure>,
    ) -> Result<usize, Failure> {
        self.reap_bindings();
        if !Arc::ptr_eq(&self.owner, &input.owner) {
            return Err(Failure::Cancelled);
        }
        let mut count = 0;
        while let Some((binding, packet)) = input.packets.pop_front() {
            if self.current(&binding).is_ok() {
                receive(&binding, packet)?;
                count += 1;
            }
            drop(input.permit.as_mut().and_then(|permit| permit.split(1)));
        }
        Ok(count)
    }

    fn observe_peer(&self, peer: NodePublicKey, flow: super::evidence::Flow, count: usize) {
        if !self.diagnostics {
            return;
        }
        for binding in self
            .bindings
            .iter()
            .filter_map(|held| held.binding.upgrade())
        {
            if binding.peer_key() == peer && self.current(&binding).is_ok() {
                binding.trace.flow(flow, count);
            }
        }
    }

    fn invalidate_frames(&mut self) {
        self.frame_cancelled.cancel();
        self.frame_cancelled = CancellationToken::new();
        if let Some(epoch) = self.frame_epoch.checked_add(1) {
            self.frame_epoch = epoch;
            self.generation.epoch.store(epoch, Ordering::Release);
        } else {
            self.failed = true;
            self.generation.live.store(false, Ordering::Release);
        }
    }

    fn seal_all(&mut self) {
        self.invalidate_frames();
        for item in &mut self.bindings {
            if let Some(binding) = item.binding.upgrade() {
                binding.cancelled.cancel();
            }
            item.retired = true;
        }
        for peer in self.peers.values() {
            self.plane
                .wireguard
                .remove_peer(ts_tunnel::PeerId(peer.handle.0));
            if peer.identity.tailnet == self.local.tailnet && !peer.identity.expired() {
                self.plane.wireguard.upsert_peer(ts_tunnel::PeerConfig::new(
                    ts_tunnel::PeerId(peer.handle.0),
                    peer.identity.key,
                    [0; 32],
                ));
            }
        }
    }

    fn reap_bindings(&mut self) {
        let mut reset = HashSet::new();
        let mut retired = HashSet::new();
        for item in &mut self.bindings {
            let binding = item.binding.upgrade();
            if !item.retired && binding.as_ref().is_none_or(|binding| !binding.live()) {
                if let Some(binding) = binding {
                    binding.cancelled.cancel();
                }
                item.retired = true;
                retired.insert(item.handle);
                if item.pending_plaintext {
                    reset.insert(item.handle);
                }
            }
        }
        // Expired peers with no active binding must not retain crypto timers or
        // transport routes. There is no control-ready substitute for key validity.
        for peer in self.peers.values().filter(|peer| peer.identity.expired()) {
            self.plane
                .wireguard
                .remove_peer(ts_tunnel::PeerId(peer.handle.0));
            self.plane.ur_out.table.remove(&peer.handle);
        }
        if !retired.is_empty() {
            self.invalidate_frames();
        }
        for handle in retired {
            if !self
                .bindings
                .iter()
                .any(|item| item.handle == handle && !item.retired)
            {
                reset.insert(handle);
            }
        }
        for handle in reset {
            // Removal purges SDK-held plaintext, or releases an unused peer's
            // sessions. Established siblings otherwise keep their receiver IDs.
            self.plane
                .wireguard
                .remove_peer(ts_tunnel::PeerId(handle.0));
            for item in &mut self.bindings {
                if item.handle == handle {
                    item.pending_plaintext = false;
                }
            }
            if let Some(peer) = self.peers.values().find(|peer| {
                peer.handle == handle
                    && peer.identity.tailnet == self.local.tailnet
                    && !peer.identity.expired()
            }) {
                self.plane.wireguard.upsert_peer(ts_tunnel::PeerConfig::new(
                    ts_tunnel::PeerId(handle.0),
                    peer.identity.key,
                    [0; 32],
                ));
            }
        }
        self.bindings
            .retain(|item| item.binding.strong_count() != 0);
    }

    fn fail<T>(&mut self) -> Result<T, Failure> {
        self.failed = true;
        self.generation.live.store(false, Ordering::Release);
        self.seal_all();
        Err(Failure::DomainFailed)
    }
}

impl Drop for Peers {
    fn drop(&mut self) {
        self.generation.live.store(false, Ordering::Release);
        self.frame_cancelled.cancel();
        for binding in self
            .bindings
            .iter()
            .filter_map(|item| item.binding.upgrade())
        {
            binding.cancelled.cancel();
        }
    }
}

fn frame_watcher(
    cancelled: CancellationToken,
    expires: Option<chrono::DateTime<chrono::Utc>>,
    bindings: Vec<CancellationToken>,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        let cancellation = futures_util::future::select_all(
            std::iter::once(cancelled)
                .chain(bindings)
                .map(|cancelled| Box::pin(cancelled.cancelled_owned()))
                .collect::<Vec<_>>(),
        );
        if let Some(expires) = expires {
            let remaining = (expires - chrono::Utc::now()).to_std().unwrap_or_default();
            tokio::select! { _ = cancellation => {}, _ = tokio::time::sleep(remaining) => {} }
        } else {
            cancellation.await;
        }
    })
}

fn tcp_tuple(bytes: &[u8]) -> Option<(SocketAddr, SocketAddr)> {
    let (source, destination, payload) = match IpVersion::of_packet(bytes).ok()? {
        IpVersion::Ipv4 => {
            let ip = Ipv4Packet::new_checked(bytes).ok()?;
            if ip.next_header() != IpProtocol::Tcp || ip.more_frags() || ip.frag_offset() != 0 {
                return None;
            }
            (
                IpAddr::V4(ip.src_addr()),
                IpAddr::V4(ip.dst_addr()),
                ip.payload(),
            )
        }
        IpVersion::Ipv6 => {
            let ip = Ipv6Packet::new_checked(bytes).ok()?;
            if ip.next_header() != IpProtocol::Tcp {
                return None;
            }
            (
                IpAddr::V6(ip.src_addr()),
                IpAddr::V6(ip.dst_addr()),
                ip.payload(),
            )
        }
    };
    let tcp = TcpPacket::new_checked(payload).ok()?;
    Some((
        SocketAddr::new(source, tcp.src_port()),
        SocketAddr::new(destination, tcp.dst_port()),
    ))
}

fn vector_cost<T>(items: &Vec<T>) -> usize {
    items.capacity().saturating_mul(std::mem::size_of::<T>())
}

struct ReplyFilter {
    policy: Arc<ts_packetfilter::HashbrownFilter>,
    replies: Vec<PacketInfo>,
}

impl Filter for ReplyFilter {
    fn match_for(&self, info: &PacketInfo, caps: CapIter) -> Option<&str> {
        if self.replies.contains(info) {
            Some("native-initiated-TCP-reply")
        } else {
            self.policy.match_for(info, caps)
        }
    }
}

fn node_cost(node: &Node) -> usize {
    std::mem::size_of::<Node>()
        .saturating_add(node.stable_id.0.capacity())
        .saturating_add(node.hostname.capacity())
        .saturating_add(node.tailnet.as_ref().map_or(0, String::capacity))
        .saturating_add(vector_cost(&node.accepted_routes))
        .saturating_add(vector_cost(&node.underlay_addresses))
        .saturating_add(vector_cost(&node.tags))
        .saturating_add(node.tags.iter().map(String::capacity).sum::<usize>())
        .saturating_add(
            node.tailnet_lock_key_signature
                .as_ref()
                .map_or(0, Vec::capacity),
        )
        .saturating_add(
            node.node_capabilities
                .iter()
                .map(|(key, values)| {
                    // Conservative tree entry allowance, plus retained vector/string capacity.
                    128usize
                        .saturating_add(key.capacity())
                        .saturating_add(vector_cost(values))
                        .saturating_add(values.iter().map(String::capacity).sum::<usize>())
                })
                .sum::<usize>(),
        )
}

fn policy_cost(policy: &ts_packetfilter::HashbrownFilter) -> usize {
    let mut bytes = policy.capacity().saturating_mul(128);
    for (name, rules) in policy {
        bytes = bytes
            .saturating_add(name.capacity())
            .saturating_add(vector_cost(rules));
        for rule in rules {
            bytes = bytes
                .saturating_add(vector_cost(&rule.src.pfxs))
                .saturating_add(vector_cost(&rule.src.caps))
                .saturating_add(rule.src.caps.iter().map(String::capacity).sum::<usize>())
                .saturating_add(vector_cost(&rule.protos))
                .saturating_add(vector_cost(&rule.dst))
                .saturating_add(
                    rule.dst
                        .iter()
                        .map(|dst| vector_cost(&dst.ips))
                        .sum::<usize>(),
                );
        }
    }
    bytes
}
