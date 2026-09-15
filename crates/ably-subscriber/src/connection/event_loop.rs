//! Event loop, reconnection, and token renewal.

use std::{collections::HashMap, time::Duration};

use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

use super::auth::exchange_token;
use super::endpoint::build_ws_url;
use super::errors::{
    channel_detached_message, error_or_unknown, protocol_disconnect_reason, protocol_error_message,
};
use super::handshake::{
    AttachOutcome, encode_attach_for_channel, wait_for_attach_outcome, wait_for_connected,
};
use super::message::{decode_data, message_targets_channel};
use super::session::{SessionState, TokenRenewalFailure};
use super::state::{ChannelLifecycleState, reconnect_spacing_delay, retry_delay};
use super::transport::{
    TransportCloseTracker, WsTransport, close_websocket_sink, connect_pending,
    websocket_close_frame_reason, websocket_close_reason, websocket_error_reason,
};
use crate::Error;
use crate::protocol::{
    AuthDetails, ProtocolMessage, action, decode_msg, encode_msg, error_code, flags,
};
use crate::subscribe::CloseRequest;
use crate::types::{Event, Message, TimingConfig, TokenDetails, TokenFuture};

const DROP_WARNING_INTERVAL: Duration = Duration::from_secs(60);
type CloseReceiver = oneshot::Receiver<CloseRequest>;

#[derive(Default)]
pub(crate) struct DropWarningState {
    total_dropped: u64,
    reported_dropped: u64,
    last_reported_at: Option<Instant>,
    report_at: Option<Instant>,
}

struct DropWarningReport {
    dropped_since_last: u64,
    total_dropped: u64,
}

impl DropWarningState {
    fn record_drop(&mut self) -> Option<DropWarningReport> {
        self.total_dropped += 1;
        if self.report_at.is_some() {
            return None;
        }

        let now = Instant::now();
        let Some(last_reported_at) = self.last_reported_at else {
            return Some(self.take_report(now));
        };
        let report_at = last_reported_at + DROP_WARNING_INTERVAL;
        if now >= report_at {
            return Some(self.take_report(now));
        }

        self.report_at = Some(report_at);
        None
    }

    fn report_at(&self) -> Option<Instant> {
        self.report_at
    }

    fn take_due_report(&mut self) -> DropWarningReport {
        self.take_report(Instant::now())
    }

    fn take_report(&mut self, now: Instant) -> DropWarningReport {
        let report = DropWarningReport {
            dropped_since_last: self.total_dropped - self.reported_dropped,
            total_dropped: self.total_dropped,
        };
        self.reported_dropped = self.total_dropped;
        self.last_reported_at = Some(now);
        self.report_at = None;
        report
    }
}

fn warn_dropped_messages(report: DropWarningReport) {
    tracing::warn!(
        dropped_since_last = report.dropped_since_last,
        total_dropped = report.total_dropped,
        "event channel full, dropping message"
    );
}

pub(crate) struct EventLoopState {
    pub transport: Option<WsTransport>,
    pub event_tx: mpsc::Sender<Event>,
    pub session: SessionState,
    pub channel: String,
    pub channel_params: Option<HashMap<String, String>>,
    pub realtime_host: String,
    pub rest_host: String,
    pub http: reqwest::Client,
    pub get_token: Box<dyn Fn() -> TokenFuture + Send + Sync>,
    pub pending_token_renewal: Option<PendingTokenRenewal>,
    pub timing: TimingConfig,
    pub drop_warnings: DropWarningState,
    pub transport_close_tracker: TransportCloseTracker,
}

