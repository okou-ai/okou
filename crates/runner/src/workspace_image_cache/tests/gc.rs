use std::time::{Duration, SystemTime};

use tokio::fs;

use super::super::fs::{allocated_bytes, workspace_cache_path_allocated_bytes};
use super::super::gc::gc_budget_satisfied;
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, CacheBudget, FsStats, TEST_FS_AVAILABLE_BYTES, TEST_FS_TOTAL_BYTES,
    WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
};
use super::support::{
    TEST_PROFILE_NAME, local_cache, promote_current_cache_entry, timestamp_for_index,
    write_current_cache_entry,
};
use crate::error::RunnerError;
use crate::storage_fingerprints::StorageFingerprints;
use crate::test_fixtures::workspace_image_cache_key;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::ids::RunId;
use runner_types::types::MAX_HELD_WORKSPACE_STATES;

#[tokio::test]
async fn global_gc_preserves_other_group_cache_entries_when_under_budget() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
        .await
        .unwrap();
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_a = WorkspaceImageCache::shared(runner_a.clone(), &home, "group-a");
    let cache_b = WorkspaceImageCache::shared(runner_b, &home, "group-b");
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();

    let lease = cache_a
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = runner_a.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"image").await.unwrap();
    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    cache_b.gc(false).await.unwrap();

    assert_eq!(cache_a.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn maintenance_gc_preserves_valid_group_scoped_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
        .await
        .unwrap();
    let runner = RunnerPaths::new(dir.path().join("runner"));
    let maintenance_runner = RunnerPaths::new(dir.path().join("maintenance-runner"));
    tokio::fs::create_dir_all(runner.base_dir()).await.unwrap();
    tokio::fs::create_dir_all(maintenance_runner.base_dir())
        .await
        .unwrap();
    let cache = WorkspaceImageCache::shared(runner.clone(), &home, "group-a");
    let maintenance_cache = WorkspaceImageCache::shared(maintenance_runner, &home, "");
    let key = promote_current_cache_entry(
        &cache,
        &runner,
        "sess-1",
        b"image",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.workspace_image_cache_current_image(&key);
    let metadata = cache.workspace_image_cache_metadata(&key);

    maintenance_cache.gc(false).await.unwrap();

    assert!(current.exists());
    assert!(metadata.exists());
}

#[tokio::test]
async fn routine_gc_cleans_stale_entries_when_capacity_lock_is_available() {
    let (_dir, _paths, cache) = local_cache().await;
    let cache_key = workspace_image_cache_key("sess-stale", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
        .await
        .unwrap();
    cache.reset_gc_root_scan_count();

    let freed = cache.try_routine_gc(Duration::from_secs(60)).await.unwrap();

    assert!(freed.is_some());
    assert_eq!(cache.gc_root_scan_count(), 1);
    assert!(
        std::fs::metadata(cache.capacity_lock_path()).unwrap().len() > 0,
        "successful routine GC should record host-global completion"
    );
    assert!(
        !cache
            .entry_paths(&cache_key)
            .entry_dir()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn routine_gc_skips_without_scanning_when_capacity_lock_is_busy() {
    let (_dir, _paths, cache) = local_cache().await;
    let _capacity_lock = runner_host::lock::acquire(cache.capacity_lock_path())
        .await
        .unwrap();
    cache.reset_gc_root_scan_count();

    let freed = cache.try_routine_gc(Duration::from_secs(60)).await.unwrap();

    assert_eq!(freed, None);
    assert_eq!(cache.gc_root_scan_count(), 0);
}

#[tokio::test]
async fn routine_gc_runs_once_per_interval_across_shared_cache_instances() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_a = WorkspaceImageCache::shared(runner_a, &home, "group-a");
    let cache_b = WorkspaceImageCache::shared(runner_b, &home, "group-b");
    let stale_key = workspace_image_cache_key("sess-stale", "/workspace");
    tokio::fs::create_dir_all(cache_a.entry_paths(&stale_key).entry_dir())
        .await
        .unwrap();

    let first = cache_a
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap();
    let second = cache_b
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap();

    assert!(first.is_some());
    assert_eq!(second, None);
    assert_eq!(cache_a.gc_root_scan_count(), 1);
    assert_eq!(cache_b.gc_root_scan_count(), 0);
}

#[tokio::test]
async fn routine_gc_runs_again_after_shared_completion_expires() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_a = WorkspaceImageCache::shared(runner_a, &home, "group-a");
    let cache_b = WorkspaceImageCache::shared(runner_b, &home, "group-b");
    cache_a
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap()
        .expect("first routine GC should record completion");
    let future_completion = SystemTime::now() + Duration::from_secs(60);
    std::fs::File::options()
        .write(true)
        .open(cache_a.capacity_lock_path())
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(future_completion))
        .unwrap();
    cache_b.reset_gc_root_scan_count();

    let future = cache_b
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap();

    assert_eq!(future, None);
    assert_eq!(cache_b.gc_root_scan_count(), 0);
    let old_completion = SystemTime::now() - Duration::from_secs(61);
    std::fs::File::options()
        .write(true)
        .open(cache_a.capacity_lock_path())
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(old_completion))
        .unwrap();
    cache_b.reset_gc_root_scan_count();

    let next = cache_b
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap();

    assert!(next.is_some());
    assert_eq!(cache_b.gc_root_scan_count(), 1);
}

