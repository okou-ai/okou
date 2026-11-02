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
//! That owner performs a bounded sequence of read-only GET attempts, keeps the
//! cache writer through atomic publication and the runner-wide permit through
//! guest application, and stages only complete content. A terminal failure fails
//! storage preparation after draining; it does not retry the request in the guest.
//! Keying on both name and version gives same-version entries with different
//! storage names separate collision-resistant staged filenames in normal
//! operation, so they do not clobber each other on the guest tmpfs.
//!
//! Entries above `CACHE_MAX_SIZE`, entries without a content key, and
//! reuse/repair actions pass through untouched.
//! For a post-spawn background fill, if the probe says an entry is cache-eligible
//! but the full response exceeds `CACHE_MAX_SIZE`, the cache rejects publication
//! and reports a background-fill failure. The original URL has already been handed
//! to the guest; this failure does not revoke it or retroactively fail storage
//! application.
//!
//! Runtime contract: `file://` URLs produced here point to guest-local archives
//! staged under `GUEST_STAGE_DIR`. `guest-storage-apply` supports that scheme and
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
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, TryAcquireError, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;
use tokio_util::task::{TaskTracker, task_tracker::TaskTrackerToken};
use tracing::{info, warn};

use crate::archive_connection_attempt::{
    ArchiveConnectionAttempt, ConnectionAttemptLayer, ConnectionAttemptObserver,
};
use crate::error::{StorageError as RunnerError, StorageResult as RunnerResult};
#[cfg(test)]
use crate::object_download_policy::{OBJECT_DOWNLOAD_BUDGET, OBJECT_DOWNLOAD_RETRY_DELAY};
use crate::object_download_policy::{
    OBJECT_DOWNLOAD_MAX_ATTEMPTS, OBJECT_DOWNLOAD_TIMEOUT, ObjectDownloadRetryBudget,
    before_deadline, object_download_http_retry_after, object_download_transient_transport_kind,
};
use crate::storage_plan::{ArchiveHandle, CacheArchiveCandidate, StoragePlan};
#[cfg(test)]
use crate::telemetry::StorageTelemetry;
use crate::telemetry::{ArchiveSizeMismatch, JobTelemetry, SandboxOpRecord, SandboxOpReporter};
use runner_host::lock;
use runner_host::paths::{HomePaths, short_digest, touch_mtime};

pub mod decoded;

/// Archive sizes strictly larger than this are passthrough.
const CACHE_MAX_SIZE: u64 = 8 * 1024 * 1024;
const BODY_BUFFER_FALLBACK_CAPACITY: usize = 64 * 1024;

/// Parallel (probe GET / full GET / flock / vsock) operations per `populate_cache` call.
const CONCURRENCY: usize = 4;
/// Maximum number of cache-fill groups that may be active across the runner.
const BACKGROUND_FILL_ACTIVE_LIMIT: usize = CONCURRENCY;
/// Idle transport retention, independent of the per-object request deadline.
const FRESH_DELIVERY_HTTP_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound a stalled first response without shortening body or later-attempt allowance.
const FRESH_DELIVERY_FIRST_HEADERS_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum number of unique cache-fill groups waiting for a worker across the runner.
const BACKGROUND_FILL_QUEUE_CAPACITY: usize = 32;
/// Bound the number of missing archives dispatched while maintenance is waiting.
const BACKGROUND_FILL_MISSING_BURST: usize = 3;
/// Maximum number of completed telemetry tasks reaped between scheduler polls.
const BACKGROUND_FILL_REPORT_REAP_BATCH: usize = 32;
const FRESH_DELIVERY_SCAN_LIMIT: usize = 64;
const FRESH_DELIVERY_PER_RUN_LIMIT: usize = 4;
const FRESH_DELIVERY_RUNNER_LIMIT: usize = 8;

/// Maximum number of archives staged in one guest batch write.
const GUEST_STAGE_BATCH_MAX_FILES: usize = 64;

/// Maximum total archive bytes staged in one guest batch write.
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
const STORAGE_CACHE_ARTIFACT_DECODED: &str = "storage_cache_artifact_decoded";
const STORAGE_CACHE_ARTIFACT_DECODED_INELIGIBLE: &str = "storage_cache_artifact_decoded_ineligible";
const STORAGE_CACHE_ARTIFACT_ARCHIVE_HIT: &str = "storage_cache_artifact_archive_hit";
const STORAGE_CACHE_ARTIFACT_MISS_PASSTHROUGH: &str = "storage_cache_artifact_miss_passthrough";
const STORAGE_CACHE_ARTIFACT_LOCK_BUSY_PASSTHROUGH: &str =
    "storage_cache_artifact_lock_busy_passthrough";
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
    representative: CacheTarget,
    additional_targets: Vec<CacheTarget>,
    archive_size: Option<u64>,
    // This plan already validated positive decoded contents. Only a hint for
    // optional warming of archive hits; never suppress missing archive fills.
    decoded_ready_observed: bool,
}

impl CacheTargetGroup {
    fn targets(&self) -> impl Iterator<Item = &CacheTarget> {
        std::iter::once(&self.representative).chain(&self.additional_targets)
    }