async fn sleep_until_optional(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

async fn enter_suspended_retry(p: &mut EventLoopState, close_rx: &mut CloseReceiver) -> bool {
    p.session.enter_suspended_retry_state();
    let event = Event::Disconnected {
        reason: Some("connection state expired; entering suspended retry".to_string()),
    };
    send_status_event(p, close_rx, event, "suspended").await
}

// Caller-requested shutdown should send Ably CLOSE before closing the WebSocket
// so the connection state is explicitly terminated.
async fn send_close_message(p: &mut EventLoopState) -> Result<(), Error> {
    p.pending_token_renewal = None;
    p.session.request_closing();
    let result = if let Some(transport) = p.transport.take() {
        let WsTransport {
            ws_read: _ws_read,
            mut ws_write,
        } = transport;
        let close_timeout = p.timing.close_timeout;
        match tokio::time::timeout(close_timeout, async move {
            let close_msg = ProtocolMessage {
                action: action::CLOSE,
                ..Default::default()
            };
            let protocol_result = match encode_msg(&close_msg) {
                Ok(data) => ws_write
                    .send(tungstenite::Message::Binary(data.into()))
                    .await
                    .map_err(Error::from),
                Err(error) => Err(error),
            };
            let websocket_result = close_websocket_sink(&mut ws_write).await;
            match (protocol_result, websocket_result) {
                (Ok(()), result) | (result, Ok(())) => result,
                (Err(error), Err(close_error)) => {
                    tracing::warn!(
                        error = %close_error,
                        "Additional websocket close failure"
                    );
                    Err(error)
                }
            }
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err(Error::Protocol {
                code: error_code::TIMEOUT,
                message: "Subscription close timed out".to_string(),
            }),
        }
    } else {
        Ok(())
    };
    p.session.mark_closed();
    result
}

async fn complete_close_request(
    p: &mut EventLoopState,
    request: Result<CloseRequest, oneshot::error::RecvError>,
) {
    // `tokio::select!` drops non-selected branch futures before running their
    // handlers, so a canceled reconnect registers its cleanup before this wait.
    let direct_result = send_close_message(p).await;
    let cleanup_result = p.transport_close_tracker.close_and_wait().await;
    let result = match (direct_result, cleanup_result) {
        (Ok(()), result) | (result, Ok(())) => result,
        (Err(error), Err(cleanup_error)) => {
            tracing::warn!(
                error = %cleanup_error,
                "Additional websocket transport close failure"
            );
            Err(error)
        }
    };
    match request {
        Ok(request) => request.complete(result),
        Err(_) => {
            if let Err(error) = result {
                tracing::warn!(%error, "Failed to close subscription");
            }
        }
    }
}

// Transport-only shutdown paths must not send Ably CLOSE, which would terminate
// resumable connection state or duplicate a server-declared CLOSED transition.
//
// The transport is detached synchronously so status events and reconnects are
// not delayed by a slow close handshake. The bounded background close still
// releases the socket without keeping it in `EventLoopState`.
fn close_websocket_transport(p: &mut EventLoopState) {
    p.pending_token_renewal = None;
    let Some(transport) = p.transport.take() else {
        return;
    };
    transport.close_in_background(p.timing.close_timeout, &p.transport_close_tracker);
}

async fn send_status_event(
    p: &mut EventLoopState,
    close_rx: &mut CloseReceiver,
    event: Event,
    status_event: &'static str,
) -> bool {
    tokio::select! {
        biased;
        request = &mut *close_rx => {
            tracing::info!(status_event, "Close requested while sending status event");
            complete_close_request(p, request).await;
            false
        }
        result = p.event_tx.send(event) => result.is_ok(),
    }
}

async fn send_terminal_status_event(
    p: &mut EventLoopState,
    close_rx: &mut CloseReceiver,
    event: Event,
    status_event: &'static str,
) -> bool {
    // Terminal status events can be backpressured by a slow consumer. Release
    // the socket first so an unpolled Subscription cannot keep it alive.
    close_websocket_transport(p);
    send_status_event(p, close_rx, event, status_event).await
}

pub(crate) async fn run_event_loop(mut p: EventLoopState, mut close_rx: CloseReceiver) {
    let mut last_reconnect_attempt: Option<Instant> = None;

    'outer: loop {
        let mut disconnected_sent = false;
        let mut refresh_token = false;
        let mut immediate_retry = false;
        let mut disconnect_reason = None;
        let mut close_before_reconnect = false;
        // Main message processing loop
        loop {
            let Some(transport) = p.transport.as_ref() else {
                tracing::warn!("WebSocket transport missing before receive loop");
                break;
            };
            let idle_deadline = transport
                .ws_read
                .idle_deadline(p.session.max_idle_interval(), p.timing.heartbeat_margin);
            let heartbeat_elapsed =
                idle_deadline.is_some_and(|(deadline, _)| deadline <= Instant::now());

            if !heartbeat_elapsed {
                if let Some(attach_timed_out) = p.session.clear_elapsed_channel_operation_deadline(
                    Instant::now(),
                    p.timing.channel_retry_timeout,
                ) {
                    if attach_timed_out {
                        tracing::warn!(
                            timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                            "Channel attach timed out, entering suspended channel retry"
                        );
                    }
                    continue;
                }

                if let Some(should_attach) = p.session.clear_elapsed_channel_retry(Instant::now()) {
                    if should_attach
                        && p.session
                            .begin_channel_attach(p.timing.realtime_request_timeout)
                    {
                        match send_attach(&mut p, &mut close_rx).await {
                            LoopAction::Stop => return,
                            LoopAction::Reconnect {
                                disconnected_event,
                                refresh_token: action_refresh_token,
                            } => {
                                record_reconnect_disconnected_event(
                                    &mut disconnected_sent,
                                    disconnected_event,
                                );
                                refresh_token |= action_refresh_token;
                                immediate_retry = true;
                                break;
                            }
                            LoopAction::Continue => {}
                        }
                    }
                    continue;
                }
            }

            let drop_warning_deadline = p.drop_warnings.report_at();
            let Some(transport) = p.transport.as_mut() else {
                tracing::warn!("WebSocket transport missing before receive loop");
                break;
            };

            let event = tokio::select! {
                biased;

                request = &mut close_rx => {
                    ReceiveLoopEvent::CloseRequested(request)
                }

                event = wait_for_token_renewal(&mut p.pending_token_renewal) => event,

                _ = sleep_until_optional(p.session.token_renewal_at()), if p.pending_token_renewal.is_none() && p.session.token_renewal_at().is_some() => {
                    ReceiveLoopEvent::TokenRenewal
                }

                _ = sleep_until_optional(drop_warning_deadline), if drop_warning_deadline.is_some() => {
                    ReceiveLoopEvent::DropWarningDeadline
                }

                frame = transport.ws_read.next() => {
                    ReceiveLoopEvent::Frame(frame)
                }

                _ = sleep_until_optional(idle_deadline.map(|(deadline, _)| deadline)), if idle_deadline.is_some() => {
                    let Some((_, idle_timeout)) = idle_deadline else {
                        continue;
                    };
                    ReceiveLoopEvent::HeartbeatTimeout { idle_timeout }
                }

                _ = sleep_until_optional(p.session.channel_operation_deadline()), if p.session.channel_operation_deadline().is_some() => {
                    ReceiveLoopEvent::ChannelOperationDeadline
                }

                _ = sleep_until_optional(p.session.channel_retry_at()), if p.session.channel_retry_at().is_some() => {
                    ReceiveLoopEvent::ChannelRetry
                }
            };

            match event {
                ReceiveLoopEvent::CloseRequested(request) => {
                    tracing::info!("Close requested");
                    complete_close_request(&mut p, request).await;
                    return;
                }
                ReceiveLoopEvent::TokenRenewal => {
                    start_token_renewal(&mut p);
                }
                ReceiveLoopEvent::TokenAcquired { result, deadline } => {
                    p.pending_token_renewal = None;
                    let result = match result {
                        Ok(Ok(token)) => tokio::select! {
                            biased;
                            request = &mut close_rx => {
                                tracing::info!("Close requested during token renewal");
                                complete_close_request(&mut p, request).await;
                                return;
                            }
                            result = tokio::time::timeout_at(deadline, send_auth(&mut p, token)) => result,
                        },
                        Ok(Err(error)) => Ok(Err(error)),
                        Err(elapsed) => Err(elapsed),
                    };
                    if handle_renewal_result(&mut p, &mut close_rx, result).await {
                        return;
                    }
                }
                ReceiveLoopEvent::DropWarningDeadline => {
                    warn_dropped_messages(p.drop_warnings.take_due_report());
                }
                ReceiveLoopEvent::ChannelOperationDeadline => {
                    if let Some(attach_timed_out) =
                        p.session.clear_elapsed_channel_operation_deadline(
                            Instant::now(),
                            p.timing.channel_retry_timeout,
                        )
                        && attach_timed_out
                    {
                        tracing::warn!(
                            timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                            "Channel attach timed out, entering suspended channel retry"
                        );
                    }
                }
                ReceiveLoopEvent::ChannelRetry => {
                    if let Some(should_attach) =
                        p.session.clear_elapsed_channel_retry(Instant::now())
                        && should_attach
                        && p.session
                            .begin_channel_attach(p.timing.realtime_request_timeout)
                    {
                        match send_attach(&mut p, &mut close_rx).await {
                            LoopAction::Stop => return,
                            LoopAction::Reconnect {
                                disconnected_event,
                                refresh_token: action_refresh_token,
                            } => {
                                record_reconnect_disconnected_event(
                                    &mut disconnected_sent,
                                    disconnected_event,
                                );
                                refresh_token |= action_refresh_token;
                                immediate_retry = true;
                                break;
                            }
                            LoopAction::Continue => {}
                        }
                    }
                }
                ReceiveLoopEvent::Frame(frame) => {
                    match frame {
                        Some(Ok(tungstenite::Message::Binary(data))) => match decode_msg(&data) {
                            Ok(msg) => match handle_message(&mut p, msg, &mut close_rx).await {
                                LoopAction::Stop => return,
                                LoopAction::Reconnect {
                                    disconnected_event,
                                    refresh_token: action_refresh_token,
                                } => {
                                    record_reconnect_disconnected_event(
                                        &mut disconnected_sent,
                                        disconnected_event,
                                    );
                                    refresh_token |= action_refresh_token;
                                    immediate_retry = true;
                                    break;
                                }
                                LoopAction::Continue => {}
                            },
                            Err(e) => {
                                tracing::warn!("Failed to decode message: {e}");
                            }
                        },
                        Some(Ok(tungstenite::Message::Close(frame))) => {
                            let reason = websocket_close_reason(frame.as_ref());
                            if let Some(ref f) = frame {
                                let close_reason = websocket_close_frame_reason(f);
                                tracing::info!(
                                    code = %f.code,
                                    reason = %close_reason,
                                    "WebSocket Close frame received",
                                );
                            } else {
                                tracing::info!(
                                    "WebSocket Close frame received without close frame"
                                );
                            }
                            disconnect_reason = Some(reason);
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                        Some(Ok(_)) => {
                            // Ignore text, ping, pong frames
                        }
                        Some(Err(e)) => {
                            let reason = websocket_error_reason(&e);
                            tracing::info!(%reason, "WebSocket error, reconnecting");
                            disconnect_reason = Some(reason);
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                        None => {
                            disconnect_reason = Some("websocket stream ended".to_string());
                            tracing::info!("WebSocket stream ended");
                            immediate_retry = true;
                            close_before_reconnect = true;
                            break; // → reconnect
                        }
                    }
                }
                ReceiveLoopEvent::HeartbeatTimeout { idle_timeout } => {
                    disconnect_reason = Some(format!("heartbeat timeout after {idle_timeout:?}"));
                    immediate_retry = true;
                    close_before_reconnect = true;
                    tracing::info!("Heartbeat timeout, reconnecting");
                    break; // → reconnect
                }
            }
        }

        // --- Reconnection ---
        // Acquisition belongs to the transport that started it. Cancel it
        // before status-event backpressure or any replacement connection.
        p.pending_token_renewal = None;
        p.session.mark_connection_disconnected(Instant::now());
        if close_before_reconnect {
            close_websocket_transport(&mut p);
        }
        if !disconnected_sent {
            let event = Event::Disconnected {
                reason: disconnect_reason,
            };
            if !send_status_event(&mut p, &mut close_rx, event, "disconnected").await {
                return;
            }
        }

        let mut retry_immediately = immediate_retry;
        let mut disconnected_retry_count: u32 = 0;
        let mut pending_reconnect_token: Option<PendingReconnectToken> = None;
        loop {
            if p.session.should_enter_suspended_retry()
                && !enter_suspended_retry(&mut p, &mut close_rx).await
            {
                return;
            }

            // ably-js retries immediately when an active connection becomes
            // disconnected, with a one-second guard against tight reconnect
            // loops. Subsequent disconnected retries use jittered retry time;
            // suspended retries use the fixed suspendedRetryTimeout.
            let backoff_duration = if retry_immediately {
                retry_immediately = false;
                let delay = reconnect_spacing_delay(
                    last_reconnect_attempt,
                    p.timing.min_reconnect_interval,
                );
                if delay == Duration::ZERO {
                    tracing::info!("Reconnecting immediately after connection interruption");
                } else {
                    tracing::info!(
                        delay_ms = delay.as_millis(),
                        "Delaying reconnect after repeated connection interruption"
                    );
                }
                delay
            } else if p.session.connection_is_suspended() {
                p.timing.suspended_retry_timeout
            } else {
                disconnected_retry_count = disconnected_retry_count.saturating_add(1);
                retry_delay(
                    p.timing.disconnected_retry_timeout,
                    disconnected_retry_count,
                )
            };
            let suspend_at = p.session.suspend_deadline();
            tokio::select! {
                biased;
                request = &mut close_rx => {
                    tracing::info!("Close requested during reconnect");
                    complete_close_request(&mut p, request).await;
                    return;
                }
                _ = sleep_until_optional(suspend_at), if suspend_at.is_some() => {
                    if !enter_suspended_retry(&mut p, &mut close_rx).await {
                        return;
                    }
                    continue;
                }
                _ = tokio::time::sleep(backoff_duration) => {}
            }

            last_reconnect_attempt = Some(Instant::now());
            p.session.request_connecting();
            let suspend_at = p.session.suspend_deadline();
            let reconnect_result = tokio::select! {
                biased;
                request = &mut close_rx => {
                    tracing::info!("Close requested during reconnect attempt");
                    complete_close_request(&mut p, request).await;
                    return;
                }
                _ = sleep_until_optional(suspend_at), if suspend_at.is_some() => {
                    if !enter_suspended_retry(&mut p, &mut close_rx).await {
                        return;
                    }
                    continue;
                }
                result = attempt_reconnect(
                    &mut p,
                    &mut refresh_token,
                    &mut pending_reconnect_token,
                ) => result,
            };

            match reconnect_result {
                Ok(ReconnectOutcome::Attached {
                    connected_msg,
                    channel_serial,
                    token,
                    transport,
                }) => {
                    p.session.commit_reconnect_attached(
                        &connected_msg,
                        channel_serial,
                        token,
                        p.timing.token_renewal_margin,
                    );
                    p.transport = Some(transport);
                    if !send_status_event(&mut p, &mut close_rx, Event::Connected, "connected")
                        .await
                    {
                        return;
                    }
                    continue 'outer;
                }
                Ok(ReconnectOutcome::ChannelSuspended {
                    connected_msg,
                    token,
                    transport,
                }) => {
                    p.session.commit_reconnect_channel_suspended(
                        &connected_msg,
                        token,
                        p.timing.token_renewal_margin,
                        p.timing.channel_retry_timeout,
                    );
                    p.transport = Some(transport);
                    continue 'outer;
                }
                Ok(ReconnectOutcome::Closed) => {
                    p.session.commit_reconnect_closed();
                    return;
                }
                Err(e) => {
                    tracing::warn!("Reconnect attempt failed: {e}");
                }
            }
            p.session.mark_reconnect_failed_if_not_suspended();
        }
    }
}

enum ReceiveLoopEvent {
    CloseRequested(Result<CloseRequest, oneshot::error::RecvError>),
    TokenRenewal,
    TokenAcquired {
        result: Result<Result<TokenDetails, Error>, tokio::time::error::Elapsed>,
        deadline: Instant,
    },
    DropWarningDeadline,
    ChannelOperationDeadline,
    ChannelRetry,
    Frame(Option<Result<tungstenite::Message, tungstenite::Error>>),
    HeartbeatTimeout {
        idle_timeout: Duration,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum LoopAction {
    Continue,
    Stop,
    Reconnect {
        disconnected_event: DisconnectedEvent,
        refresh_token: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisconnectedEvent {
    Pending,
    Sent,
}

fn record_reconnect_disconnected_event(
    disconnected_sent: &mut bool,
    disconnected_event: DisconnectedEvent,
) {
    *disconnected_sent = disconnected_event == DisconnectedEvent::Sent;
}

enum ReconnectOutcome {
    Attached {
        connected_msg: ProtocolMessage,
        channel_serial: Option<String>,
        token: Option<TokenDetails>,
        transport: WsTransport,
    },
    ChannelSuspended {
        connected_msg: ProtocolMessage,
        token: Option<TokenDetails>,
        transport: WsTransport,
    },
    Closed,
}

struct PendingReconnectToken {
    details: TokenDetails,
    renewal_at: Option<Instant>,
}

async fn send_attach(p: &mut EventLoopState, close_rx: &mut CloseReceiver) -> LoopAction {
    let data = match encode_attach_for_channel(
        &p.channel,
        p.channel_params.as_ref(),
        p.session.channel_serial(),
        p.session.attach_mode(),
    ) {
        Ok(data) => data,
        Err(e) => {
            tracing::warn!("Failed to encode attach message: {e}");
            close_websocket_transport(p);
            return LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
                refresh_token: false,
            };
        }
    };

    let connect_timeout = p.timing.connect_timeout;
    let Some(transport) = p.transport.as_mut() else {
        tracing::warn!("Missing websocket transport for attach");
        return LoopAction::Reconnect {
            disconnected_event: DisconnectedEvent::Pending,
            refresh_token: false,
        };
    };
    let send_result = tokio::select! {
        biased;
        request = &mut *close_rx => {
            tracing::info!("Close requested during channel attach");
            complete_close_request(p, request).await;
            return LoopAction::Stop;
        }
        result = tokio::time::timeout(
            connect_timeout,
            transport.ws_write.send(tungstenite::Message::Binary(data.into())),
        ) => result,
    };
    match send_result {
        Ok(Ok(())) => LoopAction::Continue,
        Ok(Err(_)) => {
            tracing::warn!("Failed to send attach, triggering reconnect");
            close_websocket_transport(p);
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
                refresh_token: false,
            }
        }
        Err(_) => {
            tracing::warn!("Timed out sending attach, triggering reconnect");
            close_websocket_transport(p);
            LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Pending,
                refresh_token: false,
            }
        }
    }
}

async fn handle_message(
    p: &mut EventLoopState,
    msg: ProtocolMessage,
    close_rx: &mut CloseReceiver,
) -> LoopAction {
    match msg.action {
        action::HEARTBEAT => {}
        action::MESSAGE => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }
            if p.session.channel_state() != ChannelLifecycleState::Attached {
                tracing::info!(
                    channel_state = ?p.session.channel_state(),
                    "Skipping message while channel is not attached"
                );
                return LoopAction::Continue;
            }
            if let Some(serial) = msg.channel_serial {
                p.session.record_channel_serial(serial);
            }
            if let Some(messages) = msg.messages {
                for (i, m) in messages.into_iter().enumerate() {
                    // Use try_reserve (non-blocking) for messages: if the
                    // consumer falls behind, we drop messages before payload
                    // decoding rather than stalling the event loop or doing
                    // work for messages that will be discarded. Status events
                    // (Connected, Disconnected, Error) use .send().await
                    // because they must not be lost.
                    match p.event_tx.try_reserve() {
                        Ok(permit) => {
                            let raw = m.data.unwrap_or(serde_json::Value::Null);
                            let data = decode_data(raw, m.encoding.as_deref());
                            let id =
                                m.id.or_else(|| msg.id.as_ref().map(|pid| format!("{pid}:{i}")));
                            let timestamp = m.timestamp.or(msg.timestamp);
                            permit.send(Event::Message(Message {
                                name: m.name,
                                data,
                                id,
                                client_id: m.client_id,
                                timestamp,
                            }));
                        }
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            if let Some(report) = p.drop_warnings.record_drop() {
                                warn_dropped_messages(report);
                            }
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            return LoopAction::Stop;
                        }
                    }
                }
            }
        }
        action::DISCONNECTED => {
            // ably-js always reconnects on mid-session DISCONNECTED regardless
            // of retriability. The server may send DISCONNECTED with a non-
            // retriable error (e.g. 429 rate limit) but still expect the client
            // to reconnect after backoff. Only connection-level ERROR is fatal.
            let refresh_token = msg
                .error
                .as_ref()
                .is_some_and(|error| error_code::is_token_error(error.code));
            let reason = Some(protocol_disconnect_reason(msg.error));
            p.session.notify_protocol_disconnected();
            close_websocket_transport(p);
            if !send_status_event(p, close_rx, Event::Disconnected { reason }, "disconnected").await
            {
                return LoopAction::Stop;
            }
            return LoopAction::Reconnect {
                disconnected_event: DisconnectedEvent::Sent,
                refresh_token,
            };
        }
        action::ERROR => {
            let err = error_or_unknown(msg.error);
            if let Some(channel) = msg.channel.as_deref() {
                if channel != p.channel {
                    return LoopAction::Continue;
                }

                if err.code == 80016 {
                    if p.session
                        .begin_channel_attach(p.timing.realtime_request_timeout)
                    {
                        return send_attach(p, close_rx).await;
                    }
                    return LoopAction::Continue;
                }

                p.session.enter_channel_failed();
            } else {
                p.session.enter_connection_failed();
            }
            let event = Event::Error {
                code: err.code,
                message: protocol_error_message(err.message),
            };
            let _ = send_terminal_status_event(p, close_rx, event, "error").await;
            return LoopAction::Stop;
        }
        action::DETACHED => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }

            let reason = msg.error.as_ref().map_or_else(
                || "Channel detached".to_string(),
                |err| channel_detached_message(&err.message),
            );
            match p.session.channel_state() {
                ChannelLifecycleState::Attaching => {
                    // Mirrors ably-js RealtimeChannel.processMessage(DETACHED):
                    // a detach while an attach is in progress moves the
                    // channel to suspended and starts the channel retry timer.
                    tracing::warn!(channel = ?msg.channel, %reason, "Channel detached while attaching");
                    p.session
                        .enter_channel_suspended(p.timing.channel_retry_timeout);
                }
                ChannelLifecycleState::Attached | ChannelLifecycleState::Suspended => {
                    // RTL13a in ably-js: attached/suspended channels request
                    // attaching again immediately on DETACHED, independent of
                    // the error's retriability.
                    tracing::warn!(channel = ?msg.channel, %reason, "Channel detached, re-attaching");
                    if p.session
                        .begin_channel_attach(p.timing.realtime_request_timeout)
                    {
                        return send_attach(p, close_rx).await;
                    }
                }
                ChannelLifecycleState::Detached | ChannelLifecycleState::Failed => {}
            }
        }
        action::ATTACHED => {
            if !message_targets_channel(&msg, &p.channel) {
                return LoopAction::Continue;
            }
            if let Some(serial) = msg.channel_serial {
                p.session.record_channel_serial(serial);
            }
            p.session.mark_channel_attached();
            let f = msg.flags.unwrap_or(0);
            let resumed = f & flags::HAS_CHANNEL_RESUMED != 0;
            let has_backlog = f & flags::HAS_BACKLOG != 0;
            let has_presence = f & flags::HAS_PRESENCE != 0;
            tracing::info!(
                channel = ?msg.channel,
                resumed,
                has_backlog,
                has_presence,
                "Channel attached",
            );
            if p.session.take_connected_event_pending()
                && !send_status_event(p, close_rx, Event::Connected, "connected").await
            {
                return LoopAction::Stop;
            }
        }
        action::CONNECTED => {
            p.session.update_from_connected(&msg);
        }
        action::CLOSED => {
            tracing::info!("Connection closed by server");
            p.session.mark_closed();
            close_websocket_transport(p);
            return LoopAction::Stop;
        }
        action::AUTH => {
            tracing::info!("Server requested reauthentication");
            start_token_renewal(p);
        }
        _ => {
            tracing::info!(action = msg.action, "Ignoring unknown action");
        }
    }
    LoopAction::Continue
}

