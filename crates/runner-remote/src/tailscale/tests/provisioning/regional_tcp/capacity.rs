//! Retiring an actual regional socket frees capacity without replacing other TCP.

use super::*;
use crate::tailscale::Failure;

#[tokio::test]
async fn eight_live_regions_reject_ninth_until_actual_old_io_is_destroyed() {
    let api = Api::secure(None).await;
    let mut servers = Vec::new();
    for _ in 0..9 {
        servers.push(Server::secure().await);
    }
    let keys = (0..9).map(|_| NodeKeyPair::random()).collect::<Vec<_>>();
    let mut value: serde_json::Value = serde_json::from_slice(&map(&servers[0])).unwrap();
    let template = value["DERPMap"]["Regions"]["1"].clone();
    let mut nodes = Vec::new();
    for (index, (server, key)) in servers.iter().zip(&keys).enumerate() {
        let id = index + 1;
        let mut region = template.clone();
        region["RegionID"] = id.into();
        region["Nodes"][0]["RegionID"] = id.into();
        region["Nodes"][0]["Name"] = format!("{id}a").into();
        region["Nodes"][0]["DERPPort"] = server.address.port().into();
        value["DERPMap"]["Regions"][id.to_string()] = region;
        let mut peer = node(
            (index + 2) as i64,
            &format!("p{index}.synthetic.ts.net."),
            (index + 2) as u8,
            key,
        );
        peer["HomeDERP"] = id.into();
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
    let gates = (0..9).map(|_| WriteGate::new()).collect::<Vec<_>>();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = api.secure.as_ref().unwrap().clone();
    let native = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::multiple(
                    &servers.iter().collect::<Vec<_>>(),
                    &gates,
                    Arc::clone(&descriptors),
                ),
            ),
        )
        .unwrap();
    control.allow_all();
    bounded(native.ready()).await.unwrap();
    assert_eq!(control.announced_home(), vec![1]);
    let mut servers = servers.into_iter();
    let home = servers.next().unwrap();
    let (frames, client) = bounded(home.task).await.unwrap();
    let mut services = vec![Service {
        task: None,
        frames: Some(frames),
        outgoing: VecDeque::new(),
        offset: 0,
        expected: keys[0].public,
        client,
        closed: false,
        packets: 0,
    }];
    for (server, key) in servers.zip(&keys[1..]) {
        services.push(Service {
            task: Some(server.task),
            frames: None,
            outgoing: VecDeque::new(),
            offset: 0,
            expected: key.public,
            client,
            closed: false,
            packets: 0,
        });
    }
    let mut peers = Peers {
        services,
        sides: keys
            .into_iter()
            .enumerate()
            .map(|(index, key)| wire::DerpSide::new(key, client, (index + 2) as u8))
            .collect(),
        destinations: (0..9).collect(),
        epoch: Instant::now(),
    };
    let mut listeners = Vec::new();
    for index in 0..9 {
        let channel = peers.sides[index].channel();
        listeners.push(
            peers
                .finish(channel.tcp_listen(wire::remote((index + 2) as u8)))
                .await
                .unwrap(),
        );
    }
    let mut flows = Vec::new();
    for (index, listener) in listeners.iter().take(8).enumerate() {
        let host = format!("100.64.0.{}", index + 2);
        let (client, server) = peers
            .finish(async { tokio::join!(native.dial(&host, 22), listener.accept()) })
            .await;
        let mut client = client.unwrap();
        let mut server = server.unwrap();
        peers.transfer(&mut client, &mut server).await;
        flows.push(Some((client, server)));
    }
    assert_eq!(descriptors.lock().unwrap().len(), 8);
    assert!(matches!(
        peers.finish(native.dial("100.64.0.10", 22)).await,
        Err(Failure::ResourceExhausted)
    ));
    assert_eq!(descriptors.lock().unwrap().len(), 8);
    assert!(peers.services[8].frames.is_none());
    // Region 2's original TCP is dropped. Capacity remains occupied until its
    // actual TLS/raw socket is gone, not merely until its binding is removed.
    drop(flows[1].take());
    peers.finish(gates[1].destroyed()).await;
    let (client, server) = peers
        .finish(async { tokio::join!(native.dial("100.64.0.10", 22), listeners[8].accept()) })
        .await;
    let mut client = client.unwrap();
    let mut server = server.unwrap();
    peers.transfer(&mut client, &mut server).await;
    assert_eq!(descriptors.lock().unwrap().len(), 9);
    // All seven other flows retain their original TCP/socket identities and
    // transfer another 65,536 bytes each way after the ninth region starts.
    for (client, server) in flows.iter_mut().flatten() {
        peers.transfer(client, server).await;
    }
    assert!(peers.services[1].closed);
    assert!(peers.services.iter().all(|service| service.packets > 0));
    run.close();
    bounded(native.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    for gate in &gates {
        bounded(gate.destroyed()).await;
    }
    control.assert_control_closed();
    dial.assert_closed(2);
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}
