//! Controlled external SDK peers over actual loopback UDP. No provider access.
//! SDK endpoint maps retain SmallBox storage, without mutating key identities.
use crate::tailscale::peers::{Binding, Frames, Peers, Received};
use crate::tailscale::tcp::{Connection, Stream};
use std::{
    collections::VecDeque,
    future::Future,
    net::{IpAddr, SocketAddr, UdpSocket},
    sync::Arc,
    task::Context,
    time::Duration,
};
use ts_bart::{RoutingTable, Table};
use ts_dataplane::DataPlane;
use ts_keys::NodeKeyPair;
use ts_netstack_smoltcp_core::{Channel, Config, HasChannel, Netstack, smoltcp};
use ts_netstack_smoltcp_socket::{CreateSocket, TcpListener, TcpStream};
use ts_packet::PacketMut;
use ts_packetfilter::{Filter, PacketInfo, filter::CapIter};
use ts_transport::{DynEndpoint, OverlayTransportId, PeerId, UnderlayTransportId};

type Underlay = std::collections::HashMap<(UnderlayTransportId, DynEndpoint), Vec<PacketMut>>;

#[expect(clippy::mutable_key_type)]
pub(super) fn routed(peers: &mut Peers, mut frames: Frames) -> Underlay {
    let mut result = Underlay::new();
    assert!(
        peers
            .try_emit(&mut frames, |transport, endpoint, bytes| {
                result
                    .entry((transport, endpoint.clone()))
                    .or_default()
                    .push(PacketMut::from(bytes));
                Ok(())
            })
            .unwrap()
    );
    result
}
pub(super) fn peer_ip(ip: u8) -> IpAddr {
    IpAddr::from([100, 64, 0, ip])
}
pub(super) fn local(port: u16) -> SocketAddr {
    SocketAddr::new(peer_ip(1), port)
}
pub(in crate::tailscale::tests) fn remote(ip: u8) -> SocketAddr {
    SocketAddr::new(peer_ip(ip), 22)
}

pub(in crate::tailscale::tests) fn initiation(
    keys: NodeKeyPair,
    client: ts_keys::NodePublicKey,
) -> PacketMut {
    let mut endpoint = ts_tunnel::Endpoint::new(keys);
    let peer = ts_tunnel::PeerId(1);
    endpoint.upsert_peer(ts_tunnel::PeerConfig::new(peer, client, [0; 32]));
    let mut generated = endpoint.send(
        std::time::Instant::now(),
        [(peer, vec![PacketMut::from(&b"late-peer-initiation"[..])])],
    );
    let mut packets = generated.to_peers.remove(&peer).unwrap();
    assert_eq!(packets.len(), 1);
    let packet = packets.remove(0);
    assert_eq!(&packet.as_ref()[..4], &[1, 0, 0, 0]);
    packet
}

pub(super) fn syn(source: SocketAddr, destination: SocketAddr) -> PacketMut {
    let header = if source.is_ipv4() { 20 } else { 40 };
    let mut bytes = vec![0; header + 20];
    match (source.ip(), destination.ip()) {
        (IpAddr::V4(source), IpAddr::V4(destination)) => {
            bytes[0] = 0x45;
            bytes[2..4].copy_from_slice(&40u16.to_be_bytes());
            bytes[8] = 64;
            bytes[9] = 6;
            bytes[12..16].copy_from_slice(&source.octets());
            bytes[16..20].copy_from_slice(&destination.octets());
        }
        (IpAddr::V6(source), IpAddr::V6(destination)) => {
            bytes[0] = 0x60;
            bytes[4..6].copy_from_slice(&20u16.to_be_bytes());
            bytes[6] = 6;
            bytes[7] = 64;
            bytes[8..24].copy_from_slice(&source.octets());
            bytes[24..40].copy_from_slice(&destination.octets());
        }
        _ => panic!("same-family fixture tuple"),
    }
    bytes[header..header + 2].copy_from_slice(&source.port().to_be_bytes());
    bytes[header + 2..header + 4].copy_from_slice(&destination.port().to_be_bytes());
    bytes[header + 12] = 0x50;
    bytes[header + 13] = 2;
    PacketMut::from(bytes.as_slice())
}

