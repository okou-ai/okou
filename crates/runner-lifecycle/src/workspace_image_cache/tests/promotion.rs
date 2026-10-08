use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

use nix::sys::stat::Mode;

use tokio::fs;

use super::super::fs::local_timestamp;
use super::super::{
    CacheBudget, FsStats, TEST_FS_AVAILABLE_BYTES, TEST_FS_TOTAL_BYTES,
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageCache,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
    WorkspaceImagePromotionIdentityMismatch, WorkspaceImagePromotionIdentityRequest,
    WorkspaceImagePromotionRequest,
};
use super::support::{
    TEST_PROFILE_NAME, local_cache, promote_current_cache_entry, write_current_cache_entry,
};
use crate::error::LifecycleError;
use crate::storage_fingerprints::StorageFingerprints;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use crate::test_fixtures::workspace_image_cache_key;
use runner_host::paths::RunnerPaths;
use runner_types::ids::RunId;

const PERMISSIVE_UMASK_CHILD_ENV: &str = "OKOU_RUN_WORKSPACE_CACHE_PERMISSIVE_UMASK_TEST";
const PUBLICATION_UMASK_ENV: &str = "OKOU_WORKSPACE_CACHE_PUBLICATION_UMASK";

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

struct UmaskGuard {
    original: Mode,
}

impl UmaskGuard {
    fn set(mask: Mode) -> Self {
        Self {
            original: nix::sys::stat::umask(mask),
        }
    }
}

impl Drop for UmaskGuard {
    fn drop(&mut self) {
        nix::sys::stat::umask(self.original);
    }
}

async fn cross_filesystem_cache(
    fs_stats: FsStats,
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    RunnerPaths,
    WorkspaceImageCache,
) {
    let runner_dir = tempfile::tempdir_in("/tmp").unwrap();
    let cache_dir = tempfile::tempdir_in("/dev/shm").unwrap();
    let paths = RunnerPaths::new(runner_dir.path().join("runner"));
    fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache_root = cache_dir.path().join("workspace-image-cache");
    fs::create_dir_all(&cache_root).await.unwrap();
    let runner_device = fs::metadata(paths.base_dir()).await.unwrap().dev();
    let cache_device = fs::metadata(&cache_root).await.unwrap().dev();
    assert_ne!(
        runner_device, cache_device,
        "cross-filesystem promotion tests require /tmp and /dev/shm on distinct devices"
    );
    let lock_dir = runner_dir.path().join("locks");
    let cache = WorkspaceImageCache::with_cache_dirs_and_fs_stats(
        paths.clone(),
        cache_root,
        lock_dir,
        "",
        fs_stats,
    );
    (runner_dir, cache_dir, paths, cache)
}

