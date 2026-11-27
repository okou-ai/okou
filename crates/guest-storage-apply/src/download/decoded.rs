//! Dispatch independent decoded tasks within one prepared application batch.

use super::{
    ApplyFailure, AttemptRunner, LOG_TAG, PendingDownload, StartedDownload, record_failure,
};
use guest_contracts::storage_files::conflicting_mounts;
use guest_telemetry::log_error;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::thread;

const MIN_DECODED_MOUNTS: usize = 16;

pub(super) fn can_dispatch(pending: &VecDeque<PendingDownload<'_>>) -> bool {
    // Equal logical and resolved targets let one overlap check prove both
    // ownership views. The general scheduler owns aliased paths.
    pending.len() >= MIN_DECODED_MOUNTS
        && pending.iter().all(|download| {
            let task = &download.task;
            task.task.files.is_some() && task.logical_mount_path() == task.effective_mount_path()
        })
        && conflicting_mounts(
            pending
                .iter()
                .map(|download| download.task.task.mount_path()),
        )
        .is_empty()
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
                            log_error!(LOG_TAG, "Decoded download queue lock poisoned");
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
