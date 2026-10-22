//! Retirement preserves established sessions but never flushes cancelled SYNs.
use super::*;

#[tokio::test]
async fn inactive_peer_input_preserves_capacity_and_a_later_authorized_handshake() {
    inside(|control| async move {
        control.ready();
        for retired in [false, true] {
            let keys = NodeKeyPair::random();
            let peer = NodeKeyPair::random();
            let mut peers = Peers::new(keys.clone(), own(&keys).await).unwrap();
            peers
                .update(update(json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&peer)]})).await)
                .unwrap();
            if retired {
                let binding = peers.bind("100.64.0.2", 22, local(6001)).unwrap();
                peers
                    .endpoint(
                        &binding,
                        UnderlayTransportId(1),
                        DynEndpoint::derp(peer.public),
                    )
                    .unwrap();
                drop(binding);
            }
            assert!(
                peers
                    .incoming_derp(peer.public, wire::initiation(peer.clone(), keys.public))
                    .unwrap()
                    .is_none()
            );
            assert!(peers.writable());

            let binding = peers.bind("100.64.0.2", 22, local(6001)).unwrap();
            peers
                .endpoint(
                    &binding,
                    UnderlayTransportId(1),
                    DynEndpoint::derp(peer.public),
                )
                .unwrap();
            let syn = wire::syn(local(6001), remote(2));
            let mut frames = peers.outgoing(&binding, vec![syn.clone()]).unwrap();
            let packet = peers.prepare_derp(&mut frames).unwrap().unwrap();
            assert!(packet.stamp.current());
            assert_eq!(packet.destination, peer.public);
            let bytes = packet.bytes.clone();
            drop(packet);
            let mut external = ts_tunnel::Endpoint::new(peer.clone());
            let id = ts_tunnel::PeerId(1);
            external.upsert_peer(ts_tunnel::PeerConfig::new(id, keys.public, [0; 32]));
            let mut response = external.recv(std::time::Instant::now(), vec![bytes]);
            let mut reply = response.to_peers.remove(&id).unwrap();
            assert_eq!(reply.len(), 1);
            let (mut frames, received) = peers
                .incoming_derp(peer.public, reply.remove(0))
                .unwrap()
                .unwrap();
            assert!(received.is_empty());
            let mut decrypted = Vec::new();
            while let Some(packet) = peers.prepare_derp(&mut frames).unwrap() {
                let result = external.recv(std::time::Instant::now(), vec![packet.bytes]);
                decrypted.extend(result.to_local.into_values().flatten());
            }
            assert_eq!(decrypted.len(), 1);
            // The raw WireGuard endpoint retains padding; the IP data plane
            // trims it to the authenticated packet's declared total length.
            let length = decrypted[0].get_ip_len().unwrap();
            assert_eq!(length, syn.len());
            assert_eq!(&decrypted[0].as_ref()[..length], syn.as_ref());
            assert!(peers.writable());
        }
    })
    .await;
}

#[tokio::test]
async fn last_binding_retirement_removes_the_sdk_handshake_response_route() {
    inside(|control| async move {
        let (keys, peer, mut peers, binding, output) = relay::packets().await;
        control.ready();
        drop(output);
        drop(binding);
        peers.maintain().unwrap();
        // Exercise the SDK boundary directly so ingress rejection alone cannot
        // hide a retained underlay route or crypto timer output.
        let (frames, received) = peers
            .incoming(vec![wire::initiation(peer, keys.public)])
            .unwrap();
        assert!(frames.is_empty());
        assert!(received.is_empty());
        assert!(peers.events().unwrap().is_empty());
        assert!(peers.writable());
    })
    .await;
}

#[tokio::test]
async fn a_live_same_peer_sibling_still_owns_derp_handshake_responses_after_retirement() {
    inside(|control| async move {
        let (keys, peer, mut peers, survivor, output) = relay::packets().await;
        control.ready();
        drop(output);
        let unused = peers.bind("100.64.0.2", 22, local(6003)).unwrap();
        drop(unused);
        let (mut frames, received) = peers
            .incoming_derp(peer.public, wire::initiation(peer.clone(), keys.public))
            .unwrap()
            .unwrap();
        assert!(received.is_empty());
        let packet = peers.prepare_derp(&mut frames).unwrap().unwrap();
        assert_eq!(packet.destination, peer.public);
        assert_eq!(&packet.bytes.as_ref()[..4], &[2, 0, 0, 0]);
        assert!(packet.stamp.current());
        assert!(survivor.live());
        drop(packet);
        assert!(peers.prepare_derp(&mut frames).unwrap().is_none());
        assert!(peers.writable());
    })
    .await;
}

