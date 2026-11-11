use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::readiness::Readiness;
use crate::source;
use crate::telemetry::{
    DownloadRunTelemetry, DownloadTaskTelemetry, LocalArchiveTaskMetrics, RemoteArchiveTaskMetrics,
};
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

const LOCAL_CONCURRENT: usize = 4;
const MAX_CONCURRENT: usize = 16;
type AttemptRunner = fn(&mut StartedDownload) -> Result<(), DownloadError>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    url: String,
    mount_path: String,
    normalized_mount_path: PathBuf,
    telemetry: DownloadTaskTelemetry,
    files: Option<Vec<guest_contracts::storage_files::StorageFile>>,
    template_guidance: Option<guest_contracts::storage_manifest::TemplateGuidanceReference>,
}

impl DownloadTask {
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

    pub(crate) fn set_files(&mut self, files: Vec<guest_contracts::storage_files::StorageFile>) {
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
            template_guidance: None,
        }
    }

    fn prepare(self) -> Result<PreparedDownloadTask, String> {
        fs::create_dir_all(&self.mount_path).map_err(|e| {
            format!(
                "{} target preparation failed: failed to create directory {}: {e}",
                self.label, self.mount_path
            )
        })?;
        let effective_mount_path = Path::new(&self.mount_path).canonicalize().map_err(|e| {
            format!(
                "{} target preparation failed: failed to resolve directory {}: {e}",
                self.label, self.mount_path
            )
        })?;

        Ok(PreparedDownloadTask {
            task: self,
            effective_mount_path,
            source_ready: None,
        })
    }
}

pub(crate) struct PreparedDownloadTask {
    task: DownloadTask,
    effective_mount_path: PathBuf,
    source_ready: Option<Arc<AtomicBool>>,
}

impl PreparedDownloadTask {
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

struct PendingDownload {
    id: usize,
    task: PreparedDownloadTask,
    estimated_work: u64,
}

impl PendingDownload {
    fn new(id: usize, task: PreparedDownloadTask) -> Self {
        Self {
            id,
            task,
            estimated_work: 0,
        }
    }
}

struct StartedDownload {
    id: usize,
    task: PreparedDownloadTask,
    start: Instant,
    opened_file_compressed_bytes: Option<u64>,
    remote_metrics: Option<RemoteArchiveTaskMetrics>,
    local_metrics: Option<LocalArchiveTaskMetrics>,
    concurrency: usize,
}

impl StartedDownload {
    fn new(download: PendingDownload, concurrency: usize) -> Self {
        let start = Instant::now();
        log_info!(
            LOG_TAG,
            "Downloading {} to {}",
            download.task.task.label,
            download.task.task.mount_path
        );
        Self {
            id: download.id,
            remote_metrics: download.task.task.telemetry.remote_metrics(),
            local_metrics: download.task.task.telemetry.local_metrics(),
            task: download.task,
            start,
            opened_file_compressed_bytes: None,
            concurrency,
        }
    }

