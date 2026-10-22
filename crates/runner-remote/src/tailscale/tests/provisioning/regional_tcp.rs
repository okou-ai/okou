//! Two actual map-derived regions; only controlled external SDK peers are pumped.
//! The production configured Root runs independently on its owned OS thread.

mod admission;
mod capacity;
mod common;
mod kdc;
mod liveness;
mod vnc;
mod vnc_shared;

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Instant,
};

use futures_util::Stream;
use runner_types::ids::RunId;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::codec::{Encoder, Framed};
use ts_derp::frame;
use ts_http_util::Upgraded;
use ts_keys::{NodeKeyPair, NodePublicKey};
use ts_netstack_smoltcp_socket::CreateSocket;

use super::{
    configuration,
    fixture::Service as Api,
    regional_fixture::{Relay, map},
};
use crate::{
    tailscale::tests::fixture::Cache,
    tailscale::tests::{
        derp::fixture::{Server, WriteGate},
        fixture::bounded,
        peers::{node, wire},
        startup::secure::{KeyReply, Service as Control},
    },
};

const ACCEPTED: &[u8] = br#"{"User":{"ID":1},"Login":{"ID":1,"Provider":"synthetic","LoginName":"synthetic"},"MachineAuthorized":true,"NodeKeyExpired":false,"Error":"","AuthURL":""}"#;
type Frames = Framed<Upgraded, frame::Codec>;
type Handshake = tokio::task::JoinHandle<(Frames, NodePublicKey)>;

struct Service {
    task: Option<Handshake>,
    frames: Option<Frames>,
    outgoing: VecDeque<bytes::BytesMut>,
    offset: usize,
    expected: NodePublicKey,
    client: NodePublicKey,
    closed: bool,
    packets: usize,
}

impl Service {
    fn poll(&mut self, cx: &mut Context<'_>, side: &mut wire::DerpSide) {
        if let Some(task) = self.task.as_mut()
            && let Poll::Ready(result) = Pin::new(task).poll(cx)
        {
            let (frames, client) = result.unwrap();
            assert_eq!(client, self.client);
            self.frames = Some(frames);
            self.task.take();
        }
        let Some(frames) = self.frames.as_mut() else {
            return;
        };
        // The independently driven native root can outpace this peer's queue.
        // Leave excess frames buffered until Peers::pump consumes the batch.
        while side.can_receive() {
            match Pin::new(&mut *frames).poll_next(cx) {
                Poll::Pending => break,
                Poll::Ready(Some(Ok(packet))) => {
                    let (header, bytes) = packet.get().as_type::<frame::SendPacket>().unwrap();
                    assert_eq!(
                        header.dest, self.expected,
                        "a different peer was sent to this region"
                    );
                    self.packets += 1;
                    side.receive(ts_packet::PacketMut::from(bytes));
                }
                Poll::Ready(_) => {
                    self.frames.take();
                    self.outgoing.clear();
                    self.closed = true;
                    break;
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
                    Poll::Ready(Ok(count)) if count != 0 => self.offset += count,
                    Poll::Pending => return,
                    _ => {
                        self.outgoing.clear();
                        self.offset = 0;
                        return;
                    }
                }
            }
            self.outgoing.pop_front();
            self.offset = 0;
        }
        let _ = Pin::new(frames.get_mut()).poll_flush(cx);
    }
}

struct Peers {
    services: Vec<Service>,
    sides: Vec<wire::DerpSide>,
    destinations: Vec<usize>,
    epoch: Instant,
}

impl Peers {
    async fn pump(&mut self) {
        std::future::poll_fn(|cx| {
            for (service, destination) in self.services.iter_mut().zip(&self.destinations) {
                service.poll(cx, &mut self.sides[*destination]);
            }
            for side in &mut self.sides {
                for packet in side.pump(self.epoch.elapsed().as_millis() as i64) {
                    self.services[0].enqueue(side.key, packet);
                }
            }
            self.services[0].flush(cx);
            Poll::Ready(())
        })
        .await;
    }

    async fn finish<F: Future>(&mut self, future: F) -> F::Output {
        bounded(async {
            tokio::pin!(future);
            loop {
                self.pump().await;
                tokio::select! { biased; result = &mut future => return result, _ = tokio::task::yield_now() => {} }
            }
        }).await
    }

