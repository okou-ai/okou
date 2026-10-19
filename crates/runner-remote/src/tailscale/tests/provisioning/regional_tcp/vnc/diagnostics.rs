use super::*;
use crate::test_fixtures::{diagnostic_attempt, diagnostic_text, remote_inventory};
use std::sync::atomic::Ordering;

async fn mode(h: &Harness, expected: u8) {
    assert!(
        matches!(h.peer.event().await, crate::vnc::tests::peer::Event::Mode(actual) if actual == expected)
    );
}

async fn closed(h: &Harness) {
    assert!(matches!(
        h.peer.event().await,
        crate::vnc::tests::peer::Event::Closed
    ));
}

#[tokio::test]
async fn native_checks_keep_fresh_streams_separate_from_reused_node_and_shared_terminal_history() {
    let mut h = Harness::new().await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
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
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial.clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    let id = uuid::Uuid::new_v4();
    let _resolve = h.resolve_response(credential(&h, id, false)).await;
    let mut other_credential = credential(&h, id, false);
    other_credential["port"] = json!(5901);
    let _second = h
        .resolve_response_connection(OTHER, other_credential, Some(CREATED_AT))
        .await;
    let _check = h.check_route(CONNECTION, route(id), "valid", 200).await;
    let _other_check = h.check_route(OTHER, route(id), "valid", 200).await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7), (OTHER, 7)], CREATED_AT));
        })
        .await;
    control.allow_all();
    let (foreground, initial_check, mut peers, proxy, other_proxy) = {
        let opening = h.start("shared");
        tokio::pin!(opening);
        let mut peers = relay(home, key, opening.as_mut(), vec![5900, 5901]).await;
        let channel = peers.sides[0].channel();
        let listener = peers
            .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
            .await
            .unwrap();
        let proxy = proxy(listener, h.peer.address);
        let other_listener = peers
            .finish(channel.tcp_listen("100.64.0.2:5901".parse().unwrap()))
            .await
            .unwrap();
        let other_proxy = super::proxy(other_listener, h.peer.address);
        // Establish the external listener before exercising concurrent consumers.
        let (foreground, checked) = peers
            .finish(async {
                tokio::join!(
                    opening.as_mut(),
                    h.run
                        .active_check(json!({"connectionId":OTHER,"mode":"exclusive"}))
                )
            })
            .await;
        (foreground.session(), checked, peers, proxy, other_proxy)
    };
    assert_eq!(initial_check["status"], "passed", "{initial_check}");
    let mut modes = Vec::new();
    for _ in 0..2 {
        match peers.finish(h.peer.event()).await {
            crate::vnc::tests::peer::Event::Mode(mode) => modes.push(mode),
            _ => panic!("concurrent start/check must initialize without desktop IO"),
        }
    }
    modes.sort_unstable();
    assert_eq!(modes, [0, 1]);
    h.peer.refuse.store(true, Ordering::SeqCst);
    let failure = peers.finish(h.start("shared")).await;
    assert_eq!(failure.result()["reason"], "authentication_failed");
    let automatic = diagnostic_text(failure.result());
    assert!(automatic.contains("node setup reused;"), "{automatic}");
    assert!(
        automatic.contains("Selected peer control-plane status: online;"),
        "{automatic}"
    );
    assert!(
        automatic.contains("WireGuard transport-data produced:"),
        "{automatic}"
    );
    assert!(
        !automatic.contains("WireGuard transport-data produced: not observed."),
        "{automatic}"
    );
    assert!(
        automatic.contains("Native node registration: passed;"),
        "{automatic}"
    );
    assert!(
        automatic.contains("Native connection private tcp: passed;"),
        "{automatic}"
    );
    assert!(
        automatic.contains("Native connection private tcp endpoint: 100.64.0.2:5900;"),
        "{automatic}"
    );
    peers.finish(closed(&h)).await;
    let before = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(diagnostic_text(&before), automatic);
    let source_line = |text: &str, prefix: &str| {
        text.lines()
            .find(|line| line.starts_with(prefix))
            .unwrap()
            .to_owned()
    };
    let previous_connection = source_line(automatic, "- Native connection evidence:");
    assert_ne!(
        previous_connection,
        source_line(
            diagnostic_text(&initial_check),
            "- Native connection evidence:"
        )
    );
    assert_eq!(
        source_line(automatic, "- Native source:"),
        source_line(diagnostic_text(&initial_check), "- Native source:")
    );
    h.peer.refuse.store(false, Ordering::SeqCst);
    let mut last_connection = previous_connection;
    for (sharing, flag) in [("shared", 1), ("exclusive", 0)] {
        let checked = peers
            .finish(
                h.run
                    .active_check(json!({"connectionId":CONNECTION,"mode":sharing})),
            )
            .await;
        assert_eq!(checked["status"], "passed", "{checked}");
        let text = diagnostic_text(&checked);
        assert!(
            text.contains("Selected peer control-plane status: online;"),
            "{text}"
        );
        assert!(
            text.contains("WireGuard transport-data header received:"),
            "{text}"
        );
        assert!(text.contains("stream passed; node setup reused;"), "{text}");
        assert!(text.contains("VNC initialization: passed."), "{text}");
        assert!(text.contains("Check-owned cleanup: passed."), "{text}");
        assert_eq!(
            source_line(text, "- Native source:"),
            source_line(automatic, "- Native source:")
        );
        let connection = source_line(text, "- Native connection evidence:");
        assert_ne!(connection, last_connection);
        last_connection = connection;
        peers.finish(mode(&h, flag)).await;
        // Native teardown destroys the local private TCP owner without promising
        // a remote FIN/RST. Verify the check's actual temporary-session boundary.
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(h.run.passive("vnc.diagnose", json!({})).await, before);
    }
    let second = peers
        .finish(h.run.request(
            "vnc.session.start",
            json!({"connectionId":OTHER,"mode":"shared"}),
        ))
        .await
        .session();
    peers.finish(mode(&h, 1)).await;
    // A real invalid control frame fails the shared native owner after readiness.
    control
        .update_map(json!({"Peers":[{"ID":2,"Name":"private-map-canary"}]}))
        .await;
    let after = peers
        .finish(async {
            loop {
                let found = h
                    .run
                    .passive("vnc.diagnose", json!({"connectionId":OTHER}))
                    .await;
                let text = diagnostic_text(&found);
                if text.contains("terminal root: map stream;")
                    && text.contains("cleanup complete true;")
                {
                    break found;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
    let text = diagnostic_text(&after);
    assert!(
        text.contains("Native node map validation: failed; detail: invalid."),
        "{text}"
    );
    assert!(
        text.contains(&format!(
            "VNC RFB carrier: configuration {id}; generation 1;"
        )),
        "{text}"
    );
    assert!(text.contains("Native connection evidence:"), "{text}");
    assert!(
        text.contains("first terminal failure domain failed;"),
        "{text}"
    );
    assert!(!text.contains("private-map-canary") && !text.contains("synthetic-secret"));
    for session in [foreground, second] {
        assert_eq!(
            h.run
                .request("vnc.session.status", json!({"sessionId":session}))
                .await
                .result()["outcome"],
            "failed"
        );
    }
    let blocked = h
        .run
        .active_check(json!({"connectionId":CONNECTION,"mode":"shared"}))
        .await;
    assert_eq!(blocked["status"], "blocked", "{blocked}");
    assert!(
        diagnostic_text(&blocked).contains("stream not reached; node setup reused;"),
        "{blocked}"
    );
    assert_eq!(
        h.run
            .passive("vnc.diagnose", json!({"connectionId":OTHER}))
            .await,
        after
    );
    let shared = h
        .run
        .passive("vnc.diagnose", json!({"connectionId":CONNECTION}))
        .await;
    assert_eq!(shared["status"], "found");
    assert_eq!(
        source_line(diagnostic_text(&shared), "- Native source:"),
        source_line(text, "- Native source:")
    );
    let retained = h
        .run
        .passive(
            "vnc.diagnose",
            json!({"attemptId":diagnostic_attempt(&before)}),
        )
        .await;
    assert_eq!(retained["status"], "found");
    let retained = diagnostic_text(&retained);
    assert!(
        retained.contains("Native node map validation: passed;"),
        "{retained}"
    );
    assert!(
        !retained.contains("terminal root: map stream;"),
        "{retained}"
    );
    assert!(
        h.network.queries.lock().unwrap().is_empty()
            && h.network.attempts.lock().unwrap().is_empty()
    );
    h.run.shutdown().await;
    proxy.abort();
    assert!(proxy.await.unwrap_err().is_cancelled());
    other_proxy.abort();
    assert!(other_proxy.await.unwrap_err().is_cancelled());
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime for the real Kerberos worker"]
async fn mixed_cloudflare_rfb_tailscale_kdc_failure_keeps_the_kdc_native_source() {
    use crate::vnc::tests::native::gateway::{Gateway, HOST};
    for checking in [false, true] {
        let mut h = Harness::with_authority(Peer::gssapi().await, None).await;
        h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
        let gateway = Gateway::new(h.peer.address, false, false, HOST).await;
        crate::vnc::tests::native::connect_gateway(&h, &gateway).await;
        let api = Api::secure(None).await;
        let home = Server::secure().await;
        let control = Control::new(ACCEPTED.to_vec(), map(&home), KeyReply::Valid, false).await;
        control.set_home_status(hyper::StatusCode::SERVICE_UNAVAILABLE);
        let dial = api.secure.as_ref().unwrap().clone();
        *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
            dial,
            Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
        ));
        let kdc = uuid::Uuid::new_v4();
        let _resolve = h.resolve_response(json!({
            "outcome":"resolved_kerberos", "host":HOST,"port":443,"generation":7,
            "credentialRevision":3,"serverName":"vnc.example.test",
            "transport":{"type":"cloudflare_access","configId":CONNECTION,"generation":7,
                "credentials":{"clientId":"private-client","clientSecret":"private-secret"},"originTls":null},
            "authentication":{"method":"qemu_kerberos_password","initiator":{"realm":"EXAMPLE.TEST","components":["operator"]},"password":"mixed-kdc-password-canary"},
            "security":{"type":"qemu_x509_gssapi","trust":{"mode":"custom_ca","caBundle":h.peer.ca},
                "service":{"realm":"EXAMPLE.TEST","components":["vnc","desktop.internal"]},
                "kdc":{"host":"peer.synthetic.ts.net","port":88,
                    "transport":{"type":"tailscale","configId":kdc,"generation":1,
                        "credentials":{"clientId":"synthetic-client","clientSecret":"synthetic-secret"},"tags":["tag:ssh"]},
                    "ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":7200}}
        })).await;
        let _authority = h
            .check_kerberos_route(
                CONNECTION,
                json!({"type":"cloudflare_access","configId":CONNECTION,"generation":7}),
                json!({"type":"tailscale","configId":kdc,"generation":1}),
            )
            .await;
        let _inventory = h
            .api
            .mock_async(|when, then| {
                when.method("GET").path("/api/vnc/hosts");
                then.status(200)
                    .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
            })
            .await;
        control.allow_all();
        let result = if checking {
            let checked = h
                .run
                .active_check(json!({"connectionId":CONNECTION,"mode":"exclusive"}))
                .await;
            assert_eq!(checked["status"], "failed", "{checked}");
            checked
        } else {
            let failure = h.start("shared").await;
            assert_eq!(
                failure.result()["reason"],
                "network_failure",
                "{}",
                failure.result()
            );
            let retained = h.run.passive("vnc.diagnose", json!({})).await;
            assert_eq!(retained["status"], "found");
            // Cleanup lifecycle facts can advance, while role/stage attribution stays fixed.
            assert!(diagnostic_text(failure.result()).contains(&format!(
                "Native source: configuration {kdc}; generation 1;"
            )));
            retained
        };
        let text = diagnostic_text(&result);
        assert!(
            text.contains(&format!(
                "VNC RFB carrier: configuration {CONNECTION}; generation 7;"
            )),
            "{text}"
        );
        assert!(
            text.contains(&format!(
                "VNC KDC carrier: configuration {kdc}; generation 1;"
            )),
            "{text}"
        );
        assert!(
            text.contains(&format!(
                "Native source: configuration {kdc}; generation 1;"
            )),
            "{text}"
        );
        assert!(
            text.contains("VNC RFB carrier access websocket: passed."),
            "{text}"
        );
        assert!(
            text.contains("Native node home announcement: failed;"),
            "{text}"
        );
        assert!(text.contains("VNC kdc transport: failed."), "{text}");
        assert!(text.contains("VNC initialization: not reached."), "{text}");
        assert!(!text.contains("mixed-kdc-password-canary") && !text.contains("synthetic-secret"));
        assert_eq!(
            h.network.attempts.lock().unwrap().len(),
            1,
            "KDC native traffic must not use the RFB/system TCP destination"
        );
        closed(&h).await;
        if !checking {
            let blocked = h
                .run
                .active_check(json!({"connectionId":CONNECTION,"mode":"exclusive"}))
                .await;
            assert_eq!(blocked["status"], "blocked", "{blocked}");
            assert!(
                diagnostic_text(&blocked).contains("stream not reached; node setup reused;"),
                "{blocked}"
            );
            assert!(
                diagnostic_text(&blocked).contains(&format!(
                    "Native source: configuration {kdc}; generation 1;"
                )),
                "{blocked}"
            );
            closed(&h).await;
            let history = h.run.passive("vnc.diagnose", json!({})).await;
            assert_eq!(diagnostic_attempt(&history), diagnostic_attempt(&result));
        }
        drop(gateway);
        if !checking {
            let retained = h
                .run
                .passive(
                    "vnc.diagnose",
                    json!({"attemptId":diagnostic_attempt(&result)}),
                )
                .await;
            assert_eq!(retained["status"], "found");
            assert!(diagnostic_text(&retained).contains("Native node home announcement: failed;"));
        } else {
            let history = h.run.passive("vnc.diagnose", json!({})).await;
            assert_eq!(history["status"], "no_failure");
        }
        h.run.shutdown().await;
        api.assert_contract(1, 0);
        home.task.abort();
        assert!(matches!(home.task.await, Err(error) if error.is_cancelled()));
        api.finish().await;
        control.finish().await;
    }
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime for the real Kerberos worker"]
async fn native_rfb_failure_interrupting_cloudflare_kdc_keeps_rfb_cause_and_delivery_uncertainty() {
    use crate::vnc::tests::native::gateway::{Gateway, HOST};
    let mut h = Harness::with_authority(Peer::gssapi().await, None).await;
    h.run.enable_checks(&h.runtime, &["vnc:write"]).await;
    let gateway = Gateway::new(h.peer.address, true, false, HOST).await;
    gateway.origin_gate.acquire().await.unwrap().forget();
    crate::vnc::tests::native::connect_gateway(&h, &gateway).await;
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
    let dial = api.secure.as_ref().unwrap().clone();
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        dial,
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    let rfb = uuid::Uuid::new_v4();
    let _resolve = h.resolve_response(json!({
        "outcome":"resolved_kerberos", "host":"peer.synthetic.ts.net","port":5900,"generation":7,
        "credentialRevision":3,"serverName":"vnc.example.test",
        "transport":{"type":"tailscale","configId":rfb,"generation":1,
            "credentials":{"clientId":"synthetic-client","clientSecret":"synthetic-secret"},"tags":["tag:ssh"]},
        "authentication":{"method":"qemu_kerberos_password","initiator":{"realm":"EXAMPLE.TEST","components":["operator"]},"password":"interrupted-kdc-password-canary"},
        "security":{"type":"qemu_x509_gssapi","trust":{"mode":"custom_ca","caBundle":h.peer.ca},
            "service":{"realm":"EXAMPLE.TEST","components":["vnc","desktop.internal"]},
            "kdc":{"host":HOST,"port":443,
                "transport":{"type":"cloudflare_access","configId":OTHER,"generation":9,
                    "credentials":{"clientId":"private-client","clientSecret":"private-secret"}},
                "ticketLifetimeSeconds":1200,"renewableLifetimeSeconds":7200}}
    })).await;
    let _authority = h
        .check_kerberos_route(
            CONNECTION,
            route(rfb),
            json!({"type":"cloudflare_access","configId":OTHER,"generation":9}),
        )
        .await;
    let _inventory = h
        .api
        .mock_async(|when, then| {
            when.method("GET").path("/api/vnc/hosts");
            then.status(200)
                .json_body(remote_inventory(&[(CONNECTION, 7)], CREATED_AT));
        })
        .await;
    control.allow_all();
    let (failure, proxy) = {
        let opening = h.start("shared");
        tokio::pin!(opening);
        let mut peers = relay(home, key, opening.as_mut(), vec![5900]).await;
        let channel = peers.sides[0].channel();
        let listener = peers
            .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
            .await
            .unwrap();
        let proxy = proxy(listener, h.peer.address);
        peers.finish(async {
            tokio::select! {
                () = gateway.received.notified() => {},
                result = &mut opening => panic!("start ended before KDC send: {}", result.result()),
            }
        }).await;
        control
            .update_map(json!({"Peers":[{"ID":2,"Name":"interrupted-map-canary"}]}))
            .await;
        (peers.finish(opening.as_mut()).await, proxy)
    };
    assert_eq!(
        failure.result()["reason"],
        "delivery_unknown",
        "{}",
        failure.result()
    );
    let text = diagnostic_text(failure.result());
    assert!(
        text.contains(&format!(
            "Native source: configuration {rfb}; generation 1;"
        )),
        "{text}"
    );
    assert!(text.contains("terminal root: map stream;"), "{text}");
    assert!(
        text.contains(&format!(
            "VNC KDC carrier: configuration {OTHER}; generation 9;"
        )),
        "{text}"
    );
    assert!(
        text.contains("VNC KDC carrier access websocket: passed."),
        "{text}"
    );
    assert!(text.contains("VNC kdc exchange: unknown."), "{text}");
    assert!(
        !text.contains("VNC KDC first Cloudflare Access failure:"),
        "{text}"
    );
    assert!(
        !text.contains("interrupted-map-canary")
            && !text.contains("interrupted-kdc-password-canary")
    );
    assert_eq!(gateway.applications.load(Ordering::SeqCst), 0);
    let history = h.run.passive("vnc.diagnose", json!({})).await;
    assert_eq!(history["status"], "found");
    assert!(diagnostic_text(&history).contains(&format!(
        "Native source: configuration {rfb}; generation 1;"
    )));
    h.run.shutdown().await;
    proxy.abort();
    if let Err(error) = proxy.await {
        assert!(error.is_cancelled(), "{error}");
    }
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}
