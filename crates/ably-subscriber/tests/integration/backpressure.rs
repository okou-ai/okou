use crate::support::*;
use ably_subscriber::protocol::{ErrorInfo, ProtocolMessage, action, encode_msg};
use ably_subscriber::{SubscribeConfig, TimingConfig, subscribe};
use futures_util::SinkExt;
use httpmock::prelude::*;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

#[tokio::test]
async fn token_renewal_error_with_undrained_events_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    let short_token = serde_json::json!({
        "token": "short-lived-token",
        "expires": now + 1_000,
        "issued": now,
    });
    let path = "/keys/testKey.testId/requestToken";
    http.mock(|when, then| {
        when.method(POST).path(path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(short_token);
    });

    let ws_port = ws.port;
    let host = format!("127.0.0.1:{ws_port}");
    let rest_host = format!("127.0.0.1:{}", http.port());
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let call_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let cc = call_count.clone();
    let mut config = SubscribeConfig::new(
        Box::new(move || {
            let n = cc.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async move {
                if n > 0 {
                    return Err("simulated token fetch failure".into());
                }
                Ok(ably_subscriber::TokenRequest {
                    key_name: "testKey.testId".into(),
                    timestamp: now_ms(),
                    nonce: "nonce-1".into(),
                    mac: "fake-mac".into(),
                    capability: r#"{"*":["subscribe"]}"#.into(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        "ch",
    );
    config.host = Some(host);
    config.rest_host = Some(rest_host);
    config.timing = Some({
        let mut t = TimingConfig::default();

        t.max_token_renewal_failures = 1;
        t
    });
    let sub = subscribe(config).await.unwrap();

    // Leave Connected queued: fatal renewal must close without consumer progress.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for socket close before subscription close")
        .unwrap();
    sub.close();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn error_with_undrained_events_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let error = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40000,
                status_code: Some(400),
                message: "bad request".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error).unwrap().into(),
        ))
        .await
        .unwrap();

        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let timing = TimingConfig::default();

    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Leave Connected queued: a fatal error must close without consumer progress.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for socket close before subscription close")
        .unwrap();
    sub.close();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn channel_error_with_undrained_events_closes_socket_before_subscription_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let error = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 40001,
                status_code: Some(400),
                message: "channel failed".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error).unwrap().into(),
        ))
        .await
        .unwrap();

        expect_websocket_close_frame(&mut conn).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let timing = TimingConfig::default();

    let sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    // Leave Connected queued: channel failure must close without consumer progress.
    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for channel error socket close")
        .unwrap();
    sub.close();
    join_server_task(server_task, "mock server").await.unwrap();
}
