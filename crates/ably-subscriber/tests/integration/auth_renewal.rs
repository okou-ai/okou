#![cfg(test)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ably_subscriber::protocol::{ErrorInfo, ProtocolMessage, action, encode_msg, error_code};
use ably_subscriber::{Event, Subscription, TimingConfig, subscribe};
use futures_util::SinkExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;

use crate::support::*;

#[derive(Clone, Copy)]
enum Trigger {
    Proactive,
    ServerAuth,
}

#[derive(Clone, Copy)]
enum HeldPhase {
    Callback,
    Exchange,
}

struct Gate {
    entered: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

struct RenewalHarness {
    sub: Subscription,
    conn: WsStream,
    ws: MockAblyServer,
    release: Option<oneshot::Sender<()>>,
    initial_expires: i64,
    http_requests: Arc<AtomicUsize>,
    stop_http: oneshot::Sender<()>,
    http_task: JoinHandle<()>,
}

impl RenewalHarness {
    async fn start(trigger: Trigger, phase: HeldPhase, timing: TimingConfig) -> Self {
        let http = RawTokenServer::start().await.unwrap();
        let ws = MockAblyServer::start().await.unwrap();
        let mut config = test_config_with_timing(ws.port, http.port(), "ch", timing);
        let now = now_ms();
        let initial_expires = now
            + match trigger {
                Trigger::Proactive => 8_000,
                Trigger::ServerAuth => 3_600_000,
            };
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let gate = Gate {
            entered: entered_tx,
            release: release_rx,
        };
        let (callback_gate, mut exchange_gate) = match phase {
            HeldPhase::Callback => (Some(gate), None),
            HeldPhase::Exchange => (None, Some(gate)),
        };
        let callback_gate = Mutex::new(callback_gate);
        let first_callback = AtomicBool::new(true);
        let get_token = config.get_token;
        config.get_token = Box::new(move || {
            let gate = if first_callback.swap(false, Ordering::Relaxed) {
                None
            } else {
                callback_gate.lock().unwrap().take()
            };
            let token = get_token();
            Box::pin(async move {
                if let Some(gate) = gate {
                    gate.entered.send(()).unwrap();
                    gate.release.await?;
                }
                token.await
            })
        });

        let http_requests = Arc::new(AtomicUsize::new(0));
        let requests = http_requests.clone();
        let (stop_http, mut stop_rx) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            loop {
                let mut stream = tokio::select! {
                    biased;
                    _ = &mut stop_rx => return,
                    request = http.accept_request() => request.unwrap(),
                };
                let request_number = requests.fetch_add(1, Ordering::Relaxed) + 1;
                if request_number == 2
                    && let Some(gate) = exchange_gate.take()
                {
                    gate.entered.send(()).unwrap();
                    let mut byte = [0];
                    tokio::select! {
                        _ = &mut stop_rx => return,
                        released = gate.release => released.unwrap(),
                        result = stream.read(&mut byte) => {
                            assert_eq!(result.unwrap(), 0, "expected canceled HTTP request");
                            continue;
                        }
                    }
                }
                let (token, expires) = if request_number == 1 {
                    ("initial-token", initial_expires)
                } else {
                    ("renewed-token", now_ms() + 3_600_000)
                };
                let body = serde_json::to_vec(&serde_json::json!({
                    "token": token,
                    "issued": now,
                    "expires": expires,
                }))
                .unwrap();
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });

        let (sub, conn) = tokio::time::timeout(TEST_IO_TIMEOUT, async {
            tokio::join!(subscribe(config), ws.accept_and_handshake("ch", "conn-1"))
        })
        .await
        .expect("initial subscription handshake did not complete");
        let mut sub = sub.unwrap();
        let mut conn = conn.unwrap();
        expect_connected(&mut sub, "initial subscription")
            .await
            .unwrap();
        send_message(&mut conn, "ch", "baseline", serde_json::json!("payload"))
            .await
            .unwrap();
        expect_named_message(&mut sub, "baseline").await;
        if matches!(trigger, Trigger::ServerAuth) {
            request_auth(&mut conn).await;
        }
        wait_for_test_observation(entered_rx, "held token phase entered").await;

