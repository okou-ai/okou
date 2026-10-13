use std::sync::Arc;

use ably_subscriber::Message;
use runner_provider::AblySideMessageHandler;
use runner_types::ids::RunId;
use serde_json::{Value, json};

use super::{
    closed,
    harness::{CONNECTION, Harness, TestRun, read, send},
    mode,
    peer::Peer,
};
use crate::{
    guest_rpc::Runtime,
    test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response},
};

const OTHER: &str = "58629e7e-6504-46f7-a294-ce1732b83b82";

fn message(topic: &str, data: Value) -> Message {
    Message {
        name: Some(topic.into()),
        data,
        id: None,
        client_id: None,
        timestamp: Some(1),
    }
}

fn runtime(h: &Harness) -> Runtime {
    Runtime {
        ssh: None,
        vnc: Some(Arc::clone(&h.runtime)),
        usage: None,
    }
}

#[tokio::test]
async fn delivered_vnc_invalidation_is_connection_and_run_scoped_and_never_grants_access() {
    let mut h = Harness::new().await;
    let resolve = h.resolve().await;
    let _other_resolve = h.resolve_connection(OTHER).await;
    let _check = h.check("valid", 200).await;
    let _other_check = h.check_connection(OTHER, "valid", 200).await;
    let mut other_run = TestRun::new(&h.runtime);
    let first = h.start("shared").await.session();
    mode(&h, 1).await;
    let second = h
        .run
        .request(
            "vnc.session.start",
            json!({"connectionId":OTHER,"mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    let independent = other_run
        .request(
            "vnc.session.start",
            json!({"connectionId":CONNECTION,"mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    let runtime = runtime(&h);
    for topic in ["vnc-authority-invalidated", "ssh-authority-invalidated"] {
        for data in [
            json!({"runId":h.run.id}),
            json!({"runId":h.run.id,"connectionId":"invalid"}),
            json!({"runId":"invalid","connectionId":null}),
            json!({"runId":h.run.id,"connectionId":null,"unexpected":true}),
            json!({"runId":RunId::new_v4(),"connectionId":null}),
            json!({"runId":h.run.id,"connectionId":uuid::Uuid::new_v4()}),
        ] {
            assert!(runtime.handle(&message(topic, data)));
        }
    }
    assert!(!runtime.handle(&message(
        "unknown",
        json!({"runId":h.run.id,"connectionId":null})
    )));
    // An all-SSH event has no dependent route in these direct VNC sessions.
    assert!(runtime.handle(&message(
        "ssh-authority-invalidated",
        json!({"runId":h.run.id,"connectionId":null})
    )));
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    for _ in 0..2 {
        assert!(runtime.handle(&message(
            "vnc-authority-invalidated",
            json!({"runId":h.run.id,"connectionId":CONNECTION})
        )));
    }
    closed(&h).await;
    let listed = h.run.request("vnc.session.list", json!({})).await;
    assert_eq!(
        listed.result()["sessions"],
        json!([{"sessionId":second,"connectionId":OTHER,"mode":"shared"}])
    );
    assert_eq!(
        other_run
            .request("vnc.session.status", json!({"sessionId":independent}))
            .await
            .result()["outcome"],
        "status"
    );
    assert!(runtime.handle(&message(
        "vnc-authority-invalidated",
        json!({"runId":h.run.id,"connectionId":null})
    )));
    closed(&h).await;
    assert_eq!(
        h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
        json!([])
    );
    assert_eq!(
        h.run
            .request("vnc.session.status", json!({"sessionId":first}))
            .await
            .result()["reason"],
        "session_not_found"
    );
    assert!(!h.run.cancel.is_cancelled());
    resolve.delete_async().await;
    let denied = h.resolve_response(json!({"outcome":"unavailable"})).await;
    assert_eq!(h.start("shared").await.result()["reason"], "unavailable");
    denied.assert_calls_async(1).await;
    other_run.shutdown().await;
    closed(&h).await;
    h.run.shutdown().await;
}

#[tokio::test]
async fn invalidation_cancels_pending_resolve_and_final_check_without_admitting_a_session() {
    for during_check in [false, true] {
        let peer = Peer::new().await;
        let resolved = json_response(
            "200 OK",
            &json!({
                "outcome":"resolved_transport","host":"vnc.example.test","port":5900,"generation":7,
                "serverName":"vnc.example.test","transport":{"type":"direct"},
                "authentication":{"method":"vnc_password","password":" secret "},
                "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":peer.ca}}
            })
            .to_string(),
        );
        let mut actions = Vec::new();
        if during_check {
            actions.push(RawHttpAction::Respond(resolved));
        }
        actions.push(RawHttpAction::WaitForDisconnect);
        actions.push(RawHttpAction::Respond(json_response(
            "200 OK",
            &json!({"outcome":"unavailable"}).to_string(),
        )));
        let mut server = RawHttpTestServer::spawn(actions).await;
        let mut h = Harness::with_authority(peer, Some(server.url())).await;
        let mut guest = h.run.open().await;
        send(
            &mut guest,
            &json!({"version":1,"method":"vnc.session.start","remaining_ms":60000,
            "params":{"connectionId":CONNECTION,"mode":"shared"}})
            .to_string(),
        )
        .await;
        server.next_request("pending resolve").await;
        if during_check {
            mode(&h, 1).await;
            server.next_request("pending final check").await;
        }
        assert!(runtime(&h).handle(&message(
            "vnc-authority-invalidated",
            json!({"runId":h.run.id,"connectionId":CONNECTION})
        )));
        assert_eq!(
            read(guest).await.result(),
            &json!({"outcome":"failed","reason":"cancelled"})
        );
        if during_check {
            closed(&h).await;
        }
        assert!(!h.run.cancel.is_cancelled());
        assert_eq!(
            h.run.request("vnc.session.list", json!({})).await.result()["sessions"],
            json!([])
        );
        // The next start resolves current authority; the notification cannot refill it.
        assert_eq!(h.start("shared").await.result()["reason"], "unavailable");
        server.next_request("current-authority refill").await;
        server.assert_finished().await;
        h.run.shutdown().await;
    }
}

#[tokio::test]
async fn dropping_replaced_run_owner_cannot_unregister_its_successor() {
    let mut h = Harness::new().await;
    let _resolve = h.resolve().await;
    let _check = h.check("valid", 200).await;
    h.start("shared").await.session();
    mode(&h, 1).await;
    let mut successor = TestRun::with_id(&h.runtime, h.run.id);
    closed(&h).await;
    h.run.shutdown().await;
    let session = successor
        .request(
            "vnc.session.start",
            json!({"connectionId":CONNECTION,"mode":"shared"}),
        )
        .await
        .session();
    mode(&h, 1).await;
    assert!(runtime(&h).handle(&message(
        "vnc-authority-invalidated",
        json!({"runId":successor.id,"connectionId":CONNECTION})
    )));
    closed(&h).await;
    assert_eq!(
        successor
            .request("vnc.session.status", json!({"sessionId":session}))
            .await
            .result()["reason"],
        "session_not_found"
    );
    assert!(!successor.cancel.is_cancelled());
    successor.shutdown().await;
}
