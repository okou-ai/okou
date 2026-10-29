//! One actual shared SDK TLS/DERP transport and surviving original TCP stacks.
mod fixture;
use super::{bounded, inside, relay};
use crate::tailscale::tests::derp::fixture::{Server, WriteGate};
use crate::tailscale::tests::socket::SocketIdentity;
use crate::tailscale::{
    Failure,
    relay_driver::{Connector, Driver},
};
use futures_util::StreamExt;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_util::{codec::Encoder, sync::CancellationToken};
use ts_derp::frame;
use ts_http_util::Upgraded;
use ts_keys::NodeKeyPair;

async fn write_frame(io: &mut Upgraded, raw: frame::RawFrame<'_>, extra: &[u8]) {
    let mut bytes = bytes::BytesMut::new();
    frame::Codec.encode((raw, extra), &mut bytes).unwrap();
    bounded(io.write_all(&bytes)).await.unwrap();
    bounded(io.flush()).await.unwrap();
}

async fn abandoned_pong(secure: bool) {
    inside(move |control| async move {
        let (keys, _, mut peers, _binding, mut output) = relay::packets().await;
        let (relay, server, gate) = relay::relay(&keys, control.cancelled(), secure).await;
        let (mut frames, _) = bounded(server.task).await.unwrap();
        control.ready();
        gate.pause_after(12);
        let ping = frame::Ping {
            payload: *b"bounded!",
        };
        write_frame(
            frames.get_mut(),
            frame::RawFrame::from_body(&ping, 0).unwrap(),
            &[],
        )
        .await;
        let mut receiving = Box::pin(relay.receive());
        tokio::select! { biased;
            result=&mut receiving => panic!("inline Pong unexpectedly completed: {result:?}"),
            _=bounded(gate.pending())=>{}
        }
        drop(receiving);
        assert!(
            relay.poisoned(),
            "abandoned inline control buffer seals its SDK writer"
        );
        assert!(
            bounded(relay.send(peers.prepare_derp(&mut output).unwrap().unwrap()))
                .await
                .is_err()
        );
        drop(relay);
        bounded(gate.destroyed()).await;
        if !secure {
            let mut prefix = [0; 12];
            bounded(frames.get_mut().read_exact(&mut prefix))
                .await
                .unwrap();
            assert_eq!(prefix[0], frame::FrameType::Pong as u8);
        }
        relay::closed(frames.get_mut(), secure).await;
    })
    .await;
}

#[tokio::test]
async fn abandoning_an_inline_sdk_pong_prevents_later_plaintext_flush() {
    abandoned_pong(false).await;
}

#[tokio::test]
async fn abandoning_a_partial_tls_pong_prevents_later_ciphertext_flush() {
    abandoned_pong(true).await;
}

#[tokio::test]
async fn derp_lengths_and_fixed_body_shapes_are_rejected_before_sdk_decode_or_allocation() {
    inside(|control| async move {
        control.ready();
        for (typ, length) in [
            (5u8, 0u32),
            (5, 31),
            (5, 2081),
            (5, u32::MAX),
            (8, 32),
            (8, 34),
            (18, 7),
            (18, 9),
            (3, 4097),
            (255, 1),
        ] {
            let keys = NodeKeyPair::random();
            let (relay, server, gate) = relay::relay(&keys, control.cancelled(), false).await;
            let (mut frames, _) = bounded(server.task).await.unwrap();
            let mut header = vec![typ];
            header.extend_from_slice(&length.to_be_bytes());
            bounded(frames.get_mut().write_all(&header)).await.unwrap();
            assert!(
                bounded(relay.receive()).await.is_err(),
                "invalid DERP length reached the SDK"
            );
            drop(relay);
            bounded(gate.destroyed()).await;
            relay::closed(frames.get_mut(), false).await;
        }
    })
    .await;
}

pub(in crate::tailscale::tests) struct Connections {
    keys: NodeKeyPair,
    cancelled: CancellationToken,
    endpoints: VecDeque<(
        std::net::SocketAddr,
        Option<Arc<rustls::ClientConfig>>,
        Arc<WriteGate>,
    )>,
    descriptors: Arc<Mutex<Vec<SocketIdentity>>>,
}

pub(in crate::tailscale::tests) fn single_connector(
    keys: NodeKeyPair,
    cancelled: CancellationToken,
    address: std::net::SocketAddr,
    tls: Option<Arc<rustls::ClientConfig>>,
    gate: Arc<WriteGate>,
    descriptors: Arc<Mutex<Vec<SocketIdentity>>>,
) -> Connections {
    Connections {
        keys,
        cancelled,
        endpoints: VecDeque::from([(address, tls, gate)]),
        descriptors,
    }
}