#[derive(Default)]
pub(super) struct Device {
    pub(super) incoming: VecDeque<Vec<u8>>,
    pub(super) outgoing: VecDeque<Vec<u8>>,
}
pub(super) struct Receive(Vec<u8>);
pub(super) struct Transmit<'a>(&'a mut VecDeque<Vec<u8>>);
impl smoltcp::phy::RxToken for Receive {
    fn consume<R, F>(self, function: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        function(&self.0)
    }
}
impl smoltcp::phy::TxToken for Transmit<'_> {
    fn consume<R, F>(self, length: usize, function: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        assert!(length <= 1280 && self.0.len() < 64);
        let mut bytes = vec![0; length];
        let result = function(&mut bytes);
        self.0.push_back(bytes);
        result
    }
}
impl smoltcp::phy::Device for Device {
    type RxToken<'a> = Receive;
    type TxToken<'a> = Transmit<'a>;
    fn receive(
        &mut self,
        _: smoltcp::time::Instant,
    ) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        if self.outgoing.len() >= 64 {
            return None;
        }
        let packet = self.incoming.pop_front()?;
        Some((Receive(packet), Transmit(&mut self.outgoing)))
    }
    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<Self::TxToken<'_>> {
        (self.outgoing.len() < 64).then_some(Transmit(&mut self.outgoing))
    }
    fn capabilities(&self) -> smoltcp::phy::DeviceCapabilities {
        let mut cap = smoltcp::phy::DeviceCapabilities::default();
        cap.medium = smoltcp::phy::Medium::Ip;
        cap.max_transmission_unit = 1280;
        cap
    }
}

pub(super) struct Stack {
    stack: Netstack,
    pub(super) device: Device,
}
impl Stack {
    pub(super) fn new(ip: IpAddr) -> Self {
        let mut stack = Netstack::new(
            Config {
                command_channel_capacity: Some(4),
                tcp_buffer_size: 64 * 1024,
                loopback: false,
                mtu: 1280,
                ..Config::default()
            },
            smoltcp::time::Instant::from_millis(0),
        );
        assert!(stack.direct_set_ips([ip]));
        Self {
            stack,
            device: Default::default(),
        }
    }
    pub(super) fn channel(&self) -> Channel {
        self.stack.command_channel()
    }
    pub(super) fn poll(&mut self, milliseconds: i64) {
        self.stack.process_cmds();
        self.stack.poll_device_io(
            smoltcp::time::Instant::from_millis(milliseconds),
            &mut self.device,
        );
    }
    fn receive(&mut self, packet: PacketMut) {
        assert!(packet.len() <= 1280 && self.device.incoming.len() < 64);
        self.device.incoming.push_back(packet.as_ref().to_vec());
    }
}

struct ExternalPolicy {
    destination: IpAddr,
    ports: Vec<u16>,
}

fn external_plane(
    keys: NodeKeyPair,
    client_key: ts_keys::NodePublicKey,
    ip: u8,
    endpoint: DynEndpoint,
    ports: Vec<u16>,
) -> DataPlane {
    let mut plane = DataPlane::new(keys);
    plane.wireguard.upsert_peer(ts_tunnel::PeerConfig::new(
        ts_tunnel::PeerId(1),
        client_key,
        [0; 32],
    ));
    let mut out = Table::default();
    out.insert(
        ipnet::IpNet::from(peer_ip(1)),
        ts_overlay_router::outbound::RouteAction::Wireguard(PeerId(1)),
    );
    plane.or_out.swap(out);
    plane
        .ur_out
        .table
        .insert(PeerId(1), (UnderlayTransportId(1), endpoint));
    let mut incoming = Table::default();
    incoming.insert(
        ipnet::IpNet::from(peer_ip(ip)),
        ts_overlay_router::inbound::RouteAction::ToOverlay(OverlayTransportId(1)),
    );
    plane.or_in.swap(incoming);
    let mut source = Table::default();
    source.insert(ipnet::IpNet::from(peer_ip(1)), PeerId(1));
    plane.src_filter_in = Arc::new(source);
    plane.packet_filter = Arc::new(ExternalPolicy {
        destination: peer_ip(ip),
        ports,
    });
    plane
}

