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

#[cfg(test)]
pub(super) mod testing;

use super::api::ApiClient;
use super::api_direct_candidates::{
    DirectCandidateInbox, DirectCandidateInsertOutcome, DirectCandidatePruneSnapshot,
    DirectJobCandidate,
};
use super::connector_runtime_sync::ConnectorRuntimeSyncHandle;
use super::{RunnerPreferenceContext, parse_runner_preference};
use crate::active_input::ActiveInputNotifications;
use crate::duration::duration_ms;
use crate::ids::RunId;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::run_cancellation::{RunCancellationHandle, RunCancellationRegistry};
use crate::types::ConnectorRuntimeTarget;

const ABLY_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
const ABLY_BACKOFF_MAX: Duration = Duration::from_secs(60);
const ABLY_DISCONNECT_ERROR_AFTER: Duration = Duration::from_secs(60);
const DEFERRED_POLL_MAX: Duration = Duration::from_secs(10);
type AblyConnectHandle =
    tokio::task::JoinHandle<Result<ably_subscriber::Subscription, ably_subscriber::Error>>;
type CancelDelivery = Pin<Box<dyn Future<Output = ()> + Send>>;

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
struct PollWakeupsInner {
    /// Selects slow versus fast ordinary polling cadence.
    ably_connected: bool,
    /// Immediate poll request. Re-armed after `JobFound` to drain backlog.
    poll_now: bool,
    /// Deferred poll deadline. Blocks immediate and retry polls until this
    /// deadline is reached.
    deferred_poll_at: Option<tokio::time::Instant>,
    /// Upper bound for repeated deferral extension.
    deferred_poll_cap_at: Option<tokio::time::Instant>,
    /// Retry deadline for failed wakeup-driven polls only.
    wakeup_retry_at: Option<tokio::time::Instant>,
    /// Bumped whenever a new wakeup is recorded. This keeps an older HTTP poll
    /// result from clearing a wakeup that arrived after the poll started.
    generation: u64,
}

impl PollWakeupsInner {
    fn bump_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
}

#[derive(Debug, Clone, Copy)]
struct ScheduledPoll {
    at: tokio::time::Instant,
    reason: PollReason,
}

