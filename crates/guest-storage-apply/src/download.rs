use crate::ApplyFailure;
use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::readiness::Readiness;
use crate::source;
use crate::telemetry::{
    DownloadRunTelemetry, DownloadTaskTelemetry, LocalArchiveTaskMetrics, RemoteArchiveTaskMetrics,
};
use guest_contracts::storage_files::{PACKED_BATCH_FILE_URL, PACKED_BATCH_START_URL};
use guest_contracts::storage_paths::normalize_path;
use guest_telemetry::{log_error, log_info};
use std::any::Any;
use std::collections::VecDeque;
use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

mod decoded;

const LOCAL_CONCURRENT: usize = 4;
const LARGE_LOCAL_ARTIFACT_BYTES: u64 = 256 * 1024;
#[cfg(target_os = "linux")]
const MIN_INLINE_ARTIFACT_BATCH_TASKS: usize = 17;
#[cfg(target_os = "linux")]
const MAX_INLINE_COMPANION_EXPANDED_BYTES: u32 = 32 * 1024 * 1024;
#[cfg(target_os = "linux")]
const WIDE_LOCAL_INFLATE_TASKS: usize = 32;
const BASE_REMOTE_CONCURRENT: usize = 16;
const MEDIUM_REMOTE_MAX_CONCURRENT: usize = 20;
const LARGE_REMOTE_BATCH: usize = 64;
const LARGE_REMOTE_CONCURRENT: usize = 24;
const VERY_LARGE_REMOTE_BATCH: usize = 96;
const VERY_LARGE_REMOTE_CONCURRENT: usize = 32;
const VERY_LARGE_REMOTE_MAX_CONCURRENT: usize = 40;
type AttemptRunner = fn(&mut StartedDownload<'_>) -> Result<(), DownloadError>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask<'input> {
    label: String,
    url: String,
    mount_path: String,
    normalized_mount_path: PathBuf,
    telemetry: DownloadTaskTelemetry,
    files: Option<Vec<guest_contracts::storage_files::StorageFile<&'input [u8]>>>,
    inline_archive: Option<&'input [u8]>,
    template_guidance: Option<guest_contracts::storage_manifest::TemplateGuidanceReference>,
}

impl<'input> DownloadTask<'input> {
    pub(crate) fn with_template_guidance(
        mut self,
        reference: Option<guest_contracts::storage_manifest::TemplateGuidanceReference>,
    ) -> Self {
        self.template_guidance = reference;
        self
    }

    pub(crate) fn mount_path(&self) -> &str {
        &self.mount_path
    }

    pub(crate) fn local_archive_path(&self) -> Option<&str> {
        self.url.strip_prefix("file://")
    }

    pub(crate) fn set_inline_archive(&mut self, archive: &'input [u8]) {
        self.inline_archive = Some(archive);
    }

    fn log_progress(&self) -> bool {
        // Packed decoded requests keep batch progress and per-mount result
        // metrics. Avoid synchronous stderr and system-log writes for the
        // start and successful completion of every decoded mount.
        self.files.is_none()
            || !matches!(
                self.url.as_str(),
                PACKED_BATCH_START_URL | PACKED_BATCH_FILE_URL
            )
    }

    pub(crate) fn set_files(
        &mut self,
        files: Vec<guest_contracts::storage_files::StorageFile<&'input [u8]>>,
    ) {
        self.files = Some(files);
        self.telemetry.decoded();
        self.label.push_str(" delivery=decoded_files");
    }

    pub(crate) fn storage(
        label: String,
        url: String,
        mount_path: String,
        has_instructions_target: bool,
    ) -> Self {
        let normalized_mount_path = normalize_path(Path::new(&mount_path));
        let telemetry =
            DownloadTaskTelemetry::storage(&url, &normalized_mount_path, has_instructions_target);
        Self {
            label,
            url,
            mount_path,
            normalized_mount_path,
            telemetry,
            files: None,
            inline_archive: None,
            template_guidance: None,
        }
    }

    pub(crate) fn artifact(label: String, url: String, mount_path: String) -> Self {
        let normalized_mount_path = normalize_path(Path::new(&mount_path));
        let telemetry = DownloadTaskTelemetry::artifact(&url, &normalized_mount_path);
        Self {
            label,
            url,
            mount_path,
            normalized_mount_path,
            telemetry,
            files: None,
            inline_archive: None,
            template_guidance: None,
        }
    }

    fn prepare(self) -> Result<PreparedDownloadTask<'input>, DownloadError> {
        fs::create_dir_all(&self.mount_path).map_err(|e| {
            DownloadError::writing_target(
                format!(
                    "{} target preparation failed: failed to create directory {}",
                    self.label, self.mount_path
                ),
                e,
            )
        })?;
        let effective_mount_path = Path::new(&self.mount_path).canonicalize().map_err(|e| {
            DownloadError::writing_target(
                format!(
                    "{} target preparation failed: failed to resolve directory {}",
                    self.label, self.mount_path
                ),
                e,
            )
        })?;

        Ok(PreparedDownloadTask {
            task: self,
            effective_mount_path,
            source_ready: None,
        })
    }
}

