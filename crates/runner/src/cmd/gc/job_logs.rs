use std::os::unix::fs::MetadataExt;
use std::time::{Duration, SystemTime};

use tracing::{info, warn};

use crate::byte_size::human_bytes;
use crate::error::RunnerResult;
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
    let logs_dir = home.logs_dir();
    let Some(mut entries) = read_dir_or_missing(&logs_dir).await? else {
        return Ok(GcReport::default());
    };

    let now = SystemTime::now();
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
mod tests {
    use super::*;
    use crate::cmd::gc::test_support::test_home;

    #[tokio::test]
    async fn gc_job_logs_deletes_stale() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_file = logs_dir.join("network-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::open(&old_file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 1);
        assert!(!old_file.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_recent() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let recent = logs_dir.join("network-aabbccdd-1234-5678-9abc-def012345678.jsonl");
        std::fs::write(&recent, r#"{"timestamp":"2026-02-18T00:00:00"}"#).unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 0);
        assert!(recent.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_deletes_stale_runner_logs() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // Old runner log file — should be deleted.
        let runner_log = logs_dir.join("runner-default.2026-02-10.log");
        std::fs::write(&runner_log, "log content").unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
        std::fs::File::open(&runner_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 1);
        assert!(!runner_log.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_recent_runner_logs() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // Recent runner log — should be kept.
        let runner_log = logs_dir.join("runner-default.2026-03-19.log");
        std::fs::write(&runner_log, "log content").unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 0);
        assert!(runner_log.exists());
    }

    #[tokio::test]
    async fn gc_job_logs_keeps_at_boundary() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        // File just under 7 days old — should be kept (age <= MAX_AGE).
        // Subtract 1 second less than max age to avoid race between set_times and check.
        let boundary = logs_dir.join("network-11111111-1111-1111-1111-111111111111.jsonl");
        std::fs::write(&boundary, r#"{"timestamp":"2026-02-11T00:00:00"}"#).unwrap();
        let boundary_time = SystemTime::now() - JOB_LOG_MAX_AGE + Duration::from_secs(1);
        std::fs::File::open(&boundary)
            .unwrap()
            .set_times(FileTimes::new().set_modified(boundary_time))
            .unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 0);
        assert!(boundary.exists(), "file at max age should be kept");
    }
    #[tokio::test]
    async fn gc_job_logs_dry_run() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_file = logs_dir.join("network-00000000-0000-0000-0000-000000000001.jsonl");
        std::fs::write(&old_file, r#"{"timestamp":"2026-01-01T00:00:00"}"#).unwrap();
        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);
        std::fs::File::open(&old_file)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = gc_job_logs(&home, true).await.unwrap();
        assert_eq!(report.activity_count, 1);
        assert!(old_file.exists(), "dry-run should not delete");
    }

    #[tokio::test]
    async fn gc_job_logs_deletes_stale_system_metrics_and_sandbox_ops() {
        use std::fs::FileTimes;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let logs_dir = home.logs_dir();
        std::fs::create_dir_all(&logs_dir).unwrap();

        let old_time = SystemTime::now() - Duration::from_secs(8 * 24 * 3600);

        let system_log = logs_dir.join("system-550e8400-e29b-41d4-a716-446655440000.log");
        std::fs::write(&system_log, "log content").unwrap();
        std::fs::File::open(&system_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let metrics_log = logs_dir.join("metrics-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&metrics_log, "{}").unwrap();
        std::fs::File::open(&metrics_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let sandbox_ops_log =
            logs_dir.join("sandbox-ops-550e8400-e29b-41d4-a716-446655440000.jsonl");
        std::fs::write(&sandbox_ops_log, "{}").unwrap();
        std::fs::File::open(&sandbox_ops_log)
            .unwrap()
            .set_times(FileTimes::new().set_modified(old_time))
            .unwrap();

        let report = gc_job_logs(&home, false).await.unwrap();
        assert_eq!(report.activity_count, 3);
        assert!(!system_log.exists());
        assert!(!metrics_log.exists());
        assert!(!sandbox_ops_log.exists());
    }
}