// ---------------------------------------------------------------------------
// Token renewal
// ---------------------------------------------------------------------------

pub(crate) struct PendingTokenRenewal {
    acquisition:
        BoxFuture<'static, Result<Result<TokenDetails, Error>, tokio::time::error::Elapsed>>,
    deadline: Instant,
}

fn start_token_renewal(p: &mut EventLoopState) {
    if p.pending_token_renewal.is_some() {
        return;
    }

    tracing::info!("Renewing token");
    // Keep Tokio's overflow-safe conversion for caller-supplied timeouts.
    let deadline = tokio::time::sleep(p.timing.connect_timeout).deadline();
    let token_request = (p.get_token)();
    let http = p.http.clone();
    let rest_host = p.rest_host.clone();
    p.pending_token_renewal = Some(PendingTokenRenewal {
        acquisition: Box::pin(tokio::time::timeout_at(deadline, async move {
            let token_request = token_request.await.map_err(Error::TokenFetch)?;
            exchange_token(&http, &token_request, &rest_host).await
        })),
        deadline,
    });
}

async fn wait_for_token_renewal(pending: &mut Option<PendingTokenRenewal>) -> ReceiveLoopEvent {
    match pending {
        Some(renewal) => ReceiveLoopEvent::TokenAcquired {
            result: renewal.acquisition.as_mut().await,
            deadline: renewal.deadline,
        },
        None => std::future::pending().await,
    }
}

