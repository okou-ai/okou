use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, Stream, StreamExt};
use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_util::task::TaskTracker;

use super::state::idle_deadline;
use crate::Error;
use crate::protocol::error_code;
use crate::types::redact_auth_query_params;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type WsSplitRead = futures_util::stream::SplitStream<WsStream>;
pub(crate) type WsWrite = futures_util::stream::SplitSink<WsStream, tungstenite::Message>;

pub(crate) struct WsRead {
    inner: WsSplitRead,
    last_inbound_activity_at: Instant,
    pub(super) connected_at: Instant,
    pub(super) local_addr: Option<SocketAddr>,
    pub(super) peer_addr: Option<SocketAddr>,
    pub(super) tcp_nodelay: Option<bool>,
    pub(super) received_messages: u64,
    pub(super) received_bytes: u64,
    pub(super) received_pings: u64,
    pub(super) received_pongs: u64,
    pub(super) last_message_kind: &'static str,
}

impl WsRead {
    fn new(
        inner: WsSplitRead,
        local_addr: Option<SocketAddr>,
        peer_addr: Option<SocketAddr>,
        tcp_nodelay: Option<bool>,
    ) -> Self {
        Self {
            inner,
            last_inbound_activity_at: Instant::now(),
            connected_at: Instant::now(),
            local_addr,
            peer_addr,
            tcp_nodelay,
            received_messages: 0,
            received_bytes: 0,
            received_pings: 0,
            received_pongs: 0,
            last_message_kind: "none",
        }
    }

    pub(super) fn last_received_age(&self) -> Duration {
        self.last_inbound_activity_at.elapsed()
    }

    pub(super) fn idle_deadline(
        &self,
        max_idle_interval: Option<Duration>,
        heartbeat_margin: Duration,
    ) -> Option<(Instant, Duration)> {
        idle_deadline(
            self.last_inbound_activity_at,
            max_idle_interval,
            heartbeat_margin,
        )
    }
}

impl Stream for WsRead {
    type Item = Result<tungstenite::Message, tungstenite::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = Pin::new(&mut self.inner).poll_next(cx);
        if let Poll::Ready(Some(Ok(message))) = &result {
            self.last_inbound_activity_at = Instant::now();
            // Tungstenite yields assembled data messages and individual control frames.
            self.received_messages = self.received_messages.saturating_add(1);
            self.received_bytes = self.received_bytes.saturating_add(message.len() as u64);
            self.last_message_kind = match message {
                tungstenite::Message::Binary(_) => "binary",
                tungstenite::Message::Text(_) => "text",
                tungstenite::Message::Ping(_) => {
                    self.received_pings = self.received_pings.saturating_add(1);
                    "ping"
                }
                tungstenite::Message::Pong(_) => {
                    self.received_pongs = self.received_pongs.saturating_add(1);
                    "pong"
                }
                tungstenite::Message::Close(_) => "close",
                tungstenite::Message::Frame(_) => "frame",
            };
        }
        result
    }
}

pub(crate) struct WsTransport {
    pub(super) ws_read: WsRead,
    pub(super) ws_write: WsWrite,
}

#[derive(Clone)]
pub(crate) struct TransportCloseTracker {
    tasks: TaskTracker,
    state: Arc<TransportCloseTrackerState>,
}

struct TransportCloseTrackerState {
    observe_failures: AtomicBool,
    first_failure: Mutex<Option<Error>>,
}

impl TransportCloseTracker {
    pub(crate) fn new() -> Self {
        Self {
            tasks: TaskTracker::new(),
            state: Arc::new(TransportCloseTrackerState {
                observe_failures: AtomicBool::new(false),
                first_failure: Mutex::new(None),
            }),
        }
    }

    pub(crate) fn observe_failures(&self) {
        self.state.observe_failures.store(true, Ordering::Release);
    }

    fn spawn(&self, transport: WsTransport, close_timeout: Duration) {
        let tracker = self.clone();
        let close_task = self.tasks.spawn(async move {
            if let Err(error) = transport.close(close_timeout).await {
                if tracker.state.observe_failures.load(Ordering::Acquire) {
                    let mut first_failure = tracker.state.first_failure.lock().await;
                    if first_failure.is_none() {
                        *first_failure = Some(error);
                    }
                } else {
                    tracing::warn!(%error, "Failed to close websocket transport");
                }
            }
        });
        drop(close_task);
    }