impl Connector for Connections {
    async fn connect(&mut self) -> Result<crate::tailscale::relay::Relay<Upgraded>, Failure> {
        if let Some(old) = self.descriptors.lock().unwrap().last() {
            old.assert_closed();
        }
        let (address, tls, gate) = self.endpoints.pop_front().ok_or(Failure::DomainFailed)?;
        let socket = TcpStream::connect(address)
            .await
            .map_err(|_| Failure::DomainFailed)?;
        self.descriptors
            .lock()
            .unwrap()
            .push(SocketIdentity::record(&socket));
        socket.set_nodelay(true).unwrap();
        Ok(relay::connect(
            socket,
            address,
            tls,
            &self.keys,
            self.cancelled.clone(),
            gate,
        )
        .await)
    }
}

#[tokio::test]
async fn the_owned_driver_retires_a_backpressured_inline_pong_and_closes_the_tls_socket() {
    inside(|control| async move {
        let keys = NodeKeyPair::random();
        let server = Server::secure().await;
        let gate = WriteGate::new();
        let cancel = control.cancelled().child_token();
        let (driver, mut port) = Driver::new(cancel.clone());
        let connector = Connections {
            keys: keys.clone(),
            cancelled: cancel.clone(),
            endpoints: VecDeque::from([(server.address, server.tls.clone(), Arc::clone(&gate))]),
            descriptors: Arc::new(Mutex::new(Vec::new())),
        };
        let mut running = Box::pin(driver.run(connector));
        let mut handshake = Box::pin(server.task);
        let (mut frames, _) = tokio::select! { biased;
            result=&mut running=>panic!("driver failed during handshake: {result:?}"),
            result=&mut handshake=>result.unwrap(),
        };
        control.ready();
        gate.pause_after(0);
        let ping = frame::Ping {
            payload: *b"backpres",
        };
        write_frame(
            frames.get_mut(),
            frame::RawFrame::from_body(&ping, 0).unwrap(),
            &[],
        )
        .await;
        tokio::select! { biased;
            result=&mut running=>panic!("driver unexpectedly stopped: {result:?}"),
            _=bounded(gate.pending())=>{}
        }
        // Cancellation must drop both owned loops and the actual client even
        // while SDK recv_one is parked on its internal Pong writer.
        cancel.cancel();
        assert_eq!(bounded(running).await, Err(Failure::Cancelled));
        bounded(gate.destroyed()).await;
        assert!(port.receive().is_err());
        relay::closed(frames.get_mut(), true).await;
    })
    .await;
}

#[tokio::test]
async fn one_driver_concurrently_handles_inline_pong_data_send_and_bounded_receive() {
    inside(|control| async move {
        let (keys, peer, mut peers, _binding, mut output) = relay::packets().await;
        let server = Server::secure().await;
        let gate = WriteGate::new();
        let cancel = control.cancelled().child_token();
        let (driver, mut port) = Driver::new(cancel.clone());
        let connector = Connections { keys: keys.clone(), cancelled: cancel.clone(), endpoints: VecDeque::from([(server.address, server.tls.clone(), Arc::clone(&gate))]), descriptors: Arc::new(Mutex::new(Vec::new())) };
        let mut running = Box::pin(driver.run(connector));
        let (mut frames, _) = tokio::select! { biased;
            result=&mut running=>panic!("driver failed during handshake: {result:?}"),
            result=server.task=>result.unwrap(),
        };
        control.ready();
        let ping = frame::Ping { payload: *b"progress" };
        write_frame(frames.get_mut(), frame::RawFrame::from_body(&ping, 0).unwrap(), &[]).await;
        let bytes = peers.prepare_derp(&mut output).unwrap().unwrap();
        let expected = bytes.bytes.as_ref().to_vec();
        port.send(bytes).unwrap();
        let mut pong = false;
        let mut packet = false;
        while !pong || !packet {
            let received = tokio::select! { biased;
                result=&mut running=>panic!("driver stopped during IO: {result:?}"),
                frame=bounded(frames.next())=>frame.unwrap().unwrap(),
            };
            if let Some((header, rest)) = received.get().as_type::<frame::Pong>() {
                assert_eq!(header.payload, ping.payload); assert!(rest.is_empty()); assert!(!pong); pong = true;
            } else {
                let (header, payload) = received.get().as_type::<frame::SendPacket>().unwrap();
                assert_eq!(header.dest, peer.public); assert_eq!(payload, expected); assert!(!packet); packet = true;
            }
        }
        let incoming = vec![71; 2048];
        write_frame(frames.get_mut(), frame::RawFrame::from_body(&frame::RecvPacket { src: peer.public }, incoming.len()).unwrap(), &incoming).await;
        let observed = bounded(async {
            loop {
                if let Some(packet) = port.receive().unwrap() { return packet; }
                tokio::select! { biased; result=&mut running=>panic!("driver stopped before delivery: {result:?}"), _=tokio::task::yield_now()=>{} }
            }
        }).await;
        assert_eq!(observed.0, peer.public); assert_eq!(observed.1.as_ref(), incoming);
        cancel.cancel();
        assert_eq!(bounded(running).await, Err(Failure::Cancelled));
        bounded(gate.destroyed()).await;
        relay::closed(frames.get_mut(), true).await;
    }).await;
}