        Self {
            sub,
            conn,
            ws,
            release: Some(release_tx),
            initial_expires,
            http_requests,
            stop_http,
            http_task,
        }
    }

    async fn close(mut self) {
        let (result, ()) = tokio::join!(self.sub.close_and_wait(), async {
            let close = expect_protocol_msg(&mut self.conn, "CLOSE after renewal")
                .await
                .unwrap();
            assert_eq!(close.action, action::CLOSE);
            expect_websocket_closed(&mut self.conn).await.unwrap();
        });
        result.unwrap();
        if let Some(release) = self.release.as_mut() {
            expect_acquisition_canceled(release).await;
        }
        self.stop_http.send(()).unwrap();
        join_server_task(self.http_task, "token endpoint")
            .await
            .unwrap();
    }
}

async fn request_auth(conn: &mut WsStream) {
    send_protocol(
        conn,
        ProtocolMessage {
            action: action::AUTH,
            ..Default::default()
        },
    )
    .await;
}

async fn send_protocol(conn: &mut WsStream, message: ProtocolMessage) {
    conn.send(tungstenite::Message::Binary(
        encode_msg(&message).unwrap().into(),
    ))
    .await
    .unwrap();
}

async fn expect_acquisition_canceled(release: &mut oneshot::Sender<()>) {
    tokio::time::timeout(TEST_IO_TIMEOUT, release.closed())
        .await
        .expect("pending token acquisition was not canceled");
}

async fn expect_named_message(sub: &mut Subscription, name: &str) {
    match expect_event(sub, name).await.unwrap() {
        Event::Message(message) => {
            assert_eq!(message.name.as_deref(), Some(name));
            assert_eq!(message.data, serde_json::json!("payload"));
        }
        other => panic!("expected {name} message, got {other:?}"),
    }
}

async fn delivery_during_renewal(trigger: Trigger, phase: HeldPhase) {
    let mut harness = RenewalHarness::start(trigger, phase, TimingConfig::default()).await;
    // The following message proves all preceding duplicate AUTH frames were
    // processed while the same acquisition remained gated.
    for _ in 0..4 {
        request_auth(&mut harness.conn).await;
    }
    send_message(
        &mut harness.conn,
        "ch",
        "cancel",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "cancel").await;
    assert!(now_ms() < harness.initial_expires, "initial token expired");

    harness.release.take().unwrap().send(()).unwrap();
    let auth = expect_protocol_msg(&mut harness.conn, "renewed AUTH")
        .await
        .unwrap();
    assert_eq!(auth.action, action::AUTH);
    assert_eq!(auth.auth.unwrap().access_token, "renewed-token");
    send_message(
        &mut harness.conn,
        "ch",
        "after-auth",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "after-auth").await;
    assert_eq!(harness.http_requests.load(Ordering::Relaxed), 2);
    harness.close().await;
}

#[tokio::test]
async fn proactive_delivery_during_token_callback() {
    delivery_during_renewal(Trigger::Proactive, HeldPhase::Callback).await;
}

#[tokio::test]
async fn proactive_delivery_during_token_exchange() {
    delivery_during_renewal(Trigger::Proactive, HeldPhase::Exchange).await;
}

#[tokio::test]
async fn server_auth_delivery_during_token_callback() {
    delivery_during_renewal(Trigger::ServerAuth, HeldPhase::Callback).await;
}

#[tokio::test]
async fn server_auth_delivery_during_token_exchange() {
    delivery_during_renewal(Trigger::ServerAuth, HeldPhase::Exchange).await;
}

#[tokio::test]
async fn huge_renewal_timeout_keeps_delivery_and_close_live() {
    let mut timing = TimingConfig::default();
    timing.connect_timeout = Duration::MAX;
    let mut harness = RenewalHarness::start(Trigger::ServerAuth, HeldPhase::Callback, timing).await;
    send_message(
        &mut harness.conn,
        "ch",
        "during-renewal",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "during-renewal").await;
    harness.close().await;
}