/// External peer owns actual SDK crypto/TCP without an alternate UDP path.
pub(in crate::tailscale::tests) struct DerpSide {
    plane: DataPlane,
    stack: Stack,
    pub(in crate::tailscale::tests) key: ts_keys::NodePublicKey,
    client_key: ts_keys::NodePublicKey,
    incoming: Vec<PacketMut>,
    lose_syn: bool,
    pub(super) lost_syns: usize,
}

impl DerpSide {
    pub(in crate::tailscale::tests) fn new(
        keys: NodeKeyPair,
        client_key: ts_keys::NodePublicKey,
        ip: u8,
    ) -> Self {
        Self::with_port(keys, client_key, ip, 22)
    }

    pub(in crate::tailscale::tests) fn with_port(
        keys: NodeKeyPair,
        client_key: ts_keys::NodePublicKey,
        ip: u8,
        port: u16,
    ) -> Self {
        Self::with_ports(keys, client_key, ip, vec![port])
    }

    pub(in crate::tailscale::tests) fn with_ports(
        keys: NodeKeyPair,
        client_key: ts_keys::NodePublicKey,
        ip: u8,
        ports: Vec<u16>,
    ) -> Self {
        let key = keys.public;
        Self {
            plane: external_plane(keys, client_key, ip, DynEndpoint::derp(client_key), ports),
            stack: Stack::new(peer_ip(ip)),
            key,
            client_key,
            incoming: Vec::new(),
            lose_syn: false,
            lost_syns: 0,
        }
    }
    pub(in crate::tailscale::tests) fn channel(&self) -> Channel {
        self.stack.channel()
    }
    pub(super) fn lose_first_syn(&mut self) {
        assert_eq!(self.lost_syns, 0);
        self.lose_syn = true;
    }
    pub(in crate::tailscale::tests) fn can_receive(&self) -> bool {
        self.incoming.len() < 64
    }
    pub(in crate::tailscale::tests) fn receive(&mut self, packet: PacketMut) {
        assert!(self.can_receive() && packet.len() <= 2048);
        self.incoming.push(packet);
    }
    #[expect(clippy::mutable_key_type)]
    pub(in crate::tailscale::tests) fn pump(&mut self, milliseconds: i64) -> Vec<PacketMut> {
        let incoming = std::mem::take(&mut self.incoming);
        let mut processed = self.plane.process_inbound(incoming);
        for packet in processed
            .to_local
            .remove(&OverlayTransportId(1))
            .unwrap_or_default()
        {
            if self.lose_syn {
                let ip = smoltcp::wire::Ipv4Packet::new_checked(packet.as_ref()).unwrap();
                let tcp = smoltcp::wire::TcpPacket::new_checked(ip.payload()).unwrap();
                if tcp.syn() && !tcp.ack() {
                    // Drop at the controlled external peer's actual decrypted
                    // IP boundary, before its unchanged SDK TCP stack sees it.
                    self.lose_syn = false;
                    self.lost_syns += 1;
                    continue;
                }
            }
            self.stack.receive(packet);
        }
        self.stack.poll(milliseconds);
        let packets = self
            .stack
            .device
            .outgoing
            .drain(..)
            .map(|bytes| PacketMut::from(bytes.as_slice()))
            .collect();
        let outgoing = self.plane.process_outbound(packets);
        let events = self.plane.process_events();
        let mut packets = Vec::new();
        for ((_, endpoint), batch) in processed
            .to_peers
            .into_iter()
            .chain(outgoing.to_peers)
            .chain(events)
        {
            assert_eq!(
                endpoint.as_derp(),
                Some(self.client_key),
                "external peer has no UDP/system path"
            );
            packets.extend(batch);
        }
        assert!(packets.len() <= 64 && packets.iter().all(|packet| packet.len() <= 2048));
        packets
    }
}
impl Filter for ExternalPolicy {
    fn match_for(&self, info: &PacketInfo, _: CapIter) -> Option<&str> {
        (info.src == peer_ip(1)
            && info.dst == self.destination
            && info.ip_proto == ts_packetfilter::IpProto::TCP
            && self.ports.contains(&info.port))
        .then_some("synthetic-external-TCP-peer")
    }
}

