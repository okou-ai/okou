use std::future::{Future as _, poll_fn};
use std::sync::mpsc;
use std::task::Poll;
use std::time::Duration;

use tokio::fs;

use super::super::fs::{allocated_bytes, local_timestamp};
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::{
    CACHE_FORMAT_VERSION, CacheBudget, FsStats, TEST_FS_TOTAL_BYTES, WORKSPACE_DRIVE_LAYOUT,
    WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus, WorkspaceImageActiveLeaseRequest,
    WorkspaceImageCache, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareLockTestGate,
    WorkspaceImagePrepareRequest, WorkspaceImagePromotionRequest,
};
use super::support::{TEST_PROFILE_NAME, local_cache, write_current_cache_entry};
use crate::storage_fingerprints::StorageFingerprints;
use crate::test_fixtures::workspace_image_cache_key;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::ids::RunId;

#[tokio::test]
async fn thread_cache_is_reusable_across_runs() {
    let (_dir, paths, cache) = local_cache().await;
    let reuse_key = "thread:chat-thread";
    let first_run_id = RunId::new_v4();
    let first_sandbox_id = sandbox::SandboxId::new_v4();
    let first = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: first_run_id,
                sandbox_id: first_sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(first.result(), WorkspaceCacheCheckoutResult::Miss);
    let active_image = paths.active_workspace_image(&first_sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, b"image").await.unwrap();
    assert!(
        first
            .promote(
                first_run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-01T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );

    let rotated = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(rotated.result(), WorkspaceCacheCheckoutResult::Hit);
}

#[tokio::test]
async fn shared_cache_is_reusable_across_runner_base_dirs() {
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
    let cache_a = WorkspaceImageCache::shared(runner_a.clone(), &home, "test-group");
    let cache_b = WorkspaceImageCache::shared(runner_b.clone(), &home, "test-group");
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
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
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

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Hit);
    let seed = checkout
        .workspace_drive_config()
        .and_then(|config| config.seed_image)
        .expect("shared checkout should seed from the host-level workspace image cache");
    match seed {
        sandbox::WorkspaceDriveSeedImage::Move(path) => assert!(
            path.starts_with(home.workspace_image_cache_dir()),
            "shared checkout must move from the host-level workspace image cache"
        ),
        other => panic!("shared checkout should use a move seed, got {other:?}"),
    }
    let key = cache_b.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace", 5);
    assert!(
        !cache_b.entry_paths(&key).metadata().exists(),
        "move checkout must remove reusable cache metadata"
    );
}

#[tokio::test]
async fn cache_hit_removes_metadata_and_returns_move_seed() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-hit",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    let image_size = fs::metadata(&current).await.unwrap().len();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-move-hit"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert!(lease.consumed_cache_hit);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        Some(sandbox::WorkspaceDriveSeedImage::Move(current.clone()))
    );
    assert!(current.exists());
    assert!(matches!(
        fs::metadata(cache.entry_paths(&key).metadata().to_path_buf()).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    ));
}

#[tokio::test]
async fn consumed_cache_hit_invalidation_tolerates_missing_current() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let key = write_current_cache_entry(
        &cache,
        run_id,
        "sess-move-invalidate",
        "/workspace",
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
    )
    .await;
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    let image_size = fs::metadata(&current).await.unwrap().len();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-move-invalidate"),
                working_dir: "/workspace",
                image_size_bytes: image_size,
            },
            workspace_drive_required: true,
        })
        .await;
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    fs::remove_file(&current).await.unwrap();

    assert!(
        lease
            .invalidate(run_id, "test consumed cache hit failure")
            .await
            .unwrap()
    );
    assert!(!cache.entry_paths(&key).entry_dir().to_path_buf().exists());
}

#[test]
fn prepare_waits_for_initial_lock_attempt_before_contention_timeout() {
    const BLOCKER_WATCHDOG: Duration = Duration::from_secs(1);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();

    runtime.block_on(async {
        tokio::time::pause();
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        std::fs::create_dir_all(paths.base_dir()).unwrap();
        let cache = WorkspaceImageCache::new(paths);
        let (blocker_started_tx, blocker_started_rx) = mpsc::channel();
        let (release_blocker_tx, release_blocker_rx) = mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            blocker_started_tx.send(()).unwrap();
            release_blocker_rx.recv().unwrap();
        });
        blocker_started_rx
            .recv_timeout(BLOCKER_WATCHDOG)
            .expect("blocking-pool blocker should start");

        let mut prepare = Box::pin(cache.prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-delayed-first-lock-attempt"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        }));
        let initial_poll = poll_fn(|context| Poll::Ready(prepare.as_mut().poll(context))).await;
        assert!(initial_poll.is_pending());

        tokio::time::advance(Duration::from_secs(1)).await;
        match poll_fn(|context| Poll::Ready(prepare.as_mut().poll(context))).await {
            Poll::Pending => {}
            Poll::Ready(lease) => {
                release_blocker_tx.send(()).unwrap();
                blocker.await.unwrap();
                panic!(
                    "pre-attempt blocking-pool delay completed prepare as {:?}",
                    lease.result()
                );
            }
        }

        release_blocker_tx.send(()).unwrap();
        blocker.await.unwrap();
        let lease = prepare.await;

        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
        assert!(lease.cache_key.is_some());
    });
}