#[tokio::test]
async fn failed_routine_gc_does_not_suppress_retry() {
    let (_dir, paths, cache) = local_cache().await;
    let cache_root = crate::test_fixtures::runner_workspace_image_cache_dir(&paths);
    tokio::fs::write(&cache_root, b"not a directory")
        .await
        .unwrap();

    let error = cache
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap_err();

    assert!(matches!(error, RunnerError::Io(_)));
    assert_eq!(
        std::fs::metadata(cache.capacity_lock_path()).unwrap().len(),
        0,
        "failed routine GC must not record completion"
    );
    tokio::fs::remove_file(&cache_root).await.unwrap();

    let retry = cache.try_routine_gc(Duration::from_secs(60)).await.unwrap();

    assert!(retry.is_some());
    assert_eq!(cache.gc_root_scan_count(), 2);
}

#[tokio::test]
async fn unknown_metadata_format_is_not_reused_or_advertised_and_is_reclaimed() {
    let (_dir, _paths, cache) = local_cache().await;
    let checkout_reuse_key = "thread:unknown-format-checkout";
    let checkout_key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        checkout_reuse_key,
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let checkout_metadata_path = cache.entry_paths(&checkout_key).metadata().to_path_buf();
    let mut checkout_metadata = cache
        .read_metadata_file(&checkout_metadata_path)
        .await
        .unwrap();
    checkout_metadata.format_version = CACHE_FORMAT_VERSION + 1;
    cache
        .write_metadata(&checkout_key, RunId::new_v4(), checkout_metadata)
        .await
        .unwrap();

    let gc_reuse_key = "thread:unknown-format-gc";
    let gc_key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        gc_reuse_key,
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let gc_metadata_path = cache.entry_paths(&gc_key).metadata().to_path_buf();
    let mut gc_metadata = cache.read_metadata_file(&gc_metadata_path).await.unwrap();
    gc_metadata.format_version = CACHE_FORMAT_VERSION + 1;
    cache
        .write_metadata(&gc_key, RunId::new_v4(), gc_metadata)
        .await
        .unwrap();

    assert!(cache.held_workspace_states().await.is_empty());
    let checkout = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(checkout_reuse_key),
                working_dir: "/workspace",
                image_size_bytes: format!("image-{checkout_reuse_key}").len() as u64,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(
        checkout.result(),
        super::super::WorkspaceCacheCheckoutResult::Miss
    );
    assert!(
        !cache
            .entry_paths(&checkout_key)
            .entry_dir()
            .to_path_buf()
            .exists()
    );

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache
            .entry_paths(&gc_key)
            .entry_dir()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn global_gc_candidates_include_other_group_cache_entries() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    tokio::fs::create_dir_all(home.workspace_image_cache_dir().parent().unwrap())
        .await
        .unwrap();
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_a = WorkspaceImageCache::shared(runner_a.clone(), &home, "group-a");
    let cache_b = WorkspaceImageCache::shared(runner_b.clone(), &home, "group-b");

    let group_a_key = promote_current_cache_entry(
        &cache_a,
        &runner_a,
        "sess-a",
        b"image-a",
        "2026-05-01T00:00:00.000Z",
    )
    .await;

    assert!(
        cache_a.gc_candidate(group_a_key.clone()).await.is_some(),
        "own group entries should remain eligible for GC"
    );
    assert!(
        cache_b.gc_candidate(group_a_key.clone()).await.is_some(),
        "GC budget candidates should include valid entries from other groups"
    );

    let group_b_key = promote_current_cache_entry(
        &cache_b,
        &runner_b,
        "sess-b",
        b"image-b",
        "2026-05-01T00:01:00.000Z",
    )
    .await;

    let candidates = cache_b.gc_candidates().await.unwrap();
    let candidate_keys: Vec<_> = candidates
        .into_iter()
        .map(|candidate| candidate.cache_key)
        .collect();
    assert_eq!(candidate_keys.len(), 2);
    assert!(candidate_keys.contains(&group_a_key));
    assert!(candidate_keys.contains(&group_b_key));
}

