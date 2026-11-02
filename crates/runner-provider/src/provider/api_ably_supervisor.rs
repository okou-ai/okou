//! Ably control-plane supervisor for API-backed runner job discovery.
//!
//! `ApiProvider` uses this module as the low-latency side of discovery while
//! keeping HTTP polling as the correctness fallback. Job notifications become
//! direct candidates when they include a supported profile; incomplete
//! notifications or direct-inbox fallback request immediate poll wakeups so the
//! server remains the source of truth for job selection. Ably cancel
//! notifications bypass discovery and only signal local cancellation handles.
//! Invalid job notifications are ignored. Unsupported profiles are ignored
//! without mutating discovery wakeup state.
//!
//! The direct candidate inbox is an optimization, not the only delivery path:
//! incomplete notifications, inbox overflow, backlog draining, and
//! Ably connection state all route through `PollWakeups` so a runner can still
//! discover work through HTTP polling.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant as StdInstant};

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use super::api::ApiClient;
use super::api_direct_candidates::{
    DirectCandidateInbox, DirectCandidateInsertOutcome, DirectCandidatePruneSnapshot,
    DirectJobCandidate,
};
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::worker_join::join_retained_worker;
use super::{RunnerPreferenceContext, parse_runner_preference};
use crate::active_input::ActiveInputNotifications;
use crate::duration::duration_ms;
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
const DEFERRED_POLL_MAX: Duration = Duration::from_secs(10);
type CancelDelivery = Pin<Box<dyn Future<Output = ()> + Send>>;

mod connection;

