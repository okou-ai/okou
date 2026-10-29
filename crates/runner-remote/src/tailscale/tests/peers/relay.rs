//! Final raw IO admission through the real unchanged SDK HTTP/DERP buffers.
mod tcp;

use super::{bounded, inside, local, node, own, remote, update, wire};
use crate::tailscale::tests::derp::fixture::{self, PausedTcp, Server, WriteGate};
use crate::tailscale::tests::socket::SocketIdentity;
use crate::tailscale::{
    Failure,
    peers::{Binding, Clock, Frames, Peers},
    relay::Relay,
};
use futures_util::StreamExt;
use serde_json::json;
use std::sync::Arc;
use tokio::{io::AsyncReadExt, net::TcpStream};
use tokio_util::sync::CancellationToken;
use ts_derp::frame;
use ts_http_util::Upgraded;
use ts_keys::NodeKeyPair;
use ts_transport::{DynEndpoint, UnderlayTransportId};

pub(super) async fn relay(
    keys: &NodeKeyPair,
    cancel: CancellationToken,
    secure: bool,
) -> (Relay<Upgraded>, Server, Arc<WriteGate>) {
    let server = if secure {
        Server::secure().await
    } else {
        Server::new().await
    };
    let gate = WriteGate::new();
    let address = server.address;
    let tls = server.tls.clone();
    let socket = TcpStream::connect(address).await.unwrap();
    socket.set_nodelay(true).unwrap();
    let relay = connect(socket, address, tls, keys, cancel, Arc::clone(&gate)).await;
    (relay, server, gate)
}

pub(super) async fn connect(
    socket: TcpStream,
    address: std::net::SocketAddr,
    tls: Option<Arc<rustls::ClientConfig>>,
    keys: &NodeKeyPair,
    cancel: CancellationToken,
    gate: Arc<WriteGate>,
) -> Relay<Upgraded> {
    Relay::connect(
        PausedTcp::new(socket, Arc::clone(&gate)),
        keys,
        cancel,
        move |io| async move {
            if let Some(tls) = tls {
                let name = ts_tls_util::ServerName::try_from("derp.synthetic.invalid").unwrap();
                let io = tokio_rustls::TlsConnector::from(tls)
                    .connect(name, io)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                fixture::upgrade(address, io).await
            } else {
                fixture::upgrade(address, io).await
            }
        },
    )
    .await
    .unwrap()
}

pub(super) async fn packets() -> (NodeKeyPair, NodeKeyPair, Peers, Arc<Binding>, Frames) {
    let keys = NodeKeyPair::random();
    let peer = NodeKeyPair::random();
    packets_with_keys(keys, peer, None, Clock::default()).await
}

async fn packets_with_keys(
    keys: NodeKeyPair,
    peer: NodeKeyPair,
    expires: Option<chrono::DateTime<chrono::Utc>>,
    clock: Clock,
) -> (NodeKeyPair, NodeKeyPair, Peers, Arc<Binding>, Frames) {
    let mut peers = Peers::with_clock(keys.clone(), own(&keys).await, clock).unwrap();
    let mut metadata = node(2, "a.tail-okou.ts.net.", 2, &peer);
    if let Some(expires) = expires {
        metadata["KeyExpiry"] = json!(expires.to_rfc3339());
    }
    peers
        .update(update(json!({"Peers":[metadata],"PacketFilter":[]})).await)
        .unwrap();
    let binding = peers.bind("100.64.0.2", 22, local(6001)).unwrap();
    peers
        .endpoint(
            &binding,
            UnderlayTransportId(1),
            DynEndpoint::derp(peer.public),
        )
        .unwrap();
    let output = peers
        .outgoing(&binding, vec![wire::syn(local(6001), remote(2))])
        .unwrap();
    assert!(!output.is_empty(), "actual public SDK WireGuard ciphertext");
    (keys, peer, peers, binding, output)
}

async fn current_ciphertext(secure: bool) {
    inside(move |control| async move {
        let (keys, peer, mut peers, _binding, mut output) = packets().await;
        let (relay, server, gate) = relay(&keys, control.cancelled(), secure).await;
        let (mut frames, identity) = bounded(server.task).await.unwrap();
        assert_eq!(identity, keys.public);
        control.ready();
        let packet = peers.prepare_derp(&mut output).unwrap().unwrap();
        let expected = packet.bytes.as_ref().to_vec();
        bounded(relay.send(packet)).await.unwrap();
        let frame = bounded(frames.next()).await.unwrap().unwrap();
        let (header, ciphertext) = frame.get().as_type::<frame::SendPacket>().unwrap();
        assert_eq!(header.dest, peer.public);
        assert_eq!(ciphertext, expected);
        drop(relay);
        bounded(gate.destroyed()).await;
        closed(frames.get_mut(), secure).await;
    })
    .await;
}

