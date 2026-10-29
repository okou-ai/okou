//! External DERP and SDK TCP peers; the production Core/Driver own the client.
use super::super::{bounded, node, wire};
use super::{Connections, relay};
use crate::tailscale::tests::derp::fixture::{Server, WriteGate};
use crate::tailscale::tests::socket::SocketIdentity;
use crate::tailscale::{
    Failure,
    map_reader::MapReader,
    node_root::{Client, Root},
};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::{
    codec::{Encoder, Framed},
    sync::CancellationToken,
};
use ts_derp::frame;
use ts_http_util::Upgraded;
use ts_keys::{NodeKeyPair, NodePublicKey};

type ServerResult = (Framed<Upgraded, frame::Codec>, NodePublicKey);
struct Service {
    task: Option<tokio::task::JoinHandle<ServerResult>>,
    frames: Option<Framed<Upgraded, frame::Codec>>,
    outgoing: VecDeque<bytes::BytesMut>,
    offset: usize,
    closed: bool,
}

impl Service {
    fn new(task: tokio::task::JoinHandle<ServerResult>) -> Self {
        Self {
            task: Some(task),
            frames: None,
            outgoing: VecDeque::new(),
            offset: 0,
            closed: false,
        }
    }
    fn poll(&mut self, cx: &mut Context<'_>, node: NodePublicKey, sides: &mut [wire::DerpSide; 2]) {
        use futures_util::Stream;
        if let Some(task) = self.task.as_mut()
            && let Poll::Ready(result) = Pin::new(task).poll(cx)
        {
            let (frames, key) = result.unwrap();
            assert_eq!(key, node);
            self.frames = Some(frames);
            self.task.take();
        }
        let Some(frames) = self.frames.as_mut() else {
            return;
        };
        loop {
            match Pin::new(&mut *frames).poll_next(cx) {
                Poll::Pending => break,
                Poll::Ready(Some(Ok(packet))) => {
                    let (header, bytes) = packet
                        .get()
                        .as_type::<frame::SendPacket>()
                        .expect("only SDK peer data in this service");
                    let side = sides
                        .iter_mut()
                        .find(|side| side.key == header.dest)
                        .expect("exact controlled peer key");
                    side.receive(ts_packet::PacketMut::from(bytes));
                }
                Poll::Ready(_) => {
                    self.frames.take();
                    self.outgoing.clear();
                    self.offset = 0;
                    self.closed = true;
                    return;
                }
            }
        }
        self.flush(cx);
    }
    fn enqueue(&mut self, source: NodePublicKey, packet: ts_packet::PacketMut) {
        assert!(self.outgoing.len() < 64);
        let mut bytes = bytes::BytesMut::new();
        frame::Codec
            .encode(
                (
                    frame::RawFrame::from_body(&frame::RecvPacket { src: source }, packet.len())
                        .unwrap(),
                    packet.as_ref(),
                ),
                &mut bytes,
            )
            .unwrap();
        self.outgoing.push_back(bytes);
    }
    fn flush(&mut self, cx: &mut Context<'_>) {
        let Some(frames) = self.frames.as_mut() else {
            return;
        };
        while let Some(bytes) = self.outgoing.front() {
            while self.offset < bytes.len() {
                match Pin::new(frames.get_mut()).poll_write(cx, &bytes[self.offset..]) {
                    Poll::Pending => return,
                    Poll::Ready(Ok(count)) => {
                        assert!(count != 0);
                        self.offset += count;
                    }
                    Poll::Ready(Err(_)) => {
                        self.frames.take();
                        self.outgoing.clear();
                        self.closed = true;
                        return;
                    }
                }
            }
            match Pin::new(frames.get_mut()).poll_flush(cx) {
                Poll::Pending => return,
                Poll::Ready(Ok(())) => {
                    self.outgoing.pop_front();
                    self.offset = 0;
                }
                Poll::Ready(Err(_)) => {
                    self.frames.take();
                    self.outgoing.clear();
                    self.closed = true;
                    return;
                }
            }
        }
    }
}

pub(super) struct Shared {
    pub(super) client: Client,
    driver: tokio::task::JoinHandle<Result<(), Failure>>,
    maps: tokio::io::DuplexStream,
    cancel: CancellationToken,
    node: NodePublicKey,
    pub(super) sides: [wire::DerpSide; 2],
    services: [Service; 2],
    pub(super) gates: [Arc<WriteGate>; 2],
    pub(super) descriptors: Arc<Mutex<Vec<SocketIdentity>>>,
    epoch: Instant,
    secure: bool,
}

