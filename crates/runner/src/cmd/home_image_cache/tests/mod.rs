use super::*;
use crate::home_image_cache::CacheEntryPaths;
use crate::test_fixtures::home_image_cache_key;
use runner_types::ids::RunId;
use std::path::PathBuf;

fn tmp_image_path(home: &HomePaths, cache_key: &str, run_id: RunId) -> PathBuf {
    CacheEntryPaths::new(&home.home_image_cache_dir(), cache_key).tmp_image(run_id)
}

fn test_inspection() -> HomeImageCacheInspection {
    HomeImageCacheInspection {
        cache_dir: "/var/lib/vm0-runner/home-image-cache".into(),
        lock_dir: "/var/lib/vm0-runner/locks".into(),
        fs_stats: FsStats {
            total_bytes: 1_000,
            available_bytes: 700,
            total_inodes: 100,
            available_inodes: 70,
        },
        budget: CacheBudget {
            max_cache_bytes: 500,
            target_after_gc_bytes: 375,
            min_free_bytes: 100,
            complete: true,
        },
        pressure: HomeCachePressureThresholds {
            reserve_bytes: 100,
            low_free_bytes: 125,
            high_free_bytes: 150,
            reserve_feasible: true,
        },
        summary: HomeImageCacheInspectionSummary {
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
            HomeImageCacheInspectionEntry {
                cache_key: "b".repeat(64),
                status: HomeImageCacheInspectionStatus::Reusable,
                reason: None,
                cache_scope: Some("vm0/production".into()),
                profile_name: Some("vm0/default".into()),
                rootfs_hash: Some("a".repeat(64)),
                working_dir: Some("/home/user/workspace".into()),
                last_completed_at: Some("2026-06-02T15:17:08.716Z".into()),
                last_used_at: Some("2026-06-02T15:17:28.682Z".into()),
                last_terminal_status: Some(
                    crate::home_image_cache::HomeCacheTerminalStatus::Success,
                ),
                allocated_bytes: 256,
                logical_image_size_bytes: 1024,
                temporary_path_count: 1,
                temporary_allocated_bytes: 128,
                storage_count: 2,
                artifact_count: 1,
            },
            HomeImageCacheInspectionEntry {
                cache_key: "a".repeat(64),
                status: HomeImageCacheInspectionStatus::Invalid,
                reason: Some("missing metadata".into()),
                cache_scope: None,
                profile_name: None,
                rootfs_hash: None,
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

fn test_inspection_with_locked_entry() -> HomeImageCacheInspection {
    let mut inspection = test_inspection();
    inspection.summary.total_entries += 1;
    inspection.summary.locked_entries = 1;
    inspection.budget.complete = false;
    inspection.budget.max_cache_bytes = 0;
    inspection.budget.target_after_gc_bytes = 0;
    inspection.entries.push(HomeImageCacheInspectionEntry {
        cache_key: "c".repeat(64),
        status: HomeImageCacheInspectionStatus::Locked,
        reason: Some("entry lock is held".into()),
        cache_scope: None,
        profile_name: None,
        rootfs_hash: None,
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
    assert_eq!(value["cacheDir"], "/var/lib/vm0-runner/home-image-cache");
    assert_eq!(value["summary"]["totalEntries"], 2);
    assert_eq!(value["summary"]["temporaryPaths"], 1);
    assert_eq!(value["fsStats"]["availableInodes"], 70);
    assert_eq!(value["measurementsComplete"], true);
    assert_eq!(value["pressure"]["lowFreeBytes"], 125);
    assert_eq!(value["pressure"]["highFreeBytes"], 150);
    assert_eq!(value["budget"]["complete"], true);
    assert!(value["summary"].get("temporaryFiles").is_none());
    assert!(value.get("entries").is_none());
    assert!(value["budget"].get("maxEntryBytes").is_none());
}

#[test]
fn list_json_includes_limited_entries() {
    let output = list_output(test_inspection(), Some(1));
    let value = serde_json::to_value(&output).unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), 1);
    assert_eq!(value["entriesComplete"], false);
    assert_eq!(value["measurementsComplete"], true);
    assert_eq!(value["fsStats"]["totalInodes"], 100);
    assert_eq!(value["budget"]["maxCacheBytes"], 500);
    assert_eq!(value["entries"][0]["status"], "invalid");
    assert_eq!(value["entries"][0]["reason"], "missing metadata");
    assert_eq!(value["entries"][0]["temporaryPathCount"], 0);
    assert!(value["entries"][0].get("temporaryFileCount").is_none());
    assert!(value["entries"][0].get("storageFingerprints").is_none());
}

#[test]
fn list_json_preserves_locked_entry_placeholders() {
    let value =
        serde_json::to_value(list_output(test_inspection_with_locked_entry(), Some(1))).unwrap();
    let entry = &value["entries"][0];
    assert_eq!(value["summary"]["lockedEntries"], 1);
    assert_eq!(value["measurementsComplete"], false);
    assert_eq!(value["budget"]["complete"], false);
    assert_eq!(value["entriesComplete"], false);
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
    assert!(entry.get("rootfsHash").unwrap().is_null());
    assert!(entry.get("workingDir").unwrap().is_null());
    assert!(entry.get("lastCompletedAt").unwrap().is_null());
    assert!(entry.get("lastUsedAt").unwrap().is_null());
    assert!(entry.get("lastTerminalStatus").unwrap().is_null());
}

#[test]
fn text_info_contains_summary_and_next_actions() {
    let text = format_info_text(&test_inspection());
    assert!(text.contains("Home image cache"));
    assert!(text.contains("Snapshot: non-blocking, best-effort"));
    assert!(text.contains("Entries: total 2, reusable 1, invalid 1"));
    assert!(text.contains("Temporary paths: 1"));
    assert!(!text.contains("Lower bounds:"));
    assert!(text.contains("runner home-image-cache list --limit 50"));
    assert!(text.contains("runner home-image-cache gc --dry-run"));
}

#[test]
fn text_info_marks_locked_entry_derived_values_as_lower_bounds() {
    let text = format_info_text(&test_inspection_with_locked_entry());
    assert!(text.contains("Entries: total 3, reusable 1, invalid 1"));
    assert!(text.contains("locked 1"));
    assert!(text.contains("Lower bounds: status-category counts, temporary-path counts/bytes, and allocated/logical size totals exclude locked entry contents."));
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
    assert!(text.contains("Measurements unavailable: metadata, image size, temporary paths, storage, and artifacts were not inspected."));
    assert!(text.contains("reason=entry lock is held"));
    assert!(!text.contains("allocated=0 B"));
    assert!(!text.contains("scope=-"));
}

#[test]
fn text_list_distinguishes_empty_limit_from_empty_cache() {
    let limited = format_list_text(&list_output(test_inspection(), Some(0)));
    assert!(limited.contains("0 shown, 2 total"));
    assert!(limited.contains("No home image cache entries shown by current limit."));
    assert!(!limited.contains("No home image cache entries found."));
    let empty = HomeImageCacheInspection {
        summary: HomeImageCacheInspectionSummary::default(),
        entries: Vec::new(),
        ..test_inspection()
    };
    let text = format_list_text(&list_output(empty, None));
    assert!(text.contains("0 shown, 0 total"));
    assert!(text.contains("No home image cache entries found."));
}

#[test]
fn list_displays_full_rootfs_identity_without_fingerprints_or_history() {
    let value = serde_json::to_value(list_output(test_inspection(), None)).unwrap();
    assert_eq!(value["entries"][1]["rootfsHash"], "a".repeat(64));
    assert!(value["entries"][1].get("historyProof").is_none());
    let text = format_list_text(&list_output(test_inspection(), None));
    assert!(text.contains(&format!("rootfs={}", "a".repeat(64))));
}

#[tokio::test]
async fn home_image_cache_gc_cleans_shared_cache_root() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let key = home_image_cache_key("sess-1");
    let tmp = tmp_image_path(&home, &key, RunId::new_v4());
    tokio::fs::create_dir_all(tmp.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    run_home_image_cache_with_home(
        HomeImageCacheArgs {
            command: HomeImageCacheCommand::Gc(HomeImageCacheGcArgs {
                dry_run: false,
                api_url: None,
                token: None,
            }),
        },
        &home,
    )
    .await
    .unwrap();
    assert!(!tmp.exists());
}

#[tokio::test]
async fn home_image_cache_gc_dry_run_preserves_files() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let key = home_image_cache_key("sess-1");
    let tmp = tmp_image_path(&home, &key, RunId::new_v4());
    tokio::fs::create_dir_all(tmp.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    run_home_image_cache_with_home(
        HomeImageCacheArgs {
            command: HomeImageCacheCommand::Gc(HomeImageCacheGcArgs {
                dry_run: true,
                api_url: None,
                token: None,
            }),
        },
        &home,
    )
    .await
    .unwrap();
    assert!(tmp.exists());
}
