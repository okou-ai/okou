use std::{sync::Arc, time::Duration};

use ably_subscriber::Message;
use runner_provider::AblySideMessageHandler;
use runner_types::ids::RunId;
use serde_json::{Value, json};

use super::super::{
    harness::{CONNECTION, Harness, Reply, TOKEN, params},
    sessions::{bytes, rpc, start, state, write},
};
use super::{desktop, terminal};
use crate::{
    guest_rpc::Runtime,
    test_fixtures::http::{HttpClientConfig, http_client},
    vnc::{
        VncRuntime,
        tests::peer::{Event, Peer},
    },
};

const VNC: &str = "2d4b8991-a043-4d4d-a79d-d0051ca09aee";
const OTHER: &str = "58629e7e-6504-46f7-a294-ce1732b83b82";

async fn harness() -> (Harness, Arc<VncRuntime>, Peer) {
    let mut h = Harness::new(Reply::Process).await;
    let vnc = VncRuntime::official(
        http_client(HttpClientConfig {
            api_url: h.api.base_url(),
            vercel_bypass: None,
            client_session_id: "shared-invalidation".into(),
        }),
        TOKEN,
        h.identity,
    )
    .unwrap()
    .unwrap();
    h.restart_with_vnc(Arc::clone(&vnc)).await;
    (h, vnc, Peer::new().await)
}

fn notify(runtime: &Runtime, topic: Option<&str>, data: Value) -> bool {
    runtime.handle(&Message {
        name: topic.map(str::to_owned),
        data,
        id: None,
        client_id: None,
        timestamp: None,
    })
}

async fn vnc_rpc(h: &Harness, method: &str, params: Value) -> Value {
    let frames = h
        .raw(
            json!({"version":1,"method":format!("vnc.{method}"),"remaining_ms":60000,"params":params})
                .to_string(),
        )
        .await;
    terminal(&frames).clone()
}

async fn vnc_input(h: &Harness, peer: &Peer, session: &str) {
    assert_eq!(
        vnc_rpc(
            h,
            "input",
            json!({"sessionId":session,"input":{"type":"text","text":"a"}}),
        )
        .await["outcome"],
        "sent"
    );
    for down in [1, 0] {
        match peer.event().await {
            Event::Input(actual) => assert_eq!(actual, vec![4, down, 0, 0, 0, 0, 0, b'a']),
            _ => panic!("expected keyboard event"),
        }
    }
}

