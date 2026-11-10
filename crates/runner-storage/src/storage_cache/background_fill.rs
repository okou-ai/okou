//! Runner-wide ownership of deferred storage-cache work and its terminal reports.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use reqwest::Client;
use runner_host::paths::HomePaths;
use tokio::sync::{Notify, Semaphore, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::warn;

use crate::error::{StorageError as RunnerError, StorageResult as RunnerResult};
#[cfg(test)]
use crate::telemetry::StorageTelemetry;
use crate::telemetry::{JobTelemetry, SandboxOpRecord, SandboxOpReporter};

use super::{
    BackgroundFillOutcome, CACHE_MAX_SIZE, CONCURRENCY, CacheTargetGroup, CountBucket,
    count_bucket, decoded, process_group_background_fill,
};

/// Maximum number of cache-fill groups that may be active across the runner.
const BACKGROUND_FILL_ACTIVE_LIMIT: usize = CONCURRENCY;

/// Maximum number of unique cache-fill groups waiting for a worker across the runner.
const BACKGROUND_FILL_QUEUE_CAPACITY: usize = 32;
/// Bound the number of missing archives dispatched while maintenance is waiting.
const BACKGROUND_FILL_MISSING_BURST: usize = 3;
/// Maximum number of completed telemetry tasks reaped between scheduler polls.
const BACKGROUND_FILL_REPORT_REAP_BATCH: usize = 32;

pub(super) const STORAGE_CACHE_BACKGROUND_FILL_FILLED: &str =
    "storage_cache_background_fill_filled";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED: &str =
    "storage_cache_background_fill_already_cached";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_BUSY: &str = "storage_cache_background_fill_busy";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE: &str =
    "storage_cache_background_fill_unavailable";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_SKIPPED: &str =
    "storage_cache_background_fill_skipped";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_FAILED: &str =
    "storage_cache_background_fill_failed";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR: &str = "background-fill-failed";
const STORAGE_CACHE_BACKGROUND_FILL_DEDUPLICATED: &str =
    "storage_cache_background_fill_deduplicated";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED: &str =
    "storage_cache_background_fill_queue_saturated";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED: &str =
    "storage_cache_background_fill_shutdown_cancelled";
const STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_ERROR: &str = "background-fill-shutdown";
pub(super) const STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY: &str =
    "storage_cache_background_fill_deferred_delay";

/// Admission result for one deferred cache-fill group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BackgroundFillAdmission {
    Accepted,
    Deduplicated,
    QueueSaturated,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackgroundFillEntryState {
    Queued,
    Active,
}

#[derive(Clone)]
pub(super) enum BackgroundFillAction {
    /// An archive miss observed during preparation; execution revalidates it.
    Fill(Option<decoded::DecodedCache>),
    /// An archive hit observed during preparation; it may be evicted before execution.
    WarmDecoded(decoded::DecodedCache),
    RetireArchive(decoded::DecodedCache),
}

impl BackgroundFillAction {
    fn is_missing(&self) -> bool {
        matches!(self, Self::Fill(_))
    }
}

struct BackgroundFillEntry {
    group: CacheTargetGroup,
    home: HomePaths,
    action: BackgroundFillAction,
    subscribers: Vec<SandboxOpReporter>,
    state: BackgroundFillEntryState,
}

struct BackgroundFillAdmissionState {
    entries: HashMap<(String, String), BackgroundFillEntry>,
    pending: VecDeque<(String, String)>,
    closed: bool,
}

pub(super) enum BackgroundFillCommand {
    Shutdown(oneshot::Sender<()>),
    #[cfg(any(test, feature = "test-support"))]
    Checkpoint(oneshot::Sender<(usize, usize)>),
}

pub(super) struct BackgroundFillCoordinatorInner {
    state: Mutex<BackgroundFillAdmissionState>,
    pub(super) commands: mpsc::Sender<BackgroundFillCommand>,
    ready: Notify,
    http: Client,
    active_limit: usize,
    queue_capacity: usize,
    shutdown: CancellationToken,
    pub(super) classifiers: TaskTracker,
    classification_slot: Arc<Semaphore>,
}

pub(super) struct BackgroundFillCoordinatorLifecycle {
    pub(super) inner: Arc<BackgroundFillCoordinatorInner>,
    supervisor: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

/// Runner-owned coordinator for deferred storage-cache warming.
///
/// All executor handles clone the same coordinator. The coordinator bounds
/// active and queued work across jobs, deduplicates keys while work is queued
/// or active, and owns the supervisor task until explicit runner shutdown.
#[derive(Clone)]
pub struct StorageCacheBackgroundFillCoordinator {
    pub(super) lifecycle: Arc<BackgroundFillCoordinatorLifecycle>,
}

struct BackgroundFillWork {
    key: (String, String),
    group: CacheTargetGroup,
    home: HomePaths,
    action: BackgroundFillAction,
}

struct BackgroundFillWorkerResult {
    key: (String, String),
    report: BackgroundFillReport,
}

impl StorageCacheBackgroundFillCoordinator {
    pub fn new() -> RunnerResult<Self> {
        Self::new_with_limits(BACKGROUND_FILL_ACTIVE_LIMIT, BACKGROUND_FILL_QUEUE_CAPACITY)
    }

    pub(super) fn new_with_limits(
        active_limit: usize,
        queue_capacity: usize,
    ) -> RunnerResult<Self> {
        assert!(
            active_limit > 0,
            "background fill active limit must be positive"
        );
        assert!(
            queue_capacity > 0,
            "background fill queue capacity must be positive"
        );
        let http = Client::builder().build().map_err(|error| {
            RunnerError::Internal(format!("build background fill http client: {error}"))
        })?;
        let (commands, receiver) = mpsc::channel(queue_capacity);
        let inner = Arc::new(BackgroundFillCoordinatorInner {
            state: Mutex::new(BackgroundFillAdmissionState {
                entries: HashMap::new(),
                pending: VecDeque::new(),
                closed: false,
            }),
            commands,
            ready: Notify::new(),
            http,
            active_limit,
            queue_capacity,
            shutdown: CancellationToken::new(),
            classifiers: TaskTracker::new(),
            classification_slot: Arc::new(Semaphore::new(1)),
        });
        let supervisor = tokio::spawn(run_background_fill_supervisor(Arc::clone(&inner), receiver));
        let lifecycle = Arc::new(BackgroundFillCoordinatorLifecycle {
            inner,
            supervisor: tokio::sync::Mutex::new(Some(supervisor)),
        });
        Ok(Self { lifecycle })
    }

    pub(super) fn submit(
        &self,
        group: CacheTargetGroup,
        home: HomePaths,
        reporter: SandboxOpReporter,
        action: BackgroundFillAction,
    ) -> BackgroundFillAdmission {
        Self::submit_inner(&self.lifecycle.inner, group, home, reporter, action)
    }

    fn submit_inner(
        inner: &BackgroundFillCoordinatorInner,
        group: CacheTargetGroup,
        home: HomePaths,
        reporter: SandboxOpReporter,
        action: BackgroundFillAction,
    ) -> BackgroundFillAdmission {
        let key = group.key();
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.closed {
            return BackgroundFillAdmission::Closed;
        }
        if let Some(entry) = state.entries.get_mut(&key) {
            if entry.state == BackgroundFillEntryState::Queued {
                // Archive consumers take precedence over queued retirement.
                // Active work is already owned; a later run may retry optional
                // maintenance after it finishes.
                match (&mut entry.action, action) {
                    (BackgroundFillAction::Fill(cache), BackgroundFillAction::Fill(next)) => {
                        if cache.is_none() {
                            *cache = next;
                        }
                    }
                    (
                        BackgroundFillAction::Fill(cache),
                        BackgroundFillAction::WarmDecoded(next),
                    ) => {
                        if cache.is_none() {
                            *cache = Some(next);
                        }
                    }
                    (
                        BackgroundFillAction::WarmDecoded(cache),
                        BackgroundFillAction::Fill(next),
                    ) => {
                        let next = next.or_else(|| Some(cache.clone()));
                        entry.action = BackgroundFillAction::Fill(next);
                        entry.group = group;
                        entry.home = home;
                    }
                    (
                        current @ BackgroundFillAction::RetireArchive(_),
                        next @ BackgroundFillAction::Fill(_),
                    ) => {
                        *current = next;
                        entry.group = group;
                        entry.home = home;
                    }
                    (
                        current @ BackgroundFillAction::RetireArchive(_),
                        next @ BackgroundFillAction::WarmDecoded(_),
                    ) => {
                        *current = next;
                        entry.group = group;
                        entry.home = home;
                    }
                    _ => {}
                }
            }
            entry.subscribers.push(reporter);
            return BackgroundFillAdmission::Deduplicated;
        }
        // Leave one worker wave of waiting positions for the other class.
        // Already accepted same-key promotions above keep ownership even when
        // they exceed this class cap; no entry is evicted to make room.
        let reserved = inner.active_limit.min(inner.queue_capacity / 2);
        let same_class = state
            .entries
            .values()
            .filter(|entry| {
                entry.state == BackgroundFillEntryState::Queued
                    && entry.action.is_missing() == action.is_missing()
            })
            .count();
        if state.pending.len() >= inner.queue_capacity
            || same_class >= inner.queue_capacity - reserved
        {
            return BackgroundFillAdmission::QueueSaturated;
        }
        state.entries.insert(
            key.clone(),
            BackgroundFillEntry {
                group,
                home,
                action,
                subscribers: vec![reporter],
                state: BackgroundFillEntryState::Queued,
            },
        );
        state.pending.push_back(key);
        // The queue owns every accepted key before the supervisor is notified.
        // Coalesced wakeups carry no separate FIFO or overflow work ownership.
        drop(state);
        inner.ready.notify_one();
        BackgroundFillAdmission::Accepted
    }

    /// At most one bounded batch runs classification; it consumes an
    /// existing decoded worker rather than creating another classifier queue.
    fn try_classify_warming(
        &self,
        groups: Vec<(CacheTargetGroup, BackgroundFillAction)>,
        home: HomePaths,
        reporter: SandboxOpReporter,
    ) -> Result<(), Vec<(CacheTargetGroup, BackgroundFillAction)>> {
        let Some((_, BackgroundFillAction::WarmDecoded(cache))) = groups.first() else {
            return Err(groups);
        };
        let keys = groups.iter().map(|(group, _)| group.key()).collect();
        let inner = &self.lifecycle.inner;
        let state = inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(groups);
        }
        let Ok(slot) = Arc::clone(&inner.classification_slot).try_acquire_owned() else {
            return Err(groups);
        };
        let check = match cache.try_rejected_archives(keys) {
            Ok(Some(check)) => check,
            Ok(None) => return Err(groups),
            Err(error) => {
                warn!(%error, "storage_cache: rejection classification unavailable");
                return Err(groups);
            }
        };
        // Register completion and reporting under the same lock as shutdown.
        let task = inner.classifiers.token();
        let inner = Arc::clone(inner);
        drop(state);
        tokio::spawn(async move {
            let (_task, _slot) = (task, slot);
            // The blocking task releases decoded memory/workers before these
            // results can admit useful warming that needs those same permits.
            let rejected = match check.await {
                Ok(Ok(rejected)) => rejected,
                result => {
                    warn!(?result, "storage_cache: rejection classification failed");
                    vec![false; groups.len()]
                }
            };
            let mut accepted = 0;
            let mut records = Vec::new();
            for ((group, action), rejected) in groups.into_iter().zip(rejected) {
                if rejected {
                    continue;
                }
                let admission =
                    Self::submit_inner(&inner, group, home.clone(), reporter.clone(), action);
                record_background_admission(admission, &mut accepted, &mut records);
            }
            if accepted > 0 {
                records.push(SandboxOpRecord::new(
                    background_fill_scheduled_count_action(accepted),
                    Duration::ZERO,
                    true,
                    None,
                ));
            }
            if !records.is_empty() {
                reporter.report(records).await;
            }
        });
        Ok(())
    }

    /// Close admissions, cancel queued work, drain active atomic operations,
    /// and join all terminal telemetry reports before returning.
    ///
    /// Cancelling one observer leaves the original supervisor join owned here.
    /// Concurrent and replacement observers wait for the same accepted work.
    pub async fn shutdown(&self) {
        {
            let mut state = self
                .lifecycle
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.closed = true;
            self.lifecycle.inner.classifiers.close();
        }
        {
            let mut owner = self.lifecycle.supervisor.lock().await;
            if let Some(supervisor) = owner.as_mut() {
                let (complete, completed) = oneshot::channel();
                if self
                    .lifecycle
                    .inner
                    .commands
                    .send(BackgroundFillCommand::Shutdown(complete))
                    .await
                    .is_ok()
                {
                    let _ = completed.await;
                } else {
                    self.lifecycle.inner.shutdown.cancel();
                }
                if let Err(error) = supervisor.await {
                    warn!(%error, "storage_cache: background fill supervisor failed during shutdown");
                }
                *owner = None;
            }
        }
        self.lifecycle.inner.classifiers.wait().await;
    }

    #[cfg(test)]
    pub(super) fn is_closed_for_test(&self) -> bool {
        self.lifecycle
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .closed
    }

    #[cfg(any(test, feature = "test-support"))]
    pub async fn wait_idle_for_test(&self) {
        loop {
            let (send, receive) = oneshot::channel();
            let sent = self
                .lifecycle
                .inner
                .commands
                .send(BackgroundFillCommand::Checkpoint(send))
                .await;
            assert!(
                sent.is_ok(),
                "background fill supervisor stopped before checkpoint"
            );
            let counts = receive.await;
            assert!(
                counts.is_ok(),
                "background fill supervisor dropped checkpoint"
            );
            if matches!(counts, Ok((0, 0))) {
                return;
            }
            // Observe a coordinator checkpoint without busy-spinning while a
            // blocking filesystem worker is active. This is test-only polling.
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
}

impl Drop for BackgroundFillCoordinatorLifecycle {
    fn drop(&mut self) {
        // Classification may finish after the last executor owner disappears.
        // Close admission before aborting the only supervisor that can drain it.
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed = true;
        self.inner.classifiers.close();
        self.inner.shutdown.cancel();
        if let Some(supervisor) = self.supervisor.get_mut().take() {
            supervisor.abort();
        }
    }
}

async fn run_background_fill_supervisor(
    inner: Arc<BackgroundFillCoordinatorInner>,
    mut receiver: mpsc::Receiver<BackgroundFillCommand>,
) {
    let mut missing_streak = 0;
    let mut workers = JoinSet::new();
    let mut reports = JoinSet::new();
    let mut shutdown_complete: Option<oneshot::Sender<()>> = None;
    let mut shutdown_requested = false;

    loop {
        // Command and worker branches are intentionally prioritized below.
        // Reap a bounded batch here so a sustained stream of either branch
        // cannot retain completed reporter tasks indefinitely.
        reap_completed_background_fill_reports(&mut reports);

        while workers.len() < inner.active_limit {
            let Some(work) = take_background_fill_work(&inner, &mut missing_streak) else {
                break;
            };
            let worker_key = work.key.clone();
            let http = inner.http.clone();
            workers.spawn(async move {
                match std::panic::AssertUnwindSafe(run_background_fill_work(work, http))
                    .catch_unwind()
                    .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        warn!(
                            key = ?worker_key,
                            "storage_cache: background fill worker panicked"
                        );
                        BackgroundFillWorkerResult {
                            key: worker_key,
                            report: BackgroundFillReport::failed(Duration::ZERO),
                        }
                    }
                }
            });
        }

        if shutdown_requested {
            let cancelled = cancel_queued_background_fills(&inner);
            spawn_background_fill_reports(
                &mut reports,
                cancelled,
                BackgroundFillReport::shutdown_cancelled().into_records(),
            );
            while let Some(result) = workers.join_next().await {
                handle_background_fill_worker_result(&inner, &mut reports, Some(result));
            }
            while let Some(result) = reports.join_next().await {
                if let Err(error) = result {
                    warn!(%error, "storage_cache: background fill telemetry task failed during shutdown");
                }
            }
            inner.shutdown.cancel();
            if let Some(complete) = shutdown_complete.take() {
                let _ = complete.send(());
            }
            return;
        }

        tokio::select! {
            biased;
            command = receiver.recv() => {
                match command {
                    #[cfg(any(test, feature = "test-support"))]
                    Some(BackgroundFillCommand::Checkpoint(complete)) => {
                        let state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = complete.send((workers.len() + inner.classifiers.len(), state.pending.len()));
                    }
                    Some(BackgroundFillCommand::Shutdown(complete)) => {
                        let mut state = inner
                            .state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        state.closed = true;
                        shutdown_complete = Some(complete);
                        shutdown_requested = true;
                    }
                    None => {
                        let mut state = inner
                            .state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        state.closed = true;
                        shutdown_requested = true;
                    }
                }
            }
            () = inner.shutdown.cancelled(), if !shutdown_requested => {
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.closed = true;
                shutdown_requested = true;
            }
            result = workers.join_next(), if !workers.is_empty() => {
                handle_background_fill_worker_result(&inner, &mut reports, result);
            }
            () = inner.ready.notified() => {}
            result = reports.join_next(), if !reports.is_empty() => {
                if let Some(Err(error)) = result {
                    warn!(%error, "storage_cache: background fill telemetry task failed");
                }
            }
        }
    }
}

fn take_background_fill_work(
    inner: &BackgroundFillCoordinatorInner,
    missing_streak: &mut usize,
) -> Option<BackgroundFillWork> {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Shutdown closes admission before its command reaches the supervisor;
    // never promote queued work after that point.
    if state.closed {
        return None;
    }
    // FIFO within each class. Once the missing burst is spent, dispatch the
    // oldest maintenance item; an empty class never leaves a worker idle.
    let prefer_missing = *missing_streak < BACKGROUND_FILL_MISSING_BURST;
    let position = state
        .pending
        .iter()
        .position(|key| {
            state
                .entries
                .get(key)
                .is_some_and(|entry| entry.action.is_missing() == prefer_missing)
        })
        .unwrap_or(0);
    let key = state.pending.remove(position)?;
    let (group, home, action) = {
        let entry = state.entries.get_mut(&key)?;
        if entry.state != BackgroundFillEntryState::Queued {
            return None;
        }
        entry.state = BackgroundFillEntryState::Active;
        (
            entry.group.clone(),
            entry.home.clone(),
            entry.action.clone(),
        )
    };
    *missing_streak = if action.is_missing() {
        (*missing_streak + 1).min(BACKGROUND_FILL_MISSING_BURST)
    } else {
        0
    };
    Some(BackgroundFillWork {
        key,
        group,
        home,
        action,
    })
}

fn reap_completed_background_fill_reports(reports: &mut JoinSet<()>) {
    for _ in 0..BACKGROUND_FILL_REPORT_REAP_BATCH {
        let Some(result) = reports.try_join_next() else {
            break;
        };
        if let Err(error) = result {
            warn!(%error, "storage_cache: background fill telemetry task failed");
        }
    }
}

fn cancel_queued_background_fills(
    inner: &BackgroundFillCoordinatorInner,
) -> Vec<SandboxOpReporter> {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut subscribers = Vec::new();
    while let Some(key) = state.pending.pop_front() {
        if let Some(entry) = state.entries.remove(&key) {
            subscribers.extend(entry.subscribers);
        }
    }
    subscribers
}

async fn run_background_fill_work(
    work: BackgroundFillWork,
    http: Client,
) -> BackgroundFillWorkerResult {
    let started_at = Instant::now();
    let outcome = async {
        if let BackgroundFillAction::RetireArchive(cache) = &work.action {
            return cache
                .retire_archive(&work.key.0, &work.key.1)
                .await
                .map(|retired| BackgroundFillOutcome::ArchiveRetirement { retired })
                .map_err(|error| {
                    RunnerError::Internal(format!("retire storage archive: {error}"))
                });
        }
        let outcome = process_group_background_fill(&work.group, &http, &work.home).await?;
        if matches!(
            outcome,
            BackgroundFillOutcome::Filled { .. } | BackgroundFillOutcome::AlreadyCached { .. }
        ) && let BackgroundFillAction::Fill(Some(decoded))
        | BackgroundFillAction::WarmDecoded(decoded) = &work.action
        {
            decoded
                .warm_from_archive(&work.key.0, &work.key.1)
                .await
                .map_err(|error| {
                    RunnerError::Internal(format!("warm extracted storage cache: {error}"))
                })?;
        }
        Ok::<_, RunnerError>(outcome)
    }
    .await;
    let report = match outcome {
        Ok(outcome) => BackgroundFillReport::from_outcome(outcome, started_at.elapsed()),
        Err(error) => {
            warn!(%error, "storage_cache: background fill failed");
            BackgroundFillReport::failed(started_at.elapsed())
        }
    };
    BackgroundFillWorkerResult {
        key: work.key,
        report,
    }
}

fn handle_background_fill_worker_result(
    inner: &BackgroundFillCoordinatorInner,
    reports: &mut JoinSet<()>,
    result: Option<Result<BackgroundFillWorkerResult, tokio::task::JoinError>>,
) {
    let Some(result) = result else {
        return;
    };
    let worker = match result {
        Ok(worker) => worker,
        Err(error) => {
            warn!(%error, "storage_cache: background fill worker failed");
            return;
        }
    };
    let subscribers = {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = state.entries.remove(&worker.key) else {
            return;
        };
        entry.subscribers
    };
    spawn_background_fill_reports(reports, subscribers, worker.report.into_records());
}

fn spawn_background_fill_reports(
    reports: &mut JoinSet<()>,
    subscribers: Vec<SandboxOpReporter>,
    records: Vec<SandboxOpRecord>,
) {
    for reporter in subscribers {
        let records = records.clone();
        reports.spawn(async move {
            reporter.report(records).await;
        });
    }
}

/// Background cache work selected during cache population after guest staging
/// outcomes are known, but not yet started. Depending on those outcomes, the
/// selected actions may fill a missing archive, warm the extracted-file cache
/// from an archive hit, or retire a redundant archive after an extracted-file hit.
///
/// Before [`Self::start`], this value holds selection data, including archive
/// URLs and optional decoded-cache handles. Creating it does not start an HTTP
/// request or task, acquire a cache lock, or open a file, so dropping it on a
/// pre-spawn failure requires no asynchronous cleanup for this deferred work.
#[must_use = "deferred storage cache fill must be started after agent spawn or explicitly dropped"]
pub struct DeferredBackgroundFill {
    pub(super) groups: Vec<(CacheTargetGroup, BackgroundFillAction)>,
    pub(super) home: HomePaths,
    pub(super) selected_at: Instant,
}

impl DeferredBackgroundFill {
    #[cfg(test)]
    pub(super) async fn run(self) -> Vec<SandboxOpRecord> {
        run_background_fill_groups(self.groups, self.home).await
    }

    pub fn start(
        self,
        coordinator: &StorageCacheBackgroundFillCoordinator,
        telemetry: &mut JobTelemetry,
    ) {
        telemetry.record(
            STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY,
            self.selected_at.elapsed(),
            true,
            None,
        );
        let reporter = telemetry.reporter();
        let mut accepted = 0;
        let mut records = Vec::new();
        let mut groups = self.groups.into_iter().peekable();
        while let Some((group, action)) = groups.next() {
            let batch = if matches!(action, BackgroundFillAction::WarmDecoded(_)) {
                let mut batch = vec![(group, action)];
                while batch.len() < decoded::REJECTION_BATCH_SIZE
                    && groups.peek().is_some_and(|(_, action)| {
                        matches!(action, BackgroundFillAction::WarmDecoded(_))
                    })
                {
                    if let Some(next) = groups.next() {
                        batch.push(next);
                    }
                }
                match coordinator.try_classify_warming(batch, self.home.clone(), reporter.clone()) {
                    Ok(()) => continue,
                    Err(batch) => batch,
                }
            } else {
                vec![(group, action)]
            };
            for (group, action) in batch {
                let admission =
                    coordinator.submit(group, self.home.clone(), reporter.clone(), action);
                record_background_admission(admission, &mut accepted, &mut records);
            }
        }
        for record in records {
            telemetry.record(
                record.action_type,
                record.duration,
                record.success,
                record.error,
            );
        }
        if accepted > 0 {
            telemetry.record(
                background_fill_scheduled_count_action(accepted),
                Duration::ZERO,
                true,
                None,
            );
        }
    }
}

fn record_background_admission(
    admission: BackgroundFillAdmission,
    accepted: &mut usize,
    records: &mut Vec<SandboxOpRecord>,
) {
    let (action, success, error) = match admission {
        BackgroundFillAdmission::Accepted => {
            *accepted += 1;
            return;
        }
        BackgroundFillAdmission::Deduplicated => {
            (STORAGE_CACHE_BACKGROUND_FILL_DEDUPLICATED, true, None)
        }
        BackgroundFillAdmission::QueueSaturated => (
            STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED,
            true,
            Some("queue-capacity"),
        ),
        BackgroundFillAdmission::Closed => (
            STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED,
            false,
            Some(STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_ERROR),
        ),
    };
    records.push(SandboxOpRecord::new(action, Duration::ZERO, success, error));
}

pub(super) struct BackgroundFillReport {
    outcome: SandboxOpRecord,
    size_bucket: Option<SandboxOpRecord>,
}

impl BackgroundFillReport {
    pub(super) fn from_outcome(outcome: BackgroundFillOutcome, duration: Duration) -> Self {
        let (action_type, size) = match outcome {
            BackgroundFillOutcome::ArchiveRetirement { retired } => (
                if retired {
                    "storage_cache_archive_retired"
                } else {
                    "storage_cache_archive_retirement_skipped"
                },
                None,
            ),
            BackgroundFillOutcome::Filled { size } => {
                (STORAGE_CACHE_BACKGROUND_FILL_FILLED, Some(size))
            }
            BackgroundFillOutcome::AlreadyCached { size } => {
                (STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED, Some(size))
            }
            BackgroundFillOutcome::Busy => (STORAGE_CACHE_BACKGROUND_FILL_BUSY, None),
            BackgroundFillOutcome::Unavailable => (STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, None),
            BackgroundFillOutcome::Skipped => (STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, None),
        };
        Self {
            outcome: SandboxOpRecord::new(action_type, duration, true, None),
            size_bucket: size.map(|size| {
                SandboxOpRecord::new(
                    background_fill_size_bucket_action(size),
                    Duration::ZERO,
                    true,
                    None,
                )
            }),
        }
    }

    pub(super) fn failed(duration: Duration) -> Self {
        Self {
            outcome: SandboxOpRecord::new(
                STORAGE_CACHE_BACKGROUND_FILL_FAILED,
                duration,
                false,
                Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR),
            ),
            size_bucket: None,
        }
    }

    fn shutdown_cancelled() -> Self {
        Self {
            outcome: SandboxOpRecord::new(
                STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED,
                Duration::ZERO,
                false,
                Some(STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_ERROR),
            ),
            size_bucket: None,
        }
    }

    pub(super) fn into_records(self) -> Vec<SandboxOpRecord> {
        let mut records = vec![self.outcome];
        if let Some(size_bucket) = self.size_bucket {
            records.push(size_bucket);
        }
        records
    }
}

