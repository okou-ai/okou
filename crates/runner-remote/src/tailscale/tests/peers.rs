//! Real public SDK map, route, crypto and TCP boundaries of the owned candidate.

pub(in crate::tailscale::tests) mod relay;
mod retirement;
pub(in crate::tailscale::tests) mod shared_derp;
mod status;
pub(super) mod wire;

use super::fixture::bounded;
use crate::tailscale::{Failure, map_reader::MapReader, peers::Peers};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use ts_control::{Node, StateUpdate};
use ts_keys::{NodeKeyPair, NodePublicKey};
use ts_netstack_smoltcp_socket::CreateSocket;
use ts_packet::PacketMut;
use ts_transport::{DynEndpoint, UnderlayTransportId};
use wire::{Stack, local, peer_ip, remote};

pub(in crate::tailscale::tests) fn node(id: i64, name: &str, ip: u8, keys: &NodeKeyPair) -> Value {
    node_with_key(id, name, ip, keys.public)
}

fn node_with_key(id: i64, name: &str, ip: u8, key: NodePublicKey) -> Value {
    json!({"ID":id,"StableID":format!("synthetic-node-{id}"),"Name":name,
        "Key":key.to_string(),"KeyExpiry":"0001-01-01T00:00:00Z","Addresses":[format!("100.64.0.{ip}/32"),format!("fd7a:115c:a1e0::{ip}/128")],
        "AllowedIPs":["0.0.0.0/0","::/0","192.168.0.0/16"],"Online":true})
}

async fn update(value: Value) -> StateUpdate {
    let json = serde_json::to_vec(&value).unwrap();
    let mut wire = (json.len() as u32).to_le_bytes().to_vec();
    wire.extend(json);
    let stream = ts_control::client::map_stream(MapReader::new(std::io::Cursor::new(wire)));
    futures_util::pin_mut!(stream);
    let parsed = bounded(stream.next())
        .await
        .expect("public SDK typed update");
    assert!(bounded(stream.next()).await.is_none());
    parsed
}

async fn assert_rejected_map(value: Value) {
    let json = serde_json::to_vec(&value).unwrap();
    let mut wire = (json.len() as u32).to_le_bytes().to_vec();
    wire.extend(json);
    let stream = ts_control::client::map_stream(MapReader::new(std::io::Cursor::new(wire)));
    futures_util::pin_mut!(stream);
    assert!(
        bounded(stream.next()).await.is_none(),
        "rejected map never reaches SDK metadata allocation/adoption"
    );
}

#[tokio::test]
async fn sdk_defaults_cannot_manufacture_an_absent_peer_key() {
    let keys = NodeKeyPair::random();
    let mut missing = node(2, "saved.tail-okou.ts.net.", 2, &keys);
    missing.as_object_mut().unwrap().remove("Key");
    let value = json!({"Peers":[missing]});
    let json = serde_json::to_vec(&value).unwrap();
    let mut wire = (json.len() as u32).to_le_bytes().to_vec();
    wire.extend(json);
    let unguarded = ts_control::client::map_stream(std::io::Cursor::new(wire));
    futures_util::pin_mut!(unguarded);
    assert!(
        bounded(unguarded.next()).await.is_some(),
        "real SDK currently defaults a missing key instead of preserving absence"
    );
    assert_rejected_map(value).await;
}

async fn own(keys: &NodeKeyPair) -> Node {
    update(json!({"Node":node(1,"runner.tail-okou.ts.net.",1,keys)}))
        .await
        .node
        .unwrap()
}