    pub(crate) async fn close_and_wait(&self) -> Result<(), Error> {
        self.tasks.close();
        self.tasks.wait().await;
        match self.state.first_failure.lock().await.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl WsTransport {
    fn new(ws_read: WsRead, ws_write: WsWrite) -> Self {
        Self { ws_read, ws_write }
    }

    async fn close(self, close_timeout: Duration) -> Result<(), Error> {
        let Self {
            ws_read,
            mut ws_write,
        } = self;
        drop(ws_read);
        tokio::time::timeout(close_timeout, close_websocket_sink(&mut ws_write))
            .await
            .map_err(|_| Error::Protocol {
                code: error_code::TIMEOUT,
                message: "WebSocket transport close timed out".to_string(),
            })??;
        Ok(())
    }

    pub(super) fn close_in_background(
        self,
        close_timeout: Duration,
        tracker: &TransportCloseTracker,
    ) {
        tracker.spawn(self, close_timeout);
    }
}

pub(super) async fn close_websocket_sink(ws_write: &mut WsWrite) -> Result<(), Error> {
    match ws_write.close().await {
        Ok(()) => Ok(()),
        Err(tungstenite::Error::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe => {
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// Owns a connected transport until setup commits it as active.
///
/// Dropping a setup future drops this guard and schedules bounded transport
/// cleanup, so cancellation cannot silently abandon an established WebSocket.
pub(super) struct PendingWsTransport {
    transport: Option<WsTransport>,
    close_timeout: Duration,
    close_tracker: TransportCloseTracker,
}

impl PendingWsTransport {
    fn new(
        transport: WsTransport,
        close_timeout: Duration,
        close_tracker: TransportCloseTracker,
    ) -> Self {
        Self {
            transport: Some(transport),
            close_timeout,
            close_tracker,
        }
    }

    fn transport_mut(&mut self) -> Result<&mut WsTransport, Error> {
        self.transport.as_mut().ok_or_else(|| Error::Protocol {
            code: error_code::FAILED,
            message: "Pending WebSocket transport is unavailable".to_string(),
        })
    }

    pub(super) fn read_mut(&mut self) -> Result<&mut WsRead, Error> {
        Ok(&mut self.transport_mut()?.ws_read)
    }

    pub(super) fn write_mut(&mut self) -> Result<&mut WsWrite, Error> {
        Ok(&mut self.transport_mut()?.ws_write)
    }

    pub(super) fn into_transport(mut self) -> Result<WsTransport, Error> {
        self.transport.take().ok_or_else(|| Error::Protocol {
            code: error_code::FAILED,
            message: "Pending WebSocket transport is unavailable".to_string(),
        })
    }
}

impl Drop for PendingWsTransport {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.take() {
            transport.close_in_background(self.close_timeout, &self.close_tracker);
        }
    }
}

pub(super) async fn connect_pending(
    url: &str,
    close_timeout: Duration,
    close_tracker: TransportCloseTracker,
) -> Result<PendingWsTransport, Error> {
    let (ws, _resp) = tokio_tungstenite::connect_async_with_config(url, None, true).await?;
    let tcp = ws.get_ref().get_ref();
    let local_addr = tcp.local_addr().ok();
    let peer_addr = tcp.peer_addr().ok();
    let tcp_nodelay = tcp.nodelay().ok();
    let (ws_write, ws_read) = ws.split();
    Ok(PendingWsTransport::new(
        WsTransport::new(
            WsRead::new(ws_read, local_addr, peer_addr, tcp_nodelay),
            ws_write,
        ),
        close_timeout,
        close_tracker,
    ))
}

pub(super) fn websocket_close_reason(frame: Option<&CloseFrame>) -> String {
    match frame {
        Some(frame) if frame.reason.is_empty() => {
            format!("websocket closed code={}", frame.code)
        }
        Some(frame) => {
            let reason = websocket_close_frame_reason(frame);
            format!("websocket closed code={} reason={}", frame.code, reason)
        }
        None => "websocket closed without close frame".to_string(),
    }
}

pub(super) fn websocket_close_frame_reason(frame: &CloseFrame) -> String {
    redact_auth_query_params(frame.reason.as_ref())
}

pub(super) fn websocket_error_reason(error: &tungstenite::Error) -> String {
    format!(
        "websocket error: {}",
        redact_auth_query_params(&error.to_string())
    )
}

#[cfg(test)]
mod tests;
