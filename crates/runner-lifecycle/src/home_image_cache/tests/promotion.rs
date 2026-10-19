use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use sha2::{Digest, Sha256};
use std::error::Error;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, symlink};
use std::time::Duration;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn immutable_generation_replaces_metadata_then_retires_superseded_image() {
    let f = Fixture::new().await;
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
        .await;
    let old_path = f.image("thread", &old);
    let captured = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    let new = f
        .commit("thread", b"new-home", "2026-10-09T09:01:00Z")
        .await;
    drop(guard);
    let events = captured.entries();
    let published: Vec<_> = events
        .iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str) == Some("home image cache promoted")
        })
        .collect();
    assert_eq!(published.len(), 1);
    let event = published.first().unwrap();
    assert_eq!(event.fields.get("run_id"), Some(&new.image_generation));
    assert_eq!(
        event.fields.get("image_generation"),
        Some(&new.image_generation)
    );
    assert_eq!(event.fields.get("cache_key"), Some(&f.key("thread")));
    assert_eq!(
        event.fields.get("image_size_bytes"),
        Some(&SIZE.to_string())
    );
    assert_ne!(old.image_generation, new.image_generation);
    assert_ne!(old_path, f.image("thread", &new));
    assert!(!old_path.exists());
    let bytes = tokio::fs::read(f.image("thread", &new)).await.unwrap();
    assert_eq!(&bytes[4096..4104], b"new-home");
    assert_eq!(new.current_image.len, SIZE);
    assert_eq!(
        new.allocated_bytes,
        std::fs::metadata(f.image("thread", &new)).unwrap().blocks() * 512
    );
}