#[tokio::test]
async fn only_the_go_zero_expiry_instant_is_non_expiring_for_local_and_peer_nodes() {
    for (expiry, allowed) in [
        (None, true),
        (Some(Value::Null), true),
        (Some(json!("0001-01-01T00:00:00Z")), true),
        (Some(json!("0001-01-01T00:00:00.000000001Z")), false),
        (Some(json!("1970-01-01T00:00:00Z")), false),
        (Some(json!("2000-01-01T00:00:00Z")), false),
    ] {
        let keys = NodeKeyPair::random();
        let peer_keys = NodeKeyPair::random();
        let mut local_node = node(1, "runner.tail-okou.ts.net.", 1, &keys);
        let mut peer = node(2, "saved.tail-okou.ts.net.", 2, &peer_keys);
        for metadata in [&mut local_node, &mut peer] {
            if let Some(expiry) = &expiry {
                metadata["KeyExpiry"] = expiry.clone();
            } else {
                metadata.as_object_mut().unwrap().remove("KeyExpiry");
            }
        }
        let local_node = update(json!({"Node":local_node})).await.node.unwrap();
        let local_result = Peers::new(keys.clone(), local_node);
        assert_eq!(local_result.is_ok(), allowed, "local expiry {expiry:?}");
        let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
        peers.update(update(json!({"Peers":[peer]})).await).unwrap();
        assert_eq!(
            peers.bind("100.64.0.2", 8022, local(6001)).is_ok(),
            allowed,
            "peer expiry {expiry:?}"
        );
    }
}

#[tokio::test]
async fn exact_selected_tailnet_names_and_assigned_v4_v6_ignore_subnet_and_exit_routes() {
    let keys = NodeKeyPair::random();
    let a = NodeKeyPair::random();
    let foreign = NodeKeyPair::random();
    let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
    peers.update(update(json!({"Peers":[node(i64::MAX,"saved.tail-okou.ts.net.",2,&a),node((1i64<<32)+7,"saved.foreign.ts.net.",3,&foreign)]})).await).unwrap();
    let v4 = peers
        .bind("SAVED.TAIL-OKOU.TS.NET.", 22, local(6001))
        .unwrap();
    let v6 = peers
        .bind(
            "fd7a:115c:a1e0::2",
            22,
            "[fd7a:115c:a1e0::1]:6002".parse().unwrap(),
        )
        .unwrap();
    assert!(!v4.cancelled().is_cancelled() && !v6.cancelled().is_cancelled());
    for target in [
        "saved.foreign.ts.net",
        "100.64.0.3",
        "100.64.0.1",
        "192.168.1.2",
        "8.8.8.8",
        "100.64.0.9",
        "127.1",
        "[fd7a:115c:a1e0::2]",
        "saved.evil.ts.net",
        "saved.tail-okou.ts.net..",
    ] {
        assert!(
            peers.bind(target, 22, local(6010)).is_err(),
            "unsafe target {target}"
        );
    }
    assert!(
        peers
            .outgoing(
                &v4,
                vec![wire::syn(local(6001), "192.168.1.2:22".parse().unwrap())]
            )
            .is_err()
    );
    assert!(
        peers
            .outgoing(
                &v4,
                vec![wire::syn(local(6001), SocketAddr::new(peer_ip(2), 23))]
            )
            .is_err()
    );
    assert!(
        peers
            .outgoing(
                &v6,
                vec![wire::syn(
                    "[fd7a:115c:a1e0::1]:6002".parse().unwrap(),
                    "[fd7a:115c:a1e0::2]:22".parse().unwrap()
                )]
            )
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn ambiguous_names_and_missing_or_colliding_metadata_never_allocate_a_route() {
    let keys = NodeKeyPair::random();
    let a = NodeKeyPair::random();
    let b = NodeKeyPair::random();
    let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
    peers.update(update(json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&a),node(3,"saved.tail-okou.ts.net.",3,&b)]})).await).unwrap();
    assert!(peers.bind("saved", 22, local(6001)).is_err());
    assert!(
        peers
            .bind("saved.tail-okou.ts.net", 22, local(6001))
            .is_err()
    );
    let held = peers.bind("100.64.0.2", 22, local(6001)).unwrap();
    peers.update(update(json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&a),node(3,"other.tail-okou.ts.net.",2,&b)]})).await).unwrap_err();
    assert!(held.cancelled().is_cancelled());
    assert!(peers.bind("100.64.0.2", 22, local(6002)).is_err());
    for bad in [
        node(2, "unqualified", 2, &a),
        json!({"ID":2,"Name":"saved.tail-okou.ts.net.","Key":a.public.to_string(),"Addresses":["100.64.0.2/32","fd7a:115c:a1e0::2/128"]}),
    ] {
        let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
        assert!(peers.update(update(json!({"Peers":[bad]})).await).is_err());
    }
}