pub(crate) struct PreparedDownloadTask<'input> {
    task: DownloadTask<'input>,
    effective_mount_path: PathBuf,
    source_ready: Option<Arc<AtomicBool>>,
}

impl PreparedDownloadTask<'_> {
    fn logical_mount_path(&self) -> &Path {
        &self.task.normalized_mount_path
    }

    fn effective_mount_path(&self) -> &Path {
        &self.effective_mount_path
    }

    fn failure_detail(&self, error: &DownloadError) -> String {
        format!("{} download failed: {}", self.task.label, error)
    }
}

struct PendingDownload<'input> {
    id: usize,
    task: PreparedDownloadTask<'input>,
    estimated_work: u64,
}

impl<'input> PendingDownload<'input> {
    fn new(id: usize, task: PreparedDownloadTask<'input>) -> Self {
        Self {
            id,
            task,
            estimated_work: 0,
        }
    }

    fn is_large_local_artifact(&self) -> bool {
        self.estimated_work >= LARGE_LOCAL_ARTIFACT_BYTES && self.task.task.telemetry.is_artifact()
    }
}

struct StartedDownload<'input> {
    id: usize,
    task: PreparedDownloadTask<'input>,
    start: Instant,
    opened_file_compressed_bytes: Option<u64>,
    remote_metrics: Option<RemoteArchiveTaskMetrics>,
    local_metrics: Option<LocalArchiveTaskMetrics>,
    concurrency: usize,
    #[cfg(target_os = "linux")]
    inflate_load: Option<archive::inflate::InflateLoad>,
}

impl<'input> StartedDownload<'input> {
    fn new(
        download: PendingDownload<'input>,
        concurrency: usize,
        #[cfg(target_os = "linux")] inflate_load: Option<archive::inflate::InflateLoad>,
    ) -> Self {
        let start = Instant::now();
        if download.task.task.log_progress() {
            log_info!(
                LOG_TAG,
                "Downloading {} to {}",
                download.task.task.label,
                download.task.task.mount_path
            );
        }
        Self {
            id: download.id,
            remote_metrics: download.task.task.telemetry.remote_metrics(),
            local_metrics: download.task.task.telemetry.local_metrics(),
            task: download.task,
            start,
            opened_file_compressed_bytes: None,
            concurrency,
            #[cfg(target_os = "linux")]
            inflate_load,
        }
    }