#[tokio::test]
async fn promotion_does_not_overwrite_newer_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let reuse_key = "sess-race";
    let existing_image = format!("image-{reuse_key}").into_bytes();
    let image_size = existing_image.len() as u64;
    let stale_run_id = RunId::new_v4();
    let stale_sandbox_id = sandbox::SandboxId::new_v4();
    let stale_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: stale_run_id,
                sandbox_id: stale_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(stale_lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let stale_active_image = paths.active_workspace_image(&stale_sandbox_id);
    tokio::fs::create_dir_all(stale_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&stale_active_image, vec![b'o'; image_size as usize])
        .await
        .unwrap();
    let key = write_current_cache_entry(
        &cache,
        stale_run_id,
        reuse_key,
        "/workspace",
        "2026-06-02T00:00:00.000Z",
        "2026-06-02T00:00:00.000Z",
    )
    .await;

    let promoted = stale_lease
        .promote(
            stale_run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-06-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    let metadata = cache
        .read_metadata_file(cache.entry_paths(&key).metadata())
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
    let current = tokio::fs::read(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();
    assert_eq!(current, existing_image);
}

#[tokio::test]
async fn promotion_does_not_overwrite_same_completed_at_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let reuse_key = "sess-same-completed-at";
    let completed_at = "2026-06-02T00:00:00.000Z";
    let existing_image = format!("image-{reuse_key}").into_bytes();
    let image_size = existing_image.len() as u64;
    let competing_run_id = RunId::new_v4();
    let competing_sandbox_id = sandbox::SandboxId::new_v4();
    let competing_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: competing_run_id,
                sandbox_id: competing_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(competing_lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let competing_active_image = paths.active_workspace_image(&competing_sandbox_id);
    tokio::fs::create_dir_all(competing_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&competing_active_image, vec![b'n'; image_size as usize])
        .await
        .unwrap();
    let key = write_current_cache_entry(
        &cache,
        competing_run_id,
        reuse_key,
        "/workspace",
        completed_at,
        completed_at,
    )
    .await;

    let promoted = competing_lease
        .promote(
            competing_run_id,
            WorkspaceCacheTerminalStatus::Success,
            completed_at.into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    let metadata = cache
        .read_metadata_file(cache.entry_paths(&key).metadata())
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, completed_at);
    let current = tokio::fs::read(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();
    assert_eq!(current, existing_image);
}

#[tokio::test]
async fn promotion_overwrites_older_cache_entry() {
    let (_dir, paths, cache) = local_cache().await;
    let reuse_key = "sess-newer";
    let image_size = b"old image".len() as u64;
    let key = promote_current_cache_entry(
        &cache,
        &paths,
        reuse_key,
        b"old image",
        "2026-06-01T00:00:00.000Z",
    )
    .await;
    let newer_run_id = RunId::new_v4();
    let newer_sandbox_id = sandbox::SandboxId::new_v4();
    let newer_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: newer_run_id,
                sandbox_id: newer_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: false,
        })
        .await;
    assert!(newer_lease.is_cache_hit());
    let newer_active_image = paths.active_workspace_image(&newer_sandbox_id);
    tokio::fs::create_dir_all(newer_active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&newer_active_image, b"new image")
        .await
        .unwrap();

    let promoted = newer_lease
        .promote(
            newer_run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-06-02T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(promoted);
    let metadata = cache
        .read_metadata_file(cache.entry_paths(&key).metadata())
        .await
        .unwrap();
    assert_eq!(metadata.last_completed_at, "2026-06-02T00:00:00.000Z");
    let current = tokio::fs::read(cache.entry_paths(&key).current_image().to_path_buf())
        .await
        .unwrap();
    assert_eq!(current, b"new image");
}

#[tokio::test]
async fn successful_multi_entry_promotions_do_not_scan_cache_root() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let first_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-existing-1",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let second_key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-existing-2",
        "/workspace",
        "2026-05-01T00:01:00.000Z",
        "2026-05-01T00:01:00.000Z",
    )
    .await;
    cache.reset_gc_root_scan_count();

    let first_promoted_key = promote_current_cache_entry(
        &cache,
        &paths,
        "sess-promoted-1",
        b"promoted image 1",
        "2026-05-01T00:02:00.000Z",
    )
    .await;
    let second_promoted_key = promote_current_cache_entry(
        &cache,
        &paths,
        "sess-promoted-2",
        b"promoted image 2",
        "2026-05-01T00:03:00.000Z",
    )
    .await;

    assert_eq!(
        cache.gc_root_scan_count(),
        0,
        "healthy under-budget promotions should not inventory the cache root"
    );
    for cache_key in [
        first_key,
        second_key,
        first_promoted_key,
        second_promoted_key,
    ] {
        assert!(
            cache
                .entry_paths(&cache_key)
                .current_image()
                .to_path_buf()
                .exists(),
            "healthy under-budget entries should remain available for routine GC"
        );
    }
}

