use super::*;
use crate::tailscale::peers::Peers;
use futures_util::StreamExt;
use serde_json::json;
use ts_keys::NodeKeyPair;
use ts_netstack_smoltcp_core::smoltcp::phy::{Device as _, TxToken as _};

async fn connection() -> (Peers, Connection) {
    let keys = NodeKeyPair::random();
    let peer = NodeKeyPair::random();
    let node = |id: u8, key: &NodeKeyPair| {
        json!({
            "ID": id,
            "StableID": format!("synthetic-node-{id}"),
            "Name": format!("node-{id}.tail-okou.ts.net."),
            "Key": key.public.to_string(),
            "KeyExpiry": "0001-01-01T00:00:00Z",
            "Addresses": [format!("100.64.0.{id}/32"), format!("fd7a:115c:a1e0::{id}/128")],
            "Online": true,
        })
    };
    let json = serde_json::to_vec(&json!({
        "Node": node(1, &keys),
        "Peers": [node(2, &peer)],
    }))
    .unwrap();
    let mut wire = (json.len() as u32).to_le_bytes().to_vec();
    wire.extend(json);
    let updates = ts_control::client::map_stream(std::io::Cursor::new(wire));
    futures_util::pin_mut!(updates);
    let mut update = updates.next().await.unwrap();
    let mut peers = Peers::new(keys, update.node.take().unwrap()).unwrap();
    peers.update(update).unwrap();
    let binding = peers
        .bind("100.64.0.2", 22, "100.64.0.1:6001".parse().unwrap())
        .unwrap();
    let connection = Connection::new(binding, None).unwrap();
    (peers, connection)
}

#[tokio::test]
async fn outgoing_preserves_transmit_buffers_and_restores_queue_capacity() {
    let (_peers, mut connection) = connection().await;
    let now = smoltcp::time::Instant::from_millis(0);
    let mut expected = Vec::new();
    for index in 0..FRAME_CAPACITY {
        let length = if index % 2 == 0 { 40 + index } else { MTU };
        let returned = format!("frame-{index}");
        let (address, returned) =
            connection
                .device
                .transmit(now)
                .unwrap()
                .consume(length, |bytes| {
                    assert_eq!(bytes.len(), length);
                    assert!(bytes.iter().all(|byte| *byte == 0));
                    bytes.fill(index as u8);
                    (bytes.as_ptr(), returned)
                });
        assert_eq!(returned, format!("frame-{index}"));
        expected.push((address, length, index as u8));
    }
    assert!(connection.device.transmit(now).is_none());

    let packets = connection.outgoing().unwrap();
    assert_eq!(packets.len(), expected.len());
    for (packet, (address, length, value)) in packets.iter().zip(expected) {
        assert_eq!(
            packet.as_ref().as_ptr(),
            address,
            "the data-plane handoff retains the transmit callback's payload buffer"
        );
        assert_eq!(packet.len(), length);
        assert!(packet.as_ref().iter().all(|byte| *byte == value));
    }
    assert!(connection.outgoing().unwrap().is_empty());
    assert!(connection.device.transmit(now).is_some());
}