#[tokio::test]
async fn close_cancels_pending_token_callback() {
    RenewalHarness::start(
        Trigger::ServerAuth,
        HeldPhase::Callback,
        TimingConfig::default(),
    )
    .await
    .close()
    .await;
}

#[tokio::test]
async fn close_cancels_pending_token_exchange() {
    RenewalHarness::start(
        Trigger::ServerAuth,
        HeldPhase::Exchange,
        TimingConfig::default(),
    )
    .await
    .close()
    .await;
}

async fn drop_cancels_acquisition(phase: HeldPhase) {
    let mut harness =
        RenewalHarness::start(Trigger::ServerAuth, phase, TimingConfig::default()).await;
    drop(harness.sub);
    let close = expect_protocol_msg(&mut harness.conn, "CLOSE after drop")
        .await
        .unwrap();
    assert_eq!(close.action, action::CLOSE);
    expect_websocket_closed(&mut harness.conn).await.unwrap();
    expect_acquisition_canceled(harness.release.as_mut().unwrap()).await;
    harness.stop_http.send(()).unwrap();
    join_server_task(harness.http_task, "token endpoint after drop")
        .await
        .unwrap();
}

#[tokio::test]
async fn drop_cancels_pending_token_callback() {
    drop_cancels_acquisition(HeldPhase::Callback).await;
}

#[tokio::test]
async fn drop_cancels_pending_token_exchange() {
    drop_cancels_acquisition(HeldPhase::Exchange).await;
}

async fn reconnect_cancels_acquisition(phase: HeldPhase) {
    let mut harness =
        RenewalHarness::start(Trigger::ServerAuth, phase, TimingConfig::default()).await;
    send_protocol(
        &mut harness.conn,
        ProtocolMessage {
            action: action::DISCONNECTED,
            ..Default::default()
        },
    )
    .await;
    assert!(matches!(
        expect_event(&mut harness.sub, "disconnect during renewal")
            .await
            .unwrap(),
        Event::Disconnected { .. }
    ));
    expect_websocket_closed(&mut harness.conn).await.unwrap();
    expect_acquisition_canceled(harness.release.as_mut().unwrap()).await;

    let (conn, connected) = tokio::time::timeout(TEST_IO_TIMEOUT, async {
        tokio::join!(
            harness.ws.accept_and_handshake("ch", "conn-2"),
            expect_connected(&mut harness.sub, "replacement connection")
        )
    })
    .await
    .expect("replacement subscription handshake did not complete");
    connected.unwrap();
    harness.conn = conn.unwrap();
    send_message(
        &mut harness.conn,
        "ch",
        "after-reconnect",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "after-reconnect").await;
    // The still-valid initial token is reused. No canceled result is applied
    // to conn-2, whose next outbound protocol message must be CLOSE.
    assert_eq!(
        harness.http_requests.load(Ordering::Relaxed),
        match phase {
            HeldPhase::Callback => 1,
            HeldPhase::Exchange => 2,
        }
    );
    harness.close().await;
}

#[tokio::test]
async fn reconnect_cancels_pending_token_callback() {
    reconnect_cancels_acquisition(HeldPhase::Callback).await;
}

#[tokio::test]
async fn reconnect_cancels_pending_token_exchange() {
    reconnect_cancels_acquisition(HeldPhase::Exchange).await;
}