#[tokio::test]
async fn abandoned_cache_hit_promotion_context_invalidates_consumed_entry() {
    let (_dir, _paths, cache) = local_cache().await;
    let reuse_key = "sess-abandon-hit";
    let cache_run_id = RunId::new_v4();
    let cache_key = write_current_cache_entry(
        &cache,
        cache_run_id,
        reuse_key,
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    let image_size_bytes = fs::metadata(&current).await.unwrap().len();
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert!(lease.consumed_cache_hit);
    assert!(
        !fs::try_exists(cache.entry_paths(&cache_key).metadata().to_path_buf())
            .await
            .unwrap()
    );
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-02T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    assert!(
        promotion
            .abandon_unpublished("test abandoned cache hit")
            .await
            .unwrap()
    );
    assert!(
        !fs::try_exists(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
            .await
            .unwrap()
    );

    let next = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(next.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn consumed_cache_hit_promotion_moves_active_image_back_to_cache() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-promote",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    let image_size = fs::metadata(&current).await.unwrap().len();
    let active_image = paths.active_workspace_image(&sandbox_id);

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-move-promote"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::rename(&current, &active_image).await.unwrap();
    let updated = vec![b'x'; image_size as usize];
    fs::write(&active_image, &updated).await.unwrap();
    let active_metadata = fs::metadata(&active_image).await.unwrap();
    let active_identity = (active_metadata.dev(), active_metadata.ino());

    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    assert!(
        !fs::try_exists(&active_image).await.unwrap(),
        "same-filesystem promotion must transfer ownership out of the sandbox workspace"
    );
    assert_eq!(fs::read(&current).await.unwrap(), updated);
    let current_metadata = fs::metadata(&current).await.unwrap();
    assert_eq!(
        active_identity,
        (current_metadata.dev(), current_metadata.ino()),
        "same-filesystem promotion must publish the moved image without copying its extents"
    );
    let metadata = cache
        .read_metadata_file(cache.entry_paths(&key).metadata())
        .await
        .unwrap();
    assert_eq!(metadata.logical_image_size_bytes, image_size);
    assert_eq!(metadata.last_completed_at, "2026-05-02T00:00:00.000Z");
}

#[tokio::test]
async fn promotion_enforces_private_permissions_under_permissive_umask() {
    for mask in ["0022", "0002", "0000"] {
        run_ignored_child_test(
            "workspace_image_cache::tests::promotion::promotion_enforces_private_permissions_under_permissive_umask_child",
            (PERMISSIVE_UMASK_CHILD_ENV, "1"),
            &[(PUBLICATION_UMASK_ENV, Some(mask))],
            Duration::from_secs(60),
        )
        .await;
    }
}

#[test]
#[ignore]
fn promotion_enforces_private_permissions_under_permissive_umask_child() {
    if !ignored_child_test_env_guard_enabled((PERMISSIVE_UMASK_CHILD_ENV, "1")) {
        return;
    }

    let mask = u32::from_str_radix(&std::env::var(PUBLICATION_UMASK_ENV).unwrap(), 8).unwrap();
    let _umask = UmaskGuard::set(Mode::from_bits_truncate(mask));
    let source_mode = if mask == 0o022 { 0o644 } else { 0o600 };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_promotion_private_permissions(source_mode));
}

async fn assert_promotion_private_permissions(source_mode: u32) {
    let (dir, paths, cache) = local_cache().await;
    fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    fs::set_permissions(paths.base_dir(), std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-private-permissions";
    let image = b"private workspace image";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    runner_host::host_file::ensure_dir(
        active_image.parent().unwrap(),
        runner_host::host_file::DirMode::Private,
        "test workspace directory",
    )
    .unwrap();
    fs::write(&active_image, image).await.unwrap();
    fs::set_permissions(&active_image, std::fs::Permissions::from_mode(source_mode))
        .await
        .unwrap();
    let active_metadata = fs::metadata(&active_image).await.unwrap();
    let active_identity = (active_metadata.dev(), active_metadata.ino());

    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        reuse_key,
        "/workspace",
        image.len() as u64,
    );
    let entry_dir = cache.workspace_image_cache_entry_dir(&cache_key);
    let current = cache.workspace_image_cache_current_image(&cache_key);
    let metadata = cache.workspace_image_cache_metadata(&cache_key);
    let current_metadata = fs::metadata(&current).await.unwrap();
    assert_eq!(
        active_identity,
        (current_metadata.dev(), current_metadata.ino())
    );
    assert_eq!(mode(cache.workspace_image_cache_dir()), 0o700);
    assert_eq!(mode(&entry_dir), 0o700);
    assert_eq!(mode(&current), 0o600);
    assert_eq!(mode(&metadata), 0o600);

    let next_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(next_lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert_eq!(fs::read(&current).await.unwrap(), image);
}

#[tokio::test]
async fn cross_filesystem_promotion_falls_back_to_sparse_copy() {
    let (_runner_dir, _cache_dir, paths, cache) = cross_filesystem_cache(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    })
    .await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-cross-filesystem";
    let image = vec![b'x'; 4096];
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
    let active_image = paths.active_workspace_image(&sandbox_id);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::write(&active_image, &image).await.unwrap();
    fs::set_permissions(&active_image, std::fs::Permissions::from_mode(0o644))
        .await
        .unwrap();

    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    assert_eq!(
        fs::read(&active_image).await.unwrap(),
        image,
        "cross-filesystem fallback must retain the source image"
    );
    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        reuse_key,
        "/workspace",
        image.len() as u64,
    );
    let current = cache.workspace_image_cache_current_image(&cache_key);
    assert_eq!(fs::read(&current).await.unwrap(), image);
    assert_ne!(
        fs::metadata(&active_image).await.unwrap().dev(),
        fs::metadata(&current).await.unwrap().dev()
    );
    assert_eq!(mode(cache.workspace_image_cache_dir()), 0o700);
    assert_eq!(
        mode(&cache.workspace_image_cache_entry_dir(&cache_key)),
        0o700
    );
    assert_eq!(mode(&current), 0o600);
    assert_eq!(
        mode(&cache.workspace_image_cache_metadata(&cache_key)),
        0o600
    );
}

#[tokio::test]
async fn promotion_rejects_group_writable_image_without_publishing_metadata() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-group-writable-image";
    let image = b"unsafe workspace image";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::write(&active_image, image).await.unwrap();
    fs::set_permissions(&active_image, std::fs::Permissions::from_mode(0o660))
        .await
        .unwrap();

    let error = lease
        .promote(
            run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-02T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap_err();

    assert!(error.to_string().contains("group/other writable"));
    assert!(active_image.exists());
    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        reuse_key,
        "/workspace",
        image.len() as u64,
    );
    assert!(
        !cache
            .workspace_image_cache_current_image(&cache_key)
            .exists()
    );
    assert!(!cache.workspace_image_cache_metadata(&cache_key).exists());
}