async fn surviving_original_b(secure: bool) {
    use super::wire;
    use ts_netstack_smoltcp_socket::CreateSocket;
    inside(move |control| async move {
        let mut shared = fixture::Shared::new(control, secure).await;
        let a = shared.sides[0].channel();
        let b = shared.sides[1].channel();
        let (a_listener, b_listener) = shared
            .finish(async {
                tokio::join!(a.tcp_listen(wire::remote(2)), b.tcp_listen(wire::remote(3)))
            })
            .await;
        let a_listener = a_listener.unwrap();
        let b_listener = b_listener.unwrap();
        let a_open = shared.client.dial("100.64.0.2", 22).unwrap();
        let b_open = shared.client.dial("100.64.0.3", 22).unwrap();
        let (a_client, b_client, a_server, b_server) = shared
            .finish(async {
                tokio::join!(a_open, b_open, a_listener.accept(), b_listener.accept())
            })
            .await;
        let mut a_client = a_client.unwrap();
        let mut b_client = b_client.unwrap();
        let mut a_server = a_server.unwrap();
        let mut b_server = b_server.unwrap();
        shared.transfer(&mut a_client, &mut a_server, 1024).await;
        shared.transfer(&mut b_client, &mut b_server, 1024).await;
        for _ in 0..8 {
            shared.pump().await;
            tokio::task::yield_now().await;
        }
        assert_eq!(
            shared.descriptors.lock().unwrap().len(),
            1,
            "A and B use one original actual DERP connection"
        );
        shared.gates[0].pause_after(if secure { 12 } else { 37 });
        a_client
            .write_all(b"retired-A-application-bytes")
            .await
            .unwrap();
        let pending = Arc::clone(&shared.gates[0]);
        shared.finish(pending.pending()).await;
        shared.update(serde_json::json!({"PeersRemoved":[2]})).await;
        assert!(
            shared.finish(a_client.read(&mut [0; 64])).await.is_err(),
            "retired original A cannot release buffered plaintext"
        );
        shared.transfer(&mut b_client, &mut b_server, 65536).await;
        assert!(
            shared.original_closed(),
            "old actual SDK/TLS socket reached external EOF/error"
        );
        assert_eq!(
            shared.descriptors.lock().unwrap().len(),
            2,
            "one physical replacement, no original TCP reconnect"
        );
        shared.close().await;
        drop((
            a_client, b_client, a_server, b_server, a_listener, b_listener,
        ));
    })
    .await;
}

#[tokio::test]
async fn original_b_tcp_survives_a_retirement_through_one_shared_derp_connection_and_replacement() {
    surviving_original_b(false).await;
}

#[tokio::test]
async fn original_b_tcp_survives_a_partial_tls_derp_frame_retirement_and_owned_replacement() {
    surviving_original_b(true).await;
}

#[tokio::test]
async fn the_scheduled_native_root_uses_sdk_tcp_deadlines_after_a_real_derp_syn_loss() {
    use super::wire;
    use ts_netstack_smoltcp_socket::CreateSocket;
    inside(|control| async move {
        let mut shared = fixture::Shared::new(control, true).await;
        shared.sides[1].lose_first_syn();
        let channel = shared.sides[1].channel();
        let listener = shared
            .finish(channel.tcp_listen(wire::remote(3)))
            .await
            .unwrap();
        // There is exactly one application dial. Only the unchanged SDK TCP
        // timer can reproduce the discarded SYN; the fixture never polls Root.
        let opening = shared.client.dial("100.64.0.3", 22).unwrap();
        let (client, server) = shared
            .finish(async { tokio::join!(opening, listener.accept()) })
            .await;
        let mut client = client.unwrap();
        let mut server = server.unwrap();
        assert_eq!(shared.sides[1].lost_syns, 1);
        assert_eq!(shared.descriptors.lock().unwrap().len(), 1);
        shared.transfer(&mut client, &mut server, 65536).await;
        assert_eq!(shared.descriptors.lock().unwrap().len(), 1);
        shared.close().await;
        drop((client, server, listener));
    })
    .await;
}

