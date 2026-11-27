//! Dispatch independent ready tasks within one prepared application batch.

use super::{
    ApplyFailure, AttemptRunner, LOG_TAG, PendingDownload, StartedDownload, record_failure,
};
use guest_contracts::storage_files::conflicting_mounts;
use guest_telemetry::log_error;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::thread;

const MIN_DECODED_MOUNTS: usize = 16;

pub(super) fn can_dispatch_decoded(pending: &VecDeque<PendingDownload<'_>>) -> bool {
    pending.len() >= MIN_DECODED_MOUNTS
        && pending
            .iter()
            .all(|download| download.task.task.files.is_some())
        && targets_are_independent(pending)
}

pub(super) fn targets_are_independent(pending: &VecDeque<PendingDownload<'_>>) -> bool {
    // Equal logical and resolved targets let one overlap check prove both
    // ownership views. The general scheduler owns aliased paths.
    pending
        .iter()
        .all(|download| download.task.logical_mount_path() == download.task.effective_mount_path())
        && conflicting_mounts(
            pending
                .iter()
                .map(|download| download.task.task.mount_path()),
        )
        .is_empty()
}

#[cfg(target_os = "linux")]
pub(super) fn prioritize_inline_archives(pending: &mut VecDeque<PendingDownload<'_>>) {
    use super::{DownloadSelection, find_startable_download};

    // All targets are ready and independent. Retain the existing first-wave
    // order before the workers pull from the queue.
    let Some((index, _)) = find_startable_download(
        pending,
        &[],
        DownloadSelection::Largest,
        &mut |_, _, _, _| {},
    ) else {
        return;
    };
    let Some(largest) = pending.remove(index) else {
        return;
    };
    if !largest.is_large_local_artifact()
        && let Some((index, _)) = find_startable_download(
            pending,
            &[],
            DownloadSelection::LargeArtifact,
            &mut |_, _, _, _| {},
        )
        && let Some(artifact) = pending.remove(index)
    {
        pending.push_front(artifact);
    }
    pending.push_front(largest);
}

pub(super) fn download(
    pending: VecDeque<PendingDownload<'_>>,
    concurrency: usize,
    attempt_runner: AttemptRunner,
) -> Result<(), ApplyFailure> {
    let pending = Mutex::new(pending);
    thread::scope(|scope| {
        let mut workers = Vec::with_capacity(concurrency);
        for _ in 0..concurrency {
            workers.push(scope.spawn(|| {
                let mut result = Ok(());
                loop {
                    // Release the queue lock before creating or writing files.
                    let task = match pending.lock() {
                        Ok(mut queue) => queue.pop_front(),
                        Err(_) => {
                            log_error!(LOG_TAG, "Direct download queue lock poisoned");
                            return Err(ApplyFailure::Failed);
                        }
                    };
                    let Some(task) = task else { break };
                    let attempt = StartedDownload::new(
                        task,
                        concurrency,
                        #[cfg(target_os = "linux")]
                        None,
                    );
                    record_failure(&mut result, attempt.attempt(attempt_runner).finish());
                }
                result
            }));
        }
        let mut result = Ok(());
        for worker in workers {
            let outcome = worker
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            record_failure(&mut result, outcome);
        }
        result
    })
}
