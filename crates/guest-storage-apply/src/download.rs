use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::path::normalize_path;
use crate::source;
use crate::telemetry::{DownloadRunTelemetry, DownloadTaskTelemetry, RemoteArchiveTaskMetrics};
use guest_telemetry::{log_error, log_info};
use std::any::Any;
use std::collections::VecDeque;
use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CONCURRENT: usize = 4;
type AttemptRunner = fn(&mut StartedDownload) -> Result<(), DownloadError>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    url: String,
    mount_path: String,
    normalized_mount_path: PathBuf,
    telemetry: DownloadTaskTelemetry,
    files: Option<Vec<guest_contracts::storage_files::StorageFile>>,
}

impl DownloadTask {
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
        })
    }
}

pub(crate) struct PreparedDownloadTask {
    task: DownloadTask,
    effective_mount_path: PathBuf,
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
}

impl PendingDownload {
    fn new(id: usize, task: PreparedDownloadTask) -> Self {
        Self { id, task }
    }
}

struct StartedDownload {
    id: usize,
    task: PreparedDownloadTask,
    start: Instant,
    opened_file_compressed_bytes: Option<u64>,
    remote_metrics: Option<RemoteArchiveTaskMetrics>,
}

impl StartedDownload {
    fn new(download: PendingDownload) -> Self {
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
            task: download.task,
            start,
            opened_file_compressed_bytes: None,
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

enum AttemptOutcome {
    Finished(Result<(), DownloadError>),
    Panicked(String),
}

struct DownloadScheduler {
    pending: VecDeque<PendingDownload>,
    reservations: Vec<DownloadReservation>,
    active_attempts: usize,
    all_success: bool,
}

impl DownloadScheduler {
    fn new(pending: VecDeque<PendingDownload>) -> Self {
        Self {
            pending,
            reservations: Vec::new(),
            active_attempts: 0,
            all_success: true,
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
        while self.active_attempts < MAX_CONCURRENT {
            let Some((index, _)) = find_startable_download(
                &self.pending,
                &self.reservations,
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
            let download = StartedDownload::new(download);
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
/// Limits active archive attempts to MAX_CONCURRENT and serializes logically or
/// physically overlapping mount paths in task order.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(tasks: Vec<PreparedDownloadTask>) -> bool {
    download_all_parallel_with_runner(tasks, run_download_attempt)
}

fn download_all_parallel_with_runner(
    tasks: Vec<PreparedDownloadTask>,
    attempt_runner: AttemptRunner,
) -> bool {
    let pending = tasks
        .into_iter()
        .enumerate()
        .map(|(sequence, task)| PendingDownload::new(sequence, task))
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
        MAX_CONCURRENT
    );

    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        // Admission counts queued and running attempts together, so this queue
        // cannot add work beyond the existing four-attempt bound. The sender is
        // local to this scope's closure: every return closes it before joining.
        let (work_tx, work_rx) = mpsc::sync_channel::<StartedDownload>(MAX_CONCURRENT);
        let work_rx = Arc::new(Mutex::new(work_rx));
        for _ in 0..pending.len().min(MAX_CONCURRENT) {
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
                    let _ = completion_tx.send(DownloadCompletion { download, outcome });
                }
            });
        }
        drop(work_rx);
        drop(completion_tx);
        let mut scheduler = DownloadScheduler::new(pending);

        while scheduler.has_work() {
            if !scheduler.start_ready_attempts(&work_tx, &mut telemetry) {
                return false;
            }

            if !scheduler.can_make_progress() {
                log_error!(LOG_TAG, "Download scheduler cannot make progress");
                return false;
            }

            let completion = match completion_rx.recv() {
                Ok(completion) => completion,
                Err(e) => {
                    log_error!(LOG_TAG, "Download scheduler failed: {e}");
                    return false;
                }
            };
            scheduler.record_completion(completion);
        }

        scheduler.all_success
    });
    telemetry.finish();
    success
}

fn find_startable_download(
    pending: &VecDeque<PendingDownload>,
    reservations: &[DownloadReservation],
    on_conflict: &mut impl FnMut(usize, &Path, usize, &Path),
) -> Option<(usize, usize)> {
    // Independent tasks may bypass blocked work, but conflicting tasks must
    // retain their order even when the earlier task has not started yet.
    for (index, download) in pending.iter().enumerate() {
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

        return Some((index, download.id));
    }

    None
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
        return crate::files::materialize(files, download.task.effective_mount_path()).map_err(
            |error| DownloadError::new(format!("Decoded storage write failed: {error}")),
        );
    }
    download_and_extract(
        &download.task.task.url,
        download.task.effective_mount_path(),
        &mut download.opened_file_compressed_bytes,
        download.remote_metrics.as_mut(),
    )
}