#[tokio::test]
async fn shared_cache_same_key_lock_blocks_other_runner_without_deadlock() {
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
    let cache_a = WorkspaceImageCache::shared(runner_a, &home, "test-group");
    let cache_b = WorkspaceImageCache::shared(runner_b, &home, "test-group");

    let lease_a = cache_a
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(lease_a.result(), WorkspaceCacheCheckoutResult::Miss);

    let blocked_checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        blocked_checkout.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );
    assert!(blocked_checkout.cache_key.is_none());
    assert!(blocked_checkout.source_image.is_none());
    assert!(
        blocked_checkout.workspace_drive_config().is_some(),
        "lock contention should fall back to a fresh workspace image"
    );

    drop(lease_a);
    let checkout_after_drop = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        checkout_after_drop.result(),
        WorkspaceCacheCheckoutResult::Miss
    );
}

#[tokio::test]
async fn shared_cache_is_scoped_by_runner_group() {
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
    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Miss);
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

    let checkout = cache_b
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(checkout.result(), WorkspaceCacheCheckoutResult::Miss);
    assert!(checkout.source_image.is_none());
    assert!(
        cache_b.held_workspace_states().await.is_empty(),
        "a runner must not advertise workspace cache entries from another group"
    );
}

#[tokio::test]
async fn prepare_returns_disk_pressure_without_cache_or_promotion() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let min_free_bytes = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_TOTAL_BYTES,
    })
    .min_free_bytes;
    let cache = WorkspaceImageCache::new_with_fs_stats(
        paths,
        FsStats {
            total_bytes: TEST_FS_TOTAL_BYTES,
            available_bytes: min_free_bytes.saturating_sub(1),
        },
    );
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let reuse_key = "sess-disk-pressure";
    let working_dir = "/workspace";
    let image_size_bytes = 5;
    let cache_key =
        cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, working_dir, image_size_bytes);

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir,
                image_size_bytes,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::DiskPressure);
    assert!(lease.cache_key.is_none());
    assert!(lease.source_image.is_none());
    assert!(
        lease
            .workspace_drive_config()
            .expect("disk pressure should fall back to a fresh workspace drive")
            .seed_image
            .is_none(),
        "disk pressure fallback should not seed the fresh workspace drive"
    );
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
        "disk pressure should disable workspace image promotion"
    );
    assert!(
        !fs::try_exists(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
            .await
            .unwrap(),
        "disk pressure should not publish a workspace cache entry"
    );
}

