//! VNC-only Run uses the production native owner and genuine encrypted SDK TCP.

mod diagnostics;
mod retirement;

use super::*;
use crate::vnc::tests::{
    harness::{CREATED_AT, Harness},
    native::exercise_session,
    peer::Peer,
};
use serde_json::{Value, json};

const CONNECTION: &str = "9f0128ce-dd11-4234-b1ac-a0c33353a112";
const OTHER: &str = "11111111-1111-4111-8111-111111111112";

pub(super) async fn relay<F: Future>(
    home: Server,
    key: NodeKeyPair,
    mut opening: Pin<&mut F>,
    ports: Vec<u16>,
) -> Peers {
    let (frames, client) = bounded(async {
        tokio::select! {
            result = home.task => result.unwrap(),
            _ = &mut opening => panic!("application finished before encrypted relay"),
        }
    })
    .await;
    Peers {
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
        sides: vec![wire::DerpSide::with_ports(key, client, 2, ports)],
        destinations: vec![0],
        epoch: Instant::now(),
    }
}

pub(super) fn proxy(
    listener: ts_netstack_smoltcp_socket::TcpListener,
    target: std::net::SocketAddr,
) -> tokio_util::task::AbortOnDropHandle<()> {
    proxy_gated(listener, target, None)
}

struct BackendGate {
    accepted: Mutex<Vec<std::net::SocketAddr>>,
    first_ready: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}

fn proxy_gated(
    listener: ts_netstack_smoltcp_socket::TcpListener,
    target: std::net::SocketAddr,
    gate: Option<Arc<BackendGate>>,
) -> tokio_util::task::AbortOnDropHandle<()> {
    assert!(target.ip().is_loopback());
    tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        // SDK accept enqueues a command and is not cancellation safe. Preserve
        // that response receiver when a forwarding task finishes first.
        let mut accepting = Box::pin(listener.accept());
        loop {
            tokio::select! {
                accepted = &mut accepting => {
                    let Ok(mut stream) = accepted else { break; };
                    accepting.set(listener.accept());
                    let first = gate.as_ref().is_some_and(|gate| {
                        let mut accepted = gate.accepted.lock().unwrap();
                        accepted.push(stream.remote_addr());
                        accepted.len() == 1
                    });
                    let gate = gate.clone();
                    connections.spawn(async move {
                        if first {
                            let gate = gate.as_ref().unwrap();
                            gate.first_ready.notify_one();
                            gate.release.acquire().await.unwrap().forget();
                        }
                        let mut server = tokio::net::TcpStream::connect(target).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut server).await;
                    });
                },
                result = connections.join_next(), if !connections.is_empty() => { result.unwrap().unwrap(); },
            }
        }
    }))
}

#[tokio::test]
async fn cancelled_vnc_start_retains_unknown_provider_effect_and_rejects_run_reuse() {
    use super::super::fixture::Phase;
    use runner_provider::AblySideMessageHandler;
    let mut h = Harness::new().await;
    let mut api = Api::secure(Some(Phase::Create)).await;
    let home = Server::secure().await;
    let control = Control::new(ACCEPTED.to_vec(), map(&home), KeyReply::Valid, false).await;
    let dial = api.secure.as_ref().unwrap().clone();
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    let resolve = h
        .resolve_response(credential(&h, uuid::Uuid::new_v4(), true))
        .await;
    {
        let starting = h.start("shared");
        tokio::pin!(starting);
        bounded(async {
            tokio::select! {
                () = async { api.next(Phase::OAuth).await; api.next(Phase::Create).await; } => {},
                result = &mut starting => panic!("start ended before accepted provider create: {:?}", result.result()),
            }
        }).await;
        assert!(h.runtime.handle(&ably_subscriber::Message {
            name: Some("vnc-authority-invalidated".into()),
            data: json!({"runId":h.run.id,"connectionId":CONNECTION}),
            id: None,
            client_id: None,
            timestamp: Some(1),
        }));
        assert_eq!(starting.await.result()["reason"], "cancelled");
    }
    resolve.assert_calls_async(1).await;
    assert_eq!(
        h.run.shutdown_result().await,
        Err(crate::guest_rpc::CleanupError::Native)
    );
    assert!(h.network.attempts.lock().unwrap().is_empty());
    assert!(h.network.queries.lock().unwrap().is_empty());
    api.assert_contract(1, 0);
    home.task.abort();
    assert!(matches!(home.task.await, Err(error) if error.is_cancelled()));
    api.finish().await;
    control.finish_unused().await;
}