fn download_and_extract(
    url: &str,
    target_path: &Path,
    opened_file_compressed_bytes: &mut Option<u64>,
    remote_metrics: Option<&mut RemoteArchiveTaskMetrics>,
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
    let reader = match source::open_archive(url, attempt_metrics.as_ref()) {
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
    let result = archive::extract_tar_gz(reader, target_path);
    let extract_wall = extract_start.elapsed();
    if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
        metrics.record_attempt(attempt_metrics.snapshot(), extract_wall);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized_path(path: &str) -> PathBuf {
        normalize_path(Path::new(path))
    }

    fn task_at(path: &str) -> DownloadTask {
        DownloadTask::storage(
            format!("task {path}"),
            "file:///tmp/archive.tar.gz".to_owned(),
            path.to_owned(),
            false,
        )
    }

    fn prepared_task_at(path: &str) -> PreparedDownloadTask {
        PreparedDownloadTask {
            task: task_at(path),
            effective_mount_path: normalized_path(path),
        }
    }

    fn pending_at(id: usize, path: &str) -> PendingDownload {
        PendingDownload::new(id, prepared_task_at(path))
    }

    #[test]
    fn mount_paths_conflict_for_exact_and_parent_child_paths() {
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount"),
            &normalized_path("/tmp/mount")
        ));
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount"),
            &normalized_path("/tmp/mount/child")
        ));
        assert!(mount_paths_conflict(
            &normalized_path("/tmp/mount/child"),
            &normalized_path("/tmp/mount")
        ));
    }

    #[test]
    fn mount_paths_do_not_conflict_for_siblings_or_prefix_traps() {
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/mount-a"),
            &normalized_path("/tmp/mount-b")
        ));
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/foo/bar"),
            &normalized_path("/tmp/foo/barista")
        ));
    }

    #[test]
    fn mount_path_conflicts_use_lexical_normalization() {
        assert!(mount_paths_conflict(
            &normalized_path("/tmp//foo/./bar/baz/.."),
            &normalized_path("/tmp/foo/bar")
        ));
        assert!(!mount_paths_conflict(
            &normalized_path("/tmp/foo/bar/../barista"),
            &normalized_path("/tmp/foo/bar")
        ));
    }

    #[test]
    fn task_panic_releases_reservation_and_pending_tasks_finish() {
        guest_telemetry::log::clear_system_log_file();
        let directory = tempfile::tempdir().unwrap();

        fn runner(download: &mut StartedDownload) -> Result<(), DownloadError> {
            if download.task.task.url == "panic" {
                panic!("expected panic");
            }
            fs::write(
                download
                    .task
                    .effective_mount_path()
                    .join(&download.task.task.url),
                &download.task.task.url,
            )
            .map_err(|error| DownloadError::new(error.to_string()))
        }

        // All tasks conflict, so the panic must release its reservation before
        // any of the more-than-four remaining tasks can produce their files.
        let tasks = (0..10)
            .map(|index| PreparedDownloadTask {
                task: DownloadTask::storage(
                    format!("task-{index}"),
                    if index == 0 {
                        "panic".to_owned()
                    } else {
                        format!("file-{index}")
                    },
                    directory.path().to_str().unwrap().to_owned(),
                    false,
                ),
                effective_mount_path: directory.path().to_owned(),
            })
            .collect();
        let result = std::panic::catch_unwind(|| download_all_parallel_with_runner(tasks, runner));

        assert!(matches!(result, Ok(false)));
        for index in 1..10 {
            let name = format!("file-{index}");
            assert_eq!(
                fs::read_to_string(directory.path().join(&name)).unwrap(),
                name
            );
        }
    }

    #[test]
    fn find_startable_download_observes_conflict_and_selects_later_task() {
        let pending = VecDeque::from([
            pending_at(3, "/tmp/mount/child"),
            pending_at(4, "/tmp/other"),
        ]);
        let reservations = vec![DownloadReservation {
            id: 2,
            logical_mount_path: normalized_path("/tmp/mount"),
            effective_mount_path: normalized_path("/tmp/mount"),
        }];
        let mut conflicts = Vec::new();

        let selected = find_startable_download(
            &pending,
            &reservations,
            &mut |pending_id, _, active_id, _| {
                conflicts.push((pending_id, active_id));
            },
        );

        assert_eq!(conflicts, [(3, 2)]);
        assert_eq!(selected, Some((1, 4)));
    }

    #[test]
    fn find_startable_download_reports_first_active_conflict_on_each_scan() {
        let pending = VecDeque::from([pending_at(4, "/tmp/mount/child")]);
        let reservations = vec![
            DownloadReservation {
                id: 2,
                logical_mount_path: normalized_path("/tmp/mount"),
                effective_mount_path: normalized_path("/tmp/mount"),
            },
            DownloadReservation {
                id: 3,
                logical_mount_path: normalized_path("/tmp/mount/child"),
                effective_mount_path: normalized_path("/tmp/mount/child"),
            },
        ];
        let mut conflicts = Vec::new();

        for _ in 0..2 {
            let selected = find_startable_download(
                &pending,
                &reservations,
                &mut |pending_id, _, active_id, _| {
                    conflicts.push((pending_id, active_id));
                },
            );
            assert_eq!(selected, None);
        }

        assert_eq!(conflicts, [(4, 2), (4, 2)]);
    }

    #[test]
    fn download_task_failure_detail_includes_entry_metadata() {
        let task = DownloadTask::storage(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
            false,
        );
        let error = DownloadError::new("Failed to read archive entries: invalid gzip header");

        let detail = PreparedDownloadTask {
            task,
            effective_mount_path: PathBuf::from("/workspace"),
        }
        .failure_detail(&error);

        assert!(detail.contains("storage 1"));
        assert!(detail.contains("mountPath=/workspace"));
        assert!(detail.contains("vasStorageName=repo"));
        assert!(detail.contains("vasVersionId=v1"));
        assert!(detail.contains("urlScheme=file"));
        assert!(detail.contains("Failed to read archive entries"));
    }
}