impl Shared {
    pub(super) async fn new(control: crate::tailscale::Control, secure: bool) -> Self {
        let keys = NodeKeyPair::random();
        let a = NodeKeyPair::random();
        let b = NodeKeyPair::random();
        let node_key = keys.public;
        let first = if secure {
            Server::secure().await
        } else {
            Server::new().await
        };
        let second = if secure {
            Server::secure().await
        } else {
            Server::new().await
        };
        let gates = [WriteGate::new(), WriteGate::new()];
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let cancel = control.cancelled().child_token();
        let (root, client) = Root::new(cancel.clone());
        let connector = Connections {
            keys: keys.clone(),
            cancelled: cancel.clone(),
            endpoints: VecDeque::from([
                (first.address, first.tls.clone(), Arc::clone(&gates[0])),
                (second.address, second.tls.clone(), Arc::clone(&gates[1])),
            ]),
            descriptors: Arc::clone(&descriptors),
        };
        let (map_io, mut maps) = tokio::io::duplex(64 * 1024);
        write_map(&mut maps, serde_json::json!({"Node":node(1,"runner.tail-okou.ts.net.",1,&keys),"Peers":[node(2,"a.tail-okou.ts.net.",2,&a),node(3,"b.tail-okou.ts.net.",3,&b)],"PacketFilter":[]})).await;
        let updates = ts_control::client::map_stream(MapReader::new(map_io));
        Self {
            client,
            // Only the actual Tokio task scheduler polls this root. A fixture
            // pump must not conceal missing map/TCP/timer/relay wakeups by
            // repeatedly polling a pending production future itself.
            driver: tokio::task::spawn_local(async move {
                root.run(keys, updates, connector, &control).await
            }),
            maps,
            cancel,
            node: node_key,
            sides: [
                wire::DerpSide::new(a, node_key, 2),
                wire::DerpSide::new(b, node_key, 3),
            ],
            services: [Service::new(first.task), Service::new(second.task)],
            gates,
            descriptors,
            epoch: Instant::now(),
            secure,
        }
    }
    pub(super) async fn pump(&mut self) {
        std::future::poll_fn(|cx| {
            assert!(
                Pin::new(&mut self.driver).poll(cx).is_pending(),
                "actual retained relay driver stopped"
            );
            for service in &mut self.services {
                service.poll(cx, self.node, &mut self.sides);
            }
            let active = self
                .services
                .iter()
                .rposition(|service| service.frames.is_some());
            for side in &mut self.sides {
                let packets = side.pump(self.epoch.elapsed().as_millis() as i64);
                if let Some(active) = active {
                    for packet in packets {
                        self.services[active].enqueue(side.key, packet);
                    }
                }
                // No absent/old transport packet is replayed into a replacement.
                // Original SDK TCP/WireGuard owners retain protocol retries.
            }
            for service in &mut self.services {
                service.flush(cx);
            }
            assert!(Pin::new(&mut self.driver).poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    pub(super) async fn finish<F: Future>(&mut self, future: F) -> F::Output {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut future = Box::pin(future);
        loop {
            self.pump().await;
            tokio::select! { biased; result=&mut future=>return result, _=tokio::task::yield_now()=>{} }
            assert!(
                tokio::time::Instant::now() < deadline,
                "actual shared TLS/DERP/TCP deadline"
            );
        }
    }
    pub(super) async fn transfer(
        &mut self,
        client: &mut crate::tailscale::tcp::Stream,
        server: &mut ts_netstack_smoltcp_socket::TcpStream,
        size: usize,
    ) {
        let expected = (0..size).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let reverse = (0..size)
            .map(|i| ((i + 31) % 239) as u8)
            .collect::<Vec<_>>();
        let mut forward = vec![0; size];
        let mut backward = vec![0; size];
        let (mut cr, mut cw) = tokio::io::split(client);
        let (mut sr, mut sw) = tokio::io::split(server);
        let (w, r, rw, rr) = self
            .finish(async {
                tokio::join!(
                    cw.write_all(&expected),
                    sr.read_exact(&mut forward),
                    sw.write_all(&reverse),
                    cr.read_exact(&mut backward)
                )
            })
            .await;
        w.unwrap();
        r.unwrap();
        rw.unwrap();
        rr.unwrap();
        assert_eq!(
            forward, expected,
            "original B forward TCP bytes without reconnect/replay"
        );
        assert_eq!(
            backward, reverse,
            "original B reverse TCP bytes without reconnect/replay"
        );
    }
    pub(super) fn original_closed(&self) -> bool {
        self.services[0].closed
    }
    pub(super) async fn update(&mut self, update: serde_json::Value) {
        write_map(&mut self.maps, update).await;
    }
    pub(super) async fn close(mut self) {
        use futures_util::StreamExt;
        self.cancel.cancel();
        assert_eq!(bounded(self.driver).await.unwrap(), Err(Failure::Cancelled));
        let connections = self.descriptors.lock().unwrap().len();
        assert!((1..=2).contains(&connections));
        bounded(self.gates[connections - 1].destroyed()).await;
        // Another test may already own the same fd number. Check the exact
        // original socket, as connect does before opening a replacement.
        self.descriptors
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .assert_closed();
        for service in &mut self.services {
            // A replacement that was never used is an external fixture
            // listener, not native work. Abort and join that exact fixture.
            if let Some(task) = service.task.take() {
                task.abort();
                assert!(bounded(task).await.is_err_and(|error| error.is_cancelled()));
            }
            if let Some(frames) = service.frames.as_mut() {
                // An independently scheduled root can commit final B ACKs to
                // the kernel before cancellation. Validate those bounded SDK
                // frames before checking EOF; bytes already accepted by the
                // OS are not a later write after physical socket destruction.
                let mut ended = false;
                for _ in 0..64 {
                    match bounded(frames.next()).await {
                        None => {
                            ended = true;
                            break;
                        }
                        Some(Err(error))
                            if self.secure && error.kind() == std::io::ErrorKind::UnexpectedEof =>
                        {
                            ended = true;
                            break;
                        }
                        Some(Ok(packet)) => {
                            let (header, bytes) =
                                packet.get().as_type::<frame::SendPacket>().unwrap();
                            assert_eq!(header.dest, self.sides[1].key);
                            assert!(bytes.len() <= 2048);
                            self.sides[1].receive(ts_packet::PacketMut::from(bytes));
                        }
                        Some(Err(error)) => panic!("unexpected final DERP IO: {error}"),
                    }
                }
                assert!(ended, "finite final DERP frames reach actual closure");
                relay::closed(frames.get_mut(), self.secure).await;
            }
        }
    }
}

async fn write_map(io: &mut tokio::io::DuplexStream, update: serde_json::Value) {
    let bytes = serde_json::to_vec(&update).unwrap();
    bounded(io.write_u32_le(bytes.len() as u32)).await.unwrap();
    bounded(io.write_all(&bytes)).await.unwrap();
}
