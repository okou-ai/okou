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
mod tests;