    fn finish(self, result: Result<(), DownloadError>) -> bool {
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
                log_info!(
                    LOG_TAG,
                    "{} downloaded in {}ms",
                    self.task.task.label,
                    elapsed.as_millis()
                );
                true
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
                false
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
    fn new(download: &StartedDownload) -> Self {
        Self {
            id: download.id,
            logical_mount_path: download.task.logical_mount_path().to_path_buf(),
            effective_mount_path: download.task.effective_mount_path().to_path_buf(),
        }
    }
}

struct DownloadCompletion {
    download: StartedDownload,
    outcome: AttemptOutcome,
}

enum DownloadEvent {
    Completed(Box<DownloadCompletion>),
    SourceReadiness(std::io::Result<()>),
}

enum AttemptOutcome {
    Finished(Result<(), DownloadError>),
    Panicked(String),
}

struct DownloadScheduler {
    pending: VecDeque<PendingDownload>,
    reservations: Vec<DownloadReservation>,
    active_attempts: usize,
    concurrency: usize,
    all_success: bool,
    prioritize_large: bool,
}

impl DownloadScheduler {
    fn new(pending: VecDeque<PendingDownload>, concurrency: usize) -> Self {
        let prioritize_large = pending.iter().any(|download| download.estimated_work > 0);
        Self {
            pending,
            reservations: Vec::new(),
            active_attempts: 0,
            concurrency,
            all_success: true,
            prioritize_large,
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
        work_tx: &mpsc::SyncSender<StartedDownload>,
        telemetry: &mut DownloadRunTelemetry,
    ) -> bool {
        while self.active_attempts < self.concurrency {
            let Some((index, _)) = find_startable_download(
                &self.pending,
                &self.reservations,
                self.prioritize_large,
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
            // Front-load one long ready archive, then retain FIFO so subsequent
            // CPU-heavy work does not crowd that task throughout its execution.
            if download.estimated_work > 0 {
                self.prioritize_large = false;
            }
            let download = StartedDownload::new(download, self.concurrency);
            self.reservations.push(DownloadReservation::new(&download));

            if work_tx.send(download).is_err() {
                log_error!(LOG_TAG, "Download scheduler worker channel closed");
                return false;
            }
            self.active_attempts += 1;
        }
        true
    }

    fn record_completion(&mut self, completion: DownloadCompletion) {
        self.active_attempts -= 1;

        match completion.outcome {
            AttemptOutcome::Finished(result) => {
                self.reservations
                    .retain(|reserved| reserved.id != completion.download.id);
                if !completion.download.finish(result) {
                    self.all_success = false;
                }
            }
            AttemptOutcome::Panicked(msg) => {
                self.reservations
                    .retain(|reserved| reserved.id != completion.download.id);
                log_error!(LOG_TAG, "Thread panicked: {msg}");
                self.all_success = false;
            }
        }
    }
}

/// Prepare download targets before any archive worker can start.
pub(crate) fn prepare_download_tasks(
    tasks: Vec<DownloadTask>,
) -> Result<Vec<PreparedDownloadTask>, String> {
    tasks.into_iter().map(DownloadTask::prepare).collect()
}

/// Download all prepared tasks in parallel using std::thread.
/// Allows additional overlap for remote header waits while keeping local-only
/// extraction bounded. Serializes logically or physically overlapping mounts.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(
    tasks: Vec<PreparedDownloadTask>,
    readiness: Option<Readiness>,
) -> bool {
    download_with_readiness(tasks, readiness, run_download_attempt)
}

#[cfg(test)]
fn download_all_parallel_with_runner(
    tasks: Vec<PreparedDownloadTask>,
    attempt_runner: AttemptRunner,
) -> bool {
    download_with_readiness(tasks, None, attempt_runner)
}

fn download_with_readiness(
    mut tasks: Vec<PreparedDownloadTask>,
    readiness: Option<Readiness>,
    attempt_runner: AttemptRunner,
) -> bool {
    if let Some(readiness) = &readiness {
        for task in &mut tasks {
            task.source_ready = readiness.gate(&task.task.url);
        }
    }
    // Remote requests spend time waiting for headers before extraction can
    // start. Grow only for actual remote work; decoded HTTP-origin inputs and
    // file archives retain the smaller CPU-bound worker budget.
    let concurrency = tasks
        .iter()
        .filter(|task| task.task.telemetry.is_remote())
        .count()
        .clamp(LOCAL_CONCURRENT, MAX_CONCURRENT)
        .min(tasks.len());
    // Local archives compete for CPU. Prefer longer ready work without changing
    // the original pending order used to enforce logical and physical ownership.
    let local_only = tasks.iter().all(|task| !task.task.telemetry.is_remote());
    let pending = tasks
        .into_iter()
        .enumerate()
        .map(|(sequence, task)| {
            let estimated_work = if local_only && task.task.files.is_none() {
                task.task
                    .url
                    .strip_prefix("file://")
                    .and_then(|path| fs::metadata(path).ok())
                    .filter(|metadata| metadata.is_file())
                    .map_or(0, |metadata| metadata.len())
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
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        pending.len(),
        concurrency
    );

    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut watcher = match readiness
            .map(|readiness| {
                let completion_tx = completion_tx.clone();
                readiness.watch(move |event| {
                    let _ = completion_tx.send(DownloadEvent::SourceReadiness(event));
                })
            })
            .transpose()
        {
            Ok(watcher) => watcher,
            Err(error) => {
                log_error!(LOG_TAG, "Archive readiness startup failed: {error}");
                return false;
            }
        };
        // Admission counts queued and running attempts together, so this queue
        // cannot add work beyond the selected bound. The sender is
        // local to this scope's closure: every return closes it before joining.
        let (work_tx, work_rx) = mpsc::sync_channel::<StartedDownload>(concurrency);
        let work_rx = Arc::new(Mutex::new(work_rx));
        for _ in 0..concurrency {
            let work_rx = Arc::clone(&work_rx);
            let completion_tx = completion_tx.clone();
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
                    let Ok(mut download) = work else {
                        break;
                    };
                    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        attempt_runner(&mut download)
                    }))
                    .map(AttemptOutcome::Finished)
                    .unwrap_or_else(|e| AttemptOutcome::Panicked(panic_message(e.as_ref())));
                    let _ = completion_tx.send(DownloadEvent::Completed(Box::new(
                        DownloadCompletion { download, outcome },
                    )));
                }
            });
        }
        drop(work_rx);
        drop(completion_tx);
        let mut scheduler = DownloadScheduler::new(pending, concurrency);

        while scheduler.has_work() {
            if !scheduler.start_ready_attempts(&work_tx, &mut telemetry) {
                return false;
            }

            if !scheduler.can_make_progress() && watcher.is_none() {
                log_error!(LOG_TAG, "Download scheduler cannot make progress");
                return false;
            }

            let completion = match completion_rx.recv() {
                Ok(DownloadEvent::Completed(completion)) => *completion,
                Ok(DownloadEvent::SourceReadiness(Ok(()))) => continue,
                Ok(DownloadEvent::SourceReadiness(Err(error))) => {
                    log_error!(LOG_TAG, "Archive readiness failed: {error}");
                    return false;
                }
                Err(e) => {
                    log_error!(LOG_TAG, "Download scheduler failed: {e}");
                    return false;
                }
            };
            scheduler.record_completion(completion);
        }

        let sources_finished = watcher.as_mut().map(|watcher| watcher.finish()).transpose();
        if let Err(error) = sources_finished {
            log_error!(LOG_TAG, "Archive readiness completion failed: {error}");
            return false;
        }
        scheduler.all_success
    });
    telemetry.finish();
    success
}