async fn abandoning_pending_root_dial(target: &'static str) {
    use super::wire;
    use ts_netstack_smoltcp_socket::CreateSocket;
    inside(move |control| async move {
        let mut shared = fixture::Shared::new(control, true).await;
        let channel = shared.sides[1].channel();
        let listener = shared
            .finish(channel.tcp_listen(wire::remote(3)))
            .await
            .unwrap();
        let opening = shared.client.dial("100.64.0.3", 22).unwrap();
        let (client, server) = shared
            .finish(async { tokio::join!(opening, listener.accept()) })
            .await;
        let mut client = client.unwrap();
        let mut server = server.unwrap();
        shared.transfer(&mut client, &mut server, 1024).await;
        for _ in 0..8 {
            shared.pump().await;
            tokio::task::yield_now().await;
        }
        assert_eq!(shared.descriptors.lock().unwrap().len(), 1);
        shared.gates[0].pause_after(12);
        // There is no pending accept for this dial. Its complete private SDK
        // stack and queued SYN exist, and the shared TLS writer is genuinely held.
        let abandoned = shared.client.dial(target, 22).unwrap();
        let pending = Arc::clone(&shared.gates[0]);
        shared.finish(pending.pending()).await;
        drop(abandoned);
        shared.finish(pending.destroyed()).await;
        shared.transfer(&mut client, &mut server, 65536).await;
        assert!(shared.original_closed());
        assert_eq!(shared.descriptors.lock().unwrap().len(), 2);
        shared.close().await;
        drop((client, server, listener));
    })
    .await;
}

#[tokio::test]
async fn abandoning_a_pending_root_dial_cuts_its_partial_tls_frame_and_preserves_original_b_tcp() {
    abandoning_pending_root_dial("100.64.0.2").await;
}

#[tokio::test]
async fn abandoning_a_same_peer_pending_root_dial_preserves_original_b_tcp_after_crypto_retirement()
{
    abandoning_pending_root_dial("100.64.0.3").await;
}

#[tokio::test]
async fn a_prepared_ciphertext_cannot_be_retargeted_after_its_exact_peer_stamp() {
    inside(|control| async move {
        let (keys, _, mut peers, _binding, mut output) = relay::packets().await;
        let (relay, server, gate) = relay::relay(&keys, control.cancelled(), true).await;
        let (mut frames, _) = bounded(server.task).await.unwrap();
        control.ready();
        let mut packet = peers.prepare_derp(&mut output).unwrap().unwrap();
        packet.destination = NodeKeyPair::random().public;
        assert!(bounded(relay.send(packet)).await.is_err());
        assert!(
            !relay.poisoned(),
            "pre-encoding refusal does not retire an unrelated transport"
        );
        drop(relay);
        bounded(gate.destroyed()).await;
        relay::closed(frames.get_mut(), true).await;
    })
    .await;
}

#[tokio::test]
async fn cancelling_the_root_before_its_first_map_closes_real_map_io_and_rejects_all_four_queued_dials()
 {
    use crate::tailscale::{map_reader::MapReader, node_root::Root};
    inside(|control| async move {
        control.ready();
        let cancel = control.cancelled().child_token();
        let (root, client) = Root::new(cancel.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let socket_identity = SocketIdentity::record(&socket);
        let (mut provider, _) = listener.accept().await.unwrap();
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let connector = Connections {
            keys: NodeKeyPair::random(),
            cancelled: cancel.clone(),
            endpoints: VecDeque::new(),
            descriptors: Arc::clone(&descriptors),
        };
        let queued = (0..4)
            .map(|_| client.dial("100.64.0.2", 22).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            client.dial("100.64.0.2", 22),
            Err(Failure::ResourceExhausted)
        ));
        let maps = ts_control::client::map_stream(MapReader::new(socket));
        let mut running = Box::pin(root.run(NodeKeyPair::random(), maps, connector, &control));
        std::future::poll_fn(|cx| {
            assert!(running.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        cancel.cancel();
        // Waiters observe cancellation without another owner poll. The actual
        // socket remains physically owned until that root is then disposed.
        for response in queued {
            assert!(matches!(bounded(response).await, Err(Failure::Cancelled)));
        }
        socket_identity.assert_open();
        assert_eq!(bounded(&mut running).await, Err(Failure::Cancelled));
        drop(running);
        assert!(matches!(
            client.dial("100.64.0.2", 22),
            Err(Failure::Cancelled)
        ));
        assert!(descriptors.lock().unwrap().is_empty());
        socket_identity.assert_closed();
        assert_eq!(bounded(provider.read(&mut [0; 1])).await.unwrap(), 0);
    })
    .await;
}
