use clap::{Args, Subcommand};
use serde::Serialize;

use crate::error::{RunnerError, RunnerResult};
use crate::home_image_cache::{
    CacheBudget, FsStats, HomeCachePressureThresholds, HomeImageCache, HomeImageCacheInspection,
    HomeImageCacheInspectionEntry, HomeImageCacheInspectionStatus, HomeImageCacheInspectionSummary,
};
use runner_host::byte_size::human_bytes;
use runner_host::paths::{HomePaths, RunnerPaths};

#[derive(Args)]
pub struct HomeImageCacheArgs {
    #[command(subcommand)]
    command: HomeImageCacheCommand,
}

#[derive(Subcommand)]
enum HomeImageCacheCommand {
    /// Show a non-blocking, best-effort home image cache summary
    ///
    /// Locked entries skip metadata, image-size, temporary-path, storage, and
    /// artifact inspection. When any entries are locked, status-category,
    /// temporary-path, and size values are lower bounds.
    Info(HomeImageCacheInfoArgs),
    /// List entries from a non-blocking, best-effort cache snapshot
    ///
    /// Locked entries skip metadata, image-size, temporary-path, storage, and
    /// artifact inspection. In JSON, zero measurements and null metadata fields
    /// on locked entries mean unavailable rather than measured zero.
    /// Status-category, temporary-path, and size summary values are lower bounds
    /// when `lockedEntries` is greater than zero.
    List(HomeImageCacheListArgs),
    /// Clean up home image cache entries.
    ///
    /// The first phase removes stale, unusable, and temporary cache contents before evaluating
    /// capacity. It may evict valid entries, oldest-first, below the filesystem low-water mark
    /// toward its high-water mark, or to restore the independent 4,096-entry cap. Count-only
    /// cleanup does not activate a free-byte target. Actual free space controls recovery;
    /// deleting an open image does not imply its blocks were released. Locked entries are skipped
    /// during reusable-entry eviction, and candidates are revalidated before deletion. Use
    /// `--dry-run` to evaluate this same policy and report prospective cleanup without deleting
    /// data.
    Gc(HomeImageCacheGcArgs),
}

