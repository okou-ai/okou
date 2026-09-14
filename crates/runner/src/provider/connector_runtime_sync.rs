//! Connector runtime synchronization for active API-backed runs.
//!
//! Builtin and custom connector targets share one scheduler, bounded
//! queue, generation model, retry policy, and registry publication boundary.
//! The scheduler runs a bounded number of independent runs concurrently while
//! serializing and coalescing work for each run. Realtime notifications advance
//! a target generation and schedule immediate work; API deadlines and retries
//! continue the generation they belong to. Nearby due targets for one run are
//! coalesced and split to the shared API contract limit.
//!
//! A sync response must contain each requested target exactly once. Valid
//! builtin policy and custom firewall updates are prepared independently, then
//! committed through one registry transaction that holds their registration
//! and generations current through the atomic write. Authoritative custom
//! absence removes only that candidate, while unresolved results retain
//! last-known-good state and retry. Transport, validation, queue, and registry
//! publication failures also retain last-known-good state and install a capped,
//! jittered retry. Older queued or in-flight work cannot clear a newer realtime
//! trigger. Every state transition is also scoped to the registration's
//! cancellation token so work from a replaced registration cannot affect its
//! successor when generations reset.
//!
//! A typed terminal-run response removes the entire run from tracking, cancels
//! scheduled work, and fail-closes every still-matching target. Registry writes
//! always re-check source IP and run id so stale work cannot patch a later run
//! that reused the same source IP. A first transport failure is retried once
//! before entering the scheduled retry path.
//!
//! Unregister and shutdown remove active run state, cancel per-run tokens, and
//! abort scheduled task handles. Local publications own their tasks and guards
//! independently of the dispatcher, so cancellation cannot release a transaction
//! while its filesystem replacement is still running. Shutdown drains these
//! tasks; HTTP requests and publication lock waits remain cancellable. Dropping
//! the worker cancels the global token and aborts the dispatcher without aborting
//! an already-started publication.
//!
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use api_contracts::generated::constants::runners::CONNECTOR_RUNTIME_SYNC_TARGETS_MAX;
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::sync::{
    Mutex, mpsc,
    mpsc::error::{TrySendError, TrySendError::Closed, TrySendError::Full},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::instrument::WithSubscriber;
use tracing::{info, warn};

use super::api::{ApiClient, ConnectorRuntimeSyncOutcome};
use crate::error::RunnerError;
use crate::ids::RunId;
use crate::proxy::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimeRegistryUpdate,
    CustomConnectorRuntimeRegistryState, ProxyRegistryHandle,
};
use crate::types::{
    ConnectorRuntimeSyncBatchResponse, ConnectorRuntimeSyncState, ConnectorRuntimeTarget,
    ConnectorRuntimeTargetRegistration, ConnectorRuntimeUnresolvedReason, FirewallEntry,
    NetworkPolicy, NetworkPolicyRefresh,
};

const SYNC_REQUEST_QUEUE_CAPACITY: usize = 256;
const SYNC_REQUEST_SCHEDULER_CAPACITY: usize = SYNC_REQUEST_QUEUE_CAPACITY;
const SYNC_REQUEST_CONCURRENCY: usize = 4;
const CONNECTOR_RUNTIME_SYNC_BATCH_MAX: usize = CONNECTOR_RUNTIME_SYNC_TARGETS_MAX as usize;
const EXPIRED_SYNC_DEADLINE_RETRY_DELAY: Duration = Duration::from_millis(250);
const SCHEDULED_SYNC_COALESCE_WINDOW: Duration = Duration::from_millis(100);
const SYNC_RETRY_INITIAL_DELAY: Duration = Duration::from_secs(1);
const SYNC_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
const SYNC_RETRY_JITTER_MIN_PER_MILLE: u64 = 800;
const SYNC_RETRY_JITTER_SPAN_PER_MILLE: u64 = 201;
const SYNC_RETRY_LOG_TARGET_SAMPLE_MAX: usize = 16;

#[derive(Clone)]
pub(crate) struct ConnectorRuntimeSyncHandle {
    core: ConnectorRuntimeSyncCore,
    worker: Arc<ConnectorRuntimeSyncWorker>,
}

struct ConnectorRuntimeSyncWorker {
    core: ConnectorRuntimeSyncCore,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
struct ConnectorRuntimeSyncCore {
    inner: Arc<ConnectorRuntimeSyncStateStore>,
    request_tx: mpsc::Sender<SyncRequest>,
}

struct ConnectorRuntimeSyncStateStore {
    api: ApiClient,
    active_runs: Mutex<HashMap<RunId, ActiveRunConnectorRuntimeState>>,
    cancel: CancellationToken,
    publications: TaskTracker,
}

struct ActiveRunConnectorRuntimeState {
    source_ip: String,
    registry: ProxyRegistryHandle,
    connectors: HashMap<ConnectorRuntimeTarget, ActiveConnectorSyncState>,
    cancel: CancellationToken,
    sync_tasks: HashMap<ConnectorRuntimeTarget, ScheduledSyncTask>,
    next_sync_task_id: u64,
}

struct ActiveConnectorSyncState {
    registration: ConnectorRuntimeTargetRegistration,
    generation: u64,
    consecutive_failures: u32,
    #[cfg(test)]
    successful_generation: tokio::sync::watch::Sender<Option<u64>>,
}

struct ScheduledSyncTask {
    id: u64,
    generation: u64,
    deadline: tokio::time::Instant,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct ActiveRunConnectorRuntimeSnapshot {
    source_ip: String,
    registry: ProxyRegistryHandle,
}

pub(crate) struct ConnectorRuntimeSyncRegistration<'a> {
    pub(crate) run_id: RunId,
    pub(crate) source_ip: &'a str,
    pub(crate) registry: ProxyRegistryHandle,
    pub(crate) targets: &'a [ConnectorRuntimeTargetRegistration],
    pub(crate) refreshes: Option<&'a HashMap<String, NetworkPolicyRefresh>>,
}

struct SyncRequest {
    run_id: RunId,
    targets: Vec<ConnectorSyncTarget>,
    cancel: CancellationToken,
}

type SyncFuture = Pin<Box<dyn Future<Output = RunId> + Send>>;

struct SyncDispatcher {
    pending: HashMap<RunId, SyncRequest>,
    ready: VecDeque<RunId>,
    ready_runs: HashSet<RunId>,
    in_flight_runs: HashSet<RunId>,
    in_flight: FuturesUnordered<SyncFuture>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConnectorSyncTarget {
    target: ConnectorRuntimeTarget,
    generation: u64,
}

struct PreparedConnectorRuntimePublication {
    target: ConnectorSyncTarget,
    deadline: Option<tokio::time::Instant>,
    update: ConnectorRuntimeRegistryUpdate,
}

#[derive(Default)]
struct SyncRetrySummary {
    scheduled_target_count: usize,
    scheduled_targets: Vec<String>,
    newly_degraded_target_count: usize,
    newly_degraded_targets: Vec<String>,
    already_degraded_target_count: usize,
    already_degraded_targets: Vec<String>,
    min_attempt: Option<u32>,
    max_attempt: Option<u32>,
    min_retry_delay_ms: Option<u64>,
    max_retry_delay_ms: Option<u64>,
}

impl SyncRetrySummary {
    fn record(
        &mut self,
        target: &ConnectorRuntimeTarget,
        attempt: u32,
        delay: Duration,
        newly_degraded: bool,
    ) {
        let identity = target.log_identity();
        Self::record_target(
            &mut self.scheduled_targets,
            &mut self.scheduled_target_count,
            &identity,
        );
        if newly_degraded {
            Self::record_target(
                &mut self.newly_degraded_targets,
                &mut self.newly_degraded_target_count,
                &identity,
            );
        } else {
            Self::record_target(
                &mut self.already_degraded_targets,
                &mut self.already_degraded_target_count,
                &identity,
            );
        }
        self.min_attempt = Some(self.min_attempt.map_or(attempt, |value| value.min(attempt)));
        self.max_attempt = Some(self.max_attempt.map_or(attempt, |value| value.max(attempt)));
        let delay_ms = delay.as_millis() as u64;
        self.min_retry_delay_ms = Some(
            self.min_retry_delay_ms
                .map_or(delay_ms, |value| value.min(delay_ms)),
        );
        self.max_retry_delay_ms = Some(
            self.max_retry_delay_ms
                .map_or(delay_ms, |value| value.max(delay_ms)),
        );
    }

    fn record_target(sample: &mut Vec<String>, count: &mut usize, identity: &str) {
        *count += 1;
        if sample.len() < SYNC_RETRY_LOG_TARGET_SAMPLE_MAX {
            sample.push(identity.to_string());
        }
    }

    fn scheduled_targets_omitted_count(&self) -> usize {
        self.scheduled_target_count - self.scheduled_targets.len()
    }

    fn newly_degraded_targets_omitted_count(&self) -> usize {
        self.newly_degraded_target_count - self.newly_degraded_targets.len()
    }

    fn already_degraded_targets_omitted_count(&self) -> usize {
        self.already_degraded_target_count - self.already_degraded_targets.len()
    }

    fn will_retry(&self) -> bool {
        self.scheduled_target_count > 0
    }
}

macro_rules! emit_sync_retry_event {
    ($emit:ident, $run_id:ident, $summary:ident, $message:literal, $($extra:tt)*) => {
        $emit!(
            run_id = %$run_id,
            $($extra)*
            targets = ?$summary.scheduled_targets,
            targets_omitted_count = $summary.scheduled_targets_omitted_count(),
            scheduled_target_count = $summary.scheduled_target_count,
            newly_degraded_targets = ?$summary.newly_degraded_targets,
            newly_degraded_targets_omitted_count = $summary.newly_degraded_targets_omitted_count(),
            newly_degraded_target_count = $summary.newly_degraded_target_count,
            already_degraded_targets = ?$summary.already_degraded_targets,
            already_degraded_targets_omitted_count = $summary.already_degraded_targets_omitted_count(),
            already_degraded_target_count = $summary.already_degraded_target_count,
            min_attempt = $summary.min_attempt.unwrap_or_default(),
            max_attempt = $summary.max_attempt.unwrap_or_default(),
            min_retry_delay_ms = $summary.min_retry_delay_ms.unwrap_or_default(),
            max_retry_delay_ms = $summary.max_retry_delay_ms.unwrap_or_default(),
            will_retry = $summary.will_retry(),
            $message
        );
    };
}

fn log_sync_retry_summary_info(run_id: RunId, reason: &'static str, summary: &SyncRetrySummary) {
    if summary.will_retry() {
        emit_sync_retry_event!(
            info,
            run_id,
            summary,
            "connector runtime sync retry state updated",
            reason,
        );
    }
}

fn log_connector_runtime_sync_api_failure(
    run_id: RunId,
    error: &RunnerError,
    transport_retry_attempted: bool,
    summary: &SyncRetrySummary,
) {
    match error {
        RunnerError::ApiTransport(api_error) => {
            let request = &api_error.request;
            macro_rules! emit_transport_failure {
                ($emit:ident) => {
                    emit_sync_retry_event!(
                        $emit,
                        run_id,
                        summary,
                        "connector runtime sync failed; retaining last-known-good state",
                        error = %error,
                        endpoint = request.endpoint_label,
                        method = %request.method,
                        host = %request.host,
                        path = %request.path,
                        client_request_id = %request.client_request_id,
                        client_session_id = %request.client_session_id,
                        client_version = %request.client_version,
                        failure_kind = api_error.failure_kind.as_str(),
                        failure_cause = api_error.failure_cause.as_str(),
                        error_summary = %api_error.summary,
                        transport_retry_attempted,
                        reason = "api_error",
                    );
                };
            }
            if summary.newly_degraded_target_count > 0 {
                emit_transport_failure!(warn);
            } else {
                emit_transport_failure!(info);
            }
        }
        RunnerError::ApiStatus(api_error) => {
            emit_sync_retry_event!(
                warn,
                run_id,
                summary,
                "connector runtime sync failed; retaining last-known-good state",
                endpoint = api_error.endpoint_label,
                status = %api_error.status,
                failure_kind = "http_status",
                transport_retry_attempted,
                reason = "api_error",
            );
        }
        _ => {
            emit_sync_retry_event!(
                warn,
                run_id,
                summary,
                "connector runtime sync failed; retaining last-known-good state",
                failure_kind = "response_or_local",
                error_summary = %error,
                transport_retry_attempted,
                reason = "api_error",
            );
        }
    }
}

impl ConnectorRuntimeSyncHandle {
    pub(super) fn new(api: ApiClient) -> Self {
        let (request_tx, request_rx) = mpsc::channel(SYNC_REQUEST_QUEUE_CAPACITY);
        let core = ConnectorRuntimeSyncCore {
            inner: Arc::new(ConnectorRuntimeSyncStateStore {
                api,
                active_runs: Mutex::new(HashMap::new()),
                cancel: CancellationToken::new(),
                publications: TaskTracker::new(),
            }),
            request_tx,
        };
        let worker_task = tokio::spawn(run_sync_dispatcher(core.clone(), request_rx));
        Self {
            core: core.clone(),
            worker: Arc::new(ConnectorRuntimeSyncWorker {
                core,
                task: StdMutex::new(Some(worker_task)),
            }),
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.core.shutdown_active_runs().await;
        let worker_task = self.take_worker_task();
        if let Some(worker_task) = worker_task
            && let Err(error) = worker_task.await
        {
            warn!(error = %error, "connector runtime sync worker failed during shutdown");
        }
        // Joining the dispatcher stops publication admission. Its cancelled
        // waiters do not own the local writes, which must settle before shutdown
        // can report completion and job cleanup can finish unregistering runs.
        self.core.inner.publications.close();
        self.core.inner.publications.wait().await;
    }

    pub(crate) async fn register_run(&self, registration: ConnectorRuntimeSyncRegistration<'_>) {
        self.core.register_run(registration).await;
    }

    pub(crate) async fn unregister_run(&self, run_id: RunId) {
        self.core.unregister_run(run_id).await;
    }

    pub(crate) async fn notify_connector_runtime_sync(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
    ) {
        self.core
            .notify_connector_runtime_sync(run_id, target)
            .await;
    }

    pub(crate) async fn notify_connector_runtime_sync_until_cancelled(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_connector_runtime_sync_until_cancelled(run_id, target, cancel)
            .await;
    }

    fn take_worker_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.worker.take_task()
    }
}

impl ConnectorRuntimeSyncWorker {
    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for ConnectorRuntimeSyncWorker {
    fn drop(&mut self) {
        self.core.inner.cancel.cancel();
        if let Some(worker_task) = self.take_task() {
            worker_task.abort();
        }
    }
}

impl ConnectorRuntimeSyncCore {
    async fn shutdown_active_runs(&self) {
        self.inner.cancel.cancel();
        let old_runs = std::mem::take(&mut *self.inner.active_runs.lock().await);
        for old in old_runs.into_values() {
            old.cancel.cancel();
            abort_tasks(old.sync_tasks.into_values().map(|task| task.handle));
        }
    }

    async fn register_run(&self, registration: ConnectorRuntimeSyncRegistration<'_>) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        let runtime_targets = registration.targets.to_vec();
        if runtime_targets.is_empty() {
            self.unregister_run(registration.run_id).await;
            return;
        }
        let run_cancel = CancellationToken::new();
        let mut old_tasks = Vec::new();
        {
            let mut active_runs = self.inner.active_runs.lock().await;
            if self.inner.cancel.is_cancelled() {
                return;
            }
            if let Some(old) = active_runs.remove(&registration.run_id) {
                old.cancel.cancel();
                old_tasks.extend(old.sync_tasks.into_values().map(|task| task.handle));
            }

            let connectors = runtime_targets
                .iter()
                .map(|registration| {
                    (
                        registration.target(),
                        ActiveConnectorSyncState {
                            registration: registration.clone(),
                            generation: 0,
                            consecutive_failures: 0,
                            #[cfg(test)]
                            successful_generation: tokio::sync::watch::channel(None).0,
                        },
                    )
                })
                .collect();
            active_runs.insert(
                registration.run_id,
                ActiveRunConnectorRuntimeState {
                    source_ip: registration.source_ip.to_string(),
                    registry: registration.registry,
                    connectors,
                    cancel: run_cancel.clone(),
                    sync_tasks: HashMap::new(),
                    next_sync_task_id: 0,
                },
            );
        }
        abort_tasks(old_tasks);

        for target in runtime_targets
            .iter()
            .map(ConnectorRuntimeTargetRegistration::target)
            .filter(|target| matches!(target, ConnectorRuntimeTarget::Custom { .. }))
        {
            self.replace_sync_deadline_for_registration(
                registration.run_id,
                &ConnectorSyncTarget {
                    target,
                    generation: 0,
                },
                Some(tokio::time::Instant::now()),
                &run_cancel,
            )
            .await;
        }

        if let Some(refreshes) = registration.refreshes {
            let mut invalid_targets = Vec::new();
            for (connector_slug, refresh) in refreshes {
                let target = ConnectorSyncTarget {
                    target: ConnectorRuntimeTarget::Builtin {
                        connector_slug: connector_slug.clone(),
                    },
                    generation: 0,
                };
                match parse_sync_deadline(&refresh.next_refresh_at) {
                    Ok(deadline) => {
                        self.replace_sync_deadline_for_registration(
                            registration.run_id,
                            &target,
                            Some(deadline),
                            &run_cancel,
                        )
                        .await;
                    }
                    Err(()) => invalid_targets.push(target),
                }
            }
            let retry_summary = self
                .schedule_sync_retries_for_registration(
                    registration.run_id,
                    &invalid_targets,
                    &run_cancel,
                    "invalid_initial_deadline",
                )
                .await;
            log_sync_retry_summary_info(
                registration.run_id,
                "invalid_initial_deadline",
                &retry_summary,
            );
        }
    }

    async fn unregister_run(&self, run_id: RunId) {
        let _ = self.take_active_run(run_id).await;
    }

    async fn take_active_run(&self, run_id: RunId) -> Option<ActiveRunConnectorRuntimeState> {
        let mut old = self.inner.active_runs.lock().await.remove(&run_id)?;
        old.cancel.cancel();
        abort_tasks(
            std::mem::take(&mut old.sync_tasks)
                .into_values()
                .map(|task| task.handle),
        );
        Some(old)
    }

    async fn take_active_run_if_registration_matches(
        &self,
        run_id: RunId,
        registration_cancel: &CancellationToken,
    ) -> Option<ActiveRunConnectorRuntimeState> {
        // The caller controls cancellation because terminal reconciliation must
        // keep its own request alive until fail-close publication finishes.
        let mut old = {
            let mut active_runs = self.inner.active_runs.lock().await;
            if active_runs
                .get(&run_id)
                .is_none_or(|active| &active.cancel != registration_cancel)
            {
                return None;
            }
            active_runs.remove(&run_id)?
        };
        abort_tasks(
            std::mem::take(&mut old.sync_tasks)
                .into_values()
                .map(|task| task.handle),
        );
        Some(old)
    }

