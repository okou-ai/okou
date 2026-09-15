//! Public entry point: [`subscribe`] and [`Subscription`].

use tokio::sync::{mpsc, oneshot};

use crate::connection::{
    DEFAULT_REALTIME_HOST, DropWarningState, EventLoopState, SessionState, TransportCloseTracker,
    connect_and_attach, exchange_token, rest_host, run_event_loop,
};
use crate::protocol::error_code;
use crate::types::{Error, Event, SubscribeConfig};

/// Handle to a running subscription.
///
/// Call [`next`](Subscription::next) to receive events. Use [`close`](Subscription::close) for a
/// best-effort close request, or [`close_and_wait`](Subscription::close_and_wait) when the caller
/// must observe bounded shutdown completion.
///
/// # Backpressure
///
/// All events share a bounded channel. [`Event::Message`] events use non-blocking delivery and may
/// be dropped when the channel is full. Status events ([`Event::Connected`],
/// [`Event::Disconnected`], and [`Event::Error`]) instead wait for channel capacity rather than
/// being dropped because the channel is full.
///
/// Keep polling [`next`](Subscription::next) while the subscription is active. A full channel can
/// delay reconnect until space is available for `Disconnected` and, after reconnect, delay
/// processing on the new connection until space is available for `Connected`. Calling `close` or
/// `close_and_wait`, or dropping the subscription, can interrupt a status-event send that is
/// waiting for capacity. Before waiting to deliver a terminal `Error`, the background task
/// releases its socket.
pub struct Subscription {
    rx: mpsc::Receiver<Event>,
    close_tx: Option<oneshot::Sender<CloseRequest>>,
    close_timeout: std::time::Duration,
    transport_close_tracker: TransportCloseTracker,
}

pub(crate) struct CloseRequest {
    completion_tx: Option<oneshot::Sender<Result<(), Error>>>,
}

impl CloseRequest {
    fn untracked() -> Self {
        Self {
            completion_tx: None,
        }
    }

    fn tracked(completion_tx: oneshot::Sender<Result<(), Error>>) -> Self {
        Self {
            completion_tx: Some(completion_tx),
        }
    }

    pub(crate) fn complete(self, result: Result<(), Error>) {
        match self.completion_tx {
            Some(completion_tx) => {
                if let Err(Err(error)) = completion_tx.send(result) {
                    tracing::warn!(%error, "Failed to close subscription");
                }
            }
            None => {
                if let Err(error) = result {
                    tracing::warn!(%error, "Failed to close subscription");
                }
            }
        }
    }
}

impl Subscription {
    /// Receive the next event. Returns `None` if the background task has exited.
    pub async fn next(&mut self) -> Option<Event> {
        self.rx.recv().await
    }

    /// Request a best-effort graceful close without waiting for completion.
    pub fn close(mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(CloseRequest::untracked());
        }
    }

    /// Gracefully close the subscription and wait for bounded local completion.
    ///
    /// Success means the background event loop finished its caller-requested
    /// Ably `CLOSE` send, WebSocket close, and outstanding transport cleanup.
    /// It does not wait for an Ably `CLOSED` acknowledgement from the server.
    pub async fn close_and_wait(mut self) -> Result<(), Error> {
        let close_tx = self.close_tx.take().ok_or_else(|| Error::Protocol {
            code: error_code::FAILED,
            message: "Subscription close request is unavailable".to_string(),
        })?;
        // Receiving the request can cancel a pending reconnect and start its
        // transport cleanup immediately, so observation must be enabled first.
        self.transport_close_tracker.observe_failures();
        let (completion_tx, completion_rx) = oneshot::channel();
        close_tx
            .send(CloseRequest::tracked(completion_tx))
            .map_err(|_| Error::Protocol {
                code: error_code::FAILED,
                message: "Subscription event loop is unavailable during close".to_string(),
            })?;

        tokio::time::timeout(self.close_timeout, completion_rx)
            .await
            .map_err(|_| Error::Protocol {
                code: error_code::TIMEOUT,
                message: "Subscription close timed out".to_string(),
            })?
            .map_err(|_| Error::Protocol {
                code: error_code::FAILED,
                message: "Subscription event loop exited before close completed".to_string(),
            })?
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(tx) = self.close_tx.take() {
            let _ = tx.send(CloseRequest::untracked());
        }
    }
}

/// Subscribe to an Ably channel.
///
/// Establishes a WebSocket connection, exchanges the token, attaches to the
/// channel, and returns a [`Subscription`] that yields [`Event`]s.
///
/// The background task automatically handles reconnection, token renewal, and
/// heartbeat timeout detection. While acquiring a renewal token, it continues
/// receiving messages on the established connection. See [`Subscription`] for how
/// a full event channel can delay reconnect and post-reconnect receive progress
/// until the caller drains events or closes the subscription.
pub async fn subscribe(config: SubscribeConfig) -> Result<Subscription, Error> {
    let timing = config.timing.unwrap_or_default();
    let close_timeout = timing.close_timeout;
    let event_channel_capacity = timing.event_channel_capacity.max(1);
    let (event_tx, event_rx) = mpsc::channel::<Event>(event_channel_capacity);
    let (close_tx, close_rx) = oneshot::channel::<CloseRequest>();
    let transport_close_tracker = TransportCloseTracker::new();

    let realtime_host = config
        .host
        .as_deref()
        .unwrap_or(DEFAULT_REALTIME_HOST)
        .to_string();
    let rest = config
        .rest_host
        .unwrap_or_else(|| rest_host(&realtime_host));
    let http = reqwest::Client::builder()
        .timeout(timing.connect_timeout)
        .build()?;

    // Initial token exchange (with timeout)
    let token_request = tokio::time::timeout(timing.connect_timeout, (config.get_token)())
        .await
        .map_err(|_| Error::Protocol {
            code: error_code::TIMEOUT,
            message: "Token fetch timed out".to_string(),
        })?
        .map_err(Error::TokenFetch)?;
    let token = exchange_token(&http, &token_request, &rest).await?;

    // Connect, handshake, and attach with timeout
    let (transport, conn_state) = tokio::time::timeout(
        timing.connect_timeout,
        connect_and_attach(
            &realtime_host,
            token,
            &config.channel,
            config.channel_params.as_ref(),
            &timing,
            transport_close_tracker.clone(),
        ),
    )
    .await
    .map_err(|_| Error::Protocol {
        code: error_code::TIMEOUT,
        message: "Connection timed out".to_string(),
    })??;

    let _ = event_tx.send(Event::Connected).await;

    // Spawn background event loop
    tokio::spawn(run_event_loop(
        EventLoopState {
            transport: Some(transport),
            event_tx,
            session: SessionState::connected(conn_state),
            channel: config.channel,
            channel_params: config.channel_params,
            realtime_host,
            rest_host: rest,
            http,
            get_token: config.get_token,
            pending_token_renewal: None,
            timing,
            drop_warnings: DropWarningState::default(),
            transport_close_tracker: transport_close_tracker.clone(),
        },
        close_rx,
    ));

    Ok(Subscription {
        rx: event_rx,
        close_tx: Some(close_tx),
        close_timeout,
        transport_close_tracker,
    })
}
