use crate::support::*;
use ably_subscriber::protocol::{
    ConnectionDetails, ErrorInfo, ProtocolMessage, action, encode_msg, error_code,
};
use ably_subscriber::{Error, Event, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn websocket_close_assertion_preserves_protocol_error() {
    let ws = MockAblyServer::start().await.unwrap();
    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
        let error = expect_websocket_closed(&mut conn).await.unwrap_err();
        assert!(
            matches!(
                error.downcast_ref::<tungstenite::Error>(),
                Some(tungstenite::Error::Protocol(
                    tungstenite::error::ProtocolError::UnmaskedFrameFromClient
                ))
            ),
            "expected original unmasked-frame protocol error, got {error:?}"
        );
    });

    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", ws_port))
        .await
        .unwrap();
    let (client, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{ws_port}"), tcp)
        .await
        .unwrap();
    let mut tcp = client.into_inner();
    tcp.write_all(&[0x81, 0x00]).await.unwrap();

    join_server_task(server_task, "invalid websocket frame server")
        .await
        .unwrap();
}

#[tokio::test]
async fn close_subscription() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Wait for Ably protocol CLOSE from client.
        let msg = expect_protocol_msg(&mut conn, "CLOSE").await.unwrap();
        assert_eq!(msg.action, action::CLOSE);

        // Then the websocket itself should be closed instead of relying on task
        // drop to release the socket.
        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    sub.close_and_wait().await.unwrap();

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn peer_reset_during_transport_cleanup_is_idempotent() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (reset_tx, reset_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        reset_rx.await.unwrap();
        conn.get_ref().set_zero_linger().unwrap();
        drop(conn);
    });

    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    let mut timing = TimingConfig::default();
    timing.min_reconnect_interval = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    reset_tx.send(()).unwrap();
    let event = expect_event(&mut sub, "peer reset").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let close_result = sub.close_and_wait().await;
    join_server_task(server_task, "resetting mock server")
        .await
        .unwrap();
    let events = captured.entries();
    assert!(
        close_result.is_ok(),
        "peer-already-gone transport cleanup failed: {close_result:?}; events={events:#?}"
    );
    assert!(
        !events.iter().any(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|message| message == "Failed to close websocket transport")
                && event
                    .fields
                    .get("error")
                    .is_some_and(|error| error.contains("Broken pipe"))
        }),
        "peer-already-gone transport cleanup emitted a BrokenPipe warning: {events:#?}"
    );
}

#[tokio::test]
async fn drop_subscription_sends_close() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();

    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let msg = expect_protocol_msg(&mut conn, "CLOSE after drop")
            .await
            .unwrap();
        assert_eq!(msg.action, action::CLOSE);

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after drop")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
        close_tx.send(()).unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    drop(sub);

    tokio::time::timeout(Duration::from_secs(5), close_rx)
        .await
        .expect("timed out waiting for server to confirm drop close")
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

/// ably-js always reconnects on mid-session DISCONNECTED regardless of
/// retriability — the server may send 429 or 401 but still expect the
/// client to backoff-and-retry. Only connection-level ERROR is fatal.

#[tokio::test]
async fn server_sends_closed() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let closed = ProtocolMessage {
            action: action::CLOSED,
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&closed).unwrap().into(),
        ))
        .await
        .unwrap();
        expect_websocket_closed(&mut conn).await.unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Stream should end (CLOSED → LoopAction::Stop)
    expect_subscription_closed(&mut sub, "CLOSED")
        .await
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();

    let error = sub.close_and_wait().await.unwrap_err();
    assert!(
        matches!(
            &error,
            Error::Protocol {
                code: error_code::FAILED,
                ..
            }
        ),
        "expected failed close request, got {error}"
    );
}