pub(in crate::tailscale::tests) async fn closed(io: &mut Upgraded, secure: bool) {
    match bounded(io.read(&mut [0; 128])).await {
        Ok(0) => {}
        Err(error) if secure && error.kind() == std::io::ErrorKind::UnexpectedEof => {}
        result => {
            panic!("unexpected bytes or IO result after actual raw socket destruction: {result:?}")
        }
    }
}

#[tokio::test]
async fn authenticated_sdk_relay_emits_only_the_current_peer_ciphertext() {
    current_ciphertext(false).await;
}

#[tokio::test]
async fn verified_tls_sdk_relay_emits_the_current_peer_ciphertext() {
    current_ciphertext(true).await;
}

async fn withdrawal(prefix: usize, secure: bool) {
    inside(move |control| async move {
        let (keys, _peer, mut peers, _binding, mut output) = packets().await;
        let (relay, server, gate) = relay(&keys, control.cancelled(), secure).await;
        let (mut frames, _) = bounded(server.task).await.unwrap();
        control.ready();
        gate.pause_after(prefix);
        let packet = peers.prepare_derp(&mut output).unwrap().unwrap();
        let mut sending = Box::pin(relay.send(packet));
        tokio::select! { biased;
            result = &mut sending => panic!("writer unexpectedly completed: {result:?}"),
            _ = bounded(gate.pending()) => {}
        }
        if prefix != 0 && !secure {
            let mut bytes = vec![0; prefix];
            bounded(frames.get_mut().read_exact(&mut bytes))
                .await
                .unwrap();
            assert_eq!(bytes[0], frame::FrameType::SendPacket as u8);
        }
        // No artificial write wake: the actual typed map withdrawal wakes the
        // final IO fence even though the real raw TCP writer stays blocked.
        peers
            .update(update(json!({"PeersRemoved":[2]})).await)
            .unwrap();
        assert!(bounded(sending).await.is_err());
        drop(relay);
        bounded(gate.destroyed()).await;
        closed(frames.get_mut(), secure).await;
    })
    .await;
}

#[tokio::test]
async fn sdk_buffered_derp_frame_is_discarded_when_peer_withdraws_before_first_write() {
    withdrawal(0, false).await;
}

#[tokio::test]
async fn peer_withdrawal_wakes_a_partial_sdk_derp_write_and_closes_the_raw_socket() {
    withdrawal(12, false).await;
}

#[tokio::test]
async fn tls_buffered_sdk_frame_is_cut_off_before_first_raw_write() {
    withdrawal(0, true).await;
}

#[tokio::test]
async fn partial_tls_record_is_cut_off_without_releasing_a_derp_frame() {
    withdrawal(12, true).await;
}