#[tokio::test]
async fn withdrawal_reassignment_and_cross_owner_bindings_cannot_redirect_old_tcp() {
    let keys = NodeKeyPair::random();
    let a = NodeKeyPair::random();
    let b = NodeKeyPair::random();
    let own_node = own(&keys).await;
    let mut peers = Peers::new(keys.clone(), own_node.clone()).unwrap();
    let initial = json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&a)]});
    peers.update(update(initial.clone()).await).unwrap();
    let old = peers.bind("saved", 22, local(6001)).unwrap();
    let mut other = Peers::new(keys, own_node).unwrap();
    other.update(update(initial).await).unwrap();
    assert!(
        other
            .outgoing(&old, vec![wire::syn(local(6001), remote(2))])
            .is_err()
    );
    peers
        .update(update(json!({"PeersRemoved":[2]})).await)
        .unwrap();
    assert!(old.cancelled().is_cancelled());
    peers
        .update(
            update(json!({"PeersChanged":[node(3,"replacement.tail-okou.ts.net.",2,&b)]})).await,
        )
        .unwrap();
    assert!(
        peers
            .outgoing(&old, vec![wire::syn(local(6001), remote(2))])
            .is_err()
    );
    // The retired owner continues to reserve its tuple until its physical owner drops.
    assert!(peers.bind("100.64.0.2", 22, local(6001)).is_err());
    drop(old);
    let fresh = peers.bind("100.64.0.2", 22, local(6001)).unwrap();
    assert!(!fresh.cancelled().is_cancelled());
}

#[tokio::test]
async fn netmap_overlapping_deltas_preserve_original_encrypted_tcp() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let obsolete = NodeKeyPair::random();
        let mut current = node_with_key(3, "b.tail-okou.ts.net.", 3, fixture.b_key);
        current["KeyExpiry"] = json!("2000-01-01T00:00:00Z");
        fixture
            .peers
            .update(
                update(json!({
                    "PeersRemoved": [3, 3, 999, 999],
                    "PeersChanged": [
                        node(3, "obsolete.tail-okou.ts.net.", 4, &obsolete),
                        current
                    ],
                    "OnlineChange": {"3": true},
                    "PeersChangedPatch": [{
                        "NodeID": 3,
                        "KeyExpiry": "0001-01-01T00:00:00Z"
                    }]
                }))
                .await,
            )
            .unwrap();
        assert!(fixture.peers.bind("obsolete", 22, local(6010)).is_err());
        assert!(fixture.peers.bind("100.64.0.4", 22, local(6010)).is_err());
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn netmap_absent_peer_patches_do_not_restore_routes_or_interrupt_other_tcp() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let old_a = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .update(
                update(json!({
                    "PeersRemoved": [2],
                    "OnlineChange": {"2": true, "999": true},
                    "PeerSeenChange": {"2": true, "999": true},
                    "PeersChangedPatch": [
                        {"NodeID": 2, "KeyExpiry": "0001-01-01T00:00:00Z"},
                        {"NodeID": 999, "Key": fixture.b_key.to_string()}
                    ]
                }))
                .await,
            )
            .unwrap();
        assert!(old_a.cancelled().is_cancelled());
        assert!(fixture.peers.bind("100.64.0.2", 22, local(6010)).is_err());
        assert!(fixture.peers.bind("100.64.0.99", 22, local(6010)).is_err());
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn inventory_and_policy_accumulation_fail_closed() {
    let keys = NodeKeyPair::random();
    let a = NodeKeyPair::random();
    let full = (0..257)
        .map(|i| node(i + 2, &format!("peer-{i}.tail-okou.ts.net."), 2, &a))
        .collect::<Vec<_>>();
    assert_rejected_map(json!({"Peers":full})).await;
    let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
    let rules = json!([{"SrcIPs":["100.64.0.2/32"],"IPProto":[6],"DstPorts":[{"IP":"100.64.0.1/32","Ports":{"First":6001,"Last":6001}}]}]);
    for i in 0..256 {
        let name = format!("synthetic-{i}");
        let named = serde_json::Map::from_iter([(name, rules.clone())]);
        peers
            .update(update(json!({"PacketFilters":named})).await)
            .unwrap();
    }
    assert!(
        peers
            .update(update(json!({"PacketFilters":{"extra":rules}})).await)
            .is_err()
    );
    assert!(peers.bind("100.64.0.2", 22, local(6001)).is_err());
}

