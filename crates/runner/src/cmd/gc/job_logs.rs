use std::os::unix::fs::MetadataExt;
use std::time::{Duration, SystemTime};

use tracing::{info, warn};

use crate::error::RunnerResult;
use runner_host::byte_size::human_bytes;
use runner_host::paths::{HomePaths, LogPaths};

use super::filesystem::{next_entry_warn_or_stop, read_dir_or_missing};
use super::report::GcReport;

/// Per-job log files older than this are eligible for GC.
const JOB_LOG_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// Delete stale log files (older than [`JOB_LOG_MAX_AGE`]).
///
/// Covers log names matched by [`LogPaths::is_gc_eligible_log`], including
/// per-job logs and runner instance logs.
/// Returns the successfully removed or predicted files and their freed bytes.
pub(super) async fn gc_job_logs(home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
    gc_job_logs_with_clock(home, dry_run, SystemTime::now).await
}

async fn gc_job_logs_with_clock(
    home: &HomePaths,
    dry_run: bool,
    clock: impl FnOnce() -> SystemTime,
) -> RunnerResult<GcReport> {
    let logs_dir = home.logs_dir();
    let Some(mut entries) = read_dir_or_missing(&logs_dir).await? else {
        return Ok(GcReport::default());
    };

    let now = clock();
    let mut removed = 0u64;
    let mut freed = 0u64;

    while let Some(entry) = next_entry_warn_or_stop(&mut entries, "gc_job_logs", &logs_dir).await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };

        if !LogPaths::is_gc_eligible_log(name) {
            continue;
        }

        let Ok(meta) = entry.metadata().await else {
            continue;
        };

        let age = meta
            .modified()
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .unwrap_or_default();

        if age <= JOB_LOG_MAX_AGE {
            continue;
        }

        let size = meta.blocks() * 512;
        if dry_run {
            info!(
                "[dry-run] would delete job log {name} ({})",
                human_bytes(size)
            );
        } else {
            match tokio::fs::remove_file(entry.path()).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warn!("cannot remove {}: {e}", entry.path().display());
                    continue;
                }
            }
        }
        removed += 1;
        freed += size;
    }

    Ok(GcReport::cleanup(removed, freed))
}

#[cfg(test)]
mod tests;
