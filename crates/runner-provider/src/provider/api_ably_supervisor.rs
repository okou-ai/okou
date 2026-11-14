//! Shared API control subscription: cancellation, input, synchronization and side messages.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::api::ApiClient;
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::worker_join::join_retained_worker;
use crate::active_input::ActiveInputNotifications;
use crate::run_cancellation::{
    RunCancellationHandle, RunCancellationMode, RunCancellationRegistry,
};
use runner_types::ids::RunId;
use runner_types::types::ConnectorRuntimeTarget;

const ABLY_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
// Request Ably's supported minimum. With its negotiated five-second idle
// interval and the standard ten-second margin, silent-loss detection takes
// about fifteen seconds rather than the default twenty-five.
const ABLY_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const ABLY_BACKOFF_MAX: Duration = Duration::from_secs(60);
const ABLY_DISCONNECT_ERROR_AFTER: Duration = Duration::from_secs(60);
type CancelDelivery = Pin<Box<dyn Future<Output = ()> + Send>>;

mod connection;

use connection::{AblyConnection, ConnectionEvent};

pub(super) struct AblySupervisor {
    shutdown: CancellationToken,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub(super) struct AblySupervisorConfig {
    pub(super) ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    pub(super) api: ApiClient,
    pub(super) group: String,
    pub(super) cancel_tokens: RunCancellationRegistry,
    pub(super) connector_runtime_sync: ConnectorRuntimeSyncHandle,
    pub(super) active_input_notifications: ActiveInputNotifications,
    pub(super) provider_cancel: CancellationToken,
}

struct SupervisorTaskConfig {
    ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    api: ApiClient,
    group: String,
    cancel_tokens: RunCancellationRegistry,
    connector_runtime_sync: ConnectorRuntimeSyncHandle,
    active_input_notifications: ActiveInputNotifications,
    provider_cancel: CancellationToken,
    shutdown: CancellationToken,
}

impl AblySupervisor {
    pub(super) fn spawn(config: AblySupervisorConfig) -> Self {
        Self::spawn_with_subscription(config, None)
    }

    fn spawn_with_subscription(
        config: AblySupervisorConfig,
        subscription: Option<ably_subscriber::Subscription>,
    ) -> Self {
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let task_config = SupervisorTaskConfig {
            ably_side_message_handler: config.ably_side_message_handler,
            api: config.api,
            group: config.group,
            cancel_tokens: config.cancel_tokens,
            connector_runtime_sync: config.connector_runtime_sync,
            active_input_notifications: config.active_input_notifications,
            provider_cancel: config.provider_cancel,
            shutdown: task_shutdown,
        };
        let task = tokio::spawn(async move {
            run_supervisor(task_config, subscription).await;
        });
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }

    pub(super) async fn shutdown(&self) {
        self.shutdown.cancel();
        if let Err(e) = join_retained_worker(&self.task).await {
            warn!(error = %e, "ably supervisor task failed during shutdown");
        }
    }