    fn key(&self) -> (String, String) {
        (
            self.representative.name.clone(),
            self.representative.version.clone(),
        )
    }
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
/// Runner teardown must call [`Self::shutdown`] after stopping job producers to
/// join accepted bodies, including publications detached by a lost job owner.
#[derive(Clone)]
pub struct FreshArchiveDeliveryAdmission {
    permits: Arc<Semaphore>,
    http: Arc<Mutex<Option<FreshArchiveHttpClient>>>,
    accepted: TaskTracker,
}

struct FreshArchiveHttpClient {
    origin: url::Origin,
    client: Client,
}

struct FreshArchivePermit {
    capacity: OwnedSemaphorePermit,
    completion: TaskTrackerToken,
}

impl FreshArchivePermit {
    fn split(&mut self, count: usize) -> Option<Self> {
        Some(Self {
            capacity: self.capacity.split(count)?,
            completion: self.completion.clone(),
        })
    }
}

impl FreshArchiveDeliveryAdmission {
    pub fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(FRESH_DELIVERY_RUNNER_LIMIT)),
            http: Arc::new(Mutex::new(None)),
            accepted: TaskTracker::new(),
        }
    }

    fn try_reserve(&self, count: u32) -> Result<FreshArchivePermit, TryAcquireError> {
        // Register before admission: shutdown closes the semaphore before it
        // waits. A registration racing that close either retains accepted work
        // or fails admission and cannot start archive IO after the join.
        let completion = self.accepted.token();
        let capacity = Arc::clone(&self.permits).try_acquire_many_owned(count)?;
        Ok(FreshArchivePermit {
            capacity,
            completion,
        })
    }

    /// Close further admission and join all previously accepted archive bodies.
    ///
    /// Call after jobs/producers have stopped. This does not cancel atomic
    /// publication: a lost per-job owner still retains its original completion
    /// witness until the publication and retained body actually retire.
    pub async fn shutdown(&self) {
        self.permits.close();
        self.accepted.close();
        self.accepted.wait().await;
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn is_closed_for_test(&self) -> bool {
        self.permits.is_closed()
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
            .connector_layer(ConnectionAttemptLayer)
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

impl Default for FreshArchiveDeliveryAdmission {
    fn default() -> Self {
        Self::new()
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

enum BackgroundFillCommand {
    Shutdown(oneshot::Sender<()>),
    #[cfg(any(test, feature = "test-support"))]
    Checkpoint(oneshot::Sender<(usize, usize)>),
}

struct BackgroundFillCoordinatorInner {
    state: Mutex<BackgroundFillAdmissionState>,
    commands: mpsc::Sender<BackgroundFillCommand>,
    ready: Notify,
    http: Client,
    active_limit: usize,
    queue_capacity: usize,
    shutdown: CancellationToken,
    classifiers: TaskTracker,
    classification_slot: Arc<Semaphore>,
}

struct BackgroundFillCoordinatorLifecycle {
    inner: Arc<BackgroundFillCoordinatorInner>,
    supervisor: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

/// Runner-owned coordinator for deferred storage-cache warming.
///
/// All executor handles clone the same coordinator. The coordinator bounds
/// active and queued work across jobs, deduplicates keys while work is queued
/// or active, and owns the supervisor task until explicit runner shutdown.
#[derive(Clone)]
pub struct StorageCacheBackgroundFillCoordinator {
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
    pub fn new() -> RunnerResult<Self> {
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

    fn submit(
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
    fn is_closed_for_test(&self) -> bool {
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

struct FreshArchivePhaseRecord {
    operation: SandboxOpRecord,
    completed_at: DateTime<Utc>,
    archive_size_mismatch: Option<ArchiveSizeMismatch>,
    archive_connection_attempt: Option<ArchiveConnectionAttempt>,
}

/// At most eight phases per archive: headers/body for three attempts, then
/// apply-wait/publication once. Four admitted archives therefore retain at most
/// 32 records. Records live outside fetch tasks so aborting and joining retains
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
            telemetry.record_archive_phase_at(
                record.operation,
                record.completed_at,
                record.archive_size_mismatch,
                record.archive_connection_attempt,
            );
        }
    }
}

struct FreshArchivePhaseGuard {
    records: FreshArchivePhaseRecords,
    action_type: Option<&'static str>,
    started_at: Instant,
    archive_size_mismatch: Option<ArchiveSizeMismatch>,
    connection_attempt_observer: Option<ConnectionAttemptObserver>,
}

impl FreshArchivePhaseGuard {
    fn new(records: &FreshArchivePhaseRecords, action_type: &'static str) -> Self {
        Self {
            records: records.clone(),
            action_type: Some(action_type),
            started_at: Instant::now(),
            archive_size_mismatch: None,
            connection_attempt_observer: None,
        }
    }

    fn new_headers(records: &FreshArchivePhaseRecords) -> (Self, ConnectionAttemptObserver) {
        let observer = ConnectionAttemptObserver::default();
        (
            Self {
                records: records.clone(),
                action_type: Some(STORAGE_CACHE_FRESH_DELIVERY_HEADERS),
                started_at: Instant::now(),
                archive_size_mismatch: None,
                connection_attempt_observer: Some(observer.clone()),
            },
            observer,
        )
    }

    fn finish(mut self, result: Result<(), &'static str>) {
        self.record(result);
    }

    fn finish_with_archive_size_mismatch(
        mut self,
        result: Result<(), &'static str>,
        mismatch: Option<ArchiveSizeMismatch>,
    ) {
        self.archive_size_mismatch = mismatch;
        self.record(result);
    }

    fn record(&mut self, result: Result<(), &'static str>) {
        let Some(action_type) = self.action_type.take() else {
            return;
        };
        // Close the request observer before capturing the phase boundary so a
        // background connector cannot enter the recorded summary after this
        // operation's duration or completion timestamp.
        let archive_connection_attempt = self
            .connection_attempt_observer
            .as_ref()
            .map(ConnectionAttemptObserver::freeze);
        let record = FreshArchivePhaseRecord {
            operation: SandboxOpRecord::new(
                action_type,
                self.started_at.elapsed(),
                result.is_ok(),
                result.err(),
            ),
            completed_at: Utc::now(),
            archive_size_mismatch: self.archive_size_mismatch,
            archive_connection_attempt,
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
    permit: FreshArchivePermit,
}

#[derive(Clone, Copy)]
enum FreshArchiveSizeSource {
    Manifest,
    Response,
}

enum FreshArchiveFetchTaskResult {
    Downloaded(FreshArchiveDownloaded),
    Terminal { error: FreshArchiveFetchError },
}

struct FreshArchiveFetchError {
    reason: &'static str,
    http_status: Option<u16>,
    retry_after: Option<Duration>,
}

impl FreshArchiveFetchError {
    fn permanent(reason: &'static str) -> Self {
        Self {
            reason,
            http_status: None,
            retry_after: None,
        }
    }

    fn from_reqwest(reason: &'static str, error: reqwest::Error) -> Self {
        Self {
            reason: if error.is_timeout() {
                "timeout"
            } else {
                reason
            },
            http_status: None,
            retry_after: object_download_transient_transport_kind(&error).map(|_| Duration::ZERO),
        }
    }

    fn http_status(response: &reqwest::Response) -> Self {
        Self {
            reason: "http-status",
            http_status: Some(response.status().as_u16()),
            retry_after: object_download_http_retry_after(response),
        }
    }
}

impl fmt::Display for FreshArchiveFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.reason)?;
        if let Some(status) = self.http_status {
            write!(f, " (status={status})")?;
        }
        Ok(())
    }
}

struct FreshArchivePublicationTaskResult {
    group: CacheTargetGroup,
    result: RunnerResult<FreshArchivePublished>,
}

struct FreshArchivePublished {
    bytes: Bytes,
    permit: FreshArchivePermit,
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
/// cancelled midway. The shared admission retains those accepted bodies for
/// [`FreshArchiveDeliveryAdmission::shutdown`] to join at Runner teardown.
pub struct FreshArchiveDelivery {
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
/// home-image selection must drain the previous delivery and rebuild both
/// values; a retry such as DNS-only sandbox replacement may retain the pair
/// when the plan inputs are unchanged.
pub struct PreparedStorage {
    pub plan: StoragePlan,
    pub delivery: FreshArchiveDelivery,
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
    /// home-image retry, a plan with no guest work, pre-spawn failure, or
    /// cancellation. It closes pending apply gates, aborts and joins fetch
    /// tasks, and then waits for publication tasks that have already started.
    /// Fetches can be cancelled before publication, but an atomic fsync/rename
    /// transaction must be allowed to finish.
    ///
    /// Unlike implicit `Drop`, this keeps publication in normal awaited
    /// teardown and records cancellation and drain telemetry when owned work
    /// exists.
    pub async fn cancel_and_drain(&mut self, telemetry: &mut JobTelemetry) {
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
                    let target = &group.representative;
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
                FreshArchiveFetchTaskResult::Terminal { error } => {
                    let reason = error.reason;
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
                            "runner-owned archive download failed: {error}"
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
    groups: Vec<(CacheTargetGroup, BackgroundFillAction)>,
    home: HomePaths,
    selected_at: Instant,
}

impl DeferredBackgroundFill {
    #[cfg(test)]
    async fn run(self) -> Vec<SandboxOpRecord> {
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

impl GuestStageWrite {
    fn as_file_entry(&self) -> WriteFileEntry<'_> {
        WriteFileEntry {
            path: self.guest_path.as_str(),
            content: self.bytes.as_ref(),
        }
    }
}

#[derive(Default)]
struct GuestStageBatch {
    writes: Vec<GuestStageWrite>,
    content_bytes: usize,
}

struct FreshGuestStageEntry {
    group: CacheTargetGroup,
    write: GuestStageWrite,
    permit: FreshArchivePermit,
}

#[derive(Default)]
struct FreshGuestStageBatch {
    entries: Vec<FreshGuestStageEntry>,
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
    groups: &mut [CacheTargetGroup],
    cache: &decoded::DecodedCache,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<()> {
    if plan.decoded_prepared() {
        return Ok(());
    }
    for batch in groups.chunks_mut(decoded::LOOKUP_BATCH_SIZE) {
        let keys = batch
            .iter()
            .map(|group| {
                let target = &group.representative;
                has_decoded_download_target(group, plan)
                    .then_some((target.name.as_str(), target.version.as_str()))
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
        for (group, files) in batch.iter_mut().zip(ready) {
            group.decoded_ready_observed = files.is_some();
            let decoded_reused = reuse_decoded(plan, group, files)?;
            if group.targets().any(|target| {
                target.handle.is_artifact()
                    && !plan.has_decoded(target.handle)
                    && (!plan.is_decoded_download(target.handle)
                        || (group.decoded_ready_observed && !decoded_reused))
            }) {
                telemetry.record(
                    STORAGE_CACHE_ARTIFACT_DECODED_INELIGIBLE,
                    Duration::ZERO,
                    true,
                    None,
                );
            }
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
    // An archive may still be required by another target sharing this key,
    // such as an instruction storage. Admit its ordinary targets without
    // changing archive delivery for that other consumer.
    let eligible = group
        .targets()
        .filter(|target| plan.is_decoded_download(target.handle))
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Ok(false);
    }
    // Check mounts only on a ready hit. Misses keep ordinary delivery.
    let Some(mounts) = eligible
        .iter()
        .map(|target| plan.decoded_mount(target.handle).map(str::to_owned))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(false);
    };
    for target in &eligible {
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
        || plan.decoded_file_count() + files.files.len() * mounts.len()
            > guest_contracts::storage_files::MAX_TOTAL_FILES
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
        writes: &[WriteFileEntry<'_>],
    ) -> RunnerResult<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let mut paths = writes.iter().map(|write| write.path).collect::<Vec<_>>();
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
        sandbox.write_files(writes).await?;
        Ok(())
    }
}

fn guest_stage_batch_should_flush_before(
    file_count: usize,
    content_bytes: usize,
    incoming_bytes: usize,
) -> bool {
    file_count != 0
        && (file_count >= GUEST_STAGE_BATCH_MAX_FILES
            || content_bytes.saturating_add(incoming_bytes) > GUEST_STAGE_BATCH_MAX_BYTES)
}

fn guest_stage_batch_should_flush_after_push(file_count: usize, content_bytes: usize) -> bool {
    file_count >= GUEST_STAGE_BATCH_MAX_FILES || content_bytes >= GUEST_STAGE_BATCH_MAX_BYTES
}

impl GuestStageBatch {
    fn should_flush_before(&self, write: &GuestStageWrite) -> bool {
        guest_stage_batch_should_flush_before(
            self.writes.len(),
            self.content_bytes,
            write.bytes.len(),
        )
    }

    fn push(&mut self, write: GuestStageWrite) {
        self.content_bytes += write.bytes.len();
        self.writes.push(write);
    }

    fn should_flush_after_push(&self) -> bool {
        guest_stage_batch_should_flush_after_push(self.writes.len(), self.content_bytes)
    }
}

impl FreshGuestStageBatch {
    fn should_flush_before(&self, write: &GuestStageWrite) -> bool {
        guest_stage_batch_should_flush_before(
            self.entries.len(),
            self.content_bytes,
            write.bytes.len(),
        )
    }

    fn push(&mut self, entry: FreshGuestStageEntry) {
        self.content_bytes += entry.write.bytes.len();
        self.entries.push(entry);
    }

    fn should_flush_after_push(&self) -> bool {
        guest_stage_batch_should_flush_after_push(self.entries.len(), self.content_bytes)
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
    let result = {
        let writes = batch
            .writes
            .iter()
            .map(GuestStageWrite::as_file_entry)
            .collect::<Vec<_>>();
        stage.guest_writes.write_files(stage.sandbox, &writes).await
    };
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
    if batch.entries.is_empty() {
        return Ok(());
    }
    let started_at = Instant::now();
    let result = {
        let writes = batch
            .entries
            .iter()
            .map(|entry| entry.write.as_file_entry())
            .collect::<Vec<_>>();
        stage.guest_writes.write_files(stage.sandbox, &writes).await
    };
    stage.metrics.record_write_result(
        stage.telemetry,
        STORAGE_CACHE_STAGE_BATCH_WRITE,
        started_at,
        &result,
    );
    result?;
    // Moving groups into outcomes must not release capacity while other
    // entries in this successful batch still need their bookkeeping.
    let mut retained_permits = Vec::with_capacity(batch.entries.len());
    for FreshGuestStageEntry {
        group,
        write,
        permit,
    } in batch.entries.drain(..)
    {
        stage.telemetry.record(
            STORAGE_CACHE_FRESH_DELIVERY_STAGED,
            Duration::ZERO,
            true,
            None,
        );
        outcomes.push((group, TargetOutcome::Hit));
        drop(write);
        retained_permits.push(permit);
    }
    drop(retained_permits);
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
        let target = &group.representative;
        let write = GuestStageWrite {
            guest_path: guest_archive_path(&target.name, &target.version),
            bytes,
        };
        if batch.should_flush_before(&write) {
            flush_fresh_guest_stage_batch(&mut batch, &mut stage, &mut outcomes).await?;
        }
        batch.push(FreshGuestStageEntry {
            group,
            write,
            permit,
        });
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
    let result = match processed {
        Ok(processed) => {
            stage_processed_group(group, processed, outcomes, stage_batch, stage).await
        }
        Err(error) => Err(error),
    };
    if result.is_err() {
        abort_pending_processed_groups(groups).await;
    }
    result
}

/// Test-only wrapper for [`populate_cache_with_fresh_delivery`] without fresh
/// delivery or a decoded cache.
#[cfg(test)]
pub async fn populate_cache(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    populate_cache_with_fresh_delivery(plan, sandbox, home, telemetry, None, None).await
}

/// Resolves eligible archive sources against the runner-side cache.
///
/// Warm hits are staged into the guest over vsock, and their sources in
/// `plan` are rewritten to guest-local `file://` URLs before this function
/// returns. Sources without a usable warm hit keep their original remote URLs
/// for the current guest download. After classifying and staging outcomes, this
/// function may select deferred archive fill, extracted-file cache warming, or
/// redundant archive retirement; it does not start that work.
///
/// # Returns
///
/// Returns `Ok(Some(...))` when a [`DeferredBackgroundFill`] was selected. The
/// caller must retain it through pre-spawn setup and call
/// [`DeferredBackgroundFill::start`] only after the agent process has spawned;
/// an earlier failure deliberately drops it without starting work. Returns
/// `Ok(None)` when no deferred work was selected.
///
/// Reuse, repair, empty, instruction, cleanup, and guest-work semantics remain
/// owned by [`StoragePlan`].
pub async fn populate_cache_with_fresh_delivery(
    plan: &mut StoragePlan,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
    fresh_delivery: Option<&mut FreshArchiveDelivery>,
    decoded: Option<&decoded::DecodedCache>,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    let mut fresh_delivery = fresh_delivery;
    let mut target_groups = if let Some(delivery) = fresh_delivery.as_mut() {
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
        prepare_decoded_storage(plan, &mut target_groups, cache, telemetry).await?;
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
        .map(|(group, _)| group.key())
        .collect::<HashSet<_>>();
    let target_groups = target_groups
        .into_iter()
        .filter(|group| !owned_keys.contains(&group.key()))
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

    record_passthrough_summary(&outcomes, plan, telemetry);
    let deferred =
        defer_background_fill_groups(&outcomes, home.clone(), decoded.cloned(), plan, telemetry);
    for (group, outcome) in outcomes {
        apply_group_outcome(plan, &group, &outcome, telemetry);
    }
    Ok(deferred)
}

fn has_decoded_download_target(group: &CacheTargetGroup, plan: &StoragePlan) -> bool {
    group
        .targets()
        .any(|target| plan.is_decoded_download(target.handle))
}

fn group_has_decoded(group: &CacheTargetGroup, plan: &StoragePlan) -> bool {
    group
        .targets()
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
                .filter(|_| has_decoded_download_target(group, plan));
            let action = if matches!(outcome, TargetOutcome::Decoded) {
                if !group
                    .targets()
                    .any(|target| plan.decoded_archive_retirement_candidate(target.handle))
                {
                    return None;
                }
                BackgroundFillAction::RetireArchive(decoded?.clone())
            } else if should_background_fill(outcome) {
                BackgroundFillAction::Fill(decoded.cloned())
            } else if matches!(outcome, TargetOutcome::Hit) && !group.decoded_ready_observed {
                BackgroundFillAction::WarmDecoded(decoded?.clone())
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

fn group_targets(targets: Vec<CacheTarget>) -> Vec<CacheTargetGroup> {
    let mut group_order = Vec::new();
    let mut groups_by_key: HashMap<(String, String), CacheTargetGroup> = HashMap::new();

    for target in targets {
        let key = (target.name.clone(), target.version.clone());
        match groups_by_key.entry(key.clone()) {
            Entry::Occupied(mut entry) => {
                entry.get_mut().additional_targets.push(target);
            }
            Entry::Vacant(entry) => {
                group_order.push(key);
                entry.insert(CacheTargetGroup {
                    representative: target,
                    additional_targets: Vec::new(),
                    archive_size: None,
                    decoded_ready_observed: false,
                });
            }
        }
    }

    let mut groups = Vec::with_capacity(group_order.len());
    for key in group_order {
        if let Some(mut group) = groups_by_key.remove(&key) {
            group.archive_size = reconcile_archive_size(group.targets());
            groups.push(group);
        }
    }
    groups
}

fn reconcile_archive_size<'a>(targets: impl Iterator<Item = &'a CacheTarget>) -> Option<u64> {
    let mut known_size = None;
    for size in targets
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
pub async fn prepare_fresh_archive_delivery(
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
    let mut groups = group_targets(collect_targets(archives));
    if let Some(cache) = decoded {
        prepare_decoded_storage(plan, &mut groups, cache, telemetry).await?;
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
                let target = &group.representative;
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
            let permit = match admission.try_reserve(1) {
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
        let mut permits = match admission.try_reserve(expanded.len() as u32) {
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
    let target = &group.representative;
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
        permit: FreshArchivePermit,
        admission: &FreshArchiveDeliveryAdmission,
        cancel: &CancellationToken,
        metrics: &mut CacheProcessMetrics,
    ) -> RunnerResult<()> {
        let target = &group.representative;
        let http = admission.client_for_archive(&target.archive_url)?;
        let archive_url = target.archive_url.clone();
        let representative = target.handle;
        let group = group.clone();
        let cancel = cancel.clone();
        let phase_records = self.phase_records.clone();
        let (apply_tx, apply_rx) = oneshot::channel();
        self.apply.push(apply_tx);
        self.fetches.spawn(async move {
            let fetch = tokio::select! {
                biased;
                () = cancel.cancelled() => Err(FreshArchiveFetchError::permanent("cancelled")),
                result = fetch_fresh_archive(&http, &archive_url, group.archive_size, representative, &phase_records) => result,
            };
            let (bytes, size_source) = match fetch {
                Ok(download) => download,
                Err(error) => return FreshArchiveFetchTaskResult::Terminal { error },
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
                Err(reason) => FreshArchiveFetchTaskResult::Terminal {
                    error: FreshArchiveFetchError::permanent(reason),
                },
            }
        });
        metrics.record(
            STORAGE_CACHE_FRESH_DELIVERY_ADMITTED,
            Duration::ZERO,
            true,
            None,
        );
        // Retain the legacy admission marker once per logical download owner.
        // Entered headers phases count explicit application-level GET attempts.
        metrics.record(
            STORAGE_CACHE_FRESH_DELIVERY_SINGLE_REQUEST,
            Duration::ZERO,
            true,
            None,
        );
        Ok(())
    }
}

/// Retries remain within this owner, with the same URL, writer and permit.
/// Exhaustion is terminal; no second Guest download owner follows a failure.
async fn fetch_fresh_archive(
    http: &Client,
    archive_url: &str,
    expected_size: Option<u64>,
    representative: ArchiveHandle,
    phase_records: &FreshArchivePhaseRecords,
) -> Result<(Bytes, FreshArchiveSizeSource), FreshArchiveFetchError> {
    let mut budget = ObjectDownloadRetryBudget::default();
    let mut first_attempt = true;
    loop {
        let result = budget
            .run_attempt(fetch_fresh_archive_once(
                http,
                archive_url,
                expected_size,
                representative,
                phase_records,
                first_attempt,
            ))
            .await
            .map_err(|_| FreshArchiveFetchError::permanent("timeout"))?;
        match result {
            Ok(download) => return Ok(download),
            Err(error) => {
                let Some(retry) = budget.next_retry(error.retry_after) else {
                    return Err(error);
                };
                info!(
                    action = "storage_cache_fresh_delivery_retry",
                    r2_key = crate::r2_download::key_from_url(archive_url).as_deref(),
                    attempt = retry.attempt(),
                    max_attempts = OBJECT_DOWNLOAD_MAX_ATTEMPTS,
                    reason = error.reason,
                    http_status = error.http_status,
                    retry_delay_ms = retry.delay().as_millis() as u64,
                    "retrying runner-owned archive download"
                );
                // The enclosing task's cancellation owns this wait and the
                // next request. Partial bodies never leave an attempt.
                retry
                    .wait()
                    .await
                    .map_err(|_| FreshArchiveFetchError::permanent("timeout"))?;
                first_attempt = false;
            }
        }
    }
}

async fn fetch_fresh_archive_once(
    http: &Client,
    archive_url: &str,
    expected_size: Option<u64>,
    representative: ArchiveHandle,
    phase_records: &FreshArchivePhaseRecords,
    first_attempt: bool,
) -> Result<(Bytes, FreshArchiveSizeSource), FreshArchiveFetchError> {
    let (phase, connection_attempt_observer) = FreshArchivePhaseGuard::new_headers(phase_records);
    let mut mismatch = None;
    let headers = connection_attempt_observer
        .scope(async {
            let request = http
                .get(archive_url)
                .timeout(OBJECT_DOWNLOAD_TIMEOUT)
                .send();
            // Keep reqwest's whole-request timer through body consumption. Only
            // the first send gets a shorter absolute header deadline; retries
            // retain room for a valid slow response under the original budget.
            let response = if first_attempt {
                before_deadline(
                    tokio::time::Instant::now() + FRESH_DELIVERY_FIRST_HEADERS_TIMEOUT,
                    request,
                )
                .await
                .map_err(|_| FreshArchiveFetchError {
                    reason: "headers-timeout",
                    http_status: None,
                    retry_after: Some(Duration::ZERO),
                })?
            } else {
                request.await
            }
            .map_err(|error| FreshArchiveFetchError::from_reqwest("http", error))?;
            if response.status() != reqwest::StatusCode::OK {
                return Err(FreshArchiveFetchError::http_status(&response));
            }

            let response_size = response.content_length();
            let (exact_size, size_source) = match expected_size {
                Some(expected) => {
                    if let Some(size) = response_size.filter(|size| *size != expected) {
                        mismatch = Some(ArchiveSizeMismatch::new(
                            expected,
                            size,
                            representative,
                            response.headers(),
                        ));
                    }
                    // A logical version does not fix the compressed archive size.
                    // Use the response length when available and retain the stored
                    // size only for responses without a declared length.
                    (
                        response_size.unwrap_or(expected),
                        if mismatch.is_some() {
                            FreshArchiveSizeSource::Response
                        } else {
                            FreshArchiveSizeSource::Manifest
                        },
                    )
                }
                None => match response_size {
                    Some(0) => return Err(FreshArchiveFetchError::permanent("response-size-zero")),
                    Some(size) if size <= CACHE_MAX_SIZE => {
                        (size, FreshArchiveSizeSource::Response)
                    }
                    Some(_) => {
                        return Err(FreshArchiveFetchError::permanent("response-size-oversized"));
                    }
                    None => return Err(FreshArchiveFetchError::permanent("response-size-missing")),
                },
            };
            if exact_size == 0 {
                return Err(FreshArchiveFetchError::permanent(
                    if response_size.is_some() {
                        "response-size-zero"
                    } else {
                        "expected-size-zero"
                    },
                ));
            }
            if exact_size > CACHE_MAX_SIZE {
                return Err(FreshArchiveFetchError::permanent(
                    if response_size.is_some() {
                        "response-size-oversized"
                    } else {
                        "expected-size-oversized"
                    },
                ));
            }
            Ok((response, response_size, exact_size, size_source))
        })
        .await;
    phase.finish_with_archive_size_mismatch(
        headers.as_ref().map(|_| ()).map_err(|error| error.reason),
        mismatch,
    );
    let (mut response, response_size, exact_size, size_source) = headers?;

    let phase = FreshArchivePhaseGuard::new(phase_records, STORAGE_CACHE_FRESH_DELIVERY_BODY);
    let body = async {
        let mut body = BoundedArchiveBody::new(
            initial_body_capacity(response_size, Some(exact_size), CACHE_MAX_SIZE),
            CACHE_MAX_SIZE,
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| FreshArchiveFetchError::from_reqwest("body", error))?
        {
            if body
                .append(&chunk)
                .map_err(|_| FreshArchiveFetchError::permanent("body-length-overflow"))?
                .is_some()
            {
                return Err(FreshArchiveFetchError::permanent("body-oversized"));
            }
        }
        if body
            .len()
            .map_err(|_| FreshArchiveFetchError::permanent("body-length-overflow"))?
            != exact_size
        {
            return Err(FreshArchiveFetchError::permanent("body-size-mismatch"));
        }
        Ok((body.into_bytes(), size_source))
    }
    .await;
    phase.finish(body.as_ref().map(|_| ()).map_err(|error| error.reason));
    body
}

fn cache_target_from_entry(
    handle: ArchiveHandle,
    archive_url: &str,
    name: &str,
    version: &str,
    archive_size: Option<u64>,
) -> Option<CacheTarget> {
    // Empty identity components collapse distinct entries into one cache slot.
    // Guest treats the literal "null" source as absent; neither it nor an
    // empty source may be replaced by cached content.
    if name.is_empty() || version.is_empty() || archive_url.is_empty() || archive_url == "null" {
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
    let target = &group.representative;
    process_one_background_fill(target, group.archive_size, http, home).await
}

async fn process_group_hit_or_passthrough(
    group: &CacheTargetGroup,
    home: &HomePaths,
    metrics: &mut CacheProcessMetrics,
) -> RunnerResult<ProcessedGroup> {
    let target = &group.representative;
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
            r2_key = crate::r2_download::key_from_url(&target.archive_url).as_deref(),
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

    let mut body = BoundedArchiveBody::new(
        initial_body_capacity(content_length, expected_size, max_size),
        max_size,
    );

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CacheHttpError::from_reqwest("read body", e))?
    {
        if let Some(observed_size) = body.append(&chunk)? {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    let bytes = body.into_bytes();
    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
    }

    Ok(DownloadBody::Complete(bytes))
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
    let mut body = BoundedArchiveBody::new(capacity, max_size);
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
        if let Some(observed_size) = body.append(chunk)? {
            return Ok(DownloadBody::OverSize { observed_size });
        }
    }

    let bytes = body.into_bytes();
    if bytes.is_empty() {
        return Ok(DownloadBody::Empty);
    }

    Ok(DownloadBody::Complete(bytes))
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

/// Owns the retained bytes and their append limit without a separate byte count.
struct BoundedArchiveBody {
    bytes: Vec<u8>,
    max_size: u64,
}

impl BoundedArchiveBody {
    fn new(capacity: usize, max_size: u64) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
            max_size,
        }
    }

    fn len(&self) -> RunnerResult<u64> {
        u64::try_from(self.bytes.len())
            .map_err(|_| RunnerError::Internal("body length overflow".to_string()))
    }

    fn append(&mut self, chunk: &[u8]) -> RunnerResult<Option<u64>> {
        let chunk_len = u64::try_from(chunk.len())
            .map_err(|_| RunnerError::Internal("body chunk length overflow".to_string()))?;
        let Some(observed_size) = self.len()?.checked_add(chunk_len) else {
            return Ok(Some(u64::MAX));
        };
        if observed_size > self.max_size {
            return Ok(Some(observed_size));
        }
        self.bytes.extend_from_slice(chunk);
        Ok(None)
    }

    fn into_bytes(self) -> Bytes {
        Bytes::from(self.bytes)
    }
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

enum CachePublication {
    Renamed,
    ExistingArchive,
}

async fn write_to_cache(cache_dir: &Path, bytes: &[u8]) -> RunnerResult<()> {
    let staging = staging_dir(cache_dir);

    // Best-effort cleanup of stale staging from a prior crashed run.
    let _ = fs::remove_dir_all(&staging).await;
    fs::create_dir_all(&staging)
        .await
        .map_err(|e| RunnerError::Internal(format!("create staging {}: {e}", staging.display())))?;

    let publication: RunnerResult<CachePublication> = async {
        let archive_staging = staging.join("archive.tar.gz");
        fs::write(&archive_staging, bytes).await.map_err(|e| {
            RunnerError::Internal(format!("write {}: {e}", archive_staging.display()))
        })?;

        // fsync before publishing so a crash cannot expose a torn archive.
        // Retire the handle before any failed-attempt cleanup.
        {
            let archive = fs::File::open(&archive_staging).await.map_err(|e| {
                RunnerError::Internal(format!("open for fsync {}: {e}", archive_staging.display()))
            })?;
            archive.sync_all().await.map_err(|e| {
                RunnerError::Internal(format!("fsync {}: {e}", archive_staging.display()))
            })?;
        }

        // Ensure the `<name>/` parent exists so the rename below has a target.
        if let Some(parent) = cache_dir.parent() {
            fs::create_dir_all(parent).await.map_err(|e| {
                RunnerError::Internal(format!("create cache parent {}: {e}", parent.display()))
            })?;
        }

        if let Err(e) = fs::rename(&staging, cache_dir).await {
            // A sibling runner may have populated the final dir while we were
            // staging. Only accept a collision when the final artifact exists;
            // other errors (EXDEV, ENOSPC, EACCES, ...) must still propagate.
            if is_rename_collision(&e)
                && fs::metadata(cache_dir.join("archive.tar.gz")).await.is_ok()
            {
                return Ok(CachePublication::ExistingArchive);
            }
            return Err(RunnerError::Internal(format!(
                "rename {} -> {}: {e}",
                staging.display(),
                cache_dir.display()
            )));
        }
        Ok(CachePublication::Renamed)
    }
    .await;

    let result = match publication {
        // Rename consumed staging; its old path may already belong to a new attempt.
        Ok(CachePublication::Renamed) => return Ok(()),
        Ok(CachePublication::ExistingArchive) => Ok(()),
        Err(error) => Err(error),
    };
    // Retire failed or superseded staging without replacing the original result.
    let _ = fs::remove_dir_all(&staging).await;
    result
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
    for target in group.targets() {
        if plan.has_decoded(target.handle) {
            apply_outcome(plan, target, &TargetOutcome::Decoded, telemetry);
        } else {
            apply_outcome(plan, target, outcome, telemetry);
        }
    }
}

fn apply_outcome(
    plan: &mut StoragePlan,
    target: &CacheTarget,
    outcome: &TargetOutcome,
    telemetry: &mut JobTelemetry,
) {
    let artifact = target.handle.is_artifact();
    match outcome {
        TargetOutcome::Decoded => {
            telemetry.record("storage_cache_decoded", Duration::ZERO, true, None);
            if artifact {
                telemetry.record(STORAGE_CACHE_ARTIFACT_DECODED, Duration::ZERO, true, None);
            }
        }
        TargetOutcome::Hit => {
            rewrite_url(plan, target);
            telemetry.record("storage_cache_hit", Duration::ZERO, true, None);
            if artifact {
                telemetry.record(
                    STORAGE_CACHE_ARTIFACT_ARCHIVE_HIT,
                    Duration::ZERO,
                    true,
                    None,
                );
            }
        }
        TargetOutcome::MissPassthrough { reason } => {
            telemetry.record(
                STORAGE_CACHE_MISS_PASSTHROUGH,
                Duration::ZERO,
                true,
                Some(reason),
            );
            if artifact {
                telemetry.record(
                    STORAGE_CACHE_ARTIFACT_MISS_PASSTHROUGH,
                    Duration::ZERO,
                    true,
                    Some(reason),
                );
            }
        }
        TargetOutcome::LockBusyPassthrough => {
            telemetry.record(
                STORAGE_CACHE_LOCK_BUSY_PASSTHROUGH,
                Duration::ZERO,
                true,
                None,
            );
            if artifact {
                telemetry.record(
                    STORAGE_CACHE_ARTIFACT_LOCK_BUSY_PASSTHROUGH,
                    Duration::ZERO,
                    true,
                    None,
                );
            }
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
    plan: &StoragePlan,
    telemetry: &mut JobTelemetry,
) {
    let mut summary = PassthroughSummary::default();
    for (group, outcome) in outcomes {
        for target in group.targets() {
            if plan.has_decoded(target.handle) {
                add_passthrough_summary(&mut summary, &TargetOutcome::Decoded, 1);
            } else {
                add_passthrough_summary(&mut summary, outcome, 1);
            }
        }
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
mod tests;