async fn timed_out_acquisition_retries(phase: HeldPhase) {
    let mut timing = TimingConfig::default();
    timing.connect_timeout = Duration::from_secs(1);
    timing.token_renewal_retry_delay = Duration::from_millis(20);
    let mut harness = RenewalHarness::start(Trigger::ServerAuth, phase, timing).await;
    send_message(
        &mut harness.conn,
        "ch",
        "before-timeout",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "before-timeout").await;
    expect_acquisition_canceled(harness.release.as_mut().unwrap()).await;
    let auth = expect_protocol_msg(&mut harness.conn, "AUTH after renewal retry")
        .await
        .unwrap();
    assert_eq!(auth.action, action::AUTH);
    assert_eq!(auth.auth.unwrap().access_token, "renewed-token");
    assert_eq!(
        harness.http_requests.load(Ordering::Relaxed),
        match phase {
            HeldPhase::Callback => 2,
            HeldPhase::Exchange => 3,
        }
    );
    send_message(
        &mut harness.conn,
        "ch",
        "after-retry",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "after-retry").await;
    harness.close().await;
}

#[tokio::test]
async fn timed_out_token_callback_retries_on_same_connection() {
    timed_out_acquisition_retries(HeldPhase::Callback).await;
}

#[tokio::test]
async fn timed_out_token_exchange_retries_on_same_connection() {
    timed_out_acquisition_retries(HeldPhase::Exchange).await;
}

#[tokio::test]
async fn renewal_timeout_preserves_fatal_failure_limit() {
    let mut timing = TimingConfig::default();
    timing.connect_timeout = Duration::from_secs(1);
    timing.max_token_renewal_failures = 1;
    let mut harness = RenewalHarness::start(Trigger::ServerAuth, HeldPhase::Exchange, timing).await;
    send_message(
        &mut harness.conn,
        "ch",
        "before-fatal",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    expect_named_message(&mut harness.sub, "before-fatal").await;
    match expect_event(&mut harness.sub, "fatal renewal timeout")
        .await
        .unwrap()
    {
        Event::Error { code, message } => {
            assert_eq!(code, error_code::FAILED);
            assert_eq!(message, "Token renewal failed 1 consecutive times");
        }
        other => panic!("expected fatal renewal error, got {other:?}"),
    }
    expect_websocket_closed(&mut harness.conn).await.unwrap();
    expect_acquisition_canceled(harness.release.as_mut().unwrap()).await;
    expect_subscription_closed(&mut harness.sub, "fatal renewal timeout")
        .await
        .unwrap();
    harness.stop_http.send(()).unwrap();
    join_server_task(harness.http_task, "token endpoint after timeout")
        .await
        .unwrap();
}

#[tokio::test]
async fn fatal_error_cancels_acquisition_before_status_backpressure() {
    let mut timing = TimingConfig::default();
    timing.event_channel_capacity = 1;
    let mut harness = RenewalHarness::start(Trigger::ServerAuth, HeldPhase::Exchange, timing).await;
    send_message(
        &mut harness.conn,
        "ch",
        "queued",
        serde_json::json!("payload"),
    )
    .await
    .unwrap();
    // Receiving ATTACH proves the preceding MESSAGE filled the event channel.
    send_protocol(
        &mut harness.conn,
        ProtocolMessage {
            action: action::DETACHED,
            channel: Some("ch".into()),
            ..Default::default()
        },
    )
    .await;
    let attach = expect_protocol_msg(&mut harness.conn, "reattach while renewal pending")
        .await
        .unwrap();
    assert_eq!(attach.action, action::ATTACH);
    send_protocol(
        &mut harness.conn,
        ProtocolMessage {
            action: action::ERROR,
            error: Some(ErrorInfo {
                code: 50000,
                message: "connection failed".into(),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .await;
    expect_websocket_closed(&mut harness.conn).await.unwrap();
    expect_acquisition_canceled(harness.release.as_mut().unwrap()).await;
    expect_named_message(&mut harness.sub, "queued").await;
    assert!(matches!(
        expect_event(&mut harness.sub, "terminal error")
            .await
            .unwrap(),
        Event::Error { code: 50000, .. }
    ));
    expect_subscription_closed(&mut harness.sub, "terminal error")
        .await
        .unwrap();
    harness.stop_http.send(()).unwrap();
    join_server_task(harness.http_task, "token endpoint after terminal error")
        .await
        .unwrap();
}