use connection::{AblyConnection, ConnectionEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PollReason {
    Immediate,
    Deferred,
    WakeupRetry,
    Slow,
    Fast,
}

impl PollReason {
    pub(super) fn is_wakeup(self) -> bool {
        matches!(self, Self::Immediate | Self::Deferred | Self::WakeupRetry)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PollDue {
    reason: PollReason,
    /// Wakeup generation observed immediately before starting the HTTP poll.
    /// Poll results must not clear wakeups that arrive while that request is in flight.
    generation: u64,
}

impl PollDue {
    pub(super) fn reason(self) -> PollReason {
        self.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PollOutcome {
    JobFound,
    Empty,
    Failure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PollRecord {
    defer_job_return: bool,
}

impl PollRecord {
    pub(super) fn defer_job_return(self) -> bool {
        self.defer_job_return
    }
}

/// Coalesced HTTP poll scheduler shared by the Ably supervisor and `ApiProvider`.
///
/// This is the state-machine contract for API job discovery fallback:
///
/// - Ably connection state selects the ordinary polling cadence: slow while
///   connected, fast while disconnected.
/// - Advertised reusable inventory also arms an absolute safety deadline. It
///   does not depend on Ably noticing a silent receive-side interruption.
/// - Immediate wakeups request a prompt HTTP poll for startup, incomplete Ably
///   job notifications, direct queue fallback, and backlog draining after a job
///   is found.
/// - Wakeup retries are only for failed wakeup-driven polls. Ordinary slow and
///   fast polling failures wait for the next ordinary cadence.
/// - Generations prevent an HTTP poll result from clearing wakeups that arrived
///   after that poll started.
pub(super) struct PollWakeups {
    // State-only critical sections must not enqueue an async waiter retained
    // inside discover(): an inline reactor callback also updates this state.
    inner: StdMutex<PollWakeupsInner>,
    notify: Notify,
}

#[derive(Debug)]
struct DeferredPollWindow {
    at: tokio::time::Instant,
    /// The original cap stays with this window across deadline extensions.
    cap_at: tokio::time::Instant,
}

impl DeferredPollWindow {
    fn new(at: tokio::time::Instant, cap_at: tokio::time::Instant) -> Self {
        Self {
            at: at.min(cap_at),
            cap_at,
        }
    }

    fn extend_to(&mut self, at: tokio::time::Instant) {
        self.at = self.at.max(at.min(self.cap_at));
    }
}

#[derive(Debug)]
struct PollWakeupsInner {
    /// Selects slow versus fast ordinary polling cadence.
    ably_connected: bool,
    /// Last local inventory projection; an older heartbeat cannot re-enable
    /// reconciliation after a newer snapshot withdrew reusable resources.
    reuse_snapshot_order: Option<(u64, u64)>,
    reuse_poll: Option<ReusePoll>,
    /// Immediate poll request. Re-armed after `JobFound` to drain backlog.
    poll_now: bool,
    /// A capped deferred window blocks immediate and retry polls until due.
    deferred_poll: Option<DeferredPollWindow>,
    /// Retry deadline for failed wakeup-driven polls only.
    wakeup_retry_at: Option<tokio::time::Instant>,
    /// Bumped whenever a new wakeup is recorded. This keeps an older HTTP poll
    /// result from clearing a wakeup that arrived after the poll started.
    generation: u64,
}

impl PollWakeupsInner {
    fn consume_poll(&mut self, reason: PollReason, now: tokio::time::Instant) -> PollDue {
        if let Some(reuse) = &mut self.reuse_poll {
            reuse.at = now + reuse.interval;
        }
        PollDue {
            reason,
            generation: self.generation,
        }
    }

    fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }

    fn consume_deferred_if_due(&mut self, now: tokio::time::Instant) -> bool {
        if self
            .deferred_poll
            .as_ref()
            .is_some_and(|window| window.at <= now)
        {
            self.deferred_poll = None;
            self.poll_now = false;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ScheduledPoll {
    at: tokio::time::Instant,
    reason: PollReason,
    reuse: bool,
}

#[derive(Debug)]
struct ReusePoll {
    interval: Duration,
    at: tokio::time::Instant,
}

impl PollWakeups {
    pub(super) fn new(ably_connected: bool) -> Self {
        Self {
            inner: StdMutex::new(PollWakeupsInner {
                ably_connected,
                reuse_snapshot_order: None,
                reuse_poll: None,
                poll_now: true,
                deferred_poll: None,
                wakeup_retry_at: None,
                generation: 0,
            }),
            notify: Notify::new(),
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, PollWakeupsInner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn mark_ably_connected(&self) {
        self.lock_inner().ably_connected = true;
        self.notify.notify_waiters();
    }

    pub(super) fn mark_ably_disconnected(&self) {
        self.lock_inner().ably_connected = false;
        self.notify.notify_waiters();
    }

    pub(super) fn update_reuse_polling(&self, order: (u64, u64), interval: Option<Duration>) {
        let mut inner = self.lock_inner();
        if inner
            .reuse_snapshot_order
            .is_some_and(|previous| previous >= order)
        {
            return;
        }
        inner.reuse_snapshot_order = Some(order);
        let changed = match (&mut inner.reuse_poll, interval) {
            (None, Some(interval)) => {
                inner.reuse_poll = Some(ReusePoll {
                    interval,
                    at: tokio::time::Instant::now() + interval,
                });
                true
            }
            (Some(_), None) => {
                inner.reuse_poll = None;
                true
            }
            // New observations must not postpone an already armed deadline,
            // including an error backoff or a wait cancelled by direct delivery.
            _ => false,
        };
        drop(inner);
        if changed {
            self.notify.notify_waiters();
        }
    }

    pub(super) fn request_immediate_poll(&self) {
        let mut inner = self.lock_inner();
        inner.poll_now = true;
        inner.bump_generation();
        self.notify.notify_waiters();
    }

    pub(super) fn request_deferred_poll_after(&self, delay: Duration) {
        let now = tokio::time::Instant::now();
        self.request_deferred_poll_capped_at(now + delay, now + DEFERRED_POLL_MAX);
    }

    pub(super) fn request_deferred_poll_until(&self, deadline: StdInstant) {
        let now = tokio::time::Instant::now();
        self.request_deferred_poll_capped_at(deadline.into(), now + DEFERRED_POLL_MAX);
    }

    fn request_deferred_poll_capped_at(
        &self,
        at: tokio::time::Instant,
        cap_at: tokio::time::Instant,
    ) {
        let mut inner = self.lock_inner();
        match &mut inner.deferred_poll {
            Some(window) => window.extend_to(at),
            None => inner.deferred_poll = Some(DeferredPollWindow::new(at, cap_at)),
        }
        inner.bump_generation();
        drop(inner);
        self.notify.notify_waiters();
    }

    #[cfg(test)]
    fn request_deferred_poll_at(&self, at: tokio::time::Instant) {
        self.request_deferred_poll_capped_at(at, at);
    }

    #[cfg(test)]
    pub(super) fn request_deferred_poll_after_for_test(&self, delay: Duration) {
        self.request_deferred_poll_after(delay);
    }

    pub(super) fn record_poll_result(
        &self,
        due: PollDue,
        outcome: PollOutcome,
        wakeup_retry_delay: Duration,
    ) -> PollRecord {
        let mut should_notify = false;
        let mut inner = self.lock_inner();
        if let Some(reuse) = &mut inner.reuse_poll {
            let delay = if outcome == PollOutcome::Failure {
                reuse.interval.max(wakeup_retry_delay)
            } else {
                reuse.interval
            };
            reuse.at = tokio::time::Instant::now() + delay;
        }
        let has_new_wakeup = inner.generation != due.generation;
        // A deferred wakeup that arrives while an HTTP poll is in flight
        // must be honored before returning a newly found job to this runner.
        let defer_job_return =
            outcome == PollOutcome::JobFound && has_new_wakeup && inner.deferred_poll.is_some();
        match outcome {
            PollOutcome::JobFound | PollOutcome::Empty => {
                if !has_new_wakeup {
                    inner.deferred_poll = None;
                    inner.wakeup_retry_at = None;
                }
                if outcome == PollOutcome::JobFound {
                    // A successful poll can mean more eligible work is already queued,
                    // so re-arm the immediate path to drain backlog without waiting
                    // for the ordinary slow/fast cadence.
                    inner.poll_now = true;
                    inner.bump_generation();
                    should_notify = true;
                }
            }
            PollOutcome::Failure if due.reason.is_wakeup() => {
                inner.wakeup_retry_at = Some(tokio::time::Instant::now() + wakeup_retry_delay);
                inner.bump_generation();
                should_notify = true;
            }
            PollOutcome::Failure => {}
        }
        drop(inner);
        if should_notify {
            self.notify.notify_waiters();
        }
        PollRecord { defer_job_return }
    }

    pub(super) async fn wait_for_poll_due(
        &self,
        cancel: &CancellationToken,
        slow_interval: Duration,
        fast_interval: Duration,
    ) -> Option<PollDue> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let scheduled = {
                let mut inner = self.lock_inner();
                let now = tokio::time::Instant::now();
                if inner.consume_deferred_if_due(now) {
                    return Some(inner.consume_poll(PollReason::Deferred, now));
                }
                if inner.deferred_poll.is_some() {
                    // Deferred fairness deliberately holds immediate polls
                    // and wakeup retries until the deferred deadline.
                    Self::next_scheduled(&inner, now, slow_interval, fast_interval)
                } else if inner.poll_now {
                    inner.poll_now = false;
                    return Some(inner.consume_poll(PollReason::Immediate, now));
                } else if inner.wakeup_retry_at.is_some_and(|at| at <= now) {
                    inner.wakeup_retry_at = None;
                    return Some(inner.consume_poll(PollReason::WakeupRetry, now));
                } else {
                    Self::next_scheduled(&inner, now, slow_interval, fast_interval)
                }
            };

            tokio::select! {
                () = cancel.cancelled() => {
                    return None;
                }
                () = &mut notified => {}
                () = tokio::time::sleep_until(scheduled.at) => {
                    if let Some(due) = self.consume_scheduled(scheduled) {
                        return Some(due);
                    }
                }
            }
        }
    }

    fn next_scheduled(
        inner: &PollWakeupsInner,
        now: tokio::time::Instant,
        slow_interval: Duration,
        fast_interval: Duration,
    ) -> ScheduledPoll {
        let mut scheduled = if let Some(window) = &inner.deferred_poll {
            // A pending deferred poll is the highest-priority scheduled
            // deadline, even when an immediate poll or wakeup retry exists.
            ScheduledPoll {
                at: window.at,
                reason: PollReason::Deferred,
                reuse: false,
            }
        } else if inner.ably_connected {
            ScheduledPoll {
                at: now + slow_interval,
                reason: PollReason::Slow,
                reuse: false,
            }
        } else {
            ScheduledPoll {
                at: now + fast_interval,
                reason: PollReason::Fast,
                reuse: false,
            }
        };

        if inner.deferred_poll.is_none()
            && let Some(reuse) = &inner.reuse_poll
            && reuse.at < scheduled.at
        {
            scheduled = ScheduledPoll {
                at: reuse.at,
                reason: PollReason::Fast,
                reuse: true,
            };
        }

        if inner.deferred_poll.is_none()
            && let Some(at) = inner.wakeup_retry_at
            && at <= scheduled.at
        {
            scheduled = ScheduledPoll {
                at,
                reason: PollReason::WakeupRetry,
                reuse: false,
            };
        }
        scheduled
    }

    fn consume_scheduled(&self, scheduled: ScheduledPoll) -> Option<PollDue> {
        let mut inner = self.lock_inner();
        let now = tokio::time::Instant::now();

        let is_due = match scheduled.reason {
            PollReason::Immediate => false,
            PollReason::WakeupRetry => {
                if inner.deferred_poll.is_none()
                    && inner.wakeup_retry_at.is_some_and(|at| at <= now)
                {
                    inner.wakeup_retry_at = None;
                    true
                } else {
                    false
                }
            }
            PollReason::Deferred => inner.consume_deferred_if_due(now),
            PollReason::Slow => {
                inner.deferred_poll.is_none()
                    && inner.ably_connected
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
            PollReason::Fast => {
                inner.deferred_poll.is_none()
                    && if scheduled.reuse {
                        inner
                            .reuse_poll
                            .as_ref()
                            .is_some_and(|reuse| reuse.at <= now)
                    } else {
                        !inner.ably_connected
                    }
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
        };
        is_due.then(|| inner.consume_poll(scheduled.reason, now))
    }

    fn has_due_wakeup(inner: &PollWakeupsInner, now: tokio::time::Instant) -> bool {
        inner.wakeup_retry_at.is_some_and(|at| at <= now)
            || inner
                .deferred_poll
                .as_ref()
                .is_some_and(|window| window.at <= now)
    }

    #[cfg(test)]
    pub(super) fn snapshot(&self) -> PollWakeupsSnapshot {
        let inner = self.lock_inner();
        PollWakeupsSnapshot {
            ably_connected: inner.ably_connected,
            poll_now: inner.poll_now,
            deferred_poll_at: inner.deferred_poll.as_ref().map(|window| window.at),
            deferred_poll_cap_at: inner.deferred_poll.as_ref().map(|window| window.cap_at),
            wakeup_retry_at: inner.wakeup_retry_at,
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(super) struct PollWakeupsSnapshot {
    pub(super) ably_connected: bool,
    pub(super) poll_now: bool,
    pub(super) deferred_poll_at: Option<tokio::time::Instant>,
    pub(super) deferred_poll_cap_at: Option<tokio::time::Instant>,
    pub(super) wakeup_retry_at: Option<tokio::time::Instant>,
}

pub(super) struct AblySupervisor {
    shutdown: CancellationToken,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

pub(super) struct AblySupervisorConfig {
    pub(super) ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    pub(super) api: ApiClient,
    pub(super) group: String,
    pub(super) profiles: Vec<String>,
    pub(super) poll_wakeups: Arc<PollWakeups>,
    pub(super) direct_candidates: Arc<DirectCandidateInbox>,
    pub(super) cancel_tokens: RunCancellationRegistry,
    pub(super) connector_runtime_sync: ConnectorRuntimeSyncHandle,
    pub(super) active_input_notifications: ActiveInputNotifications,
    pub(super) provider_cancel: CancellationToken,
}

struct SupervisorTaskConfig {
    ably_side_message_handler: Option<Arc<dyn super::AblySideMessageHandler>>,
    api: ApiClient,
    group: String,
    profiles: Vec<String>,
    poll_wakeups: Arc<PollWakeups>,
    direct_candidates: Arc<DirectCandidateInbox>,
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
            profiles: config.profiles,
            poll_wakeups: config.poll_wakeups,
            direct_candidates: config.direct_candidates,
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
                        config.poll_wakeups.mark_ably_connected();
                    }
                    ConnectionEvent::ConnectResult(Err(reason)) => {
                        disconnect.record_disconnected(reason);
                        config.poll_wakeups.mark_ably_disconnected();
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
// health still controls discovery polling, but is not evidence of revoked access.
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
                &config.profiles,
                &config.poll_wakeups,
                &config.direct_candidates,
                &config.cancel_tokens,
                Some(&config.connector_runtime_sync),
                Some(&config.shutdown),
            )
            .await;
        }
        Some(ably_subscriber::Event::Connected) => {
            handle_ably_connected(
                disconnect,
                &config.poll_wakeups,
                &config.active_input_notifications,
            );
        }
        Some(ably_subscriber::Event::Disconnected { reason }) => {
            let reason = reason.unwrap_or_else(|| "unknown".to_string());
            disconnect.record_disconnected(reason.clone());
            config.poll_wakeups.mark_ably_disconnected();
            info!(reason = %reason, "ably disconnected, switching to fast poll");
        }
        Some(ably_subscriber::Event::Error { code, message }) => {
            error!(code, message = %message, "ably fatal error, will reconnect");
            disconnect.record_disconnected(message.clone());
            config.poll_wakeups.mark_ably_disconnected();
            connection.retry();
        }
        None => {
            warn!("ably subscription closed, will reconnect");
            disconnect.record_disconnected("subscription closed".to_string());
            config.poll_wakeups.mark_ably_disconnected();
            connection.retry();
        }
    }
}

// Every subscription and every reconnect, resumed or fresh, emits
// `Event::Connected`. An `active-input` push published while disconnected is
// lost, so each active run reads its next steerable input once.
fn handle_ably_connected(
    disconnect: &mut AblyDisconnectState,
    poll_wakeups: &PollWakeups,
    active_input_notifications: &ActiveInputNotifications,
) {
    if !disconnect.is_connected() {
        info!("ably reconnected");
    }
    disconnect.mark_connected();
    poll_wakeups.mark_ably_connected();
    active_input_notifications.notify_all();
}

#[cfg(test)]
async fn handle_ably_message(
    msg: &ably_subscriber::Message,
    profiles: &[String],
    poll_wakeups: &PollWakeups,
    direct_candidates: &DirectCandidateInbox,
    cancel_tokens: &RunCancellationRegistry,
) {
    handle_ably_message_with_connector_runtime_sync(
        msg,
        profiles,
        poll_wakeups,
        direct_candidates,
        cancel_tokens,
        None,
        None,
    )
    .await;
}

async fn handle_ably_message_with_connector_runtime_sync(
    msg: &ably_subscriber::Message,
    profiles: &[String],
    poll_wakeups: &PollWakeups,
    direct_candidates: &DirectCandidateInbox,
    cancel_tokens: &RunCancellationRegistry,
    connector_runtime_sync: Option<&ConnectorRuntimeSyncHandle>,
    connector_runtime_sync_cancel: Option<&CancellationToken>,
) {
    let notification_received_at = StdInstant::now();

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
        return;
    }

    let action = {
        let Some(notif) = parse_job_notification(msg) else {
            return;
        };

        if let Some(profile) = notif.profile {
            if supports_profile(profiles, profile) {
                info!(
                    run_id = %notif.run_id,
                    profile = %profile,
                    "ably: job notification, queueing direct candidate"
                );
                JobNotificationAction::Direct(Box::new(
                    DirectJobCandidate::new_with_routing_metadata(
                        notif.run_id,
                        profile.to_owned(),
                        notification_received_at,
                        notif.reuse_key.map(str::to_owned),
                        notif.runner_preference_context,
                    ),
                ))
            } else {
                info!(
                    run_id = %notif.run_id,
                    profile = %profile,
                    "ably: job profile unsupported, ignoring direct notification"
                );
                JobNotificationAction::Ignore
            }
        } else {
            info!(
                run_id = %notif.run_id,
                "ably: job notification missing profile, waking poll"
            );
            JobNotificationAction::WakeNow
        }
    };

    match action {
        JobNotificationAction::WakeNow => {
            poll_wakeups.request_immediate_poll();
        }
        JobNotificationAction::Direct(candidate) => {
            enqueue_direct_candidate(*candidate, direct_candidates, poll_wakeups).await;
        }
        JobNotificationAction::Ignore => {}
    }
}

enum JobNotificationAction {
    Direct(Box<DirectJobCandidate>),
    Ignore,
    WakeNow,
}

struct JobNotification<'a> {
    run_id: RunId,
    profile: Option<&'a str>,
    reuse_key: Option<&'a str>,
    runner_preference_context: Option<RunnerPreferenceContext>,
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

fn supports_profile(profiles: &[String], profile: &str) -> bool {
    profiles.iter().any(|candidate| candidate == profile)
}

async fn enqueue_direct_candidate(
    candidate: DirectJobCandidate,
    direct_candidates: &DirectCandidateInbox,
    poll_wakeups: &PollWakeups,
) {
    let run_id = candidate.run_id();
    let profile = candidate.profile_name().to_owned();
    let outcome = direct_candidates.push(candidate).await;
    if let Some(pruned) = outcome.pruned() {
        log_direct_candidate_pruned(&profile, "push", pruned);
    }
    match outcome {
        DirectCandidateInsertOutcome::Inserted { .. }
        | DirectCandidateInsertOutcome::Updated { .. } => {}
        DirectCandidateInsertOutcome::Overflow {
            snapshot,
            coalesced_count,
            should_wake_poll,
            ..
        } => {
            if !should_wake_poll {
                return;
            }
            warn!(
                run_id = %run_id,
                profile = %profile,
                depth = snapshot.depth,
                capacity = snapshot.capacity,
                coalesced_overflow_count = coalesced_count,
                fallback_poll_requested = true,
                "ably: direct candidate inbox full, waking poll"
            );
            poll_wakeups.request_immediate_poll();
        }
    }
}

fn log_direct_candidate_pruned(
    profile: &str,
    source: &'static str,
    pruned: DirectCandidatePruneSnapshot,
) {
    info!(
        profile,
        source,
        pruned_count = pruned.pruned_count,
        depth = pruned.depth,
        capacity = pruned.capacity,
        stale_after_ms = duration_ms(pruned.stale_after),
        oldest_pruned_wait_ms = duration_ms(pruned.oldest_pruned_wait_elapsed),
        "ably: stale direct candidates pruned"
    );
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

fn parse_job_notification(msg: &ably_subscriber::Message) -> Option<JobNotification<'_>> {
    if msg.name.as_deref() != Some("job") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str());
    let run_id = match raw {
        Some(s) => match s.parse() {
            Ok(id) => id,
            Err(e) => {
                warn!(value = %s, error = %e, "ably: invalid runId");
                return None;
            }
        },
        None => {
            warn!("ably: job message missing runId");
            return None;
        }
    };
    let profile = msg
        .data
        .get("profile")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty());
    let reuse_key = msg
        .data
        .get("reuseKey")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty());
    let runner_preference_context =
        match parse_runner_preference(msg.data.get("runnerPreference").cloned()) {
            Ok(context) => context,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    error = %error,
                    "ably: invalid runner preference, using ordinary admission"
                );
                None
            }
        };
    Some(JobNotification {
        run_id,
        profile,
        reuse_key,
        runner_preference_context,
    })
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
                "ably disconnected for too long, continuing fast poll"
            );
        }
    }
}

#[cfg(test)]
mod tests;