impl PollWakeups {
    pub(super) fn new(ably_connected: bool) -> Self {
        Self {
            inner: StdMutex::new(PollWakeupsInner {
                ably_connected,
                poll_now: true,
                deferred_poll_at: None,
                deferred_poll_cap_at: None,
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
        let cap_at = *inner.deferred_poll_cap_at.get_or_insert(cap_at);
        let at = at.min(cap_at);
        if inner.deferred_poll_at.is_none_or(|existing| at > existing) {
            inner.deferred_poll_at = Some(at);
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
        let has_new_wakeup = inner.generation != due.generation;
        // A deferred wakeup that arrives while an HTTP poll is in flight
        // must be honored before returning a newly found job to this runner.
        let defer_job_return =
            outcome == PollOutcome::JobFound && has_new_wakeup && inner.deferred_poll_at.is_some();
        match outcome {
            PollOutcome::JobFound => {
                // A successful poll can mean more eligible work is already queued,
                // so re-arm the immediate path to drain backlog without waiting
                // for the ordinary slow/fast cadence.
                inner.poll_now = true;
                if !has_new_wakeup {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.wakeup_retry_at = None;
                }
                inner.bump_generation();
                should_notify = true;
            }
            PollOutcome::Empty => {
                if !has_new_wakeup {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.wakeup_retry_at = None;
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
                if inner.deferred_poll_at.is_some_and(|at| at <= now) {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.poll_now = false;
                    return Some(PollDue {
                        reason: PollReason::Deferred,
                        generation: inner.generation,
                    });
                }
                if inner.deferred_poll_at.is_some() {
                    // Deferred fairness deliberately holds immediate polls
                    // and wakeup retries until the deferred deadline.
                    Self::next_scheduled(&inner, now, slow_interval, fast_interval)
                } else if inner.poll_now {
                    inner.poll_now = false;
                    return Some(PollDue {
                        reason: PollReason::Immediate,
                        generation: inner.generation,
                    });
                } else if inner.wakeup_retry_at.is_some_and(|at| at <= now) {
                    inner.wakeup_retry_at = None;
                    return Some(PollDue {
                        reason: PollReason::WakeupRetry,
                        generation: inner.generation,
                    });
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
        let mut scheduled = if let Some(at) = inner.deferred_poll_at {
            // A pending deferred poll is the highest-priority scheduled
            // deadline, even when an immediate poll or wakeup retry exists.
            ScheduledPoll {
                at,
                reason: PollReason::Deferred,
            }
        } else if inner.ably_connected {
            ScheduledPoll {
                at: now + slow_interval,
                reason: PollReason::Slow,
            }
        } else {
            ScheduledPoll {
                at: now + fast_interval,
                reason: PollReason::Fast,
            }
        };

        if inner.deferred_poll_at.is_none()
            && let Some(at) = inner.wakeup_retry_at
            && at <= scheduled.at
        {
            scheduled = ScheduledPoll {
                at,
                reason: PollReason::WakeupRetry,
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
                if inner.deferred_poll_at.is_none()
                    && inner.wakeup_retry_at.is_some_and(|at| at <= now)
                {
                    inner.wakeup_retry_at = None;
                    true
                } else {
                    false
                }
            }
            PollReason::Deferred => {
                if inner.deferred_poll_at.is_some_and(|at| at <= now) {
                    inner.deferred_poll_at = None;
                    inner.deferred_poll_cap_at = None;
                    inner.poll_now = false;
                    true
                } else {
                    false
                }
            }
            PollReason::Slow => {
                inner.deferred_poll_at.is_none()
                    && inner.ably_connected
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
            PollReason::Fast => {
                inner.deferred_poll_at.is_none()
                    && !inner.ably_connected
                    && !inner.poll_now
                    && !Self::has_due_wakeup(&inner, now)
            }
        };
        is_due.then_some(PollDue {
            reason: scheduled.reason,
            generation: inner.generation,
        })
    }

    fn has_due_wakeup(inner: &PollWakeupsInner, now: tokio::time::Instant) -> bool {
        inner.wakeup_retry_at.is_some_and(|at| at <= now)
            || inner.deferred_poll_at.is_some_and(|at| at <= now)
    }

    #[cfg(test)]
    pub(super) fn snapshot(&self) -> PollWakeupsSnapshot {
        let inner = self.lock_inner();
        PollWakeupsSnapshot {
            ably_connected: inner.ably_connected,
            poll_now: inner.poll_now,
            deferred_poll_at: inner.deferred_poll_at,
            deferred_poll_cap_at: inner.deferred_poll_cap_at,
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
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

pub(super) struct AblySupervisorConfig {
    pub(super) ssh: Option<Arc<crate::ssh::SshRuntime>>,
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
    ssh: Option<Arc<crate::ssh::SshRuntime>>,
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
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let task_config = SupervisorTaskConfig {
            ssh: config.ssh,
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
            run_supervisor(task_config).await;
        });
        Self {
            shutdown,
            task: StdMutex::new(Some(task)),
        }
    }

    pub(super) async fn shutdown(&self) {
        self.shutdown.cancel();
        let task = self.take_task();
        if let Some(task) = task
            && let Err(e) = task.await
        {
            warn!(error = %e, "ably supervisor task failed during shutdown");
        }
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self {
            shutdown: CancellationToken::new(),
            task: StdMutex::new(None),
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
            task: StdMutex::new(Some(task)),
        }
    }

    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for AblySupervisor {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn run_supervisor(config: SupervisorTaskConfig) {
    let mut ably: Option<ably_subscriber::Subscription> = None;
    let mut cancel_deliveries = FuturesUnordered::<CancelDelivery>::new();
    let mut ably_retry: RetryState<AblyConnectHandle> =
        RetryState::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX, None);
    ably_retry.restart_at = Some(StdInstant::now());
    let mut disconnect = AblyDisconnectState::disconnected("connecting".to_string());

    loop {
        maybe_spawn_ably_connect(&mut ably, &config.api, &config.group, &mut ably_retry);
        let disconnect_error_at = disconnect.error_deadline();

        tokio::select! {
            () = config.shutdown.cancelled() => {
                break;
            }
            () = config.provider_cancel.cancelled() => {
                break;
            }
            event = recv_ably(&mut ably) => {
                handle_ably_event(
                    &config,
                    event,
                    &mut ably,
                    &mut ably_retry,
                    &mut disconnect,
                    &mut cancel_deliveries,
                ).await;
            }
            Some(()) = cancel_deliveries.next(), if !cancel_deliveries.is_empty() => {}
            result = recv_retry(&mut ably_retry.handle) => {
                match handle_ably_connect_result(result, &mut ably, &mut ably_retry) {
                    Ok(()) => {
                        disconnect.mark_connected();
                        config.poll_wakeups.mark_ably_connected();
                    }
                    Err(reason) => {
                        disconnect.record_disconnected(reason);
                        config.poll_wakeups.mark_ably_disconnected();
                    }
                }
            }
            () = sleep_until_retry(&ably_retry.restart_at) => {}
            () = sleep_until_optional(disconnect_error_at), if disconnect_error_at.is_some() => {
                disconnect.mark_error_logged();
                error!(
                    reason = %disconnect.reason(),
                    disconnected_secs = disconnect.disconnected_secs(),
                    "ably disconnected for too long, continuing fast poll"
                );
            }
        }
    }

    if let Some(sub) = ably.take() {
        sub.close();
    }
    if let Some(handle) = ably_retry.handle.take() {
        handle.abort();
        let _ = handle.await;
    }
}

// Only delivered authority messages can change SSH authorization. Subscription
// health still controls discovery polling, but is not evidence of revoked access.
async fn handle_ably_event(
    config: &SupervisorTaskConfig,
    event: Option<ably_subscriber::Event>,
    ably: &mut Option<ably_subscriber::Subscription>,
    ably_retry: &mut RetryState<AblyConnectHandle>,
    disconnect: &mut AblyDisconnectState,
    cancel_deliveries: &mut FuturesUnordered<CancelDelivery>,
) {
    match event {
        Some(ably_subscriber::Event::Message(msg)) => {
            if config
                .ssh
                .as_ref()
                .is_some_and(|ssh| ssh.ably_message(&msg))
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
            if !disconnect.is_connected() {
                info!("ably reconnected");
            }
            disconnect.mark_connected();
            config.poll_wakeups.mark_ably_connected();
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
            *ably = None;
            ably_retry.schedule();
        }
        None => {
            warn!("ably subscription closed, will reconnect");
            disconnect.record_disconnected("subscription closed".to_string());
            config.poll_wakeups.mark_ably_disconnected();
            *ably = None;
            ably_retry.schedule();
        }
    }
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
                    )
                    .with_history_generation_run_id(notif.history_generation_run_id),
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
    history_generation_run_id: Option<RunId>,
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
enum CancelNotificationMode {
    Cooperative,
    Hard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CancelNotification {
    run_id: RunId,
    mode: CancelNotificationMode,
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
        CancelNotificationMode::Cooperative => {
            info!(run_id = %run_id, "ably: cancel notification, requesting cooperative cancellation");
            handle.request_cooperative_user_cancellation().await;
        }
        CancelNotificationMode::Hard => {
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
            CancelNotificationMode::Cooperative
        }
        Some(serde_json::Value::String(mode)) if mode == "hard" => CancelNotificationMode::Hard,
        Some(mode) => {
            warn!(
                run_id = %run_id,
                mode = %mode,
                "ably: unknown cancel mode, using hard cancellation"
            );
            CancelNotificationMode::Hard
        }
        // Default to hard cancellation when the API omits the mode so a
        // malformed or stale notification still stops the run safely.
        None => CancelNotificationMode::Hard,
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
    let history_generation_run_id = msg
        .data
        .get("historyGenerationRunId")
        .and_then(|v| v.as_str())
        .and_then(|value| value.parse().ok());
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
        history_generation_run_id,
        runner_preference_context,
    })
}

async fn recv_ably(
    ably: &mut Option<ably_subscriber::Subscription>,
) -> Option<ably_subscriber::Event> {
    match ably {
        Some(sub) => sub.next().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until_optional(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn make_ably_config(api: &ApiClient, group: &str) -> ably_subscriber::SubscribeConfig {
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
    ably_subscriber::SubscribeConfig::new(get_token, channel)
}

fn maybe_spawn_ably_connect(
    ably: &mut Option<ably_subscriber::Subscription>,
    api: &ApiClient,
    group: &str,
    retry: &mut RetryState<AblyConnectHandle>,
) {
    if ably.is_some() || !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    let ably_config = make_ably_config(api, group);
    retry.handle = Some(tokio::spawn(ably_subscriber::subscribe(ably_config)));
}

fn handle_ably_connect_result(
    result: Result<ably_subscriber::Subscription, String>,
    ably: &mut Option<ably_subscriber::Subscription>,
    retry: &mut RetryState<AblyConnectHandle>,
) -> Result<(), String> {
    match result {
        Ok(sub) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "ably connected after failures"
                );
            } else {
                info!("ably connected");
            }
            *ably = Some(sub);
            retry.on_success();
            Ok(())
        }
        Err(e) => {
            let next_secs = retry.backoff().as_secs();
            let _ = retry.on_failure();
            warn!(
                error = %e,
                failures = retry.consecutive_failures(),
                next_attempt_secs = next_secs,
                "ably connect failed"
            );
            Err(e)
        }
    }
}

struct AblyDisconnectState {
    connected: bool,
    disconnected_at: Option<tokio::time::Instant>,
    error_logged: bool,
    reason: Option<String>,
}

impl AblyDisconnectState {
    fn disconnected(reason: String) -> Self {
        Self {
            connected: false,
            disconnected_at: Some(tokio::time::Instant::now()),
            error_logged: false,
            reason: Some(reason),
        }
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn mark_connected(&mut self) {
        self.connected = true;
        self.disconnected_at = None;
        self.error_logged = false;
        self.reason = None;
    }

    fn record_disconnected(&mut self, reason: String) {
        if self.connected || self.disconnected_at.is_none() {
            self.disconnected_at = Some(tokio::time::Instant::now());
            self.error_logged = false;
        }
        self.connected = false;
        self.reason = Some(reason);
    }

    fn error_deadline(&self) -> Option<tokio::time::Instant> {
        if self.connected || self.error_logged {
            None
        } else {
            self.disconnected_at
                .map(|at| at + ABLY_DISCONNECT_ERROR_AFTER)
        }
    }

    fn mark_error_logged(&mut self) {
        self.error_logged = true;
    }

    fn disconnected_secs(&self) -> u64 {
        self.disconnected_at
            .map(|at| at.elapsed().as_secs())
            .unwrap_or_else(|| ABLY_DISCONNECT_ERROR_AFTER.as_secs())
    }

    fn reason(&self) -> &str {
        self.reason.as_deref().unwrap_or("unknown")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{RunnerPreference, RunnerPreferenceTier};

    fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
        ably_subscriber::Message {
            name: name.map(String::from),
            data,
            id: None,
            client_id: None,
            timestamp: None,
        }
    }

    fn poll_reason(due: Option<PollDue>) -> Option<PollReason> {
        due.map(PollDue::reason)
    }

    fn direct_candidate_inbox() -> Arc<DirectCandidateInbox> {
        direct_candidate_inbox_with_capacity(4)
    }

    fn direct_candidate_inbox_with_capacity(capacity: usize) -> Arc<DirectCandidateInbox> {
        direct_candidate_inbox_with_stale_after(
            capacity,
            crate::provider::api_direct_candidates::DIRECT_CANDIDATE_STALE_AFTER,
        )
    }

    fn direct_candidate_inbox_with_stale_after(
        capacity: usize,
        stale_after: Duration,
    ) -> Arc<DirectCandidateInbox> {
        DirectCandidateInbox::new(capacity, stale_after)
    }

    async fn pop_direct_candidate(inbox: &DirectCandidateInbox) -> DirectJobCandidate {
        inbox.try_pop().await.expect("direct candidate")
    }

    async fn assert_no_direct_candidate(inbox: &DirectCandidateInbox) {
        assert!(inbox.try_pop().await.is_none());
    }

    fn default_profiles() -> Vec<String> {
        vec![crate::profile::DEFAULT_PROFILE.to_string()]
    }

    #[tokio::test(start_paused = true)]
    async fn wait_for_poll_due_consumes_stateful_immediate_wakeup() {
        let wakeups = PollWakeups::new(true);

        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
        let snapshot = wakeups.snapshot();
        assert!(snapshot.ably_connected);
        assert!(!snapshot.poll_now);
    }

    #[tokio::test(start_paused = true)]
    async fn wakeup_poll_failure_schedules_short_retry() {
        let wakeups = PollWakeups::new(true);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups.record_poll_result(reason, PollOutcome::Failure, Duration::from_secs(5));
        let snapshot = wakeups.snapshot();
        assert!(snapshot.wakeup_retry_at.is_some());

        tokio::time::sleep(Duration::from_secs(5)).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::WakeupRetry));
    }

    #[tokio::test(start_paused = true)]
    async fn regular_poll_failure_does_not_schedule_wakeup_retry() {
        let wakeups = PollWakeups::new(false);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        tokio::time::sleep(Duration::from_secs(5)).await;
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(due.reason(), PollReason::Fast);

        wakeups.record_poll_result(due, PollOutcome::Failure, Duration::from_secs(5));
        assert!(wakeups.snapshot().wakeup_retry_at.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn disconnected_state_uses_fast_poll_interval() {
        let wakeups = Arc::new(PollWakeups::new(false));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(5)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Fast));
    }

    #[tokio::test(start_paused = true)]
    async fn connected_state_uses_slow_poll_interval() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(30)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Slow));
    }

    #[tokio::test(start_paused = true)]
    async fn pending_connected_wait_switches_to_fast_after_disconnect() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(!wait.is_finished());

        wakeups.mark_ably_disconnected();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(!wait.is_finished());
        tokio::time::sleep(Duration::from_secs(1)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Fast));
    }

    #[tokio::test(start_paused = true)]
    async fn pending_disconnected_wait_switches_to_slow_after_connect() {
        let wakeups = Arc::new(PollWakeups::new(false));
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(!wait.is_finished());

        wakeups.mark_ably_connected();
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert!(!wait.is_finished());
        tokio::time::sleep(Duration::from_secs(1)).await;

        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Slow));
    }

    #[tokio::test]
    async fn job_found_rearms_immediate_poll_for_backlog_drain() {
        let wakeups = PollWakeups::new(true);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups.record_poll_result(reason, PollOutcome::JobFound, Duration::from_secs(5));

        assert!(wakeups.snapshot().poll_now);
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Immediate));
    }

