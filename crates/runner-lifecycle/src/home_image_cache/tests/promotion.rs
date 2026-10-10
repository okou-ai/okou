use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use std::os::unix::fs::{MetadataExt, symlink};
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
async fn older_or_equal_terminal_time_and_busy_capacity_preserve_existing_bytes() {
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
    let capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
        .await
        .unwrap();
    let context = f
        .context(
            "thread",
            b"unpublished",
            "2026-10-09T09:03:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let captured = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    drop(guard);
    let events = captured.entries();
    let busy = events
        .iter()
        .find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("home image cache promotion skipped: capacity lock busy")
        })
        .unwrap();
    assert_eq!(
        busy.fields.get("run_id"),
        Some(&context.run_id().to_string())
    );
    assert!(events.iter().all(|event| {
        event.fields.get("message").map(String::as_str) != Some("home image cache promoted")
    }));
    drop(context);
    drop(capacity);
    assert_eq!(
        f.metadata("thread").await.image_generation,
        old.image_generation
    );
}

#[tokio::test]
async fn unavailable_capacity_lock_is_not_reported_as_retryable_contention() {
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
    // An unusable lock pathname is not a lock held by a concurrent publisher.
    std::fs::create_dir(f.cache.capacity_lock_path()).unwrap();
    let captured = CapturedEvents::default();
    let guard =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    drop(guard);
    let events = captured.entries();
    let unavailable = events
        .iter()
        .find(|event| {
            event.fields.get("message").map(String::as_str)
                == Some("home image cache promotion skipped: capacity lock unavailable")
        })
        .unwrap();
    assert_eq!(
        unavailable.fields.get("run_id"),
        Some(&context.run_id().to_string())
    );
    assert!(events.iter().all(|event| {
        !matches!(
            event.fields.get("message").map(String::as_str),
            Some(
                "home image cache promoted"
                    | "home image cache promotion skipped: capacity lock busy"
            )
        )
    }));
    assert!(f.paths.active_home_image(&context.sandbox_id()).exists());
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
