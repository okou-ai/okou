use super::super::state::ConnState;
use super::*;

use crate::protocol::{AblyMessage, ErrorInfo};
use crate::types::{TokenDetails, TokenRequest};
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

fn test_event_loop_state(event_tx: EventSender) -> EventLoopState {
    let timing = TimingConfig::default();
    EventLoopState {
        transport: None,
        event_tx,
        session: SessionState::connected(ConnState {
            server_id: None,
            connection_id: Some("conn-1".to_string()),
            connection_key: Some("conn-1!key".to_string()),
            channel_serial: Some("serial-0".to_string()),
            connection_state_ttl: timing.default_connection_state_ttl,
            max_idle_interval: Some(timing.default_max_idle_interval),
            disconnected_at: None,
            token: TokenDetails {
                token: "token".to_string(),
                expires: i64::MAX,
                issued: 0,
                capability: None,
                client_id: None,
            },
            token_renewal_at: None,
        }),
        channel: "ch".to_string(),
        channel_params: None,
        realtime_host: "realtime.example.com".to_string(),
        rest_host: "rest.example.com".to_string(),
        heartbeat_interval: None,
        http: reqwest::Client::new(),
        get_token: Box::new(|| -> TokenFuture {
            Box::pin(async {
                Ok(TokenRequest {
                    key_name: "test-key".to_string(),
                    timestamp: 0,
                    nonce: "nonce".to_string(),
                    mac: "mac".to_string(),
                    capability: "{}".to_string(),
                    ttl: None,
                    client_id: None,
                })
            })
        }),
        pending_token_renewal: None,
        timing,
        backlog_warnings: BacklogWarnings::default(),
        transport_close_tracker: TransportCloseTracker::new(),
    }
}

fn assert_event_channel_empty(event_rx: &mut crate::event_queue::EventReceiver) {
    assert!(
        matches!(
            event_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ),
        "expected no status event"
    );
}

fn captured_contains(events: &[CapturedEvent], needle: &str) -> bool {
    events
        .iter()
        .flat_map(|event| event.fields.values())
        .any(|value| value.contains(needle))
}

#[test]
fn pending_reconnect_keeps_outer_disconnected_event_pending() {
    let mut disconnected_sent = true;

    record_reconnect_disconnected_event(&mut disconnected_sent, DisconnectedEvent::Pending);

    assert!(
        !disconnected_sent,
        "outer loop must emit Disconnected when reconnect did not send one"
    );
}

#[test]
fn sent_reconnect_marks_outer_disconnected_event_sent() {
    let mut disconnected_sent = false;

    record_reconnect_disconnected_event(&mut disconnected_sent, DisconnectedEvent::Sent);

    assert!(
        disconnected_sent,
        "outer loop must not duplicate a Disconnected event sent by reconnect handling"
    );
}

#[tokio::test]
async fn disconnected_message_marks_reconnect_event_sent() {
    let (event_tx, mut event_rx) = crate::event_queue::event_queue();
    let mut state = test_event_loop_state(event_tx);
    let (_close_tx, mut close_rx) = oneshot::channel();

    let action = handle_message(
        &mut state,
        ProtocolMessage {
            action: action::DISCONNECTED,
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "server going away".to_string(),
            }),
            ..Default::default()
        },
        &mut close_rx,
    )
    .await;

    assert_eq!(
        action,
        LoopAction::Reconnect {
            disconnected_event: DisconnectedEvent::Sent,
            refresh_token: false,
        }
    );
    match event_rx.try_recv().expect("disconnected event") {
        Event::Disconnected { reason } => {
            assert_eq!(reason.as_deref(), Some("server going away"));
        }
        event => panic!("expected Disconnected, got {event:?}"),
    }
    assert_event_channel_empty(&mut event_rx);
}

#[tokio::test(flavor = "current_thread")]
async fn closed_message_channel_stops_before_decoding_payload() {
    let (event_tx, event_rx) = crate::event_queue::event_queue();
    drop(event_rx);
    let mut state = test_event_loop_state(event_tx);
    let (_close_tx, mut close_rx) = oneshot::channel();
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);

    let action = handle_message(
        &mut state,
        ProtocolMessage {
            action: action::MESSAGE,
            channel: Some("ch".to_string()),
            messages: Some(vec![AblyMessage {
                data: Some(serde_json::json!("{not-json")),
                encoding: Some("json".to_string()),
                ..Default::default()
            }]),
            ..Default::default()
        },
        &mut close_rx,
    )
    .await;

    assert_eq!(action, LoopAction::Stop);
    let events = captured.entries();
    assert!(
        !captured_contains(&events, "Failed to decode JSON encoding layer"),
        "payload was decoded before closed-channel stop; events={events:#?}"
    );
}

#[tokio::test]
async fn detached_reattach_missing_transport_leaves_disconnected_event_pending() {
    let (event_tx, mut event_rx) = crate::event_queue::event_queue();
    let mut state = test_event_loop_state(event_tx);
    let (_close_tx, mut close_rx) = oneshot::channel();

    let action = handle_message(
        &mut state,
        ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".to_string()),
            error: Some(ErrorInfo {
                code: 80003,
                status_code: Some(500),
                message: "channel detached".to_string(),
            }),
            ..Default::default()
        },
        &mut close_rx,
    )
    .await;

    assert_eq!(
        action,
        LoopAction::Reconnect {
            disconnected_event: DisconnectedEvent::Pending,
            refresh_token: false,
        }
    );
    assert_event_channel_empty(&mut event_rx);
}

#[tokio::test]
async fn superseded_error_reattach_missing_transport_leaves_disconnected_event_pending() {
    let (event_tx, mut event_rx) = crate::event_queue::event_queue();
    let mut state = test_event_loop_state(event_tx);
    let (_close_tx, mut close_rx) = oneshot::channel();

    let action = handle_message(
        &mut state,
        ProtocolMessage {
            action: action::ERROR,
            channel: Some("ch".to_string()),
            error: Some(ErrorInfo {
                code: 80016,
                status_code: Some(400),
                message: "operation attempted on superseded transport".to_string(),
            }),
            ..Default::default()
        },
        &mut close_rx,
    )
    .await;

    assert_eq!(
        action,
        LoopAction::Reconnect {
            disconnected_event: DisconnectedEvent::Pending,
            refresh_token: false,
        }
    );
    assert_event_channel_empty(&mut event_rx);
}