pub(super) struct Side {
    plane: DataPlane,
    pub(super) socket: UdpSocket,
    client: Arc<UdpSocket>,
    stack: Stack,
}
impl Side {
    fn new(
        keys: NodeKeyPair,
        client_key: ts_keys::NodePublicKey,
        ip: u8,
        client: Arc<UdpSocket>,
    ) -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.connect(client.local_addr().unwrap()).unwrap();
        socket.set_nonblocking(true).unwrap();
        let plane = external_plane(
            keys,
            client_key,
            ip,
            DynEndpoint::udp(client.local_addr().unwrap()),
            vec![22],
        );
        Self {
            plane,
            socket,
            client,
            stack: Stack::new(peer_ip(ip)),
        }
    }
    fn receive_wire(&self) -> Vec<PacketMut> {
        let mut bytes = [0; 2048];
        let mut packets = Vec::new();
        loop {
            match self.socket.recv(&mut bytes) {
                Ok(n) => packets.push(PacketMut::from(&bytes[..n])),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("controlled UDP error: {e}"),
            }
            assert!(packets.len() <= 64);
        }
        packets
    }
    #[expect(clippy::mutable_key_type)]
    fn transmit(&self, output: Underlay) {
        for ((_, endpoint), packets) in output {
            assert_eq!(endpoint.as_udp(), Some(self.client.local_addr().unwrap()));
            for packet in packets {
                self.socket.send(packet.as_ref()).unwrap();
            }
        }
    }
    #[expect(clippy::mutable_key_type)]
    pub(super) fn answer(&mut self, input: Underlay) -> Vec<PacketMut> {
        for ((_, endpoint), packets) in input {
            let address = endpoint.as_udp().unwrap();
            assert_eq!(address, self.socket.local_addr().unwrap());
            for packet in packets {
                self.client.send_to(packet.as_ref(), address).unwrap();
            }
        }
        let packets = self.receive_wire();
        assert!(!packets.is_empty());
        let output = self.plane.process_inbound(packets);
        assert!(output.to_local.is_empty());
        output.to_peers.into_values().flatten().collect()
    }
    #[expect(clippy::mutable_key_type)]
    pub(super) fn decrypt(&mut self, input: Underlay) -> Vec<PacketMut> {
        let input = input.into_values().flatten().collect::<Vec<_>>();
        let output = self.plane.process_inbound(input);
        output.to_local.into_values().flatten().collect()
    }
    #[expect(clippy::mutable_key_type)]
    fn pump(&mut self, milliseconds: i64) {
        let packets = self.receive_wire();
        let mut output = self.plane.process_inbound(packets);
        for packet in output
            .to_local
            .remove(&OverlayTransportId(1))
            .unwrap_or_default()
        {
            self.stack.receive(packet);
        }
        self.transmit(output.to_peers);
        self.stack.poll(milliseconds);
        let packets = self
            .stack
            .device
            .outgoing
            .drain(..)
            .map(|bytes| PacketMut::from(bytes.as_slice()))
            .collect();
        let output = self.plane.process_outbound(packets);
        self.transmit(output.to_peers);
        let events = self.plane.process_events();
        self.transmit(events);
    }
}