#[tokio::test]
async fn global_gc_evicts_old_entry_from_other_group_under_free_space_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();

    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    });
    let pressure_stats = FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: budget.min_free_bytes.saturating_sub(1),
    };
    let cache_dir = home.workspace_image_cache_dir();
    let lock_dir = home.locks_dir();
    let cache_a = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        runner_a.clone(),
        cache_dir.clone(),
        lock_dir.clone(),
        "group-a",
        pressure_stats,
    );
    let cache_b = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        runner_b.clone(),
        cache_dir,
        lock_dir,
        "group-b",
        pressure_stats,
    );
    let run_id = RunId::new_v4();
    let old_key = write_current_cache_entry(
        &cache_a,
        run_id,
        "sess-a",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let new_key = write_current_cache_entry(
        &cache_b,
        run_id,
        "sess-b",
        "/workspace",
        "2026-05-01T00:01:00.000Z",
        "2026-05-01T00:01:00.000Z",
    )
    .await;

    let freed = cache_b
        .try_routine_gc(Duration::from_secs(60))
        .await
        .unwrap()
        .expect("routine GC should acquire the idle capacity lock");

    assert!(freed > 0);
    assert!(
        !cache_a
            .workspace_image_cache_current_image(&old_key)
            .exists(),
        "oldest global candidate can be evicted even when it belongs to another group"
    );
    assert!(
        cache_b
            .workspace_image_cache_current_image(&new_key)
            .exists(),
        "newer candidate from the current group should be retained once pressure is relieved"
    );
    assert!(cache_a.held_workspace_states().await.is_empty());
    assert_eq!(cache_b.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn global_gc_prunes_oldest_entries_above_limit_across_runner_groups() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let runner_a = RunnerPaths::new(dir.path().join("runner-a"));
    let runner_b = RunnerPaths::new(dir.path().join("runner-b"));
    tokio::fs::create_dir_all(runner_a.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(runner_b.base_dir())
        .await
        .unwrap();
    let cache_dir = home.workspace_image_cache_dir();
    let lock_dir = home.locks_dir();
    let fs_stats = FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    };
    let cache_a = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        runner_a.clone(),
        cache_dir.clone(),
        lock_dir.clone(),
        "group-a",
        fs_stats,
    );
    let cache_b = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        runner_b.clone(),
        cache_dir,
        lock_dir,
        "group-b",
        fs_stats,
    );
    let run_id = RunId::new_v4();
    let oldest_key = write_current_cache_entry(
        &cache_a,
        run_id,
        "sess-a-0000",
        "/workspace",
        &timestamp_for_index(0),
        &timestamp_for_index(0),
    )
    .await;
    let mut newest_key = String::new();
    for index in 1..=MAX_HELD_WORKSPACE_STATES {
        let reuse_key = format!("sess-b-{index:04}");
        let timestamp = timestamp_for_index(index);
        let key = write_current_cache_entry(
            &cache_b,
            run_id,
            &reuse_key,
            "/workspace",
            &timestamp,
            &timestamp,
        )
        .await;
        if index == MAX_HELD_WORKSPACE_STATES {
            newest_key = key;
        }
    }

    let freed = cache_b.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache_a
            .workspace_image_cache_current_image(&oldest_key)
            .exists(),
        "oldest global candidate should be removed when the shared cache exceeds the entry cap"
    );
    assert!(
        cache_b
            .workspace_image_cache_current_image(&newest_key)
            .exists(),
        "newest candidate should be retained"
    );
    assert_eq!(
        cache_b.gc_candidates().await.unwrap().len(),
        MAX_HELD_WORKSPACE_STATES
    );
    assert!(cache_a.held_workspace_states().await.is_empty());
    assert_eq!(
        cache_b.held_workspace_states().await.len(),
        MAX_HELD_WORKSPACE_STATES
    );
}

