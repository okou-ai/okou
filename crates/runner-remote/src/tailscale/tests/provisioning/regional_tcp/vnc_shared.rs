//! Actual SSH and VNC consumers share one native configuration in one Run.

use super::*;
use crate::{
    ssh::tests::harness::{CONNECTION, CREATED_AT, Harness, Reply, TOKEN, params},
    test_fixtures::http::{HttpClientConfig, http_client},
    vnc::{
        VncRuntime,
        tests::peer::{Event, Peer},
    },
};
use runner_provider::AblySideMessageHandler;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn same_uuid_protocol_revocations_preserve_the_other_consumer_and_shared_native_node() {
    let mut h = Harness::new(Reply::default()).await;
    let desktop = Peer::classic().await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "native-shared-vnc".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(Arc::clone(&vnc)).await;

    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let key = NodeKeyPair::random();
    let mut value: serde_json::Value = serde_json::from_slice(&map(&home)).unwrap();
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
    let services = control.test_services(
        api.secure.as_ref().unwrap().clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    );
    *h.runtime.native_services.lock().unwrap() = Some(services.clone());
    *vnc.native_services.lock().unwrap() = Some(services);
    let id = uuid::Uuid::new_v4();
    let direct = h.credential(true);
    let ssh_resolve = h.resolve(json!({"outcome":"resolved_tailscale","host":"peer.synthetic.ts.net","port":22,
        "username":"test-user","generation":7,"learnedHostKey":direct["learnedHostKey"],
        "authentication":{"method":"private_key","privateKey":direct["privateKey"],"passphrase":null},
        "tailscale":{"configId":id,"generation":1,"clientId":"synthetic-client","clientSecret":"synthetic-secret","tags":["tag:ssh"]}})).await;
    let resolve = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/resolve", h.run))
            .header("authorization", format!("Bearer {TOKEN}"))
            .is_true(crate::test_fixtures::vnc::optional_kerberos_request(json!({
                "connectionId":CONNECTION,"runnerIdentity":{"runnerId":h.identity.runner_id(),"heartbeatGeneration":h.identity.heartbeat_generation()},
                "supportedProfiles":crate::test_fixtures::vnc::supported_profiles(true)
            }), true));
        then.status(200).header("X-VNC-Connection-Created-At", CREATED_AT).json_body(json!({
            "outcome":"resolved_apple_vnc_password","host":"peer.synthetic.ts.net","port":5900,"generation":7,
            "transport":{"type":"tailscale","configId":id,"generation":1,"tags":["tag:ssh"],
                "credentials":{"clientId":"synthetic-client","clientSecret":"synthetic-secret"}},
            "authentication":{"method":"vnc_password","password":" secret "},"security":{"type":"apple_vnc_password"}
        }));
    }).await;
    let check = h.api.mock_async(|when, then| {
        when.method("POST").path(format!("/api/runners/runs/{}/vnc/check", h.run))
            .json_body(json!({"connectionId":CONNECTION,"runnerIdentity":{"runnerId":h.identity.runner_id(),"heartbeatGeneration":h.identity.heartbeat_generation()},
                "expectedGeneration":7,"expectedTransport":{"type":"tailscale","configId":id,"generation":1}}));
        then.status(200).json_body(json!({"outcome":"valid"}));
    }).await;
    control.allow_all();
    let (mut peers, ssh_proxy, vnc_proxy) = {
        let request = h.request(params());
        tokio::pin!(request);
        let mut peers = super::vnc::relay(home, key, request.as_mut(), vec![22, 5900]).await;
        let channel = peers.sides[0].channel();
        let ssh_listener = peers
            .finish(channel.tcp_listen("100.64.0.2:22".parse().unwrap()))
            .await
            .unwrap();
        let vnc_listener = peers
            .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
            .await
            .unwrap();
        let ssh_proxy = super::vnc::proxy(ssh_listener, *h.network.target.lock().unwrap());
        let vnc_proxy = super::vnc::proxy(vnc_listener, desktop.address);
        let frames = peers.finish(request.as_mut()).await;
        assert_eq!(frames.last().unwrap()["data"]["effects"], "completed");
        (peers, ssh_proxy, vnc_proxy)
    };
    let frames = peers
        .finish(
            h.raw(
                json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,
        "params":{"connectionId":CONNECTION,"mode":"shared"}})
                .to_string(),
            ),
        )
        .await;
    assert_eq!(frames.last().unwrap()["data"]["outcome"], "started");
    let session = frames.last().unwrap()["data"]["session"]["sessionId"].clone();
    assert!(matches!(
        peers.finish(desktop.event()).await,
        Event::Mode(1)
    ));
    assert!(vnc.handle(&ably_subscriber::Message {
        name: Some("vnc-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: Some(1)
    }));
    let revoked = h
        .raw(
            json!({"version":1,"method":"vnc.session.status","remaining_ms":60000,
        "params":{"sessionId":session}})
            .to_string(),
        )
        .await;
    assert_eq!(revoked.last().unwrap()["data"]["outcome"], "failed");
    let original = peers.finish(h.request(params())).await;
    assert_eq!(
        original.last().unwrap()["data"]["exit"],
        json!({"type":"status","code":7})
    );
    assert_eq!(
        h.observed.auth.load(Ordering::SeqCst),
        1,
        "SSH must keep its original verified connection"
    );
    assert_eq!(h.observed.commands.lock().unwrap().len(), 2);
    let next = peers
        .finish(
            h.raw(
                json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,
        "params":{"connectionId":CONNECTION,"mode":"shared"}})
                .to_string(),
            ),
        )
        .await;
    assert_eq!(next.last().unwrap()["data"]["outcome"], "started");
    let next_session = next.last().unwrap()["data"]["session"]["sessionId"].clone();
    assert!(matches!(
        peers.finish(desktop.event()).await,
        Event::Mode(1)
    ));
    let notification = ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":h.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: Some(1),
    };
    assert!(h.runtime.handle(&notification));
    assert!(vnc.handle(&notification));
    let input = peers
        .finish(
            h.raw(
                json!({"version":1,"method":"vnc.input","remaining_ms":60000,
        "params":{"sessionId":next_session,"input":{"type":"key_chord","keys":["Enter"]}}})
                .to_string(),
            ),
        )
        .await;
    assert_eq!(input.last().unwrap()["data"]["outcome"], "sent");
    for expected in [
        vec![4, 1, 0, 0, 0, 0, 255, 13],
        vec![4, 0, 0, 0, 0, 0, 255, 13],
    ] {
        match peers.finish(desktop.event()).await {
            Event::Input(actual) => assert_eq!(actual, expected),
            _ => panic!("expected original VNC connection input after SSH retirement"),
        }
    }
    let closed = h
        .raw(
            json!({"version":1,"method":"vnc.session.close","remaining_ms":60000,
        "params":{"sessionId":next_session}})
            .to_string(),
        )
        .await;
    assert_eq!(closed.last().unwrap()["data"]["outcome"], "closed");
    ssh_resolve.assert_calls_async(1).await;
    resolve.assert_calls_async(2).await;
    check.assert_calls_async(4).await;
    api.assert_contract(1, 0);
    h.shutdown().await;
    ssh_proxy.abort();
    vnc_proxy.abort();
    assert!(ssh_proxy.await.unwrap_err().is_cancelled());
    assert!(vnc_proxy.await.unwrap_err().is_cancelled());
    assert_eq!(control.logout_count(), 1);
    api.finish().await;
    control.finish().await;
}