#[tokio::test]
async fn key_rotation_discards_actual_sdk_queued_syn_and_preserves_original_other_tcp() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let mut a_stack = Stack::new(peer_ip(1));
        let channel = a_stack.channel();
        let pending =
            tokio::spawn(async move { channel.tcp_connect(local(6001), remote(2)).await });
        let a = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .endpoint(
                &a,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let mut syn = None;
        for _ in 0..100 {
            a_stack.poll(1);
            if let Some(bytes) = a_stack.device.outgoing.pop_front() {
                syn = Some(PacketMut::from(bytes.as_slice()));
                break;
            }
            tokio::task::yield_now().await;
        }
        let handshake = fixture
            .peers
            .outgoing(&a, vec![syn.expect("actual public SDK SYN")])
            .unwrap();
        assert!(!handshake.is_empty());
        let late = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        let rotated = NodeKeyPair::random();
        fixture
            .peers
            .update(
                update(
                    json!({"PeersChangedPatch":[{"NodeID":2,"Key":rotated.public.to_string()}]}),
                )
                .await,
            )
            .unwrap();
        assert!(a.cancelled().is_cancelled());
        let (out, delivered) = fixture.peers.incoming(late).unwrap();
        assert!(delivered.is_empty());
        assert!(
            fixture
                .a
                .decrypt(wire::routed(&mut fixture.peers, out))
                .is_empty(),
            "old queued A SYN never flushes under an old handshake"
        );
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        drop(a_stack);
        drop(a);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn dropping_a_queued_binding_discards_crypto_before_late_handshake() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let binding = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .endpoint(
                &binding,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let handshake = fixture
            .peers
            .outgoing(&binding, vec![wire::syn(local(6001), remote(2))])
            .unwrap();
        let late = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        let cancelled = binding.cancelled();
        drop(binding);
        assert!(cancelled.is_cancelled());
        let (out, delivered) = fixture.peers.incoming(late).unwrap();
        assert!(delivered.is_empty());
        assert!(
            fixture
                .a
                .decrypt(wire::routed(&mut fixture.peers, out))
                .is_empty()
        );
    })
    .await;
}

#[tokio::test]
async fn already_encrypted_a_frames_are_cut_off_while_original_b_tcp_continues() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let a = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .endpoint(
                &a,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let handshake = fixture
            .peers
            .outgoing(&a, vec![wire::syn(local(6001), remote(2))])
            .unwrap();
        let answer = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        let (mut held, delivered) = fixture.peers.incoming(answer).unwrap();
        assert!(delivered.is_empty());
        assert!(
            !held.is_empty(),
            "actual SDK encrypted queued SYN is retained before transport IO"
        );
        assert!(
            !fixture
                .peers
                .try_emit(&mut held, |_, _, _| Err(
                    std::io::ErrorKind::WouldBlock.into()
                ))
                .unwrap()
        );
        assert!(
            !held.is_empty(),
            "blocked writer retains frames and capacity"
        );
        fixture
            .peers
            .update(update(json!({"PeersRemoved":[2]})).await)
            .unwrap();
        assert!(
            fixture
                .peers
                .try_emit(&mut held, |_, _, _| panic!(
                    "retired ciphertext reached actual writer"
                ))
                .is_err()
        );
        assert!(held.is_empty());
        drop(a);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn held_decrypted_bytes_are_readmitted_before_the_connection_device() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let mut original = fixture.connect_b().await;
        let received = fixture.hold_b_delivery(&mut original.1).await;
        assert!(
            !received.is_empty(),
            "actual SDK decrypted bytes await delivery"
        );
        fixture
            .peers
            .update(update(json!({"PeersRemoved":[3]})).await)
            .unwrap();
        assert_eq!(
            fixture
                .peers
                .deliver(received, |_, _| panic!(
                    "retired plaintext reached connection device"
                ))
                .unwrap(),
            0
        );
        drop(original);
    })
    .await;
}