#[tokio::test]
async fn cross_filesystem_promotion_still_requires_copy_headroom() {
    let min_free = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_AVAILABLE_BYTES,
    })
    .min_free_bytes;
    let (_runner_dir, _cache_dir, paths, cache) = cross_filesystem_cache(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: min_free,
    })
    .await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-cross-filesystem-headroom";
    let image = vec![b'x'; 4096];
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: image.len() as u64,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    fs::write(&active_image, &image).await.unwrap();

    assert!(
        !lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "cross-filesystem sparse-copy fallback must preserve duplicate-copy headroom admission"
    );
    assert!(fs::try_exists(&active_image).await.unwrap());
    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        reuse_key,
        "/workspace",
        image.len() as u64,
    );
    assert!(
        !fs::try_exists(cache.workspace_image_cache_current_image(&cache_key))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn lock_busy_checkout_cannot_promote_without_entry_lock() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 1024);
    let _held_lock = runner_host::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 1024,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::LockBusy);
    assert!(
        !lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                local_timestamp(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    assert!(
        !cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
}

#[tokio::test]
async fn promotion_context_keeps_entry_locked_until_reused_active_lease_drops() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-locked-context";
    let image_size_bytes = 16 * 1024 * 1024;

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);

    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: local_timestamp(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let blocked_by_context = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        blocked_by_context.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace",
            image_size_bytes,
        })
        .unwrap();
    let active_lease = promotion.try_into_active_lease(&expected, true).unwrap();

    let blocked_by_active_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        blocked_by_active_lease.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );

    drop(active_lease);
    let after_drop = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(after_drop.result(), WorkspaceCacheCheckoutResult::Miss);
}

