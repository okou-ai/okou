#![cfg(test)]

use crate::support::*;
use ably_subscriber::protocol::{
    ConnectionDetails, ProtocolMessage, action, encode_msg, error_code,
};
use ably_subscriber::{Error, Event, SubscribeConfig, subscribe};
use futures_util::{FutureExt, SinkExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{
    Message as WsMessage,
    handshake::server::{Callback, ErrorResponse, Request, Response},
};

struct VerifyHeartbeatHandshake(Option<&'static str>);

impl Callback for VerifyHeartbeatHandshake {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        let url = url::Url::parse(&format!("ws://localhost{}", request.uri())).unwrap();
        let intervals: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "heartbeatInterval")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(intervals, ["5000"]);
        assert_eq!(
            url.query_pairs()
                .find(|(key, _)| key == "resume")
                .map(|(_, value)| value.into_owned()),
            self.0.map(str::to_owned)
        );
        Ok(response)
    }
}

async fn accept_requested_heartbeat(
    server: &MockAblyServer,
    connection_id: &str,
    expected_resume: Option<&'static str>,
) -> WsStream {
    let (tcp, _) = server.listener.accept().await.unwrap();
    let mut conn =
        tokio_tungstenite::accept_hdr_async(tcp, VerifyHeartbeatHandshake(expected_resume))
            .await
            .unwrap();
    let connected = ProtocolMessage {
        action: action::CONNECTED,
        connection_id: Some(connection_id.into()),
        connection_key: Some(format!("{connection_id}!key")),
        connection_details: Some(ConnectionDetails {
            max_idle_interval: Some(5_000),
            connection_state_ttl: Some(120_000),
            ..Default::default()
        }),
        ..Default::default()
    };
    conn.send(WsMessage::Binary(encode_msg(&connected).unwrap().into()))
        .await
        .unwrap();
    let attach = expect_protocol_msg(&mut conn, "ATTACH after heartbeat negotiation")
        .await
        .unwrap();
    assert_eq!(attach.action, action::ATTACH);
    assert_eq!(attach.channel.as_deref(), Some("ch"));
    let attached = ProtocolMessage {
        action: action::ATTACHED,
        channel: Some("ch".into()),
        channel_serial: Some("serial-0".into()),
        ..Default::default()
    };
    conn.send(WsMessage::Binary(encode_msg(&attached).unwrap().into()))
        .await
        .unwrap();
    conn
}

#[tokio::test]
async fn requested_heartbeat_survives_reconnect_and_bounds_silent_detection() {
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (observe_close, close_observation) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut conn = accept_requested_heartbeat(&ws, "conn-1", None).await;
        // No real IO deadline is armed while the client advances the idle
        // timer. Resume real time before observing close and reconnect IO.
        close_observation.await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
        conn.flush().await.unwrap();
        drop(conn);

        let mut reconnected = accept_requested_heartbeat(&ws, "conn-2", Some("conn-1!key")).await;
        send_message(&mut reconnected, "ch", "recovered", serde_json::json!("ok"))
            .await
            .unwrap();
        assert_eq!(
            expect_protocol_msg(&mut reconnected, "caller CLOSE")
                .await
                .unwrap()
                .action,
            action::CLOSE
        );
        expect_websocket_close_frame(&mut reconnected)
            .await
            .unwrap();
        reconnected.flush().await.unwrap();
    });

    let mut config = test_config(port, http.port(), "ch");
    config.heartbeat_interval = Some(Duration::from_secs(5));
    let mut sub = subscribe(config).await.unwrap();
    expect_connected(&mut sub, "initial heartbeat-negotiated connection")
        .await
        .unwrap();
    tokio::task::yield_now().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(14)).await;
    assert!(
        sub.next().now_or_never().is_none(),
        "five-second server idle still retains the ten-second network margin"
    );
    tokio::time::resume();
    observe_close.send(()).unwrap();

    // The remaining one second expires on real time. The ordinary five-second
    // IO bound distinguishes negotiated 5+10 seconds from the default 15+10.
    assert!(matches!(
        expect_event(&mut sub, "negotiated idle timeout")
            .await
            .unwrap(),
        Event::Disconnected { .. }
    ));
    expect_connected(&mut sub, "reconnect retaining heartbeat interval")
        .await
        .unwrap();
    match expect_event(&mut sub, "message after heartbeat reconnect")
        .await
        .unwrap()
    {
        Event::Message(message) => assert_eq!(message.name.as_deref(), Some("recovered")),
        other => panic!("expected recovered message, got {other:?}"),
    }
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "heartbeat negotiation peer")
        .await
        .unwrap();
}

#[tokio::test]
async fn invalid_heartbeat_interval_is_rejected_before_token_acquisition() {
    for interval in [Duration::from_secs(4), Duration::from_secs(1801)] {
        let mut config = SubscribeConfig::new(
            Box::new(|| {
                Box::pin(async {
                    Err(std::io::Error::other("unexpected token acquisition").into())
                })
            }),
            "ch",
        );
        config.heartbeat_interval = Some(interval);
        assert!(matches!(
            subscribe(config).await,
            Err(Error::Protocol {
                code: error_code::BAD_REQUEST,
                ..
            })
        ));
    }
}