#[tokio::test]
async fn ciphertext_capacity_stays_reserved_until_retained_frames_drop() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original = fixture.connect_b().await;
        let mut packets = Vec::new();
        for _ in 0..64 {
            packets.push(wire::syn(local(6002), remote(3)));
        }
        let held = fixture.peers.outgoing(&fixture.binding, packets).unwrap();
        assert!(!held.is_empty());
        assert!(matches!(
            fixture
                .peers
                .outgoing(&fixture.binding, vec![wire::syn(local(6002), remote(3))]),
            Err(Failure::ResourceExhausted)
        ));
        drop(held);
        let mut fresh = fixture
            .peers
            .outgoing(&fixture.binding, vec![wire::syn(local(6002), remote(3))])
            .unwrap();
        assert!(
            fixture
                .peers
                .try_emit(&mut fresh, |_, _, _| Ok(()))
                .unwrap()
        );
        drop(original);
    })
    .await;
}

#[tokio::test]
async fn public_sdk_map_io_rejects_max_length_and_joins_actual_cache_owner() {
    use crate::{
        tailscale::tests::fixture::Cache,
        tailscale::{Control, Key, Work},
    };
    use runner_types::ids::RunId;
    use ts_http_util::{BytesBody, Client, Request, ResponseExt};
    let http = super::fixture::Http::new(u32::MAX.to_le_bytes().to_vec()).await;
    let address = http.address;
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let socket = tokio::net::TcpStream::connect(address)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let client = ts_http_util::http2::connect::<BytesBody>(socket)
                .await
                .map_err(|_| Failure::DomainFailed)?;
            control.ready();
            let response = client
                .send(
                    Request::builder()
                        .uri(format!(
                            "http://{address}/native-registration-qualification"
                        ))
                        .body(BytesBody::default())
                        .unwrap(),
                )
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let mut stream = Box::pin(ts_control::client::map_stream(MapReader::new(
                response.into_read(),
            )));
            assert!(stream.next().await.is_none());
            drop(stream);
            drop(client);
            Ok(())
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
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
    bounded(node.ready()).await.unwrap();
    http.requested().await;
    http.reply();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    http.finish().await;
}

#[tokio::test]
async fn retired_native_bridge_cuts_buffered_bytes_and_remains_common_ssh_io() {
    inside(|control| async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        fn common_io<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin>(_: &T) {}
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let (mut client, mut server, listener) = fixture.connect_b().await;
        common_io(&client);
        fixture.buffer_b_bridge(&mut client, &mut server).await;
        fixture
            .peers
            .update(update(json!({"PeersRemoved":[3]})).await)
            .unwrap();
        let mut bytes = [0; 64];
        assert_eq!(
            bounded(client.read(&mut bytes)).await.unwrap_err().kind(),
            std::io::ErrorKind::ConnectionAborted
        );
        assert_eq!(bytes, [0; 64], "retired bridge never fills caller memory");
        assert_eq!(
            bounded(client.write(b"no operation replay"))
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::ConnectionAborted
        );
        fixture.retire_b();
        drop((client, server, listener));
    })
    .await;
}

#[tokio::test]
async fn retained_liveness_observer_does_not_reserve_a_physically_closed_tcp_tuple() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let (client, server, listener) = fixture.connect_b().await;
        let observer = client.guard();
        assert!(observer.is_live());
        let retirement = observer.retired();
        tokio::pin!(retirement);
        assert!(futures_util::poll!(retirement.as_mut()).is_pending());
        let local = fixture.binding.local();
        fixture.retire_b();
        assert!(!observer.is_live());
        bounded(retirement).await;
        drop((client, server, listener));
        let mut peers = fixture.into_peers();
        let replacement = peers.bind("100.64.0.3", 22, local);
        assert!(
            replacement.is_ok(),
            "metadata-only liveness must not reserve the closed TCP tuple"
        );
        assert!(
            !observer.is_live(),
            "old observation cannot adopt a new tuple"
        );
    })
    .await;
}