async fn retained_capacity(secure: bool) {
    inside(move |control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        fixture.b_endpoint(true);
        let (relay, server, gate) = relay(&fixture.local_keys, control.cancelled(), secure).await;
        let (mut frames, _) = bounded(server.task).await.unwrap();
        let mut output = fixture
            .peers
            .outgoing(
                &fixture.binding,
                (0..64).map(|_| wire::syn(local(6002), remote(3))).collect(),
            )
            .unwrap();
        gate.pause_after(0);
        let mut sending =
            Box::pin(relay.send(fixture.peers.prepare_derp(&mut output).unwrap().unwrap()));
        tokio::select! { biased;
            result = &mut sending => panic!("writer unexpectedly completed: {result:?}"),
            _ = bounded(gate.pending()) => {}
        }
        drop(sending);
        drop(output);
        assert!(
            matches!(
                fixture.peers.outgoing(
                    &fixture.binding,
                    (0..64).map(|_| wire::syn(local(6002), remote(3))).collect()
                ),
                Err(Failure::ResourceExhausted)
            ),
            "SDK's retained frame still owns its capacity after caller cancellation"
        );
        // A real fresh ciphertext exists after this peer's completed WG/TCP
        // handshake. A poisoned SDK client must refuse it without flushing.
        let mut fresh = fixture
            .peers
            .outgoing(&fixture.binding, vec![wire::syn(local(6002), remote(3))])
            .unwrap();
        assert!(
            bounded(relay.send(fixture.peers.prepare_derp(&mut fresh).unwrap().unwrap()))
                .await
                .is_err()
        );
        drop(fresh);
        drop(relay);
        bounded(gate.destroyed()).await;
        closed(frames.get_mut(), secure).await;
        drop(
            fixture
                .peers
                .outgoing(
                    &fixture.binding,
                    (0..64).map(|_| wire::syn(local(6002), remote(3))).collect(),
                )
                .unwrap(),
        );
        fixture.b_endpoint(false);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn sdk_buffered_ciphertext_reserves_capacity_until_physical_disposal_and_b_tcp_survives() {
    retained_capacity(false).await;
}

#[tokio::test]
async fn tls_sdk_buffered_ciphertext_keeps_capacity_until_disposal_and_original_b_tcp_survives() {
    retained_capacity(true).await;
}

#[tokio::test]
async fn a_bound_peer_cannot_be_redirected_to_another_valid_derp_identity() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let a = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        assert!(
            fixture
                .peers
                .endpoint(&a, UnderlayTransportId(1), DynEndpoint::derp(fixture.b_key))
                .is_err()
        );
        drop(a);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn natural_key_expiry_wakes_the_actual_pending_tls_writer_without_a_map_update() {
    inside(|control| async move {
        let keys = NodeKeyPair::random();
        let (relay, server, gate) = relay(&keys, control.cancelled(), true).await;
        let (mut frames, _) = bounded(server.task).await.unwrap();
        let clock = Clock::held();
        let expires = clock.now() + chrono::Duration::milliseconds(250);
        let (_, _, mut peers, binding, mut output) =
            packets_with_keys(keys, NodeKeyPair::random(), Some(expires), clock.clone()).await;
        control.ready();
        gate.pause_after(0);
        let mut sending = Box::pin(relay.send(peers.prepare_derp(&mut output).unwrap().unwrap()));
        tokio::select! { biased;
            result=&mut sending=>panic!("writer unexpectedly completed before expiry: {result:?}"),
            _=bounded(gate.pending())=>{}
        }
        assert!(
            binding.live(),
            "the actual TLS writer is pending before expiry"
        );
        // Start the natural timer after observing the actual blocked writer.
        // There is no map update, write release or binding cancellation.
        clock.start();
        assert!(bounded(sending).await.is_err());
        drop(relay);
        bounded(gate.destroyed()).await;
        closed(frames.get_mut(), true).await;
        assert!(
            peers
                .outgoing(&binding, vec![wire::syn(local(6001), remote(2))])
                .is_err()
        );
    })
    .await;
}

#[tokio::test]
async fn run_retirement_joins_a_partial_tls_sdk_frame_and_closes_the_actual_os_descriptor() {
    use crate::{
        tailscale::tests::fixture::Cache,
        tailscale::{Key, Work, registration::Registration},
    };
    // The synthetic service is outside the retiring native runtime, so its
    // observation cannot be satisfied by disposing both ends of the socket.
    let server = Server::secure().await;
    let address = server.address;
    let tls = server.tls.clone();
    let gate = WriteGate::new();
    let owned_gate = Arc::clone(&gate);
    let (descriptor, identity) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control| {
        Box::pin(async move {
            let profile = Registration::new();
            let keys = profile.keys().node_keys.clone();
            let socket = TcpStream::connect(address).await.unwrap();
            descriptor.send(SocketIdentity::record(&socket)).unwrap();
            let relay = connect(
                socket,
                address,
                tls,
                &keys,
                control.cancelled(),
                Arc::clone(&owned_gate),
            )
            .await;
            let (_, _, mut peers, _binding, mut output) =
                packets_with_keys(keys, NodeKeyPair::random(), None, Clock::default()).await;
            owned_gate.pause_after(12);
            control.ready();
            relay
                .send(peers.prepare_derp(&mut output).unwrap().unwrap())
                .await?;
            Err(Failure::DomainFailed)
        })
    });
    let cache = Cache::new();
    let run = cache.register(runner_types::ids::RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    let (mut frames, _) = bounded(server.task).await.unwrap();
    bounded(node.ready()).await.unwrap();
    bounded(gate.pending()).await;
    let identity = bounded(identity).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    identity.assert_closed();
    closed(frames.get_mut(), true).await;
    drop((node, access, run, cache));
}
