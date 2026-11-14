use super::*;

use ably_subscriber::protocol::{AblyMessage, ProtocolMessage, action, decode_msg, encode_msg};
use futures_util::SinkExt;
use httpmock::prelude::*;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_util::task::AbortOnDropHandle;

use crate::http::{HttpClient, HttpClientConfig};

const CHANNEL: &str = "runner-group:default";
const BOUND: Duration = Duration::from_secs(1);

struct ConnectedSupervisor {
    supervisor: AblySupervisor,
    messages: mpsc::UnboundedSender<Vec<AblyMessage>>,
    peer: AbortOnDropHandle<()>,
    input_notifications: ActiveInputNotifications,
    connector_runtime_sync: ConnectorRuntimeSyncHandle,
    _tokens: MockServer,
}

impl ConnectedSupervisor {
    async fn start(cancel_tokens: RunCancellationRegistry) -> Self {
        let tokens = MockServer::start_async().await;
        tokens
            .mock_async(|when, then| {
                when.method(POST).path("/keys/fixture.key/requestToken");
                then.status(201).json_body(serde_json::json!({
                    "token": "synthetic-token",
                    "expires": chrono::Utc::now().timestamp_millis() + 3_600_000,
                }));
            })
            .await;
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let (messages, mut receive) = mpsc::unbounded_channel();
        let peer = AbortOnDropHandle::new(tokio::spawn(async move {
            let (tcp, _) = socket.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let connected = ProtocolMessage {
                action: action::CONNECTED,
                connection_id: Some("blocked-cancel-fixture".into()),
                connection_key: Some("blocked-cancel!fixture".into()),
                ..Default::default()
            };
            ws.send(WsMessage::Binary(encode_msg(&connected).unwrap().into()))
                .await
                .unwrap();
            let attach = ws.next().await.unwrap().unwrap();
            let attach = decode_msg(&attach.into_data()).unwrap();
            assert_eq!(attach.action, action::ATTACH);
            assert_eq!(attach.channel.as_deref(), Some(CHANNEL));
            let attached = ProtocolMessage {
                action: action::ATTACHED,
                channel: Some(CHANNEL.into()),
                ..Default::default()
            };
            ws.send(WsMessage::Binary(encode_msg(&attached).unwrap().into()))
                .await
                .unwrap();
            loop {
                tokio::select! {
                    Some(messages) = receive.recv() => {
                        let notification = ProtocolMessage {
                            action: action::MESSAGE,
                            channel: Some(CHANNEL.into()),
                            messages: Some(messages),
                            ..Default::default()
                        };
                        ws.send(WsMessage::Binary(encode_msg(&notification).unwrap().into()))
                            .await
                            .unwrap();
                    }
                    frame = ws.next() => {
                        match frame.expect("supervisor should close its subscription").unwrap() {
                            WsMessage::Close(_) => {
                                ws.flush().await.unwrap();
                                break;
                            }
                            frame => assert_eq!(
                                decode_msg(&frame.into_data()).unwrap().action,
                                action::CLOSE,
                            ),
                        }
                    }
                }
            }
        }));
        let api = ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: tokens.base_url(),
                vercel_bypass: None,
                client_session_id: "blocked-cancel-fixture".into(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })
            .unwrap(),
            "synthetic-runner-token".into(),
        );
        let mut config = make_ably_config(&api, "default");
        config.get_token = Box::new(|| {
            Box::pin(async {
                Ok(ably_subscriber::TokenRequest {
                    key_name: "fixture.key".into(),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                    nonce: "fixture-nonce".into(),
                    mac: "fixture-mac".into(),
                    capability: "{\"*\":[\"subscribe\"]}".into(),
                    ttl: None,
                    client_id: None,
                })
            })
        });
        config.host = Some(address.to_string());
        config.rest_host = Some(tokens.address().to_string());
        let subscription = tokio::time::timeout(BOUND, ably_subscriber::subscribe(config))
            .await
            .expect("loopback subscription should connect")
            .unwrap();
        let input_notifications = ActiveInputNotifications::new();
        let mut connected = input_notifications.subscribe(RunId::new_v4());
        let connector_runtime_sync = ConnectorRuntimeSyncHandle::new(api.clone());
        let supervisor = AblySupervisor::connected_for_test(
            AblySupervisorConfig {
                ably_side_message_handler: None,
                api,
                group: "default".into(),

                cancel_tokens,
                connector_runtime_sync: connector_runtime_sync.clone(),
                active_input_notifications: input_notifications.clone(),
                provider_cancel: CancellationToken::new(),
            },
            subscription,
        );
        tokio::time::timeout(BOUND, connected.wait())
            .await
            .expect("initial reconnect wakeup must settle before observing a Run message");
        Self {
            supervisor,
            messages,
            peer,
            input_notifications,
            connector_runtime_sync,
            _tokens: tokens,
        }
    }

    async fn cancel_then_input(&self, run_id: RunId, input_run_id: RunId) {
        // Observe control progress after a transfer-blocked cancellation.
        let mut input = self.input_notifications.subscribe(input_run_id);
        self.messages
            .send(vec![
                AblyMessage {
                    name: Some("cancel".into()),
                    data: Some(serde_json::json!({ "runId": run_id, "mode": "hard" })),
                    ..Default::default()
                },
                AblyMessage {
                    name: Some("active-input".into()),
                    data: Some(serde_json::json!({
                        "runId": input_run_id,
                    })),
                    ..Default::default()
                },
            ])
            .unwrap();
        tokio::time::timeout(BOUND, input.wait())
            .await
            .expect("active input must progress while cancellation is blocked");
    }

    async fn shutdown(&mut self) {
        tokio::time::timeout(BOUND, self.supervisor.shutdown())
            .await
            .expect("supervisor shutdown should drop blocked cancellation delivery");
        tokio::time::timeout(BOUND, &mut self.peer)
            .await
            .expect("subscription peer should close")
            .unwrap();
        self.connector_runtime_sync.shutdown().await;
    }
}