#[tokio::test]
async fn error_during_event_loop() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let error_msg = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 40000,
                status_code: Some(400),
                message: "Bad request".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error_msg).unwrap().into(),
        ))
        .await
        .unwrap();
        expect_websocket_closed(&mut conn).await.unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Error").await.unwrap();
    match event {
        Event::Error { code, .. } => assert_eq!(code, 40000),
        other => panic!("expected Error, got {other:?}"),
    }

    expect_subscription_closed(&mut sub, "subscription end")
        .await
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_during_hanging_reconnect_attempt_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (mut tcp, _) = ws.listener.accept().await.unwrap();
        accepted_tx.send(()).unwrap();

        let mut buf = Vec::new();
        let _ = tcp.read_to_end(&mut buf).await;
        let _ = closed_tx.send(());
    });

    let mut timing = TimingConfig::default();
    timing.reconnect_timeout = Duration::from_secs(30);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), accepted_rx)
        .await
        .expect("timed out waiting for hanging reconnect attempt")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(1), closed_rx)
        .await
        .expect("hanging reconnect socket was not closed after subscription close")
        .unwrap();

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_during_protocol_disconnected_reconnect_attempt_closes_sockets() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close after protocol DISCONNECTED")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );

        let (mut tcp, _) = ws.listener.accept().await.unwrap();
        accepted_tx.send(()).unwrap();

        let mut buf = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut buf))
            .await
            .expect("hanging reconnect socket was not closed after subscription close")
            .unwrap();

        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::ZERO;
    timing.reconnect_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = expect_event(&mut sub, "protocol DISCONNECTED")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), accepted_rx)
        .await
        .expect("timed out waiting for reconnect attempt")
        .unwrap();

    sub.close();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for reconnect-attempt close check")
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_during_reconnect_backoff_stops_before_next_attempt() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server = async {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);
        // The first interruption retries immediately; only the next one has
        // a previous reconnect attempt against which to enforce spacing.
        let conn = ws.accept_and_handshake("ch", "conn-2").await.unwrap();
        drop(conn);
    };
    let client = async {
        let mut timing = TimingConfig::default();
        timing.min_reconnect_interval = Duration::from_secs(30);
        let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
            .await
            .unwrap();

        for context in ["initial connection", "reconnected transport"] {
            expect_connected(&mut sub, context).await.unwrap();
            let event = expect_event(&mut sub, "Disconnected").await.unwrap();
            assert!(
                matches!(event, Event::Disconnected { .. }),
                "expected Disconnected, got {event:?}"
            );
        }
        sub.close_and_wait().await.unwrap();
    };
    tokio::time::timeout(TEST_IO_TIMEOUT, async {
        tokio::join!(server, client);
    })
    .await
    .expect("subscription and peer must finish during reconnect backoff");

    // Local close completion retires the reconnect owner; inspect the actual
    // kernel backlog rather than waiting for an arbitrary quiet interval.
    let reconnect = ws.listener.into_std().unwrap().accept();
    assert!(
        matches!(reconnect, Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "subscription reconnected despite close during backoff: {reconnect:?}"
    );
}

#[tokio::test]
async fn close_during_protocol_disconnected_reconnect_backoff_closes_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server = async {
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

        let frame = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .expect("timed out waiting for websocket close during protocol DISCONNECTED backoff")
            .expect("websocket closed before close frame")
            .unwrap();
        assert!(
            matches!(frame, tungstenite::Message::Close(_)),
            "expected websocket close frame, got {frame:?}"
        );
    };
    let client = async {
        let mut timing = TimingConfig::default();
        timing.disconnected_retry_timeout = Duration::from_secs(5);
        let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
            .await
            .unwrap();

        expect_connected(&mut sub, "Connected event").await.unwrap();
        let event = expect_event(&mut sub, "protocol DISCONNECTED")
            .await
            .unwrap();
        assert!(
            matches!(event, Event::Disconnected { .. }),
            "expected Disconnected, got {event:?}"
        );
        sub.close_and_wait().await.unwrap();
    };
    tokio::time::timeout(TEST_IO_TIMEOUT, async {
        tokio::join!(server, client);
    })
    .await
    .expect("subscription and protocol-close peer must finish during backoff");

    let reconnect = ws.listener.into_std().unwrap().accept();
    assert!(
        matches!(reconnect, Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "subscription reconnected despite close after protocol DISCONNECTED: {reconnect:?}"
    );
}

#[tokio::test]
async fn close_during_reconnect_attach_wait_closes_temporary_socket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (attach_sent_tx, attach_sent_rx) = tokio::sync::oneshot::channel::<()>();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn2, "reconnect ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);
        attach_sent_tx.send(()).unwrap();

        expect_websocket_closed(&mut conn2).await.unwrap();
        closed_tx.send(()).unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_secs(30);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    tokio::time::timeout(Duration::from_secs(5), attach_sent_rx)
        .await
        .expect("timed out waiting for reconnect ATTACH")
        .unwrap();

    sub.close_and_wait().await.unwrap();

    tokio::time::timeout(Duration::from_secs(5), closed_rx)
        .await
        .expect("timed out waiting for reconnect attach socket close")
        .unwrap();
    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn close_and_wait_includes_stalled_reconnect_transport_cleanup() {
    const LARGE_PARAM_BYTES: usize = 8 * 1024 * 1024;

    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (attach_started_tx, attach_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_server_tx, release_server_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn2 = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-2".into()),
            connection_key: Some("conn-2!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-2!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&connected).unwrap().into(),
            ))
            .await
            .unwrap();

        let mut frame_prefix = [0_u8; 1024];
        conn2.get_mut().read_exact(&mut frame_prefix).await.unwrap();
        attach_started_tx.send(()).unwrap();
        release_server_rx.await.unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.close_timeout = Duration::from_millis(200);
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_secs(30);
    let mut config = test_config_with_timing(ws_port, http.port(), "ch", timing);
    config.channel_params = Some(HashMap::from([(
        "backpressure".to_string(),
        "x".repeat(LARGE_PARAM_BYTES),
    )]));
    let mut sub = subscribe(config).await.unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );
    tokio::time::timeout(Duration::from_secs(5), attach_started_rx)
        .await
        .expect("timed out waiting for reconnect ATTACH backpressure")
        .unwrap();

    let error = sub.close_and_wait().await.unwrap_err();
    assert!(
        matches!(
            &error,
            Error::Protocol {
                code: error_code::TIMEOUT,
                ..
            }
        ),
        "expected close timeout, got {error}"
    );

    release_server_tx.send(()).unwrap();
    join_server_task(server_task, "backpressured reconnect server")
        .await
        .unwrap();
}
