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
//! and generations current through the atomic write. Authoritative absence
//! removes only the matching candidate, while unresolved results retain
//! last-known-good state and retry. Transport, validation, queue, and registry
//! publication failures also retain last-known-good state and install a capped,
//! jittered retry. Older queued or in-flight work cannot clear a newer realtime
//! trigger. Every state transition is also scoped to the registration's
//! cancellation token so work from a replaced registration cannot affect its
//! successor when generations reset.
//!
//! A validated unresolved result is a normal domain observation: both its first
//! occurrence and retries log at INFO, preserving the target and unavailable
//! reason locally without entering the WARN+ Axiom transport. Request, response
//! validation, and publication faults retain their separate warning boundaries.
//! Unavailability does not change the pinned account or count as a successful
//! sync. Older draining runners may still warn; missing warnings alone do not
//! prove recovery. Confirm recovery through a later successful publication.
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
use std::sync::Arc;
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
use super::worker_join::join_retained_worker;
use crate::connector_registry::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication, ConnectorRuntimeRegistryHandle,
    ConnectorRuntimeRegistryUpdate, CustomConnectorRuntimeRegistryState,
};
use crate::error::ProviderError;
use runner_types::ids::RunId;
use runner_types::types::{
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
pub struct ConnectorRuntimeSyncHandle {
    core: ConnectorRuntimeSyncCore,
    worker: Arc<ConnectorRuntimeSyncWorker>,
}

struct ConnectorRuntimeSyncWorker {
    core: ConnectorRuntimeSyncCore,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    #[cfg(test)]
    scheduled_enqueue_gate: Mutex<Option<Arc<ScheduledSyncEnqueueGate>>>,
}

#[cfg(test)]
struct ScheduledSyncEnqueueGate {
    taken: tokio::sync::Barrier,
    release: tokio::sync::Barrier,
    enqueued: tokio::sync::Barrier,
}

struct ActiveRunConnectorRuntimeState {
    source_ip: String,
    registry: ConnectorRuntimeRegistryHandle,
    connectors: HashMap<ConnectorRuntimeTarget, ActiveConnectorSyncState>,
    cancel: CancellationToken,
    next_sync_task_id: u64,
}

impl ActiveRunConnectorRuntimeState {
    fn for_registration(&self, registration_cancel: &CancellationToken) -> Option<&Self> {
        (&self.cancel == registration_cancel).then_some(self)
    }

    fn for_registration_mut(
        &mut self,
        registration_cancel: &CancellationToken,
    ) -> Option<&mut Self> {
        self.for_registration(registration_cancel)?;
        Some(self)
    }

    fn current_target(&self, target: &ConnectorSyncTarget) -> Option<&ActiveConnectorSyncState> {
        self.connectors
            .get(&target.target)?
            .for_generation(target.generation)
    }

    fn current_target_mut(
        &mut self,
        target: &ConnectorSyncTarget,
    ) -> Option<&mut ActiveConnectorSyncState> {
        self.connectors
            .get_mut(&target.target)?
            .for_generation_mut(target.generation)
    }

    fn take_sync_tasks(&mut self) -> impl Iterator<Item = tokio::task::JoinHandle<()>> + '_ {
        self.connectors
            .values_mut()
            .filter_map(|connector| connector.scheduled_sync.take())
            .map(|task| task.handle)
    }

    fn cancel_and_take_sync_tasks(
        &mut self,
    ) -> impl Iterator<Item = tokio::task::JoinHandle<()>> + '_ {
        self.cancel.cancel();
        self.take_sync_tasks()
    }
}

struct ActiveConnectorSyncState {
    registration: ConnectorRuntimeTargetRegistration,
    generation: u64,
    consecutive_failures: u32,
    scheduled_sync: Option<ScheduledSyncTask>,
    #[cfg(test)]
    successful_generation: tokio::sync::watch::Sender<Option<u64>>,
}

impl ActiveConnectorSyncState {
    fn for_generation(&self, generation: u64) -> Option<&Self> {
        (self.generation == generation).then_some(self)
    }

    fn for_generation_mut(&mut self, generation: u64) -> Option<&mut Self> {
        self.for_generation(generation)?;
        Some(self)
    }
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
    registry: ConnectorRuntimeRegistryHandle,
}

