use serde_json::{Value, json};
use tokio::{io::DuplexStream, sync::oneshot};

use super::{
    closed,
    harness::{CONNECTION, Harness, read, send},
    mode,
    peer::{Event, Peer},
};
use crate::test_fixtures::raw_http::{RawHttpAction, RawHttpTestServer, json_response};

struct PendingList {
    harness: Harness,
    server: RawHttpTestServer,
    guest: DuplexStream,
    checking: Value,
    waiting: Value,
}

impl PendingList {
    async fn start(gate: RawHttpAction, subsequent_checks: usize, remaining_ms: u64) -> Self {
        let peer = Peer::new().await;
        let resolved = json_response(
            "200 OK",
            &json!({"outcome":"resolved","host":"vnc.example.test","port":5900,"generation":7,
                "authentication":{"method":"vnc_password","password":" secret "},
                "security":{"type":"x509_vnc","trust":{"mode":"custom_ca","caBundle":peer.ca}}})
            .to_string(),
        );
        let mut actions = Vec::new();
        for _ in 0..2 {
            actions.push(RawHttpAction::Respond(resolved.clone()));
            actions.push(valid());
        }
        actions.push(gate);
        actions.extend((0..subsequent_checks).map(|_| valid()));
        let mut server = RawHttpTestServer::spawn(actions).await;
        let h = Harness::with_authority(peer, Some(server.url())).await;
        let mut sessions = Vec::new();
        for connection in [CONNECTION, "58629e7e-6504-46f7-a294-ce1732b83b82"] {
            let started = h
                .run
                .request(
                    "vnc.session.start",
                    json!({"connectionId":connection,"mode":"shared"}),
                )
                .await;
            started.session();
            sessions.push(started.result()["session"].clone());
            mode(&h, 1).await;
            server.next_request("resolve before session start").await;
            server.next_request("check after session start").await;
        }
        let mut guest = h.run.open().await;
        send(
            &mut guest,
            &json!({"version":1,"method":"vnc.session.list","remaining_ms":remaining_ms,"params":{}})
                .to_string(),
        )
        .await;
        let request = server.next_request("first list authority check").await;
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(body).unwrap();
        let first = sessions
            .iter()
            .position(|session| session["connectionId"] == body["connectionId"])
            .unwrap();
        let checking = sessions.remove(first);
        Self {
            harness: h,
            server,
            guest,
            checking,
            waiting: sessions.pop().unwrap(),
        }
    }
}

fn valid() -> RawHttpAction {
    RawHttpAction::Respond(json_response("200 OK", r#"{"outcome":"valid"}"#))
}

async fn list_during_close(close_checking: bool) {
    let (release, gate) = oneshot::channel();
    let action = if close_checking {
        RawHttpAction::WaitForDisconnect
    } else {
        RawHttpAction::WaitThenRespond {
            release: gate,
            response: json_response("200 OK", r#"{"outcome":"valid"}"#),
        }
    };
    let PendingList {
        mut harness,
        server,
        guest,
        checking,
        waiting,
    } = PendingList::start(action, if close_checking { 2 } else { 1 }, 60000).await;
    let (closing, surviving) = if close_checking {
        (checking, waiting)
    } else {
        (waiting, checking)
    };
    let closed_reply = harness
        .run
        .request(
            "vnc.session.close",
            json!({"sessionId":closing["sessionId"]}),
        )
        .await;
    assert_eq!(closed_reply.result()["outcome"], "closed");
    closed(&harness).await;
    if !close_checking {
        release.send(()).unwrap();
    }
    let listed = read(guest).await;
    assert_eq!(
        listed.result(),
        &json!({"outcome":"listed","sessions":[surviving.clone()]})
    );
    let capture = harness
        .run
        .request("vnc.capture", json!({"sessionId":surviving["sessionId"]}))
        .await;
    assert_eq!(capture.result()["outcome"], "captured");
    assert!(capture.ended);
    assert!(matches!(harness.peer.event().await, Event::Capture));
    harness.run.shutdown().await;
    closed(&harness).await;
    server.assert_finished().await;
}

#[tokio::test]
async fn list_omits_a_session_closed_before_its_authority_check() {
    list_during_close(false).await;
}

#[tokio::test]
async fn list_omits_a_session_closed_during_its_authority_check() {
    list_during_close(true).await;
}

#[tokio::test]
async fn list_preserves_run_cancellation() {
    let PendingList {
        mut harness,
        server,
        guest,
        ..
    } = PendingList::start(RawHttpAction::WaitForDisconnect, 0, 60000).await;
    harness.run.cancel.cancel();
    let listed = read(guest).await;
    assert_eq!(listed.result()["outcome"], "failed");
    assert_eq!(listed.result()["reason"], "cancelled");
    harness.run.shutdown().await;
    closed(&harness).await;
    closed(&harness).await;
    server.assert_finished().await;
}

#[tokio::test]
async fn list_preserves_request_deadline() {
    let PendingList {
        mut harness,
        server,
        guest,
        ..
    } = PendingList::start(RawHttpAction::WaitForDisconnect, 0, 2000).await;
    let listed = read(guest).await;
    assert_eq!(listed.result()["outcome"], "failed");
    assert_eq!(listed.result()["reason"], "timed_out");
    closed(&harness).await;
    harness.run.shutdown().await;
    closed(&harness).await;
    server.assert_finished().await;
}
