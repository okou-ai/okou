//! Runner-side content-addressed cache for small storage archives.
//!
//! Sits between storage planning and `download_storages` in `run_in_sandbox`.
//! For each eligible planned archive, checks a host-local
//! cache keyed by `(vasStorageName, vasVersionId)`. On hit, reads the cached
//! tarball from disk and pushes it into the guest via vsock. On miss, leaves
//! the original URL for the current guest download and returns a deferred
//! cache fill for future runs. The executor starts that fill only after the
//! agent process has spawned. Once guest staging succeeds, the plan's
//! archive source is resolved to
//! `file:///tmp/vm0-storage-cache/<hash(name)>-<hash(version)>.tar.gz`
//! so `guest-storage-apply` reads the guest-local staged archive instead of
//! re-fetching.
//!
//! Production source preparation first selects admissible extracted-file hits
//! and pins their owned bytes in the plan. Those identities bypass archive
//! prefetch and staging entirely.
//! Each selected mount must fit a bounded Guest request; larger combined
//! manifests are batched by the executor without increasing payload budgets.
//!
//! After successful direct use and Agent spawn,
//! the same bounded background owner can retire the redundant compressed entry
//! while holding both formats' locks and validating the extracted replacement.
//! Ordinary archive consumers retain the delivery and fill paths below.
//!
//! Eligible fresh and reused sandbox attempts can assign bounded cold
//! identities to a runner owner before independent pre-spawn preparation.
//! That owner performs one full request, keeps the cache writer through atomic
//! publication and the runner-wide permit through guest application, and
//! stages only complete content. An admitted owner's terminal failure fails
//! storage preparation after draining; it does not retry the request in the guest.
//! Keying on both name and version gives same-version entries with different
//! storage names separate collision-resistant staged filenames in normal
//! operation, so they do not clobber each other on the guest tmpfs.
//!
//! Entries above [`CACHE_MAX_SIZE`], entries without a content key, and
//! reuse/repair actions pass through untouched.
//! For a post-spawn background fill, if the probe says an entry is cache-eligible
//! but the full response exceeds [`CACHE_MAX_SIZE`], the cache rejects publication
//! and reports a background-fill failure. The original URL has already been handed
//! to the guest; this failure does not revoke it or retroactively fail storage
//! application.
//!
//! Runtime contract: `file://` URLs produced here point to guest-local archives
//! staged under [`GUEST_STAGE_DIR`]. `guest-storage-apply` supports that scheme and
//! treats missing local archives as a broken staging contract.

use std::collections::{HashMap, HashSet, VecDeque, hash_map::Entry};
use std::fmt;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::{FutureExt, StreamExt};
use reqwest::Client;
use sandbox::{Sandbox, WriteFileEntry};
use tokio::fs;
use tokio::io::AsyncReadExt as _;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::object_download_policy::OBJECT_DOWNLOAD_TIMEOUT;
use crate::paths::{HomePaths, short_digest, touch_mtime};
use crate::storage_plan::{ArchiveHandle, CacheArchiveCandidate, StoragePlan};
use crate::telemetry::{JobTelemetry, SandboxOpRecord, SandboxOpReporter};

pub(crate) mod decoded;

/// Archive sizes strictly larger than this are passthrough.
const CACHE_MAX_SIZE: u64 = 8 * 1024 * 1024;
const BODY_BUFFER_FALLBACK_CAPACITY: usize = 64 * 1024;

/// Parallel (probe GET / full GET / flock / vsock) operations per `populate_cache` call.
const CONCURRENCY: usize = 4;
/// Maximum number of cache-fill groups that may be active across the runner.
const BACKGROUND_FILL_ACTIVE_LIMIT: usize = CONCURRENCY;
/// Idle transport retention, independent of the per-object request deadline.
const FRESH_DELIVERY_HTTP_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum number of unique cache-fill groups waiting for a worker across the runner.
const BACKGROUND_FILL_QUEUE_CAPACITY: usize = 32;
/// Maximum number of completed telemetry tasks reaped between scheduler polls.
const BACKGROUND_FILL_REPORT_REAP_BATCH: usize = 32;
const FRESH_DELIVERY_SCAN_LIMIT: usize = 64;
const FRESH_DELIVERY_PER_RUN_LIMIT: usize = 4;
const FRESH_DELIVERY_RUNNER_LIMIT: usize = 8;

/// Maximum number of warm cache-hit archives staged in one guest batch write.
const GUEST_STAGE_BATCH_MAX_FILES: usize = 64;

/// Maximum total warm cache-hit bytes staged in one guest batch write.
const GUEST_STAGE_BATCH_MAX_BYTES: usize = 15 * 1024 * 1024;

/// Guest stage directory for `file://` archives.
const GUEST_STAGE_DIR: &str = "/tmp/vm0-storage-cache";

const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const STORAGE_CACHE_STAGE_TOTAL: &str = "storage_cache_stage_total";
const STORAGE_CACHE_STAGE_BATCH_WRITE: &str = "storage_cache_stage_batch_write";
const STORAGE_CACHE_STAGE_FAILED: &str = "storage-cache-stage-failed";
const STORAGE_CACHE_PROCESS_GROUP: &str = "storage_cache_process_group";
const STORAGE_CACHE_PROCESS_GROUP_FAILED: &str = "storage-cache-process-group-failed";
const STORAGE_CACHE_LOCK_WAIT: &str = "storage_cache_lock_wait";
const STORAGE_CACHE_LOCK_WAIT_FAILED: &str = "storage-cache-lock-wait-failed";
const STORAGE_CACHE_HIT_READ: &str = "storage_cache_hit_read";
const STORAGE_CACHE_MISS_PASSTHROUGH: &str = "storage_cache_miss_passthrough";
const STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH: &str = "storage_cache_lock_busy_passthrough";
const STORAGE_CACHE_BACKGROUND_FILL_FILLED: &str = "storage_cache_background_fill_filled";
const STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED: &str =
    "storage_cache_background_fill_already_cached";
const STORAGE_CACHE_BACKGROUND_FILL_BUSY: &str = "storage_cache_background_fill_busy";
const STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE: &str = "storage_cache_background_fill_unavailable";
const STORAGE_CACHE_BACKGROUND_FILL_SKIPPED: &str = "storage_cache_background_fill_skipped";
const STORAGE_CACHE_BACKGROUND_FILL_FAILED: &str = "storage_cache_background_fill_failed";
const STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR: &str = "background-fill-failed";
const STORAGE_CACHE_BACKGROUND_FILL_DEDUPLICATED: &str =
    "storage_cache_background_fill_deduplicated";
const STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED: &str =
    "storage_cache_background_fill_queue_saturated";
const STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED: &str =
    "storage_cache_background_fill_shutdown_cancelled";
const STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_ERROR: &str = "background-fill-shutdown";
const STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY: &str =
    "storage_cache_background_fill_deferred_delay";
const STORAGE_CACHE_FRESH_DELIVERY_ADMITTED: &str = "storage_cache_fresh_delivery_admitted";
const STORAGE_CACHE_FRESH_DELIVERY_WARM: &str = "storage_cache_fresh_delivery_warm";
const STORAGE_CACHE_FRESH_DELIVERY_OVERSIZED: &str = "storage_cache_fresh_delivery_oversized";
const STORAGE_CACHE_FRESH_DELIVERY_LOCK_BUSY: &str = "storage_cache_fresh_delivery_lock_busy";
const STORAGE_CACHE_FRESH_DELIVERY_CAPACITY: &str = "storage_cache_fresh_delivery_capacity";
const STORAGE_CACHE_FRESH_DELIVERY_COMPLETE: &str = "storage_cache_fresh_delivery_complete";
const STORAGE_CACHE_FRESH_DELIVERY_FAILED: &str = "storage_cache_fresh_delivery_failed";
const STORAGE_CACHE_FRESH_DELIVERY_CANCELLED: &str = "storage_cache_fresh_delivery_cancelled";
const STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED: &str = "storage_cache_fresh_delivery_published";
const STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION_FAILED: &str =
    "storage_cache_fresh_delivery_publication_failed";
const STORAGE_CACHE_FRESH_DELIVERY_STAGED: &str = "storage_cache_fresh_delivery_staged";
const STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST: &str =
    "storage_cache_fresh_delivery_single_request";
const STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST: &str =
    "storage_cache_fresh_delivery_size_manifest";
const STORAGE_CACHE_FRESH_DELIVERY_SIZE_RESPONSE: &str =
    "storage_cache_fresh_delivery_size_response";
const STORAGE_CACHE_FRESH_DELIVERY_DRAINED: &str = "storage_cache_fresh_delivery_drained";
const STORAGE_CACHE_FRESH_DELIVERY_HEADERS: &str = "storage_cache_fresh_delivery_headers";
const STORAGE_CACHE_FRESH_DELIVERY_BODY: &str = "storage_cache_fresh_delivery_body";
const STORAGE_CACHE_FRESH_DELIVERY_APPLY_WAIT: &str = "storage_cache_fresh_delivery_apply_wait";
const STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION: &str = "storage_cache_fresh_delivery_publication";
const STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS: &str = "storage_cache_fresh_delivery_scan_groups";
const STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX: &str = "storage_cache_fresh_delivery_scan_suffix";
const STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN: &str =
    "storage_cache_fresh_delivery_scan_suffix_unknown";
const STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP: &str = "storage_cache_fresh_delivery_scan_stop";

/// Guest-side filename for a cached archive.
///
/// Includes both hashed components so two manifest entries that differ only in
/// `vas_storage_name` but share `vas_version_id` derive their staged filenames
/// from both values under the same truncated-hash collision model as the host
/// cache. Uses the same `short_digest` helper that `HomePaths` uses for the host
/// cache dir, so host writes and guest reads use one shared keying scheme.
fn guest_archive_path(name: &str, version: &str) -> String {
    let name_hash = short_digest(name);
    let version_hash = short_digest(version);
    format!("{GUEST_STAGE_DIR}/{name_hash}-{version_hash}.tar.gz")
}

/// One manifest entry that passed the eligibility filter.
#[derive(Clone)]
struct CacheTarget {
    handle: ArchiveHandle,
    name: String,
    version: String,
    archive_url: String,
    archive_size: Option<u64>,
}

#[derive(Clone)]
struct CacheTargetGroup {
    targets: Vec<CacheTarget>,
    archive_size: Option<u64>,
}

struct FreshDeliveryScanSummary {
    group_count: usize,
    cap_excess_count: usize,
    static_eligible_count: usize,
    unknown_size_count: usize,
    per_run: bool,
    runner_wide: bool,
}

impl FreshDeliveryScanSummary {
    fn from_groups<'a>(
        groups: impl Iterator<Item = &'a CacheTargetGroup> + Clone,
        scan_limit: usize,
    ) -> Self {
        let group_count = groups.clone().count();
        let suffix = groups.skip(scan_limit);
        let static_eligible_count = suffix
            .clone()
            .filter(|group| {
                group
                    .archive_size
                    .is_some_and(|size| size <= CACHE_MAX_SIZE)
            })
            .count();
        let unknown_size_count = suffix.filter(|group| group.archive_size.is_none()).count();
        Self {
            group_count,
            cap_excess_count: group_count.saturating_sub(scan_limit),
            static_eligible_count,
            unknown_size_count,
            per_run: false,
            runner_wide: false,
        }
    }

    fn record(&self, telemetry: &mut JobTelemetry, success: bool) {
        telemetry.record_bounded_outcome(
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            success,
            count_bucket_outcome(self.group_count),
            Some(if success {
                "prepared"
            } else {
                "prepare_failed"
            }),
        );
        if self.cap_excess_count > 0 {
            telemetry.record_bounded_outcome(
                STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX,
                success,
                count_bucket_outcome(self.cap_excess_count),
                Some(count_bucket_outcome(self.static_eligible_count)),
            );
        }
        if self.unknown_size_count > 0 {
            telemetry.record_bounded_outcome(
                STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN,
                success,
                count_bucket_outcome(self.unknown_size_count),
                None,
            );
        }

        let mut recorded_stop = false;
        for (observed, outcome) in [(self.per_run, "per_run"), (self.runner_wide, "runner_wide")] {
            if observed {
                telemetry.record_bounded_outcome(
                    STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
                    success,
                    outcome,
                    None,
                );
                recorded_stop = true;
            }
        }
        if !recorded_stop {
            telemetry.record_bounded_outcome(
                STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
                success,
                "none",
                None,
            );
        }
    }
}

/// Runner-wide admission control for bounded archive delivery.
///
/// Clones share one semaphore, so concurrent executor attempts draw from the
/// same `FRESH_DELIVERY_RUNNER_LIMIT`. For an admitted archive, the owned
/// permit follows the downloaded body through atomic cache publication and
/// remains held until the guest staging attempt completes. This bounds
/// retained runner-owned archive bodies across runs, not only active fetches.
/// Clones also share one lazy same-origin HTTP pool with at most eight idle
/// sockets and a 30-second idle timeout. Origin replacement releases the cached
/// client; admitted fetches can retain its old pool until their owned tasks end.
#[derive(Clone)]
pub(crate) struct FreshArchiveDeliveryAdmission {
    permits: Arc<Semaphore>,
    http: Arc<Mutex<Option<FreshArchiveHttpClient>>>,
}

struct FreshArchiveHttpClient {
    origin: url::Origin,
    client: Client,
}

impl FreshArchiveDeliveryAdmission {
    pub(crate) fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(FRESH_DELIVERY_RUNNER_LIMIT)),
            http: Arc::new(Mutex::new(None)),
        }
    }

    fn client_for_archive(&self, archive_url: &str) -> RunnerResult<Client> {
        // Only this origin may use the cached client: redirects are disabled,
        // and changing origins replaces the idle pool instead of accumulating
        // one for every host. Active fetches retain their own client clones.
        // Invalid/unsupported URLs still fail in the owned fetch, as before.
        let origin = reqwest::Url::parse(archive_url)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(|url| url.origin());
        let mut cached = self.http.lock().map_err(|_| {
            RunnerError::Internal("runner-owned archive client lock poisoned".into())
        })?;
        if let Some(cached) = cached.as_ref()
            && origin.as_ref() == Some(&cached.origin)
        {
            return Ok(cached.client.clone());
        }
        // Construction remains lazy after admission and failures are not
        // cached. There is no await while holding this initialization lock.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(FRESH_DELIVERY_RUNNER_LIMIT)
            .pool_idle_timeout(FRESH_DELIVERY_HTTP_IDLE_TIMEOUT)
            .build()
            .map_err(|error| {
                RunnerError::Internal(format!("build runner-owned archive client: {error}"))
            })?;
        if let Some(origin) = origin {
            *cached = Some(FreshArchiveHttpClient {
                origin,
                client: client.clone(),
            });
        }
        Ok(client)
    }
}

/// Admission result for one deferred cache-fill group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BackgroundFillAdmission {
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
enum BackgroundFillAction {
    Fill(Option<decoded::DecodedCache>),
    RetireArchive(decoded::DecodedCache),
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
    queued: usize,
    closed: bool,
}

enum BackgroundFillCommand {
    Start((String, String)),
    Shutdown(oneshot::Sender<()>),
    #[cfg(test)]
    Checkpoint(oneshot::Sender<(usize, usize)>),
}

struct BackgroundFillCoordinatorInner {
    state: Mutex<BackgroundFillAdmissionState>,
    commands: mpsc::Sender<BackgroundFillCommand>,
    http: Client,
    active_limit: usize,
    queue_capacity: usize,
    shutdown: CancellationToken,
}

struct BackgroundFillCoordinatorLifecycle {
    inner: Arc<BackgroundFillCoordinatorInner>,
    supervisor: Mutex<Option<JoinHandle<()>>>,
}

/// Runner-owned coordinator for deferred storage-cache warming.
///
/// All executor handles clone the same coordinator. The coordinator bounds
/// active and queued work across jobs, deduplicates keys while work is queued
/// or active, and owns the supervisor task until explicit runner shutdown.
#[derive(Clone)]
pub(crate) struct StorageCacheBackgroundFillCoordinator {
    lifecycle: Arc<BackgroundFillCoordinatorLifecycle>,
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
    pub(crate) fn new() -> RunnerResult<Self> {
        Self::new_with_limits(BACKGROUND_FILL_ACTIVE_LIMIT, BACKGROUND_FILL_QUEUE_CAPACITY)
    }