pub struct ConnectorRuntimeSyncRegistration<'a> {
    pub run_id: RunId,
    pub source_ip: &'a str,
    pub registry: ConnectorRuntimeRegistryHandle,
    pub targets: &'a [ConnectorRuntimeTargetRegistration],
    pub refreshes: Option<&'a HashMap<String, NetworkPolicyRefresh>>,
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
    error: &ProviderError,
    transport_retry_attempted: bool,
    summary: &SyncRetrySummary,
) {
    match error {
        ProviderError::ApiTransport(api_error) => {
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
        ProviderError::ApiStatus(api_error) => {
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
                #[cfg(test)]
                scheduled_enqueue_gate: Mutex::new(None),
            }),
            request_tx,
        };
        let worker_task = tokio::spawn(run_sync_dispatcher(core.clone(), request_rx));
        Self {
            core: core.clone(),
            worker: Arc::new(ConnectorRuntimeSyncWorker {
                core,
                task: Mutex::new(Some(worker_task)),
            }),
        }
    }

    pub async fn shutdown(&self) {
        self.core.shutdown_active_runs().await;
        if let Err(error) = join_retained_worker(&self.worker.task).await {
            warn!(error = %error, "connector runtime sync worker failed during shutdown");
        }
        // Joining the dispatcher stops publication admission. Its cancelled
        // waiters do not own the local writes, which must settle before shutdown
        // can report completion and job cleanup can finish unregistering runs.
        self.core.inner.publications.close();
        self.core.inner.publications.wait().await;
    }

    pub async fn register_run(&self, registration: ConnectorRuntimeSyncRegistration<'_>) {
        self.core.register_run(registration).await;
    }

    pub async fn unregister_run(&self, run_id: RunId) {
        self.core.unregister_run(run_id).await;
    }

    pub async fn notify_connector_runtime_sync(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
    ) {
        self.core
            .notify_connector_runtime_sync(run_id, target)
            .await;
    }

    pub async fn notify_connector_runtime_sync_until_cancelled(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_connector_runtime_sync_until_cancelled(run_id, target, cancel)
            .await;
    }

    #[cfg(test)]
    async fn take_worker_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.worker.task.lock().await.take()
    }
}

impl Drop for ConnectorRuntimeSyncWorker {
    fn drop(&mut self) {
        self.core.inner.cancel.cancel();
        if let Some(worker_task) = self.task.get_mut().take() {
            worker_task.abort();
        }
    }
}