    async fn transfer<C, S>(&mut self, client: &mut C, server: &mut S)
    where
        C: tokio::io::AsyncRead + AsyncWrite + Unpin,
        S: tokio::io::AsyncRead + AsyncWrite + Unpin,
    {
        let expected = (0..65536).map(|i| (i % 251) as u8).collect::<Vec<_>>();
        let reverse = (0..65536)
            .map(|i| ((i + 71) % 251) as u8)
            .collect::<Vec<_>>();
        let mut forward = vec![0; expected.len()];
        let mut backward = vec![0; reverse.len()];
        let (mut cr, mut cw) = tokio::io::split(client);
        let (mut sr, mut sw) = tokio::io::split(server);
        let (a, b, c, d) = self
            .finish(async {
                tokio::join!(
                    cw.write_all(&expected),
                    sr.read_exact(&mut forward),
                    sw.write_all(&reverse),
                    cr.read_exact(&mut backward)
                )
            })
            .await;
        a.unwrap();
        b.unwrap();
        c.unwrap();
        d.unwrap();
        assert_eq!(forward, expected);
        assert_eq!(backward, reverse);
    }
}

#[tokio::test]
async fn configured_regions_keep_original_b_tcp_after_a_partial_tls_writer_is_retired() {
    independent_b(Scenario::PartialWriter).await;
}

#[tokio::test]
async fn failed_peer_region_closes_only_a_and_keeps_original_b_tcp_and_home_relay() {
    independent_b(Scenario::FailedPeer).await;
}

#[tokio::test]
async fn authenticated_map_withdrawal_cuts_a_partial_regional_writer_and_preserves_original_b_tcp()
{
    independent_b(Scenario::WithdrawPeer).await;
}

#[tokio::test]
async fn failed_home_region_physically_retires_both_established_tcp_flows_and_all_owned_io() {
    independent_b(Scenario::FailedHome).await;
}

#[tokio::test]
async fn authenticated_peer_server_change_drops_partial_old_tls_and_preserves_both_tcp_flows() {
    independent_b(Scenario::ReplacePeer).await;
}

#[tokio::test]
async fn authenticated_home_server_change_drops_partial_old_tls_and_preserves_both_tcp_flows() {
    independent_b(Scenario::ReplaceHome).await;
}

#[tokio::test]
async fn retired_peer_handshake_preserves_original_sibling_tcp_and_normal_node_logout() {
    independent_b(Scenario::RetiredPeer).await;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    PartialWriter,
    FailedPeer,
    WithdrawPeer,
    FailedHome,
    ReplacePeer,
    ReplaceHome,
    RetiredPeer,
}