    async fn notify_connector_runtime_sync(&self, run_id: RunId, target: ConnectorRuntimeTarget) {
        self.notify_connector_runtime_sync_inner(run_id, target, None)
            .await;
    }

    async fn notify_connector_runtime_sync_until_cancelled(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: &CancellationToken,
    ) {
        self.notify_connector_runtime_sync_inner(run_id, target, Some(cancel))
            .await;
    }

    async fn notify_connector_runtime_sync_inner(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: Option<&CancellationToken>,
    ) {
        if self.inner.cancel.is_cancelled() || cancel.is_some_and(CancellationToken::is_cancelled) {
            return;
        }
        let mut active_runs = self.inner.active_runs.lock().await;
        if self.inner.cancel.is_cancelled() || cancel.is_some_and(CancellationToken::is_cancelled) {
            return;
        }
        let Some(active) = active_runs.get_mut(&run_id) else {
            return;
        };
        if active.cancel.is_cancelled() {
            return;
        }
        let Some(connector) = active.connectors.get_mut(&target) else {
            return;
        };
        connector.generation += 1;
        let target = ConnectorSyncTarget {
            target,
            generation: connector.generation,
        };
        self.replace_schedule_locked(active, run_id, &target, Some(tokio::time::Instant::now()));
    }

    async fn enqueue_scheduled_sync(&self, request: SyncRequest, cancel: &CancellationToken) {
        if self.inner.cancel.is_cancelled() || cancel.is_cancelled() {
            return;
        }

        if let Err(error) = self.request_tx.try_send(request) {
            self.handle_scheduled_enqueue_error(error).await;
        }
    }

    async fn handle_scheduled_enqueue_error(&self, error: TrySendError<SyncRequest>) {
        match error {
            Full(request) => {
                let requested_target_count = request.targets.len();
                let retry_summary = self
                    .schedule_sync_retries_for_registration(
                        request.run_id,
                        &request.targets,
                        &request.cancel,
                        "queue_full",
                    )
                    .await;
                warn!(
                    run_id = %request.run_id,
                    connector_count = requested_target_count,
                    targets = ?retry_summary.scheduled_targets,
                    targets_omitted_count = retry_summary.scheduled_targets_omitted_count(),
                    scheduled_target_count = retry_summary.scheduled_target_count,
                    "connector runtime sync queue full; retaining last-known-good state"
                );
                log_sync_retry_summary_info(request.run_id, "queue_full", &retry_summary);
            }
            Closed(error) => {
                let targets = target_identities(&error.targets);
                warn!(
                    run_id = %error.run_id,
                    connector_count = error.targets.len(),
                    targets = ?targets,
                    "connector runtime sync queue closed"
                );
            }
        }
    }

    #[cfg(test)]
    async fn sync_builtin_connector_runtime_now(
        &self,
        run_id: RunId,
        connector_slugs: Vec<String>,
    ) {
        let Some(registration_cancel) = self.current_registration_cancel(run_id).await else {
            return;
        };
        let targets = self.current_sync_targets(run_id, connector_slugs).await;
        self.sync_connector_runtime_targets_now(run_id, targets, &registration_cancel)
            .await;
    }

    async fn sync_connector_runtime_targets_now(
        &self,
        run_id: RunId,
        targets: Vec<ConnectorSyncTarget>,
        registration_cancel: &CancellationToken,
    ) {
        let active_targets = self
            .active_sync_targets(run_id, targets, registration_cancel)
            .await;
        if active_targets.is_empty() {
            return;
        }

        for targets in active_targets.chunks(CONNECTOR_RUNTIME_SYNC_BATCH_MAX) {
            let current_targets = self
                .active_sync_targets(run_id, targets.to_vec(), registration_cancel)
                .await;
            if current_targets.is_empty() {
                continue;
            }
            if !self
                .sync_connector_runtime_batch_for_registration(
                    run_id,
                    &current_targets,
                    registration_cancel,
                )
                .await
            {
                return;
            }
        }
    }

    #[cfg(test)]
    async fn sync_connector_runtime_batch_now(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorSyncTarget],
    ) -> bool {
        let Some(registration_cancel) = self.current_registration_cancel(run_id).await else {
            return false;
        };
        self.sync_connector_runtime_batch_for_registration(
            run_id,
            active_targets,
            &registration_cancel,
        )
        .await
    }

    async fn sync_connector_runtime_batch_for_registration(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorSyncTarget],
        registration_cancel: &CancellationToken,
    ) -> bool {
        let current_targets = self
            .current_connector_runtime_sync_targets(run_id, active_targets, registration_cancel)
            .await;
        if current_targets.is_empty() {
            return true;
        }
        let (active_targets, requested_targets): (Vec<_>, Vec<_>) =
            current_targets.into_iter().unzip();
        let mut transport_retry_attempted = false;
        let response = loop {
            let response = self
                .inner
                .api
                .sync_connector_runtime(run_id, &requested_targets)
                .await;
            if !transport_retry_attempted && let Err(RunnerError::ApiTransport(error)) = &response {
                if !self
                    .registration_is_current(run_id, registration_cancel)
                    .await
                {
                    return false;
                }
                transport_retry_attempted = true;
                let request = &error.request;
                info!(
                    run_id = %run_id,
                    targets = ?target_identities(&active_targets),
                    error = %error,
                    endpoint = request.endpoint_label,
                    method = %request.method,
                    host = %request.host,
                    path = %request.path,
                    client_request_id = %request.client_request_id,
                    client_session_id = %request.client_session_id,
                    client_version = %request.client_version,
                    failure_kind = error.failure_kind.as_str(),
                    failure_cause = error.failure_cause.as_str(),
                    error_summary = %error.summary,
                    attempt = 1,
                    max_attempts = 2,
                    will_retry = true,
                    "connector runtime sync transport failed, retrying"
                );
                continue;
            }
            break response;
        };

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                let retry_summary = self
                    .schedule_sync_retries_for_registration(
                        run_id,
                        &active_targets,
                        registration_cancel,
                        "api_error",
                    )
                    .await;
                log_connector_runtime_sync_api_failure(
                    run_id,
                    &error,
                    transport_retry_attempted,
                    &retry_summary,
                );
                return true;
            }
        };

        let core = self.clone();
        let registration_cancel = registration_cancel.clone();
        // Dropping the dispatcher or a per-run waiter must not drop a registry
        // transaction while Tokio's blocking filesystem work can still finish.
        // Only local response processing is owned here; HTTP remains cancellable.
        let publication = self.inner.publications.spawn(
            async move {
                if core.inner.cancel.is_cancelled() || registration_cancel.is_cancelled() {
                    return false;
                }
                match response {
                    ConnectorRuntimeSyncOutcome::Synced(response) => {
                        core.publish_connector_runtime_response(
                            run_id,
                            &active_targets,
                            response,
                            &registration_cancel,
                        )
                        .await
                    }
                    ConnectorRuntimeSyncOutcome::RunTerminal => {
                        core.reconcile_terminal_run(run_id, &registration_cancel)
                            .await;
                        false
                    }
                }
            }
            .with_current_subscriber(),
        );
        match publication.await {
            Ok(keep_syncing) => keep_syncing,
            Err(error) => {
                warn!(run_id = %run_id, error = %error, "connector runtime publication task failed");
                false
            }
        }
    }

    async fn publish_connector_runtime_response(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorSyncTarget],
        response: ConnectorRuntimeSyncBatchResponse,
        registration_cancel: &CancellationToken,
    ) -> bool {
        let requested_targets = active_targets
            .iter()
            .map(|target| target.target.clone())
            .collect::<HashSet<_>>();
        let mut responses_by_target = HashMap::new();
        let mut duplicate_targets = HashSet::new();
        for result in response.results {
            if !requested_targets.contains(&result.target) {
                warn!(
                    run_id = %run_id,
                    target = %result.target.log_identity(),
                    "connector runtime sync returned unexpected target"
                );
                continue;
            }
            let target = result.target.clone();
            if responses_by_target.insert(target.clone(), result).is_some() {
                duplicate_targets.insert(target.clone());
                warn!(
                    run_id = %run_id,
                    target = %target.log_identity(),
                    "connector runtime sync returned duplicate target"
                );
            }
        }

        let mut retry_targets = Vec::new();
        let mut prepared_publications = Vec::new();
        for target in active_targets {
            if duplicate_targets.contains(&target.target) {
                retry_targets.push(target.clone());
                continue;
            }
            let Some(result) = responses_by_target.remove(&target.target) else {
                warn!(
                    run_id = %run_id,
                    target = %target.target.log_identity(),
                    "connector runtime sync response omitted requested target"
                );
                retry_targets.push(target.clone());
                continue;
            };
            let candidate_base_url_vars = match (&target.target, &result.state) {
                (
                    ConnectorRuntimeTarget::Custom { .. },
                    ConnectorRuntimeSyncState::Available { .. },
                ) => match result.base_url_vars.clone() {
                    Some(base_url_vars) => Some(base_url_vars),
                    None => {
                        warn!(
                            run_id = %run_id,
                            target = %target.target.log_identity(),
                            "connector runtime sync omitted required base URL variables"
                        );
                        retry_targets.push(target.clone());
                        continue;
                    }
                },
                _ if result.base_url_vars.is_some() => {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        "connector runtime sync returned base URL variables for an invalid target state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
                _ => None,
            };
            if let ConnectorRuntimeSyncState::Unresolved { reason } = &result.state {
                if !connector_runtime_unresolved_reason_is_valid(&target.target, reason) {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        reason = ?reason,
                        "invalid connector runtime sync result; retaining last-known-good state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
                warn!(
                    run_id = %run_id,
                    target = %target.target.log_identity(),
                    reason = ?reason,
                    "connector runtime sync is unresolved; retaining last-known-good state"
                );
                retry_targets.push(target.clone());
                continue;
            }
            let deadline = match parse_optional_sync_deadline(result.next_sync_at.as_deref()) {
                Ok(deadline) => deadline,
                Err(()) => {
                    retry_targets.push(target.clone());
                    continue;
                }
            };
            if !self
                .target_generation_is_current(run_id, target, registration_cancel)
                .await
            {
                continue;
            }
            if let Some(candidate) = &candidate_base_url_vars {
                let Some(matches_pinned_values) = self
                    .custom_base_url_vars_match(run_id, target, candidate, registration_cancel)
                    .await
                else {
                    continue;
                };
                if !matches_pinned_values {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        "connector runtime sync tried to replace run-pinned base URL variables"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
            }
            let update = match (&target.target, &result.state) {
                (
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeSyncState::Available {
                        network_policy,
                        firewall,
                    },
                ) => {
                    if firewall.is_some() {
                        Err("builtin available result must not include an inline firewall")
                    } else if let Err(error) =
                        validate_connector_runtime_network_policy(network_policy)
                    {
                        Err(error)
                    } else {
                        Ok(ConnectorRuntimeRegistryUpdate::BuiltinAvailable {
                            connector_slug: connector_slug.clone(),
                            network_policy: network_policy.clone(),
                        })
                    }
                }
                (
                    ConnectorRuntimeTarget::Custom {
                        custom_connector_id,
                    },
                    state,
                ) => {
                    let routing_variables =
                        if matches!(state, ConnectorRuntimeSyncState::Available { .. }) {
                            let Some(routing_variables) = self
                                .custom_base_url_vars_for_publication(
                                    run_id,
                                    target,
                                    registration_cancel,
                                )
                                .await
                            else {
                                retry_targets.push(target.clone());
                                continue;
                            };
                            routing_variables
                        } else {
                            HashMap::new()
                        };
                    let Some(expected_source_id) = self
                        .custom_source_id_for_publication(run_id, target, registration_cancel)
                        .await
                    else {
                        retry_targets.push(target.clone());
                        continue;
                    };
                    let registry_state = match custom_connector_runtime_registry_state(
                        custom_connector_id,
                        state,
                        routing_variables,
                        expected_source_id.as_deref(),
                    ) {
                        Ok(state) => state,
                        Err(error) => {
                            warn!(
                                run_id = %run_id,
                                target = %target.target.log_identity(),
                                error,
                                "invalid connector runtime sync result; retaining last-known-good state"
                            );
                            retry_targets.push(target.clone());
                            continue;
                        }
                    };
                    if let ConnectorRuntimeSyncState::Absent { reason } = state {
                        info!(
                            run_id = %run_id,
                            target = %target.target.log_identity(),
                            reason = ?reason,
                            "custom connector runtime target is authoritatively absent"
                        );
                    }
                    Ok(ConnectorRuntimeRegistryUpdate::Custom {
                        custom_connector_id: custom_connector_id.clone(),
                        state: registry_state,
                    })
                }
                (ConnectorRuntimeTarget::Builtin { .. }, _) => {
                    Err("builtin connector runtime result has an invalid state")
                }
            };
            let update = match update {
                Ok(update) => update,
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        error,
                        "invalid connector runtime sync result; retaining last-known-good state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
            };
            prepared_publications.push(PreparedConnectorRuntimePublication {
                target: target.clone(),
                deadline,
                update,
            });
        }

        let Some((snapshot, prepared_publications)) = self
            .current_connector_runtime_publications(
                run_id,
                prepared_publications,
                registration_cancel,
            )
            .await
        else {
            return false;
        };
        if !prepared_publications.is_empty() {
            let transaction = tokio::select! {
                biased;
                () = self.inner.cancel.cancelled() => return false,
                () = registration_cancel.cancelled() => return false,
                transaction = snapshot.registry.connector_runtime_registry_transaction() => transaction,
            };
            let (prepared_publications, publication) = match transaction {
                Ok(transaction) => {
                    // Acquire the registry transaction before active state so notifications can
                    // advance while the registry lock is contended. Holding both through the
                    // write orders every commit against generation and registration changes.
                    let active_runs = self.inner.active_runs.lock().await;
                    if self.inner.cancel.is_cancelled() || registration_cancel.is_cancelled() {
                        return false;
                    }
                    let Some(active) = active_runs.get(&run_id) else {
                        return false;
                    };
                    if &active.cancel != registration_cancel {
                        return false;
                    }
                    let prepared_publications = prepared_publications
                        .into_iter()
                        .filter(|publication| {
                            active
                                .connectors
                                .get(&publication.target.target)
                                .is_some_and(|connector| {
                                    connector.generation == publication.target.generation
                                })
                        })
                        .collect::<Vec<_>>();
                    if prepared_publications.is_empty() {
                        drop(active_runs);
                        drop(transaction);
                        (prepared_publications, Ok(Some(Vec::new())))
                    } else {
                        let updates = prepared_publications
                            .iter()
                            .map(|publication| publication.update.clone())
                            .collect::<Vec<_>>();
                        let publication = transaction
                            .apply_updates_if_run_matches(
                                &snapshot.source_ip,
                                &run_id.to_string(),
                                &updates,
                            )
                            .await;
                        drop(active_runs);
                        (prepared_publications, publication)
                    }
                }
                Err(error) => (prepared_publications, Err(error)),
            };
            match publication {
                Ok(Some(outcomes)) => {
                    for (prepared, published) in prepared_publications.into_iter().zip(outcomes) {
                        if !published {
                            warn!(
                                run_id = %run_id,
                                target = %prepared.target.target.log_identity(),
                                "proxy registry rejected connector runtime target; retaining last-known-good state"
                            );
                            retry_targets.push(prepared.target);
                            continue;
                        }
                        if let Some(recovered_after_failures) = self
                            .complete_successful_sync(
                                run_id,
                                &prepared.target,
                                prepared.deadline,
                                registration_cancel,
                            )
                            .await
                        {
                            if recovered_after_failures == 0 {
                                info!(
                                    run_id = %run_id,
                                    target = %prepared.target.target.log_identity(),
                                    generation = prepared.target.generation,
                                    "synced connector runtime target"
                                );
                            } else {
                                info!(
                                    run_id = %run_id,
                                    target = %prepared.target.target.log_identity(),
                                    generation = prepared.target.generation,
                                    recovered_after_failures,
                                    "recovered connector runtime target"
                                );
                            }
                        }
                    }
                }
                Ok(None) => {
                    if let Some(active) = self
                        .take_active_run_if_registration_matches(run_id, registration_cancel)
                        .await
                    {
                        active.cancel.cancel();
                    }
                    return false;
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        error = %error,
                        target_count = prepared_publications.len(),
                        "failed to publish connector runtime targets; retaining last-known-good state"
                    );
                    retry_targets.extend(
                        prepared_publications
                            .into_iter()
                            .map(|publication| publication.target),
                    );
                }
            }
        }
        let retry_summary = self
            .schedule_sync_retries_for_registration(
                run_id,
                &retry_targets,
                registration_cancel,
                "invalid_or_unpublished_response",
            )
            .await;
        log_sync_retry_summary_info(run_id, "invalid_or_unpublished_response", &retry_summary);
        true
    }

    async fn reconcile_terminal_run(&self, run_id: RunId, registration_cancel: &CancellationToken) {
        let Some(active) = self
            .take_active_run_if_registration_matches(run_id, registration_cancel)
            .await
        else {
            return;
        };
        let cancel = active.cancel.clone();
        let connector_count = active.connectors.len();
        let snapshot = ActiveRunConnectorRuntimeSnapshot {
            source_ip: active.source_ip,
            registry: active.registry,
        };
        let targets = active.connectors.into_keys().collect::<Vec<_>>();
        let transaction = tokio::select! {
            biased;
            () = self.inner.cancel.cancelled() => {
                cancel.cancel();
                return;
            }
            () = registration_cancel.cancelled() => return,
            transaction = snapshot.registry.connector_runtime_registry_transaction() => transaction,
        };
        let publication = match transaction {
            Ok(transaction) => {
                transaction
                    .fail_closed_targets_if_run_matches(
                        &snapshot.source_ip,
                        &run_id.to_string(),
                        &targets,
                    )
                    .await
            }
            Err(error) => Err(error),
        };
        match publication {
            Ok(Some(outcomes)) => {
                for (target, outcome) in targets.iter().zip(outcomes) {
                    if let ConnectorRuntimeFailCloseOutcome::Failed(error) = outcome {
                        warn!(
                            run_id = %run_id,
                            target = %target.log_identity(),
                            error = %error,
                            "failed to close terminal run connector runtime target"
                        );
                    }
                }
            }
            Ok(None) => {}
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    connector_count,
                    error = %error,
                    "failed to close terminal run connector runtime targets"
                );
            }
        }
        cancel.cancel();
        info!(
            run_id = %run_id,
            connector_count,
            "reconciled terminal run network policies"
        );
    }

    #[cfg(test)]
    async fn current_registration_cancel(&self, run_id: RunId) -> Option<CancellationToken> {
        self.inner
            .active_runs
            .lock()
            .await
            .get(&run_id)
            .map(|active| active.cancel.clone())
    }

    async fn registration_is_current(
        &self,
        run_id: RunId,
        registration_cancel: &CancellationToken,
    ) -> bool {
        self.inner
            .active_runs
            .lock()
            .await
            .get(&run_id)
            .is_some_and(|active| &active.cancel == registration_cancel)
    }

    #[cfg(test)]
    async fn current_sync_target(
        &self,
        run_id: RunId,
        connector_slug: &str,
    ) -> Option<ConnectorSyncTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        let runtime_target = ConnectorRuntimeTarget::Builtin {
            connector_slug: connector_slug.to_string(),
        };
        let connector = active.connectors.get(&runtime_target)?;
        Some(ConnectorSyncTarget {
            target: runtime_target,
            generation: connector.generation,
        })
    }

    #[cfg(test)]
    async fn current_sync_targets(
        &self,
        run_id: RunId,
        connector_slugs: Vec<String>,
    ) -> Vec<ConnectorSyncTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        connector_slugs
            .into_iter()
            .filter_map(|connector_slug| {
                if !seen.insert(connector_slug.clone()) {
                    return None;
                }
                let runtime_target = ConnectorRuntimeTarget::Builtin { connector_slug };
                let connector = active.connectors.get(&runtime_target)?;
                Some(ConnectorSyncTarget {
                    target: runtime_target,
                    generation: connector.generation,
                })
            })
            .collect()
    }

    async fn active_sync_targets(
        &self,
        run_id: RunId,
        targets: Vec<ConnectorSyncTarget>,
        registration_cancel: &CancellationToken,
    ) -> Vec<ConnectorSyncTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        if &active.cancel != registration_cancel {
            return Vec::new();
        }
        let mut seen = HashSet::new();
        targets
            .into_iter()
            .filter(|target| {
                active
                    .connectors
                    .get(&target.target)
                    .is_some_and(|connector| connector.generation == target.generation)
                    && seen.insert(target.target.clone())
            })
            .collect()
    }

    async fn current_connector_runtime_sync_targets(
        &self,
        run_id: RunId,
        targets: &[ConnectorSyncTarget],
        registration_cancel: &CancellationToken,
    ) -> Vec<(ConnectorSyncTarget, ConnectorRuntimeTargetRegistration)> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        if &active.cancel != registration_cancel {
            return Vec::new();
        }
        targets
            .iter()
            .filter_map(|target| {
                let connector = active.connectors.get(&target.target)?;
                if connector.generation != target.generation {
                    return None;
                }
                let registration = match &connector.registration {
                    ConnectorRuntimeTargetRegistration::Builtin {
                        connector_slug,
                        source_id,
                        ..
                    } => ConnectorRuntimeTargetRegistration::Builtin {
                        connector_slug: connector_slug.clone(),
                        base_url_vars: None,
                        source_id: source_id.clone(),
                    },
                    ConnectorRuntimeTargetRegistration::Custom { .. } => {
                        connector.registration.clone()
                    }
                };
                Some((target.clone(), registration))
            })
            .collect()
    }

    async fn target_generation_is_current(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        registration_cancel: &CancellationToken,
    ) -> bool {
        let active_runs = self.inner.active_runs.lock().await;
        active_runs.get(&run_id).is_some_and(|active| {
            &active.cancel == registration_cancel
                && active
                    .connectors
                    .get(&target.target)
                    .is_some_and(|connector| connector.generation == target.generation)
        })
    }

    async fn current_connector_runtime_publications(
        &self,
        run_id: RunId,
        publications: Vec<PreparedConnectorRuntimePublication>,
        registration_cancel: &CancellationToken,
    ) -> Option<(
        ActiveRunConnectorRuntimeSnapshot,
        Vec<PreparedConnectorRuntimePublication>,
    )> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        if &active.cancel != registration_cancel {
            return None;
        }
        let current = publications
            .into_iter()
            .filter(|publication| {
                active
                    .connectors
                    .get(&publication.target.target)
                    .is_some_and(|connector| connector.generation == publication.target.generation)
            })
            .collect();
        Some((
            ActiveRunConnectorRuntimeSnapshot {
                source_ip: active.source_ip.clone(),
                registry: active.registry.clone(),
            },
            current,
        ))
    }

    async fn custom_base_url_vars_match(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        candidate: &HashMap<String, String>,
        registration_cancel: &CancellationToken,
    ) -> Option<bool> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        if &active.cancel != registration_cancel {
            return None;
        }
        let connector = active.connectors.get(&target.target)?;
        Some(
            connector
                .registration
                .custom_base_url_vars()
                .is_some_and(|pinned| pinned == candidate),
        )
    }

    async fn custom_base_url_vars_for_publication(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        registration_cancel: &CancellationToken,
    ) -> Option<HashMap<String, String>> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        if &active.cancel != registration_cancel {
            return None;
        }
        let connector = active.connectors.get(&target.target)?;
        if connector.generation != target.generation {
            return None;
        }
        connector.registration.custom_base_url_vars().cloned()
    }

    async fn custom_source_id_for_publication(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        registration_cancel: &CancellationToken,
    ) -> Option<Option<String>> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        if &active.cancel != registration_cancel {
            return None;
        }
        let connector = active.connectors.get(&target.target)?;
        if connector.generation != target.generation {
            return None;
        }
        Some(connector.registration.source_id().map(str::to_string))
    }

    async fn complete_successful_sync(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        deadline: Option<tokio::time::Instant>,
        registration_cancel: &CancellationToken,
    ) -> Option<u32> {
        let mut active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get_mut(&run_id)?;
        if &active.cancel != registration_cancel {
            return None;
        }
        let connector = active.connectors.get_mut(&target.target)?;
        if connector.generation != target.generation {
            return None;
        }
        let recovered_after_failures = connector.consecutive_failures;
        connector.consecutive_failures = 0;
        let completed = self.replace_schedule_locked(active, run_id, target, deadline);
        #[cfg(test)]
        if completed {
            active
                .connectors
                .get(&target.target)
                .expect("completed connector should remain registered")
                .successful_generation
                .send_replace(Some(target.generation));
        }
        completed.then_some(recovered_after_failures)
    }

    async fn schedule_sync_retries_for_registration(
        &self,
        run_id: RunId,
        targets: &[ConnectorSyncTarget],
        registration_cancel: &CancellationToken,
        reason: &'static str,
    ) -> SyncRetrySummary {
        if targets.is_empty() {
            return SyncRetrySummary::default();
        }

        let scheduling_base = tokio::time::Instant::now();
        let mut scheduled = Vec::new();
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return SyncRetrySummary::default();
        };
        if &active.cancel != registration_cancel {
            return SyncRetrySummary::default();
        }

        let mut seen = HashSet::new();
        for target in targets {
            if !seen.insert(&target.target) {
                continue;
            }
            let Some(connector) = active.connectors.get_mut(&target.target) else {
                continue;
            };
            if connector.generation != target.generation {
                continue;
            }
            let newly_degraded = connector.consecutive_failures == 0;
            connector.consecutive_failures = connector.consecutive_failures.saturating_add(1);
            let attempt = connector.consecutive_failures;
            let delay = sync_retry_delay(run_id, attempt);
            let deadline = scheduling_base + delay;
            if self.replace_schedule_locked(active, run_id, target, Some(deadline)) {
                scheduled.push((target.clone(), attempt, delay, newly_degraded));
            }
        }
        drop(active_runs);

        let mut summary = SyncRetrySummary::default();
        for (target, attempt, delay, newly_degraded) in scheduled {
            info!(
                run_id = %run_id,
                target = %target.target.log_identity(),
                generation = target.generation,
                attempt,
                retry_delay_ms = delay.as_millis() as u64,
                will_retry = true,
                reason,
                "retained last-known-good connector runtime state; scheduled sync retry"
            );
            summary.record(&target.target, attempt, delay, newly_degraded);
        }
        summary
    }

    #[cfg(test)]
    async fn replace_sync_deadline_if_current(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        let Some(registration_cancel) = self.current_registration_cancel(run_id).await else {
            return false;
        };
        self.replace_sync_deadline_for_registration(run_id, target, deadline, &registration_cancel)
            .await
    }

    async fn replace_sync_deadline_for_registration(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        deadline: Option<tokio::time::Instant>,
        registration_cancel: &CancellationToken,
    ) -> bool {
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return false;
        };
        if &active.cancel != registration_cancel {
            return false;
        }
        self.replace_schedule_locked(active, run_id, target, deadline)
    }

    fn replace_schedule_locked(
        &self,
        active: &mut ActiveRunConnectorRuntimeState,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        if active
            .connectors
            .get(&target.target)
            .is_none_or(|connector| connector.generation != target.generation)
        {
            return false;
        }

        if let Some(old) = active.sync_tasks.remove(&target.target) {
            old.handle.abort();
        }
        let Some(deadline) = deadline else {
            return true;
        };

        let task_id = active.next_sync_task_id;
        active.next_sync_task_id += 1;
        let cancel = active.cancel.clone();
        let global_cancel = self.inner.cancel.clone();
        let runtime_target = target.target.clone();
        let generation = target.generation;
        let handle = self.clone();
        let task_target = runtime_target.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                () = global_cancel.cancelled() => {}
                () = cancel.cancelled() => {}
                () = tokio::time::sleep_until(deadline) => {
                    if let Some((targets, enqueue_cancel)) = handle
                        .take_due_scheduled_syncs(
                            run_id,
                            &task_target,
                            task_id,
                            &cancel,
                        )
                        .await
                    {
                        handle
                            .enqueue_scheduled_sync(
                                SyncRequest {
                                    run_id,
                                    targets,
                                    cancel: enqueue_cancel.clone(),
                                },
                                &enqueue_cancel,
                            )
                            .await;
                    }
                }
            }
        });
        active.sync_tasks.insert(
            runtime_target,
            ScheduledSyncTask {
                id: task_id,
                generation,
                deadline,
                handle: task,
            },
        );
        true
    }

    async fn take_due_scheduled_syncs(
        &self,
        run_id: RunId,
        target: &ConnectorRuntimeTarget,
        task_id: u64,
        registration_cancel: &CancellationToken,
    ) -> Option<(Vec<ConnectorSyncTarget>, CancellationToken)> {
        let mut handles_to_abort = Vec::new();
        let (targets, cancel) = {
            let mut active_runs = self.inner.active_runs.lock().await;
            let active = active_runs.get_mut(&run_id)?;
            if &active.cancel != registration_cancel {
                return None;
            }
            if active
                .sync_tasks
                .get(target)
                .is_none_or(|task| task.id != task_id)
            {
                return None;
            }

            let coalesce_deadline = tokio::time::Instant::now() + SCHEDULED_SYNC_COALESCE_WINDOW;
            let mut due_targets = active
                .sync_tasks
                .iter()
                .filter(|(_, task)| task.deadline <= coalesce_deadline)
                .map(|(target, _)| target.clone())
                .collect::<Vec<_>>();
            due_targets.sort_by_key(ConnectorRuntimeTarget::log_identity);

            let mut targets = Vec::with_capacity(due_targets.len());
            for due_target in due_targets {
                if let Some(task) = active.sync_tasks.remove(&due_target) {
                    if due_target != *target {
                        handles_to_abort.push(task.handle);
                    }
                    targets.push(ConnectorSyncTarget {
                        target: due_target,
                        generation: task.generation,
                    });
                }
            }

            (targets, active.cancel.clone())
        };

        abort_tasks(handles_to_abort);
        (!targets.is_empty()).then_some((targets, cancel))
    }
}

