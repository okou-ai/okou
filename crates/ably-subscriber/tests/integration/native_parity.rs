#![cfg(test)]

use crate::support::*;
use ably_subscriber::protocol::{
    AblyMessage, ConnectionDetails, ProtocolMessage, action, encode_msg,
};
use ably_subscriber::{Event, TimingConfig, subscribe};
use futures_util::{SinkExt, StreamExt};
use httpmock::prelude::*;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{self, Message as WsMessage};
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

struct VerifyNativeHandshake;

impl tungstenite::handshake::server::Callback for VerifyNativeHandshake {
    fn on_request(
        self,
        request: &tungstenite::handshake::server::Request,
        response: tungstenite::handshake::server::Response,
    ) -> Result<
        tungstenite::handshake::server::Response,
        tungstenite::handshake::server::ErrorResponse,
    > {
        let url = url::Url::parse(&format!("ws://localhost{}", request.uri())).unwrap();
        assert!(
            url.query_pairs()
                .any(|(key, value)| key == "heartbeats" && value == "false")
        );
        Ok(response)
    }
}

async fn send_protocol(conn: &mut WsStream, message: ProtocolMessage) {
    conn.send(WsMessage::Binary(encode_msg(&message).unwrap().into()))
        .await
        .unwrap();
}

async fn protocol_ping(conn: &mut WsStream, id: &str) {
    send_protocol(
        conn,
        ProtocolMessage {
            action: action::PING,
            id: Some(id.into()),
            ..Default::default()
        },
    )
    .await;
    let pong = expect_protocol_msg(conn, "matching protocol PONG")
        .await
        .unwrap();
    assert_eq!(pong.action, action::PONG);
    assert_eq!(pong.id.as_deref(), Some(id));
}

async fn expect_client_close(conn: &mut WsStream) {
    assert_eq!(
        expect_protocol_msg(conn, "caller CLOSE")
            .await
            .unwrap()
            .action,
        action::CLOSE
    );
    expect_websocket_close_frame(conn).await.unwrap();
}

fn backlog_warnings(captured: &CapturedEvents) -> Vec<tracing_test_support::CapturedEvent> {
    captured
        .entries()
        .into_iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|m| m.starts_with("Ably event consumer backlog"))
        })
        .collect()
}

