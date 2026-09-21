use clap::{Args, Subcommand};
use serde::Serialize;

use crate::byte_size::human_bytes;
use crate::error::{RunnerError, RunnerResult};
use crate::paths::{HomePaths, RunnerPaths};
use crate::workspace_image_cache::{
    CacheBudget, FsStats, WorkspaceImageCache, WorkspaceImageCacheInspection,
    WorkspaceImageCacheInspectionEntry, WorkspaceImageCacheInspectionStatus,
    WorkspaceImageCacheInspectionSummary,
};

#[derive(Args)]
pub struct WorkspaceImageCacheArgs {
    #[command(subcommand)]
    command: WorkspaceImageCacheCommand,
}

#[derive(Subcommand)]
enum WorkspaceImageCacheCommand {
    /// Show a non-blocking, best-effort workspace image cache summary
    ///
    /// Locked entries skip metadata, image-size, temporary-path, storage, and
    /// artifact inspection. When any entries are locked, status-category,
    /// temporary-path, and size values are lower bounds.
    Info(WorkspaceImageCacheInfoArgs),
    /// List entries from a non-blocking, best-effort cache snapshot
    ///
    /// Locked entries skip metadata, image-size, temporary-path, storage, and
    /// artifact inspection. In JSON, zero measurements and null metadata fields
    /// on locked entries mean unavailable rather than measured zero.
    /// Status-category, temporary-path, and size summary values are lower bounds
    /// when `lockedEntries` is greater than zero.
    List(WorkspaceImageCacheListArgs),
    /// Clean up workspace image cache entries.
    ///
    /// The first phase removes stale, unusable, and temporary cache contents before evaluating
    /// capacity. It may also evict valid reusable entries, oldest-first, when the cache exceeds
    /// its maximum byte budget, filesystem free space falls below the minimum, or the cache
    /// exceeds the 1,024-entry cap. When budget pressure triggers eviction, it continues until
    /// the post-GC target and minimum-free-space thresholds are met. Locked entries are skipped
    /// during reusable-entry eviction, and candidates are revalidated before deletion. Use
    /// `--dry-run` to evaluate this same policy and report prospective cleanup without deleting
    /// data.
    Gc(WorkspaceImageCacheGcArgs),
}