#[tokio::test]
async fn promotion_context_validates_expected_identity() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-identity";
    let image_size_bytes = 16 * 1024 * 1024;

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace//repo/",
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: local_timestamp(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(promotion.validate_identity(&expected), Ok(()));

    let wrong_sandbox = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id: sandbox::SandboxId::new_v4(),
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_sandbox),
        Err(WorkspaceImagePromotionIdentityMismatch::SandboxId),
    );

    let wrong_reuse_key = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key: "sess-other",
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_reuse_key),
        Err(WorkspaceImagePromotionIdentityMismatch::ReuseKey),
    );

    let wrong_size = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace/repo",
            image_size_bytes: image_size_bytes + 1,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_size),
        Err(WorkspaceImagePromotionIdentityMismatch::ImageSizeBytes),
    );

    let scoped_cache = WorkspaceImageCache::with_cache_dirs(
        paths.clone(),
        crate::test_fixtures::runner_workspace_image_cache_dir(&paths),
        paths.base_dir().join("locks"),
        "other-scope",
    );
    let wrong_cache_key = scoped_cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace/repo",
            image_size_bytes,
        })
        .unwrap();
    assert_eq!(
        promotion.validate_identity(&wrong_cache_key),
        Err(WorkspaceImagePromotionIdentityMismatch::CacheKey),
    );

    assert_eq!(
        cache.expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/",
            image_size_bytes,
        }),
        Err(WorkspaceImagePromotionIdentityMismatch::UnsafeWorkingDir),
    );
}