    #[tokio::test(start_paused = true)]
    async fn deferred_poll_extends_until_latest_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups.request_deferred_poll_after(Duration::from_secs(2));
        let first_deadline = wakeups
            .snapshot()
            .deferred_poll_at
            .expect("first defer deadline");
        tokio::time::sleep(Duration::from_secs(1)).await;
        wakeups.request_deferred_poll_after(Duration::from_secs(2));
        let extended_deadline = wakeups
            .snapshot()
            .deferred_poll_at
            .expect("extended defer deadline");

        assert!(extended_deadline > first_deadline);
        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !wait.is_finished(),
            "new deferred poll request should extend the defer window"
        );

        tokio::time::sleep_until(extended_deadline).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
    }

    #[tokio::test]
    async fn deferred_poll_until_preserves_absolute_deadline() {
        let wakeups = PollWakeups::new(true);
        let deadline = StdInstant::now() + Duration::from_secs(2);

        wakeups.request_deferred_poll_until(deadline);

        assert_eq!(wakeups.snapshot().deferred_poll_at, Some(deadline.into()));
    }

    #[tokio::test(start_paused = true)]
    async fn deferred_poll_extension_is_bounded() {
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups.request_deferred_poll_after(Duration::from_secs(2));
        let cap = wakeups.snapshot().deferred_poll_cap_at.expect("defer cap");
        for _ in 0..9 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            wakeups.request_deferred_poll_after(Duration::from_secs(2));
        }

        let snapshot = wakeups.snapshot();
        assert_eq!(snapshot.deferred_poll_at, Some(cap));
        assert_eq!(snapshot.deferred_poll_cap_at, Some(cap));
        tokio::time::sleep_until(cap).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
    }

    #[tokio::test(start_paused = true)]
    async fn deferred_poll_cap_resets_after_deadline() {
        let wakeups = PollWakeups::new(true);
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;

        wakeups.request_deferred_poll_after(Duration::from_secs(2));
        let initial_cap = wakeups
            .snapshot()
            .deferred_poll_cap_at
            .expect("initial defer cap");
        for _ in 0..9 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            wakeups.request_deferred_poll_after(Duration::from_secs(2));
        }

        tokio::time::sleep_until(initial_cap).await;
        let reason = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(poll_reason(reason), Some(PollReason::Deferred));
        let snapshot = wakeups.snapshot();
        assert!(snapshot.deferred_poll_at.is_none());
        assert!(snapshot.deferred_poll_cap_at.is_none());

        wakeups.request_deferred_poll_after(Duration::from_secs(2));
        let snapshot = wakeups.snapshot();
        let next_deadline = snapshot
            .deferred_poll_at
            .expect("next defer deadline should be scheduled");
        let next_cap = snapshot
            .deferred_poll_cap_at
            .expect("next defer cap should be scheduled");
        assert!(next_deadline > initial_cap);
        assert!(next_cap > next_deadline);
    }

    #[tokio::test(start_paused = true)]
    async fn deferred_poll_blocks_pending_immediate_until_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(initial, PollOutcome::JobFound, Duration::from_secs(5));
        assert!(wakeups.snapshot().poll_now);

        wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));

        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "pending immediate must not bypass deferred poll window"
        );

        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
        assert!(!wakeups.snapshot().poll_now);
    }

    #[tokio::test(start_paused = true)]
    async fn deferred_poll_blocks_wakeup_retry_until_deadline() {
        let wakeups = Arc::new(PollWakeups::new(true));
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(initial, PollOutcome::Failure, Duration::from_secs(1));
        wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));

        tokio::time::sleep(Duration::from_secs(1)).await;
        let wakeups_for_wait = Arc::clone(&wakeups);
        let cancel = CancellationToken::new();
        let wait = tokio::spawn(async move {
            wakeups_for_wait
                .wait_for_poll_due(&cancel, Duration::from_secs(30), Duration::from_secs(5))
                .await
        });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "wakeup retry must not bypass deferred poll window"
        );

        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(poll_reason(wait.await.unwrap()), Some(PollReason::Deferred));
    }

    #[tokio::test(start_paused = true)]
    async fn empty_poll_keeps_deferred_wakeup_created_after_poll_started() {
        let wakeups = PollWakeups::new(true);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        let deferred_at = tokio::time::Instant::now() + Duration::from_secs(2);
        wakeups.request_deferred_poll_at(deferred_at);
        wakeups.record_poll_result(due, PollOutcome::Empty, Duration::from_secs(5));

        assert_eq!(wakeups.snapshot().deferred_poll_at, Some(deferred_at));
    }

    #[tokio::test(start_paused = true)]
    async fn job_found_defers_return_when_deferred_poll_arrived_after_poll_started() {
        let wakeups = PollWakeups::new(true);
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
        let record = wakeups.record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5));

        assert!(record.defer_job_return());
        assert!(wakeups.snapshot().deferred_poll_at.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn job_found_returns_when_deferred_poll_was_the_poll_reason() {
        let wakeups = PollWakeups::new(true);
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5));
        wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let due = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        let record = wakeups.record_poll_result(due, PollOutcome::JobFound, Duration::from_secs(5));

        assert!(!record.defer_job_return());
    }

    #[tokio::test(start_paused = true)]
    async fn empty_poll_clears_deferred_wakeup_seen_by_poll() {
        let wakeups = PollWakeups::new(true);
        let initial = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        wakeups.record_poll_result(initial, PollOutcome::Empty, Duration::from_secs(5));

        wakeups.request_deferred_poll_at(tokio::time::Instant::now() + Duration::from_secs(2));
        tokio::time::sleep(Duration::from_secs(2)).await;
        let deferred = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await
            .unwrap();

        wakeups.record_poll_result(deferred, PollOutcome::Empty, Duration::from_secs(5));

        assert!(wakeups.snapshot().deferred_poll_at.is_none());
    }

    #[test]
    fn disconnect_state_preserves_one_shot_escalation_window() {
        let mut state = AblyDisconnectState {
            connected: true,
            disconnected_at: None,
            error_logged: false,
            reason: None,
        };

        state.record_disconnected("first disconnect".to_string());
        let first_disconnected_at = state.disconnected_at;
        state.mark_error_logged();
        state.record_disconnected("second disconnect event".to_string());

        assert!(!state.connected);
        assert_eq!(state.disconnected_at, first_disconnected_at);
        assert!(state.error_logged);
        assert_eq!(state.reason(), "second disconnect event");
        assert!(state.error_deadline().is_none());

        state.mark_connected();
        state.record_disconnected("new window".to_string());
        assert!(!state.error_logged);
        assert!(state.error_deadline().is_some());
    }

    #[tokio::test]
    async fn cooperative_cancel_notification_uses_cooperative_signal_without_discovery() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let token = registration.token();
        let signals = registration.handle().signals();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": run_id, "mode": "cooperative" }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert!(token.is_cancelled());
        assert!(signals.cooperative_user().is_cancelled());
        assert!(!signals.hard().is_cancelled());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn hard_cancel_notification_uses_hard_signal_without_discovery() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let signals = registration.handle().signals();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": run_id, "mode": "hard" }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert!(signals.any().is_cancelled());
        assert!(signals.hard().is_cancelled());
        assert!(!signals.cooperative_user().is_cancelled());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn legacy_cancel_notification_defaults_to_hard_signal() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let signals = registration.handle().signals();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let msg = make_message(Some("cancel"), serde_json::json!({ "runId": run_id }));

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert!(signals.any().is_cancelled());
        assert!(signals.hard().is_cancelled());
        assert!(!signals.cooperative_user().is_cancelled());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn unknown_cancel_notification_mode_defaults_to_hard_signal() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let signals = registration.handle().signals();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": run_id, "mode": "future-mode" }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert!(signals.any().is_cancelled());
        assert!(signals.hard().is_cancelled());
        assert!(!signals.cooperative_user().is_cancelled());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn queued_cancel_preserves_registration_and_allows_unrelated_notification() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let job_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let signals = registration.handle().signals();
        let transfer_guard = registration.handle().transfer_guard().await;
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({ "runId": run_id, "mode": "hard" }),
        );
        let mut cancel_deliveries = FuturesUnordered::new();
        assert!(enqueue_cancel_delivery(&msg, &tokens, &mut cancel_deliveries).await);

        assert!(futures_util::poll!(cancel_deliveries.next()).is_pending());
        assert!(registration.unregister().await);
        let replacement = tokens.register(run_id).await.unwrap();

        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let job_msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": job_run_id,
                "profile": "vm0/default"
            }),
        );
        handle_ably_message(&job_msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert_eq!(
            pop_direct_candidate(&direct_candidates).await.run_id(),
            job_run_id
        );
        assert!(!signals.hard().is_cancelled());
        drop(transfer_guard);
        tokio::time::timeout(Duration::from_secs(1), cancel_deliveries.next())
            .await
            .expect("queued cancellation should complete after transfer")
            .expect("queued cancellation delivery");

        assert!(signals.hard().is_cancelled());
        assert!(!replacement.is_cancelled());
    }

    #[tokio::test]
    async fn supervisor_shutdown_drops_transfer_blocked_cancel_after_unrelated_progress() {
        let run_id: RunId = "00000000-0000-0000-0000-000000000002".parse().unwrap();
        let job_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
        let tokens = RunCancellationRegistry::new();
        let registration = tokens.register(run_id).await.unwrap();
        let signals = registration.handle().signals();
        let transfer_guard = registration.handle().transfer_guard().await;
        let direct_candidates = direct_candidate_inbox();
        let task_direct_candidates = Arc::clone(&direct_candidates);
        let task_tokens = tokens.clone();
        let (progress_tx, progress_rx) = tokio::sync::oneshot::channel();
        let supervisor = AblySupervisor::spawn_test_task(move |shutdown| async move {
            let cancel_msg = make_message(
                Some("cancel"),
                serde_json::json!({ "runId": run_id, "mode": "hard" }),
            );
            let mut cancel_deliveries = FuturesUnordered::new();
            assert!(
                enqueue_cancel_delivery(&cancel_msg, &task_tokens, &mut cancel_deliveries).await
            );
            assert!(futures_util::poll!(cancel_deliveries.next()).is_pending());

            let wakeups = PollWakeups::new(true);
            let profiles = default_profiles();
            let job_msg = make_message(
                Some("job"),
                serde_json::json!({
                    "runId": job_run_id,
                    "profile": "vm0/default"
                }),
            );
            handle_ably_message(
                &job_msg,
                &profiles,
                &wakeups,
                &task_direct_candidates,
                &task_tokens,
            )
            .await;
            let _ = progress_tx.send(());

            let shutdown_won = tokio::select! {
                () = shutdown.cancelled() => true,
                Some(()) = cancel_deliveries.next() => false,
            };
            assert!(
                shutdown_won,
                "cancellation must remain blocked while the transfer guard is held"
            );
        });

        tokio::time::timeout(Duration::from_secs(1), progress_rx)
            .await
            .expect("unrelated notification should make progress")
            .unwrap();
        assert_eq!(
            pop_direct_candidate(&direct_candidates).await.run_id(),
            job_run_id
        );
        tokio::time::timeout(Duration::from_secs(1), supervisor.shutdown())
            .await
            .expect("supervisor shutdown should drop blocked cancellation delivery");

        assert!(!signals.hard().is_cancelled());
        drop(transfer_guard);
    }

    #[tokio::test]
    async fn broadcast_supported_job_notification_enqueues_direct_candidate() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default",
                "reuseKey": "thread:chat-thread",
                "historyGenerationRunId": "00000000-0000-0000-0000-000000000098",
                "runnerPreference": {
                    "kind": "preference",
                    "runnerIdentity": {
                        "runnerId": "00000000-0000-0000-0000-000000000005",
                        "heartbeatGeneration": 7
                    },
                    "tier": "reusableSandbox",
                    "expiresAt": "2999-01-01T00:00:00.000Z"
                }
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        let candidate = pop_direct_candidate(&direct_candidates).await;
        assert_eq!(
            candidate.run_id().to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
        assert_eq!(candidate.profile_name(), "vm0/default");
        let candidate = candidate.into_job_candidate();
        assert_eq!(candidate.reuse_key(), Some("thread:chat-thread"));
        assert_eq!(
            candidate.history_generation_run_id(),
            Some("00000000-0000-0000-0000-000000000098".parse().unwrap())
        );
        let preference = candidate
            .runner_preference()
            .expect("canonical preference should be parsed");
        assert_eq!(preference.tier(), RunnerPreferenceTier::ReusableSandbox);
        assert!(
            preference.targets(
                crate::runner_process_identity::RunnerProcessIdentity::new(
                    "00000000-0000-0000-0000-000000000005".parse().unwrap(),
                    7,
                )
                .unwrap()
            )
        );
        let telemetry = candidate
            .runner_preference_claim_telemetry()
            .expect("canonical preference telemetry");
        assert!(matches!(
            telemetry.runner_preference,
            RunnerPreference::Preference {
                tier: RunnerPreferenceTier::ReusableSandbox,
                ..
            }
        ));
        assert_eq!(
            telemetry.state,
            Some(super::super::RunnerPreferenceClaimState::Active)
        );
        assert_no_direct_candidate(&direct_candidates).await;
        assert!(!wakeups.snapshot().poll_now);
    }

    #[tokio::test]
    async fn malformed_preference_preserves_direct_candidate() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000011",
                "profile": "vm0/default",
                "reuseKey": "thread:malformed-preference",
                "runnerPreference": {
                    "kind": "preference",
                    "runnerIdentity": {
                        "runnerId": "00000000-0000-0000-0000-000000000005",
                        "heartbeatGeneration": 0
                    },
                    "tier": "workspaceCache",
                    "expiresAt": "2999-01-01T00:00:00.000Z"
                }
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        let candidate = pop_direct_candidate(&direct_candidates)
            .await
            .into_job_candidate();
        assert_eq!(candidate.reuse_key(), Some("thread:malformed-preference"));
        assert!(candidate.runner_preference().is_none());
        assert!(candidate.runner_preference_claim_telemetry().is_none());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn missing_preference_preserves_direct_candidate() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000012",
                "profile": "vm0/default",
                "reuseKey": "thread:missing-preference"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        let candidate = pop_direct_candidate(&direct_candidates)
            .await
            .into_job_candidate();
        assert_eq!(candidate.reuse_key(), Some("thread:missing-preference"));
        assert!(candidate.runner_preference().is_none());
        assert!(candidate.runner_preference_claim_telemetry().is_none());
        assert_no_direct_candidate(&direct_candidates).await;
    }

    #[tokio::test]
    async fn unsupported_profile_job_notification_is_ignored() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/large"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert_no_direct_candidate(&direct_candidates).await;
        let snapshot = wakeups.snapshot();
        assert!(!snapshot.poll_now);
        assert!(snapshot.deferred_poll_at.is_none());
    }

    #[tokio::test]
    async fn empty_profile_support_job_notification_is_ignored() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = Vec::new();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert_no_direct_candidate(&direct_candidates).await;
        let snapshot = wakeups.snapshot();
        assert!(!snapshot.poll_now);
        assert!(snapshot.deferred_poll_at.is_none());
    }

    #[tokio::test]
    async fn missing_profile_job_notification_wakes_poll() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert_no_direct_candidate(&direct_candidates).await;
        assert!(wakeups.snapshot().poll_now);
    }

    #[tokio::test]
    async fn empty_profile_job_notification_wakes_poll() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": ""
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        assert_no_direct_candidate(&direct_candidates).await;
        assert!(wakeups.snapshot().poll_now);
    }

    #[tokio::test]
    async fn full_direct_candidate_queue_wakes_poll_fallback() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox_with_capacity(1);
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000001",
                "profile": "vm0/default"
            }),
        );
        let overflowing_msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000002",
                "profile": "vm0/default"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;
        handle_ably_message(
            &overflowing_msg,
            &profiles,
            &wakeups,
            &direct_candidates,
            &tokens,
        )
        .await;

        let candidate = pop_direct_candidate(&direct_candidates).await;
        assert_eq!(candidate.profile_name(), "vm0/default");
        assert!(wakeups.snapshot().poll_now);
    }

    #[tokio::test]
    async fn stale_full_direct_candidate_queue_prunes_before_enqueueing() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let stale_after = Duration::from_secs(60);
        let direct_candidates = direct_candidate_inbox_with_stale_after(1, stale_after);
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
        let stale_run_id: RunId = "00000000-0000-0000-0000-000000000001".parse().unwrap();
        let _ = direct_candidates
            .push(DirectJobCandidate::new_with_enqueued_at(
                stale_run_id,
                "vm0/default".to_string(),
                stale_enqueued_at,
                stale_enqueued_at,
            ))
            .await;
        let msg = make_message(
            Some("job"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000002",
                "profile": "vm0/default"
            }),
        );

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        let candidate = pop_direct_candidate(&direct_candidates).await;
        assert_eq!(
            candidate.run_id(),
            "00000000-0000-0000-0000-000000000002"
                .parse::<RunId>()
                .unwrap()
        );
        assert!(!wakeups.snapshot().poll_now);
    }

    #[tokio::test]
    async fn invalid_job_notification_does_not_mutate_wakeup_state() {
        let tokens = RunCancellationRegistry::new();
        let wakeups = PollWakeups::new(true);
        let direct_candidates = direct_candidate_inbox();
        let profiles = default_profiles();
        let _ = wakeups
            .wait_for_poll_due(
                &CancellationToken::new(),
                Duration::from_secs(30),
                Duration::from_secs(5),
            )
            .await;
        let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));

        handle_ably_message(&msg, &profiles, &wakeups, &direct_candidates, &tokens).await;

        let snapshot = wakeups.snapshot();
        assert_no_direct_candidate(&direct_candidates).await;
        assert!(!snapshot.poll_now);
        assert!(snapshot.deferred_poll_at.is_none());
    }

    #[tokio::test]
    async fn supervisor_shutdown_awaits_task_termination() {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
            shutdown.cancelled().await;
            let _ = done_tx.send(());
        });

        supervisor.shutdown().await;

        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .expect("supervisor shutdown should await task termination")
            .unwrap();
    }

    #[tokio::test]
    async fn supervisor_drop_cancels_task() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let supervisor = AblySupervisor::spawn_test_task(|shutdown| async move {
            let _ = started_tx.send(());
            shutdown.cancelled().await;
            let _ = done_tx.send(());
        });
        started_rx.await.expect("supervisor test task should start");

        drop(supervisor);

        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .expect("dropping supervisor should cancel the task")
            .unwrap();
    }

    #[test]
    fn parse_connector_runtime_sync_notification_reads_target() {
        let msg = make_message(
            Some("connector-runtime-sync"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000003",
                "target": {
                    "kind": "custom",
                    "customConnectorId": "550e8400-e29b-41d4-a716-446655440000"
                }
            }),
        );

        let notification = parse_connector_runtime_sync_notification(&msg)
            .expect("connector runtime notification should parse");

        assert_eq!(
            notification.run_id.to_string(),
            "00000000-0000-0000-0000-000000000003"
        );
        assert_eq!(
            notification.target,
            ConnectorRuntimeTarget::Custom {
                custom_connector_id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
            }
        );
    }

    #[test]
    fn parse_connector_runtime_sync_notification_rejects_malformed_target() {
        for data in [
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000003"
            }),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000003",
                "target": { "kind": "custom" }
            }),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000003",
                "target": { "kind": "unknown", "connectorSlug": "slack" }
            }),
        ] {
            let msg = make_message(Some("connector-runtime-sync"), data);
            assert!(parse_connector_runtime_sync_notification(&msg).is_none());
        }
    }

    #[test]
    fn parse_active_input_notification_reads_run_id() {
        let msg = make_message(
            Some("active-input"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000004"
            }),
        );

        assert_eq!(
            parse_active_input_notification(&msg)
                .expect("active-input notification should parse")
                .to_string(),
            "00000000-0000-0000-0000-000000000004"
        );
    }

    #[test]
    fn parse_cancel_notification_valid() {
        let msg = make_message(
            Some("cancel"),
            serde_json::json!({
                "runId": "00000000-0000-0000-0000-000000000002",
                "mode": "cooperative"
            }),
        );
        let notification = parse_cancel_notification(&msg).unwrap();
        assert_eq!(
            notification.run_id.to_string(),
            "00000000-0000-0000-0000-000000000002"
        );
        assert_eq!(notification.mode, CancelNotificationMode::Cooperative);
    }
}