    fn attempt(mut self, runner: AttemptRunner) -> DownloadCompletion<'input> {
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| runner(&mut self)))
            .map(AttemptOutcome::Finished)
            .unwrap_or_else(|error| AttemptOutcome::Panicked(panic_message(error.as_ref())));
        DownloadCompletion {
            download: self,
            outcome,
        }
    }

    fn finish(self, result: Result<(), DownloadError>) -> Result<(), ApplyFailure> {
        match result {
            Ok(()) => {
                let elapsed = self.start.elapsed();
                self.task.task.telemetry.record_result(
                    elapsed,
                    true,
                    None,
                    self.opened_file_compressed_bytes,
                    self.remote_metrics.as_ref(),
                    self.local_metrics.as_ref(),
                );
                if self.task.task.log_progress() {
                    log_info!(
                        LOG_TAG,
                        "{} downloaded in {}ms",
                        self.task.task.label,
                        elapsed.as_millis()
                    );
                }
                Ok(())
            }
            Err(error) => {
                let failure_detail = self.task.failure_detail(&error);
                self.task.task.telemetry.record_result(
                    self.start.elapsed(),
                    false,
                    Some(&failure_detail),
                    self.opened_file_compressed_bytes,
                    self.remote_metrics.as_ref(),
                    self.local_metrics.as_ref(),
                );
                log_error!(LOG_TAG, "{failure_detail}");
                Err(error.failure)
            }
        }
    }
}

struct DownloadReservation {
    id: usize,
    logical_mount_path: PathBuf,
    effective_mount_path: PathBuf,
}

impl DownloadReservation {
    fn new(download: &StartedDownload<'_>) -> Self {
        Self {
            id: download.id,
            logical_mount_path: download.task.logical_mount_path().to_path_buf(),
            effective_mount_path: download.task.effective_mount_path().to_path_buf(),
        }
    }
}

struct DownloadCompletion<'input> {
    download: StartedDownload<'input>,
    outcome: AttemptOutcome,
}

impl DownloadCompletion<'_> {
    fn finish(self) -> Result<(), ApplyFailure> {
        match self.outcome {
            AttemptOutcome::Finished(result) => self.download.finish(result),
            AttemptOutcome::Panicked(message) => {
                log_error!(LOG_TAG, "Thread panicked: {message}");
                Err(ApplyFailure::Failed)
            }
        }
    }
}

fn record_failure(batch: &mut Result<(), ApplyFailure>, result: Result<(), ApplyFailure>) {
    // A general failure takes precedence over a recoverable target conflict.
    if let Err(failure) = result
        && *batch != Err(ApplyFailure::Failed)
    {
        *batch = Err(failure);
    }
}

enum DownloadEvent {
    Completed,
    SourceReadiness(std::io::Result<()>),
}

enum AttemptOutcome {
    Finished(Result<(), DownloadError>),
    Panicked(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DownloadSelection {
    Fifo,
    Largest,
    LargeArtifact,
}

struct DownloadScheduler<'input> {
    pending: VecDeque<PendingDownload<'input>>,
    reservations: Vec<DownloadReservation>,
    active_attempts: usize,
    concurrency: usize,
    result: Result<(), ApplyFailure>,
    prioritize_large: bool,
    prioritize_artifact: bool,
    #[cfg(target_os = "linux")]
    paired_inflater: Option<usize>,
}

impl<'input> DownloadScheduler<'input> {
    fn new(
        pending: VecDeque<PendingDownload<'input>>,
        concurrency: usize,
        allow_artifact_priority: bool,
    ) -> Self {
        let prioritize_large = pending.iter().any(|download| download.estimated_work > 0);
        let prioritize_artifact = allow_artifact_priority
            && pending.len() > concurrency
            && pending.iter().any(PendingDownload::is_large_local_artifact);
        #[cfg(target_os = "linux")]
        let paired_inflater = if allow_artifact_priority && concurrency == 2 {
            paired_inflater(&pending)
        } else {
            None
        };
        Self {
            pending,
            reservations: Vec::new(),
            active_attempts: 0,
            concurrency,
            result: Ok(()),
            prioritize_large,
            prioritize_artifact,
            #[cfg(target_os = "linux")]
            paired_inflater,
        }
    }