#[test]
fn gc_budget_satisfied_counts_only_candidate_deletes_after_pre_cleanup() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };
    let stats_after_pre_cleanup = FsStats {
        total_bytes: 200,
        available_bytes: 40,
    };

    assert!(!gc_budget_satisfied(
        true,
        75,
        MAX_HELD_WORKSPACE_STATES,
        stats_after_pre_cleanup,
        budget,
        0,
    ));
    assert!(gc_budget_satisfied(
        true,
        75,
        MAX_HELD_WORKSPACE_STATES,
        stats_after_pre_cleanup,
        budget,
        10,
    ));
}

#[test]
fn gc_budget_satisfied_enforces_entry_cap_even_without_disk_pressure() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };

    assert!(!gc_budget_satisfied(
        false,
        50,
        MAX_HELD_WORKSPACE_STATES + 1,
        FsStats {
            total_bytes: 200,
            available_bytes: 100,
        },
        budget,
        0,
    ));
}

#[tokio::test]
async fn gc_candidate_detects_replaced_image_with_same_timestamp() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    let entry_dir = cache.entry_paths(&cache_key).entry_dir().to_path_buf();
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    tokio::fs::write(&current, b"old image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &cache_key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: 9,
                allocated_bytes: 9,
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let old_candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();
    let replacement = entry_dir.join("current.ext4.tmp");
    tokio::fs::write(&replacement, b"new image").await.unwrap();
    tokio::fs::rename(&replacement, &current).await.unwrap();
    let refreshed_candidate = cache.gc_candidate(cache_key).await.unwrap();

    assert_eq!(refreshed_candidate.last_used_at, old_candidate.last_used_at);
    assert!(
        !refreshed_candidate.same_current_image(&old_candidate),
        "GC must notice current.ext4 was replaced even when metadata timestamp is unchanged",
    );
}

#[tokio::test]
async fn gc_candidate_includes_current_image_without_metadata() {
    let (_dir, _paths, cache) = local_cache().await;
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    tokio::fs::write(&current, b"orphan image").await.unwrap();

    let candidate = cache.gc_candidate(cache_key.clone()).await.unwrap();

    assert_eq!(candidate.cache_key, cache_key);
    assert!(current.exists());
    assert_eq!(candidate.last_used_at, "");
    assert!(candidate.allocated_bytes > 0);
}

#[tokio::test]
async fn gc_counts_busy_entry_when_pruning_above_held_workspace_limit() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();

    let mut oldest_key = String::new();
    let mut second_oldest_key = String::new();
    let mut newest_key = String::new();
    for index in 0..=MAX_HELD_WORKSPACE_STATES {
        let reuse_key = format!("sess-{index:04}");
        let timestamp = timestamp_for_index(index);
        let key = write_current_cache_entry(
            &cache,
            run_id,
            &reuse_key,
            "/workspace",
            &timestamp,
            &timestamp,
        )
        .await;
        if index == 0 {
            oldest_key = key.clone();
        }
        if index == 1 {
            second_oldest_key = key.clone();
        }
        if index == MAX_HELD_WORKSPACE_STATES {
            newest_key = key;
        }
    }

    let oldest_lock = runner_host::lock::acquire(cache.entry_lock_path(&oldest_key))
        .await
        .unwrap();
    let freed = cache.gc(false).await.unwrap();
    drop(oldest_lock);

    assert!(freed > 0);
    assert!(
        cache
            .entry_paths(&oldest_key)
            .current_image()
            .to_path_buf()
            .exists(),
        "the oldest busy entry must remain protected by its entry lock"
    );
    assert!(
        !cache
            .entry_paths(&second_oldest_key)
            .entry_dir()
            .to_path_buf()
            .exists(),
        "a valid busy entry must still count toward the cap and force eviction of the next eligible candidate"
    );
    assert!(
        cache
            .entry_paths(&newest_key)
            .current_image()
            .to_path_buf()
            .exists(),
        "newest cache entry should be retained"
    );
    assert_eq!(
        cache.gc_candidates().await.unwrap().len(),
        MAX_HELD_WORKSPACE_STATES
    );
    assert_eq!(
        cache.held_workspace_states().await.len(),
        MAX_HELD_WORKSPACE_STATES
    );
}