async fn send_numbered_burst(conn: &mut WsStream, first: usize, count: usize) {
    send_protocol(
        conn,
        ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            channel_serial: Some(format!("burst-{first}")),
            messages: Some(
                (first..first + count)
                    .map(|i| AblyMessage {
                        id: Some(format!("burst-{i}")),
                        data: Some(serde_json::json!(i)),
                        ..Default::default()
                    })
                    .collect(),
            ),
            ..Default::default()
        },
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn burst_is_lossless_fifo_and_sustained_backlog_warnings_are_bounded() {
    const COUNT: usize = 500;
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (processed_tx, processed_rx) = oneshot::channel();
    let (drained_tx, drained_rx) = oneshot::channel();
    let (drain_observed_tx, drain_observed_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 0,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        send_numbered_burst(&mut conn, 0, COUNT).await;
        // A control PONG proves the whole data message was read without relying on protocol PING support.
        conn.send(WsMessage::Ping(b"burst-processed".as_slice().into()))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(pong, WsMessage::Pong(b"burst-processed".as_slice().into()));
        processed_tx.send(()).unwrap();
        // No peer deadline is armed while the test advances the backlog timer.
        drained_rx.await.unwrap();
        protocol_ping(&mut conn, "after-drain").await;
        drain_observed_tx.send(()).unwrap();
        expect_client_close(&mut conn).await;
    });
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut sub = subscribe(test_config(port, http.port(), "ch"))
        .await
        .unwrap();
    wait_for_test_observation(processed_rx, "burst dispatch without consumer progress").await;
    let warnings = || backlog_warnings(&captured);
    assert!(warnings().is_empty(), "a burst has not yet persisted");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::time::resume();
    tokio::time::timeout(Duration::from_secs(2), async {
        while warnings().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        warnings().len(),
        1,
        "sustained backlog warns without new data"
    );
    assert!(
        warnings()[0]
            .fields
            .get("event_backlog_duration_ms")
            .and_then(|value| value.parse::<u128>().ok())
            .is_some_and(|duration| duration >= 5_000),
        "the warning reports its sustained duration"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::time::resume();
    tokio::time::timeout(Duration::from_secs(2), async {
        while warnings().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        warnings().len(),
        2,
        "one duration-qualified warning and one rate-limited repeat"
    );
    assert_eq!(
        warnings()[1]
            .fields
            .get("event_backlog")
            .map(String::as_str),
        Some("501")
    );
    expect_connected(&mut sub, "initial Connected remains first")
        .await
        .unwrap();
    for i in 0..COUNT {
        match expect_event(&mut sub, "lossless ordered burst")
            .await
            .unwrap()
        {
            Event::Message(message) => {
                assert_eq!(message.id, Some(format!("burst-{i}")));
                assert_eq!(message.data, serde_json::json!(i));
            }
            other => panic!("expected message {i}, got {other:?}"),
        }
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::time::resume();
    drained_tx.send(()).unwrap();
    wait_for_test_observation(drain_observed_rx, "receive progress after draining").await;
    assert_eq!(
        warnings().len(),
        2,
        "draining cancels sustained backlog warnings"
    );
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "burst peer").await.unwrap();
}

async fn backlog_duration_restarts_after_drain(remaining: usize) {
    const COUNT: usize = 64;
    let refill_count = COUNT - remaining;
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (processed_tx, processed_rx) = oneshot::channel();
    let (refill_tx, refill_rx) = oneshot::channel();
    let (refilled_tx, refilled_rx) = oneshot::channel();
    let (check_tx, check_rx) = oneshot::channel();
    let (checked_tx, checked_rx) = oneshot::channel();
    let (close_tx, close_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 0,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        send_numbered_burst(&mut conn, 0, COUNT).await;
        protocol_ping(&mut conn, "first-burst-processed").await;
        processed_tx.send(()).unwrap();
        refill_rx.await.unwrap();
        send_numbered_burst(&mut conn, COUNT, refill_count).await;
        protocol_ping(&mut conn, "refill-processed").await;
        refilled_tx.send(()).unwrap();
        check_rx.await.unwrap();
        protocol_ping(&mut conn, "original-deadline-passed").await;
        checked_tx.send(()).unwrap();
        close_rx.await.unwrap();
        expect_client_close(&mut conn).await;
    });
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut sub = subscribe(test_config(port, http.port(), "ch"))
        .await
        .unwrap();
    wait_for_test_observation(processed_rx, "first backlog episode armed").await;
    assert!(backlog_warnings(&captured).is_empty());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    expect_connected(&mut sub, "initial Connected remains first")
        .await
        .unwrap();
    for i in 0..refill_count {
        match expect_event(&mut sub, "drain below the warning depth")
            .await
            .unwrap()
        {
            Event::Message(message) => assert_eq!(message.data, serde_json::json!(i)),
            other => panic!("expected message {i}, got {other:?}"),
        }
    }
    // No event-loop observation occurs between the receiver's threshold exit and refill.
    refill_tx.send(()).unwrap();
    wait_for_test_observation(refilled_rx, "fresh backlog episode armed").await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
    tokio::time::resume();
    check_tx.send(()).unwrap();
    wait_for_test_observation(checked_rx, "control progress after the old deadline").await;
    assert!(
        backlog_warnings(&captured).is_empty(),
        "short bursts do not inherit the previous episode's duration"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(2)).await;
    tokio::time::resume();
    tokio::time::timeout(Duration::from_secs(2), async {
        while backlog_warnings(&captured).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let warnings = backlog_warnings(&captured);
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        warnings[0].fields.get("event_backlog").map(String::as_str),
        Some("64"),
        "the new episode qualifies at the inclusive depth threshold"
    );
    for i in refill_count..COUNT + refill_count {
        match expect_event(&mut sub, "FIFO across a threshold exit and refill")
            .await
            .unwrap()
        {
            Event::Message(message) => {
                assert_eq!(message.id, Some(format!("burst-{i}")));
                assert_eq!(message.data, serde_json::json!(i));
            }
            other => panic!("expected message {i}, got {other:?}"),
        }
    }
    close_tx.send(()).unwrap();
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "backlog episode peer")
        .await
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn drained_burst_starts_a_fresh_backlog_duration() {
    backlog_duration_restarts_after_drain(0).await;
}

#[tokio::test(flavor = "current_thread")]
async fn partial_drain_below_threshold_starts_a_fresh_backlog_duration() {
    backlog_duration_restarts_after_drain(63).await;
}

#[derive(Clone, Copy)]
enum Interruption {
    WebSocketClose,
    ProtocolDisconnect,
    Idle,
}

enum ConsumerAction {
    DrainAndClose,
    CloseAndWait,
    Drop,
}

async fn undrained_reconnect(interruption: Interruption, consumer: ConsumerAction) {
    const COUNT: usize = 500;
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (ready_tx, ready_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut conn = ws
            .accept_and_handshake_with_opts(
                "ch",
                "conn-1",
                HandshakeOptions {
                    max_idle_interval_ms: 100,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        send_protocol(
            &mut conn,
            ProtocolMessage {
                action: action::MESSAGE,
                channel: Some("ch".into()),
                messages: Some(
                    (0..COUNT)
                        .map(|i| AblyMessage {
                            id: Some(format!("before-{i}")),
                            name: Some("before".into()),
                            data: Some(serde_json::json!(i)),
                            ..Default::default()
                        })
                        .collect(),
                ),
                ..Default::default()
            },
        )
        .await;
        match interruption {
            Interruption::WebSocketClose => {
                conn.close(None).await.unwrap();
            }
            Interruption::ProtocolDisconnect => {
                send_protocol(
                    &mut conn,
                    ProtocolMessage {
                        action: action::DISCONNECTED,
                        ..Default::default()
                    },
                )
                .await;
                expect_websocket_close_frame(&mut conn).await.unwrap();
            }
            Interruption::Idle => {
                expect_websocket_close_frame(&mut conn).await.unwrap();
            }
        }
        // Keep the public connection identity to exercise successful resume.
        let mut resumed = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        send_message(&mut resumed, "ch", "after", serde_json::json!(2))
            .await
            .unwrap();
        resumed
            .send(WsMessage::Ping(
                b"receive-after-reconnect".as_slice().into(),
            ))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(5), resumed.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            pong,
            WsMessage::Pong(b"receive-after-reconnect".as_slice().into())
        );
        ready_tx.send(()).unwrap();
        expect_client_close(&mut resumed).await;
    });
    let mut timing = TimingConfig::default();
    timing.heartbeat_margin = Duration::from_millis(100);
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut sub = subscribe(test_config_with_timing(port, http.port(), "ch", timing))
        .await
        .unwrap();
    wait_for_test_observation(
        ready_rx,
        "reconnect and control PONG while no events are consumed",
    )
    .await;
    match consumer {
        ConsumerAction::DrainAndClose => {
            expect_connected(&mut sub, "initial Connected")
                .await
                .unwrap();
            for i in 0..COUNT {
                match expect_event(&mut sub, "queued message before reconnect")
                    .await
                    .unwrap()
                {
                    Event::Message(message) => {
                        assert_eq!(message.name.as_deref(), Some("before"));
                        assert_eq!(message.id, Some(format!("before-{i}")));
                        assert_eq!(message.data, serde_json::json!(i));
                    }
                    other => panic!("expected message {i} before reconnect, got {other:?}"),
                }
            }
            assert!(matches!(
                expect_event(&mut sub, "Disconnected").await.unwrap(),
                Event::Disconnected { .. }
            ));
            expect_connected(&mut sub, "resumed Connected")
                .await
                .unwrap();
            assert!(
                matches!(expect_event(&mut sub, "resumed message").await.unwrap(), Event::Message(m) if m.name.as_deref() == Some("after"))
            );
            sub.close_and_wait().await.unwrap();
        }
        ConsumerAction::CloseAndWait => sub.close_and_wait().await.unwrap(),
        ConsumerAction::Drop => drop(sub),
    }
    join_server_task(server, "undrained reconnect peer")
        .await
        .unwrap();
    let events = captured.entries();
    let reconnect = events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|m| m == "Ably reconnect attached")
        })
        .expect("reconnect diagnostic");
    assert_eq!(
        reconnect.fields.get("resumed").map(String::as_str),
        Some("true")
    );
    assert!(reconnect.fields.contains_key("attempt_elapsed_ms"));
    if matches!(interruption, Interruption::Idle) {
        let snapshot = events
            .iter()
            .find(|event| event.fields.get("phase").is_some_and(|p| p == "closing"))
            .expect("timeout transport snapshot");
        assert_eq!(
            snapshot.fields.get("idle_budget_ms").map(String::as_str),
            Some("200")
        );
        assert_eq!(
            snapshot.fields.get("cause").map(String::as_str),
            Some("heartbeat-timeout")
        );
        assert_eq!(
            snapshot.fields.get("connection_id").map(String::as_str),
            Some("conn-1")
        );
        assert_eq!(
            snapshot.fields.get("tcp_nodelay").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            snapshot.fields.get("server_id").map(String::as_str),
            Some("mock-ably-server")
        );
        for field in [
            "local_addr",
            "peer_addr",
            "connection_age_ms",
            "last_received_age_ms",
            "last_message_kind",
            "received_ws_messages",
            "received_payload_bytes",
            "event_backlog",
            "event_backlog_peak",
        ] {
            assert!(
                snapshot.fields.contains_key(field),
                "missing diagnostic {field}: {snapshot:?}"
            );
        }
    }
    let logs = format!("{events:?}");
    assert!(
        !logs.contains("conn-1!key"),
        "private resume key must not be logged"
    );
    assert!(
        !logs.contains("mock-token-abc"),
        "authentication token must not be logged"
    );
    assert!(
        !logs.contains("access_token="),
        "authenticated URL must not be logged"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn undrained_consumer_allows_recovery_fifo_delivery_and_shutdown() {
    for interruption in [
        Interruption::WebSocketClose,
        Interruption::ProtocolDisconnect,
        Interruption::Idle,
    ] {
        undrained_reconnect(interruption, ConsumerAction::DrainAndClose).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn drop_closes_resumed_socket_with_undrained_events() {
    undrained_reconnect(Interruption::ProtocolDisconnect, ConsumerAction::Drop).await;
}

#[tokio::test(flavor = "current_thread")]
async fn tracked_close_finishes_with_undrained_events_after_reconnect() {
    undrained_reconnect(
        Interruption::ProtocolDisconnect,
        ConsumerAction::CloseAndWait,
    )
    .await;
}

#[tokio::test(flavor = "current_thread")]
async fn fresh_reconnect_diagnostics_do_not_reuse_missing_server_identity() {
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (ready_tx, ready_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut first = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        first.close(None).await.unwrap();
        let mut fresh = ws.accept_raw().await.unwrap();
        send_protocol(
            &mut fresh,
            ProtocolMessage {
                action: action::CONNECTED,
                connection_id: Some("conn-2".into()),
                connection_key: Some("conn-2!private-key".into()),
                connection_details: None,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            expect_protocol_msg(&mut fresh, "fresh ATTACH")
                .await
                .unwrap()
                .action,
            action::ATTACH
        );
        send_protocol(
            &mut fresh,
            ProtocolMessage {
                action: action::ATTACHED,
                channel: Some("ch".into()),
                ..Default::default()
            },
        )
        .await;
        protocol_ping(&mut fresh, "fresh-receive-ready").await;
        ready_tx.send(()).unwrap();
        expect_client_close(&mut fresh).await;
    });
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let sub = subscribe(test_config(port, http.port(), "ch"))
        .await
        .unwrap();
    wait_for_test_observation(ready_rx, "fresh connection receive progress").await;
    // All status events are still queued; tracked shutdown must finish without draining them.
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "fresh metadata peer")
        .await
        .unwrap();
    let events = captured.entries();
    let connected = events
        .iter()
        .find(|event| {
            event
                .fields
                .get("phase")
                .is_some_and(|phase| phase == "connected")
        })
        .unwrap();
    assert_eq!(
        connected.fields.get("server_id").map(String::as_str),
        Some("mock-ably-server")
    );
    let fresh = events
        .iter()
        .find(|event| {
            event
                .fields
                .get("phase")
                .is_some_and(|phase| phase == "reconnected")
        })
        .unwrap();
    assert_eq!(
        fresh.fields.get("connection_id").map(String::as_str),
        Some("conn-2")
    );
    assert!(
        !fresh.fields.contains_key("server_id"),
        "missing metadata must not identify the previous transport's server: {fresh:?}"
    );
    assert!(!format!("{events:?}").contains("conn-2!private-key"));
}

async fn control_ping_refreshes_activity(fragmented: bool) {
    use tungstenite::protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    };
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (ping_tx, ping_rx) = oneshot::channel();
    let (pong_tx, pong_rx) = oneshot::channel();
    let (finish_tx, finish_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let mut conn = ws.accept_and_handshake("ch", "conn-1").await.unwrap();
        let bytes = encode_msg(&ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".into()),
            messages: Some(vec![AblyMessage {
                name: Some("after-ping".into()),
                data: Some(serde_json::json!("private-business-payload")),
                ..Default::default()
            }]),
            ..Default::default()
        })
        .unwrap();
        let split = bytes.len() / 2;
        if fragmented {
            conn.send(WsMessage::Frame(Frame::message(
                bytes[..split].to_vec(),
                OpCode::Data(Data::Binary),
                false,
            )))
            .await
            .unwrap();
        }
        ping_rx.await.unwrap();
        conn.send(WsMessage::Ping(b"native-ping".as_slice().into()))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(5), conn.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            pong,
            WsMessage::Pong(b"native-ping".as_slice().into()),
            "PONG must precede the final fragment"
        );
        pong_tx.send(()).unwrap();
        finish_rx.await.unwrap();
        let message = if fragmented {
            WsMessage::Frame(Frame::message(
                bytes[split..].to_vec(),
                OpCode::Data(Data::Continue),
                true,
            ))
        } else {
            WsMessage::Binary(bytes.into())
        };
        conn.send(message).await.unwrap();
        expect_client_close(&mut conn).await;
    });
    let captured = CapturedEvents::default();
    let _guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let mut sub = subscribe(test_config(port, http.port(), "ch"))
        .await
        .unwrap();
    expect_connected(&mut sub, "initial Connected")
        .await
        .unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(20)).await;
    tokio::time::resume();
    ping_tx.send(()).unwrap();
    wait_for_test_observation(pong_rx, "automatic PONG and receive activity").await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(20)).await;
    tokio::time::resume();
    finish_tx.send(()).unwrap();
    assert!(
        matches!(expect_event(&mut sub, "message beyond original idle deadline").await.unwrap(), Event::Message(m) if m.name.as_deref() == Some("after-ping"))
    );
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "native control peer")
        .await
        .unwrap();
    assert!(!format!("{:?}", captured.entries()).contains("private-business-payload"));
}