    fn has_work(&self) -> bool {
        !self.pending.is_empty() || !self.reservations.is_empty()
    }

    fn can_make_progress(&self) -> bool {
        self.active_attempts > 0
    }

    fn start_ready_attempts(
        &mut self,
        work_tx: &mpsc::SyncSender<StartedDownload<'input>>,
        telemetry: &mut DownloadRunTelemetry,
    ) -> bool {
        while self.active_attempts < self.concurrency {
            // Share at most one inflater by using the existing first-wave
            // Artifact promotion. Local batches with deferred sources do not
            // set the priority flag.
            #[cfg(target_os = "linux")]
            let wide_inflate = self.prioritize_artifact
                && self.pending.len() + self.active_attempts >= WIDE_LOCAL_INFLATE_TASKS;
            let selection = if self.prioritize_large {
                DownloadSelection::Largest
            } else if std::mem::take(&mut self.prioritize_artifact) {
                DownloadSelection::LargeArtifact
            } else {
                DownloadSelection::Fifo
            };
            let Some((index, _)) = find_startable_download(
                &self.pending,
                &self.reservations,
                selection,
                &mut |pending_id, pending_path, active_id, active_path| {
                    telemetry.record_conflict(pending_id, pending_path, active_id, active_path);
                },
            ) else {
                break;
            };
            let Some(download) = self.pending.remove(index) else {
                log_error!(LOG_TAG, "Download scheduler selected a missing task");
                return false;
            };
            // Compressed size can underestimate dense Artifacts. Give one a
            // slot alongside the largest archive before returning to FIFO.
            if self.prioritize_large && download.estimated_work > 0 {
                self.prioritize_large = false;
                if download.is_large_local_artifact() {
                    self.prioritize_artifact = false;
                }
            }
            #[cfg(target_os = "linux")]
            let inflate_load = if self.concurrency == 1 || self.paired_inflater == Some(download.id)
            {
                Some(archive::inflate::InflateLoad::Light)
            } else if wide_inflate && download.is_large_local_artifact() {
                Some(archive::inflate::InflateLoad::WideBatch)
            } else {
                None
            };
            let download = StartedDownload::new(
                download,
                self.concurrency,
                #[cfg(target_os = "linux")]
                inflate_load,
            );
            self.reservations.push(DownloadReservation::new(&download));

            if work_tx.send(download).is_err() {
                log_error!(LOG_TAG, "Download scheduler worker channel closed");
                return false;
            }
            self.active_attempts += 1;
        }
        true
    }

    fn record_completion(&mut self, completion: DownloadCompletion<'input>) {
        self.active_attempts -= 1;
        self.reservations
            .retain(|reserved| reserved.id != completion.download.id);
        record_failure(&mut self.result, completion.finish());
    }
}

#[cfg(target_os = "linux")]
fn paired_inflater(pending: &VecDeque<PendingDownload<'_>>) -> Option<usize> {
    if pending.len() != 2 {
        return None;
    }
    let first = pending.front()?;
    let second = pending.back()?;
    let (artifact, companion) = if first.task.task.telemetry.is_artifact() {
        (first, second)
    } else {
        (second, first)
    };
    if !artifact.is_large_local_artifact() || companion.task.task.telemetry.is_artifact() {
        return None;
    }

    // A short companion can finish while the inflater and tar writer overlap.
    // Use the existing archive size estimate or bounded decoded input metadata.
    const COMPANION_BYTES: usize = 64 * 1024;
    const COMPANION_FILES: usize = 16;
    let small = match &companion.task.task.files {
        Some(files) => {
            files.len() <= COMPANION_FILES
                && files.iter().map(|file| file.content.len()).sum::<usize>() <= COMPANION_BYTES
        }
        None => (1..COMPANION_BYTES as u64).contains(&companion.estimated_work),
    };
    small.then_some(artifact.id)
}

/// Prepare download targets before any archive worker can start.
pub(crate) fn prepare_download_tasks(
    tasks: Vec<DownloadTask<'_>>,
) -> Result<Vec<PreparedDownloadTask<'_>>, DownloadError> {
    tasks.into_iter().map(DownloadTask::prepare).collect()
}