#[tokio::test]
async fn gc_removes_stale_entry_without_current_image() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    tokio::fs::remove_file(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "stale metadata-only entries should not accumulate and slow heartbeat scans"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_entry_without_metadata() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    tokio::fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"orphan image",
    )
    .await
    .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "current images without metadata are not reusable and should not accumulate"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_symlink_loop_without_aborting() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    std::os::unix::fs::symlink("current.ext4", cache.entry_paths(&key).current_image()).unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "symlink-loop current images are unusable and should not abort cache GC"
    );
}

#[tokio::test]
async fn gc_removes_unusable_current_entry_with_unreadable_metadata_path() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    tokio::fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"orphan image",
    )
    .await
    .unwrap();
    tokio::fs::create_dir(cache.entry_paths(&key).metadata().to_path_buf())
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "unreadable metadata paths make entries unusable and should not block cache GC"
    );
}

#[tokio::test]
async fn gc_dry_run_counts_temporary_only_entry_once() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let entry_dir = cache.entry_paths(&key).entry_dir().to_path_buf();
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let tmp = cache.entry_paths(&key).tmp_image(RunId::new_v4());
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let expected = workspace_cache_path_allocated_bytes(&entry_dir).await;

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, expected,
        "dry-run should count temporary-only entries once, matching actual full-entry cleanup"
    );
    assert!(tmp.exists());
    assert!(entry_dir.exists());
}

#[tokio::test]
async fn gc_dry_run_counts_unusable_entry_with_temporary_path_once() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let entry_dir = cache.entry_paths(&key).entry_dir().to_path_buf();
    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    tokio::fs::write(&current, b"orphan image").await.unwrap();
    let tmp = cache.entry_paths(&key).tmp_image(RunId::new_v4());
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let expected = workspace_cache_path_allocated_bytes(&entry_dir).await;

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, expected,
        "dry-run should not count temporary paths again after an unusable entry is already selected for cleanup"
    );
    assert!(current.exists());
    assert!(tmp.exists());
    assert!(entry_dir.exists());
}

#[tokio::test]
async fn gc_dry_run_uses_pre_cleanup_freed_bytes_for_disk_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let setup_cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &setup_cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = setup_cache.entry_paths(&key).tmp_image(run_id);
    tokio::fs::write(&tmp, vec![1_u8; 4096]).await.unwrap();
    let temporary_allocated = workspace_cache_path_allocated_bytes(&tmp).await;
    assert!(temporary_allocated > 0);

    let fs_total = TEST_FS_TOTAL_BYTES;
    let min_free = CacheBudget::from_fs_stats(FsStats {
        total_bytes: fs_total,
        available_bytes: fs_total,
    })
    .min_free_bytes;
    let cache = WorkspaceImageCache::new_with_fs_stats(
        paths.clone(),
        FsStats {
            total_bytes: fs_total,
            available_bytes: min_free.saturating_sub(1),
        },
    );

    let freed = cache.gc(true).await.unwrap();

    assert_eq!(
        freed, temporary_allocated,
        "dry-run should account for pre-cleanup temporary bytes before deciding whether valid cache entries need budget GC"
    );
    assert!(tmp.exists());
    assert!(
        cache
            .entry_paths(&key)
            .current_image()
            .to_path_buf()
            .exists(),
        "dry-run must not preview deleting a valid entry when temporary cleanup would relieve disk pressure"
    );
}