fn route(id: uuid::Uuid) -> Value {
    json!({"type":"tailscale","configId":id,"generation":1})
}

fn credential(h: &Harness, id: uuid::Uuid, raw: bool) -> Value {
    let mut transport = route(id);
    transport["credentials"] =
        json!({"clientId":"synthetic-client","clientSecret":"synthetic-secret"});
    transport["tags"] = json!(["tag:ssh"]);
    let mut value = json!({"outcome":if raw {"resolved_apple_vnc_password"} else {"resolved_transport"},
        "host":"peer.synthetic.ts.net","port":5900,"generation":7,"transport":transport,
    "authentication":{"method":"vnc_password","password":" secret "},
    "security":if raw {json!({"type":"apple_vnc_password"})} else {
        json!({"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":h.peer.ca}})
    }});
    if !raw {
        value["serverName"] = json!("vnc.example.test");
    }
    value
}

#[tokio::test]
async fn exact_native_peer_carries_x509_and_raw_apple_desktops_with_bounded_logout() {
    for (raw, cleanup_failure) in [(false, false), (true, false), (true, true)] {
        let mut h = Harness::with_authority(
            if raw {
                Peer::classic().await
            } else {
                Peer::new().await
            },
            None,
        )
        .await;
        let api = Api::secure(None).await;
        let home = Server::secure().await;
        let key = NodeKeyPair::random();
        let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
        let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
        peer["HomeDERP"] = 1.into();
        value["Peers"] = vec![peer].into();
        value["PacketFilter"] = json!([]);
        let control = Control::new(
            ACCEPTED.to_vec(),
            serde_json::to_vec(&value).unwrap(),
            KeyReply::Valid,
            false,
        )
        .await;
        control.set_logout_reply(
            if cleanup_failure {
                hyper::StatusCode::SERVICE_UNAVAILABLE
            } else {
                hyper::StatusCode::OK
            },
            br#"{"NodeKeyExpired":true}"#.to_vec(),
        );
        let dial = api.secure.as_ref().unwrap().clone();
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
            dial.clone(),
            Relay::new(&home, WriteGate::new(), Arc::clone(&descriptors)),
        ));
        let id = uuid::Uuid::new_v4();
        let resolve = h.resolve_response(credential(&h, id, raw)).await;
        let _check = h.check_route(CONNECTION, route(id), "valid", 200).await;
        control.allow_all();
        let (session, mut peers, proxy) = {
            let opening = h.start("shared");
            tokio::pin!(opening);
            let mut peers = relay(home, key, opening.as_mut(), vec![5900]).await;
            let channel = peers.sides[0].channel();
            let listener = peers
                .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
                .await
                .unwrap();
            let proxy = proxy(listener, h.peer.address);
            let session = peers.finish(opening.as_mut()).await.session();
            (session, peers, proxy)
        };
        peers.finish(exercise_session(&h, "shared", session)).await;
        assert!(
            h.network.attempts.lock().unwrap().is_empty(),
            "native targets never reach system/public DNS or TCP"
        );
        assert!(h.network.queries.lock().unwrap().is_empty());
        resolve.assert_calls_async(1).await;
        // Consumed-node logout is bounded best effort under the shared owner.
        // Unknown provider effects/physical cleanup failures are tested separately.
        h.run.shutdown().await;
        proxy.abort();
        assert!(proxy.await.unwrap_err().is_cancelled());
        control.assert_control_closed();
        api.assert_contract(1, 0);
        assert_eq!(control.logout_count(), 1);
        api.finish().await;
        control.finish().await;
    }
}

