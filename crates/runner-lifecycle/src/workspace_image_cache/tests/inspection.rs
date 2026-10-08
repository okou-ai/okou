use std::collections::HashMap;

use tokio::fs;

use super::super::fs::allocated_bytes;
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, CacheBudget, TEST_FS_TOTAL_BYTES, WORKSPACE_DRIVE_LAYOUT,
    WorkspaceCacheTerminalStatus, WorkspaceImageCache, WorkspaceImageCacheInspectionStatus,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::test_fixtures::workspace_image_cache_key;
use runner_host::paths::RunnerPaths;
use runner_types::ids::RunId;

#[tokio::test]
async fn inspect_missing_cache_dir_returns_empty_summary() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths);

    let inspection = cache.inspect().await.unwrap();

    assert!(inspection.entries.is_empty());
    assert_eq!(inspection.summary.total_entries, 0);
    assert_eq!(inspection.summary.total_allocated_bytes, 0);
    assert_eq!(inspection.summary.total_logical_image_bytes, 0);
    assert_eq!(inspection.fs_stats.total_bytes, TEST_FS_TOTAL_BYTES);
    assert_eq!(
        inspection.budget,
        CacheBudget::from_fs_stats(inspection.fs_stats)
    );
}

#[tokio::test]
async fn inspect_reports_reusable_entry_with_storage_counts() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints {
                    storages: HashMap::from([
                        ("/workspace".into(), StorageFingerprint::new("repo", "v1")),
                        (
                            "/workspace/cache".into(),
                            StorageFingerprint::new("cache", "v2"),
                        ),
                    ]),
                    artifacts: HashMap::from([(
                        "/workspace/artifact".into(),
                        StorageFingerprint::new("artifact", "v1"),
                    )]),
                },
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.total_entries, 1);
    assert_eq!(inspection.summary.reusable_entries, 1);
    assert_eq!(inspection.summary.total_logical_image_bytes, 5);
    assert!(inspection.summary.total_allocated_bytes > 0);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Reusable);
    assert_eq!(entry.storage_count, 2);
    assert_eq!(entry.artifact_count, 1);
    assert_eq!(entry.allocated_bytes, allocated_bytes(&current_metadata));
    assert_eq!(entry.logical_image_size_bytes, current_metadata.len());
}

#[tokio::test]
async fn inspect_reports_invalid_metadata_reason() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "other-session".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("cache key mismatch"));
}

#[tokio::test]
async fn inspect_rejects_symlink_current_image() {
    let (dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let image = b"image";
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        image.len() as u64,
    );
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let target = dir.path().join("target.ext4");
    fs::write(&target, image).await.unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    std::os::unix::fs::symlink(&target, &current).unwrap();
    let current_target_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/workspace".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_target_metadata.len(),
                allocated_bytes: allocated_bytes(&current_target_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_target_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
}

#[tokio::test]
async fn inspect_reports_current_directory_as_invalid() {
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
    fs::create_dir_all(&current).await.unwrap();
    fs::write(current.join("nested"), vec![1_u8; 4096])
        .await
        .unwrap();
    let current_metadata = fs::symlink_metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: reuse_key.into(),
                working_dir: working_dir.into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:01:00.000Z".into(),
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

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("current image is not a file"));
    assert!(
        entry.allocated_bytes > allocated_bytes(&current_metadata),
        "inspection should count nested bytes for directory-shaped current images",
    );
}

#[tokio::test]
async fn inspect_reports_stale_entry_without_current_image() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    fs::remove_file(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.stale_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Stale);
    assert_eq!(entry.reason.as_deref(), Some("missing current image"));
    assert_eq!(entry.profile_name.as_deref(), Some(TEST_PROFILE_NAME));
}

#[tokio::test]
async fn inspect_reports_temporary_only_entry() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let tmp = cache.entry_paths(&key).tmp_image(RunId::new_v4());
    fs::create_dir_all(tmp.parent().unwrap()).await.unwrap();
    fs::write(&tmp, b"partial image").await.unwrap();
    let tmp_metadata = fs::metadata(&tmp).await.unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.temporary_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 1);
    assert_eq!(
        inspection.summary.temporary_allocated_bytes,
        allocated_bytes(&tmp_metadata)
    );
    let entry = &inspection.entries[0];
    assert_eq!(
        entry.status,
        WorkspaceImageCacheInspectionStatus::TemporaryOnly
    );
    assert_eq!(entry.temporary_path_count, 1);
}

