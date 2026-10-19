//! Retirement preserves established sessions but never flushes cancelled SYNs.
use super::*;

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