async fn independent_b(scenario: Scenario) {
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let other = Server::secure().await;
    let replacement = if matches!(scenario, Scenario::ReplacePeer | Scenario::ReplaceHome) {
        Some(Server::secure().await)
    } else {
        None
    };
    let a = NodeKeyPair::random();
    let b = NodeKeyPair::random();
    let mut value: serde_json::Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut second = value["DERPMap"]["Regions"]["1"].clone();
    second["RegionID"] = 2.into();
    second["Nodes"][0]["RegionID"] = 2.into();
    second["Nodes"][0]["Name"] = "2a".into();
    second["Nodes"][0]["DERPPort"] = other.address.port().into();
    value["DERPMap"]["Regions"]["2"] = second;
    let mut peer_a = node(2, "a.synthetic.ts.net.", 2, &a);
    peer_a["HomeDERP"] = 2.into();
    let mut peer_b = node(3, "b.synthetic.ts.net.", 3, &b);
    peer_b["HomeDERP"] = 1.into();
    value["Peers"] = vec![peer_a, peer_b].into();
    value["PacketFilter"] = serde_json::json!([]);
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    if scenario == Scenario::RetiredPeer {
        control.set_logout_reply(
            hyper::StatusCode::OK,
            br#"{"NodeKeyExpired":true}"#.to_vec(),
        );
    }
    let gates = [WriteGate::new(), WriteGate::new(), WriteGate::new()];
    let mut servers = vec![&home, &other];
    if let Some(replacement) = &replacement {
        servers.push(replacement);
    }
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register_with_diagnostics(RunId::new_v4(), true);
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = api.secure.as_ref().unwrap().clone();
    let config = configuration(uuid::Uuid::new_v4());
    let native = access
        .native_configured(
            config.clone(),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::multiple(&servers, &gates, Arc::clone(&descriptors)),
            ),
        )
        .unwrap();
    let source = native.diagnostic_source(config.key());
    control.allow_all();
    bounded(native.ready()).await.unwrap();
    assert_eq!(control.announced_home(), vec![1]);
    let (frames, client) = bounded(home.task).await.unwrap();
    let mut peers = Peers {
        services: vec![
            Service {
                task: None,
                frames: Some(frames),
                outgoing: VecDeque::new(),
                offset: 0,
                expected: b.public,
                client,
                closed: false,
                packets: 0,
            },
            Service {
                task: Some(other.task),
                frames: None,
                outgoing: VecDeque::new(),
                offset: 0,
                expected: a.public,
                client,
                closed: false,
                packets: 0,
            },
        ],
        sides: vec![
            wire::DerpSide::new(a.clone(), client, 2),
            wire::DerpSide::new(b, client, 3),
        ],
        // Region 1 is our home and B's home; region 2 is A's home.
        destinations: vec![1, 0],
        epoch: Instant::now(),
    };
    let ac = peers.sides[0].channel();
    let bc = peers.sides[1].channel();
    let (al, bl) = peers
        .finish(async {
            tokio::join!(
                ac.tcp_listen(wire::remote(2)),
                bc.tcp_listen(wire::remote(3))
            )
        })
        .await;
    let al = al.unwrap();
    let bl = bl.unwrap();
    let (ca, cb, sa, sb) = peers
        .finish(async {
            tokio::join!(
                native.dial("100.64.0.2", 22),
                native.dial("100.64.0.3", 22),
                al.accept(),
                bl.accept()
            )
        })
        .await;
    let mut ca = ca.unwrap();
    let mut cb = cb.unwrap();
    let evidence_a = ca.evidence().unwrap();
    let evidence_b = cb.evidence().unwrap();
    assert_ne!(evidence_a.attempt_id, evidence_b.attempt_id);
    assert_eq!(evidence_a.region, Some(2));
    assert_eq!(evidence_b.region, Some(1));
    assert_eq!(evidence_a.endpoints[0].address.to_string(), "100.64.0.2:22");
    assert_eq!(evidence_b.endpoints[0].address.to_string(), "100.64.0.3:22");
    for evidence in [&evidence_a, &evidence_b] {
        assert!(
            evidence
                .steps
                .iter()
                .any(|s| s.stage == crate::tailscale::evidence::Stage::PrivateTcp
                    && s.status == crate::tailscale::evidence::Status::Passed)
        );
    }
    let mut sa = sa.unwrap();
    let mut sb = sb.unwrap();
    peers.transfer(&mut ca, &mut sa).await;
    peers.transfer(&mut cb, &mut sb).await;
    for _ in 0..8 {
        peers.pump().await;
        tokio::task::yield_now().await;
    }
    // Count established sockets before retiring either region. A failed
    // reconnect can open TCP on a reused loopback port without completing
    // TLS/DERP or replacing either original TCP flow.
    assert_eq!(descriptors.lock().unwrap().len(), 2);
    if scenario == Scenario::RetiredPeer {
        drop(ca);
        // The actual regional TLS/raw socket closes only after Core retires A
        // and removes its active route. B keeps the native node and home alive.
        peers.finish(gates[1].destroyed()).await;
        peers.services[0].enqueue(a.public, wire::initiation(a.clone(), client));
        // The late initiation is ordered before B's replies on the same home
        // connection. Original B's complete transfer proves native progress
        // beyond that input, rather than merely waiting for a quiet interval.
        tokio::select! { biased;
            result = native.physical() => panic!(
                "shared native node stopped after retired-peer input: {result:?}; evidence={}",
                serde_json::to_value(source.evidence.layers().snapshot()).unwrap()
            ),
            _ = peers.transfer(&mut cb, &mut sb) => {}
        }
        assert!(source.evidence.layers().snapshot().unwrap().root.is_none());
        assert_eq!(descriptors.lock().unwrap().len(), 2);
        run.close();
        bounded(native.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        bounded(gates[0].destroyed()).await;
        assert_eq!(control.logout_count(), 1);
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        api.finish().await;
        control.finish().await;
        return;
    }
    if let Some(replacement) = replacement {
        let index = if scenario == Scenario::ReplaceHome {
            0
        } else {
            1
        };
        gates[index].pause_after(12);
        let bytes = b"server-authority-replacement";
        if index == 0 {
            cb.write_all(bytes).await.unwrap();
        } else {
            ca.write_all(bytes).await.unwrap();
        }
        peers.finish(gates[index].pending()).await;
        value["DERPMap"]["Regions"][if index == 0 { "1" } else { "2" }]["Nodes"][0]["DERPPort"] =
            replacement.address.port().into();
        control
            .update_map(serde_json::json!({"DERPMap": value["DERPMap"]}))
            .await;
        peers.finish(gates[index].destroyed()).await;
        let service = &mut peers.services[index];
        service.frames.take();
        service.outgoing.clear();
        service.offset = 0;
        service.closed = false;
        service.task = Some(replacement.task);
        let mut received = vec![0; bytes.len()];
        if index == 0 {
            peers.finish(sb.read_exact(&mut received)).await.unwrap();
        } else {
            peers.finish(sa.read_exact(&mut received)).await.unwrap();
        }
        assert_eq!(received, bytes);
        // These are the original two TCP streams. Only their map-authorized
        // external relay changed, after actual old TLS/raw socket destruction.
        peers.transfer(&mut ca, &mut sa).await;
        peers.transfer(&mut cb, &mut sb).await;
        assert_eq!(descriptors.lock().unwrap().len(), 3);
        let next_a = ca.evidence().unwrap().relay.unwrap().attempt_id;
        let next_b = cb.evidence().unwrap().relay.unwrap().attempt_id;
        let old_a = evidence_a.relay.as_ref().unwrap().attempt_id;
        let old_b = evidence_b.relay.as_ref().unwrap().attempt_id;
        if index == 0 {
            assert_ne!(next_b, old_b);
            assert_eq!(next_a, old_a);
        } else {
            assert_ne!(next_a, old_a);
            assert_eq!(next_b, old_b);
        }
        run.close();
        bounded(native.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        bounded(gates[2].destroyed()).await;
        bounded(gates[1 - index].destroyed()).await;
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        api.finish().await;
        control.finish().await;
        return;
    }
    if scenario == Scenario::FailedHome {
        // Both genuine TCP flows have transferred before the actual home TLS
        // socket disappears. Its single-use listener is gone; bounded owned
        // reconnects really fail rather than being injected into Root state.
        peers.services[0].frames.take();
        peers.services[0].outgoing.clear();
        bounded(native.physical()).await.unwrap();
        let retained = serde_json::to_value(source.evidence.layers().snapshot()).unwrap();
        assert_eq!(retained["root"], "relay");
        assert_eq!(retained["region"], 1);
        // A reused loopback port can accept TCP before TLS or DERP fails. The
        // complete setup attempt fails in every case, independently of that stage.
        assert!(
            retained["steps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["stage"] == "relay_attempt" && s["status"] == "failed"),
            "{retained}"
        );
        let mut byte = [0];
        assert!(matches!(bounded(ca.read(&mut byte)).await, Ok(0) | Err(_)));
        assert!(matches!(bounded(cb.read(&mut byte)).await, Ok(0) | Err(_)));
        bounded(gates[0].destroyed()).await;
        bounded(gates[1].destroyed()).await;
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        run.close();
        bounded(run.shutdown_native()).await.unwrap();
        api.finish().await;
        control.finish().await;
        return;
    }
    if scenario == Scenario::FailedPeer {
        // Close the actual external A-region TLS/raw socket. Its single-use
        // listener is gone, so owned reconnect attempts also genuinely fail.
        peers.services[1].frames.take();
        peers.services[1].outgoing.clear();
        peers.services[1].closed = true;
        let mut byte = [0];
        let result = peers.finish(ca.read(&mut byte)).await;
        assert!(matches!(result, Ok(0) | Err(_)));
        drop(ca);
        peers.finish(gates[1].destroyed()).await;
        assert!(peers.finish(native.dial("100.64.0.2", 22)).await.is_err());
    } else {
        gates[1].pause_after(12);
        ca.write_all(b"retired-region-A-bytes").await.unwrap();
        peers.finish(gates[1].pending()).await;
        if scenario == Scenario::WithdrawPeer {
            // This travels through the real authenticated HTTP2/Noise map
            // stream. The fixture does not touch any application peer state.
            control
                .update_map(serde_json::json!({"PeersRemoved":[2]}))
                .await;
            let mut byte = [0];
            assert!(matches!(
                peers.finish(ca.read(&mut byte)).await,
                Ok(0) | Err(_)
            ));
        }
        drop(ca);
        peers.finish(gates[1].destroyed()).await;
    }
    peers.transfer(&mut cb, &mut sb).await;
    assert_eq!(cb.evidence().unwrap().attempt_id, evidence_b.attempt_id);
    assert_eq!(
        cb.evidence().unwrap().endpoints[0].address,
        evidence_b.endpoints[0].address
    );
    assert!(source.evidence.layers().snapshot().unwrap().root.is_none());
    assert!(
        !peers.services[0].closed,
        "original home/B relay was replaced"
    );
    assert!(peers.services.iter().all(|service| service.packets > 0));
    if scenario != Scenario::FailedPeer {
        // Cancellation and map withdrawal must not start replacement IO.
        assert_eq!(
            descriptors.lock().unwrap().len(),
            2,
            "cancelled region opened replacement TCP"
        );
    }
    run.close();
    bounded(native.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gates[0].destroyed()).await;
    control.assert_control_closed();
    dial.assert_closed(2);
    api.assert_contract(1, 0);
    let expected = peers.services[0].expected;
    if let Some(frames) = peers.services[0].frames.as_mut() {
        use futures_util::StreamExt;
        bounded(async {
            let mut remaining = 0;
            while let Some(frame) = frames.next().await {
                let Ok(frame) = frame else {
                    break;
                };
                let (header, _) = frame.get().as_type::<frame::SendPacket>().unwrap();
                assert_eq!(header.dest, expected);
                remaining += 1;
                assert!(remaining <= 64, "unbounded traffic after physical closure");
            }
        })
        .await;
    }
    api.finish().await;
    control.finish().await;
}