#[derive(Args)]
struct WorkspaceImageCacheInfoArgs {
    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct WorkspaceImageCacheListArgs {
    /// Limit the number of entries shown after sorting.
    #[arg(long)]
    limit: Option<usize>,
    /// Emit machine-readable JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct WorkspaceImageCacheGcArgs {
    /// Evaluate the same cleanup policy and report what would be deleted without deleting data.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceImageCacheInfoOutput {
    cache_dir: String,
    lock_dir: String,
    fs_stats: FsStats,
    budget: CacheBudget,
    summary: WorkspaceImageCacheInspectionSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceImageCacheListOutput {
    cache_dir: String,
    lock_dir: String,
    summary: WorkspaceImageCacheInspectionSummary,
    entries: Vec<WorkspaceImageCacheInspectionEntry>,
}

pub async fn run_workspace_image_cache(args: WorkspaceImageCacheArgs) -> RunnerResult<()> {
    let home = HomePaths::new()?;
    run_workspace_image_cache_with_home(args, &home).await
}

async fn run_workspace_image_cache_with_home(
    args: WorkspaceImageCacheArgs,
    home: &HomePaths,
) -> RunnerResult<()> {
    match args.command {
        WorkspaceImageCacheCommand::Info(info) => {
            let inspection = shared_cache(home).inspect().await?;
            if info.json {
                print_json(&info_output(&inspection))
            } else {
                print!("{}", format_info_text(&inspection));
                Ok(())
            }
        }
        WorkspaceImageCacheCommand::List(list) => {
            let inspection = shared_cache(home).inspect().await?;
            let output = list_output(inspection, list.limit);
            if list.json {
                print_json(&output)
            } else {
                print!("{}", format_list_text(&output));
                Ok(())
            }
        }
        WorkspaceImageCacheCommand::Gc(gc) => {
            let freed = shared_cache(home).gc(gc.dry_run).await?;
            let verb = if gc.dry_run {
                "would be freed"
            } else {
                "freed"
            };
            tracing::info!("workspace image cache: {freed} bytes {verb}");
            Ok(())
        }
    }
}

fn shared_cache(home: &HomePaths) -> WorkspaceImageCache {
    WorkspaceImageCache::shared(
        RunnerPaths::new(home.runners_dir().join("_cache-gc")),
        home,
        "",
    )
}

fn info_output(inspection: &WorkspaceImageCacheInspection) -> WorkspaceImageCacheInfoOutput {
    WorkspaceImageCacheInfoOutput {
        cache_dir: inspection.cache_dir.clone(),
        lock_dir: inspection.lock_dir.clone(),
        fs_stats: inspection.fs_stats,
        budget: inspection.budget,
        summary: inspection.summary.clone(),
    }
}

fn list_output(
    inspection: WorkspaceImageCacheInspection,
    limit: Option<usize>,
) -> WorkspaceImageCacheListOutput {
    let WorkspaceImageCacheInspection {
        cache_dir,
        lock_dir,
        summary,
        entries,
        ..
    } = inspection;
    let mut entries = entries;
    entries.sort_by(|left, right| {
        status_rank(left.status)
            .cmp(&status_rank(right.status))
            .then_with(|| right.last_used_at.cmp(&left.last_used_at))
            .then_with(|| left.cache_key.cmp(&right.cache_key))
    });
    if let Some(limit) = limit {
        entries.truncate(limit);
    }
    WorkspaceImageCacheListOutput {
        cache_dir,
        lock_dir,
        summary,
        entries,
    }
}

fn print_json<T: Serialize>(value: &T) -> RunnerResult<()> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| RunnerError::Internal(format!("serialize workspace image cache JSON: {e}")))?;
    println!("{json}");
    Ok(())
}

fn format_info_text(inspection: &WorkspaceImageCacheInspection) -> String {
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
Workspace image cache
  Snapshot: non-blocking, best-effort
  Cache dir: {cache_dir}
  Lock dir: {lock_dir}
  Filesystem: total {fs_total}, available {fs_available}
  Budget: max {max_cache}, target after GC {target_after_gc}, min free {min_free}, max entry {max_entry}
  Entries: total {total}, reusable {reusable}, invalid {invalid}, stale {stale}, temporary-only {temporary}, locked {locked}
  Temporary paths: {temporary_paths} ({temporary_allocated})
  Size: allocated {allocated}, logical {logical}
{lower_bound_note}
List entries:
  runner workspace-image-cache list --limit 50

Preview cleanup:
  runner workspace-image-cache gc --dry-run
",
        cache_dir = inspection.cache_dir,
        lock_dir = inspection.lock_dir,
        fs_total = human_bytes(fs.total_bytes),
        fs_available = human_bytes(fs.available_bytes),
        max_cache = human_bytes(budget.max_cache_bytes),
        target_after_gc = human_bytes(budget.target_after_gc_bytes),
        min_free = human_bytes(budget.min_free_bytes),
        max_entry = human_bytes(budget.max_entry_bytes),
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
        lower_bound_note = lower_bound_note,
    )
}