/// Handle the result of a token renewal attempt. Returns `true` if the failure
/// is fatal (caller should terminate).
async fn handle_renewal_result(
    p: &mut EventLoopState,
    close_rx: &mut CloseReceiver,
    result: Result<Result<(), Error>, tokio::time::error::Elapsed>,
) -> bool {
    let failure_reason = match result {
        Ok(Ok(())) => {
            p.session.record_successful_token_renewal();
            return false;
        }
        Ok(Err(e)) => format!("Token renewal failed: {e}"),
        Err(_) => "Token renewal timed out".to_string(),
    };

    let failure = p.session.record_failed_token_renewal(
        p.timing.max_token_renewal_failures,
        p.timing.token_renewal_retry_delay,
    );
    let failures = match failure {
        TokenRenewalFailure::Retry { failures } | TokenRenewalFailure::Fatal { failures } => {
            failures
        }
    };
    tracing::error!(
        "{failure_reason} ({}/{})",
        failures,
        p.timing.max_token_renewal_failures,
    );

    if matches!(failure, TokenRenewalFailure::Fatal { .. }) {
        let event = Event::Error {
            code: error_code::FAILED,
            message: format!(
                "Token renewal failed {} consecutive times",
                p.timing.max_token_renewal_failures
            ),
        };
        let _ = send_terminal_status_event(p, close_rx, event, "error").await;
        return true;
    }

    false
}

