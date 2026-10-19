use crate::support::*;
use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ErrorInfo, ProtocolMessage, action, encode_msg, error_code,
};
use ably_subscriber::{Event, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

#[tokio::test]
async fn connect_and_receive_message() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("test-ch", "conn-1").await.unwrap();
        send_message(
            &mut conn,
            "test-ch",
            "greeting",
            serde_json::json!({"hello": "world"}),
        )
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "test-ch"))
        .await
        .unwrap();

    let event = expect_event(&mut sub, "initial Connected").await.unwrap();
    assert!(matches!(event, Event::Connected));

    let event = expect_event(&mut sub, "greeting message").await.unwrap();
    match event {
        Event::Message(msg) => {
            assert_eq!(msg.name.as_deref(), Some("greeting"));
            assert_eq!(msg.data, serde_json::json!({"hello": "world"}));
        }
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn initial_attach_is_clean_without_resume_or_serial() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let (connected_seen_tx, connected_seen_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
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

        let msg = expect_protocol_msg(&mut conn, "initial ATTACH")
            .await
            .unwrap();
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some("ch"));
        assert!(msg.channel_serial.is_none());
        assert_attach_resume(&msg, false);

        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("ch".into()),
            channel_serial: Some("serial-0".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&attached).unwrap().into(),
        ))
        .await
        .unwrap();
        wait_for_test_observation(connected_seen_rx, "initial Connected event").await;
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    connected_seen_tx.send(()).unwrap();

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn non_target_channel_events_do_not_pollute_resume_serial() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let missing_channel = ProtocolMessage {
            action: action::MESSAGE,
            channel: None,
            channel_serial: Some("serial-missing-channel".into()),
            messages: Some(vec![AblyMessage {
                name: Some("wrong".into()),
                data: Some(serde_json::json!("ignored")),
                timestamp: Some(now_ms()),
                ..Default::default()
            }]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&missing_channel).unwrap().into(),
        ))
        .await
        .unwrap();

        let other_channel_attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some("other-channel".into()),
            channel_serial: Some("other-serial".into()),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
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
        conn.send(tungstenite::Message::Binary(
            encode_msg(&other_channel_detached).unwrap().into(),
        ))
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(250), conn.next())
                .await
                .is_err(),
            "other-channel ATTACHED/DETACHED should not trigger ATTACH"
        );

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

        let msg = expect_protocol_msg(&mut conn, "ATTACH after ignored message")
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

        send_message(&mut conn, "ch", "expected", serde_json::json!("ok"))
            .await
            .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    let event = expect_event(&mut sub, "matching-channel message")
        .await
        .unwrap();
    match event {
        Event::Message(msg) => assert_eq!(msg.name.as_deref(), Some("expected")),
        other => panic!("expected Message, got {other:?}"),
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn multiple_messages() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        for i in 0..3 {
            send_message(&mut conn, "ch", &format!("evt-{i}"), serde_json::json!(i))
                .await
                .unwrap();
        }
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();
    for i in 0..3 {
        match expect_event(&mut sub, "message in sequence").await.unwrap() {
            Event::Message(msg) => {
                assert_eq!(msg.name.as_deref(), Some(format!("evt-{i}").as_str()));
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn batched_messages_in_single_frame() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let payloads = vec![
        serde_json::json!({"runId": "run-1", "target": {"kind": "builtin", "connectorSlug": "slack"}}),
        serde_json::json!({"runId": "run-1", "target": {"kind": "custom", "customConnectorId": "custom-1"}}),
        serde_json::json!({"runId": "run-2", "target": {"kind": "custom", "customConnectorId": "custom-1"}}),
    ];
    let expected = payloads.clone();

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-1".into()),
            messages: Some(
                payloads
                    .into_iter()
                    .map(|payload| AblyMessage {
                        name: Some("connector-runtime-sync".into()),
                        data: Some(serde_json::Value::String(payload.to_string())),
                        encoding: Some("json".into()),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    for payload in expected {
        match expect_event(&mut sub, "batched message").await.unwrap() {
            Event::Message(m) => {
                assert_eq!(m.name.as_deref(), Some("connector-runtime-sync"));
                assert_eq!(m.data, payload);
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }

    join_server_task(server_task, "mock server").await.unwrap();
}

#[tokio::test]
async fn message_with_json_encoding() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let msg = ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some("serial-1".into()),
            messages: Some(vec![AblyMessage {
                name: Some("evt".into()),
                data: Some(serde_json::json!(r#"{"runId":"uuid-123"}"#)),
                encoding: Some("json".into()),
                ..Default::default()
            }]),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let mut sub = subscribe(test_config(ws_port, http.port(), "ch"))
        .await
        .unwrap();

    expect_connected(&mut sub, "Connected event").await.unwrap();

    match expect_event(&mut sub, "JSON-encoded message")
        .await
        .unwrap()
    {
        Event::Message(msg) => {
            assert_eq!(msg.data, serde_json::json!({"runId": "uuid-123"}));
        }
        other => panic!("expected Message, got {other:?}"),
    }
}

#[tokio::test]
async fn closed_during_initial_attach_closes_websocket() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
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

        let attach = expect_protocol_msg(&mut conn, "initial ATTACH")
            .await
            .unwrap();
        assert_eq!(attach.action, action::ATTACH);
        assert_eq!(attach.channel.as_deref(), Some("ch"));

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

    let result = subscribe(test_config(ws_port, http.port(), "ch")).await;
    match result {
        Err(ably_subscriber::Error::Protocol { code, message }) => {
            assert_eq!(code, error_code::FAILED);
            assert_eq!(message, "Connection closed by server");
        }
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }

    join_server_task(server_task, "initial attach CLOSED server")
        .await
        .unwrap();
}

#[tokio::test]
async fn server_error_during_handshake() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
        let error_msg = ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: error_code::FAILED,
                status_code: Some(401),
                message: "Unauthorized".into(),
            }),
            ..Default::default()
        };
        conn.send(tungstenite::Message::Binary(
            encode_msg(&error_msg).unwrap().into(),
        ))
        .await
        .unwrap();
    });

    let result = subscribe(test_config(ws_port, http.port(), "ch")).await;
    join_server_task(server_task, "pre-CONNECTED ERROR server")
        .await
        .unwrap();

    match result {
        Err(ably_subscriber::Error::Protocol { code, message }) => {
            assert_eq!(code, error_code::FAILED);
            assert_eq!(message, "Unauthorized");
        }
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }
}

#[tokio::test]
async fn connection_closed_before_connected() {
    let http = MockServer::start();
    let ws = MockAblyServer::start().await.unwrap();
    mock_token_endpoint(&http, "testKey.testId");

    let ws_port = ws.port;
    let server_task = tokio::spawn(async move {
        let mut conn = ws.accept_raw().await.unwrap();
        conn.close(None).await.unwrap();
        expect_websocket_close_frame(&mut conn).await.unwrap();
    });

    let result = subscribe(test_config(ws_port, http.port(), "ch")).await;
    match result {
        Err(ably_subscriber::Error::Protocol { code, message }) => {
            assert_eq!(code, error_code::FAILED);
            assert_eq!(message, "Connection closed before CONNECTED received");
        }
        Err(other) => panic!("expected Protocol error, got {other:?}"),
        Ok(_) => panic!("expected error, got Ok"),
    }

    join_server_task(server_task, "pre-CONNECTED close server")
        .await
        .unwrap();
}