#[cfg(test)]
async fn run_background_fill_groups(
    groups: Vec<(CacheTargetGroup, BackgroundFillAction)>,
    home: HomePaths,
) -> Vec<SandboxOpRecord> {
    let http = match Client::builder().build() {
        Ok(http) => http,
        Err(error) => {
            warn!(%error, "storage_cache: failed to build background fill http client");
            return (0..groups.len())
                .map(|_| {
                    SandboxOpRecord::new(
                        STORAGE_CACHE_BACKGROUND_FILL_FAILED,
                        Duration::ZERO,
                        false,
                        Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR),
                    )
                })
                .collect();
        }
    };

    let mut fills = JoinSet::new();
    let mut reports = Vec::new();
    for (group, action) in groups {
        while fills.len() >= CONCURRENCY {
            if let Some(report) = join_next_background_fill(&mut fills).await {
                reports.extend(report.into_records());
            }
        }

        let http = http.clone();
        let home = home.clone();
        fills.spawn(async move {
            let work = BackgroundFillWork {
                key: group.key(),
                group,
                home,
                action,
            };
            run_background_fill_work(work, http).await.report
        });
    }

    while !fills.is_empty() {
        if let Some(report) = join_next_background_fill(&mut fills).await {
            reports.extend(report.into_records());
        }
    }
    reports
}