/// Send AUTH and commit the token within the acquisition's original deadline.
async fn send_auth(p: &mut EventLoopState, new_token: TokenDetails) -> Result<(), Error> {
    let auth_msg = ProtocolMessage {
        action: action::AUTH,
        auth: Some(AuthDetails {
            access_token: new_token.token.clone(),
        }),
        ..Default::default()
    };
    let data = encode_msg(&auth_msg)?;
    let Some(transport) = p.transport.as_mut() else {
        return Err(Error::Protocol {
            code: error_code::FAILED,
            message: "WebSocket transport missing during token renewal".to_string(),
        });
    };
    transport
        .ws_write
        .send(tungstenite::Message::Binary(data.into()))
        .await?;

    p.session
        .commit_token(new_token, p.timing.token_renewal_margin);
    tracing::info!("Token renewed successfully");
    Ok(())
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

/// Attempt a single reconnect (resume or fresh).
///
/// Reconnect setup through sending the channel `ATTACH` is bounded by
/// `timing.reconnect_timeout`. Waiting for the attach outcome is then separately
/// bounded by `timing.realtime_request_timeout`.
///
/// Connection mutations are deferred until the transport is connected and the
/// channel attach attempt has produced a definitive outcome. If the server
/// responds DETACHED to the ATTACH, the connected transport is kept and the
/// caller moves the channel into suspended retry, matching ably-js.
async fn attempt_reconnect(
    p: &mut EventLoopState,
    refresh_token: &mut bool,
    pending_reconnect_token: &mut Option<PendingReconnectToken>,
) -> Result<ReconnectOutcome, Error> {
    let reconnect_timeout = p.timing.reconnect_timeout;
    let reconnect_setup = tokio::time::timeout(reconnect_timeout, async {
        let use_resume = p.session.can_resume();
        let use_pending_token = *refresh_token || !use_resume;

        let active_token = if use_pending_token {
            if pending_reconnect_token.as_ref().is_some_and(|pending| {
                pending
                    .renewal_at
                    .is_some_and(|renewal_at| renewal_at <= Instant::now())
            }) {
                pending_reconnect_token.take();
            }

            let pending = match pending_reconnect_token {
                Some(pending) => pending,
                None => {
                    let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
                    let details = exchange_token(&p.http, &token_request, &p.rest_host).await?;
                    let renewal_at = super::state::ConnState::compute_renewal_at(
                        &details,
                        p.timing.token_renewal_margin,
                    );
                    pending_reconnect_token.insert(PendingReconnectToken {
                        details,
                        renewal_at,
                    })
                }
            };
            pending.details.token.clone()
        } else {
            p.session.token().to_string()
        };

        let resume = if use_resume {
            p.session.connection_key().map(str::to_string)
        } else {
            None
        };

        let ws_url = build_ws_url(&p.realtime_host, &active_token, resume.as_deref())?;
        let mut transport = connect_pending(
            &ws_url,
            p.timing.close_timeout,
            p.transport_close_tracker.clone(),
        )
        .await?;

        let connected_msg = wait_for_connected(transport.read_mut()?).await?;

        let resumed = use_resume
            && connected_msg.connection_id.as_deref() == p.session.connection_id()
            && connected_msg.error.is_none();

        // Always re-attach the channel, even after a successful connection resume.
        // The server may silently lose channel state without sending DETACHED,
        // creating a "zombie subscription" where messages stop being delivered.
        // ATTACH is idempotent — the server responds with ATTACHED regardless.
        //
        // This matches ably-js behavior: `Channels.onTransportActive()` calls
        // `channel.requestState('attaching')` for every attached channel whenever
        // a transport becomes active, including after resume.
        // See: ably-js/src/common/lib/client/baserealtime.ts
        if resumed {
            tracing::info!(
                channel_serial = ?p.session.channel_serial(),
                "Connection resumed, re-attaching channel to verify state",
            );
        } else {
            tracing::info!("Fresh connect, attaching channel");
        }
        let data = encode_attach_for_channel(
            &p.channel,
            p.channel_params.as_ref(),
            p.session.channel_serial(),
            p.session.attach_mode(),
        )?;
        transport
            .write_mut()?
            .send(tungstenite::Message::Binary(data.into()))
            .await?;

        let new_token = if use_pending_token {
            pending_reconnect_token
                .as_ref()
                .map(|pending| pending.details.clone())
        } else {
            None
        };
        Ok::<_, Error>((connected_msg, transport, new_token))
    })
    .await
    .map_err(|_| Error::Protocol {
        code: error_code::TIMEOUT,
        message: "Reconnect attempt timed out".to_string(),
    })?;
    let (connected_msg, mut transport, new_token) = match reconnect_setup {
        Ok(setup) => setup,
        Err(error) => {
            if matches!(
                &error,
                Error::Protocol { code, .. } if error_code::is_token_error(*code)
            ) {
                *refresh_token = true;
                pending_reconnect_token.take();
            }
            return Err(error);
        }
    };

    let attach_outcome = match tokio::time::timeout(p.timing.realtime_request_timeout, async {
        loop {
            match wait_for_attach_outcome(transport.read_mut()?, &p.channel).await? {
                AttachOutcome::RetryAttach(err) => {
                    tracing::warn!(
                        code = err.code,
                        message = %protocol_error_message(err.message),
                        "Channel attach was superseded while re-attaching after reconnect; retrying attach",
                    );
                    let data = encode_attach_for_channel(
                        &p.channel,
                        p.channel_params.as_ref(),
                        p.session.channel_serial(),
                        p.session.attach_mode(),
                    )?;
                    transport
                        .write_mut()?
                        .send(tungstenite::Message::Binary(data.into()))
                        .await?;
                }
                outcome => return Ok::<_, Error>(outcome),
            }
        }
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => {
            if matches!(
                &error,
                Error::Protocol { code, .. } if error_code::is_token_error(*code)
            ) {
                *refresh_token = true;
                pending_reconnect_token.take();
            }
            return Err(error);
        }
        Err(_) => AttachOutcome::TimedOut,
    };

    let attached_channel_serial = match attach_outcome {
        AttachOutcome::Attached { channel_serial } => Some(channel_serial),
        AttachOutcome::Detached(err) => {
            if error_code::is_token_error(err.code) {
                *refresh_token = true;
                pending_reconnect_token.take();
                return Err(Error::Protocol {
                    code: err.code,
                    message: protocol_error_message(err.message),
                });
            }
            tracing::warn!(
                reason = %channel_detached_message(&err.message),
                "Channel detached while re-attaching after reconnect",
            );
            None
        }
        AttachOutcome::RetryAttach(err) => {
            return Err(Error::Protocol {
                code: err.code,
                message: protocol_error_message(err.message),
            });
        }
        AttachOutcome::Closed(err) => {
            tracing::info!(
                code = err.code,
                message = %protocol_error_message(err.message),
                "Connection closed while re-attaching after reconnect",
            );
            return Ok(ReconnectOutcome::Closed);
        }
        AttachOutcome::TimedOut => {
            tracing::warn!(
                timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                "Channel attach timed out while re-attaching after reconnect",
            );
            None
        }
    };

    let transport = transport.into_transport()?;
    if new_token.is_some() {
        pending_reconnect_token.take();
    }
    Ok(match attached_channel_serial {
        Some(channel_serial) => ReconnectOutcome::Attached {
            connected_msg,
            channel_serial,
            token: new_token,
            transport,
        },
        None => ReconnectOutcome::ChannelSuspended {
            connected_msg,
            token: new_token,
            transport,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::super::state::ConnState;
    use super::*;

    use crate::protocol::{AblyMessage, ErrorInfo};
    use crate::types::{TokenDetails, TokenRequest};
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    fn test_event_loop_state(event_tx: mpsc::Sender<Event>) -> EventLoopState {
        let timing = TimingConfig::default();
        EventLoopState {
            transport: None,
            event_tx,
            session: SessionState::connected(ConnState {
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
            drop_warnings: DropWarningState::default(),
            transport_close_tracker: TransportCloseTracker::new(),
        }
    }

    fn assert_event_channel_empty(event_rx: &mut mpsc::Receiver<Event>) {
        assert!(
            matches!(event_rx.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
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
        let (event_tx, mut event_rx) = mpsc::channel(4);
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
    async fn full_message_channel_drops_before_decoding_payload() {
        let (event_tx, mut event_rx) = mpsc::channel(1);
        event_tx.try_send(Event::Connected).unwrap();
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

        assert_eq!(action, LoopAction::Continue);
        assert_eq!(state.drop_warnings.total_dropped, 1);
        assert!(
            matches!(event_rx.try_recv(), Ok(Event::Connected)),
            "expected pre-filled event to remain queued"
        );
        assert_event_channel_empty(&mut event_rx);
        let events = captured.entries();
        assert!(
            captured_contains(&events, "event channel full, dropping message"),
            "expected full-channel warning, got {events:#?}"
        );
        assert!(
            !captured_contains(&events, "Failed to decode JSON encoding layer"),
            "payload was decoded before full-channel drop; events={events:#?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn closed_message_channel_stops_before_decoding_payload() {
        let (event_tx, event_rx) = mpsc::channel(1);
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
        assert_eq!(state.drop_warnings.total_dropped, 0);
        let events = captured.entries();
        assert!(
            !captured_contains(&events, "Failed to decode JSON encoding layer"),
            "payload was decoded before closed-channel stop; events={events:#?}"
        );
    }

    #[tokio::test]
    async fn detached_reattach_missing_transport_leaves_disconnected_event_pending() {
        let (event_tx, mut event_rx) = mpsc::channel(4);
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
        let (event_tx, mut event_rx) = mpsc::channel(4);
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
}