#[tokio::test(flavor = "current_thread")]
async fn native_ping_pong_refreshes_idle_deadline() {
    control_ping_refreshes_activity(false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn ping_between_fragments_flushes_pong_and_refreshes_idle_deadline() {
    control_ping_refreshes_activity(true).await;
}

#[tokio::test]
async fn protocol_ping_is_answered_during_setup_attach_and_active_session() {
    let http = MockServer::start();
    mock_token_endpoint(&http, "testKey.testId");
    let ws = MockAblyServer::start().await.unwrap();
    let port = ws.port;
    let (active_tx, active_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = ws.listener.accept().await.unwrap();
        let mut conn = tokio_tungstenite::accept_hdr_async(tcp, VerifyNativeHandshake)
            .await
            .unwrap();
        protocol_ping(&mut conn, "pre-connected").await;
        send_protocol(
            &mut conn,
            ProtocolMessage {
                action: action::CONNECTED,
                connection_id: Some("conn-1".into()),
                connection_details: Some(ConnectionDetails {
                    max_idle_interval: Some(15_000),
                    server_id: Some("test-server".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(
            expect_protocol_msg(&mut conn, "ATTACH")
                .await
                .unwrap()
                .action,
            action::ATTACH
        );
        protocol_ping(&mut conn, "pre-attached").await;
        send_protocol(
            &mut conn,
            ProtocolMessage {
                action: action::ATTACHED,
                channel: Some("ch".into()),
                ..Default::default()
            },
        )
        .await;
        protocol_ping(&mut conn, "active").await;
        active_tx.send(()).unwrap();
        expect_client_close(&mut conn).await;
    });
    let sub = subscribe(test_config(port, http.port(), "ch"))
        .await
        .unwrap();
    wait_for_test_observation(active_rx, "active protocol PONG").await;
    sub.close_and_wait().await.unwrap();
    join_server_task(server, "protocol control peer")
        .await
        .unwrap();
}