#[tokio::test]
async fn a_full_pending_bridge_write_is_cancelled_without_adopting_or_replaying_it() {
    inside(|control| async move {
        use tokio::io::AsyncWriteExt;
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let (mut client, server, listener) = fixture.connect_b().await;
        let bytes = vec![7; 128 * 1024];
        let mut write = Box::pin(client.write_all(&bytes));
        let mut cx = std::task::Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(
            write.as_mut().poll(&mut cx).is_pending(),
            "bounded duplex actually fills before native pumping"
        );
        fixture
            .peers
            .update(update(json!({"PeersRemoved":[3]})).await)
            .unwrap();
        assert_eq!(
            bounded(write).await.unwrap_err().kind(),
            std::io::ErrorKind::ConnectionAborted
        );
        fixture.retire_b();
        drop((client, server, listener));
    })
    .await;
}

#[tokio::test]
async fn pending_private_netstacks_reserve_all_twenty_four_tuples_until_physical_drop() {
    inside(|control| async move {
        use crate::tailscale::tcp::Connection;
        let keys = NodeKeyPair::random();
        let a = NodeKeyPair::random();
        let b = NodeKeyPair::random();
        let mut peers = fixture_peers(&keys, &a, &b).await;
        let mut owners = Vec::new();
        let mut cancellation = Vec::new();
        let capacity = Arc::new(tokio::sync::Semaphore::new(1));
        let mut cx = std::task::Context::from_waker(futures_util::task::noop_waker_ref());
        for i in 0..24 {
            let binding = peers.bind("100.64.0.2", 22, local(6100 + i)).unwrap();
            cancellation.push(binding.cancelled());
            let lease = (i == 0).then(|| {
                super::super::Lease::new(Arc::new(
                    Arc::clone(&capacity).try_acquire_owned().unwrap(),
                ))
            });
            let mut owner = Connection::new(binding, lease).unwrap();
            assert!(owner.poll(&mut cx).unwrap().is_none());
            assert!(
                owner.poll(&mut cx).unwrap().is_none(),
                "actual SDK connect awaits absent peer"
            );
            owners.push(owner);
        }
        control.ready();
        assert_eq!(capacity.available_permits(), 0);
        assert!(matches!(
            peers.bind("100.64.0.2", 22, local(6199)),
            Err(Failure::ResourceExhausted)
        ));
        cancellation[0].cancel();
        assert_eq!(
            capacity.available_permits(),
            0,
            "cancelling a caller does not destroy owned SDK work"
        );
        assert!(matches!(owners[0].poll(&mut cx), Err(Failure::Cancelled)));
        assert_eq!(
            capacity.available_permits(),
            1,
            "opaque caller capacity is released after actual SDK retirement"
        );
        assert!(
            matches!(
                peers.bind("100.64.0.2", 22, local(6199)),
                Err(Failure::ResourceExhausted)
            ),
            "retiring owner still reserves physical capacity"
        );
        drop(owners.remove(0));
        let fresh = peers.bind("100.64.0.2", 22, local(6100)).unwrap();
        assert!(!fresh.cancelled().is_cancelled());
        drop(fresh);
        drop(owners);
        assert!(cancellation.iter().all(|token| token.is_cancelled()));
    })
    .await;
}

#[tokio::test]
async fn map_guard_handles_fragmented_lengths_and_keeps_exact_frame_boundaries() {
    use tokio::io::AsyncWriteExt;
    let (input, mut writer) = tokio::io::duplex(8);
    let task = tokio::spawn(async move {
        let stream = ts_control::client::map_stream(MapReader::new(input));
        futures_util::pin_mut!(stream);
        for _ in 0..2 {
            assert!(stream.next().await.is_some());
        }
        assert!(stream.next().await.is_none());
    });
    for _ in 0..2 {
        for byte in [2, 0, 0, 0, b'{', b'}'] {
            writer.write_all(&[byte]).await.unwrap();
        }
    }
    writer.shutdown().await.unwrap();
    bounded(task).await.unwrap();
}

