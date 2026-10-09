use crate::error::RunnerResult;
use runner_host::paths::HomePaths;
use runner_storage::cache_gc::CacheGcLimits;

use super::GC_MIN_AGE;
use super::report::GcReport;

/// Best-effort archive-cache targets remain command policy, not Storage defaults.
const STORAGE_CACHE_MAX_BYTES: u64 = 1 << 30;
const STORAGE_CACHE_MAX_ENTRIES: u64 = 5_000;

fn storage_cache_limits() -> CacheGcLimits {
    CacheGcLimits {
        max_bytes: STORAGE_CACHE_MAX_BYTES,
        max_entries: STORAGE_CACHE_MAX_ENTRIES,
        min_age: GC_MIN_AGE,
    }
}

pub(super) async fn gc_storage_cache(home: &HomePaths, dry_run: bool) -> RunnerResult<GcReport> {
    let report =
        runner_storage::cache_gc::gc_storage_cache(home, storage_cache_limits(), dry_run).await?;
    Ok(GcReport::cleanup(report.activity_count, report.freed_bytes))
}

#[cfg(test)]
mod tests {
    use super::super::report::{log_gc_phase_summary, log_gc_summary};
    use super::super::test_support::{old_gc_time, set_mtime, test_home};
    use super::super::{GcOperations, RealGcOperations};
    use super::*;
    use crate::error::RunnerError;
    use std::path::PathBuf;
    use std::time::SystemTime;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::CapturedEvents;

    fn cache_entry(
        home: &HomePaths,
        version: &str,
        staging: bool,
        bytes: &[u8],
        mtime: SystemTime,
    ) -> PathBuf {
        let mut path = home.storage_cache_dir("adapter-cache", version);
        if staging {
            let final_name = path.file_name().unwrap().to_str().unwrap();
            path = path.with_file_name(format!("{final_name}.tmp"));
        }
        std::fs::create_dir_all(&path).unwrap();
        if !bytes.is_empty() {
            std::fs::write(path.join("archive.tar.gz"), bytes).unwrap();
        }
        set_mtime(&path, mtime);
        path
    }

    fn summary_messages(report: &GcReport, dry_run: bool) -> Vec<String> {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        log_gc_phase_summary("storage", report, dry_run);
        let mut total = GcReport::cleanup(2, 512);
        total += GcReport::cleanup(report.activity_count, report.freed_bytes);
        log_gc_summary(&total, dry_run);
        drop(guard);
        captured
            .entries()
            .into_iter()
            .filter_map(|event| event.fields.get("message").cloned())
            .collect()
    }

    #[tokio::test]
    async fn storage_gc_adapter_preserves_defaults_grace_dry_run_and_zero_byte_activity() {
        let limits = storage_cache_limits();
        assert_eq!(limits.max_bytes, 1 << 30);
        assert_eq!(limits.max_entries, 5_000);
        assert_eq!(limits.min_age, std::time::Duration::from_secs(600));
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let old = cache_entry(&home, "old-staging", true, &[], old_gc_time());
        let fresh = cache_entry(&home, "fresh-staging", true, &[], SystemTime::now());
        let mut operations = RealGcOperations;
        let dry = operations.gc_storage_cache(&home, true).await.unwrap();
        assert_eq!(dry, GcReport::cleanup(1, 0));
        assert!(
            !dry.is_empty(),
            "zero allocated bytes still represent cleanup activity"
        );
        assert!(old.exists() && fresh.exists());
        let real = operations.gc_storage_cache(&home, false).await.unwrap();
        assert_eq!(real, dry);
        assert!(!old.exists() && fresh.exists());
        assert!(
            summary_messages(&real, false)
                .contains(&"gc storage complete: cleaned=1, freed=0 B".to_owned())
        );
        assert!(
            summary_messages(&dry, true)
                .contains(&"gc storage complete: would_clean=1, would_free=0 B".to_owned())
        );

        // Empty completed versions exercise the real command's cardinality target.
        for index in 0..=STORAGE_CACHE_MAX_ENTRIES {
            cache_entry(
                &home,
                &format!("version-{index}"),
                false,
                &[],
                old_gc_time(),
            );
        }
        let dry = operations.gc_storage_cache(&home, true).await.unwrap();
        assert_eq!(dry, GcReport::cleanup(1, 0));
        let real = operations.gc_storage_cache(&home, false).await.unwrap();
        assert_eq!(real, dry);
        assert_eq!(
            operations.gc_storage_cache(&home, false).await.unwrap(),
            GcReport::default()
        );
        assert!(fresh.exists());
    }

    #[tokio::test]
    async fn storage_gc_adapter_preserves_byte_activity_phase_and_total_reports() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        let old = cache_entry(&home, "allocated-staging", true, &[7; 4096], old_gc_time());
        let bytes = runner_host::gc::collect_dir_stats(&old).await.size;
        assert!(bytes > 0);
        let mut operations = RealGcOperations;
        let dry = operations.gc_storage_cache(&home, true).await.unwrap();
        assert_eq!(dry, GcReport::cleanup(1, bytes));
        assert!(old.exists());
        let real = operations.gc_storage_cache(&home, false).await.unwrap();
        assert_eq!(real, dry);
        assert!(!old.exists());
        let human = runner_host::byte_size::human_bytes(bytes);
        let total = runner_host::byte_size::human_bytes(bytes + 512);
        assert_eq!(
            summary_messages(&real, false),
            vec![
                format!("gc storage complete: cleaned=1, freed={human}"),
                format!("total: cleaned=3, freed={total}"),
            ]
        );
        assert_eq!(
            summary_messages(&dry, true),
            vec![
                format!("gc storage complete: would_clean=1, would_free={human}"),
                format!("total: would_clean=3, would_free={total}"),
            ]
        );
    }

    #[tokio::test]
    async fn storage_gc_adapter_preserves_internal_read_error_category_and_display() {
        let dir = tempfile::tempdir().unwrap();
        let home = test_home(dir.path());
        std::fs::create_dir_all(home.storages_dir().parent().unwrap()).unwrap();
        std::fs::write(home.storages_dir(), b"not a directory").unwrap();
        let io_error = std::fs::read_dir(home.storages_dir()).unwrap_err();
        let expected = format!("read {}: {io_error}", home.storages_dir().display());
        let mut operations = RealGcOperations;
        let error = operations.gc_storage_cache(&home, false).await.unwrap_err();
        assert!(matches!(&error, RunnerError::Internal(message) if message == &expected));
        assert_eq!(
            error.to_string(),
            RunnerError::Internal(expected).to_string()
        );
        assert_eq!(
            std::fs::read(home.storages_dir()).unwrap(),
            b"not a directory"
        );
    }
}