impl Drop for ConnectedSupervisor {
    fn drop(&mut self) {
        // An assertion/timeout must not leave a transfer-blocked worker behind.
        // Successful shutdown already joined and removed this handle.
        if let Some(task) = self.supervisor.task.get_mut().take() {
            task.abort();
        }
    }
}

#[tokio::test]
async fn supervisor_shutdown_drops_transfer_blocked_cancel_after_unrelated_progress() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let input_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let transfer_guard = registration.handle().transfer_guard().await;
    let mut connected = ConnectedSupervisor::start(tokens).await;

    connected.cancel_then_input(run_id, input_run_id).await;
    assert!(!signals.any().is_cancelled());
    connected.shutdown().await;

    drop(transfer_guard);
    assert!(!signals.any().is_cancelled());
    assert!(registration.unregister().await);
}

#[tokio::test]
async fn queued_cancel_preserves_registration_and_allows_unrelated_notification() {
    let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
    let input_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
    let tokens = RunCancellationRegistry::new();
    let registration = tokens.register(run_id).await.unwrap();
    let signals = registration.handle().signals();
    let transfer_guard = registration.handle().transfer_guard().await;
    let mut connected = ConnectedSupervisor::start(tokens.clone()).await;

    connected.cancel_then_input(run_id, input_run_id).await;
    assert!(registration.unregister().await);
    let replacement = tokens.register(run_id).await.unwrap();
    assert!(!signals.any().is_cancelled());

    drop(transfer_guard);
    tokio::time::timeout(BOUND, signals.hard().cancelled())
        .await
        .expect("queued cancellation should complete after transfer");
    connected.shutdown().await;
    assert!(!replacement.is_cancelled());
    assert!(replacement.unregister().await);
}