    fn new_with_limits(active_limit: usize, queue_capacity: usize) -> RunnerResult<Self> {
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
                queued: 0,
                closed: false,
            }),
            commands,
            http,
            active_limit,
            queue_capacity,
            shutdown: CancellationToken::new(),
        });
        let lifecycle = Arc::new(BackgroundFillCoordinatorLifecycle {
            inner: Arc::clone(&inner),
            supervisor: Mutex::new(None),
        });
        let supervisor = tokio::spawn(run_background_fill_supervisor(inner, receiver));
        *lifecycle
            .supervisor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(supervisor);
        Ok(Self { lifecycle })
    }

    fn submit(
        &self,
        group: CacheTargetGroup,
        home: HomePaths,
        reporter: SandboxOpReporter,
        action: BackgroundFillAction,
    ) -> BackgroundFillAdmission {
        let Some(key) = group_key(&group) else {
            warn!("storage_cache: refusing empty background fill group");
            return BackgroundFillAdmission::Closed;
        };
        let inner = &self.lifecycle.inner;
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
                        current @ BackgroundFillAction::RetireArchive(_),
                        next @ BackgroundFillAction::Fill(_),
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
        if state.queued >= inner.queue_capacity {
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
        state.queued += 1;

        // Keep admission state and the nonblocking command enqueue atomic with
        // respect to shutdown. A caller either owns a command in the bounded
        // queue or gets its entry removed before another submit can observe it.
        let command_closed = match inner
            .commands
            .try_send(BackgroundFillCommand::Start(key.clone()))
        {
            Ok(()) => return BackgroundFillAdmission::Accepted,
            Err(mpsc::error::TrySendError::Full(_)) => false,
            Err(mpsc::error::TrySendError::Closed(_)) => true,
        };

        if let Some(entry) = state.entries.remove(&key)
            && entry.state == BackgroundFillEntryState::Queued
        {
            state.queued = state.queued.saturating_sub(1);
        }
        if command_closed {
            state.closed = true;
            BackgroundFillAdmission::Closed
        } else if state.closed {
            BackgroundFillAdmission::Closed
        } else {
            BackgroundFillAdmission::QueueSaturated
        }
    }

    /// Close admissions, cancel queued work, drain active atomic operations,
    /// and join all terminal telemetry reports before returning.
    pub(crate) async fn shutdown(&self) {
        {
            let mut state = self
                .lifecycle
                .inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.closed {
                return;
            }
            state.closed = true;
        }
        let supervisor = self
            .lifecycle
            .supervisor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(supervisor) = supervisor else {
            return;
        };

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
    }

    #[cfg(test)]
    fn is_closed_for_test(&self) -> bool {
        self.lifecycle
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .closed
    }

    #[cfg(test)]
    pub(crate) async fn wait_idle_for_test(&self) {
        loop {
            let (send, receive) = oneshot::channel();
            self.lifecycle
                .inner
                .commands
                .send(BackgroundFillCommand::Checkpoint(send))
                .await
                .unwrap();
            if receive.await.unwrap() == (0, 0) {
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
        self.inner.shutdown.cancel();
        if let Some(supervisor) = self
            .supervisor
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            supervisor.abort();
        }
    }
}

async fn run_background_fill_supervisor(
    inner: Arc<BackgroundFillCoordinatorInner>,
    mut receiver: mpsc::Receiver<BackgroundFillCommand>,
) {
    let mut pending = VecDeque::new();
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
            let Some(key) = pending.pop_front() else {
                break;
            };
            let Some(work) = take_background_fill_work(&inner, &key) else {
                continue;
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
                    Some(BackgroundFillCommand::Start(key)) => pending.push_back(key),
                    #[cfg(test)]
                    Some(BackgroundFillCommand::Checkpoint(complete)) => {
                        // Earlier Start commands have passed the admission loop above.
                        let _ = complete.send((workers.len(), pending.len()));
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
    key: &(String, String),
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
    let (group, home, action) = {
        let entry = state.entries.get_mut(key)?;
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
    state.queued = state.queued.saturating_sub(1);
    Some(BackgroundFillWork {
        key: key.clone(),
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
    let queued_keys = state
        .entries
        .iter()
        .filter_map(|(key, entry)| {
            (entry.state == BackgroundFillEntryState::Queued).then_some(key.clone())
        })
        .collect::<Vec<_>>();
    let mut subscribers = Vec::new();
    for key in queued_keys {
        if let Some(entry) = state.entries.remove(&key) {
            state.queued = state.queued.saturating_sub(1);
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
        ) && let BackgroundFillAction::Fill(Some(decoded)) = &work.action
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

struct FreshArchivePhaseRecord {
    operation: SandboxOpRecord,
    completed_at: DateTime<Utc>,
}

/// At most four phases for each of the four archives admitted to one delivery.
/// Records live outside fetch tasks so aborting and joining those tasks retains
/// their last observed phase. Draining never holds the lock while recording
/// telemetry.
#[derive(Clone, Default)]
struct FreshArchivePhaseRecords {
    records: Arc<Mutex<Vec<FreshArchivePhaseRecord>>>,
}

impl FreshArchivePhaseRecords {
    fn record_to(&self, telemetry: &mut JobTelemetry) {
        let records = std::mem::take(
            &mut *self
                .records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        for record in records {
            let operation = record.operation;
            telemetry.record_at(
                operation.action_type,
                operation.duration,
                operation.success,
                operation.error,
                record.completed_at,
            );
        }
    }
}

struct FreshArchivePhaseGuard {
    records: FreshArchivePhaseRecords,
    action_type: Option<&'static str>,
    started_at: Instant,
}

impl FreshArchivePhaseGuard {
    fn new(records: &FreshArchivePhaseRecords, action_type: &'static str) -> Self {
        Self {
            records: records.clone(),
            action_type: Some(action_type),
            started_at: Instant::now(),
        }
    }

    fn finish(mut self, result: Result<(), &'static str>) {
        self.record(result);
    }

    fn record(&mut self, result: Result<(), &'static str>) {
        let Some(action_type) = self.action_type.take() else {
            return;
        };
        let record = FreshArchivePhaseRecord {
            operation: SandboxOpRecord::new(
                action_type,
                self.started_at.elapsed(),
                result.is_ok(),
                result.err(),
            ),
            completed_at: Utc::now(),
        };
        self.records
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(record);
    }
}

impl Drop for FreshArchivePhaseGuard {
    fn drop(&mut self) {
        // Cancellation, task abort and unwinding all mean the phase did not
        // reach an observed terminal result. Do not fabricate successful time.
        self.record(Err("interrupted"));
    }
}

struct FreshArchiveDownloaded {
    group: CacheTargetGroup,
    bytes: Bytes,
    size_source: FreshArchiveSizeSource,
    writer: nix::fcntl::Flock<std::fs::File>,
    permit: OwnedSemaphorePermit,
}

#[derive(Clone, Copy)]
enum FreshArchiveSizeSource {
    Manifest,
    Response,
}

enum FreshArchiveFetchTaskResult {
    Downloaded(FreshArchiveDownloaded),
    Terminal { reason: &'static str },
}

struct FreshArchivePublicationTaskResult {
    group: CacheTargetGroup,
    result: RunnerResult<FreshArchivePublished>,
}

struct FreshArchivePublished {
    bytes: Bytes,
    permit: OwnedSemaphorePermit,
}

struct FreshArchiveResolved {
    group: CacheTargetGroup,
    archive: FreshArchivePublished,
}

/// In-flight runner ownership for archives selected from one storage plan.
///
/// Fetch tasks start during fresh or reused pre-spawn preparation, but a
/// completed fetch waits on its apply gate until guest storage application
/// resolves this delivery. The delivery then owns any atomic cache publication
/// tasks until they finish.
///
/// Callers must either pass this value with its original plan to
/// `populate_cache_with_fresh_delivery` or call
/// [`Self::cancel_and_drain`] before abandoning or replacing that plan.
/// Implicit `Drop` is not equivalent cleanup: it aborts fetches but detaches
/// already-started publication so an atomic fsync/rename transaction is not
/// cancelled midway.
pub(crate) struct FreshArchiveDelivery {
    cancel: CancellationToken,
    phase_records: FreshArchivePhaseRecords,
    classification: JoinSet<FreshArchiveClassification>,
    groups: Option<Vec<CacheTargetGroup>>,
    apply: Vec<oneshot::Sender<()>>,
    fetches: JoinSet<FreshArchiveFetchTaskResult>,
    publications: JoinSet<FreshArchivePublicationTaskResult>,
}

struct FreshArchiveClassification {
    groups: Vec<CacheTargetGroup>,
    apply: Vec<oneshot::Sender<()>>,
    fetches: JoinSet<FreshArchiveFetchTaskResult>,
    metrics: CacheProcessMetrics,
    summary: FreshDeliveryScanSummary,
    result: RunnerResult<()>,
}

/// A storage plan paired with the delivery prepared for its plan inputs.
///
/// The plan and delivery must remain together. A retry that changes the
/// workspace-image selection must drain the previous delivery and rebuild both
/// values; a retry such as DNS-only sandbox replacement may retain the pair
/// when the plan inputs are unchanged.
pub(crate) struct PreparedStorage {
    pub(crate) plan: StoragePlan,
    pub(crate) delivery: FreshArchiveDelivery,
}

impl Drop for FreshArchiveDelivery {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.classification.abort_all();
        self.fetches.abort_all();
        // Cache publication is an atomic fsync/rename transaction. Explicit
        // lifecycle paths drain it below; an unexpected owner drop must let an
        // already-started transaction finish instead of cancelling it midway.
        // An unexpected owner drop also loses buffered phase telemetry; normal
        // lifecycle paths await cleanup and drain these records explicitly.
        self.publications.detach_all();
    }
}

impl FreshArchiveDelivery {
    async fn finish_classification(&mut self, telemetry: &mut JobTelemetry) -> RunnerResult<()> {
        let Some(task) = self.classification.join_next().await else {
            return Ok(());
        };
        let classified = task.map_err(|error| {
            RunnerError::Internal(format!("runner-owned archive classification task: {error}"))
        })?;
        classified.metrics.record_to(telemetry);
        classified
            .summary
            .record(telemetry, classified.result.is_ok());
        self.groups = Some(classified.groups);
        self.apply = classified.apply;
        self.fetches = classified.fetches;
        classified.result
    }

    /// Cancels and awaits delivery work when its prepared plan will not be applied.
    ///
    /// Callers use this for sandbox preparation failure, replacement after a
    /// workspace-image retry, a plan with no guest work, pre-spawn failure, or
    /// cancellation. It closes pending apply gates, aborts and joins fetch
    /// tasks, and then waits for publication tasks that have already started.
    /// Fetches can be cancelled before publication, but an atomic fsync/rename
    /// transaction must be allowed to finish.
    ///
    /// Unlike implicit `Drop`, this keeps publication in normal awaited
    /// teardown and records cancellation and drain telemetry when owned work
    /// exists.
    pub(crate) async fn cancel_and_drain(&mut self, telemetry: &mut JobTelemetry) {
        let started_at = Instant::now();
        let had_owned_work = !self.classification.is_empty()
            || !self.apply.is_empty()
            || !self.fetches.is_empty()
            || !self.publications.is_empty();
        self.cancel.cancel();
        // The classifier owns its fetch tasks until this join. Transfer that
        // ownership before draining; no classifier or download is detached.
        if let Err(error) = self.finish_classification(telemetry).await
            && !matches!(error, RunnerError::Cancelled)
        {
            warn!(%error, "runner-owned archive classification failed while draining");
        }
        if had_owned_work {
            telemetry.record(
                STORAGE_CACHE_FRESH_DELIVERY_CANCELLED,
                Duration::ZERO,
                true,
                None,
            );
        }
        self.apply.clear();
        self.fetches.abort_all();
        while let Some(result) = self.fetches.join_next().await {
            if let Err(error) = result
                && !error.is_cancelled()
            {
                warn!(%error, "runner-owned archive fetch task failed while draining");
            }
        }
        // Once a complete response enters publication, wait for the atomic
        // cache transaction even when the run itself has been cancelled.
        while let Some(result) = self.publications.join_next().await {
            if let Err(error) = result {
                warn!(%error, "runner-owned archive publication task failed while draining");
            }
        }
        self.phase_records.record_to(telemetry);
        if had_owned_work {
            telemetry.record(
                STORAGE_CACHE_FRESH_DELIVERY_DRAINED,
                started_at.elapsed(),
                true,
                None,
            );
        }
    }

    async fn resolve(
        &mut self,
        home: &HomePaths,
        telemetry: &mut JobTelemetry,
    ) -> RunnerResult<Vec<FreshArchiveResolved>> {
        let result = self.resolve_inner(home, telemetry).await;
        if result.is_err() {
            self.cancel_and_drain(telemetry).await;
        }
        self.phase_records.record_to(telemetry);
        result
    }

    async fn resolve_inner(
        &mut self,
        home: &HomePaths,
        telemetry: &mut JobTelemetry,
    ) -> RunnerResult<Vec<FreshArchiveResolved>> {
        self.finish_classification(telemetry).await?;
        for apply in self.apply.drain(..) {
            let _ = apply.send(());
        }

        let mut resolved = Vec::new();
        while let Some(task) = self.fetches.join_next().await {
            match task.map_err(|error| {
                RunnerError::Internal(format!("runner-owned archive fetch task: {error}"))
            })? {
                FreshArchiveFetchTaskResult::Downloaded(downloaded) => {
                    telemetry.record(
                        STORAGE_CACHE_FRESH_DELIVERY_COMPLETE,
                        Duration::ZERO,
                        true,
                        None,
                    );
                    let FreshArchiveDownloaded {
                        group,
                        bytes,
                        size_source,
                        writer,
                        permit,
                    } = downloaded;
                    telemetry.record(
                        match size_source {
                            FreshArchiveSizeSource::Manifest => {
                                STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST
                            }
                            FreshArchiveSizeSource::Response => {
                                STORAGE_CACHE_FRESH_DELIVERY_SIZE_RESPONSE
                            }
                        },
                        Duration::ZERO,
                        true,
                        None,
                    );
                    let target = group.targets.first().ok_or_else(|| {
                        RunnerError::Internal("empty runner-owned archive target group".to_string())
                    })?;
                    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
                    let phase_records = self.phase_records.clone();
                    self.publications.spawn(async move {
                        let _writer = writer;
                        let phase = FreshArchivePhaseGuard::new(
                            &phase_records,
                            STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION,
                        );
                        let result = write_to_cache(&cache_dir, &bytes)
                            .await
                            .map(|()| FreshArchivePublished { bytes, permit });
                        phase.finish(result.as_ref().map(|_| ()).map_err(|_| "publication"));
                        FreshArchivePublicationTaskResult { group, result }
                    });
                }
                FreshArchiveFetchTaskResult::Terminal { reason } => {
                    let action = if reason == "cancelled" {
                        STORAGE_CACHE_FRESH_DELIVERY_CANCELLED
                    } else {
                        STORAGE_CACHE_FRESH_DELIVERY_FAILED
                    };
                    telemetry.record(action, Duration::ZERO, reason == "cancelled", Some(reason));
                    return Err(if reason == "cancelled" {
                        RunnerError::Cancelled
                    } else {
                        RunnerError::Internal(format!(
                            "runner-owned archive download failed: {reason}"
                        ))
                    });
                }
            }
        }

        while let Some(task) = self.publications.join_next().await {
            let task = task.map_err(|error| {
                RunnerError::Internal(format!("runner-owned archive publication task: {error}"))
            })?;
            match task.result {
                Ok(archive) => {
                    telemetry.record(
                        STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED,
                        Duration::ZERO,
                        true,
                        None,
                    );
                    resolved.push(FreshArchiveResolved {
                        group: task.group,
                        archive,
                    });
                }
                Err(error) => {
                    telemetry.record(
                        STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION_FAILED,
                        Duration::ZERO,
                        false,
                        Some("publication"),
                    );
                    return Err(error);
                }
            }
        }
        Ok(resolved)
    }
}

/// Cold cache work selected during storage planning but not yet started.
///
/// Before [`Self::start`], this value owns archive URLs but no HTTP client,
/// task, cache lock, or file, so dropping it on a pre-spawn failure requires
/// no asynchronous cleanup.
#[must_use = "deferred storage cache fill must be started after agent spawn or explicitly dropped"]
pub(crate) struct DeferredBackgroundFill {
    groups: Vec<(CacheTargetGroup, BackgroundFillAction)>,
    home: HomePaths,
    selected_at: Instant,
}

impl DeferredBackgroundFill {
    #[cfg(test)]
    async fn run(self) -> Vec<SandboxOpRecord> {
        run_background_fill_groups(self.groups, self.home).await
    }

    pub(crate) fn start(
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
        for (group, action) in self.groups {
            match coordinator.submit(group, self.home.clone(), reporter.clone(), action) {
                BackgroundFillAdmission::Accepted => accepted += 1,
                BackgroundFillAdmission::Deduplicated => telemetry.record(
                    STORAGE_CACHE_BACKGROUND_FILL_DEDUPLICATED,
                    Duration::ZERO,
                    true,
                    None,
                ),
                BackgroundFillAdmission::QueueSaturated => telemetry.record(
                    STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED,
                    Duration::ZERO,
                    true,
                    Some("queue-capacity"),
                ),
                BackgroundFillAdmission::Closed => telemetry.record(
                    STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_CANCELLED,
                    Duration::ZERO,
                    false,
                    Some(STORAGE_CACHE_BACKGROUND_FILL_SHUTDOWN_ERROR),
                ),
            }
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

struct ProcessedGroup {
    outcome: TargetOutcome,
    stage_write: Option<GuestStageWrite>,
}

struct ProcessedTarget {
    outcome: TargetOutcome,
    stage_write: Option<GuestStageWrite>,
}

struct GuestStageWrite {
    guest_path: String,
    bytes: Bytes,
}

#[derive(Default)]
struct GuestStageBatch {
    writes: Vec<GuestStageWrite>,
    content_bytes: usize,
}

#[derive(Default)]
struct FreshGuestStageBatch {
    groups: Vec<CacheTargetGroup>,
    writes: Vec<GuestStageWrite>,
    permits: Vec<OwnedSemaphorePermit>,
    content_bytes: usize,
}

/// Aggregates actual guest write time, excluding cache probe/download work.
struct StorageCacheStageMetrics {
    total_duration: Duration,
    attempted: bool,
    failed: bool,
}

struct CacheProcessMetric {
    action_type: &'static str,
    duration: Duration,
    success: bool,
    error: Option<&'static str>,
}

#[derive(Default)]
struct CacheProcessMetrics {
    records: Vec<CacheProcessMetric>,
}

impl CacheProcessMetrics {
    fn record(
        &mut self,
        action_type: &'static str,
        duration: Duration,
        success: bool,
        error: Option<&'static str>,
    ) {
        self.records.push(CacheProcessMetric {
            action_type,
            duration,
            success,
            error,
        });
    }

    fn record_to(self, telemetry: &mut JobTelemetry) {
        for record in self.records {
            telemetry.record(
                record.action_type,
                record.duration,
                record.success,
                record.error,
            );
        }
    }
}

struct GuestStageRecorder<'a> {
    sandbox: &'a dyn Sandbox,
    guest_writes: &'a GuestWriteLocks,
    telemetry: &'a mut JobTelemetry,
    metrics: &'a mut StorageCacheStageMetrics,
}

struct ProcessedGroupTask {
    group: CacheTargetGroup,
    metrics: CacheProcessMetrics,
    processed: RunnerResult<ProcessedGroup>,
}

/// Pin admitted extracted files before deciding whether an archive is needed.
/// A plan makes this decision once: later population must not refetch selected
/// entries after disk eviction or redo a miss after prefetch has already begun.
async fn prepare_decoded_storage(
    plan: &mut StoragePlan,
    groups: &[CacheTargetGroup],
    cache: &decoded::DecodedCache,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if plan.decoded_prepared() {
        return Ok(());
    }
    for batch in groups.chunks(decoded::LOOKUP_BATCH_SIZE) {
        let keys = batch
            .iter()
            .map(|group| {
                group.targets.first().and_then(|target| {
                    is_ordinary_storage_group(group, plan)
                        .then_some((target.name.as_str(), target.version.as_str()))
                })
            })
            .collect::<Vec<_>>();
        let started = Instant::now();
        let result = cache.get_ready_batch(&keys).await;
        telemetry.record(
            "storage_cache_decode_lookup",
            started.elapsed(),
            result.is_ok(),
            None,
        );
        let ready = result.map_err(|error| {
            RunnerError::Internal(format!("lookup extracted storage cache: {error}"))
        })?;
        for (group, files) in batch.iter().zip(ready) {
            reuse_decoded(plan, group, files)?;
        }
    }
    plan.finish_decoded_preparation();
    Ok(())
}

fn reuse_decoded(
    plan: &mut StoragePlan,
    group: &CacheTargetGroup,
    files: Option<Arc<decoded::CachedFiles>>,
) -> RunnerResult<bool> {
    let Some(files) = files else {
        return Ok(false);
    };
    // Check mounts only on a ready hit. Misses keep ordinary delivery.
    let Some(mounts) = group
        .targets
        .iter()
        .map(|target| plan.decoded_mount(target.handle).map(str::to_owned))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(false);
    };
    for target in &group.targets {
        if !plan.decoded_entry_fits(target.handle)? {
            return Ok(false);
        }
    }
    let added = mounts
        .iter()
        .map(|mount| {
            8 + mount.len()
                + files
                    .files
                    .iter()
                    .map(|file| 20 + file.path.len() + file.content.len())
                    .sum::<usize>()
        })
        .sum::<usize>();
    if plan.decoded_bytes() + added + 4 > guest_contracts::storage_files::MAX_PAYLOAD_BYTES
        || plan.decoded_mount_count() + mounts.len() > guest_contracts::storage_files::MAX_MOUNTS
    {
        return Ok(false);
    }
    for mount in mounts {
        plan.add_decoded(mount, Arc::clone(&files));
    }
    Ok(true)
}

type ProcessedGroupTaskResult = ProcessedGroupTask;

enum TargetOutcome {
    Hit,
    Decoded,
    MissPassthrough { reason: &'static str },
    LockBusyPassthrough,
}

enum DownloadBody {
    Complete(Bytes),
    Empty,
    OverSize { observed_size: u64 },
}

enum CachedArchive {
    Hit(Bytes),
    Missing,
    Empty,
    OverSize { observed_size: u64 },
}

enum CacheFetchOutcome {
    Downloaded(Bytes),
    Unavailable,
    Skipped,
}

enum BackgroundFillOutcome {
    ArchiveRetirement { retired: bool },
    Filled { size: u64 },
    AlreadyCached { size: u64 },
    Busy,
    Skipped,
    Unavailable,
}

struct BackgroundFillReport {
    outcome: SandboxOpRecord,
    size_bucket: Option<SandboxOpRecord>,
}

impl BackgroundFillReport {
    fn from_outcome(outcome: BackgroundFillOutcome, duration: Duration) -> Self {
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

    fn failed(duration: Duration) -> Self {
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

    fn into_records(self) -> Vec<SandboxOpRecord> {
        let mut records = vec![self.outcome];
        if let Some(size_bucket) = self.size_bucket {
            records.push(size_bucket);
        }
        records
    }
}

#[derive(Default)]
struct GuestWriteLocks {
    inner: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl GuestWriteLocks {
    async fn write_files(
        &self,
        sandbox: &dyn Sandbox,
        writes: &[GuestStageWrite],
    ) -> RunnerResult<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let mut paths = writes
            .iter()
            .map(|write| write.guest_path.as_str())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        paths.dedup();
        let locks = {
            let mut lock_map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            paths
                .into_iter()
                .map(|path| {
                    Arc::clone(
                        lock_map
                            .entry(path.to_string())
                            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut guards = Vec::with_capacity(locks.len());
        for lock in &locks {
            guards.push(lock.lock().await);
        }
        let entries = writes
            .iter()
            .map(|write| WriteFileEntry {
                path: write.guest_path.as_str(),
                content: write.bytes.as_ref(),
            })
            .collect::<Vec<_>>();
        sandbox.write_files(&entries).await?;
        Ok(())
    }
}

impl GuestStageBatch {
    fn should_flush_before(&self, write: &GuestStageWrite) -> bool {
        !self.writes.is_empty()
            && (self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
                || self.content_bytes.saturating_add(write.bytes.len())
                    > GUEST_STAGE_BATCH_MAX_BYTES)
    }

    fn push(&mut self, write: GuestStageWrite) {
        self.content_bytes += write.bytes.len();
        self.writes.push(write);
    }

    fn should_flush_after_push(&self) -> bool {
        self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
            || self.content_bytes >= GUEST_STAGE_BATCH_MAX_BYTES
    }
}

impl FreshGuestStageBatch {
    fn should_flush_before(&self, write: &GuestStageWrite) -> bool {
        !self.writes.is_empty()
            && (self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
                || self.content_bytes.saturating_add(write.bytes.len())
                    > GUEST_STAGE_BATCH_MAX_BYTES)
    }

    fn push(
        &mut self,
        group: CacheTargetGroup,
        write: GuestStageWrite,
        permit: OwnedSemaphorePermit,
    ) {
        self.content_bytes += write.bytes.len();
        self.groups.push(group);
        self.writes.push(write);
        self.permits.push(permit);
    }

    fn should_flush_after_push(&self) -> bool {
        self.writes.len() >= GUEST_STAGE_BATCH_MAX_FILES
            || self.content_bytes >= GUEST_STAGE_BATCH_MAX_BYTES
    }
}

impl StorageCacheStageMetrics {
    fn start() -> Self {
        Self {
            total_duration: Duration::ZERO,
            attempted: false,
            failed: false,
        }
    }

    fn record_write_result(
        &mut self,
        telemetry: &mut JobTelemetry,
        action_type: &str,
        started_at: Instant,
        result: &RunnerResult<()>,
    ) {
        self.attempted = true;
        let duration = started_at.elapsed();
        self.total_duration = self.total_duration.saturating_add(duration);
        let success = result.is_ok();
        if !success {
            self.failed = true;
        }
        telemetry.record(
            action_type,
            duration,
            success,
            (!success).then_some(STORAGE_CACHE_STAGE_FAILED),
        );
    }

    fn record_total(&self, telemetry: &mut JobTelemetry) {
        if self.attempted {
            let success = !self.failed;
            telemetry.record(
                STORAGE_CACHE_STAGE_TOTAL,
                self.total_duration,
                success,
                (!success).then_some(STORAGE_CACHE_STAGE_FAILED),
            );
        }
    }
}

async fn flush_guest_stage_batch(
    batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    if batch.writes.is_empty() {
        return Ok(());
    }
    let started_at = Instant::now();
    let result = stage
        .guest_writes
        .write_files(stage.sandbox, &batch.writes)
        .await;
    stage.metrics.record_write_result(
        stage.telemetry,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        started_at,
        &result,
    );
    result?;
    batch.writes.clear();
    batch.content_bytes = 0;
    Ok(())
}

async fn push_guest_stage_write(
    batch: &mut GuestStageBatch,
    write: GuestStageWrite,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    if batch.should_flush_before(&write) {
        flush_guest_stage_batch(batch, stage).await?;
    }
    batch.push(write);
    if batch.should_flush_after_push() {
        flush_guest_stage_batch(batch, stage).await?;
    }
    Ok(())
}

async fn flush_fresh_guest_stage_batch(
    batch: &mut FreshGuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
    outcomes: &mut Vec<(CacheTargetGroup, TargetOutcome)>,
) -> RunnerResult<()> {
    if batch.writes.is_empty() {
        return Ok(());
    }
    let started_at = Instant::now();
    let result = stage
        .guest_writes
        .write_files(stage.sandbox, &batch.writes)
        .await;
    stage.metrics.record_write_result(
        stage.telemetry,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        started_at,
        &result,
    );
    result?;
    for group in batch.groups.drain(..) {
        stage.telemetry.record(
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            Duration::ZERO,
            true,
            None,
        );
        outcomes.push((group, TargetOutcome::Hit));
    }
    batch.writes.clear();
    batch.permits.clear();
    batch.content_bytes = 0;
    Ok(())
}

async fn stage_fresh_archives(
    resolved: Vec<FreshArchiveResolved>,
    sandbox: &dyn Sandbox,
    telemetry: &mut JobTelemetry,
    guest_writes: &GuestWriteLocks,
    stage_metrics: &mut StorageCacheStageMetrics,
) -> RunnerResult<Vec<(CacheTargetGroup, TargetOutcome)>> {
    let mut outcomes = Vec::with_capacity(resolved.len());
    let mut batch = FreshGuestStageBatch::default();
    let mut stage = GuestStageRecorder {
        sandbox,
        guest_writes,
        telemetry,
        metrics: stage_metrics,
    };
    for FreshArchiveResolved { group, archive } in resolved {
        let FreshArchivePublished { bytes, permit } = archive;
        let target = group.targets.first().ok_or_else(|| {
            RunnerError::Internal("empty runner-owned archive target group".to_string())
        })?;
        let write = GuestStageWrite {
            guest_path: guest_archive_path(&target.name, &target.version),
            bytes,
        };
        if batch.should_flush_before(&write) {
            flush_fresh_guest_stage_batch(&mut batch, &mut stage, &mut outcomes).await?;
        }
        batch.push(group, write, permit);
        if batch.should_flush_after_push() {
            flush_fresh_guest_stage_batch(&mut batch, &mut stage, &mut outcomes).await?;
        }
    }
    flush_fresh_guest_stage_batch(&mut batch, &mut stage, &mut outcomes).await?;
    Ok(outcomes)
}

async fn abort_pending_processed_groups(groups: &mut JoinSet<ProcessedGroupTaskResult>) {
    groups.abort_all();
    while groups.join_next().await.is_some() {}
}

async fn join_next_processed_group(
    groups: &mut JoinSet<ProcessedGroupTaskResult>,
) -> RunnerResult<Option<ProcessedGroupTaskResult>> {
    match groups.join_next().await {
        Some(Ok(result)) => Ok(Some(result)),
        Some(Err(error)) => {
            abort_pending_processed_groups(groups).await;
            Err(RunnerError::Internal(format!(
                "storage cache group task failed: {error}"
            )))
        }
        None => Ok(None),
    }
}

async fn stage_processed_group(
    group: CacheTargetGroup,
    processed: ProcessedGroup,
    outcomes: &mut Vec<(CacheTargetGroup, TargetOutcome)>,
    stage_batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    let ProcessedGroup {
        outcome,
        stage_write,
    } = processed;
    if let Some(stage_write) = stage_write {
        push_guest_stage_write(stage_batch, stage_write, stage).await?;
    }
    outcomes.push((group, outcome));
    Ok(())
}

async fn stage_joined_processed_group(
    groups: &mut JoinSet<ProcessedGroupTaskResult>,
    task: ProcessedGroupTask,
    outcomes: &mut Vec<(CacheTargetGroup, TargetOutcome)>,
    stage_batch: &mut GuestStageBatch,
    stage: &mut GuestStageRecorder<'_>,
) -> RunnerResult<()> {
    let ProcessedGroupTask {
        group,
        metrics,
        processed,
    } = task;
    metrics.record_to(stage.telemetry);
    let processed = match processed {
        Ok(processed) => processed,
        Err(error) => {
            abort_pending_processed_groups(groups).await;
            return Err(error);
        }
    };
    if let Err(error) = stage_processed_group(group, processed, outcomes, stage_batch, stage).await
    {
        abort_pending_processed_groups(groups).await;
        return Err(error);
    }
    Ok(())
}

/// Resolves eligible archive sources against the runner-side cache.
///
/// Warm hits are staged into the guest over vsock, and their sources in
/// `plan` are rewritten to guest-local `file://` URLs before this function
/// returns. Sources without a usable warm hit keep their original remote URLs
/// for the current guest download. Eligible cold misses may be returned as
/// deferred fill work for future runs; this function does not start those
/// remote fill requests.
///
/// # Returns
///
/// Returns `Ok(Some(...))` when a [`DeferredBackgroundFill`] was selected. The
/// caller must retain it through pre-spawn setup and call
/// [`DeferredBackgroundFill::start`] only after the agent process has spawned;
/// an earlier failure deliberately drops it without starting work. Returns
/// `Ok(None)` when no deferred fill work was selected.
///
/// Reuse, repair, empty, instruction, cleanup, and guest-work semantics remain
/// owned by [`StoragePlan`].
#[cfg(test)]
pub async fn populate_cache(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    populate_cache_with_fresh_delivery(plan, sandbox, home, telemetry, None, None).await
}

pub(crate) async fn populate_cache_with_fresh_delivery(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
    fresh_delivery: Option<&mut FreshArchiveDelivery>,
    decoded: Option<&decoded::DecodedCache>,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    let mut fresh_delivery = fresh_delivery;
    let target_groups = if let Some(delivery) = fresh_delivery.as_mut() {
        if let Err(error) = delivery.finish_classification(telemetry).await {
            delivery.cancel_and_drain(telemetry).await;
            return Err(error);
        }
        delivery.groups.take().ok_or_else(|| {
            RunnerError::Internal("prepared archive groups already consumed".into())
        })?
    } else {
        group_targets(collect_targets(plan.cache_candidates()))
    };
    if let Some(cache) = decoded {
        prepare_decoded_storage(plan, &target_groups, cache, telemetry).await?;
    }
    if target_groups.is_empty() && fresh_delivery.is_none() {
        return Ok(None);
    }

    let guest_writes = GuestWriteLocks::default();
    let mut stage_metrics = StorageCacheStageMetrics::start();
    let mut outcomes = if let Some(delivery) = fresh_delivery {
        let resolved = delivery.resolve(home, telemetry).await?;
        stage_fresh_archives(
            resolved,
            sandbox,
            telemetry,
            &guest_writes,
            &mut stage_metrics,
        )
        .await?
    } else {
        Vec::new()
    };
    let owned_keys = outcomes
        .iter()
        .filter_map(|(group, _)| group_key(group))
        .collect::<HashSet<_>>();
    let target_groups = target_groups
        .into_iter()
        .filter(|group| group_key(group).is_none_or(|key| !owned_keys.contains(&key)))
        .filter_map(|group| {
            if group_has_decoded(&group, plan) {
                outcomes.push((group, TargetOutcome::Decoded));
                None
            } else {
                Some(group)
            }
        })
        .collect::<Vec<_>>();

    // Cache population runs in owned tasks so a slow guest staging write does
    // not stop already-started workers from releasing host cache flocks. Failure
    // paths explicitly abort and drain pending workers so locks are not left for
    // the runtime to clean up later.
    let mut groups = JoinSet::new();
    let stage_result: RunnerResult<Vec<(CacheTargetGroup, TargetOutcome)>> = async {
        let mut stage_batch = GuestStageBatch::default();
        let mut stage = GuestStageRecorder {
            sandbox,
            guest_writes: &guest_writes,
            telemetry,
            metrics: &mut stage_metrics,
        };

        for group in target_groups {
            while groups.len() >= CONCURRENCY {
                let Some(task) = join_next_processed_group(&mut groups).await? else {
                    break;
                };
                stage_joined_processed_group(
                    &mut groups,
                    task,
                    &mut outcomes,
                    &mut stage_batch,
                    &mut stage,
                )
                .await?;
            }

            let home = home.clone();
            groups.spawn(async move {
                let mut metrics = CacheProcessMetrics::default();
                let started_at = Instant::now();
                let processed = process_group_hit_or_passthrough(&group, &home, &mut metrics).await;
                let success = processed.is_ok();
                metrics.record(
                    STORAGE_CACHE_PROCESS_GROUP,
                    started_at.elapsed(),
                    success,
                    (!success).then_some(STORAGE_CACHE_PROCESS_GROUP_FAILED),
                );
                ProcessedGroupTask {
                    group,
                    metrics,
                    processed,
                }
            });
        }

        while let Some(task) = join_next_processed_group(&mut groups).await? {
            stage_joined_processed_group(
                &mut groups,
                task,
                &mut outcomes,
                &mut stage_batch,
                &mut stage,
            )
            .await?;
        }
        flush_guest_stage_batch(&mut stage_batch, &mut stage).await?;
        Ok(outcomes)
    }
    .await;
    stage_metrics.record_total(telemetry);
    let outcomes = stage_result?;

    record_passthrough_summary(&outcomes, telemetry);
    let deferred =
        defer_background_fill_groups(&outcomes, home.clone(), decoded.cloned(), plan, telemetry);
    for (group, outcome) in outcomes {
        apply_group_outcome(plan, &group, &outcome, telemetry);
    }
    Ok(deferred)
}

fn group_key(group: &CacheTargetGroup) -> Option<(String, String)> {
    group
        .targets
        .first()
        .map(|target| (target.name.clone(), target.version.clone()))
}

fn is_ordinary_storage_group(group: &CacheTargetGroup, plan: &StoragePlan) -> bool {
    !group.targets.is_empty()
        && group
            .targets
            .iter()
            .all(|target| plan.is_ordinary_storage_download(target.handle))
}

fn group_has_decoded(group: &CacheTargetGroup, plan: &StoragePlan) -> bool {
    !group.targets.is_empty()
        && group
            .targets
            .iter()
            .all(|target| plan.has_decoded(target.handle))
}

fn defer_background_fill_groups(
    outcomes: &[(CacheTargetGroup, TargetOutcome)],
    home: HomePaths,
    decoded: Option<decoded::DecodedCache>,
    plan: &StoragePlan,
    telemetry: &mut JobTelemetry,
) -> Option<DeferredBackgroundFill> {
    let groups = outcomes
        .iter()
        .filter_map(|(group, outcome)| {
            let decoded = decoded
                .as_ref()
                .filter(|_| is_ordinary_storage_group(group, plan));
            let action = if matches!(outcome, TargetOutcome::Decoded) {
                if !group
                    .targets
                    .iter()
                    .any(|target| plan.decoded_archive_retirement_candidate(target.handle))
                {
                    return None;
                }
                BackgroundFillAction::RetireArchive(decoded?.clone())
            } else if should_background_fill(outcome)
                || (decoded.is_some() && matches!(outcome, TargetOutcome::Hit))
            {
                BackgroundFillAction::Fill(decoded.cloned())
            } else {
                return None;
            };
            Some((group.clone(), action))
        })
        .collect::<Vec<_>>();
    if groups.is_empty() {
        return None;
    }

    let selected_at = Instant::now();
    telemetry.record(
        background_fill_deferred_count_action(groups.len()),
        Duration::ZERO,
        true,
        None,
    );
    Some(DeferredBackgroundFill {
        groups,
        home,
        selected_at,
    })
}

fn should_background_fill(outcome: &TargetOutcome) -> bool {
    matches!(outcome, TargetOutcome::MissPassthrough { .. })
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
                key: group_key(&group).unwrap(),
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

fn group_targets(targets: Vec<CacheTarget>) -> Vec<CacheTargetGroup> {
    let mut group_order = Vec::new();
    let mut groups_by_key: HashMap<(String, String), Vec<CacheTarget>> = HashMap::new();

    for target in targets {
        let key = (target.name.clone(), target.version.clone());
        match groups_by_key.entry(key.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().push(target);
            }
            Entry::Vacant(entry) => {
                group_order.push(key);
                entry.insert(vec![target]);
            }
        }
    }

    let mut groups = Vec::with_capacity(group_order.len());
    for key in group_order {
        if let Some(targets) = groups_by_key.remove(&key) {
            let archive_size = reconcile_archive_size(&targets);
            groups.push(CacheTargetGroup {
                targets,
                archive_size,
            });
        }
    }
    groups
}

fn reconcile_archive_size(targets: &[CacheTarget]) -> Option<u64> {
    let mut known_size = None;
    for size in targets
        .iter()
        .filter_map(|target| target.archive_size)
        .filter(|size| *size > 0)
    {
        match known_size {
            None => known_size = Some(size),
            Some(known) if known == size => {}
            Some(_) => return None,
        }
    }
    known_size
}

fn collect_targets(candidates: Vec<CacheArchiveCandidate>) -> Vec<CacheTarget> {
    candidates
        .into_iter()
        .filter_map(|candidate| {
            cache_target_from_entry(
                candidate.handle,
                &candidate.archive_url,
                &candidate.name,
                &candidate.version,
                candidate.archive_size,
            )
        })
        .collect()
}

/// Starts bounded runner-owned archive delivery for one storage plan.
///
/// The executor calls this after previous-storage selection fixes the plan and
/// before fresh or reused sandbox preparation, allowing eligible full-archive
/// fetches to overlap pre-spawn work. An owned classifier inspects the required
/// groups with bounded concurrency alongside sandbox creation, admits at most
/// `FRESH_DELIVERY_PER_RUN_LIMIT`, and draws each admission from the shared
/// `FRESH_DELIVERY_RUNNER_LIMIT`.
///
/// Each admitted group acquires its cache-writer flock before fetching. After
/// validating a complete response, the fetch waits on a one-shot apply gate;
/// resolving the delivery opens that gate only when guest storage application
/// begins. The writer stays owned through atomic cache publication. Successful
/// publication transfers the runner-wide permit and complete body into guest
/// staging, where both stay owned through the attempt.
///
/// The returned delivery may own no work when no group is admitted. In every
/// case, the caller must keep it paired with this plan and either resolve it
/// through `populate_cache_with_fresh_delivery` or call
/// [`FreshArchiveDelivery::cancel_and_drain`] before abandoning the plan.
/// Admitted cache misses reuse the Runner's bounded same-origin HTTP client.
/// Plans without an admitted miss do not initialize a client or load CA roots.
/// Select extracted files using the same source groups before archive admission;
/// selected hits never start an archive request. A prepared plan keeps its pins
/// and does not repeat the lookup during population.
pub(crate) async fn prepare_fresh_archive_delivery(
    plan: &mut StoragePlan,
    home: &HomePaths,
    admission: &FreshArchiveDeliveryAdmission,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
    decoded: Option<&decoded::DecodedCache>,
) -> RunnerResult<FreshArchiveDelivery> {
    let archives = plan.cache_candidates();
    let ordinary_required = archives
        .iter()
        .any(|archive| archive.name.is_empty() || archive.version.is_empty());
    let groups = group_targets(collect_targets(archives));
    if let Some(cache) = decoded {
        prepare_decoded_storage(plan, &groups, cache, telemetry).await?;
    }
    let candidates = groups
        .iter()
        .map(|group| !group_has_decoded(group, plan))
        .collect::<Vec<_>>();
    let owner_cancel = cancel.child_token();
    let phase_records = FreshArchivePhaseRecords::default();
    let mut classification = JoinSet::new();
    classification.spawn(classify_fresh_archives(
        groups,
        candidates,
        home.clone(),
        admission.clone(),
        owner_cancel.clone(),
        ordinary_required,
        phase_records.clone(),
    ));
    Ok(FreshArchiveDelivery {
        cancel: owner_cancel,
        phase_records,
        classification,
        groups: None,
        apply: Vec::new(),
        fetches: JoinSet::new(),
        publications: JoinSet::new(),
    })
}

async fn classify_fresh_archives(
    groups: Vec<CacheTargetGroup>,
    candidates: Vec<bool>,
    home: HomePaths,
    admission: FreshArchiveDeliveryAdmission,
    owner_cancel: CancellationToken,
    mut ordinary_required: bool,
    phase_records: FreshArchivePhaseRecords,
) -> FreshArchiveClassification {
    let started = Instant::now();
    let mut scan_summary = FreshDeliveryScanSummary::from_groups(
        groups
            .iter()
            .zip(&candidates)
            .filter_map(|(group, &selected)| selected.then_some(group)),
        FRESH_DELIVERY_SCAN_LIMIT,
    );
    let mut metrics = CacheProcessMetrics::default();
    let mut requests = FreshArchiveRequests {
        apply: Vec::new(),
        fetches: JoinSet::new(),
        phase_records,
    };
    let prepare = async {
        // Metadata hints do not pin bodies or locks. Preserve manifest order and
        // the original non-decoded prefix, including response-size admission.
        let inspections = futures_util::stream::iter(
            candidates
                .into_iter()
                .enumerate()
                .filter_map(|(index, selected)| selected.then_some(index))
                .enumerate(),
        )
        .map(|(position, index)| {
            let groups = &groups;
            let home = &home;
            async move {
                let group = groups.get(index).ok_or_else(|| {
                    RunnerError::Internal("invalid archive classification group".into())
                })?;
                if group
                    .archive_size
                    .is_some_and(|size| size == 0 || size > CACHE_MAX_SIZE)
                {
                    return Ok((position, index, false));
                }
                let target = group.targets.first().ok_or_else(|| {
                    RunnerError::Internal("empty runner-owned archive target group".into())
                })?;
                let path = home
                    .storage_cache_dir(&target.name, &target.version)
                    .join("archive.tar.gz");
                let warm = match fs::metadata(&path).await {
                    Ok(metadata) => metadata.len() > 0 && metadata.len() <= CACHE_MAX_SIZE,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                    Err(error) => {
                        return Err(RunnerError::Internal(format!(
                            "stat cached {}: {error}",
                            path.display()
                        )));
                    }
                };
                Ok((position, index, warm))
            }
        })
        .buffered(CONCURRENCY);
        tokio::pin!(inspections);
        let mut expanded = Vec::new();
        while let Some(inspection) = inspections.next().await {
            if requests.apply.len() >= FRESH_DELIVERY_PER_RUN_LIMIT {
                scan_summary.per_run = true;
                metrics.record(
                    STORAGE_CACHE_FRESH_DELIVERY_CAPACITY,
                    Duration::ZERO,
                    true,
                    Some("per-run"),
                );
                break;
            }
            let (position, index, warm) = inspection?;
            let suffix = position >= FRESH_DELIVERY_SCAN_LIMIT;
            if suffix && ordinary_required {
                return Ok(());
            }
            let group = groups.get(index).ok_or_else(|| {
                RunnerError::Internal("invalid archive classification group".into())
            })?;
            if group
                .archive_size
                .is_some_and(|size| size == 0 || size > CACHE_MAX_SIZE)
            {
                metrics.record(
                    STORAGE_CACHE_FRESH_DELIVERY_OVERSIZED,
                    Duration::ZERO,
                    true,
                    Some("known-size"),
                );
                ordinary_required = true;
                continue;
            }
            if warm {
                metrics.record(
                    STORAGE_CACHE_FRESH_DELIVERY_WARM,
                    Duration::ZERO,
                    true,
                    None,
                );
                continue;
            }
            if suffix {
                // Expanding only part of a run can serialize Host delivery and
                // Guest download. Collect a complete bounded suffix before any
                // new request. Unknown sizes retain ordinary Guest ownership.
                if group.archive_size.is_none() {
                    return Ok(());
                }
                if expanded.len() + requests.apply.len() == FRESH_DELIVERY_PER_RUN_LIMIT {
                    scan_summary.per_run = true;
                    metrics.record(
                        STORAGE_CACHE_FRESH_DELIVERY_CAPACITY,
                        Duration::ZERO,
                        true,
                        Some("per-run"),
                    );
                    return Ok(());
                }
                expanded.push(index);
                continue;
            }
            let permit = match Arc::clone(&admission.permits).try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    scan_summary.runner_wide = true;
                    metrics.record(
                        STORAGE_CACHE_FRESH_DELIVERY_CAPACITY,
                        Duration::ZERO,
                        true,
                        Some("runner-wide"),
                    );
                    ordinary_required = true;
                    continue;
                }
            };
            match claim_fresh_archive(group, &home, &mut metrics).await? {
                FreshArchiveClaim::Cold(writer) => {
                    requests.start(
                        group,
                        writer,
                        permit,
                        &admission,
                        &owner_cancel,
                        &mut metrics,
                    )?;
                }
                FreshArchiveClaim::Warm => {}
                FreshArchiveClaim::Busy => ordinary_required = true,
            }
        }
        if ordinary_required || expanded.is_empty() {
            return Ok(());
        }

        // This nonblocking reservation is all-or-none across simultaneous runs.
        // Keep it bounded by the remaining cumulative per-run allowance.
        let mut permits =
            match Arc::clone(&admission.permits).try_acquire_many_owned(expanded.len() as u32) {
                Ok(permits) => permits,
                Err(_) => {
                    scan_summary.runner_wide = true;
                    metrics.record(
                        STORAGE_CACHE_FRESH_DELIVERY_CAPACITY,
                        Duration::ZERO,
                        true,
                        Some("runner-wide"),
                    );
                    return Ok(());
                }
            };
        let mut claims = Vec::new();
        for index in expanded {
            let group = groups.get(index).ok_or_else(|| {
                RunnerError::Internal("invalid archive classification group".into())
            })?;
            let permit = permits.split(1).ok_or_else(|| {
                RunnerError::Internal("incomplete expanded archive reservation".into())
            })?;
            match claim_fresh_archive(group, &home, &mut metrics).await? {
                FreshArchiveClaim::Cold(writer) => claims.push((group, writer, permit)),
                FreshArchiveClaim::Warm => {} // Drop the unused reservation immediately.
                FreshArchiveClaim::Busy => return Ok(()),
            }
        }
        // No GET has started for these claims. A busy writer above releases all
        // locks and permits, leaving the complete expanded set on ordinary delivery.
        for (group, writer, permit) in claims {
            requests.start(
                group,
                writer,
                permit,
                &admission,
                &owner_cancel,
                &mut metrics,
            )?;
        }
        Ok(())
    };
    let result = tokio::select! {
        biased;
        () = owner_cancel.cancelled() => Err(RunnerError::Cancelled),
        result = prepare => result,
    };
    metrics.record(
        "storage_cache_fresh_delivery_classify",
        started.elapsed(),
        result.is_ok(),
        None,
    );
    FreshArchiveClassification {
        groups,
        apply: requests.apply,
        fetches: requests.fetches,
        metrics,
        summary: scan_summary,
        result,
    }
}

enum FreshArchiveClaim {
    Cold(nix::fcntl::Flock<std::fs::File>),
    Warm,
    Busy,
}

async fn claim_fresh_archive(
    group: &CacheTargetGroup,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<FreshArchiveClaim> {
    let target = group
        .targets
        .first()
        .ok_or_else(|| RunnerError::Internal("empty runner-owned archive target group".into()))?;
    let writer =
        match lock::try_acquire_or_busy(home.storage_lock(&target.name, &target.version)).await? {
            lock::TryLock::Acquired(writer) => writer,
            lock::TryLock::Busy => {
                metrics.record(
                    STORAGE_CACHE_FRESH_DELIVERY_LOCK_BUSY,
                    Duration::ZERO,
                    true,
                    None,
                );
                return Ok(FreshArchiveClaim::Busy);
            }
        };
    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");
    // Unlocked observations are only hints. Revalidate under the writer before
    // assigning request ownership, preserving corrupt-entry cleanup and errors.
    match fs::metadata(&archive_path).await {
        Ok(metadata) if metadata.len() == 0 => evict_empty_cache(target, &cache_dir).await?,
        Ok(metadata) if metadata.len() <= CACHE_MAX_SIZE => {
            metrics.record(
                STORAGE_CACHE_FRESH_DELIVERY_WARM,
                Duration::ZERO,
                true,
                None,
            );
            return Ok(FreshArchiveClaim::Warm);
        }
        Ok(metadata) => evict_oversized_cache(target, &cache_dir, metadata.len()).await?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(RunnerError::Internal(format!(
                "stat cached {}: {error}",
                archive_path.display()
            )));
        }
    }
    Ok(FreshArchiveClaim::Cold(writer))
}

struct FreshArchiveRequests {
    apply: Vec<oneshot::Sender<()>>,
    fetches: JoinSet<FreshArchiveFetchTaskResult>,
    phase_records: FreshArchivePhaseRecords,
}

impl FreshArchiveRequests {
    fn start(
        &mut self,
        group: &CacheTargetGroup,
        writer: nix::fcntl::Flock<std::fs::File>,
        permit: OwnedSemaphorePermit,
        admission: &FreshArchiveDeliveryAdmission,
        cancel: &CancellationToken,
        metrics: &mut CacheProcessMetrics,
    ) -> RunnerResult<()> {
        let target = group.targets.first().ok_or_else(|| {
            RunnerError::Internal("empty runner-owned archive target group".into())
        })?;
        let http = admission.client_for_archive(&target.archive_url)?;
        let archive_url = target.archive_url.clone();
        let group = group.clone();
        let cancel = cancel.clone();
        let phase_records = self.phase_records.clone();
        let (apply_tx, apply_rx) = oneshot::channel();
        self.apply.push(apply_tx);
        self.fetches.spawn(async move {
            let fetch = tokio::select! {
                biased;
                () = cancel.cancelled() => Err("cancelled"),
                result = fetch_fresh_archive(&http, &archive_url, group.archive_size, &phase_records) => result,
            };
            let (bytes, size_source) = match fetch {
                Ok(download) => download,
                Err(reason) => return FreshArchiveFetchTaskResult::Terminal { reason },
            };
            let phase = FreshArchivePhaseGuard::new(
                &phase_records,
                STORAGE_CACHE_FRESH_DELIVERY_APPLY_WAIT,
            );
            let result = tokio::select! {
                biased;
                () = cancel.cancelled() => Err("cancelled"),
                ready = apply_rx => ready.map_err(|_| "cancelled"),
            };
            phase.finish(result);
            match result {
                Ok(()) => FreshArchiveFetchTaskResult::Downloaded(FreshArchiveDownloaded {
                    group, bytes, size_source, writer, permit,
                }),
                Err(reason) => FreshArchiveFetchTaskResult::Terminal { reason },
            }
        });
        metrics.record(
            STORAGE_CACHE_FRESH_DELIVERY_ADMITTED,
            Duration::ZERO,
            true,
            None,
        );
        metrics.record(
            STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST,
            Duration::ZERO,
            true,
            None,
        );
        Ok(())
    }
}

/// An admitted runner-owned request uses the shared bounded timeout. Failure
/// is terminal; it must not be retried through a second Guest download owner.
async fn fetch_fresh_archive(
    http: &Client,
    archive_url: &str,
    expected_size: Option<u64>,
    phase_records: &FreshArchivePhaseRecords,
) -> Result<(Bytes, FreshArchiveSizeSource), &'static str> {
    let phase = FreshArchivePhaseGuard::new(phase_records, STORAGE_CACHE_FRESH_DELIVERY_HEADERS);
    let headers = async {
        let response = http
            .get(archive_url)
            .timeout(OBJECT_DOWNLOAD_TIMEOUT)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "timeout"
                } else {
                    "http"
                }
            })?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("http-status");
        }

        let response_size = response.content_length();
        let (exact_size, size_source) = match expected_size {
            Some(expected) => {
                if response_size.is_some_and(|size| size != expected) {
                    return Err("response-size-mismatch");
                }
                (expected, FreshArchiveSizeSource::Manifest)
            }
            None => match response_size {
                Some(0) => return Err("response-size-zero"),
                Some(size) if size <= CACHE_MAX_SIZE => (size, FreshArchiveSizeSource::Response),
                Some(_) => return Err("response-size-oversized"),
                None => return Err("response-size-missing"),
            },
        };
        if exact_size == 0 {
            return Err("expected-size-zero");
        }
        if exact_size > CACHE_MAX_SIZE {
            return Err("expected-size-oversized");
        }
        Ok((response, response_size, exact_size, size_source))
    }
    .await;
    phase.finish(headers.as_ref().map(|_| ()).map_err(|reason| *reason));
    let (mut response, response_size, exact_size, size_source) = headers?;

    let phase = FreshArchivePhaseGuard::new(phase_records, STORAGE_CACHE_FRESH_DELIVERY_BODY);
    let body = async {
        let mut bytes = Vec::with_capacity(initial_body_capacity(
            response_size,
            Some(exact_size),
            CACHE_MAX_SIZE,
        ));
        let mut downloaded = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            if error.is_timeout() {
                "timeout"
            } else {
                "body"
            }
        })? {
            if append_limited_chunk(&mut bytes, &mut downloaded, &chunk, CACHE_MAX_SIZE)
                .map_err(|_| "body-length-overflow")?
                .is_some()
            {
                return Err("body-oversized");
            }
        }
        if downloaded != exact_size {
            return Err("body-size-mismatch");
        }
        Ok((Bytes::from(bytes), size_source))
    }
    .await;
    phase.finish(body.as_ref().map(|_| ()).map_err(|reason| *reason));
    body
}

fn cache_target_from_entry(
    handle: ArchiveHandle,
    archive_url: &str,
    name: &str,
    version: &str,
    archive_size: Option<u64>,
) -> Option<CacheTarget> {
    // Empty components would hash to the same fixed digest as every other
    // empty component, collapsing distinct manifest entries into a shared
    // cache slot. Treat them like missing keys: passthrough.
    if name.is_empty() || version.is_empty() {
        return None;
    }
    Some(CacheTarget {
        handle,
        name: name.to_string(),
        version: version.to_string(),
        archive_url: archive_url.to_string(),
        archive_size: archive_size.filter(|size| *size > 0),
    })
}

async fn process_group_background_fill(
    group: &CacheTargetGroup,
    http: &Client,
    home: &HomePaths,
) -> RunnerResult<BackgroundFillOutcome> {
    if group.archive_size.is_some_and(|size| size > CACHE_MAX_SIZE) {
        return Ok(BackgroundFillOutcome::Skipped);
    }
    let target = group
        .targets
        .first()
        .ok_or_else(|| RunnerError::Internal("empty storage cache target group".into()))?;
    process_one_background_fill(target, group.archive_size, http, home).await
}

async fn process_group_hit_or_passthrough(
    group: &CacheTargetGroup,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedGroup> {
    let target = group
        .targets
        .first()
        .ok_or_else(|| RunnerError::Internal("empty storage cache target group".into()))?;
    let ProcessedTarget {
        outcome,
        stage_write,
    } = process_one_hit_or_passthrough(target, home, metrics).await?;

    Ok(ProcessedGroup {
        outcome,
        stage_write,
    })
}

async fn process_one_background_fill(
    target: &CacheTarget,
    archive_size: Option<u64>,
    http: &Client,
    home: &HomePaths,
) -> RunnerResult<BackgroundFillOutcome> {
    let lock_path = home.storage_lock(&target.name, &target.version);
    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");

    let writer = match lock::try_acquire_or_busy(lock_path).await? {
        lock::TryLock::Acquired(lock) => lock,
        lock::TryLock::Busy => return Ok(BackgroundFillOutcome::Busy),
    };

    match fs::metadata(&archive_path).await {
        Ok(metadata) if metadata.len() == 0 => {
            evict_empty_cache(target, &cache_dir).await?;
        }
        Ok(metadata) if metadata.len() <= CACHE_MAX_SIZE => {
            let size = metadata.len();
            touch_mtime(&cache_dir);
            drop(writer);
            return Ok(BackgroundFillOutcome::AlreadyCached { size });
        }
        Ok(metadata) => {
            evict_oversized_cache(target, &cache_dir, metadata.len()).await?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "stat cached {}: {e}",
                archive_path.display()
            )));
        }
    }

    let outcome = match fetch_cache_target(target, archive_size, http).await? {
        CacheFetchOutcome::Downloaded(bytes) => {
            let size = bytes.len() as u64;
            write_to_cache(&cache_dir, &bytes).await?;
            BackgroundFillOutcome::Filled { size }
        }
        CacheFetchOutcome::Unavailable => BackgroundFillOutcome::Unavailable,
        CacheFetchOutcome::Skipped => BackgroundFillOutcome::Skipped,
    };
    drop(writer);
    Ok(outcome)
}

async fn fetch_cache_target(
    target: &CacheTarget,
    archive_size: Option<u64>,
    http: &Client,
) -> RunnerResult<CacheFetchOutcome> {
    let size = match archive_size {
        Some(size) => size,
        None => {
            // Legacy queued contexts do not carry encoded size. Preserve the
            // existing bounded range probe for those entries.
            match probe_size(http, &target.archive_url).await {
                Ok(SizeProbe::Known(n)) => n,
                Ok(SizeProbe::Unknown(reason)) => {
                    let reason = reason.as_str();
                    warn!(
                        name = %target.name,
                        version = %target.version,
                        reason,
                        "storage_cache: probe returned no usable size header, passthrough"
                    );
                    return Ok(CacheFetchOutcome::Unavailable);
                }
                Err(e) => {
                    let reason = e.to_string();
                    warn!(
                        name = %target.name,
                        version = %target.version,
                        error = %reason,
                        "storage_cache: probe failed, passthrough"
                    );
                    return Ok(CacheFetchOutcome::Unavailable);
                }
            }
        }
    };
    if size > CACHE_MAX_SIZE {
        info!(
            name = %target.name,
            version = %target.version,
            size,
            "storage_cache: entry over size limit, passthrough"
        );
        return Ok(CacheFetchOutcome::Skipped);
    }

    let body = download_tarball(http, &target.archive_url, Some(size), CACHE_MAX_SIZE).await;
    let bytes = match body {
        Ok(body) => body,
        Err(e) => {
            let reason = e.to_string();
            match e {
                CacheDownloadError::Http(_) => {
                    warn!(
                        name = %target.name,
                        version = %target.version,
                        error = %reason,
                        "storage_cache: full download failed, passthrough"
                    );
                    return Ok(CacheFetchOutcome::Unavailable);
                }
                CacheDownloadError::Internal(e) => return Err(e),
            }
        }
    };
    let bytes = match bytes {
        DownloadBody::Complete(bytes) => bytes,
        DownloadBody::Empty => {
            warn!(
                name = %target.name,
                version = %target.version,
                "storage_cache: full download returned empty archive, passthrough"
            );
            return Ok(CacheFetchOutcome::Unavailable);
        }
        DownloadBody::OverSize { observed_size } => {
            warn!(
                name = %target.name,
                version = %target.version,
                expected_size = size,
                observed_size,
                limit = CACHE_MAX_SIZE,
                "storage_cache: full download exceeded expected size limit, failing closed"
            );
            return Err(RunnerError::Internal(format!(
                "storage cache download size mismatch for {}@{}: expected {size} bytes within {CACHE_MAX_SIZE} byte limit, but full GET reached {observed_size} bytes",
                target.name, target.version
            )));
        }
    };
    let observed_size = u64::try_from(bytes.len())
        .map_err(|_| RunnerError::Internal("downloaded archive length overflow".to_string()))?;
    if observed_size != size {
        warn!(
            name = %target.name,
            version = %target.version,
            expected_size = size,
            observed_size,
            "storage_cache: full download size differed from expectation, passthrough"
        );
        return Ok(CacheFetchOutcome::Unavailable);
    }

    Ok(CacheFetchOutcome::Downloaded(bytes))
}

async fn process_one_hit_or_passthrough(
    target: &CacheTarget,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedTarget> {
    let lock_path = home.storage_lock(&target.name, &target.version);
    let cache_dir = home.storage_cache_dir(&target.name, &target.version);
    let archive_path = cache_dir.join("archive.tar.gz");
    let archive_may_exist = cached_archive_exists(&archive_path).await?;
    let started_at = Instant::now();
    let reader_result = lock::try_acquire_existing_shared_or_missing(lock_path.clone()).await;
    let success = reader_result.is_ok();
    metrics.record(
        STORAGE_CACHE_LOCK_WAIT,
        started_at.elapsed(),
        success,
        (!success).then_some(STORAGE_CACHE_LOCK_WAIT_FAILED),
    );
    let reader = match reader_result? {
        lock::ExistingTryLock::Acquired(lock) => lock,
        lock::ExistingTryLock::Busy => {
            return Ok(ProcessedTarget {
                outcome: TargetOutcome::LockBusyPassthrough,
                stage_write: None,
            });
        }
        lock::ExistingTryLock::Missing => {
            if !archive_may_exist || !cached_archive_exists(&archive_path).await? {
                return Ok(ProcessedTarget {
                    outcome: TargetOutcome::MissPassthrough { reason: "missing" },
                    stage_write: None,
                });
            }

            let started_at = Instant::now();
            let reader_result = lock::try_acquire_shared_or_busy(lock_path.clone()).await;
            let success = reader_result.is_ok();
            metrics.record(
                STORAGE_CACHE_LOCK_WAIT,
                started_at.elapsed(),
                success,
                (!success).then_some(STORAGE_CACHE_LOCK_WAIT_FAILED),
            );
            match reader_result? {
                lock::TryLock::Acquired(lock) => lock,
                lock::TryLock::Busy => {
                    return Ok(ProcessedTarget {
                        outcome: TargetOutcome::LockBusyPassthrough,
                        stage_write: None,
                    });
                }
            }
        }
    };

    match read_cache_entry(&cache_dir, &archive_path, metrics).await? {
        CachedArchive::Hit(bytes) => {
            let guest_path = guest_archive_path(&target.name, &target.version);
            drop(reader);
            Ok(ProcessedTarget {
                outcome: TargetOutcome::Hit,
                stage_write: Some(GuestStageWrite { guest_path, bytes }),
            })
        }
        CachedArchive::Missing => {
            drop(reader);
            remove_storage_lock_after_missing_cache(&lock_path, &archive_path).await;
            Ok(ProcessedTarget {
                outcome: TargetOutcome::MissPassthrough { reason: "missing" },
                stage_write: None,
            })
        }
        CachedArchive::Empty => Ok(ProcessedTarget {
            outcome: TargetOutcome::MissPassthrough { reason: "empty" },
            stage_write: None,
        }),
        CachedArchive::OverSize { observed_size } => {
            let _ = observed_size;
            Ok(ProcessedTarget {
                outcome: TargetOutcome::MissPassthrough {
                    reason: "over-size",
                },
                stage_write: None,
            })
        }
    }
}

async fn remove_storage_lock_after_missing_cache(lock_path: &Path, archive_path: &Path) {
    let lock = match lock::try_acquire_existing_or_missing(lock_path.to_path_buf()).await {
        Ok(lock::ExistingTryLock::Acquired(lock)) => lock,
        Ok(lock::ExistingTryLock::Busy | lock::ExistingTryLock::Missing) => return,
        Err(_) => return,
    };

    match cached_archive_exists(archive_path).await {
        Ok(false) => {}
        Ok(true) | Err(_) => return,
    }

    let Ok(lock_meta) = lock.metadata() else {
        return;
    };

    match fs::symlink_metadata(lock_path).await {
        Ok(path_meta)
            if path_meta.dev() == lock_meta.dev() && path_meta.ino() == lock_meta.ino() => {}
        Ok(_) => return,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(_) => return,
    }

    let _ = fs::remove_file(lock_path).await;
}

async fn cached_archive_exists(archive_path: &Path) -> RunnerResult<bool> {
    match fs::metadata(archive_path).await {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat cached {}: {e}",
            archive_path.display()
        ))),
    }
}

async fn read_cache_entry(
    cache_dir: &Path,
    archive_path: &Path,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<CachedArchive> {
    match fs::metadata(archive_path).await {
        Ok(metadata) if metadata.len() == 0 => Ok(CachedArchive::Empty),
        Ok(metadata) if metadata.len() <= CACHE_MAX_SIZE => {
            let started_at = Instant::now();
            match read_cached_archive(archive_path, Some(metadata.len()), CACHE_MAX_SIZE).await? {
                DownloadBody::Complete(bytes) => {
                    metrics.record(STORAGE_CACHE_HIT_READ, started_at.elapsed(), true, None);
                    touch_mtime(cache_dir);
                    Ok(CachedArchive::Hit(bytes))
                }
                DownloadBody::Empty => Ok(CachedArchive::Empty),
                DownloadBody::OverSize { observed_size } => {
                    Ok(CachedArchive::OverSize { observed_size })
                }
            }
        }
        Ok(metadata) => Ok(CachedArchive::OverSize {
            observed_size: metadata.len(),
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(CachedArchive::Missing),
        Err(e) => Err(RunnerError::Internal(format!(
            "stat cached {}: {e}",
            archive_path.display()
        ))),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SizeProbe {
    Known(u64),
    Unknown(SizeProbeUnknown),
}

#[derive(Debug, PartialEq, Eq)]
enum SizeProbeUnknown {
    MissingSizeHeader,
    InvalidSizeHeader,
    MissingContentRange,
    UnknownSize,
    InvalidContentRange,
}

impl SizeProbeUnknown {
    fn as_str(&self) -> &'static str {
        match self {
            Self::MissingSizeHeader => "missing-size-header",
            Self::InvalidSizeHeader => "invalid-size-header",
            Self::MissingContentRange => "missing-content-range",
            Self::UnknownSize => "unknown-size",
            Self::InvalidContentRange => "invalid-content-range",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProbeContentRange {
    Known(u64),
    UnknownSize,
    Invalid,
}

#[derive(Debug)]
enum CacheHttpError {
    Status {
        phase: &'static str,
        status: reqwest::StatusCode,
    },
    UnexpectedStatus {
        phase: &'static str,
        status: reqwest::StatusCode,
    },
    Transport {
        phase: &'static str,
        detail: String,
    },
}

impl CacheHttpError {
    fn status(phase: &'static str, status: reqwest::StatusCode) -> Self {
        Self::Status { phase, status }
    }

    fn unexpected_status(phase: &'static str, status: reqwest::StatusCode) -> Self {
        Self::UnexpectedStatus { phase, status }
    }

    fn from_reqwest(phase: &'static str, error: reqwest::Error) -> Self {
        if let Some(status) = error.status() {
            return Self::status(phase, status);
        }
        Self::Transport {
            phase,
            detail: reqwest_error(error),
        }
    }
}

impl fmt::Display for CacheHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status { phase, status } => write!(f, "{phase}: HTTP status {status}"),
            Self::UnexpectedStatus { phase, status } => {
                write!(f, "{phase}: unexpected status {status}")
            }
            Self::Transport { phase, detail, .. } => write!(f, "{phase}: {detail}"),
        }
    }
}

#[derive(Debug)]
enum CacheDownloadError {
    Http(CacheHttpError),
    Internal(RunnerError),
}

impl From<CacheHttpError> for CacheDownloadError {
    fn from(error: CacheHttpError) -> Self {
        Self::Http(error)
    }
}

impl From<RunnerError> for CacheDownloadError {
    fn from(error: RunnerError) -> Self {
        Self::Internal(error)
    }
}

impl fmt::Display for CacheDownloadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(error) => write!(f, "{error}"),
            Self::Internal(error) => write!(f, "{error}"),
        }
    }
}

async fn probe_size(http: &Client, url: &str) -> Result<SizeProbe, CacheHttpError> {
    use reqwest::{StatusCode, header};
    let resp = http
        .get(url)
        .header(header::RANGE, "bytes=0-0")
        .timeout(HEAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("probe GET", e))?;

    let status = resp.status();
    if status == StatusCode::PARTIAL_CONTENT {
        // 206: parse total from `Content-Range: bytes 0-0/<total>`.
        let total = match resp.headers().get(header::CONTENT_RANGE) {
            Some(value) => match value.to_str() {
                Ok(value) => match parse_probe_content_range_total(value) {
                    ProbeContentRange::Known(total) => SizeProbe::Known(total),
                    ProbeContentRange::UnknownSize => {
                        SizeProbe::Unknown(SizeProbeUnknown::UnknownSize)
                    }
                    ProbeContentRange::Invalid => {
                        SizeProbe::Unknown(SizeProbeUnknown::InvalidContentRange)
                    }
                },
                Err(_) => SizeProbe::Unknown(SizeProbeUnknown::InvalidContentRange),
            },
            None => SizeProbe::Unknown(SizeProbeUnknown::MissingContentRange),
        };
        // Do not drain the body here. Some origins ignore Range while still
        // returning large bodies, and probe safety matters more than reusing
        // this connection.
        return Ok(total);
    }
    if status == StatusCode::OK {
        // 200: server ignored Range. Fall back to Content-Length.
        let total = match resp.headers().get(header::CONTENT_LENGTH) {
            Some(value) => match value.to_str().ok().and_then(parse_ascii_decimal_u64) {
                Some(0) => SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader),
                Some(total) => SizeProbe::Known(total),
                None => SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader),
            },
            None => SizeProbe::Unknown(SizeProbeUnknown::MissingSizeHeader),
        };
        // Drop the response after headers instead of buffering an ignored
        // Range response into memory.
        return Ok(total);
    }
    // 4xx / 5xx / 416 / anything else — treat as probe failure.
    if status.is_success() {
        Err(CacheHttpError::unexpected_status("probe GET", status))
    } else {
        Err(CacheHttpError::status("probe GET", status))
    }
}

fn reqwest_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// Parse the total size from the response to our `Range: bytes=0-0` probe.
fn parse_probe_content_range_total(value: &str) -> ProbeContentRange {
    let mut parts = value.split_whitespace();
    let Some(unit) = parts.next() else {
        return ProbeContentRange::Invalid;
    };
    let Some(range_and_total) = parts.next() else {
        return ProbeContentRange::Invalid;
    };
    if parts.next().is_some() || !unit.eq_ignore_ascii_case("bytes") {
        return ProbeContentRange::Invalid;
    }

    let mut range_total_parts = range_and_total.split('/');
    let Some(range) = range_total_parts.next() else {
        return ProbeContentRange::Invalid;
    };
    let Some(total) = range_total_parts.next() else {
        return ProbeContentRange::Invalid;
    };
    if range_total_parts.next().is_some() {
        return ProbeContentRange::Invalid;
    }

    let Some((start, end)) = range.split_once('-') else {
        return ProbeContentRange::Invalid;
    };
    let Some(start) = parse_ascii_decimal_u64(start) else {
        return ProbeContentRange::Invalid;
    };
    let Some(end) = parse_ascii_decimal_u64(end) else {
        return ProbeContentRange::Invalid;
    };
    if start != 0 || end != 0 {
        return ProbeContentRange::Invalid;
    }

    if total == "*" {
        return ProbeContentRange::UnknownSize;
    }
    let Some(total) = parse_ascii_decimal_u64(total) else {
        return ProbeContentRange::Invalid;
    };
    if total <= end {
        return ProbeContentRange::Invalid;
    }
    ProbeContentRange::Known(total)
}

fn parse_ascii_decimal_u64(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

async fn download_tarball(
    http: &Client,
    url: &str,
    expected_size: Option<u64>,
    max_size: u64,
) -> Result<DownloadBody, CacheDownloadError> {
    let mut resp = http
        .get(url)
        .timeout(OBJECT_DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("GET", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(CacheHttpError::status("GET", status).into());
    }

    let content_length = resp.content_length();
    if let Some(content_length) = content_length
        && content_length > max_size
    {
        return Ok(DownloadBody::OverSize {
            observed_size: content_length,
        });
    }

    let mut bytes = Vec::with_capacity(initial_body_capacity(
        content_length,
        expected_size,
        max_size,
    ));
    let mut downloaded = 0u64;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("read body", e))?
    {
        if let Some(observed_size) =
            append_limited_chunk(&mut bytes, &mut downloaded, &chunk, max_size)?
        {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
    }

    Ok(DownloadBody::Complete(Bytes::from(bytes)))
}

async fn read_cached_archive(
    path: &Path,
    expected_size: Option<u64>,
    max_size: u64,
) -> RunnerResult<DownloadBody> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|e| RunnerError::Internal(format!("open cached {}: {e}", path.display())))?;
    let capacity = initial_body_capacity(None, expected_size, max_size);
    let mut bytes = Vec::with_capacity(capacity);
    let mut downloaded = 0u64;
    // Keep the scratch space out of every spawned archive task's future. Small
    // cached archives also need no 64-KiB Tokio file read buffer. The size is
    // only a hint: retain a useful minimum and read to EOF under the byte limit.
    let mut buf = vec![0u8; capacity.clamp(4096, BODY_BUFFER_FALLBACK_CAPACITY)];

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| RunnerError::Internal(format!("read cached {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        let chunk = buf.get(..n).ok_or_else(|| {
            RunnerError::Internal(format!(
                "read cached {} produced invalid chunk length {n}",
                path.display()
            ))
        })?;
        if let Some(observed_size) =
            append_limited_chunk(&mut bytes, &mut downloaded, chunk, max_size)?
        {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
    }

    Ok(DownloadBody::Complete(Bytes::from(bytes)))
}

fn initial_body_capacity(
    primary_size: Option<u64>,
    fallback_size: Option<u64>,
    max_size: u64,
) -> usize {
    let capacity = primary_size
        .filter(|size| *size <= max_size)
        .or_else(|| fallback_size.filter(|size| *size <= max_size))
        .unwrap_or_else(|| max_size.min(BODY_BUFFER_FALLBACK_CAPACITY as u64));
    usize::try_from(capacity).unwrap_or(BODY_BUFFER_FALLBACK_CAPACITY)
}

fn append_limited_chunk(
    bytes: &mut Vec<u8>,
    downloaded: &mut u64,
    chunk: &[u8],
    max_size: u64,
) -> RunnerResult<Option<u64>> {
    let chunk_len = u64::try_from(chunk.len())
        .map_err(|_| RunnerError::Internal("body chunk length overflow".to_string()))?;
    let Some(next_downloaded) = downloaded.checked_add(chunk_len) else {
        return Ok(Some(u64::MAX));
    };
    if next_downloaded > max_size {
        return Ok(Some(next_downloaded));
    }
    bytes.extend_from_slice(chunk);
    *downloaded = next_downloaded;
    Ok(None)
}

async fn evict_oversized_cache(
    target: &CacheTarget,
    cache_dir: &Path,
    observed_size: u64,
) -> RunnerResult<()> {
    warn!(
        name = %target.name,
        version = %target.version,
        size = observed_size,
        limit = CACHE_MAX_SIZE,
        "storage_cache: cached archive exceeds size limit, evicting"
    );
    if let Err(e) = fs::remove_dir_all(cache_dir).await
        && e.kind() != io::ErrorKind::NotFound
    {
        return Err(RunnerError::Internal(format!(
            "remove oversized cache {}: {e}",
            cache_dir.display()
        )));
    }
    Ok(())
}

async fn evict_empty_cache(target: &CacheTarget, cache_dir: &Path) -> RunnerResult<()> {
    warn!(
        name = %target.name,
        version = %target.version,
        "storage_cache: cached archive is empty, evicting"
    );
    if let Err(e) = fs::remove_dir_all(cache_dir).await
        && e.kind() != io::ErrorKind::NotFound
    {
        return Err(RunnerError::Internal(format!(
            "remove empty cache {}: {e}",
            cache_dir.display()
        )));
    }
    Ok(())
}

async fn write_to_cache(cache_dir: &Path, bytes: &[u8]) -> RunnerResult<()> {
    let staging = staging_dir(cache_dir);

    // Best-effort cleanup of stale staging from a prior crashed run.
    let _ = fs::remove_dir_all(&staging).await;
    fs::create_dir_all(&staging)
        .await
        .map_err(|e| RunnerError::Internal(format!("create staging {}: {e}", staging.display())))?;

    let archive_staging = staging.join("archive.tar.gz");
    if let Err(e) = fs::write(&archive_staging, bytes).await {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "write {}: {e}",
            archive_staging.display()
        )));
    }

    // fsync the archive so a crash between rename and next sync cannot
    // leave a zero-byte or torn file visible at the final path.
    let f = match fs::File::open(&archive_staging).await {
        Ok(f) => f,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(RunnerError::Internal(format!(
                "open for fsync {}: {e}",
                archive_staging.display()
            )));
        }
    };
    if let Err(e) = f.sync_all().await {
        drop(f);
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "fsync {}: {e}",
            archive_staging.display()
        )));
    }
    drop(f);

    // Ensure the `<name>/` parent exists so the rename below has a target.
    if let Some(parent) = cache_dir.parent()
        && let Err(e) = fs::create_dir_all(parent).await
    {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "create cache parent {}: {e}",
            parent.display()
        )));
    }

    if let Err(e) = fs::rename(&staging, cache_dir).await {
        // A sibling runner may have populated the final dir while we were
        // staging. Only swallow the error if (a) it looks like a "target
        // already exists" kind (EEXIST / ENOTEMPTY on Linux — the kernel
        // returns ENOTEMPTY for a non-empty target and EEXIST for some
        // filesystems) and (b) the expected final artifact is actually
        // there. Any other kernel error (EXDEV, ENOSPC, EACCES, ...) must
        // propagate so callers can surface the real failure.
        if is_rename_collision(&e) && fs::metadata(cache_dir.join("archive.tar.gz")).await.is_ok() {
            let _ = fs::remove_dir_all(&staging).await;
            return Ok(());
        }
        // Non-race error: clean up the staging dir ourselves so EXDEV /
        // ENOSPC / EACCES leftovers don't accumulate between retries. The
        // cleanup is best-effort — we still surface the original error.
        let _ = fs::remove_dir_all(&staging).await;
        return Err(RunnerError::Internal(format!(
            "rename {} -> {}: {e}",
            staging.display(),
            cache_dir.display()
        )));
    }
    Ok(())
}