#[tokio::test]
async fn missing_staging_image_reports_transfer_context_and_preserves_previous_commit() {
    let f = Fixture::new().await;
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
        .await;
    let old_path = f.image("thread", &old);
    let old_bytes = tokio::fs::read(&old_path).await.unwrap();
    let old_metadata_bytes = tokio::fs::read(f.cache.entry_paths(&f.key("thread")).metadata())
        .await
        .unwrap();
    let context = f
        .context(
            "thread",
            b"new-home",
            "2026-10-09T09:01:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let staging = paths.tmp_image(context.run_id());
    let candidate = paths.image(&context.publication_generation()).unwrap();
    // Controlled diagnostic trigger, not attribution of the original native failure.
    f.cache.inner.publication_fault.store(
        PublicationFault::RemoveStagingBeforeImageRename as usize,
        std::sync::atomic::Ordering::SeqCst,
    );

    let error = context.promote().await.unwrap_err();
    let LifecycleError::Io(error) = error else {
        panic!("expected a filesystem error, got {error}");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    let original = error
        .source()
        .and_then(|source| source.downcast_ref::<std::io::Error>())
        .expect("original rename errno must remain available");
    assert_eq!(original.raw_os_error(), Some(libc::ENOENT));
    let message = error.to_string();
    assert!(message.contains("renameat2(RENAME_NOREPLACE)"));
    assert!(message.contains(&format!(
        "source_path_id={}",
        hex::encode(Sha256::digest(staging.as_os_str().as_bytes()))
    )));
    assert!(message.contains(&format!(
        "destination_path_id={}",
        hex::encode(Sha256::digest(candidate.as_os_str().as_bytes()))
    )));
    assert!(!message.contains(staging.to_string_lossy().as_ref()));
    assert!(!message.contains(candidate.to_string_lossy().as_ref()));
    drop(context);

    assert_eq!(
        f.metadata("thread").await.image_generation,
        old.image_generation
    );
    assert_eq!(tokio::fs::read(&old_path).await.unwrap(), old_bytes);
    assert_eq!(
        tokio::fs::read(paths.metadata()).await.unwrap(),
        old_metadata_bytes
    );
    assert!(!candidate.exists());
}

#[tokio::test]
async fn each_publication_crash_window_preserves_a_complete_old_or_new_commit() {
    for point in [
        PublicationFault::BeforeImageSync,
        PublicationFault::AfterImageSync,
        PublicationFault::BeforeMetadataRename,
        PublicationFault::AfterMetadataRename,
    ] {
        let f = Fixture::new().await;
        let old = f
            .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
            .await;
        let context = f
            .context(
                "thread",
                b"new-home",
                "2026-10-09T09:01:00Z",
                HomeCacheTerminalStatus::Success,
                StorageFingerprints::default(),
            )
            .await;
        let generation = context.publication_generation();
        f.cache
            .inner
            .publication_fault
            .store(point as usize, std::sync::atomic::Ordering::SeqCst);
        let captured = CapturedEvents::default();
        let guard =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        assert!(context.promote().await.is_err());
        drop(guard);
        assert!(captured.entries().iter().all(|event| {
            event.fields.get("message").map(String::as_str) != Some("home image cache promoted")
        }));
        drop(context);
        let observed = f.metadata("thread").await;
        let bytes = tokio::fs::read(f.image("thread", &observed)).await.unwrap();
        if point == PublicationFault::AfterMetadataRename {
            assert_eq!(observed.image_generation, generation);
            assert_eq!(&bytes[4096..4104], b"new-home");
        } else {
            assert_eq!(observed.image_generation, old.image_generation);
            assert_eq!(&bytes[4096..4104], b"old-home");
        }
        // The old immutable bytes are never overwritten, even after late commit.
        let old_bytes = tokio::fs::read(f.image("thread", &old)).await.unwrap();
        assert_eq!(&old_bytes[4096..4104], b"old-home");
        let before = f.cache.total_cache_allocated_bytes().await.unwrap();
        let freed = f.cache.gc(false).await.unwrap();
        assert!(freed > 0);
        assert!(f.cache.total_cache_allocated_bytes().await.unwrap() < before);
        assert_eq!(
            f.metadata("thread").await.image_generation,
            observed.image_generation
        );
    }
}

#[tokio::test]
async fn older_or_equal_terminal_time_preserves_existing_bytes() {
    let f = Fixture::new().await;
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:02:00Z")
        .await;
    for timestamp in ["2026-10-09T09:01:00Z", "2026-10-09T09:02:00Z"] {
        let context = f
            .context(
                "thread",
                b"unpublished",
                timestamp,
                HomeCacheTerminalStatus::Success,
                StorageFingerprints::default(),
            )
            .await;
        assert_eq!(
            context.promote().await.unwrap(),
            HomeImagePromotionOutcome::PreservedExisting
        );
        assert!(f.paths.active_home_image(&context.sandbox_id()).exists());
        drop(context);
        assert_eq!(
            f.metadata("thread").await.image_generation,
            old.image_generation
        );
    }
}

#[tokio::test]
async fn transient_io_contention_publishes_an_intact_reusable_home() {
    let f = Fixture::new().await;
    let context = f
        .context(
            "thread",
            b"reusable-home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    f.cache
        .inner
        .publication_admission_entered
        .forget_permits(usize::MAX);
    // Saturate the real IO owner while the accepted publisher retains its entry.
    let io = f
        .cache
        .inner
        .publication_admission
        .acquire_many(4)
        .await
        .unwrap();
    let entered = &f.cache.inner.publication_admission_entered;
    let mut promotion = Box::pin(context.promote());
    tokio::select! {
        result = promotion.as_mut() => panic!("publication returned before IO admission: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), entered.acquire()) => {
            result.expect("publisher must reach IO admission").unwrap().forget();
        }
    }
    assert_eq!(tokio::fs::read(&active).await.unwrap(), original);
    assert!(!f.cache.entry_paths(&f.key("thread")).metadata().exists());
    drop(io);
    assert_eq!(
        promotion.await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    assert!(!active.exists());
    drop(context);
    let mut lease = f.lease("thread").await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Hit);
    let Some(sandbox::HomeDriveSeedImage::Move(seed)) =
        lease.home_drive_config().await.unwrap().unwrap().seed_image
    else {
        panic!("published home must be consumable through the move-seed contract");
    };
    assert_eq!(tokio::fs::read(seed).await.unwrap(), original);
}

#[tokio::test]
async fn io_wait_keeps_entry_owned_and_unrelated_checkout_available() {
    let f = Fixture::new().await;
    let other = f
        .commit("other", b"other-home", "2026-10-09T09:00:00Z")
        .await;
    let other_bytes = tokio::fs::read(f.image("other", &other)).await.unwrap();
    let context = f
        .context(
            "thread",
            b"waiting-home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    f.cache
        .inner
        .publication_admission_entered
        .forget_permits(usize::MAX);
    // Saturate the real IO owner while the accepted publisher retains its entry.
    let io = f
        .cache
        .inner
        .publication_admission
        .acquire_many(4)
        .await
        .unwrap();
    let entered = &f.cache.inner.publication_admission_entered;
    let mut promotion = Box::pin(context.promote());
    tokio::select! {
        result = promotion.as_mut() => panic!("publication returned before IO admission: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), entered.acquire()) => {
            result.expect("publisher must reach IO admission").unwrap().forget();
        }
    }
    let same = f.lease("thread").await;
    assert_eq!(same.result(), HomeCacheCheckoutResult::LockBusy);
    let mut unrelated = f.lease("other").await;
    assert_eq!(unrelated.result(), HomeCacheCheckoutResult::Hit);
    let Some(sandbox::HomeDriveSeedImage::Move(seed)) = unrelated
        .home_drive_config()
        .await
        .unwrap()
        .unwrap()
        .seed_image
    else {
        panic!("unrelated committed home must remain consumable");
    };
    assert_eq!(tokio::fs::read(seed).await.unwrap(), other_bytes);
    drop(io);
    assert_eq!(
        promotion.await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
}

#[tokio::test]
async fn cancelled_io_wait_preserves_original_context_for_retry() {
    let f = Fixture::new().await;
    let context = f
        .context(
            "thread",
            b"owned-home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    f.cache
        .inner
        .publication_admission_entered
        .forget_permits(usize::MAX);
    // Saturate the real IO owner while the accepted publisher retains its entry.
    let io = f
        .cache
        .inner
        .publication_admission
        .acquire_many(4)
        .await
        .unwrap();
    let entered = &f.cache.inner.publication_admission_entered;
    let mut promotion = Box::pin(context.promote());
    tokio::select! {
        result = promotion.as_mut() => panic!("publication returned before IO admission: {result:?}"),
        result = tokio::time::timeout(Duration::from_secs(2), entered.acquire()) => {
            result.expect("publisher must reach IO admission").unwrap().forget();
        }
    }
    drop(promotion);
    assert_eq!(tokio::fs::read(&active).await.unwrap(), original);
    let paths = f.cache.entry_paths(&f.key("thread"));
    assert!(!paths.metadata().exists());
    assert!(!paths.tmp_image(context.run_id()).exists());
    assert!(
        !paths
            .image(&context.publication_generation())
            .unwrap()
            .exists()
    );
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.entry_lock_path(&f.key("thread")))
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    drop(io);
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(context);
    let mut lease = f.lease("thread").await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Hit);
    let Some(sandbox::HomeDriveSeedImage::Move(seed)) =
        lease.home_drive_config().await.unwrap().unwrap().seed_image
    else {
        panic!("retried home must be consumable through the move-seed contract");
    };
    assert_eq!(tokio::fs::read(seed).await.unwrap(), original);
}

#[tokio::test]
async fn closed_io_admission_preserves_the_unpublished_source() {
    let f = Fixture::new().await;
    let context = f
        .context(
            "thread",
            b"unpublished",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    f.cache.inner.publication_admission.close();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert_eq!(tokio::fs::read(active).await.unwrap(), original);
    assert!(!f.cache.entry_paths(&f.key("thread")).metadata().exists());
}

#[tokio::test]
async fn promotion_rejects_wrong_shape_symlink_and_replaced_pinned_source() {
    let f = Fixture::new().await;
    let old = f
        .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
        .await;
    let context = f
        .context(
            "thread",
            b"new-home",
            "2026-10-09T09:01:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let active = f.paths.active_home_image(&context.sandbox_id());
    std::fs::OpenOptions::new()
        .write(true)
        .open(&active)
        .unwrap()
        .set_len(SIZE * 2)
        .unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    std::fs::remove_file(&active).unwrap();
    symlink(f.image("thread", &old), &active).unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    drop(context);
    assert_eq!(
        f.metadata("thread").await.image_generation,
        old.image_generation
    );
    let pin = super::super::fs::PinnedImage::open(&f.image("thread", &old), SIZE).unwrap();
    let displaced = f.dir.path().join("displaced");
    std::fs::rename(f.image("thread", &old), &displaced).unwrap();
    write_image(&f.image("thread", &old), b"different", SIZE);
    assert!(pin.validate_path(&f.image("thread", &old)).is_err());
}

#[tokio::test]
async fn publication_generation_cannot_overwrite_an_owned_orphan_of_same_run() {
    let f = Fixture::new().await;
    let context = f
        .context(
            "thread",
            b"source",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let key = f.key("thread");
    f.cache.ensure_home_cache_entry_dir(&key).await.unwrap();
    let orphan = f
        .cache
        .entry_paths(&key)
        .image(&context.publication_generation())
        .unwrap();
    write_image(&orphan, b"owned-orphan", SIZE);
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert_eq!(
        &std::fs::read(&orphan).unwrap()[4096..4108],
        b"owned-orphan"
    );
    assert!(!f.cache.entry_paths(&key).metadata().exists());
}

#[tokio::test]
async fn cross_device_interrupted_transfer_keeps_source_and_old_commit_or_complete_new_commit() {
    for fault in [
        PublicationFault::BeforeImageSync,
        PublicationFault::AfterImageSync,
        PublicationFault::BeforeMetadataRename,
        PublicationFault::AfterMetadataRename,
    ] {
        let active_root = tempfile::tempdir_in("/dev/shm").unwrap();
        let f = Fixture::new().await;
        let old = f
            .commit("thread", b"old-home", "2026-10-09T09:00:00Z")
            .await;
        let paths = runner_host::paths::RunnerPaths::new(active_root.path().join("runner"));
        let cache = HomeImageCache::shared(
            paths.clone(),
            &runner_host::paths::HomePaths::with_root(f.dir.path().join("host")),
            "group-a",
        );
        assert_ne!(
            std::fs::metadata(active_root.path()).unwrap().dev(),
            std::fs::metadata(f.dir.path()).unwrap().dev()
        );
        let run_id = runner_types::ids::RunId::new_v4();
        let sandbox_id = sandbox::SandboxId::new_v4();
        let lease = cache
            .lease_active(HomeImageLeaseRequest {
                identity: HomeImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: PROFILE,
                    rootfs_hash: ROOTFS,
                    reuse_key: Some("thread"),
                    working_dir: CWD,
                    image_size_bytes: SIZE,
                },
                home_drive_available: true,
            })
            .await;
        let active = paths.active_home_image(&sandbox_id);
        write_image(&active, b"new-home", SIZE);
        let promotion = lease
            .into_promotion_context(HomeImagePromotionRequest {
                run_id,
                sandbox_id,
                restored_session_identity: None,
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: "2026-10-09T09:01:00Z".into(),
                storage_fingerprints: StorageFingerprints::default(),
            })
            .unwrap();
        cache
            .inner
            .publication_fault
            .store(fault as usize, std::sync::atomic::Ordering::SeqCst);
        assert!(promotion.promote().await.is_err());
        drop(promotion);
        assert_eq!(&std::fs::read(&active).unwrap()[4096..4104], b"new-home");
        let metadata = f.metadata("thread").await;
        let image = std::fs::read(f.image("thread", &metadata)).unwrap();
        if fault == PublicationFault::AfterMetadataRename {
            assert_eq!(metadata.image_generation, run_id.to_string());
            assert_eq!(&image[4096..4104], b"new-home");
        } else {
            assert_eq!(metadata.image_generation, old.image_generation);
            assert_eq!(&image[4096..4104], b"old-home");
        }
        assert_eq!(
            &std::fs::read(f.image("thread", &old)).unwrap()[4096..4104],
            b"old-home"
        );
        assert!(cache.gc(false).await.unwrap() > 0);
        assert_eq!(
            f.metadata("thread").await.image_generation,
            metadata.image_generation
        );
    }
}

#[tokio::test]
async fn cross_device_sparse_publication_preserves_shape_and_transfer_ownership() {
    let active_root = tempfile::tempdir_in("/dev/shm").unwrap();
    let f = Fixture::new().await;
    let paths = runner_host::paths::RunnerPaths::new(active_root.path().join("runner"));
    let cache = HomeImageCache::shared(
        paths.clone(),
        &runner_host::paths::HomePaths::with_root(f.dir.path().join("host")),
        "group-a",
    );
    assert_ne!(
        std::fs::metadata(active_root.path()).unwrap().dev(),
        std::fs::metadata(f.dir.path()).unwrap().dev()
    );
    let run_id = runner_types::ids::RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let lease = cache
        .lease_active(HomeImageLeaseRequest {
            identity: HomeImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: PROFILE,
                rootfs_hash: ROOTFS,
                reuse_key: Some("thread"),
                working_dir: CWD,
                image_size_bytes: SIZE,
            },
            home_drive_available: true,
        })
        .await;
    let active = paths.active_home_image(&sandbox_id);
    write_image(&active, b"sparse-home", SIZE);
    let promotion = lease
        .into_promotion_context(HomeImagePromotionRequest {
            run_id,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: "2026-10-09T09:00:00Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();
    assert_eq!(
        promotion.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(promotion);
    let metadata = f.metadata("thread").await;
    let target = f.image("thread", &metadata);
    assert!(!active.exists());
    assert_eq!(std::fs::metadata(&target).unwrap().len(), SIZE);
    assert!(std::fs::metadata(&target).unwrap().blocks() * 512 < SIZE);
    assert_eq!(&std::fs::read(&target).unwrap()[4096..4107], b"sparse-home");
}
