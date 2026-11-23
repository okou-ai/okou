use crate::support::*;
use ably_subscriber::protocol::{ErrorInfo, ProtocolMessage, action, encode_msg};
use ably_subscriber::{Event, SubscribeConfig, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

struct ReconnectUriCapture(tokio::sync::mpsc::UnboundedSender<String>);

impl tungstenite::handshake::server::Callback for ReconnectUriCapture {
    fn on_request(
        self,
        request: &tungstenite::handshake::server::Request,
        response: tungstenite::handshake::server::Response,
    ) -> Result<
        tungstenite::handshake::server::Response,
        tungstenite::handshake::server::ErrorResponse,
    > {
        let _ = self.0.send(request.uri().to_string());
        Ok(response)
    }
}

fn test_config_with_token_provider_count(
    ws_port: u16,
    http_port: u16,
    timing: TimingConfig,
) -> (SubscribeConfig, Arc<AtomicU32>) {
    let mut config = test_config_with_timing(ws_port, http_port, "ch", timing);
    let calls = Arc::new(AtomicU32::new(0));
    let calls_for_provider = calls.clone();
    config.get_token = Box::new(move || {
        calls_for_provider.fetch_add(1, Ordering::Relaxed);
        Box::pin(async {
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
    });
    (config, calls)
}

fn mock_token_sequence<'a>(server: &'a MockServer, tokens: Vec<(&'static str, i64)>) -> Mock<'a> {
    let bodies = tokens
        .into_iter()
        .map(|(token, expires)| {
            serde_json::json!({
                "token": token,
                "expires": expires,
                "issued": now_ms(),
            })
            .to_string()
            .into_bytes()
        })
        .collect::<Vec<_>>();
    let call_count = std::sync::Mutex::new(0usize);
    server.mock(|when, then| {
        when.method(POST).path("/keys/testKey.testId/requestToken");
        then.respond_with(move |_request: &HttpMockRequest| {
            let mut count = call_count
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let body = bodies
                .get(*count)
                .or_else(|| bodies.last())
                .cloned()
                .unwrap_or_default();
            *count += 1;
            HttpMockResponse::builder()
                .status(201)
                .header("content-type", "application/json")
                .body(body)
                .build()
        });
    })
}

async fn accept_reconnect(
    ws: &MockAblyServer,
    uri_tx: tokio::sync::mpsc::UnboundedSender<String>,
) -> Result<WsStream, Box<dyn std::error::Error>> {
    let (tcp, _) = ws.listener.accept().await?;
    Ok(tokio_tungstenite::accept_hdr_async(tcp, ReconnectUriCapture(uri_tx)).await?)
}

async fn complete_reconnect_handshake(
    conn: &mut WsStream,
    channel: &str,
    connection_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    send_connected(conn, connection_id).await?;

    let attach = expect_protocol_msg(conn, "ATTACH after reconnect").await?;
    assert_eq!(attach.action, action::ATTACH);
    assert_eq!(attach.channel.as_deref(), Some(channel));
    let attached = ProtocolMessage {
        action: action::ATTACHED,
        channel: Some(channel.into()),
        channel_serial: Some("serial-0".into()),
        ..Default::default()
    };
    conn.send(tungstenite::Message::Binary(encode_msg(&attached)?.into()))
        .await?;
    Ok(())
}

async fn disconnect_with_token_error(
    conn: &mut WsStream,
    code: i32,
    message: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let disconnected = ProtocolMessage {
        action: action::DISCONNECTED,
        error: Some(ErrorInfo {
            code,
            status_code: Some(401),
            message: message.into(),
        }),
        ..Default::default()
    };
    conn.send(tungstenite::Message::Binary(
        encode_msg(&disconnected)?.into(),
    ))
    .await?;
    expect_websocket_close_frame(conn).await?;
    Ok(())
}

fn reconnect_query_parameter(uri: &str, name: &str) -> Result<Option<String>, url::ParseError> {
    let url = url::Url::parse(&format!("ws://localhost{uri}"))?;
    Ok(url
        .query_pairs()
        .find(|(query_name, _)| query_name == name)
        .map(|(_, value)| value.into_owned()))
}

#[tokio::test]
async fn reconnect_after_server_drop() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_drop_seen_tx, before_drop_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_reconnect_seen_tx, after_reconnect_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        // First connection
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-drop", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_drop_seen_rx, "before-drop message").await;
        drop(conn);

        // Second connection (after reconnect)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-reconnect", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_reconnect_seen_rx, "after-reconnect message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // First message
    match expect_event(&mut sub, "message before drop").await.unwrap() {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-drop"));
            before_drop_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Disconnected event
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            let reason = reason.expect("dropped stream should include a disconnect reason");
            assert!(
                reason.contains("websocket")
                    || reason.contains("connection")
                    || reason.contains("stream")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Reconnected
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect
    let event = expect_event(&mut sub, "message after reconnect")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect"));
            after_reconnect_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reconnect_immediately_after_close_frame() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_close_seen_tx, before_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        // First connection — send a message then close with a reason
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-close", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_close_seen_rx, "before-close message").await;
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "server maintenance".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        // Second connection after reconnect
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    match expect_event(&mut sub, "message before close")
        .await
        .unwrap()
    {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-close"));
            before_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Disconnected event
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            let reason = reason.expect("close frame should include a disconnect reason");
            assert!(reason.contains("websocket closed code=1000"));
            assert!(reason.contains("server maintenance"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect within 500ms (no backoff), NOT 1-2 seconds
    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect
    let event = expect_event(&mut sub, "message after reconnect")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reconnect_immediately_after_close_frame_no_reason() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (before_close_seen_tx, before_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut conn, "ch", "before-close", serde_json::json!(1))
            .await
            .unwrap();
        wait_for_test_observation(before_close_seen_rx, "before-close message").await;
        // Close without reason
        conn.close(None).await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    match expect_event(&mut sub, "message before close")
        .await
        .unwrap()
    {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("before-close"));
            before_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("websocket closed without close frame")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect within 500ms (no backoff)
    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after reconnect")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reconnect_after_close_frame_empty_reason_reports_code_only() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_close_seen_tx, after_close_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "after-close", serde_json::json!(2))
            .await
            .unwrap();
        wait_for_test_observation(after_close_seen_rx, "after-close message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("websocket closed code=1000"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = tokio::time::timeout(Duration::from_millis(500), sub.next())
        .await
        .expect("reconnect took too long — backoff was not skipped")
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after reconnect")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-close"));
            after_close_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn repeated_clean_close_reconnect_is_rate_limited() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_rate_limit_seen_tx, after_rate_limit_seen_rx) =
        tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        conn.close(Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "rotate".into(),
        }))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        conn2
            .close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "rotate-again".into(),
            }))
            .await
            .unwrap();
        expect_websocket_close_frame(&mut conn2).await.unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(250), ws.accept_raw())
                .await
                .is_err(),
            "third reconnect should wait for the minimum reconnect interval"
        );

        let mut conn3 = tokio::time::timeout(
            Duration::from_secs(5),
            ws.accept_and_handshake("ch", "conn-3"),
        )
        .await
        .expect("third reconnect did not happen")
        .unwrap();
        send_message(&mut conn3, "ch", "after-rate-limit", serde_json::json!(3))
            .await
            .unwrap();
        wait_for_test_observation(after_rate_limit_seen_rx, "after-rate-limit message").await;
    });

    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::from_secs(1);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    assert!(matches!(
        expect_event(&mut sub, "Disconnected after clean close")
            .await
            .unwrap(),
        Event::Disconnected { .. }
    ));
    assert!(matches!(
        expect_event_with_timeout(&mut sub, Duration::from_secs(1), "first reconnect")
            .await
            .unwrap(),
        Event::Connected
    ));
    assert!(matches!(
        expect_event(&mut sub, "Disconnected after second clean close")
            .await
            .unwrap(),
        Event::Disconnected { .. }
    ));

    let event = expect_event(&mut sub, "rate-limited reconnect")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "post-reconnect message")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-rate-limit"));
            after_rate_limit_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn server_sends_disconnected() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Send DISCONNECTED (retriable)
        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server going away".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected).unwrap().into(),
        ))
        .await
        .unwrap();

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after protocol DISCONNECTED")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

        // Second connection
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        send_message(&mut conn2, "ch", "reconnected", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Disconnected
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("server going away"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Reconnected
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message
    let event = expect_event(&mut sub, "reconnected message").await.unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("reconnected")),
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn server_sends_disconnected_without_message_reports_reason() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (reconnected_seen_tx, reconnected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let disconnected_without_error = ProtocolMessage {
            action: action::DISCONNECTED,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected_without_error).unwrap().into(),
        ))
        .await
        .unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();

        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        let disconnected_without_message = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: String::new(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&disconnected_without_message).unwrap().into(),
            ))
            .await
            .unwrap();
        expect_websocket_close_frame(&mut conn2).await.unwrap();

        let mut conn3 = ws.accept_and_handshake("ch", "conn-3").await.unwrap();
        send_message(&mut conn3, "ch", "reconnected", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(reconnected_seen_rx, "reconnected message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected without error details")
        .await
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("server sent DISCONNECTED without error details")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "Disconnected with empty message")
        .await
        .unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(
                reason.as_deref(),
                Some("server sent DISCONNECTED code=80003 status=500")
            );
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "reconnected message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("reconnected"));
            reconnected_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn disconnected_event_is_not_delayed_by_transport_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (event_seen_tx, event_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server going away".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&disconnected).unwrap().into(),
        ))
        .await
        .unwrap();

        event_seen_rx.await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.close_timeout = Duration::from_secs(5);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = tokio::time::timeout(Duration::from_millis(250), sub.next())
        .await
        .expect("Disconnected should not wait for transport close")
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );
    event_seen_tx.send(()).unwrap();
    sub.close();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn token_expired_disconnected_refreshes_token_and_resumes() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();

    let now = now_ms();
    let token_mock = mock_token_sequence(
        &http,
        vec![
            ("expired-token", now + 3_600_000),
            ("refreshed-token", now + 3_600_000),
        ],
    );

    let ws_port = ws.port;
    let (after_reconnect_seen_tx, after_reconnect_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (reconnect_uri_tx, mut reconnect_uri_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Expire the active token before its local expiry timestamp.
        disconnect_with_token_error(&mut conn, 40142, "Token expired")
            .await
            .unwrap();

        let mut conn2 = accept_reconnect(&ws, reconnect_uri_tx).await.unwrap();
        complete_reconnect_handshake(&mut conn2, "ch", "conn-1")
            .await
            .unwrap();

        send_message(
            &mut conn2,
            "ch",
            "after-token-refresh",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(after_reconnect_seen_rx, "after-token-refresh message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Should get Disconnected (not Error)
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    match event {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("Token expired"));
        }
        other => panic!("expected Disconnected, got {other:?}"),
    }

    // Should reconnect
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after reconnect proves subscription is alive
    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-token-refresh"));
            after_reconnect_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    let reconnect_uri = reconnect_uri_rx.recv().await.unwrap();
    let access_token = reconnect_query_parameter(&reconnect_uri, "access_token").unwrap();
    let resume = reconnect_query_parameter(&reconnect_uri, "resume").unwrap();
    assert_eq!(access_token.as_deref(), Some("refreshed-token"));
    assert_eq!(resume.as_deref(), Some("conn-1!key"));
    token_mock.assert_calls(2);
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn fresh_reconnect_token_is_reused_across_transport_failures() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    let now = now_ms();
    let token_mock = mock_token_sequence(
        &http,
        vec![
            ("initial-token", now + 3_600_000),
            ("pending-token", now + 3_600_000),
        ],
    );

    let (uri_tx, mut uri_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        disconnect_with_token_error(&mut conn, 40142, "Token expired")
            .await
            .unwrap();

        let failed = accept_reconnect(&ws, uri_tx.clone()).await.unwrap();
        drop(failed);
        let failed_again = accept_reconnect(&ws, uri_tx.clone()).await.unwrap();
        drop(failed_again);

        let mut recovered = accept_reconnect(&ws, uri_tx).await.unwrap();
        complete_reconnect_handshake(&mut recovered, "ch", "conn-2")
            .await
            .unwrap();
        send_message(
            &mut recovered,
            "ch",
            "after-pending-token-reuse",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "pending-token reuse assertions").await;
    });

    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::ZERO;
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let (config, provider_calls) =
        test_config_with_token_provider_count(ws_port, http.port(), timing);
    let mut sub = subscribe(config).await.unwrap();

    expect_connected(&mut sub, "initial Connected event")
        .await
        .unwrap();
    let event = expect_event(&mut sub, "token-expired Disconnected event")
        .await
        .unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "reconnected")
        .await
        .unwrap();
    assert!(matches!(event, Event::Connected));
    let event = expect_event(&mut sub, "message after pending-token reuse")
        .await
        .unwrap();
    assert!(matches!(
        event,
        Event::Message(ref message)
            if message.name.as_deref() == Some("after-pending-token-reuse")
    ));

    let reconnect_uris = [
        uri_rx.recv().await.unwrap(),
        uri_rx.recv().await.unwrap(),
        uri_rx.recv().await.unwrap(),
    ];
    for uri in &reconnect_uris {
        assert_eq!(
            reconnect_query_parameter(uri, "access_token")
                .unwrap()
                .as_deref(),
            Some("pending-token")
        );
    }
    assert_eq!(provider_calls.load(Ordering::Relaxed), 2);
    token_mock.assert_calls(2);

    message_seen_tx.send(()).unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn rejected_reconnect_tokens_are_replaced() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    let now = now_ms();
    let token_mock = mock_token_sequence(
        &http,
        vec![
            ("initial-token", now + 3_600_000),
            ("rejected-token", now + 3_600_000),
            ("replacement-token", now + 3_600_000),
        ],
    );

    let (uri_tx, mut uri_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let mut committed_rejected = accept_reconnect(&ws, uri_tx.clone()).await.unwrap();
        let error = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40143,
                status_code: Some(401),
                message: "Token not recognized".into(),
            }),
            ..Default::default()
        };
        committed_rejected
            .send(tungstenite::Message::Binary(
                encode_msg(&error.clone()).unwrap().into(),
            ))
            .await
            .unwrap();
        drop(committed_rejected);

        let mut pending_rejected = accept_reconnect(&ws, uri_tx.clone()).await.unwrap();
        send_connected(&mut pending_rejected, "conn-2")
            .await
            .unwrap();
        let attach = expect_protocol_msg(&mut pending_rejected, "ATTACH with rejected token")
            .await
            .unwrap();
        assert_eq!(attach.action, action::ATTACH);
        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 40143,
                status_code: Some(401),
                message: "Token not recognized".into(),
            }),
            ..Default::default()
        };
        pending_rejected
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();
        drop(pending_rejected);

        let mut recovered = accept_reconnect(&ws, uri_tx).await.unwrap();
        complete_reconnect_handshake(&mut recovered, "ch", "conn-2")
            .await
            .unwrap();
        send_message(
            &mut recovered,
            "ch",
            "after-pending-token-rejection",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "pending-token rejection assertions").await;
    });

    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::ZERO;
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let (config, provider_calls) =
        test_config_with_token_provider_count(ws_port, http.port(), timing);
    let mut sub = subscribe(config).await.unwrap();

    expect_connected(&mut sub, "initial Connected event")
        .await
        .unwrap();
    let event = expect_event(&mut sub, "transport Disconnected event")
        .await
        .unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "reconnected")
        .await
        .unwrap();
    assert!(matches!(event, Event::Connected));
    let event = expect_event(&mut sub, "message after pending-token rejection")
        .await
        .unwrap();
    assert!(matches!(
        event,
        Event::Message(ref message)
            if message.name.as_deref() == Some("after-pending-token-rejection")
    ));

    let committed_uri = uri_rx.recv().await.unwrap();
    let rejected_uri = uri_rx.recv().await.unwrap();
    let replacement_uri = uri_rx.recv().await.unwrap();
    assert_eq!(
        reconnect_query_parameter(&committed_uri, "access_token")
            .unwrap()
            .as_deref(),
        Some("initial-token")
    );
    assert_eq!(
        reconnect_query_parameter(&rejected_uri, "access_token")
            .unwrap()
            .as_deref(),
        Some("rejected-token")
    );
    assert_eq!(
        reconnect_query_parameter(&replacement_uri, "access_token")
            .unwrap()
            .as_deref(),
        Some("replacement-token")
    );
    assert_eq!(provider_calls.load(Ordering::Relaxed), 3);
    token_mock.assert_calls(3);

    message_seen_tx.send(()).unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn pending_reconnect_token_is_replaced_at_renewal_boundary() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    let now = now_ms();
    let token_mock = mock_token_sequence(
        &http,
        vec![
            ("initial-token", now + 3_600_000),
            ("short-lived-token", now + 200),
            ("replacement-token", now + 3_600_000),
        ],
    );

    let (uri_tx, mut uri_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        disconnect_with_token_error(&mut conn, 40142, "Token expired")
            .await
            .unwrap();

        let failed = accept_reconnect(&ws, uri_tx.clone()).await.unwrap();
        drop(failed);

        let mut recovered = accept_reconnect(&ws, uri_tx).await.unwrap();
        complete_reconnect_handshake(&mut recovered, "ch", "conn-2")
            .await
            .unwrap();
        send_message(
            &mut recovered,
            "ch",
            "after-pending-token-renewal",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "pending-token renewal assertions").await;
    });

    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::ZERO;
    timing.disconnected_retry_timeout = Duration::from_millis(400);
    let (config, provider_calls) =
        test_config_with_token_provider_count(ws_port, http.port(), timing);
    let mut sub = subscribe(config).await.unwrap();

    expect_connected(&mut sub, "initial Connected event")
        .await
        .unwrap();
    let event = expect_event(&mut sub, "token-expired Disconnected event")
        .await
        .unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "reconnected")
        .await
        .unwrap();
    assert!(matches!(event, Event::Connected));
    let event = expect_event(&mut sub, "message after pending-token renewal")
        .await
        .unwrap();
    assert!(matches!(
        event,
        Event::Message(ref message)
            if message.name.as_deref() == Some("after-pending-token-renewal")
    ));

    let short_lived_uri = uri_rx.recv().await.unwrap();
    let replacement_uri = uri_rx.recv().await.unwrap();
    assert_eq!(
        reconnect_query_parameter(&short_lived_uri, "access_token")
            .unwrap()
            .as_deref(),
        Some("short-lived-token")
    );
    assert_eq!(
        reconnect_query_parameter(&replacement_uri, "access_token")
            .unwrap()
            .as_deref(),
        Some("replacement-token")
    );
    assert_eq!(provider_calls.load(Ordering::Relaxed), 3);
    token_mock.assert_calls(3);

    message_seen_tx.send(()).unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn retry_enters_suspended_after_connection_state_ttl() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        // First connection: handshake then drop
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 20,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(conn);
        // Drop the server so the port is unbound — reconnects fail with
        // "connection refused" immediately instead of hanging on the listener.
        drop(ws);
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Disconnected
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );
    join_server_task(server_task, "mock server").await.unwrap();

    // ably-js does not exhaust reconnect attempts. Once the connection state
    // TTL expires, it moves to suspended retry and keeps trying fresh connects.
    expect_event_matching_before(
        async || sub.next().await,
        Instant::now() + RECONNECT_EVENT_TIMEOUT,
        "Disconnected reason containing connection state expired",
        |event| match event {
            Event::Disconnected { reason }
                if reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("connection state expired")) =>
            {
                Ok(true)
            }
            Event::Disconnected { .. } => Ok(false),
            other => Err(format!(
                "expected Disconnected while retrying, got {other:?}"
            )),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn suspended_retry_reconnect_attach_uses_resume_without_serial() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (suspended_seen_tx, suspended_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 20,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(conn);

        let mut suspended_seen_rx = suspended_seen_rx;
        tokio::time::timeout(RECONNECT_EVENT_TIMEOUT, async {
            loop {
                tokio::select! {
                    biased;
                    result = &mut suspended_seen_rx => {
                        result.unwrap();
                        break;
                    }
                    accept_result = ws.listener.accept() => {
                        let (tcp, _) = accept_result.unwrap();
                        drop(tcp);
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for suspended transition signal");

        let mut conn2 = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (tcp, _) = ws.listener.accept().await.unwrap();
                match tokio_tungstenite::accept_async(tcp).await {
                    Ok(conn) => break conn,
                    Err(_) => continue,
                }
            }
        })
        .await
        .expect("timed out waiting for post-suspended reconnect");
        send_connected(&mut conn2, "conn-2").await.unwrap();

        let msg = expect_protocol_msg(&mut conn2, "suspended retry ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-after-suspended-retry".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();
        send_message(
            &mut conn2,
            "ch",
            "after-suspended-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-suspended-retry message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let suspended_transition = expect_event_matching_before(
        async || sub.next().await,
        Instant::now() + RECONNECT_EVENT_TIMEOUT,
        "Disconnected reason containing connection state expired",
        |event| match event {
            Event::Disconnected { reason }
                if reason
                    .as_deref()
                    .is_some_and(|reason| reason.contains("connection state expired")) =>
            {
                Ok(true)
            }
            Event::Disconnected { .. } => Ok(false),
            other => Err(format!(
                "expected Disconnected while retrying, got {other:?}"
            )),
        },
    )
    .await;
    match suspended_transition {
        Ok(_) => suspended_seen_tx.send(()).unwrap(),
        Err(error) => {
            sub.close();
            if let Err(cleanup_error) = abort_server_task(server_task, "mock server").await {
                panic!("{error}; cleanup failed: {cleanup_error}");
            }
            panic!("{error}");
        }
    }

    let event = expect_event(&mut sub, "Connected after suspended retry")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after suspended retry, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after suspended retry")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-suspended-retry"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn non_positive_ttl_keeps_default_resume_window() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    let token_path = "/keys/testKey.testId/requestToken";
    let now = now_ms();
    let token_mock = http.mock(|when, then| {
        when.method(POST).path(token_path);
        then.status(201)
            .header("content-type", "application/json")
            .json_body(serde_json::json!({
                "token": "mock-token-abc",
                "expires": now + 3_600_000,
                "issued": now,
                "capability": "{\"*\":[\"*\"]}",
            }));
    });

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        // Non-positive connectionStateTtl should be treated as absent, not as
        // an already-expired resume window.
        let conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    connection_state_ttl_ms: 0,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(conn);

        let mut conn2 = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        send_message(
            &mut conn2,
            "ch",
            "after-default-ttl-resume",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-default-ttl-resume message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.suspended_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Wait for reconnection
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));

    let connected = expect_event_matching_before(
        async || sub.next().await,
        Instant::now() + RECONNECT_EVENT_TIMEOUT,
        "Connected",
        |event| match event {
            Event::Connected => Ok(true),
            Event::Disconnected { .. } => Ok(false),
            other => Err(format!("expected Connected, got {other:?}")),
        },
    )
    .await;
    if let Err(error) = connected {
        sub.close();
        if let Err(cleanup_error) = abort_server_task(server_task, "mock server").await {
            panic!("{error}; cleanup failed: {cleanup_error}");
        }
        panic!("{error}");
    }

    // Message after reconnect proves the subscription is still alive.
    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-default-ttl-resume"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    token_mock.assert_calls(1);
    join_server_task(server_task, "mock server").await.unwrap();
}

/// Regression test: when the server returns the same connection_id (resume),
/// the client must still send ATTACH. Before the fix, resumed connections
/// skipped ATTACH entirely, creating "zombie subscriptions" where the channel
/// silently lost state and messages stopped being delivered.
#[tokio::test]
async fn resumed_connection_reattaches_channel() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (attach_tx, attach_rx) = tokio::sync::oneshot::channel::<bool>();
    let (connected_seen_tx, connected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        // First connection
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        wait_for_test_observation(connected_seen_rx, "initial Connected event").await;
        drop(conn);

        // Second connection — use the SAME conn_id to simulate a successful resume.
        // The client should still send ATTACH despite the resume.
        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut ws_stream = tokio_tungstenite::accept_async(tcp).await.unwrap();

        // Send CONNECTED with the same connection_id → client sees this as resume
        send_connected(&mut ws_stream, "conn-1").await.unwrap();

        // Client should send ATTACH even though connection was resumed.
        let msg = expect_protocol_msg(&mut ws_stream, "ATTACH after resumed CONNECTED")
            .await
            .unwrap();
        assert_eq!(
            msg.action,
            action::ATTACH,
            "client must send ATTACH on resume"
        );
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);
        let _ = attach_tx.send(true);

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-resumed".into()),
            ..Default::default()
        };
        ws_stream
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();

        // Send a message to prove the subscription is alive
        send_message(
            &mut ws_stream,
            "ch",
            "after-resume",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-resume message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    connected_seen_tx.send(()).unwrap();

    // Wait for disconnect → reconnect cycle
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));

    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(matches!(event, Event::Connected));

    // Message after resumed reconnect proves subscription is alive
    let event = expect_event(&mut sub, "message after resume")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-resume"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    // Verify server saw ATTACH (meaning client re-attached despite resume)
    let did_attach = attach_rx.await.expect("server task panicked");
    assert!(
        did_attach,
        "client must send ATTACH even on resumed connection"
    );
    join_server_task(server_task, "mock server").await.unwrap();
}