/// Whether a `fs::rename` error plausibly means "target already exists or is
/// non-empty" — the race branch where a sibling runner beat us to it.
fn is_rename_collision(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
    )
}

/// `<dir>` -> `<dir>.tmp` sibling with the same parent (so rename is atomic).
fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    final_dir.with_file_name(name)
}

fn apply_group_outcome(
    plan: &mut StoragePlan,
    group: &CacheTargetGroup,
    outcome: &TargetOutcome,
    telemetry: &mut JobTelemetry,
) {
    for target in &group.targets {
        apply_outcome(plan, target, outcome, telemetry);
    }
}

fn apply_outcome(
    plan: &mut StoragePlan,
    target: &CacheTarget,
    outcome: &TargetOutcome,
    telemetry: &mut JobTelemetry,
) {
    match outcome {
        TargetOutcome::Decoded => {
            telemetry.record("storage_cache_decoded", Duration::ZERO, true, None)
        }
        TargetOutcome::Hit => {
            rewrite_url(plan, target);
            telemetry.record("storage_cache_hit", Duration::ZERO, true, None);
        }
        TargetOutcome::MissPassthrough { reason } => {
            telemetry.record(
                STORAGE_CACHE_MISS_PASSTHROUGH,
                Duration::ZERO,
                true,
                Some(reason),
            );
        }
        TargetOutcome::LockBusyPassthrough => {
            telemetry.record(
                STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH,
                Duration::ZERO,
                true,
                None,
            );
        }
    }
}