#[tokio::test]
async fn promote_skips_symlink_active_image_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-active-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let outside_image = dir.path().join("outside-active.ext4");
    tokio::fs::write(&outside_image, b"image").await.unwrap();
    std::os::unix::fs::symlink(&outside_image, &active_image).unwrap();

    let promoted = lease
        .promote(
            run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    let cache_key = workspace_image_cache_key(reuse_key, "/workspace");
    assert!(!promoted);
    assert!(
        !cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
    assert_eq!(tokio::fs::read(&outside_image).await.unwrap(), b"image");
    assert!(
        tokio::fs::symlink_metadata(&active_image)
            .await
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn promote_replaces_symlink_cache_entry_dir_without_following_it() {
    let (dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-promote-entry-symlink";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"image").await.unwrap();
    let cache_key = workspace_image_cache_key(reuse_key, "/workspace");
    let entry_dir = cache.entry_paths(&cache_key).entry_dir().to_path_buf();
    let outside_entry = dir.path().join("outside-promotion-entry");
    tokio::fs::create_dir_all(&outside_entry).await.unwrap();
    tokio::fs::write(outside_entry.join("marker"), b"marker")
        .await
        .unwrap();
    tokio::fs::create_dir_all(entry_dir.parent().unwrap())
        .await
        .unwrap();
    std::os::unix::fs::symlink(&outside_entry, &entry_dir).unwrap();

    let promoted = lease
        .promote(
            run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    let entry_metadata = fs::symlink_metadata(&entry_dir).await.unwrap();
    assert!(promoted);
    assert!(entry_metadata.is_dir());
    assert!(!entry_metadata.file_type().is_symlink());
    assert_eq!(
        fs::read(cache.entry_paths(&cache_key).current_image().to_path_buf())
            .await
            .unwrap(),
        b"image"
    );
    assert!(!outside_entry.join("current.ext4").exists());
    assert_eq!(
        fs::read(outside_entry.join("marker")).await.unwrap(),
        b"marker"
    );
}

#[tokio::test]
async fn promote_removes_current_image_when_metadata_write_fails() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
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
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::write(&active_image, b"image").await.unwrap();

    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    let metadata_path = cache.entry_paths(&cache_key).metadata().to_path_buf();
    tokio::fs::create_dir_all(&metadata_path).await.unwrap();

    let err = lease
        .promote(
            run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap_err();

    assert!(matches!(err, LifecycleError::Io(_)));
    assert!(
        !active_image.exists(),
        "metadata failure after ownership transfer must not leave a second active image"
    );
    assert!(
        !cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
    assert!(!cache.entry_paths(&cache_key).tmp_image(run_id).exists());
    assert!(!cache.entry_paths(&cache_key).tmp_metadata(run_id).exists());
}

#[tokio::test]
async fn promote_removes_stale_temporary_directory_before_transfer() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
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
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    let tmp = cache.entry_paths(&cache_key).tmp_image(run_id);
    tokio::fs::create_dir_all(&tmp).await.unwrap();
    tokio::fs::write(tmp.join("stale"), b"stale").await.unwrap();

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

    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    assert!(!tmp.exists());
    assert!(fs::metadata(&current).await.unwrap().is_file());
    assert_eq!(fs::read(current).await.unwrap(), b"image");
}

#[tokio::test]
async fn promote_replaces_stale_current_directory_before_rename() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
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
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    tokio::fs::create_dir_all(&current).await.unwrap();
    tokio::fs::write(current.join("stale"), b"stale")
        .await
        .unwrap();

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

    assert!(fs::metadata(&current).await.unwrap().is_file());
    assert_eq!(fs::read(current).await.unwrap(), b"image");
}

#[tokio::test]
async fn promote_skips_transferred_image_with_unexpected_logical_size() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-size-mismatch"),
                working_dir: "/workspace",
                image_size_bytes: 16 * 1024 * 1024,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"truncated")
        .await
        .unwrap();
    let cache_key = workspace_image_cache_key("sess-size-mismatch", "/workspace");

    assert!(
        !lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
    assert!(
        !cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
    assert!(cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn promote_skips_when_capacity_lock_is_busy() {
    let (_dir, paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-capacity-lock"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    tokio::fs::write(paths.active_workspace_image(&sandbox_id), b"image")
        .await
        .unwrap();
    let cache_key = workspace_image_cache_key("sess-capacity-lock", "/workspace");
    let _capacity_lock = runner_host::lock::acquire(cache.capacity_lock_path())
        .await
        .unwrap();

    let promoted = lease
        .promote(
            run_id,
            WorkspaceCacheTerminalStatus::Success,
            "2026-05-01T00:00:00.000Z".into(),
            &StorageFingerprints::default(),
        )
        .await
        .unwrap();

    assert!(!promoted);
    assert!(
        !cache
            .entry_paths(&cache_key)
            .current_image()
            .to_path_buf()
            .exists()
    );
    assert!(cache.held_workspace_states().await.is_empty());
}

#[tokio::test]
async fn no_reuse_key_checkout_has_no_promotion_context() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoReuseKey);
    assert!(
        lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:00.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .is_none(),
        "workspace image promotion requires a reuse key"
    );
}

#[tokio::test]
async fn no_lock_promotion_context_survives_reuse_active_lease() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "thread:reused-unlocked-context";
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace//repo/",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    let promotion = lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-05-01T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();

    let expected = cache
        .expected_promotion_identity(WorkspaceImagePromotionIdentityRequest {
            sandbox_id,
            profile_name: TEST_PROFILE_NAME,
            reuse_key,
            working_dir: "/workspace//repo/",
            image_size_bytes: 5,
        })
        .unwrap();
    let active_lease = promotion.try_into_active_lease(&expected, true).unwrap();

    assert_eq!(active_lease.working_dir(), "/workspace/repo");
    assert!(
        active_lease
            .into_promotion_context(WorkspaceImagePromotionRequest {
                run_id: RunId::new_v4(),
                sandbox_id,
                restored_session_identity: None,
                terminal_status: WorkspaceCacheTerminalStatus::Success,
                completed_at: "2026-05-01T00:00:01.000Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .is_some(),
        "converting an unlocked promotion context back into an active lease must preserve future cache promotion"
    );
}