#[tokio::test]
async fn inspect_reports_temporary_only_directory() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let tmp = cache.entry_paths(&key).tmp_image(RunId::new_v4());
    fs::create_dir_all(&tmp).await.unwrap();
    fs::write(tmp.join("partial-image"), vec![1_u8; 4096])
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.temporary_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 1);
    assert!(inspection.summary.temporary_allocated_bytes > 0);
    let entry = &inspection.entries[0];
    assert_eq!(
        entry.status,
        WorkspaceImageCacheInspectionStatus::TemporaryOnly
    );
    assert_eq!(
        entry.reason.as_deref(),
        Some("missing current image; temporary paths present")
    );
    assert_eq!(entry.temporary_path_count, 1);
    assert!(entry.temporary_allocated_bytes > 0);
}

#[tokio::test]
async fn inspect_reports_locked_entry_without_blocking() {
    let (_dir, _paths, cache) = local_cache().await;
    let key = workspace_image_cache_key("sess-1", "/workspace");
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    fs::write(
        cache.entry_paths(&key).tmp_image(RunId::new_v4()),
        b"partial image",
    )
    .await
    .unwrap();
    let _lock = runner_host::lock::acquire(cache.entry_lock_path(&key))
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.locked_entries, 1);
    assert_eq!(inspection.summary.temporary_paths, 0);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Locked);
    assert_eq!(entry.reason.as_deref(), Some("entry lock is held"));
    assert_eq!(entry.temporary_path_count, 0);
}

#[tokio::test]
async fn inspect_propagates_lock_path_errors() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = workspace_image_cache_key("sess-1", "/workspace");
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    fs::write(paths.base_dir().join("locks"), b"not a directory")
        .await
        .unwrap();

    let err = cache.inspect().await.unwrap_err();

    assert!(
        err.to_string().contains("create lock dir"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn inspect_entry_skips_directory_removed_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let entry_dir = cache.entry_paths(&key).entry_dir().to_path_buf();
    fs::create_dir_all(&entry_dir).await.unwrap();
    fs::remove_dir_all(&entry_dir).await.unwrap();

    let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

    assert!(entry.is_none());
}

#[tokio::test]
async fn inspect_entry_skips_symlink_replacement_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = workspace_image_cache_key("sess-1", "/workspace");
    let entry_dir = cache.entry_paths(&key).entry_dir().to_path_buf();
    fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    let target = dir.path().join("outside-cache-entry");
    fs::create_dir_all(&target).await.unwrap();
    std::os::unix::fs::symlink(&target, &entry_dir).unwrap();

    let entry = cache.inspect_entry(key, entry_dir).await.unwrap();

    assert!(entry.is_none());
}

#[tokio::test]
async fn inspect_reports_non_file_metadata_as_invalid_entry() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = workspace_image_cache_key("sess-1", "/workspace");
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"image",
    )
    .await
    .unwrap();
    fs::create_dir(cache.entry_paths(&key).metadata().to_path_buf())
        .await
        .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn inspect_rejects_metadata_symlink_without_following_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = write_current_cache_entry(
        &cache,
        RunId::new_v4(),
        "sess-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let metadata_path = cache.entry_paths(&key).metadata().to_path_buf();
    let outside = dir.path().join("outside-metadata.json");
    fs::rename(&metadata_path, &outside).await.unwrap();
    std::os::unix::fs::symlink(&outside, &metadata_path).unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}

#[tokio::test]
async fn inspect_rejects_oversized_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache = WorkspaceImageCache::new(paths.clone());
    let key = workspace_image_cache_key("sess-1", "/workspace");
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    fs::write(
        cache.entry_paths(&key).current_image().to_path_buf(),
        b"image",
    )
    .await
    .unwrap();
    fs::write(
        cache.entry_paths(&key).metadata().to_path_buf(),
        vec![b' '; runner_host::state_file::WORKSPACE_METADATA_MAX_BYTES as usize + 1],
    )
    .await
    .unwrap();

    let inspection = cache.inspect().await.unwrap();

    assert_eq!(inspection.summary.invalid_entries, 1);
    let entry = &inspection.entries[0];
    assert_eq!(entry.status, WorkspaceImageCacheInspectionStatus::Invalid);
    assert_eq!(entry.reason.as_deref(), Some("missing or invalid metadata"));
}
