use crate::support::*;
use ably_subscriber::protocol::{
    ConnectionDetails, ErrorInfo, ProtocolMessage, action, encode_msg,
};
use ably_subscriber::{Event, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

#[tokio::test]
async fn server_sends_detached_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // Send DETACHED (retriable — server error)
        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Expect re-ATTACH from client
        let msg = expect_protocol_msg(&mut conn, "ATTACH").await.unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Send message after reattach
        send_message(&mut conn, "ch", "after-reattach", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(after_reattach_seen_rx, "after-reattach message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Message after reattach
    let event = expect_event(&mut sub, "message after reattach")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reattach"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reattach_after_attached_without_serial_keeps_resume_intent() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    attached_channel_serial: None,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "ATTACH").await.unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        send_message(&mut conn, "ch", "after-reattach", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(after_reattach_seen_rx, "after-reattach message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after reattach")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reattach"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn message_without_serial_preserves_resume_serial_for_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        send_message_with_channel_serial(
            &mut conn,
            "ch",
            "without-serial",
            serde_json::json!("ok"),
            None,
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "message without serial").await;

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "ATTACH").await.unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        send_message(
            &mut conn,
            "ch",
            "after-preserved-serial",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(after_reattach_seen_rx, "after preserved serial message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message without serial")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("without-serial"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    let event = expect_event(&mut sub, "message after reattach")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-preserved-serial"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn attached_without_serial_preserves_resume_serial_for_next_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_second_reattach_seen_tx, after_second_reattach_seen_rx) =
        tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "first reattach")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached_without_serial = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached_without_serial).unwrap().into(),
        ))
        .await
        .unwrap();

        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "second reattach")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        send_message(
            &mut conn,
            "ch",
            "after-attached-without-serial",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(
            after_second_reattach_seen_rx,
            "after attached without serial message",
        )
        .await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after attached without serial")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-attached-without-serial"));
            after_second_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn huge_realtime_request_timeout_allows_detached_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "ATTACH after DETACHED")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        send_message(
            &mut conn,
            "ch",
            "after-huge-timeout-reattach",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(
            after_reattach_seen_rx,
            "after huge-timeout reattach message",
        )
        .await;
    });

    let mut timing = TimingConfig::default();
    timing.realtime_request_timeout = Duration::MAX;
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after huge-timeout reattach")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-huge-timeout-reattach"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn detached_with_client_error_reattaches() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_detached_seen_tx, after_detached_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        // ably-js does not gate DETACHED handling on error retriability:
        // attached channels request ATTACH again regardless of the reason.
        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 40160,
                status_code: Some(401),
                message: "Channel denied".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "ATTACH after DETACHED")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();
        send_message(
            &mut conn,
            "ch",
            "after-client-detached",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(after_detached_seen_rx, "after-client-detached message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after client DETACHED")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-client-detached"));
            after_detached_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn superseded_error_after_attached_without_serial_keeps_resume_intent() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (after_reattach_seen_tx, after_reattach_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    attached_channel_serial: None,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        let superseded = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&superseded).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "ATTACH after 80016")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-after-80016".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();
        send_message(&mut conn, "ch", "after-80016", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(after_reattach_seen_rx, "after-80016 message").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "message after 80016 reattach")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-80016"));
            after_reattach_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn detached_while_attaching_suspends_and_retries_attach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };

        // First DETACHED while attached → client sends ATTACH immediately.
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        // Wait for re-ATTACH
        let msg = expect_protocol_msg(&mut conn, "ATTACH").await.unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        // Second DETACHED before ATTACHED means the channel is currently
        // attaching. ably-js moves it to suspended and retries ATTACH on the
        // same active transport after channelRetryTimeout.
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "retry ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();
        send_message(
            &mut conn,
            "ch",
            "after-channel-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
    });

    let mut timing = TimingConfig::default();
    timing.channel_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Message after the channel retry proves the websocket stayed active and
    // no full reconnect was required.
    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("after-channel-retry")),
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reconnect_attached_without_serial_preserves_resume_serial_for_next_reattach() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (connected_seen_tx, connected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        wait_for_test_observation(connected_seen_rx, "initial Connected event").await;
        drop(conn);

        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some("conn-1".into()),
            connection_key: Some("conn-1!key".into()),
            connection_details: Some(ConnectionDetails {
                connection_key: Some("conn-1!key".into()),
                connection_state_ttl: Some(120_000),
                max_idle_interval: Some(15_000),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&connected).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(&mut conn, "reconnect ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached_without_serial = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached_without_serial).unwrap().into(),
        ))
        .await
        .unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&detached).unwrap().into(),
        ))
        .await
        .unwrap();

        let msg = expect_protocol_msg(
            &mut conn,
            "reattach after reconnect ATTACHED without serial",
        )
        .await
        .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();

        send_message(
            &mut conn,
            "ch",
            "after-reconnect-attached-without-serial",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(
            message_seen_rx,
            "after reconnect attached without serial message",
        )
        .await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    connected_seen_tx.send(()).unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));

    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(matches!(event, Event::Connected));

    let event = expect_event(&mut sub, "message after reconnect attached without serial")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(
                msg.name.as_deref(),
                Some("after-reconnect-attached-without-serial")
            );
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn detached_during_reconnect_attach_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
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

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "attach rejected temporarily".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn2, "channel retry ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
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
            "after-reconnect-channel-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reconnect-channel-retry message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = expect_event(&mut sub, "Connected after channel retry")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after channel retry")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect-channel-retry"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn superseded_error_during_reconnect_attach_retries_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
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

        let superseded = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&superseded).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn2, "retry ATTACH after 80016")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
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
            "after-superseded-retry",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-superseded-retry message").await;
    });

    let mut timing = TimingConfig::default();
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

    let event = expect_event(&mut sub, "Connected after retry ATTACH")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after retry ATTACH, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after retry ATTACH")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-superseded-retry"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn other_channel_error_during_reconnect_attach_is_ignored() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
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

        let other_channel_error = ProtocolMessage {
            action: action::ERROR,
            channel: Some("other-channel".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&other_channel_error).unwrap().into(),
            ))
            .await
            .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(250), conn2.next())
                .await
                .is_err(),
            "other-channel ERROR should not close the socket or trigger another ATTACH"
        );

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-ok".into()),
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
            "after-other-channel-error",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-other-channel-error message").await;
    });

    let mut timing = TimingConfig::default();
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

    let event = expect_event(&mut sub, "Connected").await.unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-other-channel-error"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn other_channel_attach_outcomes_during_reconnect_attach_are_ignored() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (connected_seen_tx, connected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (other_channel_frames_sent_tx, other_channel_frames_sent_rx) =
        tokio::sync::oneshot::channel::<()>();
    let (noise_checked_tx, noise_checked_rx) = tokio::sync::oneshot::channel::<()>();
    let (reconnected_seen_tx, reconnected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        wait_for_test_observation(connected_seen_rx, "initial Connected event").await;
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

        let other_channel_attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("other-channel".into()),
            channel_serial: Some("other-serial".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&other_channel_attached).unwrap().into(),
            ))
            .await
            .unwrap();

        let other_channel_detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("other-channel".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "other channel detached".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&other_channel_detached).unwrap().into(),
            ))
            .await
            .unwrap();
        other_channel_frames_sent_tx.send(()).unwrap();
        wait_for_test_observation(noise_checked_rx, "other-channel noise check").await;

        // A replacement serial here would hide resume state lost to the unrelated DETACHED.
        let attached_without_serial = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached_without_serial).unwrap().into(),
            ))
            .await
            .unwrap();
        wait_for_test_observation(reconnected_seen_rx, "reconnect Connected event").await;

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn2, "reattach after other-channel attach outcomes")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-ok".into()),
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
            "after-other-channel-attach-outcomes",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(
            message_seen_rx,
            "after other-channel attach outcomes message",
        )
        .await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    connected_seen_tx.send(()).unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(matches!(event, Event::Disconnected { .. }));

    wait_for_test_observation(
        other_channel_frames_sent_rx,
        "other-channel attach outcome frames",
    )
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(250), sub.next())
            .await
            .is_err(),
        "other-channel ATTACHED/DETACHED should not finish reconnect attach"
    );
    noise_checked_tx.send(()).unwrap();

    let event = expect_event(&mut sub, "Connected").await.unwrap();
    assert!(matches!(event, Event::Connected));
    reconnected_seen_tx.send(()).unwrap();

    let event = expect_event(&mut sub, "message after other-channel attach outcomes")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(
                msg.name.as_deref(),
                Some("after-other-channel-attach-outcomes")
            );
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn disconnected_during_reconnect_attach_retries_with_new_connection() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
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

        let disconnected = ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server disconnected during attach".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&disconnected).unwrap().into(),
            ))
            .await
            .unwrap();

        let mut conn3 = tokio::time::timeout(
            Duration::from_secs(5),
            ws.accept_and_handshake("ch", "conn-3"),
        )
        .await
        .expect("timed out waiting for reconnect after DISCONNECTED during attach")
        .unwrap();
        send_message(
            &mut conn3,
            "ch",
            "after-disconnected-during-attach",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
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

    let event = expect_event(&mut sub, "Connected after reconnect attach DISCONNECTED")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after reconnect attach DISCONNECTED, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after reconnect attach DISCONNECTED")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(
                msg.name.as_deref(),
                Some("after-disconnected-during-attach")
            );
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn closed_during_reconnect_attach_stops_subscription() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
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

        let closed = ProtocolMessage {
            action: action::CLOSED,
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&closed).unwrap().into(),
            ))
            .await
            .unwrap();
        expect_websocket_closed(&mut conn2).await.unwrap();
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

    expect_subscription_closed(&mut sub, "CLOSED during attach")
        .await
        .unwrap();

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn superseded_reconnect_attach_timeout_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
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

        let superseded = ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".into(),
            }),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&superseded).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn2, "retry ATTACH after 80016")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert_eq!(msg.channel_serial.as_deref(), Some("serial-0"));
        assert_attach_resume(&msg, true);

        let msg = expect_protocol_msg(&mut conn2, "channel retry ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-after-timeout".into()),
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
            "after-superseded-timeout",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-superseded-timeout message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_millis(20);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = expect_event(&mut sub, "Connected after channel retry")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after channel retry")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-superseded-timeout"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn reconnect_attach_timeout_retries_channel_on_same_transport() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
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

        // Do not answer the first ATTACH. The client should treat this as a
        // channel attach timeout, keep conn-2 connected, and retry ATTACH on
        // the same websocket instead of opening conn-3.
        let msg = expect_protocol_msg(&mut conn2, "channel retry ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, true);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-retry".into()),
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
            "after-reconnect-attach-timeout",
            serde_json::json!("ok"),
        )
        .await
        .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reconnect-attach-timeout message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    timing.channel_retry_timeout = Duration::from_millis(10);
    timing.realtime_request_timeout = Duration::from_millis(20);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    let event = expect_event(&mut sub, "Disconnected").await.unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = expect_event(&mut sub, "Connected after channel retry")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected after channel retry, got {event:?}"
    );

    let event = expect_event(&mut sub, "message after channel retry")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reconnect-attach-timeout"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