#[tokio::test]
async fn individually_bounded_map_deltas_cannot_accumulate_unbounded_inventory_or_policy() {
    let keys = NodeKeyPair::random();
    let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
    let mut stopped = false;
    for i in 0u8..200 {
        let peer_keys = NodeKeyPair::random();
        let mut heavy = node(
            i64::from(i) + 4,
            &format!("peer-{i}.tail-okou.ts.net."),
            i + 3,
            &peer_keys,
        );
        heavy["Tags"] = json!(vec!["t".repeat(256); 64]);
        heavy["AllowedIPs"] = json!(
            (0..256)
                .map(|n| format!("10.20.0.{n}/32"))
                .collect::<Vec<_>>()
        );
        heavy["CapMap"] = json!({"synthetic": vec!["v".repeat(248); 32]});
        let delta = update(json!({"PeersChanged":[heavy]})).await;
        if peers.update(delta).is_err() {
            assert!(
                i > 1 && i < 199,
                "aggregate inventory cap precedes the peer-count cap"
            );
            stopped = true;
            break;
        }
    }
    assert!(
        stopped,
        "retained metadata capacity is bounded across separate map responses"
    );
    assert!(peers.bind("100.64.0.3", 22, local(6001)).is_err());

    let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
    let caps = (0..64)
        .map(|i| format!("cap:{i:02}{}", "c".repeat(246)))
        .collect::<Vec<_>>();
    let rules = json!([{"SrcIPs":caps,"IPProto":[6],"DstPorts":[{"IP":"100.64.0.1/32","Ports":{"First":6001,"Last":6001}}]}]);
    let mut stopped = false;
    for i in 0..100 {
        let named = serde_json::Map::from_iter([(format!("synthetic-{i}"), rules.clone())]);
        if peers
            .update(update(json!({"PacketFilters":named})).await)
            .is_err()
        {
            assert!(
                i > 1 && i < 99,
                "aggregate policy cap precedes ruleset/rule-count caps"
            );
            stopped = true;
            break;
        }
    }
    assert!(
        stopped,
        "retained policy capacity is bounded across separate map responses"
    );
}