    #[cfg(test)]
    pub(super) fn connected_for_test(
        config: AblySupervisorConfig,
        subscription: ably_subscriber::Subscription,
    ) -> Self {
        Self::spawn_with_subscription(config, Some(subscription))
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self {
            shutdown: CancellationToken::new(),
            task: tokio::sync::Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn spawn_test_task<F>(build: impl FnOnce(CancellationToken) -> F) -> Self
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(build(shutdown.clone()));
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }
}

impl Drop for AblySupervisor {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn run_supervisor(
    config: SupervisorTaskConfig,
    subscription: Option<ably_subscriber::Subscription>,
) {
    let mut cancel_deliveries = FuturesUnordered::<CancelDelivery>::new();
    let mut connection = AblyConnection::new(subscription);
    let mut disconnect = AblyDisconnectState::disconnected("connecting".to_string());

    loop {
        connection.start_if_due(|| make_ably_config(&config.api, &config.group));
        let disconnect_error_at = disconnect.error_deadline();

        tokio::select! {
            () = config.shutdown.cancelled() => {
                break;
            }
            () = config.provider_cancel.cancelled() => {
                break;
            }
            event = connection.next() => {
                match event {
                    ConnectionEvent::Subscription(event) => {
                        handle_ably_event(
                            &config,
                            event,
                            &mut connection,
                            &mut disconnect,
                            &mut cancel_deliveries,
                        ).await;
                    }
                    ConnectionEvent::ConnectResult(Ok(())) => {
                        // `subscribe` queues `Event::Connected` as the new
                        // subscription's first event; its handler wakes the
                        // active-input readers once.
                        disconnect.mark_connected();

                    }
                    ConnectionEvent::ConnectResult(Err(reason)) => {
                        disconnect.record_disconnected(reason);

                    }
                    ConnectionEvent::RetryDue => {}
                }
            }
            Some(()) = cancel_deliveries.next(), if !cancel_deliveries.is_empty() => {}
            () = sleep_until_optional(disconnect_error_at), if disconnect_error_at.is_some() => {
                disconnect.log_persistent_disconnect();
            }
        }
    }

    connection.shutdown().await;
}

// Only delivered authority messages can change SSH authorization. Subscription
// health is not evidence of revoked access.
async fn handle_ably_event(
    config: &SupervisorTaskConfig,
    event: Option<ably_subscriber::Event>,
    connection: &mut AblyConnection,
    disconnect: &mut AblyDisconnectState,
    cancel_deliveries: &mut FuturesUnordered<CancelDelivery>,
) {
    match event {
        Some(ably_subscriber::Event::Message(msg)) => {
            if config
                .ably_side_message_handler
                .as_ref()
                .is_some_and(|handler| handler.handle(&msg))
            {
                return;
            }
            if let Some(run_id) = parse_active_input_notification(&msg) {
                config.active_input_notifications.notify(run_id);
                return;
            }
            if enqueue_cancel_delivery(&msg, &config.cancel_tokens, cancel_deliveries).await {
                return;
            }
            handle_ably_message_with_connector_runtime_sync(
                &msg,
                &config.cancel_tokens,
                Some(&config.connector_runtime_sync),
                Some(&config.shutdown),
            )
            .await;
        }
        Some(ably_subscriber::Event::Connected) => {
            handle_ably_connected(disconnect, &config.active_input_notifications);
        }
        Some(ably_subscriber::Event::Disconnected { reason }) => {
            let reason = reason.unwrap_or_else(|| "unknown".to_string());
            disconnect.record_disconnected(reason.clone());

            info!(reason = %reason, "ably disconnected, reconnecting control subscription");
        }
        Some(ably_subscriber::Event::Error { code, message }) => {
            error!(code, message = %message, "ably fatal error, will reconnect");
            disconnect.record_disconnected(message.clone());

            connection.retry();
        }
        None => {
            warn!("ably subscription closed, will reconnect");
            disconnect.record_disconnected("subscription closed".to_string());

            connection.retry();
        }
    }
}

// Every subscription and every reconnect, resumed or fresh, emits
// `Event::Connected`. An `active-input` push published while disconnected is
// lost, so each active run reads its next steerable input once.
fn handle_ably_connected(
    disconnect: &mut AblyDisconnectState,
    active_input_notifications: &ActiveInputNotifications,
) {
    if !disconnect.is_connected() {
        info!("ably reconnected");
    }
    disconnect.mark_connected();
    active_input_notifications.notify_all();
}

#[cfg(test)]
async fn handle_ably_message(
    msg: &ably_subscriber::Message,
    cancel_tokens: &RunCancellationRegistry,
) {
    handle_ably_message_with_connector_runtime_sync(msg, cancel_tokens, None, None).await;
}

async fn handle_ably_message_with_connector_runtime_sync(
    msg: &ably_subscriber::Message,
    cancel_tokens: &RunCancellationRegistry,
    connector_runtime_sync: Option<&ConnectorRuntimeSyncHandle>,
    connector_runtime_sync_cancel: Option<&CancellationToken>,
) {
    if let Some(notification) = parse_cancel_notification(msg) {
        if let Some(delivery) = prepare_cancel_delivery(notification, cancel_tokens).await {
            delivery.await;
        }
        return;
    }

    if let Some(notification) = parse_connector_runtime_sync_notification(msg) {
        let Some(connector_runtime_sync) = connector_runtime_sync else {
            return;
        };
        if let Some(cancel) = connector_runtime_sync_cancel {
            connector_runtime_sync
                .notify_connector_runtime_sync_until_cancelled(
                    notification.run_id,
                    notification.target,
                    cancel,
                )
                .await;
        } else {
            connector_runtime_sync
                .notify_connector_runtime_sync(notification.run_id, notification.target)
                .await;
        }
    }
}

struct ConnectorRuntimeSyncNotification {
    run_id: RunId,
    target: ConnectorRuntimeTarget,
}

fn parse_active_input_notification(msg: &ably_subscriber::Message) -> Option<RunId> {
    if msg.name.as_deref() != Some("active-input") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|value| value.as_str())?;
    match raw.parse() {
        Ok(run_id) => Some(run_id),
        Err(error) => {
            warn!(value = %raw, error = %error, "ably: invalid active-input runId");
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CancelNotification {
    run_id: RunId,
    mode: RunCancellationMode,
}

async fn prepare_cancel_delivery(
    notification: CancelNotification,
    cancel_tokens: &RunCancellationRegistry,
) -> Option<CancelDelivery> {
    let handle = cancel_tokens.handle(notification.run_id).await?;
    Some(Box::pin(deliver_cancel_notification(notification, handle)))
}

async fn enqueue_cancel_delivery(
    msg: &ably_subscriber::Message,
    cancel_tokens: &RunCancellationRegistry,
    cancel_deliveries: &mut FuturesUnordered<CancelDelivery>,
) -> bool {
    let Some(notification) = parse_cancel_notification(msg) else {
        return false;
    };
    if let Some(delivery) = prepare_cancel_delivery(notification, cancel_tokens).await {
        cancel_deliveries.push(delivery);
    }
    true
}

async fn deliver_cancel_notification(
    notification: CancelNotification,
    handle: RunCancellationHandle,
) {
    let run_id = notification.run_id;
    match notification.mode {
        RunCancellationMode::Cooperative => {
            info!(run_id = %run_id, "ably: cancel notification, requesting cooperative cancellation");
            handle.request_cooperative_user_cancellation().await;
        }
        RunCancellationMode::Hard => {
            info!(run_id = %run_id, "ably: cancel notification, requesting hard cancellation");
            handle.request_hard_cancellation().await;
        }
    }
}

fn parse_cancel_notification(msg: &ably_subscriber::Message) -> Option<CancelNotification> {
    if msg.name.as_deref() != Some("cancel") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str())?;
    let run_id = match raw.parse() {
        Ok(id) => id,
        Err(e) => {
            warn!(value = %raw, error = %e, "ably: invalid cancel runId");
            return None;
        }
    };
    let mode = match msg.data.get("mode") {
        Some(serde_json::Value::String(mode)) if mode == "cooperative" => {
            RunCancellationMode::Cooperative
        }
        Some(serde_json::Value::String(mode)) if mode == "hard" => RunCancellationMode::Hard,
        Some(mode) => {
            warn!(
                run_id = %run_id,
                mode = %mode,
                "ably: unknown cancel mode, using hard cancellation"
            );
            RunCancellationMode::Hard
        }
        // Default to hard cancellation when the API omits the mode so a
        // malformed or stale notification still stops the run safely.
        None => RunCancellationMode::Hard,
    };
    Some(CancelNotification { run_id, mode })
}

fn parse_connector_runtime_sync_notification(
    msg: &ably_subscriber::Message,
) -> Option<ConnectorRuntimeSyncNotification> {
    if msg.name.as_deref() != Some("connector-runtime-sync") {
        return None;
    }
    let run_id = match msg.data.get("runId").and_then(serde_json::Value::as_str) {
        Some(value) => match value.parse() {
            Ok(run_id) => run_id,
            Err(error) => {
                warn!(value, error = %error, "ably: invalid connector-runtime-sync runId");
                return None;
            }
        },
        None => {
            warn!("ably: connector-runtime-sync message missing runId");
            return None;
        }
    };
    let target = match msg.data.get("target").cloned().map(serde_json::from_value) {
        Some(Ok(target)) => target,
        Some(Err(error)) => {
            warn!(error = %error, "ably: connector-runtime-sync message has invalid target");
            return None;
        }
        None => {
            warn!("ably: connector-runtime-sync message missing target");
            return None;
        }
    };
    Some(ConnectorRuntimeSyncNotification { run_id, target })
}

async fn sleep_until_optional(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

pub(super) fn make_ably_config(api: &ApiClient, group: &str) -> ably_subscriber::SubscribeConfig {
    let api = api.clone();
    let channel = format!("runner-group:{group}");
    let group = group.to_owned();
    let get_token: Box<dyn Fn() -> ably_subscriber::TokenFuture + Send + Sync> =
        Box::new(move || {
            let api = api.clone();
            let group = group.clone();
            Box::pin(async move {
                api.realtime_token(&group)
                    .await
                    .map_err(|e| Box::new(e) as ably_subscriber::BoxError)
            })
        });
    let mut config = ably_subscriber::SubscribeConfig::new(get_token, channel);
    config.heartbeat_interval = Some(ABLY_HEARTBEAT_INTERVAL);
    config
}

enum AblyDisconnectState {
    Connected,
    Disconnected {
        since: tokio::time::Instant,
        reason: String,
        error_logged: bool,
    },
}

impl AblyDisconnectState {
    fn disconnected(reason: String) -> Self {
        Self::Disconnected {
            since: tokio::time::Instant::now(),
            reason,
            error_logged: false,
        }
    }

    fn is_connected(&self) -> bool {
        matches!(self, Self::Connected)
    }

    fn mark_connected(&mut self) {
        *self = Self::Connected;
    }

    fn record_disconnected(&mut self, reason: String) {
        match self {
            Self::Connected => *self = Self::disconnected(reason),
            Self::Disconnected { reason: latest, .. } => *latest = reason,
        }
    }

    fn error_deadline(&self) -> Option<tokio::time::Instant> {
        match self {
            Self::Disconnected {
                since,
                error_logged: false,
                ..
            } => Some(*since + ABLY_DISCONNECT_ERROR_AFTER),
            _ => None,
        }
    }

    fn log_persistent_disconnect(&mut self) {
        if let Self::Disconnected {
            since,
            reason,
            error_logged,
        } = self
            && !*error_logged
        {
            *error_logged = true;
            error!(
                reason = %reason,
                disconnected_secs = since.elapsed().as_secs(),
                "ably disconnected for too long, reconnecting control subscription"
            );
        }
    }
}

#[cfg(test)]
mod tests;