#[derive(Default)]
struct PassthroughSummary {
    hit_targets: usize,
    miss_targets: usize,
    lock_busy_targets: usize,
}

fn record_passthrough_summary(
    outcomes: &[(CacheTargetGroup, TargetOutcome)],
    telemetry: &mut JobTelemetry,
) {
    let mut summary = PassthroughSummary::default();
    for (group, outcome) in outcomes {
        add_passthrough_summary(&mut summary, outcome, group.targets.len());
    }

    telemetry.record(
        passthrough_hit_count_action(summary.hit_targets),
        Duration::ZERO,
        true,
        None,
    );
    telemetry.record(
        passthrough_miss_count_action(summary.miss_targets),
        Duration::ZERO,
        true,
        None,
    );
    telemetry.record(
        passthrough_lock_busy_count_action(summary.lock_busy_targets),
        Duration::ZERO,
        true,
        None,
    );
}

fn add_passthrough_summary(
    summary: &mut PassthroughSummary,
    outcome: &TargetOutcome,
    target_count: usize,
) {
    match outcome {
        TargetOutcome::Hit | TargetOutcome::Decoded => summary.hit_targets += target_count,
        TargetOutcome::MissPassthrough { .. } => summary.miss_targets += target_count,
        TargetOutcome::LockBusyPassthrough => summary.lock_busy_targets += target_count,
    }
}

fn passthrough_hit_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_hit_count_0",
        CountBucket::One => "storage_cache_passthrough_hit_count_1",
        CountBucket::Two => "storage_cache_passthrough_hit_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_hit_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_hit_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_hit_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_hit_count_17_plus",
    }
}

fn passthrough_miss_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_miss_count_0",
        CountBucket::One => "storage_cache_passthrough_miss_count_1",
        CountBucket::Two => "storage_cache_passthrough_miss_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_miss_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_miss_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_miss_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_miss_count_17_plus",
    }
}

fn passthrough_lock_busy_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_passthrough_lock_busy_count_0",
        CountBucket::One => "storage_cache_passthrough_lock_busy_count_1",
        CountBucket::Two => "storage_cache_passthrough_lock_busy_count_2",
        CountBucket::ThreeToFour => "storage_cache_passthrough_lock_busy_count_3_4",
        CountBucket::FiveToEight => "storage_cache_passthrough_lock_busy_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_passthrough_lock_busy_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_passthrough_lock_busy_count_17_plus",
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

fn background_fill_deferred_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "storage_cache_background_fill_deferred_count_0",
        CountBucket::One => "storage_cache_background_fill_deferred_count_1",
        CountBucket::Two => "storage_cache_background_fill_deferred_count_2",
        CountBucket::ThreeToFour => "storage_cache_background_fill_deferred_count_3_4",
        CountBucket::FiveToEight => "storage_cache_background_fill_deferred_count_5_8",
        CountBucket::NineToSixteen => "storage_cache_background_fill_deferred_count_9_16",
        CountBucket::SeventeenPlus => "storage_cache_background_fill_deferred_count_17_plus",
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

#[derive(Clone, Copy)]
enum CountBucket {
    Zero,
    One,
    Two,
    ThreeToFour,
    FiveToEight,
    NineToSixteen,
    SeventeenPlus,
}

fn count_bucket(count: usize) -> CountBucket {
    match count {
        0 => CountBucket::Zero,
        1 => CountBucket::One,
        2 => CountBucket::Two,
        3 | 4 => CountBucket::ThreeToFour,
        5..=8 => CountBucket::FiveToEight,
        9..=16 => CountBucket::NineToSixteen,
        _ => CountBucket::SeventeenPlus,
    }
}

fn count_bucket_outcome(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "0",
        CountBucket::One => "1",
        CountBucket::Two => "2",
        CountBucket::ThreeToFour => "3_4",
        CountBucket::FiveToEight => "5_8",
        CountBucket::NineToSixteen => "9_16",
        CountBucket::SeventeenPlus => "17_plus",
    }
}

