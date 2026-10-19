//! Closing a sibling cannot strand an already-established, receive-only TCP.
use super::*;

async fn close_before_first_response(checking: bool, other_port: u16) {
    let mut h = Harness::new().await;
    if checking {
        h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    }
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
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        api.secure.as_ref().unwrap().clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    let id = uuid::Uuid::new_v4();
    let first_resolve = h.resolve_response(credential(&h, id, false)).await;
    let mut other = credential(&h, id, false);
    other["port"] = json!(other_port);
    let second_resolve = h
        .resolve_response_connection(OTHER, other, Some(CREATED_AT))
        .await;
    let _check = h.check_route(CONNECTION, route(id), "valid", 200).await;
    let _other_check = h.check_route(OTHER, route(id), "valid", 200).await;
    let gate = Arc::new(BackendGate {
        accepted: Mutex::new(Vec::new()),
        first_ready: tokio::sync::Notify::new(),
        release: tokio::sync::Semaphore::new(0),
    });
    let listeners_ready = tokio::sync::Notify::new();
    control.allow_all();
    let (first, second, mut peers, proxies) = {
        let opening = async {
            tokio::join!(h.start("shared"), async {
                // The first TCP is established but its external RFB server has
                // not sent a byte. Close the other consumer before releasing it.
                gate.first_ready.notified().await;
                listeners_ready.notified().await;
                let second = if checking {
                    let checked = h
                        .run
                        .active_check(json!({"connectionId":OTHER,"mode":"exclusive"}))
                        .await;
                    assert_eq!(checked["status"], "passed", "{checked}");
                    None
                } else {
                    let session = h
                        .run
                        .request(
                            "vnc.session.start",
                            json!({"connectionId":OTHER,"mode":"exclusive"}),
                        )
                        .await
                        .session();
                    let closed = h
                        .run
                        .request("vnc.session.close", json!({"sessionId":session}))
                        .await;
                    assert_eq!(closed.result()["outcome"], "closed");
                    Some(session)
                };
                gate.release.add_permits(1);
                second
            })
        };
        tokio::pin!(opening);
        let ports = if other_port == 5900 {
            vec![5900]
        } else {
            vec![5900, other_port]
        };
        let mut peers = relay(home, key, opening.as_mut(), ports.clone()).await;
        let channel = peers.sides[0].channel();
        let mut proxies = Vec::new();
        for port in ports {
            let listener = peers
                .finish(channel.tcp_listen(format!("100.64.0.2:{port}").parse().unwrap()))
                .await
                .unwrap();
            proxies.push(proxy_gated(
                listener,
                h.peer.address,
                Some(Arc::clone(&gate)),
            ));
        }
        listeners_ready.notify_one();
        let (first, second) = peers.finish(opening.as_mut()).await;
        (first.session(), second, peers, proxies)
    };
    let accepted = gate.accepted.lock().unwrap().clone();
    assert_eq!(accepted.len(), 2);
    assert_eq!(accepted[0].ip(), accepted[1].ip());
    assert_ne!(accepted[0].port(), accepted[1].port(), "private TCP tuples");
    if let Some(second) = second {
        assert_ne!(first, second, "independent VNC session identities");
    }
    assert!(matches!(
        peers.finish(h.peer.event()).await,
        crate::vnc::tests::peer::Event::Mode(0)
    ));
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "second consumer cleanup leaves the first session"
    );
    peers.finish(exercise_session(&h, "shared", first)).await;
    first_resolve.assert_calls_async(1).await;
    second_resolve.assert_calls_async(1).await;
    assert!(h.network.queries.lock().unwrap().is_empty());
    assert!(h.network.attempts.lock().unwrap().is_empty());
    h.run.shutdown().await;
    control.assert_control_closed();
    for proxy in proxies {
        proxy.abort();
        assert!(proxy.await.unwrap_err().is_cancelled());
    }
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}

#[tokio::test]
async fn same_endpoint_check_close_preserves_waiting_native_start() {
    close_before_first_response(true, 5900).await;
}

#[tokio::test]
async fn different_port_check_close_preserves_waiting_native_start() {
    close_before_first_response(true, 5901).await;
}

#[tokio::test]
async fn ordinary_close_without_diagnostics_preserves_waiting_native_start() {
    close_before_first_response(false, 5900).await;
}
