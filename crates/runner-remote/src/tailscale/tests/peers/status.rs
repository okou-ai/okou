//! Status receipt provenance through the actual public SDK map and binding path.

use super::*;
use crate::tailscale::evidence::Trace;

fn captured(binding: &Arc<crate::tailscale::peers::Binding>) -> Value {
    serde_json::to_value(binding.trace().snapshot().unwrap()).unwrap()["peer"].clone()
}

#[tokio::test]
async fn status_receipt_survives_unrelated_maps_and_cached_binding_but_target_assertions_refresh_it()
 {
    let root = Trace::new(true);
    let keys = NodeKeyPair::random();
    let local_node = own(&keys).await;
    let mut peers = root.sync(|| Peers::new(keys, local_node)).unwrap();
    let a = NodeKeyPair::random();
    let b = NodeKeyPair::random();
    peers.update(update(json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&a),node(3,"other.tail-okou.ts.net.",3,&b)]})).await).unwrap();
    let binding = Trace::new(true)
        .sync(|| peers.bind("100.64.0.2", 8022, local(6101)))
        .unwrap();
    let frozen = binding.trace().snapshot().unwrap();
    let initial = captured(&binding);
    assert_eq!(initial["status"], "online");
    assert!(initial["observed_at"].is_string());
    assert!(initial["status_received_at"].is_string());

    for value in [
        json!({}),
        json!({"OnlineChange":{"3":false}}),
        json!({"PeersChangedPatch":[{"NodeID":2,"DERPRegion":20}]}),
    ] {
        peers.update(update(value).await).unwrap();
        assert_eq!(
            captured(&binding)["status_received_at"],
            initial["status_received_at"]
        );
    }
    let cached = Trace::new(true)
        .sync(|| peers.bind("100.64.0.2", 8022, local(6102)))
        .unwrap();
    assert_eq!(
        captured(&cached)["status_received_at"],
        initial["status_received_at"]
    );

    // The provider can reconfirm the same state; this is a genuine receipt even
    // though the state value itself did not transition.
    peers
        .update(update(json!({"OnlineChange":{"2":true}})).await)
        .unwrap();
    let reconfirmed = captured(&binding);
    assert_eq!(reconfirmed["status"], "online");
    assert_ne!(
        reconfirmed["status_received_at"],
        initial["status_received_at"]
    );
    assert_eq!(
        captured(&cached)["status_received_at"],
        reconfirmed["status_received_at"]
    );
    peers
        .update(update(json!({"OnlineChange":{"2":false}})).await)
        .unwrap();
    let offline = captured(&binding);
    assert_eq!(offline["status"], "offline");
    assert_ne!(
        offline["status_received_at"],
        reconfirmed["status_received_at"]
    );
    assert!(offline["local_last_seen_estimate"].is_string());
    assert_eq!(serde_json::to_value(frozen).unwrap()["peer"], initial);

    peers
        .update(update(json!({"PeersChanged":[node(2,"saved.tail-okou.ts.net.",2,&a)]})).await)
        .unwrap();
    let upserted = captured(&binding);
    assert_eq!(upserted["status"], "online");
    assert_ne!(
        upserted["status_received_at"],
        offline["status_received_at"]
    );

    peers.update(update(json!({"Peers":[node(2,"saved.tail-okou.ts.net.",2,&a),node(3,"other.tail-okou.ts.net.",3,&b)]})).await).unwrap();
    let repeated_full = captured(&binding);
    assert_eq!(repeated_full["status"], "online");
    assert_ne!(
        repeated_full["status_received_at"],
        upserted["status_received_at"]
    );
}

#[tokio::test]
async fn unasserted_status_has_no_invented_receipt_and_disabled_collection_stays_absent() {
    for enabled in [false, true] {
        let root = Trace::new(enabled);
        let keys = NodeKeyPair::random();
        let local_node = own(&keys).await;
        let mut peers = root.sync(|| Peers::new(keys, local_node)).unwrap();
        let a = NodeKeyPair::random();
        let mut unknown = node(2, "saved.tail-okou.ts.net.", 2, &a);
        unknown.as_object_mut().unwrap().remove("Online");
        peers
            .update(update(json!({"Peers":[unknown]})).await)
            .unwrap();
        let binding = Trace::new(enabled)
            .sync(|| peers.bind("100.64.0.2", 8022, local(6103)))
            .unwrap();
        if enabled {
            let status = captured(&binding);
            assert_eq!(status["status"], "unknown");
            assert!(status.get("status_received_at").is_none());
            peers.update(update(json!({})).await).unwrap();
            assert!(captured(&binding).get("status_received_at").is_none());
        } else {
            assert!(binding.trace().snapshot().is_none());
        }
    }
}