/// Resolve a planned archive to the guest `file://` stage path.
///
/// Verifies the planned entry still has the expected `(name, version, source)`
/// before mutating — content-addressed safety against
/// any future parallel mutation at this pipeline stage. A mismatch is not
/// a hard error (the caller made the right conservative choice) but is
/// logged so a regression that breaks the invariant is visible.
fn rewrite_url(plan: &mut StoragePlan, target: &CacheTarget) {
    let new_url = format!(
        "file://{}",
        guest_archive_path(&target.name, &target.version)
    );
    let applied = plan.stage_archive(
        target.handle,
        &target.name,
        &target.version,
        &target.archive_url,
        new_url,
    );
    if !applied {
        warn!(
            name = %target.name,
            version = %target.version,
            "storage_cache: plan identity mismatch at rewrite, skipping source swap"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod http_reuse;
    mod phase_diagnostics;

    use async_trait::async_trait;
    use httpmock::Method::{GET, HEAD};
    use httpmock::prelude::*;
    use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};
    use sandbox_mock::{MockLifecycleGate, MockSandbox};
    use std::collections::{HashMap, HashSet};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::TcpListener;

    use crate::http::{HttpClient, HttpClientConfig};
    use crate::ids::RunId;
    use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
    use crate::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};
    use crate::storage_plan::build_storage_plan;
    use crate::test_fixtures::raw_http::{
        RawHttpAction, RawHttpTestServer, http_response, join_raw_http_task, json_response,
        read_http_request,
    };

    const CACHE_TEST_RUNTIME_DIR: &str = "/tmp/storage-cache-test-runtime";

    // Cache tests observe selection at its join boundary. Executor tests use
    // the production entry point directly to verify pre-create overlap.
    async fn prepare_fresh_archive_delivery(
        plan: &mut StoragePlan,
        home: &HomePaths,
        admission: &FreshArchiveDeliveryAdmission,
        cancel: &CancellationToken,
        telemetry: &mut JobTelemetry,
        decoded: Option<&decoded::DecodedCache>,
    ) -> RunnerResult<FreshArchiveDelivery> {
        let mut delivery = super::prepare_fresh_archive_delivery(
            plan, home, admission, cancel, telemetry, decoded,
        )
        .await?;
        if let Err(error) = delivery.finish_classification(telemetry).await {
            delivery.cancel_and_drain(telemetry).await;
            return Err(error);
        }
        Ok(delivery)
    }

    fn new_telemetry() -> JobTelemetry {
        new_telemetry_for_api_url("http://localhost:0")
    }

    fn new_telemetry_for_api_url(api_url: &str) -> JobTelemetry {
        let http = HttpClient::new(HttpClientConfig {
            api_url: api_url.to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap();
        JobTelemetry::new(http, RunId::nil(), "test-token".to_string(), None)
    }

    fn assert_op(ops: &[(String, bool, Option<String>)], action_type: &str, success: bool) {
        assert!(
            ops.iter()
                .any(|(key, op_success, _)| key == action_type && *op_success == success),
            "expected {action_type} success={success} in {ops:?}"
        );
    }

    fn assert_op_error(
        ops: &[(String, bool, Option<String>)],
        action_type: &str,
        expected_error: &str,
    ) {
        let error = ops
            .iter()
            .find(|(key, _, _)| key == action_type)
            .and_then(|(_, _, error)| error.as_deref());
        assert_eq!(
            error,
            Some(expected_error),
            "expected {action_type} error {expected_error:?} in {ops:?}"
        );
    }

    fn assert_no_op(ops: &[(String, bool, Option<String>)], action_type: &str) {
        assert!(
            !ops.iter().any(|(key, _, _)| key == action_type),
            "expected no {action_type} in {ops:?}"
        );
    }

    fn op_count(ops: &[(String, bool, Option<String>)], action_type: &str) -> usize {
        ops.iter().filter(|(key, _, _)| key == action_type).count()
    }

    fn assert_op_count(ops: &[(String, bool, Option<String>)], action_type: &str, expected: usize) {
        assert_eq!(
            op_count(ops, action_type),
            expected,
            "expected {expected} {action_type} ops in {ops:?}"
        );
    }

    fn assert_bounded_outcome(
        ops: &[(String, bool, Option<String>, Option<String>)],
        action_type: &str,
        success: bool,
        outcome: &str,
        reason: Option<&str>,
    ) {
        assert!(
            ops.iter()
                .any(|(action, op_success, op_outcome, op_reason)| {
                    action == action_type
                        && *op_success == success
                        && op_outcome.as_deref() == Some(outcome)
                        && op_reason.as_deref() == reason
                }),
            "expected {action_type} success={success} outcome={outcome:?} reason={reason:?} in {ops:?}"
        );
    }

    fn bounded_outcome_count(
        ops: &[(String, bool, Option<String>, Option<String>)],
        action_type: &str,
    ) -> usize {
        ops.iter()
            .filter(|(action, _, _, _)| action == action_type)
            .count()
    }

    #[test]
    fn count_bucket_outcome_uses_stable_ranges() {
        for (count, expected) in [
            (0, "0"),
            (1, "1"),
            (2, "2"),
            (3, "3_4"),
            (4, "3_4"),
            (5, "5_8"),
            (8, "5_8"),
            (9, "9_16"),
            (16, "9_16"),
            (17, "17_plus"),
        ] {
            assert_eq!(count_bucket_outcome(count), expected);
        }
    }

    fn op_duration_ms(ops: &[(String, u64, bool, Option<String>)], action_type: &str) -> u64 {
        ops.iter()
            .find(|(key, _, _, _)| key == action_type)
            .map(|(_, duration_ms, _, _)| *duration_ms)
            .unwrap_or_else(|| panic!("expected {action_type} in {ops:?}"))
    }

    async fn select_background_fill(
        plan: &mut StoragePlan,
        sandbox: &dyn Sandbox,
        home: &HomePaths,
        telemetry: &mut JobTelemetry,
    ) -> DeferredBackgroundFill {
        populate_cache(plan, sandbox, home, telemetry)
            .await
            .unwrap()
            .expect("cold cache entry should select a background fill")
    }

    async fn populate_cache_through_background(
        plan: &mut StoragePlan,
        sandbox: &dyn Sandbox,
        home: &HomePaths,
        telemetry: &mut JobTelemetry,
    ) -> RunnerResult<Vec<SandboxOpRecord>> {
        let Some(deferred) = populate_cache(plan, sandbox, home, telemetry).await? else {
            return Ok(Vec::new());
        };
        let records = deferred.run().await;
        if records.iter().any(|record| {
            matches!(
                record.action_type,
                STORAGE_CACHE_BACKGROUND_FILL_FILLED | STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED
            )
        }) {
            let deferred = populate_cache(plan, sandbox, home, telemetry).await?;
            assert!(
                deferred.is_none(),
                "successful background fill should produce a later warm hit"
            );
        }
        Ok(records)
    }

    async fn populate_cache_through_fresh_delivery(
        plan: &mut StoragePlan,
        sandbox: &dyn Sandbox,
        home: &HomePaths,
        telemetry: &mut JobTelemetry,
    ) -> RunnerResult<Option<DeferredBackgroundFill>> {
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut delivery =
            prepare_fresh_archive_delivery(plan, home, &admission, &cancel, telemetry, None)
                .await?;
        populate_cache_with_fresh_delivery(
            plan,
            sandbox,
            home,
            telemetry,
            Some(&mut delivery),
            None,
        )
        .await
    }

    fn assert_background_op(records: &[SandboxOpRecord], action_type: &str, success: bool) {
        assert!(
            records
                .iter()
                .any(|record| { record.action_type == action_type && record.success == success }),
            "expected {action_type} success={success} in {records:?}"
        );
    }

    fn assert_background_op_count(records: &[SandboxOpRecord], action_type: &str, expected: usize) {
        let actual = records
            .iter()
            .filter(|record| record.action_type == action_type)
            .count();
        assert_eq!(
            actual, expected,
            "expected {expected} {action_type} records in {records:?}"
        );
    }

    fn home_at(temp: &tempfile::TempDir) -> HomePaths {
        HomePaths::with_root(temp.path().to_path_buf())
    }

    fn storage_entry(mount_path: String, url: String, name: &str, version: &str) -> StorageEntry {
        StorageEntry {
            name: name.to_string(),
            mount_path,
            archive_url: url,
            vas_storage_name: name.to_string(),
            vas_version_id: version.to_string(),
            baseline_candidate: false,
            instructions_target_filename: None,
            archive_size: None,
        }
    }

    fn storage_entry_with_archive_size(
        mount_path: String,
        url: String,
        name: &str,
        version: &str,
        archive_size: Option<u64>,
    ) -> StorageEntry {
        let mut entry = storage_entry(mount_path, url, name, version);
        entry.archive_size = archive_size;
        entry
    }

    fn artifact_entry(mount_path: String, url: String, name: &str, version: &str) -> ArtifactEntry {
        ArtifactEntry {
            mount_path,
            archive_url: Some(url),
            vas_storage_name: name.to_string(),
            vas_storage_id: format!("{name}-id"),
            vas_version_id: version.to_string(),
            empty: None,
            missing_root_policy: None,
            archive_size: None,
        }
    }

    fn plan_from_entries(
        storages: Vec<StorageEntry>,
        artifacts: Vec<ArtifactEntry>,
        previous: Option<&StorageFingerprints>,
    ) -> StoragePlan {
        build_storage_plan(
            &StorageManifest {
                storages,
                artifacts,
            },
            CACHE_TEST_RUNTIME_DIR,
            previous,
        )
        .unwrap()
    }

    fn fresh_storage_plan(url: String, name: &str, version: &str) -> StoragePlan {
        plan_from_entries(
            vec![storage_entry(format!("/mnt/{name}"), url, name, version)],
            Vec::new(),
            None,
        )
    }

    fn fresh_storage_plan_with_archive_size(
        url: String,
        name: &str,
        version: &str,
        archive_size: u64,
    ) -> StoragePlan {
        plan_from_entries(
            vec![storage_entry_with_archive_size(
                format!("/mnt/{name}"),
                url,
                name,
                version,
                Some(archive_size),
            )],
            Vec::new(),
            None,
        )
    }

    fn fresh_duplicate_storage_plan(
        first_url: String,
        second_url: String,
        name: &str,
        version: &str,
    ) -> StoragePlan {
        plan_from_entries(
            vec![
                storage_entry("/mnt/duplicate-a".into(), first_url, name, version),
                storage_entry("/mnt/duplicate-b".into(), second_url, name, version),
            ],
            Vec::new(),
            None,
        )
    }

    fn fresh_artifact_plan(url: String, name: &str, version: &str) -> StoragePlan {
        plan_from_entries(
            Vec::new(),
            vec![artifact_entry(
                format!("/mnt/artifact-{name}"),
                url,
                name,
                version,
            )],
            None,
        )
    }

    fn storage_archive_url(plan: &StoragePlan, index: usize) -> Option<&str> {
        plan.archive_source_url_for_test(ArchiveHandle::storage(index))
    }

    fn artifact_archive_url(plan: &StoragePlan, index: usize) -> Option<&str> {
        plan.archive_source_url_for_test(ArchiveHandle::artifact(index))
    }

    fn tarball_bytes() -> Vec<u8> {
        tarball_with_contents(b"storage cache test file\n")
    }

    fn tarball_with_contents(content: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "file.txt", content)
                .unwrap();
            let encoder = builder.into_inner().unwrap();
            encoder.finish().unwrap();
        }
        bytes
    }

    fn write_cached_archive(home: &HomePaths, name: &str, version: &str, bytes: &[u8]) {
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), bytes).unwrap();
    }

    fn write_storage_lock(home: &HomePaths, name: &str, version: &str) {
        drop(lock::open_lock_file(&home.storage_lock(name, version)).unwrap());
    }

    #[tokio::test]
    async fn decoded_hit_survives_restart_and_compressed_eviction_while_archive_lock_is_busy() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("decoded-hit");
        let cache = decoded::DecodedCache::new(home.clone());
        let mount = temp.path().join("guest-mount");
        let entry = storage_entry(
            mount.to_str().unwrap().into(),
            "https://storage.example/immutable.tar.gz".into(),
            "name",
            "v1",
        );
        write_cached_archive(&home, "name", "v1", &tarball_bytes());
        write_storage_lock(&home, "name", "v1");
        cache.warm_from_archive("name", "v1").await.unwrap();
        cache.shutdown().await;
        let cache = decoded::DecodedCache::new(home.clone());

        // Extracted files survive owner restart and compressed-cache GC.
        // Holding the archive lock proves the hit never reopens the archive.
        std::fs::remove_file(home.storage_cache_dir("name", "v1").join("archive.tar.gz")).unwrap();
        let writer = lock::acquire(home.storage_lock("name", "v1"))
            .await
            .unwrap();
        let mut hit = plan_from_entries(vec![entry.clone()], Vec::new(), None);
        assert!(
            populate_cache_with_fresh_delivery(
                &mut hit,
                &sandbox,
                &home,
                &mut new_telemetry(),
                None,
                Some(&cache),
            )
            .await
            .unwrap()
            .is_none()
        );
        let files = hit.take_decoded();
        assert_eq!(files.len(), 1);
        cache.shutdown().await;
        let manifest = serde_json::to_vec(&hit.into_guest_manifest()).unwrap();
        let input = guest_contracts::storage_files::encode_input(
            &manifest,
            &[(files[0].0.as_str(), &files[0].1.files)],
        )
        .unwrap();
        assert!(guest_storage_apply::run_storage_files_bytes(&input));
        assert_eq!(
            std::fs::read(mount.join("file.txt")).unwrap(),
            b"storage cache test file\n"
        );
        assert_eq!(
            std::fs::metadata(mount.join("file.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o644
        );
        drop(writer);
    }

    #[tokio::test]
    async fn decoded_lookup_misses_do_not_alias_names_or_versions() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("decoded-identity");
        let cache = decoded::DecodedCache::new(home.clone());
        write_cached_archive(&home, "name", "v1", &tarball_bytes());
        write_storage_lock(&home, "name", "v1");
        cache.warm_from_archive("name", "v1").await.unwrap();
        let mut fill = fresh_storage_plan("https://storage.example/a".into(), "name", "v1");
        populate_cache_with_fresh_delivery(
            &mut fill,
            &sandbox,
            &home,
            &mut new_telemetry(),
            None,
            Some(&cache),
        )
        .await
        .unwrap();
        for (name, version) in [("name", "v2"), ("other", "v1")] {
            let url = "https://storage.example/selected";
            let mut plan = fresh_storage_plan(url.into(), name, version);
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut new_telemetry(),
                None,
                Some(&cache),
            )
            .await
            .unwrap();
            assert!(deferred.is_some());
            assert!(plan.take_decoded().is_empty());
            assert_eq!(storage_archive_url(&plan, 0), Some(url));
        }
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn instruction_and_artifact_delivery_never_reads_or_warms_decoded_entries() {
        for corrupt in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new("decoded-ineligible");
            let cache = decoded::DecodedCache::new(home.clone());
            write_cached_archive(&home, "name", "v1", &tarball_bytes());
            write_storage_lock(&home, "name", "v1");
            if corrupt {
                cache.warm_from_archive("name", "v1").await.unwrap();
                let entry = home
                    .storages_dir()
                    .join(crate::paths::short_digest("name"))
                    .join(format!("decoded-v1-{}", crate::paths::short_digest("v1")));
                std::fs::write(entry.join("index.json"), b"{").unwrap();
            }
            let url = "https://storage.example/a";
            let mut instruction =
                storage_entry("/mnt/instructions".into(), url.into(), "name", "v1");
            instruction.instructions_target_filename = Some("AGENTS.md".into());
            for mut plan in [
                plan_from_entries(vec![instruction], Vec::new(), None),
                fresh_artifact_plan(url.into(), "name", "v1"),
            ] {
                let deferred = populate_cache_with_fresh_delivery(
                    &mut plan,
                    &sandbox,
                    &home,
                    &mut new_telemetry(),
                    None,
                    Some(&cache),
                )
                .await
                .unwrap();
                assert!(deferred.is_none(), "irrelevant decoded fill was selected");
                assert!(plan.take_decoded().is_empty());
                let source =
                    storage_archive_url(&plan, 0).or_else(|| artifact_archive_url(&plan, 0));
                assert!(source.unwrap().starts_with("file://"));
            }
            if !corrupt {
                assert!(cache.get_ready("name", "v1").await.unwrap().is_none());
            }
            cache.shutdown().await;
        }
    }

    #[tokio::test]
    async fn ready_decoded_files_preserve_mount_and_manifest_admission() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("decoded-admission");
        let cache = decoded::DecodedCache::new(home.clone());
        write_cached_archive(&home, "name", "v1", &tarball_bytes());
        write_storage_lock(&home, "name", "v1");
        cache.warm_from_archive("name", "v1").await.unwrap();
        let url = "https://storage.example/a";
        let mut fill = fresh_storage_plan(url.into(), "name", "v1");
        populate_cache_with_fresh_delivery(
            &mut fill,
            &sandbox,
            &home,
            &mut new_telemetry(),
            None,
            Some(&cache),
        )
        .await
        .unwrap();
        let long_url = format!(
            "{url}?{}",
            "a".repeat(guest_contracts::storage_files::MAX_MANIFEST_BYTES)
        );
        let mut instruction = storage_entry("/mnt/instructions".into(), url.into(), "name", "v1");
        instruction.instructions_target_filename = Some("AGENTS.md".into());
        let plans = [
            plan_from_entries(
                vec![storage_entry(
                    "/mnt/parent".into(),
                    url.into(),
                    "name",
                    "v1",
                )],
                vec![artifact_entry(
                    "/mnt/parent/child".into(),
                    url.into(),
                    "name",
                    "v1",
                )],
                None,
            ),
            plan_from_entries(vec![instruction], Vec::new(), None),
            fresh_storage_plan(long_url, "name", "v1"),
        ];
        for mut plan in plans {
            populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut new_telemetry(),
                None,
                Some(&cache),
            )
            .await
            .unwrap();
            assert!(plan.take_decoded().is_empty());
            assert!(
                storage_archive_url(&plan, 0)
                    .unwrap()
                    .starts_with("file://")
            );
        }
        cache.shutdown().await;
    }

    struct SamePathConcurrentWriteDetectingSandbox {
        inner: MockSandbox,
        gate: MockLifecycleGate,
        active_paths: Mutex<HashSet<String>>,
    }

    impl SamePathConcurrentWriteDetectingSandbox {
        fn new(id: impl Into<String>) -> Self {
            let inner = MockSandbox::new(id);
            let gate = MockLifecycleGate::new();
            inner.set_write_file_lifecycle_gate(gate.clone());
            Self {
                inner,
                gate,
                active_paths: Mutex::new(HashSet::new()),
            }
        }

        fn gate(&self) -> MockLifecycleGate {
            self.gate.clone()
        }

        fn write_file_calls(&self) -> Vec<sandbox_mock::WriteFileCall> {
            self.inner.write_file_calls()
        }
    }

    #[async_trait]
    impl Sandbox for SamePathConcurrentWriteDetectingSandbox {
        fn id(&self) -> &str {
            self.inner.id()
        }

        fn source_ip(&self) -> &str {
            self.inner.source_ip()
        }

        fn host_process_pid(&self) -> Option<u32> {
            self.inner.host_process_pid()
        }

        async fn start(&mut self) -> sandbox::Result<()> {
            self.inner.start().await
        }

        async fn stop(&mut self) -> sandbox::Result<()> {
            self.inner.stop().await
        }

        async fn kill(&mut self) -> sandbox::Result<()> {
            self.inner.kill().await
        }

        async fn park(&mut self) -> sandbox::Result<sandbox::SandboxParkOutcome> {
            self.inner.park().await
        }

        async fn unpark(&mut self) -> sandbox::Result<()> {
            self.inner.unpark().await
        }

        async fn exec(
            &self,
            request: &sandbox::ExecRequest<'_>,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.exec(request).await
        }

        async fn exec_with_diagnostic_label(
            &self,
            request: &sandbox::ExecRequest<'_>,
            label: &'static str,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.exec_with_diagnostic_label(request, label).await
        }

        async fn apply_storage_manifest(
            &self,
            request: &sandbox::StorageManifestRequest<'_>,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.apply_storage_manifest(request).await
        }

        async fn restore_guest_state(
            &self,
            request: &sandbox::GuestStateRestoreRequest<'_>,
        ) -> sandbox::Result<sandbox::ExecResult> {
            self.inner.restore_guest_state(request).await
        }

        async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
            self.inner.read_file(path, max_bytes).await
        }

        async fn copy_file(
            &self,
            path: &str,
            host_path: &Path,
            options: sandbox::CopyFileOptions,
        ) -> sandbox::Result<sandbox::CopyFileResult> {
            self.inner.copy_file(path, host_path, options).await
        }

        async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
            {
                let mut active_paths = self.active_paths.lock().unwrap_or_else(|e| e.into_inner());
                if !active_paths.insert(path.to_string()) {
                    return Err(SandboxError::Operation {
                        operation: SandboxOperation::WriteFile,
                        reason: SandboxOperationReason::Other,
                        message: format!("concurrent write_file to {path}"),
                    });
                }
            }

            let result = self.inner.write_file(path, content).await;
            self.active_paths
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(path);
            result
        }

        async fn write_file_with_compression(
            &self,
            path: &str,
            content: &[u8],
            compression: sandbox::FileCompression,
        ) -> sandbox::Result<()> {
            self.inner
                .write_file_with_compression(path, content, compression)
                .await
        }

        async fn write_private_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
            self.inner.write_private_file(path, content).await
        }

        async fn start_process(
            &self,
            request: &sandbox::StartProcessRequest<'_>,
        ) -> sandbox::Result<sandbox::GuestProcessHandle> {
            self.inner.start_process(request).await
        }

        async fn start_agent_process(
            &self,
            request: &sandbox::StartAgentProcessRequest<'_>,
        ) -> sandbox::Result<sandbox::GuestAgentProcessHandle> {
            self.inner.start_agent_process(request).await
        }

        async fn wait_process(
            &self,
            handle: sandbox::GuestProcessHandle,
            timeout: Duration,
        ) -> sandbox::Result<sandbox::ProcessExit> {
            self.inner.wait_process(handle, timeout).await
        }
    }

    fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    async fn raw_http_url(response: Vec<u8>) -> (String, RawHttpTestServer) {
        raw_http_sequence_url(vec![response]).await
    }

    async fn raw_http_sequence_url(responses: Vec<Vec<u8>>) -> (String, RawHttpTestServer) {
        let server =
            RawHttpTestServer::spawn(responses.into_iter().map(RawHttpAction::Respond).collect())
                .await;
        (format!("{}/archive.tar.gz", server.url()), server)
    }

    struct GatedArchiveServer {
        url: String,
        requests: tokio::sync::mpsc::Receiver<usize>,
        release: Arc<Semaphore>,
        max_active: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<std::io::Result<()>>,
    }

    async fn gated_archive_server(body: Vec<u8>, connections: usize) -> GatedArchiveServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (request_tx, request_rx) = tokio::sync::mpsc::channel(connections);
        let release = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let task_release = Arc::clone(&release);
        let task_active = Arc::clone(&active);
        let task_max_active = Arc::clone(&max_active);
        let task = tokio::spawn(async move {
            let mut handlers = JoinSet::new();
            for index in 0..connections {
                let (mut socket, _) = listener.accept().await?;
                let body = body.clone();
                let request_tx = request_tx.clone();
                let release = Arc::clone(&task_release);
                let active = Arc::clone(&task_active);
                let max_active = Arc::clone(&task_max_active);
                handlers.spawn(async move {
                    read_http_request(&mut socket).await?;
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(current, Ordering::SeqCst);
                    request_tx.send(index).await.map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "request receiver dropped")
                    })?;
                    let permit = release.acquire_owned().await.map_err(|_| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "release semaphore closed")
                    })?;
                    // Each permit releases one response, without unblocking the next handler.
                    permit.forget();
                    socket.write_all(&http_response("200 OK", &body)).await?;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok::<(), io::Error>(())
                });
            }
            while let Some(result) = handlers.join_next().await {
                result.map_err(|error| io::Error::other(error.to_string()))??;
            }
            Ok(())
        });
        GatedArchiveServer {
            url: format!("http://{addr}/archive.tar.gz"),
            requests: request_rx,
            release,
            max_active,
            task,
        }
    }

    async fn telemetry_capture_server(expected_requests: usize) -> (String, RawHttpTestServer) {
        let server = RawHttpTestServer::spawn(
            (0..expected_requests)
                .map(|_| RawHttpAction::Respond(json_response("200 OK", r#"{"success":true}"#)))
                .collect(),
        )
        .await;
        (server.url(), server)
    }

    async fn await_raw_http_sequence(server: RawHttpTestServer) {
        server.assert_finished().await;
    }

    async fn wait_cached_archive(home: &HomePaths, name: &str, version: &str) -> Vec<u8> {
        let lock_path = home.storage_lock(name, version);
        let path = home.storage_cache_dir(name, version).join("archive.tar.gz");
        let _reader = tokio::time::timeout(Duration::from_secs(5), lock::acquire_shared(lock_path))
            .await
            .expect("background fill should release cache lock")
            .expect("cache lock should be readable");
        fs::read(&path)
            .await
            .unwrap_or_else(|e| panic!("failed to read cached archive {}: {e}", path.display()))
    }

    fn partial_content_response(total: usize) -> Vec<u8> {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total}\r\nContent-Length: 1\r\n\r\nx"
        )
        .into_bytes()
    }

    fn background_fill_group(
        url: String,
        name: &str,
        version: &str,
        archive_size: Option<u64>,
    ) -> CacheTargetGroup {
        CacheTargetGroup {
            targets: vec![CacheTarget {
                handle: ArchiveHandle::storage(0),
                name: name.to_string(),
                version: version.to_string(),
                archive_url: url,
                archive_size,
            }],
            archive_size,
        }
    }

    #[tokio::test]
    async fn fresh_delivery_records_empty_scan_summary() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut plan = plan_from_entries(Vec::new(), Vec::new(), None);
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut telemetry = new_telemetry();

        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert!(delivery.apply.is_empty());
        let ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "0",
            Some("prepared"),
        );
        assert_bounded_outcome(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "none",
            None,
        );
        assert_eq!(
            bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS),
            1
        );
        assert_eq!(
            bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX),
            0
        );
        assert_eq!(
            bounded_outcome_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN),
            0
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fresh_delivery_only_needs_ca_certificates_for_admitted_misses() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        crate::ca::ensure(&home).await.unwrap();
        let cert_file = home.ca_dir().join(crate::ca::CA_CERT);
        let empty_cert_dir = temp.path().join("empty-certs");
        fs::create_dir(&empty_cert_dir).await.unwrap();

        crate::test_fixtures::ignored_child::run_ignored_child_test(
            "storage_cache::tests::fresh_delivery_missing_ca_child",
            ("VM0_TEST_FRESH_DELIVERY_MISSING_CA", "1"),
            &[
                ("SSL_CERT_FILE", Some(cert_file.to_str().unwrap())),
                ("SSL_CERT_DIR", Some(empty_cert_dir.to_str().unwrap())),
            ],
            Duration::from_secs(30),
        )
        .await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "runs in an isolated process with its own CA certificate files"]
    async fn fresh_delivery_missing_ca_child() {
        if !crate::test_fixtures::ignored_child::ignored_child_test_env_guard_enabled((
            "VM0_TEST_FRESH_DELIVERY_MISSING_CA",
            "1",
        )) {
            return;
        }

        // Initialize unrelated telemetry before making this child's CA store
        // unavailable. Changing a private file needs no process-wide env mutation.
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/archive.tar.gz");
                then.status(200).body(body.clone());
            })
            .await;
        let cert_file = std::env::var_os("SSL_CERT_FILE").unwrap();
        let certificates = fs::read(&cert_file).await.unwrap();
        fs::write(&cert_file, b"").await.unwrap();

        for case in [
            "empty",
            "warm",
            "decoded-only",
            "oversized",
            "lock-busy",
            "capacity",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let admission = FreshArchiveDeliveryAdmission::new();
            let cancel = CancellationToken::new();
            let storages = (0..if case == "empty" { 0 } else { 2 })
                .map(|index| {
                    let name = format!("{case}-{index}");
                    if matches!(case, "warm" | "decoded-only") {
                        write_cached_archive(&home, &name, "v1", &body);
                    }
                    storage_entry_with_archive_size(
                        format!("/mnt/{name}"),
                        server.url("/archive.tar.gz"),
                        &name,
                        "v1",
                        Some(if case == "oversized" {
                            CACHE_MAX_SIZE + 1
                        } else {
                            body.len() as u64
                        }),
                    )
                })
                .collect();
            let mut plan = plan_from_entries(storages, Vec::new(), None);
            let decoded =
                (case == "decoded-only").then(|| decoded::DecodedCache::new(home.clone()));
            if let Some(cache) = &decoded {
                for index in 0..2 {
                    let name = format!("decoded-only-{index}");
                    write_storage_lock(&home, &name, "v1");
                    cache.warm_from_archive(&name, "v1").await.unwrap();
                    fs::remove_file(home.storage_cache_dir(&name, "v1").join("archive.tar.gz"))
                        .await
                        .unwrap();
                }
            }
            let mut writers = Vec::new();
            if case == "lock-busy" {
                for index in 0..2 {
                    writers.push(
                        lock::acquire(home.storage_lock(&format!("{case}-{index}"), "v1"))
                            .await
                            .unwrap(),
                    );
                }
            }
            let held_capacity = (case == "capacity").then(|| {
                Arc::clone(&admission.permits)
                    .try_acquire_many_owned(FRESH_DELIVERY_RUNNER_LIMIT as u32)
                    .unwrap()
            });

            let mut delivery = prepare_fresh_archive_delivery(
                &mut plan,
                &home,
                &admission,
                &cancel,
                &mut telemetry,
                decoded.as_ref(),
            )
            .await
            .unwrap_or_else(|error| panic!("{case} should not need a client: {error}"));
            if case == "warm" {
                let sandbox = MockSandbox::new("test");
                let deferred = populate_cache_with_fresh_delivery(
                    &mut plan,
                    &sandbox,
                    &home,
                    &mut telemetry,
                    Some(&mut delivery),
                    None,
                )
                .await
                .unwrap();
                assert!(deferred.is_none());
                let batches = sandbox.write_files_calls();
                let files: Vec<_> = batches.iter().flat_map(|batch| &batch.files).collect();
                assert_eq!(files.len(), 2);
                for index in 0..2 {
                    let path = guest_archive_path(&format!("warm-{index}"), "v1");
                    assert!(
                        files
                            .iter()
                            .any(|file| file.path == path && file.content == body)
                    );
                    assert_eq!(
                        storage_archive_url(&plan, index),
                        Some(format!("file://{path}").as_str())
                    );
                }
            }
            if let Some(cache) = &decoded {
                let sandbox = MockSandbox::new("decoded-only");
                let deferred = populate_cache_with_fresh_delivery(
                    &mut plan,
                    &sandbox,
                    &home,
                    &mut telemetry,
                    Some(&mut delivery),
                    Some(cache),
                )
                .await
                .unwrap();
                assert!(deferred.is_none());
                assert!(sandbox.write_files_calls().is_empty());
                let files = plan.take_decoded();
                assert_eq!(files.len(), 2);
                for (index, (mount, cached)) in files.iter().enumerate() {
                    assert_eq!(mount, &format!("/mnt/decoded-only-{index}"));
                    assert_eq!(cached.files.len(), 1);
                    assert_eq!(cached.files[0].path, "file.txt");
                    assert_eq!(
                        cached.files[0].content,
                        b"storage cache test file\n".as_slice()
                    );
                }
                cache.shutdown().await;
            }
            delivery.cancel_and_drain(&mut telemetry).await;
            drop(held_capacity);
            drop(writers);
            assert_eq!(
                admission.permits.available_permits(),
                FRESH_DELIVERY_RUNNER_LIMIT,
                "{case} must not retain capacity"
            );
        }

        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/archive.tar.gz"),
            "cold",
            "v1",
            body.len() as u64,
        );
        let error = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .err()
        .expect("an admitted miss still requires a valid client");
        assert!(
            error
                .to_string()
                .contains("build runner-owned archive client")
        );
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        assert!(!home.storage_cache_dir("cold", "v1").exists());
        get.assert_calls_async(0).await;

        // Restoring the CA store makes the same archive eligible again. A leaked
        // writer lock would skip this fetch; a cached failed client would fail it.
        fs::write(&cert_file, certificates).await.unwrap();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let sandbox = MockSandbox::new("test");
        assert!(
            populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
            .unwrap()
            .is_none()
        );
        get.assert_calls_async(1).await;
        assert_eq!(
            fs::read(home.storage_cache_dir("cold", "v1").join("archive.tar.gz"))
                .await
                .unwrap(),
            body
        );
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
    }

    #[tokio::test]
    async fn fresh_delivery_downloads_known_archive_once_and_stages_it() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-known.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let name = "fresh-known";
        let version = "v1";
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/fresh-known.tar.gz"),
            name,
            version,
            body.len() as u64,
        );

        let deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        assert!(deferred.is_none());
        get.assert_calls_async(1).await;
        assert_eq!(
            storage_archive_url(&plan, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz"))
                .await
                .unwrap(),
            body
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_COMPLETE, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, true);
        assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "1",
            Some("prepared"),
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "none",
            None,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_retains_runner_capacity_until_guest_staging_finishes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = Arc::new(MockSandbox::new("test"));
        let gate = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(gate.clone());
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-capacity.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/fresh-capacity.tar.gz"),
            "fresh-capacity",
            "v1",
            body.len() as u64,
        );
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let task = tokio::spawn({
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            async move {
                populate_cache_with_fresh_delivery(
                    &mut plan,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                    Some(&mut delivery),
                    None,
                )
                .await
            }
        });

        gate.wait_entered(1, Duration::from_secs(5))
            .await
            .expect("fresh archive should reach guest staging");
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT - 1,
            "published bytes must retain runner capacity while guest staging is blocked"
        );

        gate.release_one();
        assert!(task.await.unwrap().unwrap().is_none());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        get.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn fresh_delivery_unknown_size_uses_one_response_for_duplicate_targets() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let first = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-duplicate-a.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let second = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-duplicate-b.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let name = "fresh-duplicate";
        let version = "v1";
        let mut plan = fresh_duplicate_storage_plan(
            server.url("/fresh-duplicate-a.tar.gz"),
            server.url("/fresh-duplicate-b.tar.gz"),
            name,
            version,
        );

        let deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        assert!(deferred.is_none());
        first.assert_calls_async(1).await;
        second.assert_calls_async(0).await;
        let staged_url = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&plan, 0), Some(staged_url.as_str()));
        assert_eq!(storage_archive_url(&plan, 1), Some(staged_url.as_str()));
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].content, body);
        assert_eq!(
            fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz"))
                .await
                .unwrap(),
            body
        );
        assert_op(
            &telemetry.pending_ops_snapshot(),
            STORAGE_CACHE_FRESH_DELIVERY_SIZE_RESPONSE,
            true,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_unknown_size_is_bounded_to_the_original_candidate_prefix() {
        for prefix_count in [FRESH_DELIVERY_SCAN_LIMIT - 1, FRESH_DELIVERY_SCAN_LIMIT] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new("unknown-prefix");
            let mut telemetry = new_telemetry();
            let server = MockServer::start_async().await;
            let body = tarball_bytes();
            let get = server
                .mock_async(|when, then| {
                    when.method(GET).path("/unknown.tar.gz");
                    then.status(200).body(body.clone());
                })
                .await;
            let mut storages = (0..prefix_count)
                .map(|index| {
                    let name = format!("warm-{index}");
                    write_cached_archive(&home, &name, "v1", &body);
                    storage_entry_with_archive_size(
                        format!("/mnt/warm-{index}"),
                        server.url(format!("/warm-{index}.tar.gz")),
                        &name,
                        "v1",
                        Some(body.len() as u64),
                    )
                })
                .collect::<Vec<_>>();
            let original = server.url("/unknown.tar.gz");
            storages.push(storage_entry(
                "/mnt/unknown".into(),
                original.clone(),
                "unknown",
                "v1",
            ));
            let mut plan = plan_from_entries(storages, Vec::new(), None);

            let deferred =
                populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                    .await
                    .unwrap();

            let eligible = prefix_count < FRESH_DELIVERY_SCAN_LIMIT;
            assert_eq!(deferred.is_none(), eligible);
            drop(deferred);
            get.assert_calls_async(usize::from(eligible)).await;
            let expected = if eligible {
                format!("file://{}", guest_archive_path("unknown", "v1"))
            } else {
                original
            };
            assert_eq!(
                storage_archive_url(&plan, prefix_count),
                Some(expected.as_str())
            );
            let staged = sandbox.write_files_calls();
            let unknown = staged
                .iter()
                .flat_map(|batch| &batch.files)
                .find(|file| file.path == guest_archive_path("unknown", "v1"));
            assert_eq!(
                unknown.map(|file| file.content.as_slice()),
                eligible.then_some(body.as_slice())
            );
        }
    }

    #[tokio::test]
    async fn fresh_delivery_unknown_size_requires_a_bounded_response_length() {
        for (headers, reason) in [
            ("".to_string(), "response-size-missing"),
            ("Content-Length: 0\r\n".to_string(), "response-size-zero"),
            (
                format!("Content-Length: {}\r\n", CACHE_MAX_SIZE + 1),
                "response-size-oversized",
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new(reason);
            let mut telemetry = new_telemetry();
            let response = format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n");
            let (url, server_task) = raw_http_url(response.into_bytes()).await;
            let mut plan = fresh_storage_plan(url.clone(), "unknown-length", "v1");

            let result =
                populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                    .await;

            server_task.assert_finished().await;
            assert!(matches!(result, Err(RunnerError::Internal(_))), "{reason}");
            assert_eq!(storage_archive_url(&plan, 0), Some(url.as_str()));
            assert!(sandbox.write_files_calls().is_empty());
            assert!(
                !home
                    .storage_cache_dir("unknown-length", "v1")
                    .join("archive.tar.gz")
                    .exists()
            );
            assert_op_error(
                &telemetry.pending_ops_snapshot(),
                STORAGE_CACHE_FRESH_DELIVERY_FAILED,
                reason,
            );
        }
    }

    #[tokio::test]
    async fn fresh_delivery_releases_warm_entry_for_bounded_revalidation() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "fresh-warm";
        let version = "v1";
        let body = tarball_bytes();
        write_cached_archive(&home, name, version, &body);
        let mut plan = fresh_storage_plan_with_archive_size(
            "https://storage.example/unused.tar.gz".into(),
            name,
            version,
            body.len() as u64,
        );

        let deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        assert!(deferred.is_none());
        assert_eq!(
            storage_archive_url(&plan, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_WARM, true);
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
        assert_op(&ops, STORAGE_CACHE_HIT_READ, true);
    }

    #[tokio::test]
    async fn fresh_delivery_handles_artifact_downloads_through_the_same_owner() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-artifact.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let name = "fresh-artifact";
        let version = "v1";
        let mut entry = artifact_entry(
            "/mnt/artifact".into(),
            server.url("/fresh-artifact.tar.gz"),
            name,
            version,
        );
        entry.archive_size = Some(body.len() as u64);
        let mut plan = plan_from_entries(Vec::new(), vec![entry], None);

        let deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        assert!(deferred.is_none());
        get.assert_calls_async(1).await;
        assert_eq!(
            artifact_archive_url(&plan, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_SIZE_MANIFEST, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_STAGED, true);
    }

    #[tokio::test]
    async fn fresh_delivery_rejects_unsolicited_partial_content() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-partial.tar.gz")
                    .header_missing("range");
                then.status(206).body(tarball_bytes());
            })
            .await;
        let original = server.url("/fresh-partial.tar.gz");
        let mut plan = fresh_storage_plan_with_archive_size(
            original.clone(),
            "fresh-partial",
            "v1",
            tarball_bytes().len() as u64,
        );

        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

        assert!(matches!(result, Err(RunnerError::Internal(_))));
        get.assert_calls_async(1).await;
        assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir("fresh-partial", "v1")
                .join("archive.tar.gz")
                .exists()
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_FAILED, "http-status");
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED);
    }

    #[tokio::test]
    async fn fresh_delivery_does_not_follow_redirects() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let redirect = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-redirect.tar.gz")
                    .header_missing("range");
                then.status(302)
                    .header("location", "/redirect-target.tar.gz");
            })
            .await;
        let target = server
            .mock_async(|when, then| {
                when.method(GET).path("/redirect-target.tar.gz");
                then.status(200).body(body.clone());
            })
            .await;
        let original = server.url("/fresh-redirect.tar.gz");
        let mut plan = fresh_storage_plan_with_archive_size(
            original.clone(),
            "fresh-redirect",
            "v1",
            body.len() as u64,
        );

        let result =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry).await;

        assert!(matches!(result, Err(RunnerError::Internal(_))));
        redirect.assert_calls_async(1).await;
        target.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_FRESH_DELIVERY_FAILED, "http-status");
        assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST, 1);
    }

    #[tokio::test]
    async fn fresh_delivery_known_size_rejects_short_and_long_chunked_bodies() {
        for (case, delivered) in [
            ("short", b"abc".as_slice()),
            ("long", b"abcdefg".as_slice()),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new(case);
            let mut telemetry = new_telemetry();
            let mut response =
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    .to_vec();
            response.extend_from_slice(format!("{:x}\r\n", delivered.len()).as_bytes());
            response.extend_from_slice(delivered);
            response.extend_from_slice(b"\r\n0\r\n\r\n");
            let (url, server_task) = raw_http_url(response).await;
            let mut plan = fresh_storage_plan_with_archive_size(
                url.clone(),
                &format!("fresh-{case}"),
                "v1",
                5,
            );

            let result =
                populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                    .await;

            server_task.assert_finished().await;
            assert!(matches!(result, Err(RunnerError::Internal(_))));
            assert_eq!(storage_archive_url(&plan, 0), Some(url.as_str()));
            let ops = telemetry.pending_ops_snapshot();
            assert_op_error(
                &ops,
                STORAGE_CACHE_FRESH_DELIVERY_FAILED,
                "body-size-mismatch",
            );
            assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED);
        }
    }

    #[tokio::test]
    async fn fresh_delivery_cancellation_releases_lock_and_runner_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/fresh-cancel.tar.gz")
                    .header_missing("range");
                then.status(200)
                    .delay(Duration::from_secs(5))
                    .body(tarball_bytes());
            })
            .await;
        let name = "fresh-cancel";
        let version = "v1";
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/fresh-cancel.tar.gz"),
            name,
            version,
            tarball_bytes().len() as u64,
        );
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if get.calls_async().await == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fresh GET should start before cancellation");
        tokio::time::timeout(
            Duration::from_secs(1),
            delivery.cancel_and_drain(&mut telemetry),
        )
        .await
        .expect("cancellation should drain promptly");

        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        match lock::try_acquire_or_busy(home.storage_lock(name, version))
            .await
            .unwrap()
        {
            lock::TryLock::Acquired(_) => {}
            lock::TryLock::Busy => panic!("cancelled delivery must release its cache lock"),
        }
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_CANCELLED, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_DRAINED, true);
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "1",
            Some("prepared"),
        );
    }

    #[tokio::test]
    async fn fresh_delivery_cancellation_drains_started_publication() {
        let mut telemetry = new_telemetry();
        let plan = fresh_storage_plan(
            "https://storage.example/publication.tar.gz".to_string(),
            "fresh-publication",
            "v1",
        );
        let group = group_targets(collect_targets(plan.cache_candidates()))
            .into_iter()
            .next()
            .unwrap();
        let completed = Arc::new(Mutex::new(false));
        let task_completed = Arc::clone(&completed);
        let publication_cancel = CancellationToken::new();
        let release_after_cancel = publication_cancel.clone();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let mut delivery = FreshArchiveDelivery {
            cancel: publication_cancel,
            phase_records: FreshArchivePhaseRecords::default(),
            classification: JoinSet::new(),
            groups: None,
            apply: Vec::new(),
            fetches: JoinSet::new(),
            publications: JoinSet::new(),
        };
        let phase_records = delivery.phase_records.clone();
        delivery.publications.spawn(async move {
            let phase = FreshArchivePhaseGuard::new(
                &phase_records,
                STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION,
            );
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            *task_completed.lock().unwrap() = true;
            phase.finish(Ok(()));
            FreshArchivePublicationTaskResult {
                group,
                result: Ok(FreshArchivePublished {
                    bytes: Bytes::from_static(b"complete"),
                    permit: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
                }),
            }
        });

        entered_rx.await.unwrap();
        let release = async move {
            release_after_cancel.cancelled().await;
            release_tx.send(()).unwrap();
        };
        tokio::join!(delivery.cancel_and_drain(&mut telemetry), release);

        assert!(*completed.lock().unwrap());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_CANCELLED, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_DRAINED, true);
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION, true);
        assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION, 1);
        delivery.cancel_and_drain(&mut telemetry).await;
        assert_op_count(
            &telemetry.pending_ops_snapshot(),
            STORAGE_CACHE_FRESH_DELIVERY_PUBLICATION,
            1,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_known_oversized_archive_issues_no_request() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/fresh-oversized.tar.gz");
                then.status(200).body(tarball_bytes());
            })
            .await;
        let original = server.url("/fresh-oversized.tar.gz");
        let mut plan = fresh_storage_plan_with_archive_size(
            original.clone(),
            "fresh-oversized",
            "v1",
            CACHE_MAX_SIZE + 1,
        );

        let _deferred =
            populate_cache_through_fresh_delivery(&mut plan, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        get.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&plan, 0), Some(original.as_str()));
        assert!(sandbox.write_files_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_OVERSIZED, true);
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
    }

    #[tokio::test]
    async fn fresh_delivery_lock_contention_keeps_guest_ownership_without_a_request() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/fresh-lock-busy.tar.gz");
                then.status(200).body(tarball_bytes());
            })
            .await;
        let name = "fresh-lock-busy";
        let version = "v1";
        let mut plan = fresh_storage_plan_with_archive_size(
            server.url("/fresh-lock-busy.tar.gz"),
            name,
            version,
            tarball_bytes().len() as u64,
        );
        let writer = match lock::try_acquire_or_busy(home.storage_lock(name, version))
            .await
            .unwrap()
        {
            lock::TryLock::Acquired(writer) => writer,
            lock::TryLock::Busy => panic!("test must acquire the cache writer"),
        };
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();

        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert!(delivery.apply.is_empty());
        get.assert_calls_async(0).await;
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_LOCK_BUSY, true);
        assert_no_op(&ops, STORAGE_CACHE_FRESH_DELIVERY_ADMITTED);
        drop(delivery);
        drop(writer);
    }

    #[tokio::test]
    async fn fresh_delivery_scan_summary_marks_preparation_failure() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        fs::write(home.locks_dir(), b"not a directory")
            .await
            .unwrap();
        let mut plan = fresh_storage_plan_with_archive_size(
            "https://example.invalid/prepare-failure.tar.gz".to_string(),
            "prepare-failure",
            "v1",
            1,
        );
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut telemetry = new_telemetry();

        let error = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .err()
        .unwrap();

        assert!(error.to_string().contains("lock dir"));
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            false,
            "1",
            Some("prepare_failed"),
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            false,
            "none",
            None,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_reaches_later_misses_after_warm_prefix() {
        const WARM_PREFIX_COUNT: usize = 48;

        fn scan_fixture_plan(base_url: &str, body_size: u64) -> StoragePlan {
            let storages = (0..WARM_PREFIX_COUNT + 5)
                .map(|index| {
                    storage_entry_with_archive_size(
                        format!("/mnt/scan-{index}"),
                        format!("{base_url}/scan-{index}.tar.gz"),
                        &format!("scan-{index}"),
                        "v1",
                        Some(body_size),
                    )
                })
                .collect();
            plan_from_entries(storages, Vec::new(), None)
        }

        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let mut gets = Vec::new();
        for index in WARM_PREFIX_COUNT..WARM_PREFIX_COUNT + 5 {
            gets.push(
                server
                    .mock_async(|when, then| {
                        when.method(GET)
                            .path(format!("/scan-{index}.tar.gz"))
                            .header_missing("range");
                        then.status(200).body(body.clone());
                    })
                    .await,
            );
        }

        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        for index in 0..WARM_PREFIX_COUNT {
            let cache_dir = home.storage_cache_dir(&format!("scan-{index}"), "v1");
            fs::create_dir_all(&cache_dir).await.unwrap();
            fs::write(cache_dir.join("archive.tar.gz"), &body)
                .await
                .unwrap();
        }
        let mut plan = scan_fixture_plan(&server.base_url(), body.len() as u64);
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let mut telemetry = new_telemetry();
        let mut delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert_eq!(delivery.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
        let sandbox = MockSandbox::new("test");
        let deferred = populate_cache_with_fresh_delivery(
            &mut plan,
            &sandbox,
            &home,
            &mut telemetry,
            Some(&mut delivery),
            None,
        )
        .await
        .unwrap();

        assert!(
            deferred.is_some(),
            "the fifth eligible group should remain deferred background work"
        );
        drop(deferred);
        for get in gets.iter().take(FRESH_DELIVERY_PER_RUN_LIMIT) {
            get.assert_calls_async(1).await;
        }
        gets[FRESH_DELIVERY_PER_RUN_LIMIT]
            .assert_calls_async(0)
            .await;
        for index in WARM_PREFIX_COUNT..WARM_PREFIX_COUNT + FRESH_DELIVERY_PER_RUN_LIMIT {
            assert!(
                storage_archive_url(&plan, index).is_some_and(|url| url.starts_with("file://")),
                "scan fixture entry {index} should use the staged archive"
            );
        }
        let untouched_index = WARM_PREFIX_COUNT + FRESH_DELIVERY_PER_RUN_LIMIT;
        let untouched_url = server.url(format!("/scan-{untouched_index}.tar.gz"));
        assert_eq!(
            storage_archive_url(&plan, untouched_index),
            Some(untouched_url.as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(&ops, STORAGE_CACHE_FRESH_DELIVERY_WARM, WARM_PREFIX_COUNT);
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_ADMITTED,
            FRESH_DELIVERY_PER_RUN_LIMIT,
        );
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST,
            FRESH_DELIVERY_PER_RUN_LIMIT,
        );
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_COMPLETE,
            FRESH_DELIVERY_PER_RUN_LIMIT,
        );
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_PUBLISHED,
            FRESH_DELIVERY_PER_RUN_LIMIT,
        );
        assert_op_count(
            &ops,
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            FRESH_DELIVERY_PER_RUN_LIMIT,
        );
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "17_plus",
            Some("prepared"),
        );
        assert_eq!(
            bounded_outcome_count(&outcome_ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX),
            0
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "per_run",
            None,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_expanded_misses_require_complete_admission() {
        for case in [
            "complete",
            "capacity",
            "overflow",
            "writer",
            "unknown",
            "oversized",
            "unkeyed",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let server = MockServer::start_async().await;
            let body = tarball_bytes();
            let cold_get = server
                .mock_async(|when, then| {
                    when.method(GET).path_includes("/expanded-");
                    then.status(200).body(body.clone());
                })
                .await;
            let mut storages = (0..98)
                .map(|index| {
                    let name = format!("warm-{index}");
                    write_cached_archive(&home, &name, "v1", &body);
                    storage_entry_with_archive_size(
                        format!("/warm/{index}"),
                        server.url(format!("/warm-{index}")),
                        &name,
                        "v1",
                        Some(body.len() as u64),
                    )
                })
                .collect::<Vec<_>>();
            let cold_count = if case == "overflow" { 5 } else { 4 };
            for index in 0..cold_count {
                let size = match (case, index) {
                    ("unknown", 3) => None,
                    ("oversized", 3) => Some(CACHE_MAX_SIZE + 1),
                    _ => Some(body.len() as u64),
                };
                storages.push(storage_entry_with_archive_size(
                    format!("/cold/{index}"),
                    server.url(format!("/expanded-{index}")),
                    &if case == "unkeyed" && index == 3 {
                        String::new()
                    } else {
                        format!("expanded-{index}")
                    },
                    "v1",
                    size,
                ));
            }
            let mut plan = plan_from_entries(storages, Vec::new(), None);
            let admission = FreshArchiveDeliveryAdmission::new();
            let held = if case == "capacity" {
                Some(
                    Arc::clone(&admission.permits)
                        .try_acquire_many_owned(5)
                        .unwrap(),
                )
            } else {
                None
            };
            let writer = if case == "writer" {
                Some(
                    lock::acquire(home.storage_lock("expanded-3", "v1"))
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            let mut telemetry = new_telemetry();
            let mut delivery = prepare_fresh_archive_delivery(
                &mut plan,
                &home,
                &admission,
                &CancellationToken::new(),
                &mut telemetry,
                None,
            )
            .await
            .unwrap();
            let sandbox = MockSandbox::new(case);
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
            .unwrap();
            let admitted = case == "complete";
            cold_get
                .assert_calls_async(if admitted { 4 } else { 0 })
                .await;
            for index in 0..cold_count {
                let expected = if admitted {
                    format!(
                        "file://{}",
                        guest_archive_path(&format!("expanded-{index}"), "v1")
                    )
                } else {
                    server.url(format!("/expanded-{index}"))
                };
                assert_eq!(
                    storage_archive_url(&plan, 98 + index),
                    Some(expected.as_str()),
                    "{case}"
                );
                let batches = sandbox.write_files_calls();
                let staged = batches.iter().flat_map(|batch| &batch.files).find(|file| {
                    file.path == guest_archive_path(&format!("expanded-{index}"), "v1")
                });
                assert_eq!(
                    staged.map(|file| file.content.as_slice()),
                    admitted.then_some(body.as_slice()),
                    "{case}"
                );
            }
            drop(deferred);
            delivery.cancel_and_drain(&mut telemetry).await;
            drop(writer);
            drop(held);
            assert_eq!(
                admission.permits.available_permits(),
                FRESH_DELIVERY_RUNNER_LIMIT,
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn fresh_delivery_concurrent_expanded_sets_keep_whole_request_ownership() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let mut warm = Vec::new();
        for index in 0..98 {
            let name = format!("shared-warm-{index}");
            write_cached_archive(&home, &name, "v1", &body);
            warm.push(storage_entry_with_archive_size(
                format!("/warm/{index}"),
                server.url(format!("/warm-{index}")),
                &name,
                "v1",
                Some(body.len() as u64),
            ));
        }
        let mut gets = Vec::new();
        for lane in 0..4 {
            gets.push(
                server
                    .mock_async(|when, then| {
                        when.method(GET).path_includes(format!("/lane-{lane}-"));
                        then.status(200).body(body.clone());
                    })
                    .await,
            );
        }
        let admission = FreshArchiveDeliveryAdmission::new();
        let mut preparations = Vec::new();
        for lane in 0..4 {
            let mut entries = warm.clone();
            for index in 0..4 {
                let name = format!("lane-{lane}-{index}");
                entries.push(storage_entry_with_archive_size(
                    format!("/cold/{index}"),
                    server.url(format!("/{name}")),
                    &name,
                    "v1",
                    Some(body.len() as u64),
                ));
            }
            let home = &home;
            let admission = &admission;
            preparations.push(async move {
                let mut plan = plan_from_entries(entries, Vec::new(), None);
                let mut telemetry = new_telemetry();
                let delivery = prepare_fresh_archive_delivery(
                    &mut plan,
                    home,
                    admission,
                    &CancellationToken::new(),
                    &mut telemetry,
                    None,
                )
                .await
                .unwrap();
                (lane, plan, telemetry, delivery)
            });
        }
        // Every preparation completes while all admitted requests are still
        // held before Guest staging, so no lane can borrow released capacity.
        let prepared = futures_util::future::join_all(preparations).await;
        let mut admitted_lanes = 0;
        for (lane, mut plan, mut telemetry, mut delivery) in prepared {
            let sandbox = MockSandbox::new("concurrent-expanded");
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                Some(&mut delivery),
                None,
            )
            .await
            .unwrap();
            let staged = (98..102)
                .filter(|&index| {
                    storage_archive_url(&plan, index).is_some_and(|url| url.starts_with("file://"))
                })
                .count();
            assert!(
                staged == 0 || staged == 4,
                "lane {lane} has a partial set: {staged}"
            );
            gets[lane].assert_calls_async(staged).await;
            if staged == 4 {
                admitted_lanes += 1;
            }
            let batches = sandbox.write_files_calls();
            for index in 0..4 {
                let name = format!("lane-{lane}-{index}");
                let file = batches
                    .iter()
                    .flat_map(|batch| &batch.files)
                    .find(|file| file.path == guest_archive_path(&name, "v1"));
                assert_eq!(
                    file.map(|file| file.content.as_slice()),
                    (staged == 4).then_some(body.as_slice())
                );
            }
            drop(deferred);
            delivery.cancel_and_drain(&mut telemetry).await;
        }
        assert_eq!(admitted_lanes, 2);
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
    }

    #[tokio::test]
    async fn fresh_delivery_runner_capacity_keeps_late_misses_on_ordinary_source() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut telemetry = new_telemetry();
        let storages = (0..=FRESH_DELIVERY_SCAN_LIMIT)
            .map(|index| {
                storage_entry_with_archive_size(
                    format!("/mnt/saturated-{index}"),
                    format!("https://example.invalid/saturated-{index}.tar.gz"),
                    &format!("saturated-{index}"),
                    "v1",
                    Some(1),
                )
            })
            .collect();
        let mut plan = plan_from_entries(storages, Vec::new(), None);
        let admission = FreshArchiveDeliveryAdmission::new();
        let held_permits = (0..FRESH_DELIVERY_RUNNER_LIMIT)
            .map(|_| Arc::clone(&admission.permits).try_acquire_owned().unwrap())
            .collect::<Vec<_>>();
        let cancel = CancellationToken::new();

        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert!(delivery.apply.is_empty());
        assert!(
            !home
                .storage_lock(&format!("saturated-{FRESH_DELIVERY_SCAN_LIMIT}"), "v1")
                .exists(),
            "a saturated runner must not acquire another archive writer"
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(action, _, error)| {
                    action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY
                        && error.as_deref() == Some("runner-wide")
                })
                .count(),
            FRESH_DELIVERY_SCAN_LIMIT
        );
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "runner_wide",
            None,
        );
        assert_eq!(
            bounded_outcome_count(&outcome_ops, STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP),
            1
        );
        drop(held_permits);
    }

    #[tokio::test]
    async fn fresh_delivery_scan_summary_buckets_unknown_suffix_sizes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET);
                then.status(200).body(tarball_bytes());
            })
            .await;
        let mut storages = (0..FRESH_DELIVERY_SCAN_LIMIT)
            .map(|index| {
                storage_entry_with_archive_size(
                    format!("/mnt/unknown-prefix-{index}"),
                    server.url(format!("/unknown-prefix-{index}.tar.gz")),
                    &format!("unknown-prefix-{index}"),
                    "v1",
                    Some(CACHE_MAX_SIZE + 1),
                )
            })
            .collect::<Vec<_>>();
        storages.push(storage_entry_with_archive_size(
            "/mnt/known-suffix".to_string(),
            server.url("/known-suffix.tar.gz"),
            "known-suffix",
            "v1",
            Some(1),
        ));
        storages.push(storage_entry_with_archive_size(
            "/mnt/unknown-suffix".to_string(),
            server.url("/unknown-suffix.tar.gz"),
            "unknown-suffix",
            "v1",
            None,
        ));
        storages.push(storage_entry_with_archive_size(
            "/mnt/conflicting-suffix-a".to_string(),
            server.url("/conflicting-suffix.tar.gz"),
            "conflicting-suffix",
            "v1",
            Some(1),
        ));
        storages.push(storage_entry_with_archive_size(
            "/mnt/conflicting-suffix-b".to_string(),
            server.url("/conflicting-suffix.tar.gz"),
            "conflicting-suffix",
            "v1",
            Some(2),
        ));
        let mut plan = plan_from_entries(storages, Vec::new(), None);
        let admission = FreshArchiveDeliveryAdmission::new();
        let held_permits = Arc::clone(&admission.permits)
            .try_acquire_many_owned(FRESH_DELIVERY_RUNNER_LIMIT as u32)
            .unwrap();
        let cancel = CancellationToken::new();

        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert!(delivery.apply.is_empty());
        get.assert_calls_async(0).await;
        drop(held_permits);
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX,
            true,
            "3_4",
            Some("1"),
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_SUFFIX_UNKNOWN,
            true,
            "2",
            None,
        );
    }

    #[tokio::test]
    async fn fresh_delivery_enforces_per_run_and_runner_wide_admission() {
        fn plan_for(
            base_url: &str,
            prefix: &str,
            start: usize,
            count: usize,
            body_size: u64,
        ) -> StoragePlan {
            let storages = (start..start + count)
                .map(|index| {
                    storage_entry_with_archive_size(
                        format!("/mnt/{prefix}-{index}"),
                        format!("{base_url}/{prefix}-{index}.tar.gz"),
                        &format!("{prefix}-{index}"),
                        "v1",
                        Some(body_size),
                    )
                })
                .collect();
            plan_from_entries(storages, Vec::new(), None)
        }

        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let admission = FreshArchiveDeliveryAdmission::new();
        let cancel = CancellationToken::new();
        let body = tarball_bytes();
        let body_size = body.len() as u64;
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let _get = server
            .mock_async(|when, then| {
                when.method(GET).header_missing("range");
                then.status(200)
                    .delay(Duration::from_secs(5))
                    .body(body.clone());
            })
            .await;
        let mut first_plan = plan_for(&server.base_url(), "first", 0, 5, body_size);
        let mut second_plan = plan_for(&server.base_url(), "second", 5, 4, body_size);
        let mut third_plan = plan_for(&server.base_url(), "third", 9, 1, body_size);

        let mut first = prepare_fresh_archive_delivery(
            &mut first_plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let mut second = prepare_fresh_archive_delivery(
            &mut second_plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        let mut third = prepare_fresh_archive_delivery(
            &mut third_plan,
            &home,
            &admission,
            &cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();

        assert_eq!(first.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
        assert_eq!(second.apply.len(), FRESH_DELIVERY_PER_RUN_LIMIT);
        assert!(third.apply.is_empty());
        assert_eq!(admission.permits.available_permits(), 0);
        let ops = telemetry.pending_ops_snapshot();
        assert!(ops.iter().any(|(action, _, error)| {
            action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY && error.as_deref() == Some("per-run")
        }));
        assert!(ops.iter().any(|(action, _, error)| {
            action == STORAGE_CACHE_FRESH_DELIVERY_CAPACITY
                && error.as_deref() == Some("runner-wide")
        }));
        let outcome_ops = telemetry.pending_ops_with_outcome_snapshot();
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "5_8",
            Some("prepared"),
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_GROUPS,
            true,
            "1",
            Some("prepared"),
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "per_run",
            None,
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "runner_wide",
            None,
        );
        assert_bounded_outcome(
            &outcome_ops,
            STORAGE_CACHE_FRESH_DELIVERY_SCAN_STOP,
            true,
            "none",
            None,
        );
        first.cancel_and_drain(&mut telemetry).await;
        second.cancel_and_drain(&mut telemetry).await;
        third.cancel_and_drain(&mut telemetry).await;
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
    }

    #[tokio::test]
    async fn hit_path_reads_from_disk_and_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Pre-populate the cache to simulate a hit.
        let name = "seed-skill-foo";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        // Give populate_cache an R2-looking URL — it should never be called.
        let mut manifest = fresh_storage_plan(
            "https://r2.example.com/never-called.tar.gz".to_string(),
            name,
            version,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();
        assert!(records.is_empty());

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "expected storage_cache_hit in {ops:?}"
        );
        assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
        assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
        assert_op(&ops, STORAGE_CACHE_HIT_READ, true);
        assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 1);
        assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 2);
        assert_op_count(&ops, STORAGE_CACHE_HIT_READ, 1);
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
    }

    #[tokio::test]
    async fn production_warm_hit_returns_no_deferred_fill() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "production-warm-hit";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());
        let mut manifest = fresh_storage_plan(
            "https://r2.example.com/never-called.tar.gz".into(),
            name,
            version,
        );

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_none());
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(sandbox.write_files_calls().len(), 1);
        let ops = telemetry.pending_ops_snapshot();
        assert_no_op(&ops, "storage_cache_background_fill_deferred_count_1");
        assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
    }

    #[tokio::test]
    async fn guarded_hit_path_reads_from_disk_and_rewrites_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "guarded-hit";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());
        write_storage_lock(&home, name, version);
        let mut manifest = fresh_storage_plan(
            "https://r2.example.com/never-called.tar.gz".into(),
            name,
            version,
        );

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_none());

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_hit", true);
        assert_op(&ops, "storage_cache_passthrough_hit_count_1", true);
        assert_op(&ops, "storage_cache_passthrough_miss_count_0", true);
    }

    #[tokio::test]
    async fn guarded_archive_without_lock_recreates_lock_and_hits() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-missing-lock";
        let version = "v1";
        let original = "https://r2.example.com/recreate-lock.tar.gz".to_string();
        write_cached_archive(&home, name, version, &tarball_bytes());
        let lock_path = home.storage_lock(name, version);
        assert!(!lock_path.exists());
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_none());

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert!(lock_path.exists());
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_hit", true);
        assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
    }

    #[tokio::test]
    async fn guarded_miss_passthrough_keeps_url_without_http_or_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (hit_tx, mut hit_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = hit_tx.send(());
                let _ = socket
                    .write_all(&http_response("500 Internal Server Error", b""))
                    .await;
            }
        });
        let name = "guarded-miss";
        let version = "v1";
        let original = format!("http://{addr}/archive.tar.gz");
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            hit_rx.try_recv().is_err(),
            "guarded miss should not contact the archive URL"
        );
        server_task.abort();
        let _ = server_task.await;
        assert!(!home.storage_cache_dir(name, version).exists());
        assert!(!home.storage_lock(name, version).exists());
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.write_files_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
        assert_op(&ops, "storage_cache_passthrough_miss_count_1", true);
        assert_op(&ops, "storage_cache_passthrough_hit_count_0", true);
        assert_no_op(&ops, "storage_cache_skipped_head_failed");
    }

    #[tokio::test]
    async fn miss_passthrough_defers_cache_fill_until_started() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let expected_body = body.clone();
        let (allow_tx, allow_rx) = tokio::sync::oneshot::channel();
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::WaitThenRespond {
                release: allow_rx,
                response: partial_content_response(body.len()),
            },
            RawHttpAction::Respond(http_response("200 OK", &body)),
        ])
        .await;
        let original = format!("{}/archive.tar.gz", server.url());
        let name = "background-miss";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap()
            .expect("cold miss should return deferred cache fill");

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(matches!(
            server.try_next_request(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.write_files_calls().is_empty());

        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
        assert_op(&ops, "storage_cache_background_fill_deferred_count_1", true);
        assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
        assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);

        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();
        deferred.start(&coordinator, &mut telemetry);
        server
            .next_request("started background fill archive request")
            .await;
        allow_tx.send(()).unwrap();
        server.assert_finished().await;
        assert_eq!(
            wait_cached_archive(&home, name, version).await,
            expected_body
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_op(
            &ops,
            "storage_cache_background_fill_scheduled_count_1",
            true,
        );
        assert_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY, true);
        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn dropped_deferred_fill_starts_no_http_or_cache_work() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (request_tx, mut request_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = request_tx.send(());
                let _ = socket
                    .write_all(&http_response("500 Internal Server Error", b""))
                    .await;
            }
        });
        let name = "dropped-background-miss";
        let version = "v1";
        let original = format!("http://{addr}/archive.tar.gz");
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap()
            .expect("cold miss should return deferred cache fill");
        drop(deferred);
        tokio::task::yield_now().await;

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(matches!(
            request_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(!home.storage_cache_dir(name, version).exists());
        assert!(!home.storage_lock(name, version).exists());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_background_fill_deferred_count_1", true);
        assert_no_op(&ops, "storage_cache_background_fill_scheduled_count_1");
        assert_no_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_DEFERRED_DELAY);

        server_task.abort();
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn background_fill_reports_filled_outcome_batch() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let (archive_url, archive_server) = raw_http_sequence_url(vec![
            partial_content_response(body.len()),
            http_response("200 OK", &body),
        ])
        .await;
        let telemetry_server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(
            json_response("200 OK", r#"{"success":true}"#),
        )])
        .await;
        let telemetry_api_url = telemetry_server.url();
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry_for_api_url(&telemetry_api_url);
        let name = "background-report";
        let version = "v1";
        let mut plan = fresh_storage_plan(archive_url, name, version);
        let coordinator = StorageCacheBackgroundFillCoordinator::new().unwrap();

        select_background_fill(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .start(&coordinator, &mut telemetry);

        await_raw_http_sequence(archive_server).await;
        assert_eq!(wait_cached_archive(&home, name, version).await, body);
        let requests = telemetry_server.assert_finished_with_requests().await;
        let request = &requests[0];
        assert!(request.contains(r#""action_type":"storage_cache_background_fill_filled""#));
        assert!(
            request.contains(r#""action_type":"storage_cache_background_fill_size_lt_64_kib""#)
        );
        assert!(!request.contains(name));
        assert!(!request.contains(version));
        assert!(!request.contains("archive.tar.gz"));
        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn bounded_maintenance_progresses_past_decoded_and_already_retired_hits() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("maintenance-progress");
        let cache = decoded::DecodedCache::new(home.clone());
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET);
                then.status(500);
            })
            .await;
        let entries = (0..3)
            .map(|index| {
                let name = format!("maintenance-progress-{index}");
                write_cached_archive(&home, &name, "v1", &tarball_bytes());
                write_storage_lock(&home, &name, "v1");
                storage_entry(
                    format!("/mnt/progress-{index}"),
                    server.url("/unused"),
                    &name,
                    "v1",
                )
            })
            .collect::<Vec<_>>();
        cache
            .warm_from_archive("maintenance-progress-0", "v1")
            .await
            .unwrap();
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
        // Two fill operations and three retirements must progress through one
        // queue slot. Already decoded/retired prefixes cannot starve later keys.
        for _ in 0..5 {
            let mut plan = plan_from_entries(entries.clone(), Vec::new(), None);
            let mut telemetry = new_telemetry();
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &sandbox,
                &home,
                &mut telemetry,
                None,
                Some(&cache),
            )
            .await
            .unwrap();
            drop(plan);
            deferred.unwrap().start(&coordinator, &mut telemetry);
            coordinator.wait_idle_for_test().await;
        }
        coordinator.shutdown().await;
        for index in 0..3 {
            let name = format!("maintenance-progress-{index}");
            assert!(cache.get_ready(&name, "v1").await.unwrap().is_some());
            assert!(
                !home
                    .storage_cache_dir(&name, "v1")
                    .join("archive.tar.gz")
                    .exists()
            );
        }
        get.assert_calls_async(0).await;
        cache.shutdown().await;
    }

    #[tokio::test]
    async fn queued_archive_demand_takes_precedence_over_retirement_in_either_order() {
        for retirement_first in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let bytes = tarball_bytes();
            write_cached_archive(&home, "queued", "v1", &bytes);
            write_storage_lock(&home, "queued", "v1");
            let cache = decoded::DecodedCache::new(home.clone());
            cache.warm_from_archive("queued", "v1").await.unwrap();
            let mut server = gated_archive_server(bytes.clone(), 1).await;
            let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
            let reporter = new_telemetry().reporter();
            assert_eq!(
                coordinator.submit(
                    background_fill_group(
                        server.url.clone(),
                        "active",
                        "v1",
                        Some(bytes.len() as u64)
                    ),
                    home.clone(),
                    reporter.clone(),
                    BackgroundFillAction::Fill(None),
                ),
                BackgroundFillAdmission::Accepted
            );
            tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
                .await
                .unwrap()
                .unwrap();
            let group =
                background_fill_group(server.url.clone(), "queued", "v1", Some(bytes.len() as u64));
            let mut actions = [
                BackgroundFillAction::Fill(None),
                BackgroundFillAction::RetireArchive(cache.clone()),
            ];
            if retirement_first {
                actions.reverse();
            }
            for (index, action) in actions.into_iter().enumerate() {
                assert_eq!(
                    coordinator.submit(group.clone(), home.clone(), reporter.clone(), action),
                    if index == 0 {
                        BackgroundFillAdmission::Accepted
                    } else {
                        BackgroundFillAdmission::Deduplicated
                    }
                );
            }
            server.release.add_permits(1);
            coordinator.wait_idle_for_test().await;
            coordinator.shutdown().await;
            cache.shutdown().await;
            server.task.await.unwrap().unwrap();
            assert_eq!(
                std::fs::read(
                    home.storage_cache_dir("queued", "v1")
                        .join("archive.tar.gz")
                )
                .unwrap(),
                bytes
            );
        }
    }

    #[tokio::test]
    async fn background_fill_coordinator_bounds_distinct_keys_globally() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = b"background-fill-body".to_vec();
        let mut server = gated_archive_server(body.clone(), 3).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(2, 4).unwrap();
        let reporter = new_telemetry().reporter();

        for (name, version) in [("global-a", "v1"), ("global-b", "v1"), ("global-c", "v1")] {
            assert_eq!(
                coordinator.submit(
                    background_fill_group(
                        server.url.clone(),
                        name,
                        version,
                        Some(body.len() as u64),
                    ),
                    home.clone(),
                    reporter.clone(),
                    BackgroundFillAction::Fill(None),
                ),
                BackgroundFillAdmission::Accepted
            );
        }

        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
                .await
                .expect("two admitted workers should reach the archive server")
                .expect("archive request channel should remain open");
        }
        // A FIFO checkpoint observes the third key's admission decision even if
        // an over-admitted worker has not reached its HTTP handler yet.
        let (complete, completed) = oneshot::channel();
        let (active_workers, pending_keys) = tokio::time::timeout(Duration::from_secs(5), async {
            coordinator
                .lifecycle
                .inner
                .commands
                .send(BackgroundFillCommand::Checkpoint(complete))
                .await
                .expect("supervisor command channel should remain open");
            completed
                .await
                .expect("supervisor should acknowledge the checkpoint")
        })
        .await
        .expect("supervisor should process all three starts while responses are held");

        server.release.add_permits(1);
        let third_request =
            tokio::time::timeout(Duration::from_secs(5), server.requests.recv()).await;
        server.release.add_permits(2);
        join_raw_http_task(server.task, "archive server after all workers are released")
            .await
            .expect("archive server should not fail");
        tokio::time::timeout(Duration::from_secs(5), coordinator.shutdown())
            .await
            .expect("coordinator should drain all admitted workers");

        // Assert only after draining, so a failing admission oracle also joins its work.
        assert_eq!(
            (active_workers, pending_keys),
            (2, 1),
            "the third key must remain queued while both active responses are held"
        );
        third_request
            .expect("the third worker should start after one slot is released")
            .expect("archive request channel should remain open");
        assert_eq!(server.max_active.load(Ordering::SeqCst), 2);
        for name in ["global-a", "global-b", "global-c"] {
            assert_eq!(
                std::fs::read(home.storage_cache_dir(name, "v1").join("archive.tar.gz")).unwrap(),
                body
            );
        }
    }

    #[tokio::test]
    async fn background_fill_coordinator_deduplicates_same_key_and_reports_subscribers() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let (archive_url, archive_server) =
            raw_http_sequence_url(vec![http_response("200 OK", &body)]).await;
        let (telemetry_url, telemetry_server) = telemetry_capture_server(2).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 4).unwrap();
        let first_reporter = new_telemetry_for_api_url(&telemetry_url).reporter();
        let second_reporter = new_telemetry_for_api_url(&telemetry_url).reporter();
        let group =
            background_fill_group(archive_url, "deduplicated", "v1", Some(body.len() as u64));

        assert_eq!(
            coordinator.submit(
                group.clone(),
                home.clone(),
                first_reporter,
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
        assert_eq!(
            coordinator.submit(
                group,
                home.clone(),
                second_reporter,
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Deduplicated
        );

        await_raw_http_sequence(archive_server).await;
        assert_eq!(wait_cached_archive(&home, "deduplicated", "v1").await, body);
        coordinator.shutdown().await;

        let reports = telemetry_server.assert_finished_with_requests().await;
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|request| {
            request.contains(r#""action_type":"storage_cache_background_fill_filled""#)
        }));
    }

    #[tokio::test]
    async fn background_fill_coordinator_saturates_queue_without_starting_excess_work() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = b"queue-body".to_vec();
        let mut server = gated_archive_server(body.clone(), 3).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
        let first_reporter = new_telemetry().reporter();
        let first_group = background_fill_group(
            server.url.clone(),
            "queue-active",
            "v1",
            Some(body.len() as u64),
        );
        assert_eq!(
            coordinator.submit(
                first_group,
                home.clone(),
                first_reporter,
                BackgroundFillAction::Fill(None)
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .expect("the active queue test worker should reach the archive server")
            .expect("archive request channel should remain open");

        let mut telemetry = new_telemetry();
        DeferredBackgroundFill {
            groups: vec![
                background_fill_group(
                    server.url.clone(),
                    "queue-waiting",
                    "v1",
                    Some(body.len() as u64),
                ),
                background_fill_group(
                    server.url.clone(),
                    "queue-rejected",
                    "v1",
                    Some(body.len() as u64),
                ),
            ]
            .into_iter()
            .map(|group| (group, BackgroundFillAction::Fill(None)))
            .collect(),
            home: home.clone(),
            selected_at: Instant::now(),
        }
        .start(&coordinator, &mut telemetry);

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_BACKGROUND_FILL_QUEUE_SATURATED, true);
        assert_op(
            &ops,
            "storage_cache_background_fill_scheduled_count_1",
            true,
        );
        assert!(matches!(
            server.requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        server.release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .expect("the admitted queued key should start after the active key completes")
            .expect("archive request channel should remain open");
        server.release.add_permits(1);
        assert_eq!(
            wait_cached_archive(&home, "queue-waiting", "v1").await,
            body
        );
        server.task.abort();
        let _ = server.task.await;
        assert!(!home.storage_cache_dir("queue-rejected", "v1").exists());
        coordinator.shutdown().await;
    }

    #[tokio::test]
    async fn background_fill_coordinator_cancels_queued_work_during_shutdown() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let body = tarball_bytes();
        let mut server = gated_archive_server(body.clone(), 1).await;
        let (telemetry_url, telemetry_server) = telemetry_capture_server(2).await;
        let coordinator = StorageCacheBackgroundFillCoordinator::new_with_limits(1, 1).unwrap();
        let reporter = new_telemetry_for_api_url(&telemetry_url).reporter();

        assert_eq!(
            coordinator.submit(
                background_fill_group(
                    server.url.clone(),
                    "shutdown-active",
                    "v1",
                    Some(body.len() as u64),
                ),
                home.clone(),
                reporter.clone(),
                BackgroundFillAction::Fill(None),
            ),
            BackgroundFillAdmission::Accepted
        );
        tokio::time::timeout(Duration::from_secs(5), server.requests.recv())
            .await
            .expect("active shutdown worker should reach the archive server")
            .expect("archive request channel should remain open");
        assert_eq!(
            coordinator.submit(
                background_fill_group(
                    server.url.clone(),
                    "shutdown-queued",
                    "v1",
                    Some(body.len() as u64),
                ),
                home.clone(),
                reporter,
                BackgroundFillAction::Fill(None),
            ),
            BackgroundFillAdmission::Accepted
        );

        let shutdown_coordinator = coordinator.clone();
        let shutdown_task = tokio::spawn(async move {
            shutdown_coordinator.shutdown().await;
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !coordinator.is_closed_for_test() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown should close admissions before draining workers");
        server.release.add_permits(1);
        shutdown_task.await.expect("shutdown task should not panic");
        join_raw_http_task(server.task, "active archive server during shutdown")
            .await
            .expect("archive server should not fail");
        assert_eq!(
            wait_cached_archive(&home, "shutdown-active", "v1").await,
            body
        );
        assert!(!home.storage_cache_dir("shutdown-queued", "v1").exists());

        let reports = telemetry_server.assert_finished_with_requests().await;
        assert!(reports.iter().any(|request| {
            request.contains(r#""action_type":"storage_cache_background_fill_filled""#)
        }));
        assert!(reports.iter().any(|request| {
            request.contains(r#""action_type":"storage_cache_background_fill_shutdown_cancelled""#)
        }));
    }

    #[test]
    fn background_fill_report_uses_fixed_outcome_and_size_actions() {
        let filled = BackgroundFillReport::from_outcome(
            BackgroundFillOutcome::Filled { size: 70 * 1024 },
            Duration::from_millis(12),
        )
        .into_records();
        assert_eq!(filled.len(), 2);
        assert_background_op_count(&filled, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
        assert_eq!(filled[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_FILLED);
        assert_eq!(filled[0].duration, Duration::from_millis(12));
        assert!(filled[0].success);
        assert_eq!(
            filled[1].action_type,
            "storage_cache_background_fill_size_64_256_kib"
        );

        let busy = BackgroundFillReport::from_outcome(
            BackgroundFillOutcome::Busy,
            Duration::from_millis(5),
        )
        .into_records();
        assert_eq!(busy.len(), 1);
        assert_eq!(busy[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_BUSY);

        let failed = BackgroundFillReport::from_outcome(
            BackgroundFillOutcome::Unavailable,
            Duration::from_millis(6),
        )
        .into_records();
        assert_eq!(failed.len(), 1);
        assert_eq!(
            failed[0].action_type,
            STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE
        );

        let failed = BackgroundFillReport::failed(Duration::from_millis(7)).into_records();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].action_type, STORAGE_CACHE_BACKGROUND_FILL_FAILED);
        assert!(!failed[0].success);
        assert_eq!(
            failed[0].error,
            Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR)
        );
    }

    #[tokio::test]
    async fn background_fill_skips_busy_cache_lock_without_http() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "background-busy";
        let version = "v1";
        let mut plan = fresh_storage_plan(
            "http://127.0.0.1:9/archive.tar.gz".to_string(),
            name,
            version,
        );
        let deferred = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry).await;
        let _writer = lock::acquire(home.storage_lock(name, version))
            .await
            .unwrap();

        let records = deferred.run().await;

        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_BUSY, true);
        assert!(!home.storage_cache_dir(name, version).exists());
    }

    #[tokio::test]
    async fn background_fill_observes_cache_written_after_selection() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "background-already-cached";
        let version = "v1";
        let mut plan = fresh_storage_plan(
            "http://127.0.0.1:9/archive.tar.gz".to_string(),
            name,
            version,
        );
        let deferred = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry).await;
        let body = tarball_bytes();
        write_cached_archive(&home, name, version, &body);

        let records = deferred.run().await;

        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED, true);
        assert_background_op(
            &records,
            "storage_cache_background_fill_size_lt_64_kib",
            true,
        );
        let later = populate_cache(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();
        assert!(later.is_none());
        assert_eq!(
            storage_archive_url(&plan, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
    }

    #[tokio::test]
    async fn background_fill_preserves_failed_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let mut plan = fresh_storage_plan(
            "http://127.0.0.1:9/archive.tar.gz".to_string(),
            "background-failed",
            "v1",
        );

        let records = select_background_fill(&mut plan, &sandbox, &home, &mut telemetry)
            .await
            .run()
            .await;

        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn guarded_missing_archive_with_existing_lock_removes_orphan_lock() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-orphan-lock";
        let version = "v1";
        let original = "https://r2.example.com/orphan-lock.tar.gz".to_string();
        write_storage_lock(&home, name, version);
        let lock_path = home.storage_lock(name, version);
        assert!(lock_path.exists());
        assert!(!home.storage_cache_dir(name, version).exists());
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(!lock_path.exists());
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.write_files_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
        assert_no_op(&ops, "storage_cache_hit");
    }

    #[tokio::test]
    async fn guarded_missing_archive_keeps_lock_when_another_reader_holds_it() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-orphan-lock-shared";
        let version = "v1";
        let original = "https://r2.example.com/orphan-lock-shared.tar.gz".to_string();
        let lock_path = home.storage_lock(name, version);
        let _other_reader = lock::acquire_shared(lock_path.clone()).await.unwrap();
        assert!(lock_path.exists());
        assert!(!home.storage_cache_dir(name, version).exists());
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            lock_path.exists(),
            "cleanup must not remove a lock while another reader still holds it"
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert!(sandbox.write_files_calls().is_empty());
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "missing");
        assert_no_op(&ops, "storage_cache_hit");
    }

    #[tokio::test]
    async fn guarded_empty_and_oversized_cached_archives_passthrough_without_eviction() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let empty_name = "guarded-empty";
        let oversized_name = "guarded-oversized";
        let version = "v1";
        let empty_dir = home.storage_cache_dir(empty_name, version);
        std::fs::create_dir_all(&empty_dir).unwrap();
        std::fs::write(empty_dir.join("archive.tar.gz"), b"").unwrap();
        write_storage_lock(&home, empty_name, version);
        let oversized_dir = home.storage_cache_dir(oversized_name, version);
        std::fs::create_dir_all(&oversized_dir).unwrap();
        let oversized_file = std::fs::File::create(oversized_dir.join("archive.tar.gz")).unwrap();
        oversized_file.set_len(CACHE_MAX_SIZE + 1).unwrap();
        write_storage_lock(&home, oversized_name, version);
        let empty_url = "https://r2.example.com/empty.tar.gz".to_string();
        let oversized_url = "https://r2.example.com/oversized.tar.gz".to_string();
        let mut manifest = plan_from_entries(
            vec![
                storage_entry("/mnt/empty".into(), empty_url.clone(), empty_name, version),
                storage_entry(
                    "/mnt/oversized".into(),
                    oversized_url.clone(),
                    oversized_name,
                    version,
                ),
            ],
            Vec::new(),
            None,
        );

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(storage_archive_url(&manifest, 0), Some(empty_url.as_str()));
        assert_eq!(
            storage_archive_url(&manifest, 1),
            Some(oversized_url.as_str())
        );
        assert!(empty_dir.join("archive.tar.gz").exists());
        assert!(oversized_dir.join("archive.tar.gz").exists());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
        assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
        assert_no_op(&ops, "storage_cache_skipped_over_size");
    }

    #[tokio::test]
    async fn guarded_same_key_duplicate_misses_preserve_each_original_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-duplicate";
        let version = "v1";
        let first_url = "https://r2.example.com/first.tar.gz".to_string();
        let second_url = "https://mirror.example.com/second.tar.gz".to_string();
        let mut manifest =
            fresh_duplicate_storage_plan(first_url.clone(), second_url.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(storage_archive_url(&manifest, 0), Some(first_url.as_str()));
        assert_eq!(storage_archive_url(&manifest, 1), Some(second_url.as_str()));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, "storage_cache_passthrough_miss_count_2", true);
        assert_op_count(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, 2);
    }

    #[tokio::test]
    async fn guarded_artifact_miss_passthrough_keeps_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-artifact";
        let version = "v1";
        let original = "https://r2.example.com/artifact.tar.gz".to_string();
        let mut manifest = fresh_artifact_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_some());

        assert_eq!(artifact_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(!home.storage_cache_dir(name, version).exists());
        assert!(!home.storage_lock(name, version).exists());
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, true);
    }

    #[tokio::test]
    async fn guarded_lock_busy_passthrough_does_not_wait_for_writer() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let name = "guarded-busy";
        let version = "v1";
        let original = "https://r2.example.com/busy.tar.gz".to_string();
        let _writer = lock::acquire(home.storage_lock(name, version))
            .await
            .unwrap();
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_none());

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH, true);
        assert_op(&ops, "storage_cache_passthrough_lock_busy_count_1", true);
        assert_no_op(&ops, STORAGE_CACHE_MISS_PASSTHROUGH);
    }

    #[tokio::test]
    async fn warm_hits_are_staged_in_one_guest_batch() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let body = tarball_bytes();
        let first_name = "warm-batch-a";
        let second_name = "warm-batch-b";
        let version = "v1";
        write_cached_archive(&home, first_name, version, &body);
        write_cached_archive(&home, second_name, version, &body);

        let mut manifest = plan_from_entries(
            vec![
                storage_entry(
                    "/mnt/a".into(),
                    "https://r2.example.com/a.tar.gz".into(),
                    first_name,
                    version,
                ),
                storage_entry(
                    "/mnt/b".into(),
                    "https://r2.example.com/b.tar.gz".into(),
                    second_name,
                    version,
                ),
            ],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();
        assert!(records.is_empty());

        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 2);
        let staged_paths = batches[0]
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<HashSet<_>>();
        assert_eq!(
            staged_paths,
            HashSet::from([
                guest_archive_path(first_name, version),
                guest_archive_path(second_name, version),
            ])
        );
        assert_eq!(sandbox.write_file_calls().len(), 2);
        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, true);
        let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
        assert_eq!(
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_BATCH_WRITE),
            "pure batch staging total should equal the batch guest write duration in {ops_with_duration:?}"
        );
    }

    #[tokio::test]
    async fn warm_hit_batch_stage_failure_records_failed_staging_telemetry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
        let mut telemetry = new_telemetry();

        let name = "warm-batch-fail";
        let version = "v1";
        let original = "https://r2.example.com/fail.tar.gz".to_string();
        write_cached_archive(&home, name, version, &tarball_bytes());
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let err = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("vsock write failed"), "got: {err}");
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
        assert_op_error(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            STORAGE_CACHE_STAGE_FAILED,
        );
        assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
        assert_no_op(&ops, "storage_cache_hit");
    }

    #[tokio::test]
    async fn miss_path_downloads_and_populates_cache() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/archive.tar.gz");
        let name = "seed-skill-bar";
        let version = "v2";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let deferred = select_background_fill(&mut manifest, &sandbox, &home, &mut telemetry).await;

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir(name, version).exists());

        let records = deferred.run().await;

        probe.assert_async().await;
        get.assert_async().await;
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
        assert_background_op(
            &records,
            "storage_cache_background_fill_size_lt_64_kib",
            true,
        );

        let final_path = home.storage_cache_dir(name, version).join("archive.tar.gz");
        assert!(final_path.exists(), "cache file must exist after miss");
        assert_eq!(std::fs::read(&final_path).unwrap(), body);

        let deferred = populate_cache(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert!(deferred.is_none());
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, true);
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, true);
        let ops_with_duration = telemetry.pending_ops_with_duration_snapshot();
        assert_eq!(
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_TOTAL),
            op_duration_ms(&ops_with_duration, STORAGE_CACHE_STAGE_BATCH_WRITE),
            "single-entry batch staging total should equal the guest write duration in {ops_with_duration:?}"
        );
        assert_op(&ops, STORAGE_CACHE_PROCESS_GROUP, true);
        assert_op(&ops, STORAGE_CACHE_LOCK_WAIT, true);
        assert_op_count(&ops, STORAGE_CACHE_PROCESS_GROUP, 2);
        assert_op_count(&ops, STORAGE_CACHE_LOCK_WAIT, 2);
        assert_op_count(&ops, STORAGE_CACHE_HIT_READ, 1);
    }

    #[tokio::test]
    async fn known_archive_size_downloads_without_range_probe() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/known-size.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/known-size.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/known-size.tar.gz");
        let name = "known-size";
        let version = "v1";
        let mut manifest = plan_from_entries(
            vec![storage_entry_with_archive_size(
                format!("/mnt/{name}"),
                original,
                name,
                version,
                Some(body.len() as u64),
            )],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_calls_async(0).await;
        get.assert_async().await;
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
    }

    #[tokio::test]
    async fn probe_http_error_preserves_original_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/forbidden.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(403);
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/forbidden.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/forbidden.tar.gz");
        let name = "probe-client-error";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_calls_async(1).await;
        full.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_invalid_url_is_sanitized() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let original = "not-a-url".to_string();
        let name = "probe-builder-error";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn full_download_http_error_is_sanitized() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-forbidden.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/download-forbidden.tar.gz")
                    .header_missing("range");
                then.status(403);
            })
            .await;

        let original = format!(
            "{}?X-Amz-Signature=secret&X-Amz-Credential=credential",
            server.url("/download-forbidden.tar.gz")
        );
        let name = "download-client-error";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(1).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
        let http = Client::builder().build().unwrap();
        let reason = download_tarball(&http, &original, Some(body.len() as u64), CACHE_MAX_SIZE)
            .await
            .err()
            .expect("403 download should fail")
            .to_string();
        full.assert_calls_async(2).await;
        assert!(reason.contains("403"), "expected 403 in reason: {reason}");
        assert!(
            !reason.contains("X-Amz-Signature")
                && !reason.contains("secret")
                && !reason.contains("credential")
                && !reason.contains("/download-forbidden.tar.gz"),
            "telemetry error must not include presigned URL details: {reason}"
        );
    }

    #[tokio::test]
    async fn cold_fill_later_warm_batch_stage_failure_records_telemetry() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("batch write failed")));
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/archive.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/archive.tar.gz");
        let name = "later-warm-stage-fail";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let err = populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap_err();

        probe.assert_async().await;
        get.assert_async().await;
        assert!(err.to_string().contains("batch write failed"), "got: {err}");
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );

        let ops = telemetry.pending_ops_snapshot();
        assert_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE, false);
        assert_op(&ops, STORAGE_CACHE_STAGE_TOTAL, false);
        assert_op_error(
            &ops,
            STORAGE_CACHE_STAGE_BATCH_WRITE,
            STORAGE_CACHE_STAGE_FAILED,
        );
        assert_op_error(&ops, STORAGE_CACHE_STAGE_TOTAL, STORAGE_CACHE_STAGE_FAILED);
    }

    #[tokio::test]
    async fn legacy_over_size_entry_probes_then_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let too_big = CACHE_MAX_SIZE + 1;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/legacy-big.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{too_big}"))
                    .body(b"x");
            })
            .await;
        let unexpected_full_get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/legacy-big.tar.gz")
                    .header_missing("range");
                then.status(200);
            })
            .await;

        let original = server.url("/legacy-big.tar.gz");
        let name = "legacy-user-volume";
        let version = "v9";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        unexpected_full_get.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(!home.storage_cache_dir(name, version).exists());

        let ops = telemetry.pending_ops_snapshot();
        assert_no_op(&ops, STORAGE_CACHE_STAGE_TOTAL);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, true);
    }

    #[tokio::test]
    async fn known_over_size_entry_is_passthrough_without_http() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let too_big = CACHE_MAX_SIZE + 1;
        let unexpected_get = server
            .mock_async(|when, then| {
                when.method(GET).path("/big.tar.gz");
                then.status(200);
            })
            .await;

        let original = server.url("/big.tar.gz");
        let name = "user-volume";
        let version = "v9";
        let mut manifest = plan_from_entries(
            vec![storage_entry_with_archive_size(
                format!("/mnt/{name}"),
                original.clone(),
                name,
                version,
                Some(too_big),
            )],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        unexpected_get.assert_calls_async(0).await;

        // archive_url untouched.
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        // Cache dir must not exist.
        assert!(!home.storage_cache_dir(name, version).exists());

        let ops = telemetry.pending_ops_snapshot();
        assert_no_op(&ops, STORAGE_CACHE_STAGE_TOTAL);
        assert_no_op(&ops, STORAGE_CACHE_STAGE_BATCH_WRITE);
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_SKIPPED, true);
    }

    #[tokio::test]
    async fn full_download_over_probe_limit_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("unexpected archive write")));
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/lying-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{CACHE_MAX_SIZE}"))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/lying-body.tar.gz")
                    .header_missing("range");
                then.status(200)
                    .body(vec![b'x'; (CACHE_MAX_SIZE + 1) as usize]);
            })
            .await;

        let original = server.url("/lying-body.tar.gz");
        let name = "lying-body";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FAILED, false);
        assert_eq!(
            records[0].error,
            Some(STORAGE_CACHE_BACKGROUND_FILL_FAILED_ERROR)
        );
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(
            sandbox.write_file("/tmp/sentinel", b"x").await.is_err(),
            "queued write_file error should remain if archive write was not attempted"
        );
    }

    #[tokio::test]
    async fn empty_full_download_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/1")
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(Vec::<u8>::new());
            })
            .await;

        let original = server.url("/empty-body.tar.gz");
        let name = "empty-body";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn non_tar_full_download_is_cached_as_opaque_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = b"not a valid tar.gz".to_vec();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/invalid-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/invalid-body.tar.gz");
        let name = "invalid-body";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, guest_archive_path(name, version));
        assert_eq!(writes[0].content, body);
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    }

    #[tokio::test]
    async fn known_size_mismatch_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();
        let expected_size = body.len() as u64 + 1;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/short-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{expected_size}"))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/short-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body);
            })
            .await;

        let original = server.url("/short-body.tar.gz");
        let name = "short-body";
        let version = "v1";
        let mut manifest = plan_from_entries(
            vec![storage_entry_with_archive_size(
                format!("/mnt/{name}"),
                original.clone(),
                name,
                version,
                Some(expected_size),
            )],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_calls_async(0).await;
        get.assert_async().await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn longer_full_download_within_limit_is_passthrough_without_cache_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/long-body.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/1")
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/long-body.tar.gz")
                    .header_missing("range");
                then.status(200).body(body);
            })
            .await;

        let original = server.url("/long-body.tar.gz");
        let name = "long-body";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn reused_storage_is_not_touched() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let previous = StorageFingerprints {
            storages: HashMap::from([("/mnt/foo".into(), StorageFingerprint::new("foo", "v1"))]),
            artifacts: HashMap::new(),
        };
        let mut manifest = plan_from_entries(
            vec![storage_entry(
                "/mnt/foo".into(),
                "https://r2.example.com/unused.tar.gz".into(),
                "foo",
                "v1",
            )],
            Vec::new(),
            Some(&previous),
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();
        assert!(records.is_empty());

        assert!(storage_archive_url(&manifest, 0).is_none());
        assert!(manifest.cache_candidates().is_empty());
        // No telemetry emitted — no eligible targets.
        assert!(telemetry.pending_ops_snapshot().is_empty());
    }

    #[tokio::test]
    async fn missing_content_key_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        // Entry without usable vas_storage_name / vas_version_id passes through.
        let mut manifest =
            fresh_storage_plan("https://r2.example.com/legacy.tar.gz".into(), "", "");

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        // archive_url untouched.
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some("https://r2.example.com/legacy.tar.gz")
        );
    }

    #[tokio::test]
    async fn version_transition_cannot_serve_prev_bytes() {
        // Correctness claim: (name, v1) and (name, v2) live in different
        // directories. A warmed cache for v2 can never serve v1 bytes
        // regardless of reused sandbox state.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "rolling-skill";
        let v2_bytes = tarball_bytes();
        let v2_dir = home.storage_cache_dir(name, "v2");
        std::fs::create_dir_all(&v2_dir).unwrap();
        std::fs::write(v2_dir.join("archive.tar.gz"), &v2_bytes).unwrap();

        // If a stale v1 tarball exists, it's under a different cache key and
        // is unreachable via (name, v2).
        let v1_bytes = b"STALE-V1-BYTES";
        let v1_dir = home.storage_cache_dir(name, "v1");
        std::fs::create_dir_all(&v1_dir).unwrap();
        std::fs::write(v1_dir.join("archive.tar.gz"), v1_bytes).unwrap();

        let mut manifest =
            fresh_storage_plan("https://r2.example.com/ignored.tar.gz".into(), name, "v2");

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, "v2")).as_str())
        );
        let writes = sandbox.write_file_calls();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].path, guest_archive_path(name, "v2"));
        assert_eq!(writes[0].content, v2_bytes);
        assert_ne!(writes[0].content, v1_bytes);

        // v2 cache retained; v1 cache untouched (only a GC branch would evict it).
        assert_eq!(
            std::fs::read(v2_dir.join("archive.tar.gz")).unwrap(),
            v2_bytes
        );
        assert_eq!(
            std::fs::read(v1_dir.join("archive.tar.gz")).unwrap(),
            v1_bytes
        );
    }

    #[tokio::test]
    async fn oversized_disk_hit_is_evicted_and_revalidated() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let name = "oversized-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        let archive = std::fs::File::create(cache_dir.join("archive.tar.gz")).unwrap();
        archive.set_len(CACHE_MAX_SIZE + 1).unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/revalidated.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/revalidated.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/revalidated.tar.gz");
        let mut manifest = fresh_storage_plan(url, name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "over-size");
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    }

    #[tokio::test]
    async fn empty_disk_hit_is_evicted_and_revalidated() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let name = "empty-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), b"").unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-revalidated.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/empty-revalidated.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/empty-revalidated.tar.gz");
        let mut manifest = fresh_storage_plan(url, name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        get.assert_async().await;
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let ops = telemetry.pending_ops_snapshot();
        assert_op_error(&ops, STORAGE_CACHE_MISS_PASSTHROUGH, "empty");
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    }

    #[tokio::test]
    async fn non_tar_disk_hit_is_staged_without_revalidation() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = b"not a valid tar.gz".to_vec();

        let name = "non-tar-hit";
        let version = "v1";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), &body).unwrap();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/should-not-revalidate.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/should-not-revalidate.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/should-not-revalidate.tar.gz");
        let mut manifest = fresh_storage_plan(url, name, version);

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        probe.assert_calls_async(0).await;
        get.assert_calls_async(0).await;
        assert_eq!(
            std::fs::read(home.storage_cache_dir(name, version).join("archive.tar.gz")).unwrap(),
            body
        );
        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 1);
        assert_eq!(batches[0].files[0].path, guest_archive_path(name, version));
        assert_eq!(batches[0].files[0].content, body);
        let ops = telemetry.pending_ops_snapshot();
        assert!(
            ops.iter().any(|(k, _, _)| k == "storage_cache_hit"),
            "expected cache hit in {ops:?}"
        );
    }

    #[tokio::test]
    async fn artifacts_are_cached_too() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "build-artifact";
        let version = "build-42";
        let cache_dir = home.storage_cache_dir(name, version);
        std::fs::create_dir_all(&cache_dir).unwrap();
        std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();

        let mut manifest = fresh_artifact_plan(
            "https://r2.example.com/ignored.tar.gz".into(),
            name,
            version,
        );

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        assert_eq!(
            artifact_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
    }

    #[tokio::test]
    async fn probe_200_ignored_range_uses_content_length_without_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let advertised_size = CACHE_MAX_SIZE + 1;

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
            socket
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {advertised_size}\r\n\r\n")
                        .as_bytes(),
                )
                .await?;
            let _ = release_rx.await;
            Ok::<(), std::io::Error>(())
        });

        let http = Client::builder().build().unwrap();
        let result = tokio::time::timeout(
            HEAD_TIMEOUT + Duration::from_secs(1),
            probe_size(&http, &format!("http://{addr}/range-ignored.tar.gz")),
        )
        .await
        .expect("probe must return after headers without waiting for the body")
        .unwrap();

        let _ = release_tx.send(());
        join_raw_http_task(server_task, "ignored range probe server")
            .await
            .unwrap();
        assert_eq!(result, SizeProbe::Known(advertised_size));
    }

    #[tokio::test]
    async fn probe_200_rejects_malformed_content_length() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
        let (url, handle) = raw_http_url(response).await;

        let http = Client::builder().build().unwrap();
        let result = probe_size(&http, &url).await;

        handle.assert_finished().await;
        match result {
            Ok(SizeProbe::Unknown(SizeProbeUnknown::InvalidSizeHeader)) => {}
            Err(err) => assert!(err.to_string().contains("probe GET"), "got: {err}"),
            other => panic!("malformed Content-Length must not become a known size: {other:?}"),
        }
    }

    #[tokio::test]
    async fn probe_200_malformed_content_length_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: +7\r\n\r\n".to_vec();
        let (original, handle) = raw_http_url(response).await;
        let name = "malformed-length";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        handle.assert_finished().await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert!(sandbox.write_file_calls().is_empty());
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_200_zero_content_length_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/zero-length.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(200).header("content-length", "0");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/zero-length.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/zero-length.tar.gz");
        let name = "zero-length";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_non_ok_success_status_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/no-content.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(204).header("content-length", "0");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/no-content.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/no-content.tar.gz");
        let name = "no-content";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_206_uses_content_range_without_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let total_size = CACHE_MAX_SIZE;

        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await?;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{total_size}\r\nContent-Length: {}\r\n\r\n",
                        CACHE_MAX_SIZE + 1
                    )
                    .as_bytes(),
                )
                .await?;
            let _ = release_rx.await;
            Ok::<(), std::io::Error>(())
        });

        let http = Client::builder().build().unwrap();
        let result = tokio::time::timeout(
            HEAD_TIMEOUT + Duration::from_secs(1),
            probe_size(&http, &format!("http://{addr}/partial.tar.gz")),
        )
        .await
        .expect("probe must return after Content-Range without waiting for the body")
        .unwrap();

        let _ = release_tx.send(());
        join_raw_http_task(server_task, "partial content probe server")
            .await
            .unwrap();
        assert_eq!(result, SizeProbe::Known(total_size));
    }

    #[test]
    fn staging_dir_is_sibling() {
        let d = PathBuf::from("/var/lib/vm0-runner/storages/foo/v1");
        let s = staging_dir(&d);
        assert_eq!(s, PathBuf::from("/var/lib/vm0-runner/storages/foo/v1.tmp"));
        // Same parent → atomic rename.
        assert_eq!(s.parent(), d.parent());
    }

    #[tokio::test]
    async fn write_to_cache_rename_error_cleans_staging() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path().join("storages").join("name").join("version");
        let parent = cache_dir.parent().unwrap();
        fs::create_dir_all(parent).await.unwrap();
        fs::write(&cache_dir, b"not-a-cache-dir").await.unwrap();

        let staging = staging_dir(&cache_dir);

        let err = write_to_cache(&cache_dir, b"archive bytes")
            .await
            .unwrap_err();

        assert!(err.to_string().contains("rename"), "got: {err}");
        assert!(
            !staging.exists(),
            "failed cache write must not leave staging dir"
        );
        assert_eq!(fs::read(&cache_dir).await.unwrap(), b"not-a-cache-dir");
    }

    #[test]
    fn initial_body_capacity_uses_bounded_hints() {
        assert_eq!(initial_body_capacity(Some(5), Some(6), 10), 5);
        assert_eq!(initial_body_capacity(Some(11), Some(6), 10), 6);
        assert_eq!(initial_body_capacity(Some(11), Some(12), 10), 10);
        assert_eq!(
            initial_body_capacity(None, None, 128 * 1024),
            BODY_BUFFER_FALLBACK_CAPACITY
        );
    }

    #[test]
    fn limited_body_allows_exact_limit() {
        let mut bytes = Vec::new();
        let mut downloaded = 0u64;

        let first = append_limited_chunk(&mut bytes, &mut downloaded, b"abcd", 6).unwrap();
        let second = append_limited_chunk(&mut bytes, &mut downloaded, b"ef", 6).unwrap();

        assert_eq!(first, None);
        assert_eq!(second, None);
        assert_eq!(downloaded, 6);
        assert_eq!(bytes, b"abcdef");
    }

    #[test]
    fn limited_body_rejects_one_byte_over_limit() {
        let mut bytes = Vec::new();
        let mut downloaded = 0u64;

        let first = append_limited_chunk(&mut bytes, &mut downloaded, b"abcd", 6).unwrap();
        let second = append_limited_chunk(&mut bytes, &mut downloaded, b"efg", 6).unwrap();

        assert_eq!(first, None);
        assert_eq!(second, Some(7));
        assert_eq!(
            downloaded, 4,
            "over-limit chunk must not advance downloaded size"
        );
        assert_eq!(bytes, b"abcd", "over-limit chunk must not be appended");
    }

    #[tokio::test]
    async fn download_rejects_advertised_content_length_over_limit() {
        let server = MockServer::start_async().await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET).path("/too-long.tar.gz");
                then.status(200).body(vec![0u8; 7]);
            })
            .await;
        let http = Client::builder().build().unwrap();

        let result = download_tarball(&http, &server.url("/too-long.tar.gz"), Some(6), 6)
            .await
            .unwrap();

        get.assert_async().await;
        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "content-length over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::Empty => panic!("content-length over limit must not be empty"),
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn download_rejects_stream_without_content_length_over_limit() {
        let (url, server_task) = raw_http_url(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n3\r\nefg\r\n0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let http = Client::builder().build().unwrap();

        let result = download_tarball(&http, &url, Some(6), 6).await.unwrap();
        server_task.assert_finished().await;

        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "stream over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::Empty => panic!("stream over limit must not be empty"),
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn cached_archive_read_rejects_one_byte_over_limit() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("archive.tar.gz");
        fs::write(&archive_path, b"abcdefg").await.unwrap();

        let result = read_cached_archive(&archive_path, Some(7), 6)
            .await
            .unwrap();

        match result {
            DownloadBody::Complete(bytes) => {
                panic!(
                    "cached file over limit should be rejected, read {} bytes",
                    bytes.len()
                )
            }
            DownloadBody::Empty => panic!("cached file over limit must not be empty"),
            DownloadBody::OverSize { observed_size } => assert_eq!(observed_size, 7),
        }
    }

    #[tokio::test]
    async fn cached_archive_read_preserves_contents_with_stale_size_hints() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("archive.tar.gz");
        for length in [0, 1, 4097, 131_073] {
            let content = (0..length).map(|i| (i % 251) as u8).collect::<Vec<_>>();
            fs::write(&archive_path, &content).await.unwrap();
            for hint in [None, Some(0), Some(1), Some(length as u64)] {
                let result = read_cached_archive(&archive_path, hint, length as u64)
                    .await
                    .unwrap();
                match result {
                    DownloadBody::Empty => assert!(content.is_empty()),
                    DownloadBody::Complete(bytes) => assert_eq!(bytes.as_ref(), content),
                    DownloadBody::OverSize { observed_size } => {
                        panic!("valid cached file rejected at {observed_size} bytes")
                    }
                }
            }
            if length > 1 {
                let result = read_cached_archive(&archive_path, Some(1), length as u64 - 1)
                    .await
                    .unwrap();
                assert!(matches!(result, DownloadBody::OverSize { observed_size }
                    if observed_size == length as u64));
            }
        }
    }

    #[tokio::test]
    async fn warmed_cache_hits_do_not_serialize_guest_writes_across_sandboxes() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let name = "warm-shared";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

        let sandbox_a = Arc::new(MockSandbox::new("test-a"));
        let sandbox_b = Arc::new(MockSandbox::new("test-b"));
        let gate_a = MockLifecycleGate::new();
        let gate_b = MockLifecycleGate::new();
        sandbox_a.set_write_file_lifecycle_gate(gate_a.clone());
        sandbox_b.set_write_file_lifecycle_gate(gate_b.clone());

        let task_a = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox_a);
            tokio::spawn(async move {
                let mut manifest = fresh_storage_plan(
                    "https://r2.example.com/ignored-a.tar.gz".to_string(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache_through_background(
                    &mut manifest,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                )
                .await
                .unwrap();
                manifest
            })
        };
        gate_a
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            !task_a.is_finished(),
            "first guest write should wait on its sandbox gate"
        );

        let task_b = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox_b);
            tokio::spawn(async move {
                let mut manifest = fresh_storage_plan(
                    "https://r2.example.com/ignored-b.tar.gz".to_string(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache_through_background(
                    &mut manifest,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                )
                .await
                .unwrap();
                manifest
            })
        };
        gate_b
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();

        gate_b.release_one();
        let manifest_b = task_b.await.unwrap();
        gate_a.release_one();
        let manifest_a = task_a.await.unwrap();

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&manifest_a, 0), Some(expected.as_str()));
        assert_eq!(storage_archive_url(&manifest_b, 0), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn multi_group_background_fill_precedes_later_warm_staging() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = Arc::new(MockSandbox::new("test"));
        let gate = MockLifecycleGate::new();
        sandbox.set_write_file_lifecycle_gate(gate.clone());

        let ready_name = "ready-stages-while-cold-in-flight";
        let cold_name = "cold-continues-while-stage-blocked";
        let version = "v1";

        let ready_body = tarball_bytes();
        let cold_body = tarball_bytes();
        let ready_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ready_addr = ready_listener.local_addr().unwrap();
        let cold_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let cold_addr = cold_listener.local_addr().unwrap();
        let (allow_ready_tx, allow_ready_rx) = tokio::sync::oneshot::channel::<()>();
        let (cold_probe_seen_tx, cold_probe_seen_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_cold_probe_tx, release_cold_probe_rx) = tokio::sync::oneshot::channel::<()>();
        let (cold_full_seen_tx, cold_full_seen_rx) = tokio::sync::oneshot::channel::<()>();

        let ready_server_task = tokio::spawn(async move {
            let (mut probe_socket, _) = ready_listener.accept().await?;
            let probe_request = read_http_request(&mut probe_socket).await?;
            assert!(
                probe_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected range probe, got {probe_request:?}"
            );
            let _ = allow_ready_rx.await;
            probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        ready_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            drop(probe_socket);

            let (mut full_socket, _) = ready_listener.accept().await?;
            let full_request = read_http_request(&mut full_socket).await?;
            assert!(
                !full_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected full download, got {full_request:?}"
            );
            full_socket
                .write_all(&http_response("200 OK", &ready_body))
                .await?;
            Ok::<(), std::io::Error>(())
        });

        let cold_server_task = tokio::spawn(async move {
            let (mut probe_socket, _) = cold_listener.accept().await?;
            let probe_request = read_http_request(&mut probe_socket).await?;
            assert!(
                probe_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected range probe, got {probe_request:?}"
            );
            let _ = cold_probe_seen_tx.send(());
            let _ = release_cold_probe_rx.await;
            probe_socket
                .write_all(
                    format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-0/{}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx",
                        cold_body.len()
                    )
                    .as_bytes(),
                )
                .await?;
            drop(probe_socket);

            let (mut full_socket, _) = cold_listener.accept().await?;
            let full_request = read_http_request(&mut full_socket).await?;
            assert!(
                !full_request
                    .to_ascii_lowercase()
                    .contains("range: bytes=0-0"),
                "expected full download, got {full_request:?}"
            );
            full_socket
                .write_all(&http_response("200 OK", &cold_body))
                .await?;
            let _ = cold_full_seen_tx.send(());
            Ok::<(), std::io::Error>(())
        });

        let task = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            tokio::spawn(async move {
                let mut manifest = plan_from_entries(
                    vec![
                        storage_entry(
                            "/mnt/ready".into(),
                            format!("http://{ready_addr}/ready.tar.gz"),
                            ready_name,
                            version,
                        ),
                        storage_entry(
                            "/mnt/cold".into(),
                            format!("http://{cold_addr}/cold.tar.gz"),
                            cold_name,
                            version,
                        ),
                    ],
                    Vec::new(),
                    None,
                );
                let mut telemetry = new_telemetry();
                populate_cache_through_background(
                    &mut manifest,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                )
                .await?;
                Ok::<StoragePlan, RunnerError>(manifest)
            })
        };

        tokio::time::timeout(Duration::from_secs(5), cold_probe_seen_rx)
            .await
            .expect("cold worker should start the probe")
            .unwrap();
        allow_ready_tx.send(()).unwrap();
        release_cold_probe_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), cold_full_seen_rx)
            .await
            .expect("both background fills should finish before later warm staging")
            .unwrap();

        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        gate.release_one();
        let manifest = task.await.unwrap().unwrap();
        join_raw_http_task(ready_server_task, "ready storage archive server")
            .await
            .unwrap();
        join_raw_http_task(cold_server_task, "cold storage archive server")
            .await
            .unwrap();

        let batches = sandbox.write_files_calls();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].files.len(), 2);

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(ready_name, version)).as_str())
        );
        assert_eq!(
            storage_archive_url(&manifest, 1),
            Some(format!("file://{}", guest_archive_path(cold_name, version)).as_str())
        );
    }

    #[tokio::test]
    async fn duplicate_same_key_targets_share_one_guest_path_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let name = "duplicate-key";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

        let sandbox = Arc::new(SamePathConcurrentWriteDetectingSandbox::new("test"));
        let gate = sandbox.gate();

        let task = {
            let home = home.clone();
            let sandbox = Arc::clone(&sandbox);
            tokio::spawn(async move {
                let mut manifest = fresh_duplicate_storage_plan(
                    "https://r2.example.com/duplicate-a.tar.gz".into(),
                    "https://r2.example.com/duplicate-b.tar.gz".into(),
                    name,
                    version,
                );
                let mut telemetry = new_telemetry();
                populate_cache_through_background(
                    &mut manifest,
                    sandbox.as_ref(),
                    &home,
                    &mut telemetry,
                )
                .await?;
                Ok::<StoragePlan, RunnerError>(manifest)
            })
        };

        gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key guest path write should be blocked in the sandbox"
        );

        gate.release_one();
        let manifest = task.await.unwrap().unwrap();
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key targets should share one guest write"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
        assert_eq!(storage_archive_url(&manifest, 1), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn duplicate_conflicting_archive_sizes_fall_back_to_probe() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-a.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-a.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;
        let unused_probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-b.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let unused_full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-b.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "duplicate-miss";
        let version = "v1";
        let mut manifest = plan_from_entries(
            vec![
                storage_entry_with_archive_size(
                    "/mnt/duplicate-a".into(),
                    server.url("/duplicate-a.tar.gz"),
                    name,
                    version,
                    Some(body.len() as u64),
                ),
                storage_entry_with_archive_size(
                    "/mnt/duplicate-b".into(),
                    server.url("/duplicate-b.tar.gz"),
                    name,
                    version,
                    Some(body.len() as u64 + 1),
                ),
            ],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_async().await;
        unused_probe.assert_calls_async(0).await;
        unused_full.assert_calls_async(0).await;
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate same-key cold miss should stage one guest archive"
        );

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
        assert_eq!(storage_archive_url(&manifest, 1), Some(expected.as_str()));

        assert_background_op_count(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
        let ops = telemetry.pending_ops_snapshot();
        assert_op_count(&ops, "storage_cache_hit", 2);
    }

    #[tokio::test]
    async fn duplicate_equal_and_missing_archive_sizes_share_known_size() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-known-a.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/duplicate-known-a.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let name = "duplicate-known-size";
        let version = "v1";
        let archive_size = body.len() as u64;
        let mut manifest = plan_from_entries(
            vec![
                storage_entry_with_archive_size(
                    "/mnt/known-a".into(),
                    server.url("/duplicate-known-a.tar.gz"),
                    name,
                    version,
                    Some(archive_size),
                ),
                storage_entry_with_archive_size(
                    "/mnt/known-b".into(),
                    server.url("/duplicate-known-b.tar.gz"),
                    name,
                    version,
                    None,
                ),
                storage_entry_with_archive_size(
                    "/mnt/known-c".into(),
                    server.url("/duplicate-known-c.tar.gz"),
                    name,
                    version,
                    Some(archive_size),
                ),
            ],
            Vec::new(),
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_calls_async(0).await;
        full.assert_async().await;
        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "duplicate entries should share one staged guest archive"
        );
        let expected = format!("file://{}", guest_archive_path(name, version));
        for index in 0..3 {
            assert_eq!(
                storage_archive_url(&manifest, index),
                Some(expected.as_str())
            );
        }
        assert_background_op_count(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, 1);
    }

    #[tokio::test]
    async fn duplicate_storage_and_artifact_key_share_warmed_guest_write() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let name = "shared-storage-artifact";
        let version = "v1";
        write_cached_archive(&home, name, version, &tarball_bytes());

        let mut manifest = plan_from_entries(
            vec![storage_entry(
                "/mnt/storage".into(),
                "https://r2.example.com/storage.tar.gz".into(),
                name,
                version,
            )],
            vec![artifact_entry(
                "/mnt/artifact".into(),
                "https://r2.example.com/artifact.tar.gz".into(),
                name,
                version,
            )],
            None,
        );

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();
        assert!(records.is_empty());

        assert_eq!(
            sandbox.write_file_calls().len(),
            1,
            "storage and artifact targets with the same key should share one guest write"
        );
        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&manifest, 0), Some(expected.as_str()));
        assert_eq!(artifact_archive_url(&manifest, 0), Some(expected.as_str()));

        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(
            ops.iter()
                .filter(|(key, _, _)| key == "storage_cache_hit")
                .count(),
            2,
            "expected entry-level hit telemetry for both duplicate targets in {ops:?}"
        );
    }

    #[tokio::test]
    async fn shared_version_distinct_names_get_distinct_guest_paths() {
        // Regression guard: two manifest entries that share `vasVersionId`
        // but differ in `vasStorageName` must resolve to distinct guest
        // `file://` URLs. Before the host/guest key symmetrization, both
        // entries collided on `{GUEST_STAGE_DIR}/{version}.tar.gz` and the
        // second `sandbox.write_file` clobbered the first.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let version = "v1";
        let name_a = "storage-a";
        let name_b = "storage-b";
        for name in [name_a, name_b] {
            let cache_dir = home.storage_cache_dir(name, version);
            std::fs::create_dir_all(&cache_dir).unwrap();
            std::fs::write(cache_dir.join("archive.tar.gz"), tarball_bytes()).unwrap();
        }

        let mut manifest = plan_from_entries(
            vec![
                storage_entry(
                    format!("/mnt/{name_a}"),
                    "https://r2.example.com/ignored.tar.gz".into(),
                    name_a,
                    version,
                ),
                storage_entry(
                    format!("/mnt/{name_b}"),
                    "https://r2.example.com/ignored.tar.gz".into(),
                    name_b,
                    version,
                ),
            ],
            Vec::new(),
            None,
        );

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        let url_a = storage_archive_url(&manifest, 0).unwrap();
        let url_b = storage_archive_url(&manifest, 1).unwrap();
        assert_ne!(
            url_a, url_b,
            "same-version entries must get distinct guest URLs"
        );
        assert_eq!(
            url_a,
            format!("file://{}", guest_archive_path(name_a, version))
        );
        assert_eq!(
            url_b,
            format!("file://{}", guest_archive_path(name_b, version))
        );
    }

    #[tokio::test]
    async fn empty_key_components_are_passthrough() {
        // Defensive guard: an artifact carries non-optional `String` keys,
        // so an empty value is serde-representable. Hashing an empty string
        // yields a fixed digest that every other empty-key entry would
        // collide on, so we skip these rather than letting them share a
        // cache slot.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();

        let original = "https://r2.example.com/nameless.tar.gz".to_string();
        let mut manifest = fresh_artifact_plan(original.clone(), "", "");

        populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
            .await
            .unwrap();

        // archive_url untouched — the entry was skipped entirely.
        assert_eq!(artifact_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(telemetry.pending_ops_snapshot().is_empty());
    }

    #[tokio::test]
    async fn concurrent_populate_for_same_key_downloads_once() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox_a = MockSandbox::new("test-a");
        let sandbox_b = MockSandbox::new("test-b");
        let mut telemetry_a = new_telemetry();
        let mut telemetry_b = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/concurrent.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let get = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/concurrent.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/concurrent.tar.gz");
        let name = "race-skill";
        let version = "v1";
        let mut manifest_a = fresh_storage_plan(url.clone(), name, version);
        let mut manifest_b = fresh_storage_plan(url.clone(), name, version);

        let deferred_a =
            select_background_fill(&mut manifest_a, &sandbox_a, &home, &mut telemetry_a).await;
        let deferred_b =
            select_background_fill(&mut manifest_b, &sandbox_b, &home, &mut telemetry_b).await;

        let (records_a, records_b) = tokio::join!(deferred_a.run(), deferred_b.run());

        let filled = records_a
            .iter()
            .chain(&records_b)
            .filter(|record| record.action_type == STORAGE_CACHE_BACKGROUND_FILL_FILLED)
            .count();
        let competing = records_a
            .iter()
            .chain(&records_b)
            .filter(|record| {
                matches!(
                    record.action_type,
                    STORAGE_CACHE_BACKGROUND_FILL_BUSY
                        | STORAGE_CACHE_BACKGROUND_FILL_ALREADY_CACHED
                )
            })
            .count();
        assert_eq!(filled, 1, "exactly one background fill should win");
        assert_eq!(competing, 1, "the competing fill should not download");

        let later_a = populate_cache(&mut manifest_a, &sandbox_a, &home, &mut telemetry_a)
            .await
            .unwrap();
        let later_b = populate_cache(&mut manifest_b, &sandbox_b, &home, &mut telemetry_b)
            .await
            .unwrap();
        assert!(later_a.is_none());
        assert!(later_b.is_none());

        let expected = format!("file://{}", guest_archive_path(name, version));
        assert_eq!(storage_archive_url(&manifest_a, 0), Some(expected.as_str()));
        assert_eq!(storage_archive_url(&manifest_b, 0), Some(expected.as_str()));

        get.assert_calls_async(1).await;
        probe.assert_calls_async(1).await;
    }

    #[tokio::test]
    async fn r2_style_head_rejected_probe_via_get_range_succeeds() {
        // Regression for #10842. R2 GET-presigned URLs 403 on HEAD (SigV4
        // binds the signature to the HTTP method). The probe must use
        // GET + Range: bytes=0-0 and parse Content-Range — never HEAD.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let head_forbidden = server
            .mock_async(|when, then| {
                when.method(HEAD).path("/r2.tar.gz");
                then.status(403);
            })
            .await;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/r2.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", format!("bytes 0-0/{}", body.len()))
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET).path("/r2.tar.gz").header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let url = server.url("/r2.tar.gz");
        let name = "r2-skill";
        let version = "v1";
        let mut manifest = fresh_storage_plan(url, name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        head_forbidden.assert_calls_async(0).await;
        probe.assert_async().await;
        full.assert_async().await;

        assert_eq!(
            storage_archive_url(&manifest, 0),
            Some(format!("file://{}", guest_archive_path(name, version)).as_str())
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_FILLED, true);
    }

    #[tokio::test]
    async fn probe_206_without_content_range_is_passthrough() {
        // Server returns 206 but omits Content-Range entirely. Probe can't
        // extract a total, so the entry must stay passthrough.
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/nosize.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206).body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/nosize.tar.gz")
                    .header_missing("range");
                then.status(200).body(tarball_bytes());
            })
            .await;

        let original = server.url("/nosize.tar.gz");
        let name = "nosize";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_wildcard_content_range_is_passthrough() {
        let temp = tempfile::tempdir().unwrap();
        let home = home_at(&temp);
        let sandbox = MockSandbox::new("test");
        let mut telemetry = new_telemetry();
        let server = MockServer::start_async().await;
        let body = tarball_bytes();

        let probe = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/wildcard.tar.gz")
                    .header("range", "bytes=0-0");
                then.status(206)
                    .header("content-range", "bytes 0-0/*")
                    .body(b"x");
            })
            .await;
        let full = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/wildcard.tar.gz")
                    .header_missing("range");
                then.status(200).body(body.clone());
            })
            .await;

        let original = server.url("/wildcard.tar.gz");
        let name = "wildcard";
        let version = "v1";
        let mut manifest = fresh_storage_plan(original.clone(), name, version);

        let records =
            populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                .await
                .unwrap();

        probe.assert_async().await;
        full.assert_calls_async(0).await;
        assert_eq!(storage_archive_url(&manifest, 0), Some(original.as_str()));
        assert!(
            !home
                .storage_cache_dir(name, version)
                .join("archive.tar.gz")
                .exists()
        );
        assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
    }

    #[tokio::test]
    async fn probe_malformed_content_range_is_passthrough() {
        let cases = [
            ("bogus-no-slash", "no-slash"),
            ("bogus/7", "bogus-slash"),
            ("bytes */7", "wildcard-range"),
            ("bytes 1-0/7", "reversed-range"),
            ("bytes 0-1/7", "wrong-range"),
            ("items 0-0/7", "wrong-unit"),
            ("bytes 0-0/0", "empty-total"),
            ("bytes -0/7", "empty-start"),
            ("bytes 0-/7", "empty-end"),
            ("bytes 0-0/", "empty-size"),
            ("bytes 0-0/7/8", "extra-slash"),
            ("bytes 0-0/7 extra", "extra-token"),
            ("bytes 0-0/18446744073709551616", "overflow-total"),
            ("bytes +0-0/7", "plus-start"),
            ("bytes 0-+0/7", "plus-end"),
            ("bytes 0-0/+7", "plus-total"),
        ];

        for (content_range, slug) in cases {
            let temp = tempfile::tempdir().unwrap();
            let home = home_at(&temp);
            let sandbox = MockSandbox::new("test");
            let mut telemetry = new_telemetry();
            let server = MockServer::start_async().await;
            let path = format!("/{slug}.tar.gz");
            let probe_path = path.clone();
            let full_path = path.clone();
            let probe_content_range = content_range.to_string();

            let probe = server
                .mock_async(move |when, then| {
                    when.method(GET)
                        .path(probe_path.as_str())
                        .header("range", "bytes=0-0");
                    then.status(206)
                        .header("content-range", probe_content_range)
                        .body(b"x");
                })
                .await;
            let full = server
                .mock_async(move |when, then| {
                    when.method(GET)
                        .path(full_path.as_str())
                        .header_missing("range");
                    then.status(200).body(tarball_bytes());
                })
                .await;

            let original = server.url(path.as_str());
            let name = format!("garbage-{slug}");
            let version = "v1";
            let mut manifest = fresh_storage_plan(original.clone(), name.as_str(), version);

            let records =
                populate_cache_through_background(&mut manifest, &sandbox, &home, &mut telemetry)
                    .await
                    .unwrap();

            probe.assert_async().await;
            full.assert_calls_async(0).await;
            assert_eq!(
                storage_archive_url(&manifest, 0),
                Some(original.as_str()),
                "{content_range} must stay passthrough"
            );
            assert!(
                !home
                    .storage_cache_dir(name.as_str(), version)
                    .join("archive.tar.gz")
                    .exists(),
                "{content_range} must not write a cache archive"
            );
            assert_background_op(&records, STORAGE_CACHE_BACKGROUND_FILL_UNAVAILABLE, true);
        }
    }
}