/// Sequence: DETACH → send ATTACH → connection drops → reconnect succeeds →
/// DETACH on new connection → client should send ATTACH (not open conn-3).
#[tokio::test]
async fn detach_after_reconnect_reattaches_not_full_reconnect() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (message_seen_tx, message_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn1 = ws.accept_and_handshake("ch", "conn-1").await.unwrap();

        let detached = ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".into(),
            }),
            ..Default::default()
        };

        // DETACH while attached → client sends ATTACH.
        conn1
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        let msg = expect_protocol_msg(&mut conn1, "ATTACH on conn-1")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);

        // Drop connection before sending ATTACHED — simulates connection loss
        drop(conn1);

        // Client reconnects (conn-2)
        let mut conn2 = ws.accept_and_handshake("ch", "conn-2").await.unwrap();

        // Send DETACH on the new connection. ably-js re-attaches on the active
        // transport instead of forcing a full reconnect.
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&detached).unwrap().into(),
            ))
            .await
            .unwrap();

        // Client should send ATTACH (re-attach), NOT open a third connection
        let msg = expect_protocol_msg(&mut conn2, "ATTACH on conn-2 (got full reconnect instead?)")
            .await
            .unwrap();
        assert_eq!(
            msg.action,
            action::ATTACH,
            "expected re-attach on conn-2, not full reconnect"
        );

        // Complete the re-attach
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-2".into()),
            ..Default::default()
        };
        conn2
            .send(tungstenite::Message::Binary(
                encode_msg(&attached).unwrap().into(),
            ))
            .await
            .unwrap();

        send_message(&mut conn2, "ch", "after-reattach", serde_json::json!("ok"))
            .await
            .unwrap();
        wait_for_test_observation(message_seen_rx, "after-reattach message").await;
    });

    let mut timing = TimingConfig::default();
    timing.disconnected_retry_timeout = Duration::from_millis(10);
    let mut sub = subscribe(test_config_with_timing(ws_port, http.port(), "ch", timing))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    // Disconnected → reconnect → Connected
    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Disconnected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Disconnected { .. }),
        "expected Disconnected, got {event:?}"
    );

    let event = expect_event_with_timeout(&mut sub, RECONNECT_EVENT_TIMEOUT, "Connected")
        .await
        .unwrap();
    assert!(
        matches!(event, Event::Connected),
        "expected Connected, got {event:?}"
    );

    // Message after re-attach on conn-2 proves we didn't do a full reconnect
    let event = expect_event(&mut sub, "message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("after-reattach"));
            message_seen_tx.send(()).unwrap();
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}