impl ConnectorRuntimeSyncCore {
    async fn shutdown_active_runs(&self) {
        self.inner.cancel.cancel();
        let old_runs = std::mem::take(&mut *self.inner.active_runs.lock().await);
        for mut old in old_runs.into_values() {
            abort_tasks(old.cancel_and_take_sync_tasks());
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
            if let Some(mut old) = active_runs.remove(&registration.run_id) {
                old_tasks.extend(old.cancel_and_take_sync_tasks());
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
                            scheduled_sync: None,
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
        abort_tasks(old.cancel_and_take_sync_tasks());
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
            active_runs
                .get(&run_id)
                .and_then(|active| active.for_registration(registration_cancel))?;
            active_runs.remove(&run_id)?
        };
        abort_tasks(old.take_sync_tasks());
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
            if !transport_retry_attempted && let Err(ProviderError::ApiTransport(error)) = &response
            {
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
                info!(
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
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeSyncState::Absent { reason },
                ) => {
                    info!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        reason = ?reason,
                        "builtin connector runtime target is authoritatively absent"
                    );
                    Ok(ConnectorRuntimeRegistryUpdate::BuiltinAbsent {
                        connector_slug: connector_slug.clone(),
                    })
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
                        .source_id_for_publication(run_id, target, registration_cancel)
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
                transaction = snapshot.registry.begin_transaction() => transaction,
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
                    let Some(active) = active_runs
                        .get(&run_id)
                        .and_then(|active| active.for_registration(registration_cancel))
                    else {
                        return false;
                    };
                    let prepared_publications = prepared_publications
                        .into_iter()
                        .filter(|publication| active.current_target(&publication.target).is_some())
                        .collect::<Vec<_>>();
                    if prepared_publications.is_empty() {
                        drop(active_runs);
                        drop(transaction);
                        (
                            prepared_publications,
                            Ok(Some(ConnectorRuntimePublication {
                                outcomes: Vec::new(),
                                publication: None,
                            })),
                        )
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
                Ok(Some(result)) => {
                    if let Some(receipt) = result.publication {
                        receipt.observe().await;
                    }
                    for (prepared, published) in
                        prepared_publications.into_iter().zip(result.outcomes)
                    {
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
            transaction = snapshot.registry.begin_transaction() => transaction,
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
            Ok(Some(result)) => {
                if let Some(receipt) = result.publication {
                    receipt.observe().await;
                }
                for (target, outcome) in targets.iter().zip(result.outcomes) {
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
            .and_then(|active| active.for_registration(registration_cancel))
            .is_some()
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
        let Some(active) = active_runs
            .get(&run_id)
            .and_then(|active| active.for_registration(registration_cancel))
        else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        targets
            .into_iter()
            .filter(|target| {
                active.current_target(target).is_some() && seen.insert(target.target.clone())
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
        let Some(active) = active_runs
            .get(&run_id)
            .and_then(|active| active.for_registration(registration_cancel))
        else {
            return Vec::new();
        };
        targets
            .iter()
            .filter_map(|target| {
                let connector = active.current_target(target)?;
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
        active_runs
            .get(&run_id)
            .and_then(|active| active.for_registration(registration_cancel))
            .and_then(|active| active.current_target(target))
            .is_some()
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
        let active = active_runs
            .get(&run_id)?
            .for_registration(registration_cancel)?;
        let current = publications
            .into_iter()
            .filter(|publication| active.current_target(&publication.target).is_some())
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
        let active = active_runs
            .get(&run_id)?
            .for_registration(registration_cancel)?;
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
        let active = active_runs
            .get(&run_id)?
            .for_registration(registration_cancel)?;
        let connector = active.current_target(target)?;
        connector.registration.custom_base_url_vars().cloned()
    }

    async fn source_id_for_publication(
        &self,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        registration_cancel: &CancellationToken,
    ) -> Option<Option<String>> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)?
            .for_registration(registration_cancel)?;
        let connector = active.current_target(target)?;
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
        let active = active_runs
            .get_mut(&run_id)?
            .for_registration_mut(registration_cancel)?;
        let connector = active.current_target_mut(target)?;
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
        let Some(active) = active_runs
            .get_mut(&run_id)
            .and_then(|active| active.for_registration_mut(registration_cancel))
        else {
            return SyncRetrySummary::default();
        };

        let mut seen = HashSet::new();
        for target in targets {
            if !seen.insert(&target.target) {
                continue;
            }
            let Some(connector) = active.current_target_mut(target) else {
                continue;
            };
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
        let Some(active) = active_runs
            .get_mut(&run_id)
            .and_then(|active| active.for_registration_mut(registration_cancel))
        else {
            return false;
        };
        self.replace_schedule_locked(active, run_id, target, deadline)
    }

    fn replace_schedule_locked(
        &self,
        active: &mut ActiveRunConnectorRuntimeState,
        run_id: RunId,
        target: &ConnectorSyncTarget,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        let Some(connector) = active
            .connectors
            .get_mut(&target.target)
            .and_then(|connector| connector.for_generation_mut(target.generation))
        else {
            return false;
        };

        if let Some(old) = connector.scheduled_sync.take() {
            old.handle.abort();
        }
        let Some(deadline) = deadline else {
            return true;
        };

        let task_id = active.next_sync_task_id;
        active.next_sync_task_id += 1;
        let cancel = active.cancel.clone();
        let global_cancel = self.inner.cancel.clone();
        let task_target = target.target.clone();
        let generation = target.generation;
        let handle = self.clone();
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
                        #[cfg(test)]
                        let enqueue_gate = handle.inner.scheduled_enqueue_gate.lock().await.take();
                        #[cfg(test)]
                        if let Some(gate) = &enqueue_gate {
                            gate.taken.wait().await;
                            gate.release.wait().await;
                        }
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
                        #[cfg(test)]
                        if let Some(gate) = enqueue_gate {
                            gate.enqueued.wait().await;
                        }
                    }
                }
            }
        });
        connector.scheduled_sync = Some(ScheduledSyncTask {
            id: task_id,
            generation,
            deadline,
            handle: task,
        });
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
            let active = active_runs
                .get_mut(&run_id)?
                .for_registration_mut(registration_cancel)?;
            if active
                .connectors
                .get(target)
                .and_then(|connector| connector.scheduled_sync.as_ref())
                .is_none_or(|task| task.id != task_id)
            {
                return None;
            }

            let coalesce_deadline = tokio::time::Instant::now() + SCHEDULED_SYNC_COALESCE_WINDOW;
            let mut due_targets = active
                .connectors
                .iter()
                .filter(|(_, connector)| {
                    connector
                        .scheduled_sync
                        .as_ref()
                        .is_some_and(|task| task.deadline <= coalesce_deadline)
                })
                .map(|(target, _)| target.clone())
                .collect::<Vec<_>>();
            due_targets.sort_by_key(ConnectorRuntimeTarget::log_identity);

            let mut targets = Vec::with_capacity(due_targets.len());
            for due_target in due_targets {
                if let Some(task) = active
                    .connectors
                    .get_mut(&due_target)
                    .and_then(|connector| connector.scheduled_sync.take())
                {
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
        targets
            .entry(target.target.clone())
            .and_modify(|existing| {
                existing.generation = existing.generation.max(target.generation);
            })
            .or_insert(target);
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
mod tests;