fn find_startable_download(
    pending: &VecDeque<PendingDownload>,
    reservations: &[DownloadReservation],
    prioritize_large: bool,
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) -> Option<(usize, usize)> {
    // Independent tasks may bypass blocked work, but conflicting tasks must
    // retain their order even when the earlier task has not started yet.
    let mut selected: Option<(usize, usize, u64)> = None;
    for (index, download) in pending.iter().enumerate() {
        // Ties retain FIFO. Unknown/decoded work cannot trigger repeated path
        // scans once a startable choice with an equal or larger hint exists.
        if selected
            .as_ref()
            .is_some_and(|(_, _, work)| download.estimated_work <= *work)
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

        if pending.iter().take(index).any(|earlier| {
            conflicting_mount_paths(
                &download.task,
                earlier.task.logical_mount_path(),
                earlier.task.effective_mount_path(),
            )
            .is_some()
        }) {
            continue;
        }

        if !prioritize_large {
            return Some((index, download.id));
        }
        selected = Some((index, download.id, download.estimated_work));
    }

    selected.map(|(index, id, _)| (index, id))
}

fn conflicting_mount_paths<'pending, 'other>(
    pending: &'pending PreparedDownloadTask,
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
fn run_download_attempt(download: &mut StartedDownload) -> Result<(), DownloadError> {
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
        .map_err(|error| DownloadError::new(format!("Decoded storage write failed: {error}")));
    }
    download_and_extract(
        &download.task.task.url,
        download.task.effective_mount_path(),
        &mut download.opened_file_compressed_bytes,
        download.remote_metrics.as_mut(),
        download.local_metrics.as_mut(),
        download.concurrency,
        download.task.task.template_guidance.as_ref(),
    )
}

fn download_and_extract(
    url: &str,
    target_path: &Path,
    opened_file_compressed_bytes: &mut Option<u64>,
    remote_metrics: Option<&mut RemoteArchiveTaskMetrics>,
    local_metrics: Option<&mut LocalArchiveTaskMetrics>,
    concurrency: usize,
    template_guidance: Option<&guest_contracts::storage_manifest::TemplateGuidanceReference>,
) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::new(format!(
            "Failed to create directory {}: {e}",
            target_path.display()
        ))
    })?;

    let attempt_metrics = remote_metrics
        .is_some()
        .then(source::RemoteArchiveAttemptMetrics::default);
    let local_attempt_metrics = local_metrics
        .is_some()
        .then(source::LocalArchiveAttemptMetrics::default);
    let reader = match source::open_archive(
        url,
        attempt_metrics.as_ref(),
        local_attempt_metrics.as_ref(),
    ) {
        Ok(reader) => reader,
        Err(error) => {
            if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
                metrics.record_attempt(attempt_metrics.snapshot(), Duration::ZERO);
            }
            return Err(error);
        }
    };
    *opened_file_compressed_bytes = reader.compressed_bytes();
    let extract_start = Instant::now();
    let result = match template_guidance {
        Some(reference) => {
            crate::template_guidance::extract(reader, target_path, concurrency, reference)
        }
        None => archive::extract_tar_gz(reader, target_path, concurrency),
    };
    let extract_wall = extract_start.elapsed();
    if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
        metrics.record_attempt(attempt_metrics.snapshot(), extract_wall);
    }
    if let (Some(metrics), Some(attempt_metrics)) = (local_metrics, &local_attempt_metrics) {
        metrics.record_extraction(attempt_metrics.body_read(), extract_wall);
    }
    result
}

#[cfg(test)]
mod tests;
