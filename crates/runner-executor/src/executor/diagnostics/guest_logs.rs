use futures_util::future::join_all;
use sandbox::{CopyFileOptions, Sandbox};
use tracing::{info, warn};

use super::super::{DEFAULT_EXEC_TIMEOUT, GUEST_LOG_COPY_MAX_BYTES, guest_runtime_path};
use runner_host::paths::LogPaths;
use runner_types::types::ExecutionContext;

/// Copy guest log files to host (best-effort, post-job).
///
/// The final system log copy keeps `system-*` as the guest-authored log. The
/// supervised process stdout/stderr stream is written separately to
/// `system-stream-*` in real time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::executor) enum GuestLogCopyFailureKind {
    Failed,
    SkippedAfterCancellation,
}

pub(in crate::executor) fn guest_log_copy_failure_kind(cancelled: bool) -> GuestLogCopyFailureKind {
    if cancelled {
        GuestLogCopyFailureKind::SkippedAfterCancellation
    } else {
        GuestLogCopyFailureKind::Failed
    }
}

pub(in crate::executor) async fn copy_guest_logs(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    log_paths: &LogPaths,
    cancelled: bool,
) {
    let run_id = context.run_id;
    let files = match [
        guest_runtime_path(run_id, guest_contracts::runtime_paths::system_log_file)
            .map(|path| (path, log_paths.system_log(run_id))),
        guest_runtime_path(run_id, guest_contracts::runtime_paths::metrics_log_file)
            .map(|path| (path, log_paths.metrics_log(run_id))),
        guest_runtime_path(run_id, guest_contracts::runtime_paths::sandbox_ops_log_file)
            .map(|path| (path, log_paths.sandbox_ops_log(run_id))),
    ]
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    {
        Ok(files) => files,
        Err(e) => {
            warn!(run_id = %run_id, error = %e, "failed to resolve guest log paths");
            return;
        }
    };

    let files = files
        .into_iter()
        .filter(|(guest_path, host_path)| {
            if let Err(e) = runner_host::log_file::validate_copy_destination(host_path) {
                warn!(
                    run_id = %run_id,
                    error = %e,
                    guest_path = %guest_path,
                    host_path = %host_path.display(),
                    "skipping unsafe guest log destination"
                );
                return false;
            }
            true
        })
        .collect::<Vec<_>>();

    join_all(files.iter().map(|(guest_path, host_path)| async move {
        if let Err(e) = sandbox
            .copy_file(
                guest_path,
                host_path,
                CopyFileOptions {
                    max_bytes: GUEST_LOG_COPY_MAX_BYTES,
                    timeout: DEFAULT_EXEC_TIMEOUT,
                    missing_ok: true,
                },
            )
            .await
        {
            match guest_log_copy_failure_kind(cancelled) {
                GuestLogCopyFailureKind::SkippedAfterCancellation => {
                    info!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "guest log copy skipped after cancellation");
                }
                GuestLogCopyFailureKind::Failed => {
                    warn!(run_id = %run_id, error = %e, guest_path = %guest_path, host_path = %host_path.display(), "failed to copy guest log");
                }
            }
        }
    }))
    .await;
}