pub(super) struct Fixture {
    pub(super) peers: Peers,
    pub(super) local_keys: NodeKeyPair,
    pub(super) b_key: ts_keys::NodePublicKey,
    pub(super) a: Side,
    b: Side,
    client: Arc<UdpSocket>,
    tcp: Connection,
    connected: Option<Stream>,
    pub(super) binding: Arc<Binding>,
    epoch: std::time::Instant,
}
impl Fixture {
    pub(super) async fn new() -> Self {
        let keys = NodeKeyPair::random();
        let a = NodeKeyPair::random();
        let b = NodeKeyPair::random();
        let b_key = b.public;
        let mut peers = super::fixture_peers(&keys, &a, &b).await;
        let client = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
        client.set_nonblocking(true).unwrap();
        let a = Side::new(a, keys.public, 2, Arc::clone(&client));
        let b = Side::new(b, keys.public, 3, Arc::clone(&client));
        let binding = peers.bind("100.64.0.3", 22, local(6002)).unwrap();
        peers
            .endpoint(
                &binding,
                UnderlayTransportId(1),
                DynEndpoint::udp(b.socket.local_addr().unwrap()),
            )
            .unwrap();
        Self {
            peers,
            local_keys: keys,
            b_key,
            a,
            b,
            client,
            tcp: Connection::new(Arc::clone(&binding), None).unwrap(),
            connected: None,
            binding,
            epoch: std::time::Instant::now(),
        }
    }
    pub(super) fn b_endpoint(&mut self, derp: bool) {
        let endpoint = if derp {
            DynEndpoint::derp(self.b_key)
        } else {
            DynEndpoint::udp(self.b.socket.local_addr().unwrap())
        };
        self.peers
            .endpoint(&self.binding, UnderlayTransportId(1), endpoint)
            .unwrap();
    }
    pub(super) fn share_b_endpoint(&mut self, binding: &Binding) {
        self.peers
            .endpoint(
                binding,
                UnderlayTransportId(1),
                DynEndpoint::udp(self.b.socket.local_addr().unwrap()),
            )
            .unwrap();
    }
    fn transmit(&mut self, mut output: Frames) {
        let client = Arc::clone(&self.client);
        let a = self.a.socket.local_addr().unwrap();
        let b = self.b.socket.local_addr().unwrap();
        assert!(
            self.peers
                .try_emit(&mut output, |_, endpoint, packet| {
                    let address = endpoint.as_udp().unwrap();
                    assert!(address == a || address == b);
                    let written = client.send_to(packet, address)?;
                    assert_eq!(written, packet.len());
                    Ok(())
                })
                .unwrap()
        );
    }
    fn pump(&mut self) {
        let now = self.epoch.elapsed().as_millis() as i64;
        let mut cx = Context::from_waker(futures_util::task::noop_waker_ref());
        if let Some(stream) = self.tcp.poll(&mut cx).unwrap() {
            assert!(self.connected.is_none());
            self.connected = Some(stream);
        }
        let packets = self.tcp.outgoing().unwrap();
        let output = self.peers.outgoing(&self.binding, packets).unwrap();
        self.transmit(output);
        self.a.pump(now);
        self.b.pump(now);
        let mut bytes = [0; 2048];
        let mut packets = Vec::new();
        loop {
            match self.client.recv_from(&mut bytes) {
                Ok((n, _)) => packets.push(PacketMut::from(&bytes[..n])),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("controlled UDP error: {e}"),
            }
            assert!(packets.len() <= 64);
        }
        let (output, delivered) = self.peers.incoming(packets).unwrap();
        self.transmit(output);
        let current = Arc::clone(&self.binding);
        self.peers
            .deliver(delivered, |binding, packet| {
                assert!(Arc::ptr_eq(binding, &current));
                self.tcp.receive(binding, packet)
            })
            .unwrap();
        let output = self.peers.events().unwrap();
        self.transmit(output);
    }
    async fn finish<F: Future>(&mut self, future: F) -> F::Output {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut future = Box::pin(future);
        loop {
            self.pump();
            tokio::select! {biased;result=&mut future=>return result,_=tokio::task::yield_now()=>{}}
            assert!(
                tokio::time::Instant::now() < deadline,
                "actual SDK TCP/crypto deadline"
            );
        }
    }
    pub(super) async fn connect_b(&mut self) -> (Stream, TcpStream, TcpListener) {
        let server = self.b.stack.channel();
        let listener = self.finish(server.tcp_listen(remote(3))).await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let connection = loop {
            self.pump();
            if let Some(stream) = self.connected.take() {
                break stream;
            }
            tokio::task::yield_now().await;
            assert!(
                tokio::time::Instant::now() < deadline,
                "production native TCP bridge connect deadline"
            );
        };
        let accepted = self.finish(listener.accept()).await.unwrap();
        (connection, accepted, listener)
    }
    pub(super) async fn transfer_b(
        &mut self,
        original: (Stream, TcpStream, TcpListener),
        count: usize,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (connection, accepted, listener) = original;
        let expected = (0..count).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let mut received = vec![0; count];
        let reverse = (0..count)
            .map(|i| ((i + 19) % 239) as u8)
            .collect::<Vec<_>>();
        let mut received_reverse = vec![0; count];
        let (mut client_read, mut client_write) = tokio::io::split(connection);
        let (mut server_read, mut server_write) = tokio::io::split(accepted);
        let (write, read, reverse_write, reverse_read) = self
            .finish(async {
                tokio::join!(
                    client_write.write_all(&expected),
                    server_read.read_exact(&mut received),
                    server_write.write_all(&reverse),
                    client_read.read_exact(&mut received_reverse)
                )
            })
            .await;
        write.unwrap();
        read.unwrap();
        reverse_write.unwrap();
        reverse_read.unwrap();
        assert_eq!(
            received, expected,
            "same original B TCP without application replay"
        );
        assert_eq!(
            received_reverse, reverse,
            "same original native bridge reverse TCP bytes"
        );
        drop((
            client_read,
            client_write,
            server_read,
            server_write,
            listener,
        ));
    }