/// Download all prepared tasks in parallel using std::thread.
/// Allows additional overlap for remote header waits while keeping local-only
/// extraction bounded. Serializes logically or physically overlapping mounts.
pub(crate) fn download_all_parallel(
    tasks: Vec<PreparedDownloadTask<'_>>,
    readiness: Option<Readiness>,
) -> Result<(), ApplyFailure> {
    download_with_readiness(tasks, readiness, run_download_attempt)
}

#[cfg(test)]
fn download_all_parallel_with_runner(
    tasks: Vec<PreparedDownloadTask<'_>>,
    attempt_runner: AttemptRunner,
) -> bool {
    download_with_readiness(tasks, None, attempt_runner).is_ok()
}

fn download_concurrency(remote_count: usize, task_count: usize) -> usize {
    let limit = match remote_count {
        VERY_LARGE_REMOTE_BATCH.. => {
            // Three windows cover up to 120 independent remote requests.
            // Keep the existing ceiling for larger batches.
            remote_count.div_ceil(3).clamp(
                VERY_LARGE_REMOTE_CONCURRENT,
                VERY_LARGE_REMOTE_MAX_CONCURRENT,
            )
        }
        LARGE_REMOTE_BATCH.. => LARGE_REMOTE_CONCURRENT,
        // Fit up to 40 remote requests into two windows with a bounded increase.
        _ => remote_count
            .div_ceil(2)
            .clamp(BASE_REMOTE_CONCURRENT, MEDIUM_REMOTE_MAX_CONCURRENT),
    };
    remote_count.clamp(LOCAL_CONCURRENT, limit).min(task_count)
}

#[cfg(target_os = "linux")]
fn single_inline_artifact<'input>(tasks: &[PreparedDownloadTask<'input>]) -> Option<&'input [u8]> {
    let mut artifact = None;
    for prepared in tasks {
        let task = &prepared.task;
        let archive = task.inline_archive?;
        if !task.telemetry.is_artifact() {
            continue;
        }
        if artifact.is_some() || task.template_guidance.is_some() {
            return None;
        }
        artifact = Some(archive);
    }
    artifact
}