fn format_list_text(output: &WorkspaceImageCacheListOutput) -> String {
    let mut text = format!(
        "Workspace image cache entries ({shown} shown, {total} total)\n  Snapshot: non-blocking, best-effort\n  Cache dir: {cache_dir}\n",
        shown = output.entries.len(),
        total = output.summary.total_entries,
        cache_dir = output.cache_dir,
    );
    if output.entries.is_empty() {
        if output.summary.total_entries == 0 {
            text.push_str("\nNo workspace image cache entries found.\n");
        } else {
            text.push_str("\nNo workspace image cache entries shown by current limit.\n");
        }
        return text;
    }
    for entry in &output.entries {
        text.push('\n');
        text.push_str(&format!(
            "{status} {key}\n",
            status = entry.status.as_str(),
            key = entry.cache_key,
        ));
        if entry.status == WorkspaceImageCacheInspectionStatus::Locked {
            text.push_str(
                "  Measurements unavailable: metadata, image size, temporary paths, storage, and artifacts were not inspected.\n",
            );
        } else {
            text.push_str(&format!(
                "  allocated={allocated} logical={logical} tempPaths={temp_paths} tempAllocated={temp_allocated} storages={storages} artifacts={artifacts}\n",
                allocated = human_bytes(entry.allocated_bytes),
                logical = human_bytes(entry.logical_image_size_bytes),
                temp_paths = entry.temporary_path_count,
                temp_allocated = human_bytes(entry.temporary_allocated_bytes),
                storages = entry.storage_count,
                artifacts = entry.artifact_count,
            ));
        }
        if let Some(reason) = &entry.reason {
            text.push_str(&format!("  reason={reason}\n"));
        }
        if entry.status == WorkspaceImageCacheInspectionStatus::Locked {
            continue;
        }
        text.push_str(&format!(
            "  scope={} profile={} workingDir={}\n",
            entry.cache_scope.as_deref().unwrap_or("-"),
            entry.profile_name.as_deref().unwrap_or("-"),
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

fn status_rank(status: WorkspaceImageCacheInspectionStatus) -> u8 {
    match status {
        WorkspaceImageCacheInspectionStatus::Locked => 0,
        WorkspaceImageCacheInspectionStatus::Invalid => 1,
        WorkspaceImageCacheInspectionStatus::Stale => 2,
        WorkspaceImageCacheInspectionStatus::TemporaryOnly => 3,
        WorkspaceImageCacheInspectionStatus::Reusable => 4,
    }
}

runner_test_group!(cmd_other; #[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::ids::RunId;
    use crate::paths::workspace_image_cache_key;
    use crate::workspace_image_cache::CacheEntryPaths;

    fn tmp_image_path(home: &HomePaths, cache_key: &str, run_id: RunId) -> PathBuf {
        CacheEntryPaths::new(&home.workspace_image_cache_dir(), cache_key).tmp_image(run_id)
    }

    fn test_inspection() -> WorkspaceImageCacheInspection {
        WorkspaceImageCacheInspection {
            cache_dir: "/var/lib/vm0-runner/workspace-image-cache".into(),
            lock_dir: "/var/lib/vm0-runner/locks".into(),
            fs_stats: FsStats {
                total_bytes: 1_000,
                available_bytes: 700,
            },
            budget: CacheBudget {
                max_cache_bytes: 500,
                target_after_gc_bytes: 375,
                min_free_bytes: 100,
                max_entry_bytes: 50,
            },
            summary: WorkspaceImageCacheInspectionSummary {
                total_entries: 2,
                reusable_entries: 1,
                invalid_entries: 1,
                stale_entries: 0,
                temporary_entries: 0,
                locked_entries: 0,
                temporary_paths: 1,
                total_allocated_bytes: 512,
                total_logical_image_bytes: 1024,
                temporary_allocated_bytes: 128,
            },
            entries: vec![
                WorkspaceImageCacheInspectionEntry {
                    cache_key: "b".repeat(64),
                    status: WorkspaceImageCacheInspectionStatus::Reusable,
                    reason: None,
                    cache_scope: Some("vm0/production".into()),
                    profile_name: Some("vm0/default".into()),
                    working_dir: Some("/home/user/workspace".into()),
                    last_completed_at: Some("2026-06-02T15:17:08.716Z".into()),
                    last_used_at: Some("2026-06-02T15:17:28.682Z".into()),
                    last_terminal_status: Some(
                        crate::workspace_image_cache::WorkspaceCacheTerminalStatus::Success,
                    ),
                    allocated_bytes: 256,
                    logical_image_size_bytes: 1024,
                    temporary_path_count: 1,
                    temporary_allocated_bytes: 128,
                    storage_count: 2,
                    artifact_count: 1,
                },
                WorkspaceImageCacheInspectionEntry {
                    cache_key: "a".repeat(64),
                    status: WorkspaceImageCacheInspectionStatus::Invalid,
                    reason: Some("missing metadata".into()),
                    cache_scope: None,
                    profile_name: None,
                    working_dir: None,
                    last_completed_at: None,
                    last_used_at: None,
                    last_terminal_status: None,
                    allocated_bytes: 128,
                    logical_image_size_bytes: 512,
                    temporary_path_count: 0,
                    temporary_allocated_bytes: 0,
                    storage_count: 0,
                    artifact_count: 0,
                },
            ],
        }
    }

    fn test_inspection_with_locked_entry() -> WorkspaceImageCacheInspection {
        let mut inspection = test_inspection();
        inspection.summary.total_entries += 1;
        inspection.summary.locked_entries = 1;
        inspection.entries.push(WorkspaceImageCacheInspectionEntry {
            cache_key: "c".repeat(64),
            status: WorkspaceImageCacheInspectionStatus::Locked,
            reason: Some("entry lock is held".into()),
            cache_scope: None,
            profile_name: None,
            working_dir: None,
            last_completed_at: None,
            last_used_at: None,
            last_terminal_status: None,
            allocated_bytes: 0,
            logical_image_size_bytes: 0,
            temporary_path_count: 0,
            temporary_allocated_bytes: 0,
            storage_count: 0,
            artifact_count: 0,
        });
        inspection
    }

    #[test]
    fn info_json_omits_entries() {
        let value = serde_json::to_value(info_output(&test_inspection())).unwrap();
        assert_eq!(
            value["cacheDir"],
            "/var/lib/vm0-runner/workspace-image-cache"
        );
        assert_eq!(value["summary"]["totalEntries"], 2);
        assert_eq!(value["summary"]["temporaryPaths"], 1);
        assert!(value["summary"].get("temporaryFiles").is_none());
        assert!(value.get("entries").is_none());
    }

    #[test]
    fn list_json_includes_limited_entries() {
        let output = list_output(test_inspection(), Some(1));
        let value = serde_json::to_value(&output).unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0]["status"], "invalid");
        assert_eq!(value["entries"][0]["reason"], "missing metadata");
        assert_eq!(value["entries"][0]["temporaryPathCount"], 0);
        assert!(value["entries"][0].get("temporaryFileCount").is_none());
        assert!(value["entries"][0].get("storageFingerprints").is_none());
    }

    #[test]
    fn list_json_preserves_locked_entry_placeholders() {
        let output = list_output(test_inspection_with_locked_entry(), Some(1));
        let value = serde_json::to_value(&output).unwrap();
        let entry = &value["entries"][0];
        assert_eq!(value["summary"]["lockedEntries"], 1);
        assert_eq!(entry["status"], "locked");
        assert_eq!(entry["reason"], "entry lock is held");
        assert_eq!(entry["allocatedBytes"], 0);
        assert_eq!(entry["logicalImageSizeBytes"], 0);
        assert_eq!(entry["temporaryPathCount"], 0);
        assert_eq!(entry["temporaryAllocatedBytes"], 0);
        assert_eq!(entry["storageCount"], 0);
        assert_eq!(entry["artifactCount"], 0);
        assert!(entry.get("cacheScope").unwrap().is_null());
        assert!(entry.get("profileName").unwrap().is_null());
        assert!(entry.get("workingDir").unwrap().is_null());
        assert!(entry.get("lastCompletedAt").unwrap().is_null());
        assert!(entry.get("lastUsedAt").unwrap().is_null());
        assert!(entry.get("lastTerminalStatus").unwrap().is_null());
    }

    #[test]
    fn text_info_contains_summary_and_next_actions() {
        let text = format_info_text(&test_inspection());
        assert!(text.contains("Workspace image cache"));
        assert!(text.contains("Snapshot: non-blocking, best-effort"));
        assert!(text.contains("Entries: total 2, reusable 1, invalid 1"));
        assert!(text.contains("Temporary paths: 1"));
        assert!(!text.contains("Lower bounds:"));
        assert!(text.contains("runner workspace-image-cache list --limit 50"));
        assert!(text.contains("runner workspace-image-cache gc --dry-run"));
    }

    #[test]
    fn text_info_marks_locked_entry_derived_values_as_lower_bounds() {
        let text = format_info_text(&test_inspection_with_locked_entry());
        assert!(text.contains("Entries: total 3, reusable 1, invalid 1"));
        assert!(text.contains("locked 1"));
        assert!(text.contains(
            "Lower bounds: status-category counts, temporary-path counts/bytes, and allocated/logical size totals exclude locked entry contents."
        ));
    }

    #[test]
    fn text_list_respects_limit_and_prioritizes_invalid_entries() {
        let text = format_list_text(&list_output(test_inspection(), Some(1)));
        assert!(text.contains("1 shown, 2 total"));
        assert!(text.contains("Snapshot: non-blocking, best-effort"));
        assert!(text.contains("invalid "));
        assert!(text.contains("tempPaths=0"));
        assert!(text.contains("reason=missing metadata"));
        assert!(!text.contains("reusable "));
    }

    #[test]
    fn text_list_marks_locked_measurements_unavailable() {
        let text = format_list_text(&list_output(test_inspection_with_locked_entry(), Some(1)));
        assert!(text.contains("1 shown, 3 total"));
        assert!(text.contains("locked "));
        assert!(text.contains(
            "Measurements unavailable: metadata, image size, temporary paths, storage, and artifacts were not inspected."
        ));
        assert!(text.contains("reason=entry lock is held"));
        assert!(!text.contains("allocated=0 B"));
        assert!(!text.contains("scope=-"));
    }

    #[test]
    fn text_list_distinguishes_empty_limit_from_empty_cache() {
        let limited = format_list_text(&list_output(test_inspection(), Some(0)));
        assert!(limited.contains("0 shown, 2 total"));
        assert!(limited.contains("No workspace image cache entries shown by current limit."));
        assert!(!limited.contains("No workspace image cache entries found."));

        let empty = WorkspaceImageCacheInspection {
            summary: WorkspaceImageCacheInspectionSummary::default(),
            entries: Vec::new(),
            ..test_inspection()
        };
        let text = format_list_text(&list_output(empty, None));
        assert!(text.contains("0 shown, 0 total"));
        assert!(text.contains("No workspace image cache entries found."));
    }

    #[tokio::test]
    async fn workspace_image_cache_gc_cleans_shared_cache_root() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let cache_key = workspace_image_cache_key("sess-1", "/workspace");
        let tmp = tmp_image_path(&home, &cache_key, RunId::new_v4());
        tokio::fs::create_dir_all(tmp.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&tmp, b"partial image").await.unwrap();

        run_workspace_image_cache_with_home(
            WorkspaceImageCacheArgs {
                command: WorkspaceImageCacheCommand::Gc(WorkspaceImageCacheGcArgs {
                    dry_run: false,
                }),
            },
            &home,
        )
        .await
        .unwrap();

        assert!(!tmp.exists());
    }

    #[tokio::test]
    async fn workspace_image_cache_gc_dry_run_preserves_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let cache_key = workspace_image_cache_key("sess-1", "/workspace");
        let tmp = tmp_image_path(&home, &cache_key, RunId::new_v4());
        tokio::fs::create_dir_all(tmp.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&tmp, b"partial image").await.unwrap();

        run_workspace_image_cache_with_home(
            WorkspaceImageCacheArgs {
                command: WorkspaceImageCacheCommand::Gc(WorkspaceImageCacheGcArgs {
                    dry_run: true,
                }),
            },
            &home,
        )
        .await
        .unwrap();

        assert!(tmp.exists());
    }
});