#[tokio::test]
async fn cache_hit_checkout_and_same_filesystem_promotion_do_not_require_copy_headroom() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let setup_cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let image = vec![1_u8; 4096];
    let cache_key = setup_cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        image.len() as u64,
    );
    tokio::fs::create_dir_all(
        setup_cache
            .entry_paths(&cache_key)
            .entry_dir()
            .to_path_buf(),
    )
    .await
    .unwrap();
    let current = setup_cache
        .entry_paths(&cache_key)
        .current_image()
        .to_path_buf();
    tokio::fs::write(&current, &image).await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    let actual_allocated_bytes = allocated_bytes(&current_metadata);
    assert!(
        actual_allocated_bytes > 0,
        "test filesystem must report allocated blocks for the cache image"
    );
    setup_cache
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
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: 0,
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();
    let min_free = CacheBudget::from_fs_stats(FsStats {
        total_bytes: TEST_FS_TOTAL_BYTES,
        available_bytes: TEST_FS_TOTAL_BYTES,
    })
    .min_free_bytes;
    let cache = WorkspaceImageCache::new_with_fs_stats(
        paths.clone(),
        FsStats {
            total_bytes: TEST_FS_TOTAL_BYTES,
            available_bytes: min_free.saturating_add(actual_allocated_bytes - 1),
        },
    );

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: current_metadata.len(),
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::Hit);
    assert_eq!(
        lease
            .workspace_drive_config()
            .and_then(|config| config.seed_image),
        Some(sandbox::WorkspaceDriveSeedImage::Move(current.clone()))
    );
    assert!(
        tokio::fs::try_exists(&current).await.unwrap(),
        "move checkout keeps the source in place until sandbox preparation consumes it"
    );
    assert!(
        !tokio::fs::try_exists(cache.entry_paths(&cache_key).metadata().to_path_buf())
            .await
            .unwrap(),
        "move checkout removes metadata before handing the current image to sandbox preparation"
    );
    tokio::fs::create_dir_all(paths.workspace_dir(&sandbox_id))
        .await
        .unwrap();
    let active_image = paths.active_workspace_image(&sandbox_id);
    tokio::fs::rename(&current, &active_image).await.unwrap();

    assert!(
        lease
            .promote(
                run_id,
                WorkspaceCacheTerminalStatus::Success,
                "2026-05-02T00:00:00.000Z".into(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "same-filesystem ownership transfer must not require duplicate-copy headroom"
    );
    assert!(
        tokio::fs::try_exists(&current).await.unwrap(),
        "same-filesystem promotion must publish the moved image"
    );
    assert!(
        !tokio::fs::try_exists(&active_image).await.unwrap(),
        "same-filesystem promotion must consume the active image"
    );
}

#[tokio::test]
async fn active_lease_hides_cached_reuse_key_until_dropped() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let cache_key = workspace_image_cache_key("sess-1", "/workspace");
    tokio::fs::create_dir_all(cache.entry_paths(&cache_key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&cache_key).current_image().to_path_buf();
    tokio::fs::write(&current, b"image").await.unwrap();
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
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: 5,
                allocated_bytes: 5,
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    assert_eq!(cache.held_workspace_states().await.len(), 1);

    let lease = cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_available: true,
        })
        .await;

    assert!(cache.held_workspace_states().await.is_empty());
    drop(lease);
    assert_eq!(cache.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn lock_busy_checkout_reports_local_active_and_finalizing_owners() {
    let (_dir, _paths, cache) = local_cache().await;
    let reuse_key = "thread:local-lock-owner";
    let sandbox_id = sandbox::SandboxId::new_v4();
    let active_lease = cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_available: true,
        })
        .await;

    let active_contender = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        active_contender.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );
    assert_eq!(
        active_contender.lock_outcome_and_reason(),
        Some(("busy", Some("active")))
    );

    let promotion = active_lease
        .into_promotion_context(WorkspaceImagePromotionRequest {
            run_id: RunId::new_v4(),
            sandbox_id,
            restored_session_identity: None,
            terminal_status: WorkspaceCacheTerminalStatus::Success,
            completed_at: "2026-09-03T00:00:00.000Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .expect("active lease should retain a promotion target");
    let finalizing_contender = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;
    assert_eq!(
        finalizing_contender.result(),
        WorkspaceCacheCheckoutResult::LockBusy
    );
    assert_eq!(
        finalizing_contender.lock_outcome_and_reason(),
        Some(("busy", Some("finalizing")))
    );
    drop(promotion);
}

#[tokio::test]
async fn lock_busy_checkout_reports_unknown_for_another_cache_instance() {
    let (_dir, paths, owner_cache) = local_cache().await;
    let contender_cache = WorkspaceImageCache::new_with_fs_stats(
        paths,
        FsStats {
            total_bytes: TEST_FS_TOTAL_BYTES,
            available_bytes: TEST_FS_TOTAL_BYTES,
        },
    );
    let reuse_key = "thread:cross-instance-lock-owner";
    let _active_lease = owner_cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_available: true,
        })
        .await;

    let contender = contender_cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(contender.result(), WorkspaceCacheCheckoutResult::LockBusy);
    assert_eq!(
        contender.lock_outcome_and_reason(),
        Some(("busy", Some("unknown")))
    );
}

#[tokio::test]
async fn lock_busy_checkout_does_not_attribute_an_owner_acquired_after_the_first_attempt() {
    let (_dir, _paths, cache) = local_cache().await;
    let reuse_key = "thread:changed-lock-owner";
    let cache_key = workspace_image_cache_key(reuse_key, "/workspace");
    let external_lock = runner_host::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();
    let prepare_lock_gate = WorkspaceImagePrepareLockTestGate::default();
    let contender_cache = cache
        .clone()
        .with_prepare_lock_test_gate(prepare_lock_gate.clone());
    let contender = tokio::spawn(async move {
        contender_cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id: RunId::new_v4(),
                    sandbox_id: sandbox::SandboxId::new_v4(),
                    profile_name: TEST_PROFILE_NAME,
                    reuse_key: Some(reuse_key),
                    working_dir: "/workspace",
                    image_size_bytes: 5,
                },
                workspace_drive_required: false,
            })
            .await
    });
    prepare_lock_gate.wait_entered(Duration::from_secs(1)).await;

    drop(external_lock);
    let _replacement_owner = cache
        .lease_active(WorkspaceImageActiveLeaseRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some(reuse_key),
                working_dir: "/workspace",
                image_size_bytes: 5,
            },
            workspace_drive_available: true,
        })
        .await;
    prepare_lock_gate.release();
    let contender = contender.await.unwrap();

    assert_eq!(contender.result(), WorkspaceCacheCheckoutResult::LockBusy);
    assert_eq!(
        contender.lock_outcome_and_reason(),
        Some(("busy", Some("unknown")))
    );
}