#[cfg(target_os = "linux")]
fn inline_companions_fit_budget(tasks: &[PreparedDownloadTask<'_>]) -> bool {
    // Several individually small archives can still compete for write time.
    tasks
        .iter()
        .map(|prepared| &prepared.task)
        .filter(|task| !task.telemetry.is_artifact())
        .try_fold(0, |total, task| {
            let expanded = archive::inflate::small_companion_expanded_bytes(task.inline_archive?)?;
            let total = total + expanded;
            (total <= MAX_INLINE_COMPANION_EXPANDED_BYTES).then_some(total)
        })
        .is_some()
}

#[cfg(target_os = "linux")]
fn inline_batch_prefers_two_workers(tasks: &[PreparedDownloadTask<'_>]) -> bool {
    let Some(artifact) = single_inline_artifact(tasks) else {
        return false;
    };
    archive::inflate::inline_artifact_size_is_eligible(artifact)
        && rustix::thread::sched_getaffinity(None).is_ok_and(|cpus| cpus.count() == 2)
        && inline_companions_fit_budget(tasks)
        && archive::inflate::has_small_inline_file_prefix(artifact)
}

fn download_with_readiness(
    mut tasks: Vec<PreparedDownloadTask<'_>>,
    readiness: Option<Readiness>,
    attempt_runner: AttemptRunner,
) -> Result<(), ApplyFailure> {
    if let Some(readiness) = &readiness {
        for task in &mut tasks {
            task.source_ready = readiness.gate(&task.task.url);
        }
    }
    // Remote requests spend time waiting for headers before extraction can
    // start. Grow only for actual remote work; decoded HTTP-origin inputs and
    // file archives retain the smaller CPU-bound worker budget.
    let remote_count = tasks
        .iter()
        .filter(|task| task.task.telemetry.is_remote())
        .count();
    let local_only = remote_count == 0;
    let allow_artifact_priority = local_only && readiness.is_none();
    let concurrency = download_concurrency(remote_count, tasks.len());
    // Two ready writers help an isolated dense Artifact on a two-CPU Guest.
    // Other substantial writes in the batch benefit from the existing budget.
    #[cfg(target_os = "linux")]
    let concurrency = if allow_artifact_priority
        && (MIN_INLINE_ARTIFACT_BATCH_TASKS..WIDE_LOCAL_INFLATE_TASKS).contains(&tasks.len())
        && inline_batch_prefers_two_workers(&tasks)
    {
        2
    } else {
        concurrency
    };
    // Local archives compete for CPU. Prefer longer ready work while active
    // reservations protect logical and resolved targets.
    let pending = tasks
        .into_iter()
        .enumerate()
        .map(|(sequence, task)| {
            let estimated_work = if local_only && task.task.files.is_none() {
                task.task.inline_archive.map_or_else(
                    || {
                        task.task
                            .local_archive_path()
                            .and_then(|path| fs::metadata(path).ok())
                            .filter(|metadata| metadata.is_file())
                            .map_or(0, |metadata| metadata.len())
                    },
                    |archive| archive.len() as u64,
                )
            } else {
                0
            };
            let mut pending = PendingDownload::new(sequence, task);
            pending.estimated_work = estimated_work;
            pending
        })
        .collect::<VecDeque<_>>();
    let mut telemetry = DownloadRunTelemetry::start(pending.iter().map(|download| {
        (
            download.task.task.telemetry,
            download.task.logical_mount_path(),
        )
    }));
    if pending.is_empty() {
        telemetry.finish();
        return Ok(());
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        pending.len(),
        concurrency
    );

    if readiness.is_none() && decoded::can_dispatch(&pending) {
        let result = decoded::download(pending, concurrency, attempt_runner);
        telemetry.finish();
        return result;
    }

    let success = thread::scope(|scope| {
        // The readiness watcher owns a 'static notification callback. Keep its
        // wakeups separate from completion values that borrow this input and
        // remain inside the scoped application lifetime.
        let (event_tx, event_rx) = mpsc::channel();
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut watcher = match readiness
            .map(|readiness| {
                let event_tx = event_tx.clone();
                readiness.watch(move |event| {
                    let _ = event_tx.send(DownloadEvent::SourceReadiness(event));
                })
            })
            .transpose()
        {
            Ok(watcher) => watcher,
            Err(error) => {
                log_error!(LOG_TAG, "Archive readiness startup failed: {error}");
                return Err(ApplyFailure::Failed);
            }
        };
        // Admission counts queued and running attempts together, so this queue
        // cannot add work beyond the selected bound. The sender is
        // local to this scope's closure: every return closes it before joining.
        let (work_tx, work_rx) = mpsc::sync_channel::<StartedDownload<'_>>(concurrency);
        let work_rx = Arc::new(Mutex::new(work_rx));
        for _ in 0..concurrency {
            let work_rx = Arc::clone(&work_rx);
            let completion_tx = completion_tx.clone();
            let event_tx = event_tx.clone();
            scope.spawn(move || {
                loop {
                    // Only receiving is serialized; extraction and panic
                    // handling never hold the receiver lock.
                    let work = match work_rx.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => {
                            log_error!(LOG_TAG, "Download worker receiver lock poisoned");
                            break;
                        }
                    };
                    let Ok(download) = work else {
                        break;
                    };
                    let _ = completion_tx.send(download.attempt(attempt_runner));
                    let _ = event_tx.send(DownloadEvent::Completed);
                }
            });
        }
        drop(work_rx);
        drop(completion_tx);
        drop(event_tx);
        let mut scheduler = DownloadScheduler::new(pending, concurrency, allow_artifact_priority);

        while scheduler.has_work() {
            if !scheduler.start_ready_attempts(&work_tx, &mut telemetry) {
                return Err(ApplyFailure::Failed);
            }

            if !scheduler.can_make_progress() && watcher.is_none() {
                log_error!(LOG_TAG, "Download scheduler cannot make progress");
                return Err(ApplyFailure::Failed);
            }

            let completion = match event_rx.recv() {
                Ok(DownloadEvent::Completed) => match completion_rx.recv() {
                    Ok(completion) => completion,
                    Err(error) => {
                        log_error!(LOG_TAG, "Download completion channel closed: {error}");
                        return Err(ApplyFailure::Failed);
                    }
                },
                Ok(DownloadEvent::SourceReadiness(Ok(()))) => continue,
                Ok(DownloadEvent::SourceReadiness(Err(error))) => {
                    log_error!(LOG_TAG, "Archive readiness failed: {error}");
                    return Err(ApplyFailure::Failed);
                }
                Err(e) => {
                    log_error!(LOG_TAG, "Download scheduler failed: {e}");
                    return Err(ApplyFailure::Failed);
                }
            };
            scheduler.record_completion(completion);
        }

        let sources_finished = watcher.as_mut().map(|watcher| watcher.finish()).transpose();
        if let Err(error) = sources_finished {
            log_error!(LOG_TAG, "Archive readiness completion failed: {error}");
            return Err(ApplyFailure::Failed);
        }
        scheduler.result
    });
    telemetry.finish();
    success
}

fn find_startable_download(
    pending: &VecDeque<PendingDownload<'_>>,
    reservations: &[DownloadReservation],
    selection: DownloadSelection,
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) -> Option<(usize, usize)> {
    // Only active reservations restrict the order of ready downloads.
    let mut selected: Option<(usize, usize, u64)> = None;
    for (index, download) in pending.iter().enumerate() {
        let work = match selection {
            DownloadSelection::Largest => download.estimated_work,
            DownloadSelection::LargeArtifact if download.is_large_local_artifact() => {
                download.estimated_work
            }
            _ => 0,
        };
        // Ties retain FIFO. Unknown/decoded work cannot trigger repeated path
        // scans once a startable choice with an equal or larger hint exists.
        if selected
            .as_ref()
            .is_some_and(|(_, _, selected_work)| work <= *selected_work)
        {
            continue;
        }
        if download
            .task
            .source_ready
            .as_ref()
            .is_some_and(|gate| !gate.load(Ordering::Acquire))
        {
            continue;
        }
        if let Some((blocking, pending_path, reserved_path)) =
            reservations.iter().find_map(|reservation| {
                conflicting_mount_paths(
                    &download.task,
                    &reservation.logical_mount_path,
                    &reservation.effective_mount_path,
                )
                .map(|(pending_path, reserved_path)| (reservation, pending_path, reserved_path))
            })
        {
            on_conflict(download.id, pending_path, blocking.id, reserved_path);
            continue;
        }

        if selection == DownloadSelection::Fifo {
            return Some((index, download.id));
        }
        selected = Some((index, download.id, work));
    }

    selected.map(|(index, id, _)| (index, id))
}

fn conflicting_mount_paths<'pending, 'other>(
    pending: &'pending PreparedDownloadTask<'_>,
    other_logical: &'other Path,
    other_effective: &'other Path,
) -> Option<(&'pending Path, &'other Path)> {
    if mount_paths_conflict(pending.logical_mount_path(), other_logical) {
        return Some((pending.logical_mount_path(), other_logical));
    }
    if mount_paths_conflict(pending.effective_mount_path(), other_effective) {
        return Some((pending.effective_mount_path(), other_effective));
    }
    None
}

fn mount_paths_conflict(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|msg| (*msg).to_owned()))
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Download and extract one archive. Files written before an error remain in place.
fn run_download_attempt(download: &mut StartedDownload<'_>) -> Result<(), DownloadError> {
    if let Some(files) = &download.task.task.files {
        if download.task.task.template_guidance.is_some() {
            return Err(DownloadError::new(
                "Template guidance requires a verified archive",
            ));
        }
        return crate::files::materialize(
            files,
            download.task.effective_mount_path(),
            download.concurrency,
        )
        .map_err(|error| DownloadError::writing_target("Decoded storage write failed", error));
    }
    download_and_extract(download)
}