#[tokio::test]
async fn queued_binding_retirement_purges_plaintext_even_with_a_live_same_peer_sibling() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let cancelled = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        let survivor = fixture.peers.bind("100.64.0.2", 22, local(6003)).unwrap();
        fixture
            .peers
            .endpoint(
                &cancelled,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let handshake = fixture
            .peers
            .outgoing(&cancelled, vec![wire::syn(local(6001), remote(2))])
            .unwrap();
        let queued = fixture
            .peers
            .outgoing(&survivor, vec![wire::syn(local(6003), remote(2))])
            .unwrap();
        assert!(queued.is_empty(), "same handshake holds both SYNs");
        drop(queued);
        let late = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        drop(cancelled);
        let (out, delivered) = fixture.peers.incoming(late).unwrap();
        assert!(delivered.is_empty());
        assert!(
            fixture
                .a
                .decrypt(wire::routed(&mut fixture.peers, out))
                .is_empty(),
            "a live sibling cannot authorize replay of the cancelled SYN"
        );
        assert!(survivor.live());
        let syn = wire::syn(local(6003), remote(2));
        let fresh = fixture
            .peers
            .outgoing(&survivor, vec![syn.clone()])
            .unwrap();
        let reply = fixture.a.answer(wire::routed(&mut fixture.peers, fresh));
        let (out, delivered) = fixture.peers.incoming(reply).unwrap();
        assert!(delivered.is_empty());
        let decrypted = fixture.a.decrypt(wire::routed(&mut fixture.peers, out));
        assert_eq!(decrypted.len(), 1, "only the survivor's fresh SYN");
        assert_eq!(decrypted[0].as_ref(), syn.as_ref());
    })
    .await;
}

#[tokio::test]
async fn unused_sibling_retirement_preserves_the_live_bindings_pending_handshake() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let survivor = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        let unused = fixture.peers.bind("100.64.0.2", 22, local(6003)).unwrap();
        fixture
            .peers
            .endpoint(
                &survivor,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let syn = wire::syn(local(6001), remote(2));
        let handshake = fixture
            .peers
            .outgoing(&survivor, vec![syn.clone()])
            .unwrap();
        let reply = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        drop(unused);
        let (out, delivered) = fixture.peers.incoming(reply).unwrap();
        assert!(delivered.is_empty());
        let decrypted = fixture.a.decrypt(wire::routed(&mut fixture.peers, out));
        assert_eq!(
            decrypted.len(),
            1,
            "unrelated retirement keeps the queued SYN"
        );
        assert_eq!(decrypted[0].as_ref(), syn.as_ref());
    })
    .await;
}

#[tokio::test]
async fn ambiguous_underlay_output_cannot_clear_another_peers_cancelled_plaintext() {
    inside(|control| async move {
        let mut fixture = wire::Fixture::new().await;
        control.ready();
        let original_b = fixture.connect_b().await;
        let cancelled = fixture.peers.bind("100.64.0.2", 22, local(6001)).unwrap();
        let survivor = fixture.peers.bind("100.64.0.2", 22, local(6003)).unwrap();
        fixture
            .peers
            .endpoint(
                &cancelled,
                UnderlayTransportId(1),
                DynEndpoint::udp(fixture.a.socket.local_addr().unwrap()),
            )
            .unwrap();
        let handshake = fixture
            .peers
            .outgoing(&cancelled, vec![wire::syn(local(6001), remote(2))])
            .unwrap();
        let late = fixture
            .a
            .answer(wire::routed(&mut fixture.peers, handshake));
        // Two peers now share an underlay address. B's encrypted output cannot
        // prove that A's still-pending plaintext queue has been drained.
        fixture.share_b_endpoint(&cancelled);
        let encrypted_b = fixture
            .peers
            .outgoing(&fixture.binding, vec![wire::syn(local(6002), remote(3))])
            .unwrap();
        assert!(!encrypted_b.is_empty());
        drop(encrypted_b);
        drop(cancelled);
        let (out, delivered) = fixture.peers.incoming(late).unwrap();
        assert!(delivered.is_empty());
        assert!(
            fixture
                .a
                .decrypt(wire::routed(&mut fixture.peers, out))
                .is_empty(),
            "ambiguous output never authorizes cancelled A plaintext"
        );
        assert!(survivor.live());
        fixture.transfer_b(original_b, 65_536).await;
    })
    .await;
}