#[tokio::test]
async fn malformed_notifications_preserve_cached_ssh_and_active_ssh_vnc_work() {
    let (mut h, vnc, peer) = harness().await;
    let resolve = h.resolve(h.credential(true)).await;
    let (runtime, session, bridge) = desktop(&h, &peer, VNC, vnc).await;
    assert!(matches!(peer.event().await, Event::Mode(1)));
    let shell = start(&h, json!({"type":"shell"}), false).await;
    state(&h, &shell, "running").await;
    resolve.delete_async().await;
    let unavailable = h.resolve(json!({"outcome":"unavailable"})).await;

    for topic in ["ssh-authority-invalidated", "vnc-authority-invalidated"] {
        for data in [
            json!({"runId":h.run,"connectionId":null,"unexpected":true}),
            json!({"runId":h.run,"connectionId":CONNECTION,"unexpected":true}),
            json!({"runId":h.run}),
            json!({"connectionId":null}),
            json!({"runId":h.run,"connectionId":42}),
            json!({"runId":42,"connectionId":null}),
            json!({"runId":h.run,"connectionId":"invalid"}),
            json!({"runId":"invalid","connectionId":null}),
            Value::Null,
        ] {
            assert!(notify(&runtime, Some(topic), data));
            let mut request = params();
            request["command"] = json!("printf cached");
            let result = h.request(request).await;
            assert_eq!(terminal(&result)["type"], "finished");
            assert_eq!(super::super::output(&result, "stdout"), b"cached");
        }
        state(&h, &shell, "running").await;
        vnc_input(&h, &peer, &session).await;
    }
    for topic in [None, Some("unknown")] {
        assert!(!notify(
            &runtime,
            topic,
            json!({"runId":h.run,"connectionId":null})
        ));
    }
    write(&h, &shell, "printf live; exit 0\n", false).await;
    state(&h, &shell, "finished").await;
    assert_eq!(
        bytes(&rpc(&h, "read", json!({"sessionId":shell,"cursor":0})).await),
        b"live"
    );
    vnc_input(&h, &peer, &session).await;
    unavailable.assert_calls_async(0).await;
    h.shutdown().await;
    tokio::time::timeout(Duration::from_secs(5), bridge)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn shared_notifications_retire_only_selected_ssh_and_dependent_vnc_work() {
    let (mut h, vnc, peer) = harness().await;
    let resolve = h.resolve(h.credential(true)).await;
    let other = h.resolve_connection(OTHER, h.credential(true)).await;
    let (runtime, session, bridge) = desktop(&h, &peer, VNC, Arc::clone(&vnc)).await;
    assert!(matches!(peer.event().await, Event::Mode(1)));
    let shell = start(&h, json!({"type":"shell"}), false).await;
    let independent = rpc(
        &h,
        "start",
        json!({"sshConnectionId":OTHER,"program":{"type":"shell"},"pty":false}),
    )
    .await;
    assert_eq!(independent["type"], "started");
    let independent = independent["session_id"].clone();

    for data in [
        json!({"runId":RunId::new_v4(),"connectionId":null}),
        json!({"runId":h.run,"connectionId":uuid::Uuid::new_v4()}),
    ] {
        assert!(notify(&runtime, Some("ssh-authority-invalidated"), data));
    }
    state(&h, &shell, "running").await;
    state(&h, &independent, "running").await;
    vnc_input(&h, &peer, &session).await;

    assert!(notify(
        &runtime,
        Some("ssh-authority-invalidated"),
        json!({"runId":h.run,"connectionId":CONNECTION})
    ));
    tokio::time::timeout(Duration::from_secs(5), bridge)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(peer.event().await, Event::Closed));
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":shell})).await["failure_reason"],
        "unavailable"
    );
    state(&h, &independent, "running").await;
    assert_eq!(
        vnc_rpc(&h, "session.list", json!({})).await["sessions"],
        json!([])
    );

    // A new desktop must refill the selected SSH authority after its eviction.
    let (_, session, bridge) = desktop(&h, &peer, VNC, vnc).await;
    assert!(matches!(peer.event().await, Event::Mode(1)));
    vnc_input(&h, &peer, &session).await;
    resolve.assert_calls_async(2).await;
    other.assert_calls_async(1).await;
    resolve.delete_async().await;
    other.delete_async().await;
    let unavailable = h.resolve(json!({"outcome":"unavailable"})).await;
    let other_unavailable = h
        .resolve_connection(OTHER, json!({"outcome":"unavailable"}))
        .await;

    assert!(notify(
        &runtime,
        Some("ssh-authority-invalidated"),
        json!({"runId":h.run,"connectionId":null})
    ));
    tokio::time::timeout(Duration::from_secs(5), bridge)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(peer.event().await, Event::Closed));
    assert_eq!(
        rpc(&h, "status", json!({"sessionId":independent})).await["failure_reason"],
        "unavailable"
    );
    assert_eq!(
        vnc_rpc(&h, "session.list", json!({})).await["sessions"],
        json!([])
    );
    for connection in [CONNECTION, OTHER] {
        let mut request = params();
        request["sshConnectionId"] = json!(connection);
        assert_eq!(
            terminal(&h.request(request).await)["failure_reason"],
            "unavailable"
        );
    }
    unavailable.assert_calls_async(1).await;
    other_unavailable.assert_calls_async(1).await;
    assert!(!h.cancel.is_cancelled());
    h.shutdown().await;
}