fn download_and_extract(download: &mut StartedDownload<'_>) -> Result<(), DownloadError> {
    let task = &download.task.task;
    let target_path = download.task.effective_mount_path();
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::writing_target(
            format!("Failed to create directory {}", target_path.display()),
            e,
        )
    })?;

    let attempt_metrics = download
        .remote_metrics
        .is_some()
        .then(source::RemoteArchiveAttemptMetrics::default);
    let local_attempt_metrics = download
        .local_metrics
        .is_some()
        .then(source::LocalArchiveAttemptMetrics::default);
    #[cfg(target_os = "linux")]
    if let Some(load) = download.inflate_load
        && task.telemetry.is_artifact()
        && task.template_guidance.is_none()
        && let Some(path) = task.url.strip_prefix("file://")
    {
        let metrics = local_attempt_metrics.as_ref();
        let (result, extract_wall) = if let Some(bytes) = task.inline_archive {
            download.opened_file_compressed_bytes = Some(bytes.len() as u64);
            let extract_start = Instant::now();
            let result = archive::inflate::extract_inline(
                bytes,
                target_path,
                metrics,
                download.concurrency,
                load,
            );
            (result, extract_start.elapsed())
        } else {
            let archive = source::LocalArchive::open(path)?;
            download.opened_file_compressed_bytes = archive.compressed_bytes;
            let extract_start = Instant::now();
            let result = archive::inflate::extract_staged(
                archive,
                target_path,
                metrics,
                download.concurrency,
                load,
            );
            (result, extract_start.elapsed())
        };
        if let (Some(metrics), Some(attempt)) =
            (&mut download.local_metrics, &local_attempt_metrics)
        {
            metrics.record_extraction(attempt.body_read(), extract_wall);
        }
        return result;
    }

    let source = match task.inline_archive {
        Some(archive) => Ok(source::ArchiveSource::inline(archive)),
        None => source::open_archive(
            &task.url,
            attempt_metrics.as_ref(),
            local_attempt_metrics.as_ref(),
        ),
    };
    let reader = match source {
        Ok(reader) => reader,
        Err(error) => {
            if let (Some(metrics), Some(attempt_metrics)) =
                (&mut download.remote_metrics, &attempt_metrics)
            {
                metrics.record_attempt(attempt_metrics.snapshot(), Duration::ZERO);
            }
            return Err(error);
        }
    };
    download.opened_file_compressed_bytes = reader.compressed_bytes();
    let extract_start = Instant::now();
    let result = match &task.template_guidance {
        Some(reference) => {
            crate::template_guidance::extract(reader, target_path, download.concurrency, reference)
        }
        None => archive::extract_tar_gz(reader, target_path, download.concurrency),
    };
    let extract_wall = extract_start.elapsed();
    if let (Some(metrics), Some(attempt_metrics)) = (&mut download.remote_metrics, &attempt_metrics)
    {
        metrics.record_attempt(attempt_metrics.snapshot(), extract_wall);
    }
    if let (Some(metrics), Some(attempt_metrics)) =
        (&mut download.local_metrics, &local_attempt_metrics)
    {
        metrics.record_extraction(attempt_metrics.body_read(), extract_wall);
    }
    result
}

#[cfg(test)]
mod tests;