#[tokio::test]
async fn gc_removes_current_directory_even_when_metadata_matches() {
    let (dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let reuse_key = "sess-1";
    let working_dir = "/workspace";
    let probe = dir.path().join("current-probe");
    tokio::fs::create_dir_all(&probe).await.unwrap();
    let image_size_bytes = fs::metadata(&probe).await.unwrap().len();
    tokio::fs::remove_dir_all(&probe).await.unwrap();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, working_dir, image_size_bytes);
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    tokio::fs::create_dir_all(&current).await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: reuse_key.into(),
                working_dir: working_dir.into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: image_size_bytes,
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(
        !cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "current directories must not remain as reusable workspace cache entries"
    );
}

#[tokio::test]
async fn gc_counts_nested_current_directory_bytes() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let reuse_key = "sess-1";
    let working_dir = "/workspace";
    let image_size_bytes = 1024 * 1024;
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, working_dir, image_size_bytes);
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    let nested = current.join("nested");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    tokio::fs::write(
        nested.join("payload"),
        vec![1_u8; image_size_bytes as usize],
    )
    .await
    .unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: reuse_key.into(),
                working_dir: working_dir.into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(
        freed >= image_size_bytes,
        "GC must report nested current directory bytes so callers refresh disk stats after cleanup"
    );
    assert!(!cache.entry_paths(&key).entry_dir().to_path_buf().exists());
}

#[tokio::test]
async fn gc_keeps_unusable_current_entry_when_entry_lock_is_held() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    tokio::fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"orphan image",
    )
    .await
    .unwrap();
    let _lock = runner_host::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "entry locks must protect in-progress promotions from GC removal"
    );
}

#[tokio::test]
async fn gc_keeps_stale_entry_without_current_image_when_entry_lock_is_held() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    tokio::fs::remove_file(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();
    let _lock = runner_host::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        cache.entry_paths(&key).entry_dir().to_path_buf().exists(),
        "entry locks must protect stale entries from GC removal"
    );
}

#[tokio::test]
async fn gc_removes_orphan_temporary_workspace_cache_files() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let tmp = cache.entry_paths(&cache_key).tmp_image(run_id);
    let metadata_tmp = cache.entry_paths(&cache_key).tmp_metadata(run_id);
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    tokio::fs::write(&metadata_tmp, b"partial metadata")
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!tmp.exists());
    assert!(!metadata_tmp.exists());
}

#[tokio::test]
async fn gc_removes_orphan_temporary_workspace_cache_directories() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = cache.entry_paths(&cache_key).tmp_image(run_id);
    let metadata_tmp = cache.entry_paths(&cache_key).tmp_metadata(run_id);
    tokio::fs::create_dir_all(&tmp).await.unwrap();
    tokio::fs::write(tmp.join("partial-image"), b"partial image")
        .await
        .unwrap();
    tokio::fs::create_dir_all(&metadata_tmp).await.unwrap();
    tokio::fs::write(metadata_tmp.join("partial-metadata"), b"partial metadata")
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(freed > 0);
    assert!(!tmp.exists());
    assert!(!metadata_tmp.exists());
    assert!(
        cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn gc_counts_nested_temporary_workspace_cache_directories() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let tmp = cache.entry_paths(&cache_key).tmp_image(run_id);
    let nested = tmp.join("nested");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    tokio::fs::write(nested.join("partial-image"), vec![1_u8; 4096])
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert!(
        freed > 0,
        "GC must report bytes freed from nested temporary directories"
    );
    assert!(!tmp.exists());
    assert!(
        cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn gc_keeps_temporary_workspace_cache_files_when_entry_lock_is_held() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let tmp = cache.entry_paths(&cache_key).tmp_image(run_id);
    let metadata_tmp = cache.entry_paths(&cache_key).tmp_metadata(run_id);
    tokio::fs::write(&tmp, b"partial image").await.unwrap();
    tokio::fs::write(&metadata_tmp, b"partial metadata")
        .await
        .unwrap();
    let _lock = runner_host::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let freed = cache.gc(false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(tmp.exists());
    assert!(metadata_tmp.exists());
}