#[tokio::test]
async fn an_authenticated_zero_expiry_patch_restores_peer_crypto_and_preserves_other_tcp() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        fixture
            .peers
            .update(
                update(
                    json!({"PeersChangedPatch":[{"NodeID":2,"KeyExpiry":"2000-01-01T00:00:00Z"}]}),
                )
                .await,
            )
            .unwrap();
        assert!(fixture.peers.bind("100.64.0.2", 22, local(6001)).is_err());
        fixture
            .peers
            .update(
                update(
                    json!({"PeersChangedPatch":[{"NodeID":2,"KeyExpiry":"0001-01-01T00:00:00Z"}]}),
                )
                .await,
            )
            .unwrap();
        let binding = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .endpoint(
                &binding,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let syn = wire::syn(local(6001), remote(2));
        let expected = syn.as_ref().to_vec();
        let handshake = fixture.peers.outgoing(&binding, vec![syn]).unwrap();
        let answer = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        let (frames, _) = fixture.peers.incoming(answer).unwrap();
        let plaintext = fixture.a.decrypt(wire::routed(&mut fixture.peers, frames));
        assert_eq!(plaintext.len(), 1);
        assert_eq!(plaintext[0].as_ref(), expected);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn natural_peer_key_expiry_cuts_old_crypto_and_wakes_its_binding_only() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let expiry = (chrono::Utc::now() + chrono::Duration::milliseconds(150)).to_rfc3339();
        fixture
            .peers
            .update(update(json!({"PeersChangedPatch":[{"NodeID":2,"KeyExpiry":expiry}]})).await)
            .unwrap();
        let binding = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        fixture
            .peers
            .endpoint(
                &binding,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let handshake = fixture
            .peers
            .outgoing(&binding, vec![wire::syn(local(6001), remote(2))])
            .unwrap();
        let late = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let events = fixture.peers.events().unwrap();
        drop(events);
        assert!(
            binding.cancelled().is_cancelled(),
            "expired key wakes its actual connection cancellation"
        );
        assert!(fixture.peers.bind("100.64.0.2", 22, local(6003)).is_err());
        let (out, delivered) = fixture.peers.incoming(late).unwrap();
        assert!(delivered.is_empty());
        assert!(
            fixture
                .a
                .decrypt(wire::routed(&mut fixture.peers, out))
                .is_empty()
        );
        drop(binding);
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

pub(super) async fn fixture_peers(keys: &NodeKeyPair, a: &NodeKeyPair, b: &NodeKeyPair) -> Peers {
    let mut peers = Peers::new(keys.clone(), own(keys).await).unwrap();
    // An SSH client needs no blanket inbound ephemeral-port grant. The
    // production adapter must admit only replies to its initiated exact tuples.
    peers.update(update(json!({"Peers":[node(2,"a.tail-okou.ts.net.",2,a),node(3,"b.tail-okou.ts.net.",3,b)],"PacketFilter":[]})).await).unwrap();
    peers
}

async fn inside<F, Fut>(work: F)
where
    F: FnOnce(super::Control) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + 'static,
{
    use crate::{
        tailscale::tests::fixture::Cache,
        tailscale::{Key, Work},
    };
    let cache = Cache::new();
    let run = cache.register(runner_types::ids::RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let (completed, observed) = tokio::sync::oneshot::channel();
    let (finish, finishing) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control| {
        Box::pin(async move {
            tokio::task::LocalSet::new().run_until(work(control)).await;
            let _ = completed.send(());
            // A fast fixture must keep the actual root alive until its caller
            // adopts readiness and observes all assertions. Production rightly
            // refuses late adoption after an already-finished runtime.
            let _ = finishing.await;
            Ok(())
        })
    });
    let node = access
        .native_node(
            Key {
                configuration: uuid::Uuid::new_v4(),
                generation: 1,
            },
            work,
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    bounded(observed).await.unwrap();
    finish.send(()).unwrap();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
}

#[tokio::test]
async fn native_reply_admission_never_widens_the_authenticated_reverse_tcp_tuple() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        for (source, source_port, destination_port) in [(3, 23, 6002), (3, 22, 6003), (2, 22, 6002)]
        {
            let received = fixture.unexpected_b_packet(source, source_port, destination_port);
            assert!(
                received.is_empty(),
                "wrong authenticated peer/source port/local port is never delivered"
            );
        }
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}

#[tokio::test]
async fn retiring_a_private_stack_preserves_shared_peer_crypto_without_replaying_original_b() {
    inside(|control| async move {
        use crate::tailscale::tcp::Connection;
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let a = fixture.peers.bind("100.64.0.3", 22, local(6001)).unwrap();
        let mut owner = Connection::new(Arc::clone(&a), None).unwrap();
        let mut cx = std::task::Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(owner.poll(&mut cx).unwrap().is_none());
        assert!(owner.poll(&mut cx).unwrap().is_none());
        let packets = owner.outgoing().unwrap();
        assert!(
            !packets.is_empty(),
            "actual second private SDK stack has queued its SYN"
        );
        let mut held = fixture.peers.outgoing(&a, packets).unwrap();
        assert!(
            !held.is_empty(),
            "same established peer crypto encrypted the second connection's SYN"
        );
        a.cancelled().cancel();
        assert!(matches!(owner.poll(&mut cx), Err(Failure::Cancelled)));
        assert!(
            fixture
                .peers
                .try_emit(&mut held, |_, _, _| panic!(
                    "retired same-peer A frame reached writer"
                ))
                .is_err()
        );
        assert!(
            !fixture.binding.cancelled().is_cancelled(),
            "other same-peer B binding remains live"
        );
        drop(owner);
        drop(a);
        assert!(
            !fixture.unexpected_b_packet(3, 22, 6002).is_empty(),
            "original peer session still decrypts inbound bytes before any survivor send or handshake"
        );
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}