#[tokio::test]
async fn targeted_vnc_revocation_preserves_shared_peer_then_key_retirement_cuts_pending_capture() {
    use runner_provider::AblySideMessageHandler;
    let mut h = Harness::with_authority(Peer::new().await, None).await;
    h.run.enable_diagnostics(&h.runtime).await;
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let key = NodeKeyPair::random();
    let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
    peer["HomeDERP"] = 1.into();
    value["Peers"] = vec![peer].into();
    value["PacketFilter"] = json!([]);
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    control.set_logout_reply(
        hyper::StatusCode::OK,
        br#"{"NodeKeyExpired":true}"#.to_vec(),
    );
    let dial = api.secure.as_ref().unwrap().clone();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::new(&home, WriteGate::new(), descriptors),
    ));
    let id = uuid::Uuid::new_v4();
    let resolve = h.resolve_response(credential(&h, id, false)).await;
    let second = h
        .resolve_response_connection(OTHER, credential(&h, id, false), Some(CREATED_AT))
        .await;
    let _check = h.check_route(CONNECTION, route(id), "valid", 200).await;
    let _other_check = h.check_route(OTHER, route(id), "valid", 200).await;
    control.allow_all();
    let (first, mut peers, proxy) = {
        let opening = h.start("shared");
        tokio::pin!(opening);
        let mut peers = relay(home, key, opening.as_mut(), vec![5900]).await;
        let channel = peers.sides[0].channel();
        let listener = peers
            .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
            .await
            .unwrap();
        let proxy = proxy(listener, h.peer.address);
        let first = peers.finish(opening.as_mut()).await.session();
        (first, peers, proxy)
    };
    peers.finish(h.peer.event()).await;
    let second_id = peers
        .finish(h.run.request(
            "vnc.session.start",
            json!({"connectionId":OTHER,"mode":"shared"}),
        ))
        .await
        .session();
    peers.finish(h.peer.event()).await;
    assert!(h.runtime.handle(&ably_subscriber::Message {
        name: Some("vnc-authority-invalidated".into()),
        data: json!({"runId":h.run.id,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: Some(1)
    }));
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":first}))
            .await
            .result()["outcome"],
        "failed"
    );
    let captured = peers
        .finish(h.run.request("vnc.capture", json!({"sessionId":second_id})))
        .await;
    assert_eq!(captured.result()["outcome"], "captured");
    peers.finish(h.peer.event()).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *h.peer.capture_gate.lock().await = Some(gate);
    {
        let pending = h.run.request("vnc.capture", json!({"sessionId":second_id}));
        tokio::pin!(pending);
        peers.finish(async {
            tokio::select! { event = h.peer.event() => { let _ = event; }, result = &mut pending => panic!("capture ended before retirement: {:?}", result.result()) }
        }).await;
        control.update_map(json!({"PeersRemoved":[2]})).await;
        let reply = peers.finish(&mut pending).await;
        assert_eq!(reply.result()["outcome"], "failed");
        assert!(
            reply.bytes.is_empty(),
            "retired peer must not release buffered screenshot bytes"
        );
    }
    resolve.assert_calls_async(1).await;
    second.assert_calls_async(1).await;
    let inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(crate::test_fixtures::remote_inventory(
                    &[(CONNECTION, 7), (OTHER, 7)],
                    CREATED_AT,
                ));
        })
        .await;
    let history = h
        .run
        .passive("vnc.diagnose", json!({"connectionId":OTHER}))
        .await;
    assert_eq!(history["status"], "found");
    let text = crate::test_fixtures::diagnostic_text(&history);
    assert!(
        text.contains(&format!("Native source: configuration {id}; generation 1;")),
        "{text}"
    );
    assert!(!text.contains("synthetic-secret") && !text.contains("synthetic-client"));
    inventory.assert_calls_async(1).await;
    h.run.shutdown().await;
    proxy.abort();
    assert!(proxy.await.unwrap_err().is_cancelled());
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}
