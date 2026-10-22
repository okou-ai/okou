//! Unrelated authenticated map peers cannot multiply binding-liveness locking.

use super::*;
use crate::tailscale::tests::relay_projection::Liveness;

#[tokio::test]
async fn packet_turn_liveness_work_is_bounded_by_connections_not_map_peers() {
    for peer_count in [1, 32, 256] {
        unchanged_traffic(peer_count).await;
    }
}

async fn unchanged_traffic(peer_count: usize) {
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let key = NodeKeyPair::random();
    let mut value: serde_json::Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut active = node(2, "active.synthetic.ts.net.", 2, &key);
    active["HomeDERP"] = 1.into();
    let mut nodes = vec![active];
    for index in 1..peer_count {
        let mut peer = node(
            (index + 2) as i64,
            &format!("idle-{index}.synthetic.ts.net."),
            3,
            &NodeKeyPair::random(),
        );
        peer["Addresses"] = serde_json::json!([
            format!("100.65.0.{index}/32"),
            format!("fd7a:115c:a1e0:{index:x}::1/128"),
        ]);
        peer["HomeDERP"] = 1.into();
        nodes.push(peer);
    }
    value["Peers"] = nodes.into();
    value["PacketFilter"] = serde_json::json!([]);
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    let gate = WriteGate::new();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let counts = Arc::new(Liveness::default());
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = api.secure.as_ref().unwrap().clone();
    let factory = control.provisioned_root_factory(
        dial.clone(),
        Relay::new(&home, Arc::clone(&gate), Arc::clone(&descriptors)),
    );
    let observer = Arc::clone(&counts);
    let native = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            move |configuration, journal| observer.observe(factory(configuration, journal)),
        )
        .unwrap();
    control.allow_all();
    bounded(native.ready()).await.unwrap();
    let (frames, client) = bounded(home.task).await.unwrap();
    let mut peers = Peers {
        services: vec![Service {
            task: None,
            frames: Some(frames),
            outgoing: VecDeque::new(),
            offset: 0,
            expected: key.public,
            client,
            closed: false,
            packets: 0,
        }],
        sides: vec![wire::DerpSide::new(key, client, 2)],
        destinations: vec![0],
        epoch: Instant::now(),
    };
    let channel = peers.sides[0].channel();
    let listener = peers
        .finish(channel.tcp_listen(wire::remote(2)))
        .await
        .unwrap();
    let mut flows = Vec::new();
    for _ in 0..8 {
        let (client, server) = peers
            .finish(async { tokio::join!(native.dial("100.64.0.2", 22), listener.accept()) })
            .await;
        flows.push((client.unwrap(), server.unwrap()));
    }

    // Measure established traffic, excluding connection setup. The complete
    // bidirectional payloads still prove progress on all eight original flows.
    counts.start();
    for (client, server) in &mut flows {
        peers.transfer(client, server).await;
    }
    counts.stop();
    run.close();
    bounded(native.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    control.assert_control_closed();
    dial.assert_closed(2);
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;

    let (projections, maximum) = counts.snapshot();
    assert!(projections > 0, "actual packet turns must be observed");
    assert!(
        maximum <= flows.len(),
        "{peer_count} peers: {maximum} liveness checks in one projection for {} connections",
        flows.len(),
    );
    eprintln!(
        "{peer_count} peers, 8 connections: maximum {maximum} liveness checks per projection"
    );
}