#[cfg(test)]
async fn join_next_background_fill(
    fills: &mut JoinSet<BackgroundFillReport>,
) -> Option<BackgroundFillReport> {
    match fills.join_next().await {
        Some(Ok(report)) => Some(report),
        None => None,
        Some(Err(error)) => {
            warn!(%error, "storage_cache: background fill task failed");
            Some(BackgroundFillReport::failed(Duration::ZERO))
        }
    }
}

fn background_fill_scheduled_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_background_fill_scheduled_count_0",
        CountBucket::One => "storage_cache_background_fill_scheduled_count_1",
        CountBucket::Two => "storage_cache_background_fill_scheduled_count_2",
        CountBucket::ThreeToFour => "storage_cache_background_fill_scheduled_count_3_4",
        CountBucket::FiveToEight => "storage_cache_background_fill_scheduled_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_background_fill_scheduled_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_background_fill_scheduled_count_17_plus",
    }
}

fn background_fill_size_bucket_action(size: u64) -> &'static str {
    if size < 64 * 1024 {
        "storage_cache_background_fill_size_lt_64_kib"
    } else if size < 256 * 1024 {
        "storage_cache_background_fill_size_64_256_kib"
    } else if size < 1024 * 1024 {
        "storage_cache_background_fill_size_256_kib_1_mib"
    } else if size < 4 * 1024 * 1024 {
        "storage_cache_background_fill_size_1_4_mib"
    } else if size <= CACHE_MAX_SIZE {
        "storage_cache_background_fill_size_4_8_mib"
    } else {
        "storage_cache_background_fill_size_gt_8_mib"
    }
}