#[derive(Args)]
struct HomeImageCacheInfoArgs {
    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct HomeImageCacheListArgs {
    /// Limit the number of entries shown after sorting.
    #[arg(long)]
    limit: Option<usize>,
    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct HomeImageCacheGcArgs {
    /// API URL for optional sandbox operation reporting.
    #[arg(long, env = "OKOU_API_BACKEND_URL", hide_env_values = true)]
    api_url: Option<String>,
    /// Runner authentication for optional sandbox operation reporting.
    #[arg(long, env = "OKOU_RUNNER_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// Evaluate the same cleanup policy and report what would be deleted without deleting data.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeImageCacheInfoOutput {
    cache_dir: String,
    lock_dir: String,
    fs_stats: FsStats,
    budget: CacheBudget,
    pressure: HomeCachePressureThresholds,
    measurements_complete: bool,
    summary: HomeImageCacheInspectionSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeImageCacheListOutput {
    cache_dir: String,
    lock_dir: String,
    fs_stats: FsStats,
    budget: CacheBudget,
    pressure: HomeCachePressureThresholds,
    measurements_complete: bool,
    entries_complete: bool,
    summary: HomeImageCacheInspectionSummary,
    entries: Vec<HomeImageCacheInspectionEntry>,
}

pub async fn run_home_image_cache(args: HomeImageCacheArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    run_home_image_cache_with_home(args, &home).await
}

async fn run_home_image_cache_with_home(
    args: HomeImageCacheArgs,
    home: &HomePaths,
) -> RunnerResult<()> {
    match args.command {
        HomeImageCacheCommand::Info(info) => {
            let inspection = shared_cache(home).inspect().await?;
            if info.json {
                print_json(&info_output(&inspection))
            } else {
                print!("{}", format_info_text(&inspection));
                Ok(())
            }
        }
        HomeImageCacheCommand::List(list) => {
            let inspection = shared_cache(home).inspect().await?;
            let output = list_output(inspection, list.limit);
            if list.json {
                print_json(&output)
            } else {
                print!("{}", format_list_text(&output));
                Ok(())
            }
        }
        HomeImageCacheCommand::Gc(gc) => {
            let telemetry = match (gc.api_url, gc.token) {
                (Some(api_url), Some(token)) => {
                    match runner_provider::http::HttpClient::new(
                        runner_provider::http::HttpClientConfig {
                            api_url,
                            vercel_bypass: None,
                            client_session_id: uuid::Uuid::new_v4().to_string(),
                            runner_version: env!("CARGO_PKG_VERSION"),
                        },
                    ) {
                        Ok(http) => Some(runner_executor::telemetry::JobTelemetry::new_runner(
                            http, token, None,
                        )),
                        Err(error) => {
                            tracing::warn!(%error, "optional GC operation telemetry unavailable");
                            None
                        }
                    }
                }
                _ => None,
            };
            let mut cache = shared_cache(home);
            if let Some(telemetry) = &telemetry {
                cache = cache.with_telemetry(telemetry.reporter());
            }
            let result = cache.gc(gc.dry_run).await.map(|freed| {
                let verb = if gc.dry_run {
                    "would be freed"
                } else {
                    "freed"
                };
                tracing::info!("home image cache: {freed} bytes {verb}");
            });
            if let Some(telemetry) = telemetry {
                telemetry.flush().await;
            }
            result.map_err(Into::into)
        }
    }
}

fn shared_cache(home: &HomePaths) -> HomeImageCache {
    HomeImageCache::shared(
        RunnerPaths::new(home.runners_dir().join("_cache-gc")),
        home,
        "",
    )
}

fn info_output(inspection: &HomeImageCacheInspection) -> HomeImageCacheInfoOutput {
    HomeImageCacheInfoOutput {
        cache_dir: inspection.cache_dir.clone(),
        lock_dir: inspection.lock_dir.clone(),
        fs_stats: inspection.fs_stats,
        budget: inspection.budget,
        pressure: inspection.pressure,
        measurements_complete: inspection.summary.locked_entries == 0,
        summary: inspection.summary.clone(),
    }
}

fn list_output(
    inspection: HomeImageCacheInspection,
    limit: Option<usize>,
) -> HomeImageCacheListOutput {
    let HomeImageCacheInspection {
        cache_dir,
        lock_dir,
        fs_stats,
        budget,
        pressure,
        summary,
        entries,
    } = inspection;
    let mut entries = entries;
    entries.sort_by(|left, right| {
        status_rank(left.status)
            .cmp(&status_rank(right.status))
            .then_with(|| right.last_used_at.cmp(&left.last_used_at))
            .then_with(|| left.cache_key.cmp(&right.cache_key))
    });
    let observed_entries = entries.len();
    if let Some(limit) = limit {
        entries.truncate(limit);
    }
    HomeImageCacheListOutput {
        cache_dir,
        lock_dir,
        fs_stats,
        budget,
        pressure,
        measurements_complete: summary.locked_entries == 0,
        entries_complete: entries.len() == observed_entries,
        summary,
        entries,
    }
}

fn print_json<T: Serialize>(value: &T) -> RunnerResult<()> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| RunnerError::Internal(format!("serialize home image cache JSON: {e}")))?;
    println!("{json}");
    Ok(())
}

fn format_info_text(inspection: &HomeImageCacheInspection) -> String {
    let summary = &inspection.summary;
    let fs = inspection.fs_stats;
    let budget = inspection.budget;
    let lower_bound_note = if summary.locked_entries > 0 {
        "  Lower bounds: status-category counts, temporary-path counts/bytes, and allocated/logical size totals exclude locked entry contents.\n"
    } else {
        ""
    };
    format!(
        "\
Home image cache
  Snapshot: non-blocking, best-effort
  Cache dir: {cache_dir}
  Lock dir: {lock_dir}
  Filesystem: total {fs_total}, available {fs_available}
  Inodes: total {inode_total}, available {inode_available}
  Pressure: min free {min_free}, low {low_free}, high {high_free}, feasible {feasible}
  Legacy allocation projection: max {max_cache}, target after GC {target_after_gc}, complete {budget_complete}
  Entries: total {total}, reusable {reusable}, invalid {invalid}, stale {stale}, temporary-only {temporary}, locked {locked}
  Temporary paths: {temporary_paths} ({temporary_allocated})
  Size: allocated {allocated}, logical {logical}
  Scope: retained cache and staging only; excludes active/idle home disks, rootfs COW and other host consumers.
  Sparse image logical size is not allocated usage; Guest unlink does not guarantee host block reclamation.
{lower_bound_note}
List entries:
  runner home-image-cache list --limit 50

Preview cleanup:
  runner home-image-cache gc --dry-run
",
        cache_dir = inspection.cache_dir,
        lock_dir = inspection.lock_dir,
        fs_total = human_bytes(fs.total_bytes),
        fs_available = human_bytes(fs.available_bytes),
        inode_total = fs.total_inodes,
        inode_available = fs.available_inodes,
        max_cache = human_bytes(budget.max_cache_bytes),
        target_after_gc = human_bytes(budget.target_after_gc_bytes),
        min_free = human_bytes(budget.min_free_bytes),
        low_free = human_bytes(inspection.pressure.low_free_bytes),
        high_free = human_bytes(inspection.pressure.high_free_bytes),
        feasible = inspection.pressure.reserve_feasible,
        budget_complete = budget.complete,
        total = summary.total_entries,
        reusable = summary.reusable_entries,
        invalid = summary.invalid_entries,
        stale = summary.stale_entries,
        temporary = summary.temporary_entries,
        locked = summary.locked_entries,
        temporary_paths = summary.temporary_paths,
        temporary_allocated = human_bytes(summary.temporary_allocated_bytes),
        allocated = human_bytes(summary.total_allocated_bytes),
        logical = human_bytes(summary.total_logical_image_bytes),
    )
}

fn format_list_text(output: &HomeImageCacheListOutput) -> String {
    let mut text = format!(
        "Home image cache entries ({shown} shown, {total} total)\n  Snapshot: non-blocking, best-effort\n  Cache dir: {cache_dir}\n",
        shown = output.entries.len(),
        total = output.summary.total_entries,
        cache_dir = output.cache_dir,
    );
    text.push_str(&format!("  Filesystem: available {} / {}; inodes available {} / {}\n  Measurements complete: {}; entries complete: {}\n  Scope: retained/staging allocation, not active/idle disks or rootfs COW.\n",
        human_bytes(output.fs_stats.available_bytes), human_bytes(output.fs_stats.total_bytes),
        output.fs_stats.available_inodes, output.fs_stats.total_inodes,
        output.measurements_complete, output.entries_complete));
    if output.entries.is_empty() {
        if output.summary.total_entries == 0 {
            text.push_str("\nNo home image cache entries found.\n");
        } else {
            text.push_str("\nNo home image cache entries shown by current limit.\n");
        }
        return text;
    }
    for entry in &output.entries {
        text.push('\n');
        text.push_str(&format!(
            "{status} {key}\n",
            status = entry.status.as_str(),
            key = entry.cache_key
        ));
        if entry.status == HomeImageCacheInspectionStatus::Locked {
            text.push_str("  Measurements unavailable: metadata, image size, temporary paths, storage, and artifacts were not inspected.\n");
        } else {
            text.push_str(&format!(
                "  allocated={allocated} logical={logical} tempPaths={temp_paths} tempAllocated={temp_allocated} storages={storages} artifacts={artifacts}\n",
                allocated = human_bytes(entry.allocated_bytes), logical = human_bytes(entry.logical_image_size_bytes),
                temp_paths = entry.temporary_path_count, temp_allocated = human_bytes(entry.temporary_allocated_bytes),
                storages = entry.storage_count, artifacts = entry.artifact_count,
            ));
        }
        if let Some(reason) = &entry.reason {
            text.push_str(&format!("  reason={reason}\n"));
        }
        if entry.status == HomeImageCacheInspectionStatus::Locked {
            continue;
        }
        text.push_str(&format!(
            "  scope={} profile={} rootfs={} workingDir={}\n",
            entry.cache_scope.as_deref().unwrap_or("-"),
            entry.profile_name.as_deref().unwrap_or("-"),
            entry.rootfs_hash.as_deref().unwrap_or("-"),
            entry.working_dir.as_deref().unwrap_or("-"),
        ));
        text.push_str(&format!(
            "  lastCompletedAt={} lastUsedAt={} terminalStatus={}\n",
            entry.last_completed_at.as_deref().unwrap_or("-"),
            entry.last_used_at.as_deref().unwrap_or("-"),
            entry
                .last_terminal_status
                .map(|status| status.as_str())
                .unwrap_or("-"),
        ));
    }
    text
}

fn status_rank(status: HomeImageCacheInspectionStatus) -> u8 {
    match status {
        HomeImageCacheInspectionStatus::Locked => 0,
        HomeImageCacheInspectionStatus::Invalid => 1,
        HomeImageCacheInspectionStatus::Stale => 2,
        HomeImageCacheInspectionStatus::TemporaryOnly => 3,
        HomeImageCacheInspectionStatus::Reusable => 4,
    }
}

#[cfg(test)]
mod tests;