    pub(super) fn retire_b(&mut self) {
        self.tcp.retire();
    }

    pub(super) fn into_peers(self) -> Peers {
        self.peers
    }

    pub(super) fn unexpected_b_packet(
        &mut self,
        source: u8,
        source_port: u16,
        destination_port: u16,
    ) -> Received {
        let output = self.b.plane.process_outbound(vec![syn(
            SocketAddr::new(peer_ip(source), source_port),
            local(destination_port),
        )]);
        assert!(
            !output.to_peers.is_empty(),
            "actual SDK ciphertext for the negative tuple case"
        );
        self.b.transmit(output.to_peers);
        let mut bytes = [0; 2048];
        let (n, sender) = self.client.recv_from(&mut bytes).unwrap();
        assert_eq!(sender, self.b.socket.local_addr().unwrap());
        let (out, received) = self
            .peers
            .incoming(vec![PacketMut::from(&bytes[..n])])
            .unwrap();
        self.transmit(out);
        received
    }

    pub(super) async fn buffer_b_bridge(&mut self, client: &mut Stream, server: &mut TcpStream) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let canary = b"retired-bridge-plaintext";
        self.finish(server.write_all(canary)).await.unwrap();
        let mut first = [0];
        self.finish(client.read_exact(&mut first)).await.unwrap();
        assert_eq!(first, [canary[0]]);
        // The SDK read has filled the bounded duplex. Remaining bytes must not
        // become observable after the binding is withdrawn or its owner retires.
    }

    pub(super) async fn hold_b_delivery(&mut self, stream: &mut TcpStream) -> Received {
        use tokio::io::AsyncWriteExt;
        let mut write = Box::pin(stream.write_all(b"old-generation-plaintext"));
        let mut finished = false;
        let mut held = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            self.b.pump(self.epoch.elapsed().as_millis() as i64);
            let mut bytes = [0; 2048];
            let mut packets = Vec::new();
            while let Ok((n, _)) = self.client.recv_from(&mut bytes) {
                packets.push(PacketMut::from(&bytes[..n]));
                assert!(packets.len() <= 64);
            }
            let (out, received) = self.peers.incoming(packets).unwrap();
            self.transmit(out);
            if !received.is_empty() {
                assert!(held.is_none(), "one bounded held delivery");
                held = Some(received);
            }
            if finished && held.is_some() {
                return held.take().unwrap();
            }
            if !finished {
                tokio::select! { biased; result = &mut write => {result.unwrap(); finished = true;}, _ = tokio::task::yield_now() => {} }
            } else {
                tokio::task::yield_now().await;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "actual SDK held delivery deadline"
            );
        }
    }
}