impl SyncDispatcher {
    fn new() -> Self {
        Self {
            pending: HashMap::new(),
            ready: VecDeque::new(),
            ready_runs: HashSet::new(),
            in_flight_runs: HashSet::new(),
            in_flight: FuturesUnordered::new(),
        }
    }

    fn can_receive(&self) -> bool {
        self.pending.len() + self.in_flight.len() < SYNC_REQUEST_SCHEDULER_CAPACITY
    }

    fn is_idle(&self) -> bool {
        self.pending.is_empty() && self.in_flight.is_empty()
    }

    fn enqueue(&mut self, request: SyncRequest) {
        if request.cancel.is_cancelled() {
            return;
        }
        let run_id = request.run_id;
        match self.pending.get_mut(&run_id) {
            Some(pending) if pending.cancel == request.cancel => {
                merge_sync_requests(pending, request);
            }
            Some(pending) => {
                *pending = request;
            }
            None => {
                self.pending.insert(run_id, request);
            }
        }
        if !self.in_flight_runs.contains(&run_id) && self.ready_runs.insert(run_id) {
            self.ready.push_back(run_id);
        }
    }

    fn start_ready(&mut self, handle: &ConnectorRuntimeSyncCore) {
        while self.in_flight.len() < SYNC_REQUEST_CONCURRENCY {
            let Some(run_id) = self.ready.pop_front() else {
                break;
            };
            self.ready_runs.remove(&run_id);
            let Some(request) = self.pending.remove(&run_id) else {
                continue;
            };
            assert!(
                self.in_flight_runs.insert(run_id),
                "connector runtime sync run must not overlap itself"
            );
            let handle = handle.clone();
            self.in_flight.push(Box::pin(async move {
                let SyncRequest {
                    targets, cancel, ..
                } = request;
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {}
                    () = handle.sync_connector_runtime_targets_now(
                        run_id,
                        targets,
                        &cancel,
                    ) => {}
                }
                run_id
            }));
        }
    }

    fn complete(&mut self, run_id: RunId) {
        assert!(
            self.in_flight_runs.remove(&run_id),
            "completed connector runtime sync should be in flight"
        );
        if self.pending.contains_key(&run_id) && self.ready_runs.insert(run_id) {
            self.ready.push_back(run_id);
        }
    }
}

fn merge_sync_requests(pending: &mut SyncRequest, request: SyncRequest) {
    debug_assert_eq!(pending.run_id, request.run_id);
    let mut targets = pending
        .targets
        .drain(..)
        .map(|target| (target.target.clone(), target))
        .collect::<HashMap<_, _>>();
    for target in request.targets {
        targets.insert(target.target.clone(), target);
    }
    pending.targets = targets.into_values().collect();
    pending
        .targets
        .sort_by_key(|target| target.target.log_identity());
}

async fn run_sync_dispatcher(
    handle: ConnectorRuntimeSyncCore,
    mut request_rx: mpsc::Receiver<SyncRequest>,
) {
    let mut dispatcher = SyncDispatcher::new();
    let mut request_channel_open = true;
    loop {
        dispatcher.start_ready(&handle);
        if !request_channel_open && dispatcher.is_idle() {
            break;
        }
        let can_receive = request_channel_open && dispatcher.can_receive();
        let has_in_flight = !dispatcher.in_flight.is_empty();
        tokio::select! {
            () = handle.inner.cancel.cancelled() => {
                break;
            }
            request = request_rx.recv(), if can_receive => {
                match request {
                    Some(request) => dispatcher.enqueue(request),
                    None => request_channel_open = false,
                }
            }
            completed = dispatcher.in_flight.next(), if has_in_flight => {
                if let Some(run_id) = completed {
                    dispatcher.complete(run_id);
                }
            }
        }
    }
}

fn connector_runtime_unresolved_reason_is_valid(
    target: &ConnectorRuntimeTarget,
    reason: &ConnectorRuntimeUnresolvedReason,
) -> bool {
    match target {
        ConnectorRuntimeTarget::Builtin { .. } => {
            matches!(reason, ConnectorRuntimeUnresolvedReason::Connector)
        }
        ConnectorRuntimeTarget::Custom { .. } => matches!(
            reason,
            ConnectorRuntimeUnresolvedReason::PermissionBundle
                | ConnectorRuntimeUnresolvedReason::RuntimeConfiguration
        ),
    }
}

fn custom_connector_runtime_registry_state(
    custom_connector_id: &str,
    state: &ConnectorRuntimeSyncState,
    routing_variables: HashMap<String, String>,
    expected_source_id: Option<&str>,
) -> Result<CustomConnectorRuntimeRegistryState, &'static str> {
    match state {
        ConnectorRuntimeSyncState::Absent { .. } => Ok(CustomConnectorRuntimeRegistryState::Absent),
        ConnectorRuntimeSyncState::Available {
            network_policy,
            firewall:
                Some(
                    firewall @ FirewallEntry::Inline {
                        firewall: inline_firewall,
                        custom_connector_id: Some(entry_connector_id),
                        source_id,
                    },
                ),
            ..
        } => {
            validate_connector_runtime_network_policy(network_policy)?;
            if entry_connector_id != custom_connector_id {
                return Err("custom available result has a mismatched connector id");
            }
            if source_id.as_deref() != expected_source_id {
                return Err("custom available result has a mismatched connector source");
            }
            inline_firewall
                .validate_for_connector_runtime()
                .map_err(|_| "custom available result has an invalid inline firewall")?;
            Ok(CustomConnectorRuntimeRegistryState::Available {
                firewall: firewall.clone(),
                network_policy: Box::new(network_policy.clone()),
                routing_variables,
            })
        }
        ConnectorRuntimeSyncState::Available { network_policy, .. } => {
            validate_connector_runtime_network_policy(network_policy)?;
            Err("custom available result must include an inline firewall")
        }
        ConnectorRuntimeSyncState::Unresolved { .. } => {
            Err("unresolved custom runtime result reached registry publication")
        }
    }
}

fn validate_connector_runtime_network_policy(policy: &NetworkPolicy) -> Result<(), &'static str> {
    if !matches!(policy.unknown_policy.as_str(), "allow" | "deny" | "ask") {
        return Err("connector runtime network policy has an invalid unknown policy");
    }
    let mut permission_names = HashSet::new();
    for permission_name in policy.allow.iter().chain(&policy.deny).chain(&policy.ask) {
        if permission_name.is_empty() || !permission_names.insert(permission_name) {
            return Err("connector runtime network policy has invalid permission names");
        }
    }
    Ok(())
}

fn parse_optional_sync_deadline(value: Option<&str>) -> Result<Option<tokio::time::Instant>, ()> {
    value.map(parse_sync_deadline).transpose()
}

fn parse_sync_deadline(value: &str) -> Result<tokio::time::Instant, ()> {
    let deadline = match DateTime::parse_from_rfc3339(value) {
        Ok(deadline) => deadline.with_timezone(&Utc),
        Err(error) => {
            warn!(
                next_refresh_at = value,
                error = %error,
                "invalid connector runtime sync deadline"
            );
            return Err(());
        }
    };
    let delay = deadline
        .signed_duration_since(Utc::now())
        .to_std()
        .unwrap_or(EXPIRED_SYNC_DEADLINE_RETRY_DELAY);
    Ok(tokio::time::Instant::now() + delay)
}

fn sync_retry_delay(run_id: RunId, attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let base = SYNC_RETRY_INITIAL_DELAY
        .saturating_mul(1_u32 << exponent)
        .min(SYNC_RETRY_MAX_DELAY);
    let mut hasher = DefaultHasher::new();
    run_id.hash(&mut hasher);
    attempt.hash(&mut hasher);
    let jitter_per_mille =
        SYNC_RETRY_JITTER_MIN_PER_MILLE + hasher.finish() % SYNC_RETRY_JITTER_SPAN_PER_MILLE;
    Duration::from_millis((base.as_millis() as u64).saturating_mul(jitter_per_mille) / 1_000)
}

fn target_identities(targets: &[ConnectorSyncTarget]) -> Vec<String> {
    targets
        .iter()
        .map(|target| target.target.log_identity())
        .collect()
}

fn abort_tasks(tasks: impl IntoIterator<Item = tokio::task::JoinHandle<()>>) {
    for task in tasks {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use httpmock::{Method::POST, MockServer};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::watch;
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    use crate::http::{HttpClient, HttpClientConfig};
    use crate::proxy::{ProxyRegistryHandle, SandboxRegistration};
    use crate::test_fixtures::raw_http::{
        RawHttpAction, RawHttpTestServer, join_raw_http_task, json_response, read_http_request,
    };
    use crate::types::{Firewall, FirewallApi, FirewallAuth, FirewallEntry};

    const SYNC_PUBLICATION_TEST_TIMEOUT: Duration = Duration::from_secs(5);

    struct SuccessfulSyncObserver {
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        generation: u64,
        successful_generation: watch::Receiver<Option<u64>>,
    }

    impl SuccessfulSyncObserver {
        async fn wait(mut self) {
            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, async {
                loop {
                    match *self.successful_generation.borrow_and_update() {
                        Some(generation) if generation == self.generation => return,
                        Some(generation) if generation > self.generation => panic!(
                            "successful sync advanced past generation {} to {generation}",
                            self.generation
                        ),
                        _ => {}
                    }
                    self.successful_generation
                        .changed()
                        .await
                        .unwrap_or_else(|_| {
                            panic!(
                                "registration closed before generation {} completed",
                                self.generation
                            )
                        });
                }
            })
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "{} generation {} for run {} did not publish within {:?}",
                    self.target.log_identity(),
                    self.generation,
                    self.run_id,
                    SYNC_PUBLICATION_TEST_TIMEOUT
                )
            });
        }
    }

    fn api_client_for_url(api_url: String) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "runner-session-test".to_string(),
            })
            .expect("test API URL should be valid"),
            "runner-token".to_string(),
        )
    }

    fn builtin_target(connector_slug: &str) -> ConnectorRuntimeTarget {
        ConnectorRuntimeTarget::Builtin {
            connector_slug: connector_slug.to_string(),
        }
    }

    fn custom_target(custom_connector_id: &str) -> ConnectorRuntimeTarget {
        ConnectorRuntimeTarget::Custom {
            custom_connector_id: custom_connector_id.to_string(),
        }
    }

    fn builtin_runtime_target_registration(
        connector_slug: &str,
    ) -> ConnectorRuntimeTargetRegistration {
        ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: connector_slug.to_string(),
            base_url_vars: None,
            source_id: None,
        }
    }

    fn custom_runtime_target_registration(
        custom_connector_id: &str,
        base_url_vars: HashMap<String, String>,
    ) -> ConnectorRuntimeTargetRegistration {
        ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars,
            source_id: None,
        }
    }

    fn custom_runtime_firewall(custom_connector_id: &str) -> FirewallEntry {
        custom_runtime_firewall_with_source(custom_connector_id, None)
    }

    fn custom_runtime_firewall_with_source(
        custom_connector_id: &str,
        source_id: Option<&str>,
    ) -> FirewallEntry {
        FirewallEntry::Inline {
            firewall: Firewall {
                name: format!("custom_connector_{}", custom_connector_id.replace('-', "")),
                apis: vec![FirewallApi {
                    id: "custom-api:0".to_string(),
                    base: "https://custom.example.test/api/".to_string(),
                    auth: FirewallAuth {
                        headers: HashMap::from([(
                            "Authorization".to_string(),
                            "Bearer ${{ secrets.CUSTOM_TOKEN }}".to_string(),
                        )]),
                        base: None,
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: None,
                }],
            },
            custom_connector_id: Some(custom_connector_id.to_string()),
            source_id: source_id.map(str::to_string),
        }
    }

    #[test]
    fn custom_runtime_source_must_match_registration() {
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let expected_source_id = "550e8400-e29b-41d4-a716-446655440001";
        let firewall =
            custom_runtime_firewall_with_source(custom_connector_id, Some(expected_source_id));
        let state = ConnectorRuntimeSyncState::Available {
            network_policy: NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
            firewall: Some(firewall),
        };

        assert!(
            custom_connector_runtime_registry_state(
                custom_connector_id,
                &state,
                HashMap::new(),
                Some(expected_source_id),
            )
            .is_ok()
        );
        assert!(matches!(
            custom_connector_runtime_registry_state(
                custom_connector_id,
                &state,
                HashMap::new(),
                Some("550e8400-e29b-41d4-a716-446655440002"),
            ),
            Err("custom available result has a mismatched connector source")
        ));
        assert!(matches!(
            custom_connector_runtime_registry_state(
                custom_connector_id,
                &state,
                HashMap::new(),
                None,
            ),
            Err("custom available result has a mismatched connector source")
        ));
        let source_less_state = ConnectorRuntimeSyncState::Available {
            network_policy: NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
            firewall: Some(custom_runtime_firewall(custom_connector_id)),
        };
        assert!(matches!(
            custom_connector_runtime_registry_state(
                custom_connector_id,
                &source_less_state,
                HashMap::new(),
                Some(expected_source_id),
            ),
            Err("custom available result has a mismatched connector source")
        ));
    }

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        api_client_for_url(server.base_url())
    }

    async fn accept_http_request(listener: &TcpListener) -> (tokio::net::TcpStream, String) {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await.unwrap();
        (socket, request)
    }

    fn assert_connector_runtime_sync_request(request: &str, run_id: &RunId) {
        let expected = format!("POST /api/runners/runs/{run_id}/connector-runtime/sync HTTP/1.1");
        assert_eq!(request.lines().next(), Some(expected.as_str()));
        assert!(
            request.ends_with(r#"{"targets":[{"kind":"builtin","connectorSlug":"slack"}]}"#),
            "unexpected connector runtime sync request: {request}"
        );
    }

    fn core_without_worker(
        server: &MockServer,
    ) -> (
        ConnectorRuntimeSyncCore,
        tokio::sync::mpsc::Receiver<SyncRequest>,
    ) {
        let (request_tx, request_rx) = mpsc::channel(SYNC_REQUEST_QUEUE_CAPACITY);
        (
            ConnectorRuntimeSyncCore {
                inner: Arc::new(ConnectorRuntimeSyncStateStore {
                    api: api_client_for_server(server),
                    active_runs: Mutex::new(HashMap::new()),
                    cancel: CancellationToken::new(),
                    publications: TaskTracker::new(),
                }),
                request_tx,
            },
            request_rx,
        )
    }

    async fn recv_sync_request(
        requests: &mut tokio::sync::mpsc::Receiver<SyncRequest>,
    ) -> SyncRequest {
        tokio::time::timeout(Duration::from_secs(1), requests.recv())
            .await
            .expect("sync request should arrive before timeout")
            .expect("runtime sync queue should stay open")
    }

    async fn wait_until_scheduled_sync_task_clears(core: &ConnectorRuntimeSyncCore, run_id: RunId) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| active.sync_tasks.is_empty())
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("scheduled sync task should clear itself before timeout");
    }

    struct ConnectorRuntimeSyncHarness {
        _dir: tempfile::TempDir,
        handle: ConnectorRuntimeSyncHandle,
        registry_path: std::path::PathBuf,
        run_id: RunId,
        source_ip: String,
    }

    impl ConnectorRuntimeSyncHarness {
        async fn new(server: &MockServer, run_id: RunId) -> Self {
            Self::new_with_connectors(server, run_id, &["slack"]).await
        }

        async fn new_with_connectors(
            server: &MockServer,
            run_id: RunId,
            connector_slugs: &[&str],
        ) -> Self {
            Self::new_with_api(api_client_for_server(server), run_id, connector_slugs).await
        }

        async fn new_with_api(api: ApiClient, run_id: RunId, connector_slugs: &[&str]) -> Self {
            let dir = tempfile::tempdir().expect("tempdir should be created");
            let registry_path = dir.path().join("proxy-registry.json");
            tokio::fs::write(&registry_path, br#"{"sandboxes":{},"updatedAt":0}"#)
                .await
                .expect("empty registry should be written");
            let registry =
                ProxyRegistryHandle::new(registry_path.clone(), dir.path().join("registry.lock"));
            let source_ip = "10.200.0.2";
            let connector_slugs = connector_slugs
                .iter()
                .map(|connector_slug| (*connector_slug).to_string())
                .collect::<HashSet<_>>();
            let runtime_targets = connector_slugs
                .iter()
                .map(
                    |connector_slug| ConnectorRuntimeTargetRegistration::Builtin {
                        connector_slug: connector_slug.clone(),
                        base_url_vars: None,
                        source_id: None,
                    },
                )
                .collect::<Vec<_>>();
            let firewalls = connector_slugs
                .iter()
                .map(|connector_slug| FirewallEntry::Builtin {
                    name: connector_slug.clone(),
                    base_url_vars: None,
                    source_id: None,
                })
                .collect::<Vec<_>>();
            let network_policies = connector_slugs
                .iter()
                .map(|connector_slug| {
                    (
                        connector_slug.clone(),
                        NetworkPolicy {
                            allow: vec!["chat:write".to_string()],
                            deny: vec!["files:write".to_string()],
                            ask: vec!["channels:read".to_string()],
                            unknown_policy: "allow".to_string(),
                        },
                    )
                })
                .collect::<HashMap<_, _>>();
            let billable_firewalls = Vec::new();
            let run_id_string = run_id.to_string();
            let network_log_path = dir.path().join("network.jsonl");
            let proxy_log_path = dir.path().join("proxy.log");
            registry
                .register_sandbox(
                    source_ip,
                    &SandboxRegistration {
                        run_id: &run_id_string,
                        cli_agent_type: "codex",
                        sandbox_token: "sandbox-token",
                        network_log_path: &network_log_path,
                        proxy_log_path: &proxy_log_path,
                        firewalls: Some(&firewalls),
                        network_policies: Some(&network_policies),
                        connector_runtime_targets: Some(&runtime_targets),
                        encrypted_secrets: None,
                        secret_connector_map: None,
                        secret_connector_metadata_map: None,
                        vars: None,
                        capture_network_bodies: false,
                        billable_firewalls: &billable_firewalls,
                        model_usage_provider: None,
                    },
                )
                .await
                .expect("sandbox should be registered");

            let handle = ConnectorRuntimeSyncHandle::new(api);
            handle
                .core
                .register_run(ConnectorRuntimeSyncRegistration {
                    run_id,
                    source_ip,
                    registry: registry.clone(),
                    targets: &runtime_targets,
                    refreshes: None,
                })
                .await;

            Self {
                _dir: dir,
                handle,
                registry_path,
                run_id,
                source_ip: source_ip.to_string(),
            }
        }

        async fn sync_slack(&self) {
            self.handle
                .core
                .sync_builtin_connector_runtime_now(self.run_id, vec!["slack".to_string()])
                .await;
        }

        async fn slack_policy(&self) -> serde_json::Value {
            self.policy("slack").await
        }

        async fn policy(&self, connector_slug: &str) -> serde_json::Value {
            let registry_json: serde_json::Value = serde_json::from_str(
                &tokio::fs::read_to_string(&self.registry_path)
                    .await
                    .expect("registry should be readable"),
            )
            .expect("registry should be valid JSON");
            registry_json["sandboxes"][&self.source_ip]["networkPolicies"][connector_slug].clone()
        }

        async fn shutdown(self) {
            self.handle.shutdown().await;
        }
    }

    fn assert_fail_closed_policy(policy: &serde_json::Value) {
        assert_eq!(policy["allow"], json!([]));
        assert_eq!(
            policy["deny"],
            json!(["channels:read", "chat:write", "files:write"])
        );
        assert_eq!(policy["ask"], json!([]));
        assert_eq!(policy["unknownPolicy"], json!("deny"));
    }

    fn assert_last_known_good_policy(policy: &serde_json::Value) {
        assert_eq!(
            policy,
            &json!({
                "allow": ["chat:write"],
                "deny": ["files:write"],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
    }

    async fn assert_retry_scheduled(
        core: &ConnectorRuntimeSyncCore,
        run_id: RunId,
        connector_slug: &str,
        expected_attempt: u32,
    ) {
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active while refresh retries");
        let connector = active
            .connectors
            .get(&ConnectorRuntimeTarget::Builtin {
                connector_slug: connector_slug.to_string(),
            })
            .expect("connector should remain active while refresh retries");
        assert_eq!(connector.consecutive_failures, expected_attempt);
        let task = active
            .sync_tasks
            .get(&ConnectorRuntimeTarget::Builtin {
                connector_slug: connector_slug.to_string(),
            })
            .expect("connector should retain a scheduled sync retry");
        assert_eq!(task.generation, connector.generation);
        assert!(task.deadline > tokio::time::Instant::now());
    }

    async fn assert_retry_scheduled_and_abort(
        core: &ConnectorRuntimeSyncCore,
        run_id: RunId,
        connector_slug: &str,
        expected_attempt: u32,
    ) {
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active while refresh retries");
        let target = builtin_target(connector_slug);
        let connector = active
            .connectors
            .get(&target)
            .expect("connector should remain active while refresh retries");
        assert_eq!(connector.consecutive_failures, expected_attempt);
        let task = active
            .sync_tasks
            .get(&target)
            .expect("connector should retain a scheduled sync retry");
        assert_eq!(task.generation, connector.generation);
        assert!(task.deadline > tokio::time::Instant::now());
        task.handle.abort();
    }

    fn connector_runtime_sync_response(target: serde_json::Value) -> serde_json::Value {
        json!({
            "results": [{
                "target": target,
                "state": "available",
                "networkPolicy": {
                    "allow": ["chat:write", "files:write"],
                    "deny": [],
                    "ask": ["channels:read"],
                    "unknownPolicy": "allow",
                },
            }],
        })
    }

    async fn capture_sync_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let output = future.with_subscriber(subscriber).await;
        (output, captured.entries())
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
    }

    fn captured_events<'a>(events: &'a [CapturedEvent], message: &str) -> Vec<&'a CapturedEvent> {
        events
            .iter()
            .filter(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .collect()
    }

    fn warning_count(events: &[CapturedEvent]) -> usize {
        events
            .iter()
            .filter(|event| event.level == tracing::Level::WARN)
            .count()
    }

    fn assert_connector_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "event={event:#?}");
    }

    fn assert_connector_transport_fields(event: &CapturedEvent, api_url: &str, run_id: RunId) {
        assert_connector_field(event, "endpoint", "connector runtime sync");
        assert_connector_field(event, "method", "POST");
        assert_connector_field(
            event,
            "path",
            &format!("/api/runners/runs/{run_id}/connector-runtime/sync"),
        );
        assert_connector_field(event, "client_session_id", "runner-session-test");
        assert_connector_field(event, "client_version", env!("CARGO_PKG_VERSION"));
        let host = event
            .fields
            .get("host")
            .unwrap_or_else(|| panic!("missing field host; event={event:#?}"));
        assert!(
            host.starts_with("127.0.0.1:"),
            "host should include only host and port; event={event:#?}"
        );
        let failure_kind = event
            .fields
            .get("failure_kind")
            .unwrap_or_else(|| panic!("missing field failure_kind; event={event:#?}"));
        assert!(
            ["timeout", "connect", "request", "body", "unknown"].contains(&failure_kind.as_str()),
            "unexpected failure kind; event={event:#?}"
        );
        let failure_cause = event
            .fields
            .get("failure_cause")
            .unwrap_or_else(|| panic!("missing field failure_cause; event={event:#?}"));
        assert_eq!(failure_cause, "http_incomplete_message", "event={event:#?}");
        let error_summary = event
            .fields
            .get("error_summary")
            .unwrap_or_else(|| panic!("missing field error_summary; event={event:#?}"));
        assert!(!error_summary.is_empty(), "event={event:#?}");
        let client_request_id = event
            .fields
            .get("client_request_id")
            .unwrap_or_else(|| panic!("missing field client_request_id; event={event:#?}"));
        uuid::Uuid::parse_str(client_request_id).expect("client_request_id should be a UUID");

        let event_debug = format!("{event:#?}");
        assert!(
            !event_debug.contains(api_url),
            "event should not include full URL: {event_debug}"
        );
        assert!(
            !event_debug.contains("runner-token") && !event_debug.contains(r#"\"connectorSlug\""#),
            "event should not include bearer token or request body: {event_debug}"
        );
    }

    fn active_run_connector_runtime_state(
        registry: ProxyRegistryHandle,
    ) -> ActiveRunConnectorRuntimeState {
        active_run_connector_runtime_state_with_targets(registry, ["slack"])
    }

    fn active_run_connector_runtime_state_with_targets<I, S>(
        registry: ProxyRegistryHandle,
        connector_slugs: I,
    ) -> ActiveRunConnectorRuntimeState
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        ActiveRunConnectorRuntimeState {
            source_ip: "10.200.0.2".to_string(),
            registry,
            connectors: connector_slugs
                .into_iter()
                .map(|connector_slug| {
                    let registration = ConnectorRuntimeTargetRegistration::Builtin {
                        connector_slug: connector_slug.into(),
                        base_url_vars: None,
                        source_id: None,
                    };
                    (
                        registration.target(),
                        ActiveConnectorSyncState {
                            registration,
                            generation: 0,
                            consecutive_failures: 0,
                            successful_generation: tokio::sync::watch::channel(None).0,
                        },
                    )
                })
                .collect(),
            cancel: CancellationToken::new(),
            sync_tasks: HashMap::new(),
            next_sync_task_id: 0,
        }
    }

    fn sync_request(run_id: RunId, connector_slug: &str) -> SyncRequest {
        SyncRequest {
            run_id,
            targets: vec![ConnectorSyncTarget {
                target: ConnectorRuntimeTarget::Builtin {
                    connector_slug: connector_slug.to_string(),
                },
                generation: 0,
            }],
            cancel: CancellationToken::new(),
        }
    }

    async fn replace_schedule(
        core: &ConnectorRuntimeSyncCore,
        run_id: RunId,
        connector_slug: &str,
        next_refresh_at: &str,
    ) {
        let target = core
            .current_sync_target(run_id, connector_slug)
            .await
            .expect("active connector should have a refresh target");
        let deadline =
            parse_sync_deadline(next_refresh_at).expect("valid refresh deadline should parse");
        assert!(
            core.replace_sync_deadline_if_current(run_id, &target, Some(deadline))
                .await,
            "active connector should accept refresh schedule"
        );
    }

    async fn registered_slack_registry(
        run_id: RunId,
    ) -> (
        tempfile::TempDir,
        ProxyRegistryHandle,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"sandboxes":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let lock_path = dir.path().join("registry.lock");
        let registry = ProxyRegistryHandle::new(registry_path.clone(), lock_path.clone());
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        }];
        let mut network_policies = HashMap::new();
        network_policies.insert(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec!["channels:read".to_string()],
                unknown_policy: "allow".to_string(),
            },
        );
        let run_id_string = run_id.to_string();
        let network_log_path = dir.path().join("network.jsonl");
        let proxy_log_path = dir.path().join("proxy.log");
        let runtime_targets = [ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        }];
        registry
            .register_sandbox(
                "10.200.0.2",
                &SandboxRegistration {
                    run_id: &run_id_string,
                    cli_agent_type: "codex",
                    sandbox_token: "sandbox-token",
                    network_log_path: &network_log_path,
                    proxy_log_path: &proxy_log_path,
                    firewalls: Some(&firewalls),
                    network_policies: Some(&network_policies),
                    connector_runtime_targets: Some(&runtime_targets),
                    encrypted_secrets: None,
                    secret_connector_map: None,
                    secret_connector_metadata_map: None,
                    vars: None,
                    capture_network_bodies: false,
                    billable_firewalls: &[],
                    model_usage_provider: None,
                },
            )
            .await
            .expect("sandbox should be registered");
        (dir, registry, registry_path, lock_path)
    }

    async fn registered_runtime_registry(
        run_id: RunId,
        firewalls: &[FirewallEntry],
        network_policies: &HashMap<String, NetworkPolicy>,
    ) -> (tempfile::TempDir, ProxyRegistryHandle, std::path::PathBuf) {
        let runtime_targets = firewalls
            .iter()
            .filter_map(|firewall| match firewall {
                FirewallEntry::Builtin {
                    name,
                    base_url_vars,
                    source_id,
                } => Some(ConnectorRuntimeTargetRegistration::Builtin {
                    connector_slug: name.clone(),
                    base_url_vars: base_url_vars.clone(),
                    source_id: source_id.clone(),
                }),
                FirewallEntry::Inline {
                    custom_connector_id: Some(custom_connector_id),
                    source_id,
                    ..
                } => Some(ConnectorRuntimeTargetRegistration::Custom {
                    custom_connector_id: custom_connector_id.clone(),
                    base_url_vars: HashMap::new(),
                    source_id: source_id.clone(),
                }),
                FirewallEntry::Inline { .. } => None,
            })
            .collect::<Vec<_>>();
        registered_runtime_registry_with_targets(
            run_id,
            firewalls,
            network_policies,
            &runtime_targets,
        )
        .await
    }

    async fn registered_runtime_registry_with_targets(
        run_id: RunId,
        firewalls: &[FirewallEntry],
        network_policies: &HashMap<String, NetworkPolicy>,
        runtime_targets: &[ConnectorRuntimeTargetRegistration],
    ) -> (tempfile::TempDir, ProxyRegistryHandle, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"sandboxes":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let registry = ProxyRegistryHandle::new(
            registry_path.clone(),
            dir.path().join("proxy-registry.lock"),
        );
        let run_id = run_id.to_string();
        let network_log_path = dir.path().join("network.jsonl");
        let proxy_log_path = dir.path().join("proxy.log");
        let runtime_vars = firewalls
            .iter()
            .filter_map(|firewall| match firewall {
                FirewallEntry::Builtin {
                    base_url_vars: Some(base_url_vars),
                    ..
                } => Some(base_url_vars),
                FirewallEntry::Builtin {
                    base_url_vars: None,
                    ..
                }
                | FirewallEntry::Inline { .. } => None,
            })
            .flat_map(|base_url_vars| base_url_vars.clone())
            .collect::<HashMap<_, _>>();
        registry
            .register_sandbox(
                "10.200.0.2",
                &SandboxRegistration {
                    run_id: &run_id,
                    cli_agent_type: "codex",
                    sandbox_token: "sandbox-token",
                    network_log_path: &network_log_path,
                    proxy_log_path: &proxy_log_path,
                    firewalls: Some(firewalls),
                    network_policies: Some(network_policies),
                    connector_runtime_targets: Some(runtime_targets),
                    encrypted_secrets: None,
                    secret_connector_map: None,
                    secret_connector_metadata_map: None,
                    vars: (!runtime_vars.is_empty()).then_some(&runtime_vars),
                    capture_network_bodies: false,
                    billable_firewalls: &[],
                    model_usage_provider: None,
                },
            )
            .await
            .expect("sandbox should be registered");
        (dir, registry, registry_path)
    }

    async fn register_builtin_runtime(
        core: &ConnectorRuntimeSyncCore,
        run_id: RunId,
        connector_slugs: &[&str],
        update_attempt_tx: Option<tokio::sync::mpsc::UnboundedSender<()>>,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        Vec<ConnectorRuntimeTarget>,
    ) {
        let targets = connector_slugs
            .iter()
            .map(|connector_slug| builtin_target(connector_slug))
            .collect::<Vec<_>>();
        let registrations = connector_slugs
            .iter()
            .map(|connector_slug| builtin_runtime_target_registration(connector_slug))
            .collect::<Vec<_>>();
        let firewalls = connector_slugs
            .iter()
            .map(|connector_slug| FirewallEntry::Builtin {
                name: (*connector_slug).to_string(),
                base_url_vars: None,
                source_id: None,
            })
            .collect::<Vec<_>>();
        let policies = connector_slugs
            .iter()
            .map(|connector_slug| {
                (
                    (*connector_slug).to_string(),
                    NetworkPolicy {
                        allow: vec!["last-known-good".to_string()],
                        deny: vec![],
                        ask: vec![],
                        unknown_policy: "allow".to_string(),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let (dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let lock_path = dir.path().join("proxy-registry.lock");
        let registry = match update_attempt_tx {
            Some(tx) => registry.with_connector_runtime_update_attempt_tx(tx),
            None => registry,
        };
        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: &registrations,
            refreshes: None,
        })
        .await;
        (dir, registry_path, lock_path, targets)
    }

    async fn slack_policy(registry_path: &std::path::Path) -> serde_json::Value {
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"]["slack"].clone()
    }

    async fn wait_until_slack_policy(
        registry_path: &std::path::Path,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let policy = slack_policy(registry_path).await;
                if predicate(&policy) {
                    return policy;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("slack policy should match before timeout")
    }

    async fn observe_current_successful_sync(
        handle: &ConnectorRuntimeSyncHandle,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
    ) -> SuccessfulSyncObserver {
        let active_runs = handle.core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain registered");
        let connector = active
            .connectors
            .get(&target)
            .expect("connector should remain registered");
        SuccessfulSyncObserver {
            run_id,
            target,
            generation: connector.generation,
            successful_generation: connector.successful_generation.subscribe(),
        }
    }

    async fn register_slack_run(
        handle: &ConnectorRuntimeSyncHandle,
        run_id: RunId,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let (dir, registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        let targets = [builtin_runtime_target_registration("slack")];
        handle
            .register_run(ConnectorRuntimeSyncRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                targets: &targets,
                refreshes: None,
            })
            .await;
        (dir, registry_path)
    }

    async fn write_connector_runtime_sync_response(
        socket: &mut tokio::net::TcpStream,
        allow: &[&str],
    ) {
        let body = json!({
            "results": [{
                "target": { "kind": "builtin", "connectorSlug": "slack" },
                "state": "available",
                "networkPolicy": {
                    "allow": allow,
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                },
            }],
        })
        .to_string();
        socket
            .write_all(&json_response("200 OK", &body))
            .await
            .expect("connector runtime sync response should be written");
    }

    async fn write_terminal_connector_runtime_sync_response(socket: &mut tokio::net::TcpStream) {
        let body = json!({
            "error": {
                "code": "RUN_TERMINAL",
                "message": "Run is terminal",
            },
        })
        .to_string();
        socket
            .write_all(&json_response("409 Conflict", &body))
            .await
            .expect("terminal connector runtime response should be written");
    }

    #[tokio::test]
    async fn shutdown_awaits_runtime_sync_worker_task() {
        let server = MockServer::start();
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .expect("connector runtime sync shutdown timed out");

        let worker_task = handle
            .worker
            .task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(worker_task.is_none());
    }

    fn mock_publication_response(server: &MockServer, run_id: RunId, terminal: bool) {
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            if terminal {
                then.status(409).json_body(json!({
                    "error": { "code": "RUN_TERMINAL", "message": "Run is terminal" },
                }));
            } else {
                then.status(200)
                    .json_body(connector_runtime_sync_response(json!({
                        "kind": "builtin", "connectorSlug": "slack",
                    })));
            }
        });
    }

    async fn assert_cancelled_publication_preserves_unregister(
        terminal: bool,
        cancel_caller: bool,
    ) {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        mock_publication_response(&server, run_id, terminal);
        let mut gate =
            crate::host_file::atomic_write_test::AtomicRenameGate::new(&harness.registry_path);
        let caller = if cancel_caller {
            let core = harness.handle.core.clone();
            Some(tokio::spawn(async move {
                core.sync_builtin_connector_runtime_now(run_id, vec!["slack".to_string()])
                    .await;
            }))
        } else {
            harness
                .handle
                .notify_connector_runtime_sync(run_id, builtin_target("slack"))
                .await;
            None
        };
        gate.wait_entered().await;
        if let Some(caller) = caller {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
        }

        // Own the worker join solely to observe cancellation deterministically.
        // Shutdown must still drain publications when its worker was already
        // taken by another caller.
        let worker = harness.handle.take_worker_task().unwrap();
        let shutdown = harness.handle.shutdown();
        tokio::pin!(shutdown);
        let mut shutdown_finished_early = futures_util::poll!(shutdown.as_mut()).is_ready();
        tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, worker)
            .await
            .expect("dispatcher should stop while local publication is gated")
            .unwrap();
        if !shutdown_finished_early {
            shutdown_finished_early = futures_util::poll!(shutdown.as_mut()).is_ready();
        }

        let lock_path = harness._dir.path().join("registry.lock");
        let lock = crate::lock::try_acquire_or_busy(lock_path.clone())
            .await
            .unwrap();
        let publication_holds_lock = matches!(lock, crate::lock::TryLock::Busy);
        drop(lock);
        let registry = ProxyRegistryHandle::new(harness.registry_path.clone(), lock_path);
        let unregister = registry.unregister_sandbox(&harness.source_ip);
        tokio::pin!(unregister);
        let mut unregister_finished = match futures_util::poll!(unregister.as_mut()) {
            std::task::Poll::Ready(result) => {
                result.unwrap();
                true
            }
            std::task::Poll::Pending => false,
        };
        // With broken ownership, let the successor finish before releasing the
        // old replacement to deterministically reproduce the lost unregister.
        if !publication_holds_lock && !unregister_finished {
            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, unregister.as_mut())
                .await
                .unwrap()
                .unwrap();
            unregister_finished = true;
        }
        gate.finish().await;
        if !unregister_finished {
            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, unregister.as_mut())
                .await
                .unwrap()
                .unwrap();
        }
        if !shutdown_finished_early {
            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, shutdown.as_mut())
                .await
                .unwrap();
        }

        let registry_json: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&harness.registry_path).await.unwrap())
                .unwrap();
        assert_eq!(
            registry_json["sandboxes"],
            json!({}),
            "cancelled publication must not restore an unregistered sandbox (terminal={terminal})"
        );
        assert!(publication_holds_lock, "publication must retain its flock");
        assert!(!shutdown_finished_early, "shutdown must drain publication");
    }

    #[tokio::test]
    async fn shutdown_drains_in_flight_registry_publications() {
        for terminal in [false, true] {
            assert_cancelled_publication_preserves_unregister(terminal, false).await;
        }
    }

    #[tokio::test]
    async fn cancelled_sync_caller_retains_in_flight_registry_publications() {
        for terminal in [false, true] {
            assert_cancelled_publication_preserves_unregister(terminal, true).await;
        }
    }

    #[tokio::test]
    async fn shutdown_cancels_publications_waiting_for_registry_lock() {
        for terminal in [false, true] {
            let server = MockServer::start();
            let run_id = RunId::nil();
            let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
            let (attempt_tx, mut attempt_rx) = tokio::sync::mpsc::unbounded_channel();
            let (_dir, registry_path, lock_path, _) =
                register_builtin_runtime(&handle.core, run_id, &["slack"], Some(attempt_tx)).await;
            let before = tokio::fs::read(&registry_path).await.unwrap();
            let guard = crate::lock::acquire(lock_path).await.unwrap();
            mock_publication_response(&server, run_id, terminal);
            handle
                .notify_connector_runtime_sync(run_id, builtin_target("slack"))
                .await;
            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, attempt_rx.recv())
                .await
                .unwrap()
                .expect("publication should attempt the held lock");

            tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, handle.shutdown())
                .await
                .expect("shutdown must not wait for a publication that has not acquired its lock");
            drop(guard);
            assert_eq!(tokio::fs::read(registry_path).await.unwrap(), before);
        }
    }

    #[tokio::test]
    async fn shutdown_cancels_stalled_in_flight_sync() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = ConnectorRuntimeSyncHarness::new_with_api(
            api_client_for_url(api_url),
            run_id,
            &["slack"],
        )
        .await;
        let policy_before_shutdown = harness.slack_policy().await;
        let (request_received_tx, request_received_rx) = tokio::sync::oneshot::channel();
        let (verify_shutdown_tx, verify_shutdown_rx) = tokio::sync::oneshot::channel();
        let mut server_tasks = tokio::task::JoinSet::new();
        server_tasks.spawn(async move {
            let (mut socket, request) = accept_http_request(&listener).await;
            request_received_tx
                .send(())
                .expect("request receiver should remain available");

            if verify_shutdown_rx.await.is_err() {
                let body = connector_runtime_sync_response(json!({
                    "kind": "builtin",
                    "connectorSlug": "slack",
                }))
                .to_string();
                let _ = socket.write_all(&json_response("200 OK", &body)).await;
                return (request, None);
            }

            let mut byte = [0_u8; 1];
            let closed = socket.read(&mut byte).await.unwrap();
            let listener = listener
                .into_std()
                .expect("listener should convert to a nonblocking standard socket");
            let retry_connection_queued = match listener.accept() {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
                Err(error) => panic!("failed to inspect retry connection: {error}"),
            };
            (request, Some((closed, retry_connection_queued)))
        });

        harness
            .handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        tokio::time::timeout(Duration::from_secs(1), request_received_rx)
            .await
            .expect("sync request should reach the server before shutdown")
            .expect("sync request sender should remain available");

        let shutdown = harness.handle.shutdown();
        tokio::pin!(shutdown);
        let shutdown_completed_promptly =
            tokio::time::timeout(Duration::from_secs(1), shutdown.as_mut())
                .await
                .is_ok();
        if shutdown_completed_promptly {
            verify_shutdown_tx
                .send(())
                .expect("server should remain available for shutdown verification");
        } else {
            drop(verify_shutdown_tx);
        }

        let (request, server_verification) =
            tokio::time::timeout(Duration::from_secs(1), server_tasks.join_next())
                .await
                .expect("sync server should finish before timeout")
                .expect("sync server task should be present")
                .expect("sync server task should succeed");
        assert!(server_tasks.is_empty());

        if !shutdown_completed_promptly {
            tokio::time::timeout(Duration::from_secs(1), shutdown.as_mut())
                .await
                .expect("connector runtime sync shutdown cleanup timed out");
            panic!("connector runtime sync shutdown waited for the HTTP request timeout");
        }

        assert_connector_runtime_sync_request(&request, &run_id);
        let (closed, retry_connection_queued) =
            server_verification.expect("server should verify prompt shutdown");
        assert_eq!(closed, 0, "shutdown should drop the in-flight request");
        assert!(
            !retry_connection_queued,
            "shutdown should not retry the cancelled sync request"
        );
        assert!(
            harness
                .handle
                .worker
                .task
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_none(),
            "shutdown should reap the sync worker task"
        );
        assert!(
            harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .is_empty(),
            "shutdown should clear active sync state"
        );
        assert_eq!(
            harness.slack_policy().await,
            policy_before_shutdown,
            "shutdown should not mutate the network policy"
        );
    }

    #[tokio::test]
    async fn stalled_run_does_not_block_or_overlap_other_run() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_a = RunId::from(uuid::Uuid::from_u128(1));
        let run_b = RunId::from(uuid::Uuid::from_u128(2));
        let (_dir_a, registry_a) = register_slack_run(&handle, run_a).await;
        let (_dir_b, registry_b) = register_slack_run(&handle, run_b).await;

        handle
            .notify_connector_runtime_sync(run_a, builtin_target("slack"))
            .await;
        let (mut run_a_socket, run_a_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("run A should reach the API");
        assert_connector_runtime_sync_request(&run_a_request, &run_a);

        handle
            .notify_connector_runtime_sync(run_a, builtin_target("slack"))
            .await;
        handle
            .notify_connector_runtime_sync(run_a, builtin_target("slack"))
            .await;
        let run_a_sync =
            observe_current_successful_sync(&handle, run_a, builtin_target("slack")).await;
        handle
            .notify_connector_runtime_sync(run_b, builtin_target("slack"))
            .await;
        let run_b_sync =
            observe_current_successful_sync(&handle, run_b, builtin_target("slack")).await;

        let (mut run_b_socket, run_b_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("run B should bypass stalled run A");
        assert_connector_runtime_sync_request(&run_b_request, &run_b);
        write_connector_runtime_sync_response(&mut run_b_socket, &["run-b:read"]).await;
        drop(run_b_socket);
        run_b_sync.wait().await;
        let run_b_policy = slack_policy(&registry_b).await;
        assert_eq!(run_b_policy["allow"], json!(["run-b:read"]));
        assert_eq!(run_b_policy["unknownPolicy"], json!("allow"));

        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "run A follow-up must not overlap its stalled request"
        );

        write_connector_runtime_sync_response(&mut run_a_socket, &["stale:read"]).await;
        drop(run_a_socket);
        let (mut run_a_follow_up_socket, run_a_follow_up_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("run A follow-up should start after its first request completes");
        assert_connector_runtime_sync_request(&run_a_follow_up_request, &run_a);
        write_connector_runtime_sync_response(&mut run_a_follow_up_socket, &["new:read"]).await;
        drop(run_a_follow_up_socket);
        run_a_sync.wait().await;
        let run_a_policy = slack_policy(&registry_a).await;
        assert_eq!(run_a_policy["allow"], json!(["new:read"]));
        assert_eq!(run_a_policy["unknownPolicy"], json!("allow"));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn connector_runtime_sync_bounds_independent_run_concurrency() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_ids = (1_u128..=SYNC_REQUEST_CONCURRENCY as u128 + 1)
            .map(|value| RunId::from(uuid::Uuid::from_u128(value)))
            .collect::<Vec<_>>();
        let mut run_state = Vec::new();
        for run_id in &run_ids {
            run_state.push(register_slack_run(&handle, *run_id).await);
            handle
                .notify_connector_runtime_sync(*run_id, builtin_target("slack"))
                .await;
        }

        let mut stalled = Vec::new();
        let mut accepted_runs = HashSet::new();
        for _ in 0..SYNC_REQUEST_CONCURRENCY {
            let (socket, request) =
                tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                    .await
                    .expect("an admitted run should reach the API");
            let run_id = *run_ids
                .iter()
                .find(|run_id| {
                    request.starts_with(&format!(
                        "POST /api/runners/runs/{run_id}/connector-runtime/sync HTTP/1.1"
                    ))
                })
                .expect("request should belong to a registered run");
            assert!(
                accepted_runs.insert(run_id),
                "one run must not consume multiple concurrency slots"
            );
            assert_connector_runtime_sync_request(&request, &run_id);
            stalled.push((socket, request));
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "requests beyond the concurrency cap must wait"
        );

        let (mut released_socket, _released_request) = stalled.remove(0);
        write_connector_runtime_sync_response(&mut released_socket, &["released:read"]).await;
        drop(released_socket);
        let (fifth_socket, fifth_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("a waiting run should start after a slot is released");
        let fifth_run = *run_ids
            .iter()
            .find(|run_id| {
                fifth_request.starts_with(&format!(
                    "POST /api/runners/runs/{run_id}/connector-runtime/sync HTTP/1.1"
                ))
            })
            .expect("fifth request should belong to a registered run");
        assert!(accepted_runs.insert(fifth_run));
        assert_eq!(accepted_runs.len(), run_ids.len());
        assert_connector_runtime_sync_request(&fifth_request, &fifth_run);
        stalled.push((fifth_socket, fifth_request));

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .expect("shutdown should cancel every stalled sync promptly");
        for (mut socket, _) in stalled {
            let mut byte = [0_u8; 1];
            let closed = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
                .await
                .expect("stalled request should close during shutdown")
                .expect("stalled request socket should remain readable");
            assert_eq!(closed, 0, "shutdown should drop every in-flight request");
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "shutdown must not retry cancelled sync requests"
        );
        drop(run_state);
    }

    #[tokio::test]
    async fn reregister_cancels_stalled_sync_before_starting_new_registration() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_id = RunId::nil();
        let (_old_dir, _old_registry) = register_slack_run(&handle, run_id).await;

        handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        let (mut old_socket, old_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("old registration should reach the API");
        assert_connector_runtime_sync_request(&old_request, &run_id);

        handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        let (_new_dir, new_registry) = register_slack_run(&handle, run_id).await;
        handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;

        let mut byte = [0_u8; 1];
        let old_closed = tokio::time::timeout(Duration::from_secs(1), old_socket.read(&mut byte))
            .await
            .expect("re-registration should cancel the old request")
            .expect("old request socket should remain readable");
        assert_eq!(old_closed, 0);

        let (mut new_socket, new_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("new registration should not wait for the old request timeout");
        assert_connector_runtime_sync_request(&new_request, &run_id);
        write_connector_runtime_sync_response(&mut new_socket, &["new-registration:read"]).await;
        drop(new_socket);
        let policy = wait_until_slack_policy(&new_registry, |policy| {
            policy["allow"] == json!(["new-registration:read"])
        })
        .await;
        assert_eq!(policy["unknownPolicy"], json!("allow"));

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn terminal_response_finishes_fail_close_before_cancelling_registration() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        let targets = [builtin_runtime_target_registration("slack")];
        handle
            .register_run(ConnectorRuntimeSyncRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                targets: &targets,
                refreshes: None,
            })
            .await;
        let registry_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");

        handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        let (mut socket, request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("terminal sync should reach the API");
        assert_connector_runtime_sync_request(&request, &run_id);
        write_terminal_connector_runtime_sync_response(&mut socket).await;
        drop(socket);

        tokio::time::timeout(Duration::from_secs(1), async {
            while handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .contains_key(&run_id)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal response should remove active state before fail-close");
        drop(registry_guard);

        let policy = wait_until_slack_policy(&registry_path, |policy| {
            policy["unknownPolicy"] == json!("deny")
        })
        .await;
        assert_fail_closed_policy(&policy);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn stale_registration_response_does_not_publish_into_replacement() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_id = RunId::nil();
        let (_old_dir, _old_registry) = register_slack_run(&handle, run_id).await;
        let old_cancel = handle
            .core
            .current_registration_cancel(run_id)
            .await
            .expect("old registration should remain active");
        let old_targets = handle
            .core
            .current_sync_targets(run_id, vec!["slack".to_string()])
            .await;
        let old_sync = {
            let core = handle.core.clone();
            let registration_cancel = old_cancel.clone();
            tokio::spawn(async move {
                core.sync_connector_runtime_batch_for_registration(
                    run_id,
                    &old_targets,
                    &registration_cancel,
                )
                .await
            })
        };
        let (mut old_socket, old_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("old registration should reach the API");
        assert_connector_runtime_sync_request(&old_request, &run_id);

        let (_new_dir, new_registry) = register_slack_run(&handle, run_id).await;
        write_connector_runtime_sync_response(&mut old_socket, &["stale:read"]).await;
        drop(old_socket);

        assert!(
            !old_sync.await.expect("old sync task should not panic"),
            "old registration response should stop without publishing"
        );
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(new_registry)
                .await
                .expect("replacement registry should be readable"),
        )
        .expect("replacement registry should contain valid JSON");
        assert_last_known_good_policy(
            &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"]["slack"],
        );
        let active_runs = handle.core.inner.active_runs.lock().await;
        let replacement = active_runs
            .get(&run_id)
            .expect("replacement registration should remain active");
        assert_ne!(replacement.cancel, old_cancel);
        assert_eq!(
            replacement.connectors[&builtin_target("slack")].consecutive_failures,
            0
        );
        assert!(replacement.sync_tasks.is_empty());
        drop(active_runs);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn stale_registration_terminal_response_does_not_remove_replacement() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_url(api_url));
        let run_id = RunId::nil();
        let (_old_dir, _old_registry) = register_slack_run(&handle, run_id).await;
        let old_cancel = handle
            .core
            .current_registration_cancel(run_id)
            .await
            .expect("old registration should remain active");
        let old_targets = handle
            .core
            .current_sync_targets(run_id, vec!["slack".to_string()])
            .await;
        let old_sync = {
            let core = handle.core.clone();
            let registration_cancel = old_cancel.clone();
            tokio::spawn(async move {
                core.sync_connector_runtime_batch_for_registration(
                    run_id,
                    &old_targets,
                    &registration_cancel,
                )
                .await
            })
        };
        let (mut old_socket, old_request) =
            tokio::time::timeout(Duration::from_secs(1), accept_http_request(&listener))
                .await
                .expect("old registration should reach the API");
        assert_connector_runtime_sync_request(&old_request, &run_id);

        let (_new_dir, new_registry) = register_slack_run(&handle, run_id).await;
        write_terminal_connector_runtime_sync_response(&mut old_socket).await;
        drop(old_socket);

        assert!(
            !old_sync.await.expect("old sync task should not panic"),
            "old terminal response should stop without removing the replacement"
        );
        let active_runs = handle.core.inner.active_runs.lock().await;
        let replacement = active_runs
            .get(&run_id)
            .expect("replacement registration should remain active");
        assert_ne!(replacement.cancel, old_cancel);
        drop(active_runs);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(new_registry)
                .await
                .expect("replacement registry should be readable"),
        )
        .expect("replacement registry should contain valid JSON");
        assert_last_known_good_policy(
            &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"]["slack"],
        );

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn drop_last_handle_cancels_runtime_sync_worker_task() {
        let server = MockServer::start();
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
        let worker_task = handle
            .take_worker_task()
            .expect("sync worker task should be running");

        drop(handle);

        tokio::time::timeout(Duration::from_secs(1), worker_task)
            .await
            .expect("dropping the last handle should cancel the worker task")
            .expect("worker task should not panic");
    }

    #[tokio::test]
    async fn dropping_concurrent_last_handles_releases_runtime_sync_state() {
        let server = MockServer::start();
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
        let other_handle = handle.clone();
        let weak_state = Arc::downgrade(&handle.core.inner);
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let first_drop = {
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                drop(handle);
            })
        };
        let second_drop = {
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                drop(other_handle);
            })
        };

        barrier.wait().await;
        first_drop
            .await
            .expect("first concurrent drop task should finish");
        second_drop
            .await
            .expect("second concurrent drop task should finish");

        tokio::time::timeout(Duration::from_secs(1), async {
            while weak_state.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("concurrent last handle drops should release sync state");
    }

    #[tokio::test]
    async fn drop_last_handle_releases_runtime_sync_state_with_scheduled_task() {
        let server = MockServer::start();
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
        let weak_state = Arc::downgrade(&handle.core.inner);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "2999-01-01T00:00:00Z".to_string(),
            },
        )]);
        let targets = [builtin_runtime_target_registration("slack")];
        handle
            .core
            .register_run(ConnectorRuntimeSyncRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                targets: &targets,
                refreshes: Some(&refreshes),
            })
            .await;

        drop(handle);

        tokio::time::timeout(Duration::from_secs(1), async {
            while weak_state.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the last handle should release sync state");
    }

    #[tokio::test]
    async fn register_after_shutdown_is_ignored() {
        let server = MockServer::start();
        let handle = ConnectorRuntimeSyncHandle::new(api_client_for_server(&server));
        handle.shutdown().await;
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        let targets = [builtin_runtime_target_registration("slack")];

        handle
            .core
            .register_run(ConnectorRuntimeSyncRegistration {
                run_id: RunId::nil(),
                source_ip: "10.200.0.2",
                registry,
                targets: &targets,
                refreshes: None,
            })
            .await;

        assert!(handle.core.inner.active_runs.lock().await.is_empty());
    }

    #[tokio::test]
    async fn builtin_target_retains_last_known_good_until_runtime_sync_recovers() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let source_id = "550e8400-e29b-41d4-a716-446655440001";
        let registration = ConnectorRuntimeTargetRegistration::Builtin {
            connector_slug: "slack".to_string(),
            base_url_vars: None,
            source_id: Some(source_id.to_string()),
        };
        let sync_target = json!({
            "kind": "builtin",
            "connectorSlug": "slack",
            "sourceId": source_id,
        });
        let unresolved_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [sync_target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "unresolved",
                        "reason": "connector-unavailable",
                    }],
                }));
        });
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: Some(HashMap::from([(
                "workspace".to_string(),
                "acme".to_string(),
            )])),
            source_id: Some(source_id.to_string()),
        }];
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "2999-01-01T00:00:00Z".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: Some(&refreshes),
        })
        .await;

        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(
            core.inner.active_runs.lock().await[&run_id]
                .sync_tasks
                .contains_key(&target)
        );

        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        unresolved_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        assert_eq!(
            active_runs[&run_id].connectors[&target].consecutive_failures,
            1
        );
        assert!(active_runs[&run_id].sync_tasks.contains_key(&target));
        drop(active_runs);

        unresolved_sync.delete_async().await;
        let available_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [sync_target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "networkPolicy": {
                            "allow": ["chat:write", "files:write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                        "nextSyncAt": "2999-01-01T00:00:00Z",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        available_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let sandbox = &registry_json["sandboxes"]["10.200.0.2"];
        assert_eq!(
            sandbox["firewalls"],
            json!([{
                "kind": "builtin",
                "name": "slack",
                "baseUrlVars": {"workspace": "acme"},
                "sourceId": source_id,
            }])
        );
        assert_eq!(
            sandbox["networkPolicies"]["slack"]["allow"],
            json!(["chat:write", "files:write"])
        );
        assert!(sandbox.get("omittedBuiltinFirewalls").is_none());
        let active_runs = core.inner.active_runs.lock().await;
        assert_eq!(
            active_runs[&run_id].connectors[&target].consecutive_failures,
            0
        );
        assert!(active_runs[&run_id].sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn builtin_batch_isolates_invalid_result_identities() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry_path, _lock_path, targets) =
            register_builtin_runtime(&core, run_id, &["slack", "github", "linear"], None).await;
        let unexpected_target = builtin_target("notion");
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": targets }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": targets[0],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                            "nextSyncAt": "2999-01-01T00:00:00Z",
                        },
                        {
                            "target": targets[1],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["first:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": targets[1],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["duplicate:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": unexpected_target,
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["unexpected:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                    ],
                }));
        });
        let active_targets = targets
            .iter()
            .cloned()
            .map(|target| ConnectorSyncTarget {
                target,
                generation: 0,
            })
            .collect::<Vec<_>>();

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &active_targets)
                .await
        );

        runtime_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let policies = &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"];
        assert_eq!(
            policies["slack"]["allow"],
            json!(["chat:write", "files:write"])
        );
        assert_eq!(policies["github"]["allow"], json!(["last-known-good"]));
        assert_eq!(policies["linear"]["allow"], json!(["last-known-good"]));

        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&targets[0]].consecutive_failures, 0);
        assert_eq!(active.connectors[&targets[1]].consecutive_failures, 1);
        assert_eq!(active.connectors[&targets[2]].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&targets[0]));
        assert!(active.sync_tasks.contains_key(&targets[1]));
        assert!(active.sync_tasks.contains_key(&targets[2]));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn batch_keeps_current_target_when_another_generation_is_superseded() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry_path, _lock_path, targets) =
            register_builtin_runtime(&core, run_id, &["slack", "github"], None).await;
        let stale_batch = targets
            .iter()
            .cloned()
            .map(|target| ConnectorSyncTarget {
                target,
                generation: 0,
            })
            .collect::<Vec<_>>();
        let github_target = targets[1].clone();
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [github_target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": github_target,
                        "state": "available",
                        "networkPolicy": {
                            "allow": ["issues:write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                    }],
                }));
        });

        core.notify_connector_runtime_sync(run_id, targets[0].clone())
            .await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &stale_batch)
                .await
        );

        runtime_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        assert_eq!(
            registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"]["github"]["allow"],
            json!(["issues:write"])
        );
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn batch_drops_target_superseded_while_registry_transaction_waits() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (update_attempt_tx, mut update_attempt_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_dir, registry_path, lock_path, targets) =
            register_builtin_runtime(&core, run_id, &["slack", "github"], Some(update_attempt_tx))
                .await;
        let old_batch = targets
            .iter()
            .cloned()
            .map(|target| ConnectorSyncTarget {
                target,
                generation: 0,
            })
            .collect::<Vec<_>>();
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": targets }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": targets[0],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["stale:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": targets[1],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["current:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "deny",
                            },
                        },
                    ],
                }));
        });
        let registry_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");
        let sync_task = tokio::spawn({
            let core = core.clone();
            async move {
                core.sync_connector_runtime_batch_now(run_id, &old_batch)
                    .await
            }
        });

        tokio::time::timeout(SYNC_PUBLICATION_TEST_TIMEOUT, update_attempt_rx.recv())
            .await
            .expect("old publication should reach the registry transaction before timeout")
            .expect("old publication should attempt the registry transaction");
        core.notify_connector_runtime_sync(run_id, targets[0].clone())
            .await;
        drop(registry_guard);

        assert!(
            sync_task
                .await
                .expect("old connector runtime sync task should finish")
        );
        runtime_sync.assert_calls(1);
        let newer_request = recv_sync_request(&mut requests).await;
        assert_eq!(
            newer_request.targets,
            vec![ConnectorSyncTarget {
                target: targets[0].clone(),
                generation: 1,
            }]
        );
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let policies = &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"];
        assert_eq!(policies["slack"]["allow"], json!(["last-known-good"]));
        assert_eq!(policies["github"]["allow"], json!(["current:write"]));
        let active_runs = core.inner.active_runs.lock().await;
        assert_eq!(active_runs[&run_id].connectors[&targets[0]].generation, 1);
        assert_eq!(active_runs[&run_id].connectors[&targets[1]].generation, 0);
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn custom_target_registers_while_absent_and_restores_from_sync() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let registration = custom_runtime_target_registration(custom_connector_id, HashMap::new());
        let absent_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [registration.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "absent",
                        "reason": "connector-unavailable",
                    }],
                }));
        });
        let firewall = custom_runtime_firewall(custom_connector_id);
        let empty_firewalls = Vec::new();
        let empty_policies = HashMap::new();
        let (_dir, registry, registry_path) = registered_runtime_registry_with_targets(
            run_id,
            &empty_firewalls,
            &empty_policies,
            std::slice::from_ref(&registration),
        )
        .await;

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;
        assert_eq!(request.targets[0].target, target);

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );
        absent_sync.assert_calls(1);
        let absent_registry: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        assert_eq!(
            absent_registry["sandboxes"]["10.200.0.2"]["omittedCustomConnectorIds"],
            json!([custom_connector_id])
        );
        assert!(
            !core.inner.active_runs.lock().await[&run_id]
                .sync_tasks
                .contains_key(&target)
        );

        absent_sync.delete_async().await;
        let available_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [registration.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.read"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                        "baseUrlVars": {},
                        "nextSyncAt": "2999-01-01T00:00:00Z",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        available_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let sandbox = &registry_json["sandboxes"]["10.200.0.2"];
        assert_eq!(
            sandbox["firewalls"][0]["customConnectorId"],
            json!(custom_connector_id)
        );
        assert_eq!(
            sandbox["networkPolicies"]["custom_connector_550e8400e29b41d4a716446655440000"]["allow"],
            json!(["custom.read"])
        );
        assert!(sandbox.get("omittedCustomConnectorIds").is_none());
        assert!(
            core.inner.active_runs.lock().await[&run_id]
                .sync_tasks
                .contains_key(&target)
        );
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn custom_target_rejects_builtin_unresolved_reason() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "unresolved",
                        "reason": "connector-unavailable",
                    }],
                }));
        });
        let firewall = custom_runtime_firewall(custom_connector_id);
        let policy_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let policies = HashMap::from([(
            policy_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let firewalls = vec![firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&custom_runtime_target_registration(
                custom_connector_id,
                HashMap::new(),
            )),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        runtime_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn custom_target_forwards_pinned_routing_values_after_wakeup() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let source_id = "550e8400-e29b-41d4-a716-446655440001";
        let target = custom_target(custom_connector_id);
        let base_url_vars = HashMap::from([("subdomain".to_string(), "acme".to_string())]);
        let registration = ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: base_url_vars.clone(),
            source_id: Some(source_id.to_string()),
        };
        let firewall = custom_runtime_firewall_with_source(custom_connector_id, Some(source_id));
        let available_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": base_url_vars,
                        "sourceId": source_id,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.read"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                        "baseUrlVars": base_url_vars,
                    }],
                }));
        });
        let empty_firewalls = Vec::new();
        let empty_policies = HashMap::new();
        let (_dir, registry, registry_path) = registered_runtime_registry_with_targets(
            run_id,
            &empty_firewalls,
            &empty_policies,
            std::slice::from_ref(&registration),
        )
        .await;

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        available_sync.assert_calls(1);
        assert_eq!(
            core.inner.active_runs.lock().await[&run_id].connectors[&target].registration,
            registration
        );
        let registry_after_available = tokio::fs::read(&registry_path).await.unwrap();
        let registry_json: serde_json::Value =
            serde_json::from_slice(&registry_after_available).unwrap();
        assert_eq!(
            registry_json["sandboxes"]["10.200.0.2"]["connectorRoutingVariables"]
                [format!("custom:{custom_connector_id}")],
            json!(base_url_vars)
        );
        assert_eq!(
            registry_json["sandboxes"]["10.200.0.2"]["firewalls"][0]["sourceId"],
            source_id
        );

        available_sync.delete_async().await;
        let unresolved_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": base_url_vars,
                        "sourceId": source_id,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "unresolved",
                        "reason": "runtime-configuration-unavailable",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        unresolved_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_after_available
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].registration, registration);
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn custom_target_rejects_routing_value_replacement() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let pinned_base_url_vars = HashMap::from([("subdomain".to_string(), "acme".to_string())]);
        let replacement_base_url_vars =
            HashMap::from([("subdomain".to_string(), "other".to_string())]);
        let registration = ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: pinned_base_url_vars.clone(),
            source_id: None,
        };
        let firewall = custom_runtime_firewall(custom_connector_id);
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": pinned_base_url_vars,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                        "baseUrlVars": replacement_base_url_vars,
                    }],
                }));
        });
        let initial_firewall = custom_runtime_firewall(custom_connector_id);
        let initial_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let initial_policies = HashMap::from([(
            initial_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let firewalls = vec![initial_firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &initial_policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].registration, registration);
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn invalid_custom_response_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let initial_firewall = custom_runtime_firewall(custom_connector_id);
        let initial_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let initial_policies = HashMap::from([(
            initial_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let invalid_firewall = custom_runtime_firewall("550e8400-e29b-41d4-a716-446655440001");
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": invalid_firewall,
                        "networkPolicy": {
                            "allow": ["custom.write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                    }],
                }));
        });
        let firewalls = vec![initial_firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &initial_policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&custom_runtime_target_registration(
                custom_connector_id,
                HashMap::new(),
            )),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn runtime_sync_http_failure_retains_builtin_last_known_good_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let route = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(404);
        });
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
            source_id: None,
        }];
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&builtin_runtime_target_registration("slack")),
            refreshes: None,
        })
        .await;
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_sync_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        route.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn runtime_sync_http_failure_retains_custom_last_known_good_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let route = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(404);
        });
        let firewall = custom_runtime_firewall(custom_connector_id);
        let firewall_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let firewalls = vec![firewall];
        let policies = HashMap::from([(
            firewall_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&custom_runtime_target_registration(
                custom_connector_id,
                HashMap::new(),
            )),
            refreshes: None,
        })
        .await;
        let request = recv_sync_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        route.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.sync_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn terminal_builtin_keeps_policy_without_matching_firewall() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let terminal_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(409)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }));
        });
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let registration = builtin_runtime_target_registration("slack");
        let (_dir, registry, registry_path) = registered_runtime_registry_with_targets(
            run_id,
            &[],
            &policies,
            std::slice::from_ref(&registration),
        )
        .await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: std::slice::from_ref(&registration),
            refreshes: None,
        })
        .await;
        core.notify_connector_runtime_sync(run_id, target).await;
        let request = recv_sync_request(&mut requests).await;

        assert!(
            !core
                .sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        terminal_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before,
            "builtin terminal reconciliation must keep the existing firewall guard",
        );
        assert!(!core.inner.active_runs.lock().await.contains_key(&run_id));
    }

    #[tokio::test]
    async fn inactive_connector_runtime_notification_is_not_enqueued() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);

        core.notify_connector_runtime_sync(RunId::nil(), builtin_target("slack"))
            .await;

        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn active_connector_runtime_notification_filters_targets_and_schedules_sync() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));

        core.notify_connector_runtime_sync(run_id, builtin_target("github"))
            .await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        core.notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;

        let request = recv_sync_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(
            target_identities(&request.targets),
            vec!["builtin:slack".to_string()]
        );
        assert_eq!(request.targets[0].generation, 1);
    }

    #[tokio::test]
    async fn cancelled_connector_runtime_notification_does_not_wait_for_queue_capacity() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));
        for _ in 0..SYNC_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(sync_request(run_id, "slack"))
                .expect("runtime sync queue should accept request");
        }
        let cancel = CancellationToken::new();
        cancel.cancel();

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_connector_runtime_sync_until_cancelled(
                run_id,
                builtin_target("slack"),
                &cancel,
            ),
        )
        .await
        .expect("cancelled notification should not wait for queue capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, SYNC_REQUEST_QUEUE_CAPACITY);
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id).expect("run should remain active");
        assert_eq!(active.connectors[&builtin_target("slack")].generation, 0);
        assert!(active.sync_tasks.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn full_queue_notification_preserves_policy_and_retries_without_registry_lock() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));
        for _ in 0..SYNC_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(sync_request(run_id, "slack"))
                .expect("runtime sync queue should accept request");
        }
        let lock_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");
        let policy_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before notification");

        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let _subscriber_guard = tracing::subscriber::set_default(subscriber);
        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_connector_runtime_sync(run_id, builtin_target("slack")),
        )
        .await
        .expect("notification should not wait for queue capacity or registry lock");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| {
                        active.connectors[&builtin_target("slack")].consecutive_failures == 1
                            && active.sync_tasks.contains_key(&builtin_target("slack"))
                    })
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue saturation should install a retry");
        let events = captured.entries();

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, SYNC_REQUEST_QUEUE_CAPACITY);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
            policy_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        let warning = captured_event(
            &events,
            "connector runtime sync queue full; retaining last-known-good state",
        );
        assert_eq!(warning.level, tracing::Level::WARN);
        assert_connector_field(warning, "connector_count", "1");
        assert_connector_field(warning, "scheduled_target_count", "1");
        assert_connector_field(warning, "targets", "[\"builtin:slack\"]");
        let retry = captured_event(
            &events,
            "retained last-known-good connector runtime state; scheduled sync retry",
        );
        assert_eq!(retry.level, tracing::Level::INFO);
        assert_connector_field(retry, "reason", "queue_full");
        assert_eq!(
            captured_event(&events, "connector runtime sync retry state updated").level,
            tracing::Level::INFO,
        );
        assert_eq!(warning_count(&events), 1, "events={events:#?}");
        drop(lock_guard);
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_sync_task_clears_itself_after_firing() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_SYNC_DEADLINE_RETRY_DELAY).await;
        let request = recv_sync_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(
            target_identities(&request.targets),
            vec!["builtin:slack".to_string()]
        );
        wait_until_scheduled_sync_task_clears(&core, run_id).await;
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after scheduled sync fires");
        assert!(active.sync_tasks.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_sync_coalesces_due_connectors_for_run() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner.active_runs.lock().await.insert(
            run_id,
            active_run_connector_runtime_state_with_targets(registry, ["slack", "github"]),
        );

        for connector_slug in ["slack", "github"] {
            replace_schedule(&core, run_id, connector_slug, "1970-01-01T00:00:00.000Z").await;
        }
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_SYNC_DEADLINE_RETRY_DELAY).await;
        let request = recv_sync_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(
            target_identities(&request.targets),
            vec!["builtin:github".to_string(), "builtin:slack".to_string()]
        );
        wait_until_scheduled_sync_task_clears(&core, run_id).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn retry_backoff_preserves_same_run_coalescing_and_caps_delay() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner.active_runs.lock().await.insert(
            run_id,
            active_run_connector_runtime_state_with_targets(registry, ["slack", "github"]),
        );
        let targets = core
            .current_sync_targets(run_id, vec!["slack".to_string(), "github".to_string()])
            .await;
        let registration_cancel = core
            .current_registration_cancel(run_id)
            .await
            .expect("test registration should remain active");

        let first_base = tokio::time::Instant::now();
        core.schedule_sync_retries_for_registration(
            run_id,
            &targets,
            &registration_cancel,
            "test_failure",
        )
        .await;
        {
            let active_runs = core.inner.active_runs.lock().await;
            let active = &active_runs[&run_id];
            assert_eq!(
                active.sync_tasks[&builtin_target("slack")].deadline,
                active.sync_tasks[&builtin_target("github")].deadline,
                "same-run connectors at the same attempt should remain coalescible"
            );
            let first_delay = active.sync_tasks[&builtin_target("slack")].deadline - first_base;
            assert!(first_delay >= Duration::from_millis(800));
            assert!(first_delay <= SYNC_RETRY_INITIAL_DELAY);
        }

        let slack_target = targets
            .iter()
            .find(|target| target.target == builtin_target("slack"))
            .expect("slack target should exist")
            .clone();
        for expected_attempt in 2..=7 {
            let scheduling_base = tokio::time::Instant::now();
            core.schedule_sync_retries_for_registration(
                run_id,
                std::slice::from_ref(&slack_target),
                &registration_cancel,
                "test_failure",
            )
            .await;
            let active_runs = core.inner.active_runs.lock().await;
            let active = &active_runs[&run_id];
            assert_eq!(
                active.connectors[&builtin_target("slack")].consecutive_failures,
                expected_attempt
            );
            if expected_attempt >= 6 {
                let delay = active.sync_tasks[&builtin_target("slack")].deadline - scheduling_base;
                assert!(delay >= Duration::from_secs(24));
                assert!(delay <= SYNC_RETRY_MAX_DELAY);
            }
        }

        let distinct_run_delays = (1_u128..=16)
            .map(|value| sync_retry_delay(RunId::from(uuid::Uuid::from_u128(value)), 1))
            .collect::<HashSet<_>>();
        assert!(
            distinct_run_delays.len() > 1,
            "deterministic jitter should spread different runs"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn unregister_cancels_scheduled_sync_before_deadline() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));
        for _ in 0..SYNC_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(sync_request(run_id, "slack"))
                .expect("runtime sync queue should accept request");
        }

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        assert!(
            core.inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_some_and(|active| active.sync_tasks.len() == 1),
            "scheduled task should remain tracked while waiting on the full runtime sync queue"
        );

        core.unregister_run(run_id).await;
        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, SYNC_REQUEST_QUEUE_CAPACITY);
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_sync_full_queue_preserves_policy_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(registry));
        for _ in 0..SYNC_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(sync_request(run_id, "slack"))
                .expect("runtime sync queue should accept request");
        }
        let policy_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before scheduled sync");
        let lock_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        tokio::time::advance(EXPIRED_SYNC_DEADLINE_RETRY_DELAY).await;

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| {
                        active.connectors[&builtin_target("slack")].consecutive_failures == 1
                            && active.sync_tasks.contains_key(&builtin_target("slack"))
                    })
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue saturation should replace the due task with a retry");
        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, SYNC_REQUEST_QUEUE_CAPACITY);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
            policy_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        drop(lock_guard);
    }

    #[tokio::test]
    async fn mismatched_connector_runtime_sync_retains_last_known_good_and_retries() {
        let (_, events) =
            capture_sync_events(assert_mismatched_connector_runtime_sync_retains_last_known_good())
                .await;

        let unexpected =
            captured_event(&events, "connector runtime sync returned unexpected target");
        assert_connector_field(unexpected, "target", "builtin:github");
        assert_connector_field(
            captured_event(
                &events,
                "connector runtime sync response omitted requested target",
            ),
            "target",
            "builtin:slack",
        );
        let retry = captured_event(
            &events,
            "retained last-known-good connector runtime state; scheduled sync retry",
        );
        assert_connector_field(retry, "reason", "invalid_or_unpublished_response");
        assert_eq!(retry.level, tracing::Level::INFO);
        assert_eq!(
            captured_event(&events, "connector runtime sync retry state updated").level,
            tracing::Level::INFO,
        );
        assert_eq!(
            warning_count(&events),
            2,
            "response contract warnings should remain primary: {events:#?}"
        );
    }

    #[tokio::test]
    async fn failed_connector_runtime_sync_retains_last_known_good_and_retries() {
        let (_, events) =
            capture_sync_events(assert_failed_connector_runtime_sync_retains_last_known_good())
                .await;

        let failure = captured_event(
            &events,
            "connector runtime sync failed; retaining last-known-good state",
        );
        assert_eq!(failure.level, tracing::Level::WARN);
        assert_connector_field(failure, "targets", "[\"builtin:slack\"]");
        assert_connector_field(failure, "status", "500 Internal Server Error");
        assert_connector_field(failure, "failure_kind", "http_status");
        assert_connector_field(failure, "scheduled_target_count", "1");
        assert_connector_field(failure, "newly_degraded_target_count", "1");
        let retry = captured_event(
            &events,
            "retained last-known-good connector runtime state; scheduled sync retry",
        );
        assert_connector_field(retry, "reason", "api_error");
        assert_eq!(retry.level, tracing::Level::INFO);
        assert_eq!(warning_count(&events), 1, "events={events:#?}");
        let event_debug = format!("{events:#?}");
        assert!(
            !event_debug.contains("refresh failed")
                && !event_debug.contains("INTERNAL_SERVER_ERROR"),
            "status response body should not be logged: {event_debug}"
        );
    }

    #[tokio::test]
    async fn terminal_connector_runtime_sync_reconciles_entire_run() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let sync_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{ "kind": "builtin", "connectorSlug": "slack" }],
                }));
            then.status(409)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }));
        });
        let (core, _requests) = core_without_worker(&server);
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let custom_firewall = custom_runtime_firewall(custom_connector_id);
        let custom_firewall_name =
            format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let firewalls = vec![
            FirewallEntry::Builtin {
                name: "slack".to_string(),
                base_url_vars: None,
                source_id: None,
            },
            FirewallEntry::Builtin {
                name: "github".to_string(),
                base_url_vars: None,
                source_id: None,
            },
            custom_firewall,
        ];
        let initial_policy = NetworkPolicy {
            allow: vec!["chat:write".to_string()],
            deny: vec!["files:write".to_string()],
            ask: vec!["channels:read".to_string()],
            unknown_policy: "allow".to_string(),
        };
        let policies = HashMap::from([
            ("slack".to_string(), initial_policy.clone()),
            ("github".to_string(), initial_policy.clone()),
            (custom_firewall_name.clone(), initial_policy),
        ]);
        let registrations = vec![
            ConnectorRuntimeTargetRegistration::Builtin {
                connector_slug: "slack".to_string(),
                base_url_vars: None,
                source_id: None,
            },
            ConnectorRuntimeTargetRegistration::Builtin {
                connector_slug: "github".to_string(),
                base_url_vars: None,
                source_id: None,
            },
            ConnectorRuntimeTargetRegistration::Custom {
                custom_connector_id: custom_connector_id.to_string(),
                base_url_vars: HashMap::new(),
                source_id: None,
            },
        ];
        let (_dir, registry, registry_path) =
            registered_runtime_registry_with_targets(run_id, &firewalls, &policies, &registrations)
                .await;
        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: &registrations,
            refreshes: None,
        })
        .await;
        let github_target = core
            .current_sync_target(run_id, "github")
            .await
            .expect("active connector should have a refresh target");
        assert!(
            core.replace_sync_deadline_if_current(
                run_id,
                &github_target,
                Some(
                    parse_sync_deadline("2999-01-01T00:00:00.000Z")
                        .expect("valid refresh deadline should parse"),
                )
            )
            .await,
            "active connector should accept refresh schedule"
        );
        let scheduled_task = {
            let active_runs = core.inner.active_runs.lock().await;
            active_runs[&run_id].sync_tasks[&builtin_target("github")]
                .handle
                .abort_handle()
        };
        let slack_target = core
            .current_sync_target(run_id, "slack")
            .await
            .expect("active connector should have a refresh target");

        let (continued, events) = capture_sync_events(
            core.sync_connector_runtime_batch_now(run_id, std::slice::from_ref(&slack_target)),
        )
        .await;

        assert!(!continued);
        sync_mock.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
        )
        .expect("registry should remain valid JSON");
        let network_policies = &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"];
        assert_fail_closed_policy(&network_policies["slack"]);
        assert_fail_closed_policy(&network_policies["github"]);
        assert_fail_closed_policy(&network_policies[&custom_firewall_name]);
        assert!(!core.inner.active_runs.lock().await.contains_key(&run_id));
        let batch_events = events
            .iter()
            .filter(|event| {
                event.fields.get("message").is_some_and(|message| {
                    message == "failed closed connector runtime targets in proxy registry"
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            batch_events.len(),
            1,
            "terminal reconciliation should persist one target batch"
        );
        assert_connector_field(batch_events[0], "target_count", "3");
        assert_connector_field(batch_events[0], "applied_count", "3");
        assert_connector_field(batch_events[0], "failed_count", "0");
        assert!(
            events.iter().all(|event| {
                event
                    .fields
                    .get("message")
                    .is_none_or(|message| message != "connector runtime sync failed")
            }),
            "terminal reconciliation should not emit the generic failure warning"
        );
        assert_eq!(
            captured_event(&events, "reconciled terminal run network policies").level,
            tracing::Level::INFO
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while !scheduled_task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal reconciliation should stop scheduled sync tasks");

        core.notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        tokio::task::yield_now().await;
        sync_mock.assert_calls(1);
    }

    #[tokio::test]
    async fn ambiguous_connector_runtime_sync_errors_retain_last_known_good() {
        for (status, body) in [
            (
                404_u16,
                json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }),
            ),
            (
                403_u16,
                json!({
                    "error": {
                        "code": "FORBIDDEN",
                        "message": "Run does not belong to user",
                    },
                }),
            ),
            (
                409_u16,
                json!({
                    "error": {
                        "code": "CONFLICT",
                        "message": "unrelated conflict",
                    },
                }),
            ),
            (
                409_u16,
                json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                    },
                }),
            ),
        ] {
            let server = MockServer::start();
            let run_id = RunId::nil();
            let sync_mock = server.mock(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
                then.status(status)
                    .header("content-type", "application/json")
                    .json_body(body);
            });
            let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;

            harness.sync_slack().await;

            sync_mock.assert_calls(1);
            assert_last_known_good_policy(&harness.slack_policy().await);
            assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
            assert!(
                harness
                    .handle
                    .core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .contains_key(&run_id)
            );
            harness.shutdown().await;
        }
    }

    #[tokio::test]
    async fn newer_notification_survives_older_in_flight_sync() {
        let run_id = RunId::nil();
        let first_body = json!({
            "results": [{
                "target": { "kind": "builtin", "connectorSlug": "slack" },
                "state": "available",
                "networkPolicy": {
                    "allow": ["old:read"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                },
            }],
        })
        .to_string();
        let second_body = json!({
            "results": [{
                "target": { "kind": "builtin", "connectorSlug": "slack" },
                "state": "available",
                "networkPolicy": {
                    "allow": ["new:read"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                },
            }],
        })
        .to_string();
        let (release_first_tx, release_first_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::WaitThenRespond {
                release: release_first_rx,
                response: json_response("200 OK", &first_body),
            },
            RawHttpAction::Respond(json_response("200 OK", &second_body)),
        ])
        .await;
        let harness = ConnectorRuntimeSyncHarness::new_with_api(
            api_client_for_url(server.url()),
            run_id,
            &["slack"],
        )
        .await;

        harness
            .handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        server.next_request("older generation sync request").await;

        harness
            .handle
            .notify_connector_runtime_sync(run_id, builtin_target("slack"))
            .await;
        assert_eq!(
            harness.handle.core.inner.active_runs.lock().await[&run_id].connectors
                [&builtin_target("slack")]
                .generation,
            2
        );
        release_first_tx
            .send(())
            .expect("first response receiver should remain available");

        let policy = wait_until_slack_policy(&harness.registry_path, |policy| {
            policy["allow"] == json!(["new:read"])
        })
        .await;
        assert_eq!(policy["unknownPolicy"], json!("allow"));
        let requests = server.assert_finished_with_requests().await;
        for request in &requests {
            assert_connector_runtime_sync_request(request, &run_id);
        }
        let active_runs = harness.handle.core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after newer refresh");
        assert_eq!(active.connectors[&builtin_target("slack")].generation, 2);
        assert_eq!(
            active.connectors[&builtin_target("slack")].consecutive_failures,
            0
        );
        assert!(!active.sync_tasks.contains_key(&builtin_target("slack")));
        drop(active_runs);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn transport_connector_runtime_sync_error_retries_and_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = ConnectorRuntimeSyncHarness::new_with_api(
            api_client_for_url(api_url.clone()),
            run_id,
            &["slack"],
        )
        .await;
        let registry_path = harness.registry_path.clone();
        let source_ip = harness.source_ip.clone();
        let response_body = json!({
            "results": [{
                "target": { "kind": "builtin", "connectorSlug": "slack" },
                "state": "available",
                "networkPolicy": {
                    "allow": ["chat:write", "files:write"],
                    "deny": [],
                    "ask": ["channels:read"],
                    "unknownPolicy": "allow",
                },
                "nextSyncAt": "2999-01-01T00:00:00.000Z",
            }],
        })
        .to_string();
        let server_task = tokio::spawn(async move {
            let (first_socket, first_request) = accept_http_request(&listener).await;
            drop(first_socket);

            let (mut second_socket, second_request) = accept_http_request(&listener).await;
            let registry_json: serde_json::Value = serde_json::from_str(
                &tokio::fs::read_to_string(&registry_path)
                    .await
                    .expect("registry should be readable before retry response"),
            )
            .expect("registry should be valid JSON before retry response");
            let policy_before_retry_response =
                registry_json["sandboxes"][&source_ip]["networkPolicies"]["slack"].clone();
            second_socket
                .write_all(&json_response("200 OK", &response_body))
                .await
                .unwrap();
            (first_request, second_request, policy_before_retry_response)
        });

        let (_, events) = tokio::time::timeout(
            Duration::from_secs(1),
            capture_sync_events(harness.sync_slack()),
        )
        .await
        .expect("connector runtime sync retry should complete");
        let (first_request, second_request, policy_before_retry_response) =
            join_raw_http_task(server_task, "connector runtime sync retry server").await;

        assert_connector_runtime_sync_request(&first_request, &run_id);
        assert_connector_runtime_sync_request(&second_request, &run_id);
        assert_eq!(
            policy_before_retry_response,
            json!({
                "allow": ["chat:write"],
                "deny": ["files:write"],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        assert_eq!(
            harness.slack_policy().await,
            json!({
                "allow": ["chat:write", "files:write"],
                "deny": [],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        assert!(
            harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_some_and(|active| active.sync_tasks.contains_key(&builtin_target("slack"))),
            "successful retry should install the returned refresh schedule"
        );
        let retry = captured_event(&events, "connector runtime sync transport failed, retrying");
        assert_connector_field(retry, "targets", "[\"builtin:slack\"]");
        assert_connector_field(retry, "attempt", "1");
        assert_connector_field(retry, "max_attempts", "2");
        assert_connector_field(retry, "will_retry", "true");
        assert_connector_transport_fields(retry, &api_url, run_id);
        assert_eq!(retry.level, tracing::Level::INFO, "event={retry:#?}");
        assert_eq!(
            warning_count(&events),
            0,
            "an immediately recovered transport failure should stay local: {events:#?}"
        );
        for message in [
            "connector runtime sync failed; retaining last-known-good state",
            "retained last-known-good connector runtime state; scheduled sync retry",
        ] {
            assert!(
                events.iter().all(|event| {
                    event
                        .fields
                        .get("message")
                        .is_none_or(|actual| actual != message)
                }),
                "successful retry should not emit {message}: {events:#?}"
            );
        }
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn persistent_transport_failure_warns_once_per_recovery_episode() {
        let run_id = RunId::nil();
        let response_body = connector_runtime_sync_response(json!({
            "kind": "builtin",
            "connectorSlug": "slack",
        }))
        .to_string();
        let server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Disconnect,
            RawHttpAction::Disconnect,
            RawHttpAction::Disconnect,
            RawHttpAction::Disconnect,
            RawHttpAction::Respond(json_response("200 OK", &response_body)),
            RawHttpAction::Disconnect,
            RawHttpAction::Disconnect,
        ])
        .await;
        let api_url = server.url();
        let harness = ConnectorRuntimeSyncHarness::new_with_api(
            api_client_for_url(api_url.clone()),
            run_id,
            &["slack"],
        )
        .await;

        let (_, events) = tokio::time::timeout(
            Duration::from_secs(2),
            capture_sync_events(async {
                harness.sync_slack().await;
                assert_retry_scheduled_and_abort(&harness.handle.core, run_id, "slack", 1).await;

                harness.sync_slack().await;
                assert_retry_scheduled_and_abort(&harness.handle.core, run_id, "slack", 2).await;

                harness.sync_slack().await;
                let active_runs = harness.handle.core.inner.active_runs.lock().await;
                let active = active_runs
                    .get(&run_id)
                    .expect("run should remain active after recovery");
                assert_eq!(
                    active.connectors[&builtin_target("slack")].consecutive_failures,
                    0
                );
                assert!(
                    !active.sync_tasks.contains_key(&builtin_target("slack")),
                    "successful recovery without nextSyncAt should clear the retry schedule"
                );
                drop(active_runs);

                harness.sync_slack().await;
                assert_retry_scheduled_and_abort(&harness.handle.core, run_id, "slack", 1).await;
            }),
        )
        .await
        .expect("connector runtime sync recovery episodes should complete");

        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
        let immediate_retries =
            captured_events(&events, "connector runtime sync transport failed, retrying");
        assert_eq!(
            immediate_retries.len(),
            3,
            "each persistent failure should retry immediately exactly once: {events:#?}"
        );
        assert!(
            immediate_retries
                .iter()
                .all(|event| event.level == tracing::Level::INFO),
            "immediate retry details should remain local: {events:#?}"
        );

        let failures = captured_events(
            &events,
            "connector runtime sync failed; retaining last-known-good state",
        );
        assert_eq!(failures.len(), 3, "events={events:#?}");
        assert_eq!(failures[0].level, tracing::Level::WARN);
        assert_eq!(failures[1].level, tracing::Level::INFO);
        assert_eq!(failures[2].level, tracing::Level::WARN);
        for failure in &failures {
            assert_connector_field(failure, "transport_retry_attempted", "true");
            assert_connector_field(failure, "scheduled_target_count", "1");
            assert_connector_field(failure, "targets_omitted_count", "0");
            assert_connector_field(failure, "will_retry", "true");
            assert_connector_field(failure, "reason", "api_error");
            assert_connector_transport_fields(failure, &api_url, run_id);
            assert_eq!(
                failure.fields["min_retry_delay_ms"], failure.fields["max_retry_delay_ms"],
                "one target should have one retry delay: {failure:#?}"
            );
            assert!(
                failure.fields["min_retry_delay_ms"]
                    .parse::<u64>()
                    .is_ok_and(|delay| delay > 0),
                "retry delay should be positive: {failure:#?}"
            );
        }
        assert_connector_field(failures[0], "newly_degraded_target_count", "1");
        assert_connector_field(failures[0], "already_degraded_target_count", "0");
        assert_connector_field(failures[0], "min_attempt", "1");
        assert_connector_field(failures[0], "max_attempt", "1");
        assert_connector_field(failures[1], "newly_degraded_target_count", "0");
        assert_connector_field(failures[1], "already_degraded_target_count", "1");
        assert_connector_field(failures[1], "min_attempt", "2");
        assert_connector_field(failures[1], "max_attempt", "2");
        assert_connector_field(failures[2], "newly_degraded_target_count", "1");
        assert_connector_field(failures[2], "already_degraded_target_count", "0");
        assert_eq!(warning_count(&events), 2, "events={events:#?}");

        let scheduled_retries = captured_events(
            &events,
            "retained last-known-good connector runtime state; scheduled sync retry",
        );
        assert_eq!(scheduled_retries.len(), 3, "events={events:#?}");
        assert!(
            scheduled_retries
                .iter()
                .all(|event| event.level == tracing::Level::INFO),
            "per-target retry details should remain local: {events:#?}"
        );
        assert_eq!(scheduled_retries[0].fields["attempt"], "1");
        assert_eq!(scheduled_retries[1].fields["attempt"], "2");
        assert_eq!(scheduled_retries[2].fields["attempt"], "1");

        let recovery = captured_event(&events, "recovered connector runtime target");
        assert_eq!(recovery.level, tracing::Level::INFO);
        assert_connector_field(recovery, "target", "builtin:slack");
        assert_connector_field(recovery, "recovered_after_failures", "2");

        let requests = server.assert_finished_with_requests().await;
        assert_eq!(requests.len(), 7);
        for request in &requests {
            assert_connector_runtime_sync_request(request, &run_id);
        }
        assert_eq!(
            harness.slack_policy().await,
            json!({
                "allow": ["chat:write", "files:write"],
                "deny": [],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn mixed_transport_failure_warns_for_newly_degraded_targets_once() {
        let run_id = RunId::nil();
        let server =
            RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect, RawHttpAction::Disconnect])
                .await;
        let harness = ConnectorRuntimeSyncHarness::new_with_api(
            api_client_for_url(server.url()),
            run_id,
            &["slack", "github"],
        )
        .await;
        let targets = harness
            .handle
            .core
            .current_sync_targets(run_id, vec!["slack".to_string()])
            .await;
        let registration_cancel = harness
            .handle
            .core
            .current_registration_cancel(run_id)
            .await
            .expect("test registration should remain active");
        harness
            .handle
            .core
            .schedule_sync_retries_for_registration(
                run_id,
                &targets,
                &registration_cancel,
                "test_setup",
            )
            .await;

        let (_, events) =
            capture_sync_events(harness.handle.core.sync_builtin_connector_runtime_now(
                run_id,
                vec!["slack".to_string(), "github".to_string()],
            ))
            .await;

        let failure = captured_event(
            &events,
            "connector runtime sync failed; retaining last-known-good state",
        );
        assert_eq!(failure.level, tracing::Level::WARN);
        assert_connector_field(failure, "scheduled_target_count", "2");
        assert_connector_field(failure, "newly_degraded_target_count", "1");
        assert_connector_field(failure, "newly_degraded_targets", "[\"builtin:github\"]");
        assert_connector_field(failure, "already_degraded_target_count", "1");
        assert_connector_field(failure, "already_degraded_targets", "[\"builtin:slack\"]");
        assert_connector_field(failure, "min_attempt", "1");
        assert_connector_field(failure, "max_attempt", "2");
        assert_eq!(warning_count(&events), 1, "events={events:#?}");
        assert!(
            captured_events(
                &events,
                "retained last-known-good connector runtime state; scheduled sync retry",
            )
            .iter()
            .all(|event| event.level == tracing::Level::INFO),
            "per-target retry detail should remain local: {events:#?}"
        );

        assert_eq!(server.assert_finished_with_requests().await.len(), 2);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn successful_connector_runtime_sync_ignores_additional_response_fields() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let sync_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": { "kind": "builtin", "connectorSlug": "slack" },
                        "state": "available",
                        "networkPolicy": {
                            "allow": ["chat:write", "files:write"],
                            "deny": [],
                            "ask": ["channels:read"],
                            "unknownPolicy": "allow",
                        },
                        "additionalField": true,
                    }],
                }));
        });
        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;

        let (_, events) = capture_sync_events(harness.sync_slack()).await;

        sync_mock.assert_calls(1);
        assert_connector_field(
            captured_event(
                &events,
                "applied connector runtime updates to proxy registry",
            ),
            "update_count",
            "1",
        );
        assert_connector_field(
            captured_event(&events, "synced connector runtime target"),
            "target",
            "builtin:slack",
        );
        assert_eq!(
            harness.slack_policy().await,
            json!({
                "allow": ["chat:write", "files:write"],
                "deny": [],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn stale_registry_ownership_stops_runtime_sync_without_retry() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let sync_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(connector_runtime_sync_response(json!({
                    "kind": "builtin",
                    "connectorSlug": "slack",
                })));
        });
        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        let registry = ProxyRegistryHandle::new(
            harness.registry_path.clone(),
            harness._dir.path().join("registry.lock"),
        );
        registry
            .unregister_sandbox(&harness.source_ip)
            .await
            .expect("replacement ownership should remove the old sandbox");

        harness.sync_slack().await;

        sync_mock.assert_calls(1);
        assert!(
            !harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .contains_key(&run_id),
            "stale registry ownership should stop all refresh tracking"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn malformed_canonical_connector_runtime_sync_identities_retain_last_known_good() {
        for (_, identity) in [
            ("missing identity", json!({})),
            (
                "invalid canonical identity",
                json!({
                    "kind": "builtin",
                    "connectorSlug": null,
                }),
            ),
            (
                "empty canonical identity",
                json!({
                    "kind": "builtin",
                    "connectorSlug": "",
                }),
            ),
        ] {
            let server = MockServer::start();
            let run_id = RunId::nil();
            let sync_mock = server.mock(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
                then.status(200)
                    .header("content-type", "application/json")
                    .json_body(connector_runtime_sync_response(identity));
            });
            let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;

            harness.sync_slack().await;

            sync_mock.assert_calls(1);
            let policy = harness.slack_policy().await;
            assert_last_known_good_policy(&policy);
            assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
            harness.shutdown().await;
        }
    }

    #[tokio::test]
    async fn duplicate_connector_runtime_sync_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let sync_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": { "kind": "builtin", "connectorSlug": "slack" },
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": ["channels:read"],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": { "kind": "builtin", "connectorSlug": "slack" },
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["channels:read"],
                                "deny": ["files:write"],
                                "ask": ["chat:write"],
                                "unknownPolicy": "ask",
                            },
                        },
                    ],
                }));
        });

        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        harness.sync_slack().await;
        sync_mock.assert_calls(1);
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn invalid_connector_runtime_sync_deadline_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": { "kind": "builtin", "connectorSlug": "slack" },
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                            "nextSyncAt": "not-a-date",
                        },
                    ],
                }));
        });

        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        harness.sync_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn registry_patch_error_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let sync_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(connector_runtime_sync_response(json!({
                    "kind": "builtin",
                    "connectorSlug": "slack",
                })));
        });
        let (core, _requests) = core_without_worker(&server);
        let (dir, _registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        let invalid_lock_path = dir.path().join("invalid-registry-lock");
        tokio::fs::create_dir(&invalid_lock_path)
            .await
            .expect("invalid lock path directory should be created");
        let failing_registry = ProxyRegistryHandle::new(registry_path.clone(), invalid_lock_path);
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_connector_runtime_state(failing_registry));
        let registry_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before refresh");

        let (_, events) = capture_sync_events(
            core.sync_builtin_connector_runtime_now(run_id, vec!["slack".to_string()]),
        )
        .await;

        sync_mock.assert_calls(1);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable after patch failure"),
            registry_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        assert_connector_field(
            captured_event(
                &events,
                "retained last-known-good connector runtime state; scheduled sync retry",
            ),
            "reason",
            "invalid_or_unpublished_response",
        );
    }

    #[tokio::test]
    async fn invalid_initial_connector_runtime_sync_deadline_preserves_policy_and_retries() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "not-a-date".to_string(),
            },
        )]);
        let targets = [builtin_runtime_target_registration("slack")];

        core.register_run(ConnectorRuntimeSyncRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            targets: &targets,
            refreshes: Some(&refreshes),
        })
        .await;

        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
        )
        .expect("registry should remain valid JSON");
        assert_last_known_good_policy(
            &registry_json["sandboxes"]["10.200.0.2"]["networkPolicies"]["slack"],
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
    }

    #[tokio::test]
    async fn initial_retry_summary_bounds_target_identity_samples() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        let target_count = SYNC_RETRY_LOG_TARGET_SAMPLE_MAX + 2;
        let connector_slugs = (0..target_count)
            .map(|index| format!("connector-{index}"))
            .collect::<Vec<_>>();
        let targets = connector_slugs
            .iter()
            .map(|connector_slug| builtin_runtime_target_registration(connector_slug))
            .collect::<Vec<_>>();
        let refreshes = connector_slugs
            .iter()
            .map(|connector_slug| {
                (
                    connector_slug.clone(),
                    NetworkPolicyRefresh {
                        next_refresh_at: "not-a-date".to_string(),
                    },
                )
            })
            .collect::<HashMap<_, _>>();

        let (_, events) =
            capture_sync_events(core.register_run(ConnectorRuntimeSyncRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                targets: &targets,
                refreshes: Some(&refreshes),
            }))
            .await;

        let summary = captured_event(&events, "connector runtime sync retry state updated");
        assert_eq!(summary.level, tracing::Level::INFO);
        assert_connector_field(summary, "scheduled_target_count", &target_count.to_string());
        assert_connector_field(summary, "targets_omitted_count", "2");
        assert_connector_field(
            summary,
            "newly_degraded_target_count",
            &target_count.to_string(),
        );
        assert_connector_field(summary, "newly_degraded_targets_omitted_count", "2");
        assert_connector_field(summary, "already_degraded_target_count", "0");
        assert_connector_field(summary, "already_degraded_targets_omitted_count", "0");
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn connector_runtime_sync_splits_batches_without_limiting_run_targets() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let connector_slugs = (0..=CONNECTOR_RUNTIME_SYNC_BATCH_MAX)
            .map(|index| format!("connector-{index}"))
            .collect::<Vec<_>>();
        let targets = connector_slugs
            .iter()
            .map(|connector_slug| builtin_target(connector_slug))
            .collect::<Vec<_>>();
        let first_batch = targets[..CONNECTOR_RUNTIME_SYNC_BATCH_MAX].to_vec();
        let second_batch = targets[CONNECTOR_RUNTIME_SYNC_BATCH_MAX..].to_vec();
        let first_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": first_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "sync failed",
                    },
                }));
        });
        let second_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": second_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "sync failed",
                    },
                }));
        });
        let (core, _requests) = core_without_worker(&server);
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"sandboxes":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let registry = ProxyRegistryHandle::new(registry_path, dir.path().join("registry.lock"));
        let active_run =
            active_run_connector_runtime_state_with_targets(registry, connector_slugs.clone());
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run);

        core.sync_builtin_connector_runtime_now(run_id, connector_slugs)
            .await;

        first_mock.assert_calls(1);
        second_mock.assert_calls(1);
        core.unregister_run(run_id).await;
    }

    async fn assert_failed_connector_runtime_sync_retains_last_known_good() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "refresh failed",
                    },
                }));
        });

        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        harness.sync_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    async fn assert_mismatched_connector_runtime_sync_retains_last_known_good() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": { "kind": "builtin", "connectorSlug": "github" },
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["repos:read"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                    ],
                }));
        });

        let harness = ConnectorRuntimeSyncHarness::new(&server, run_id).await;
        harness.sync_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }
}
