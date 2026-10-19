use super::super::*;
use super::support::*;
use crate::home_promotion::PreparedHomeImagePromotion;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::{HomeObservationKind, HomeObservationOutcome};
use runner_storage::operation_test_support::RecordedHomeObservations;
use std::os::unix::fs::MetadataExt;

fn with_space(f: &Fixture, stats: FsStats) -> HomeImageCache {
    HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        f.cache.inner.cache_dir.clone(),
        f.cache.inner.lock_dir.clone(),
        &f.cache.inner.cache_scope,
        stats,
    )
}

fn scaled_healthy_cache(f: &Fixture) -> HomeImageCache {
    // Bounded real images with a scaled reserve exercise the same policy on a
    // small external-stat fixture, not native filesystem-pressure evidence.
    let mut cache = with_space(
        f,
        FsStats {
            total_bytes: 8 * SIZE,
            available_bytes: 3 * SIZE,
            ..FsStats::default()
        },
    );
    cache.pressure_reserve_override = Some(sandbox::HomeDriveSpaceReserve::new(0, 10));
    cache
}

#[tokio::test]
async fn cross_device_publication_observes_the_held_source_and_preserves_its_bytes() {
    let mut f = Fixture::new().await;
    let destination = tempfile::tempdir_in("/dev/shm").unwrap();
    f.cache = HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        destination.path().join("cache"),
        f.cache.inner.lock_dir.clone(),
        "group-a",
        FsStats::default(),
    )
    .with_actual_fs_stats_for_test();
    f.cache.pressure_reserve_override = Some(sandbox::HomeDriveSpaceReserve::new(0, 10));
    let context = f
        .context(
            "cross-device",
            b"held source",
            "2026-10-15T08:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let source = f.paths.active_home_image(&context.sandbox_id());
    assert_ne!(
        std::fs::metadata(&source).unwrap().dev(),
        std::fs::metadata(destination.path()).unwrap().dev()
    );
    let original = tokio::fs::read(&source).await.unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    assert!(!source.exists());
    drop(context);
    let committed = f.metadata("cross-device").await;
    assert_eq!(
        tokio::fs::read(f.image("cross-device", &committed))
            .await
            .unwrap(),
        original
    );
    let stats = f.cache.query_fs_stats().await.unwrap();
    assert!(stats.available_bytes >= f.cache.pressure_thresholds(stats).reserve_bytes);
}

async fn dense_context(
    f: &Fixture,
    key: &str,
    byte: u8,
    completed_at: &str,
) -> HomeImagePromotionContext {
    let context = f
        .context(
            key,
            &[byte],
            completed_at,
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    std::fs::write(
        f.paths.active_home_image(&context.sandbox_id()),
        vec![byte; SIZE as usize],
    )
    .unwrap();
    context
}

async fn commit_dense(f: &Fixture, key: &str, byte: u8, time: &str) -> metadata::HomeCacheMetadata {
    let context = dense_context(f, key, byte, time).await;
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(context);
    let mut metadata = f.metadata(key).await;
    // Pin LRU context without elapsed-time synchronization between real commits.
    metadata.last_used_at = time.to_owned();
    let _entry = runner_host::lock::acquire(f.cache.entry_lock_path(&f.key(key)))
        .await
        .unwrap();
    f.cache
        .write_metadata(
            &f.key(key),
            metadata.image_generation.parse().unwrap(),
            metadata.clone(),
        )
        .await
        .unwrap();
    metadata
}

async fn assert_checkout_bytes(f: &Fixture, key: &str, expected: &[u8]) {
    let mut lease = f.lease(key).await;
    assert_eq!(lease.result(), HomeCacheCheckoutResult::Hit);
    let Some(sandbox::HomeDriveSeedImage::Move(image)) =
        lease.home_drive_config().await.unwrap().unwrap().seed_image
    else {
        panic!("published image must be available for same-filesystem checkout");
    };
    assert_eq!(tokio::fs::read(image).await.unwrap(), expected);
}

#[tokio::test]
async fn healthy_publication_retains_above_the_old_quota_without_an_allocation_walk() {
    use super::allocation_scan::{ScanGate, ScanPoint, wait_entered, with_scan_gate};
    use std::sync::Arc;
    use tokio::sync::{Notify, Semaphore};
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    let newest = commit_dense(&f, "newest", 3, "2026-10-15T08:02:00Z").await;
    f.cache = scaled_healthy_cache(&f);
    let context = dense_context(&f, "candidate", 4, "2026-10-15T08:03:00Z").await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let published = Arc::new(Notify::new());
    let inspect = Arc::new(Semaphore::new(0));
    let gate = ScanGate::new(
        f.cache.home_image_cache_dir().to_owned(),
        ScanPoint::Metadata,
        entered.clone(),
        release.clone(),
    );
    let cache = f.cache.clone();
    let published_task = published.clone();
    let inspect_task = inspect.clone();
    let task = tokio::spawn(with_scan_gate(gate, async move {
        assert_eq!(
            context.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        drop(context);
        published_task.notify_one();
        inspect_task.acquire().await.unwrap().forget();
        cache.total_cache_allocated_bytes().await.unwrap()
    }));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::select! {
            () = published.notified() => {}
            () = entered.notified() => panic!("healthy publication walked retained allocation"),
        }
    })
    .await
    .unwrap();
    // Positive control: the same gate must stop a requested allocation scan.
    inspect.add_permits(1);
    wait_entered(&entered).await;
    release.add_permits(1);
    let retained = task.await.unwrap();
    assert!(retained > f.cache.fs_stats().await.unwrap().total_bytes / 2);
    assert!(f.image("oldest", &oldest).exists());
    assert!(f.image("middle", &middle).exists());
    assert!(f.image("newest", &newest).exists());
    assert_checkout_bytes(&f, "candidate", &vec![4; SIZE as usize]).await;
}

#[tokio::test]
async fn low_space_required_retry_preserves_busy_homes_and_rechecks_observed_headroom() {
    for replacing in [false, true] {
        let mut f = Fixture::new().await;
        let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
        let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
        let newest = commit_dense(&f, "newest", 3, "2026-10-15T08:02:00Z").await;
        f.cache = with_space(
            &f,
            FsStats {
                total_bytes: 100 * GIB,
                available_bytes: 50 * GIB - 1,
                ..FsStats::default()
            },
        );
        let recorded = RecordedHomeObservations::default();
        f.cache = f.cache.with_telemetry(recorded.handle());
        let key = if replacing { "newest" } else { "candidate" };
        let context = dense_context(&f, key, 4, "2026-10-15T08:03:00Z").await;
        let source = f.paths.active_home_image(&context.sandbox_id());
        let mut locks = Vec::new();
        for protected in ["oldest", "middle", "newest"] {
            if protected != key {
                locks.push(
                    runner_host::lock::acquire(f.cache.entry_lock_path(&f.key(protected)))
                        .await
                        .unwrap(),
                );
            }
        }
        let prepared = PreparedHomeImagePromotion::required(context, "pressure_retry");
        assert!(prepared.publish_required().await.is_err());
        assert_eq!(
            tokio::fs::read(&source).await.unwrap(),
            vec![4; SIZE as usize]
        );
        assert!(f.image("oldest", &oldest).exists());
        assert!(f.image("middle", &middle).exists());
        assert!(f.image("newest", &newest).exists());
        assert_eq!(
            f.metadata("newest").await.image_generation,
            newest.image_generation
        );
        drop(locks.remove(0));
        // An external filesystem observation recovers. Do not infer that the
        // released entry lock or deleted allocation itself produced free space.
        f.cache.set_fs_stats_for_test(FsStats {
            total_bytes: 100 * GIB,
            available_bytes: 75 * GIB,
            ..FsStats::default()
        });
        assert!(prepared.publish_required().await.unwrap());
        assert!(!source.exists());
        assert!(f.image("oldest", &oldest).exists());
        assert!(f.image("middle", &middle).exists());
        let publications: Vec<_> = recorded
            .events()
            .into_iter()
            .filter(|event| event.kind == HomeObservationKind::Publication)
            .collect();
        assert_eq!(publications.len(), 2);
        assert_eq!(publications[0].outcome, HomeObservationOutcome::Skipped);
        assert_eq!(publications[0].reason.as_deref(), Some("disk_reserve"));
        assert_eq!(publications[1].outcome, HomeObservationOutcome::Published);
        drop(prepared);
        drop(locks);
        assert_checkout_bytes(&f, key, &vec![4; SIZE as usize]).await;
        assert_checkout_bytes(&f, "middle", &vec![2; SIZE as usize]).await;
    }
}

#[tokio::test]
async fn infeasible_reserve_preserves_commits_and_source_while_move_checkout_remains_available() {
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    f.cache = with_space(
        &f,
        FsStats {
            total_bytes: 40 * GIB,
            available_bytes: 39 * GIB,
            ..FsStats::default()
        },
    );
    let context = dense_context(&f, "candidate", 4, "2026-10-15T08:03:00Z").await;
    let source = f.paths.active_home_image(&context.sandbox_id());
    let before = f.cache.total_cache_allocated_bytes().await.unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert_eq!(f.cache.total_cache_allocated_bytes().await.unwrap(), before);
    assert!(f.image("oldest", &oldest).exists());
    assert!(f.image("middle", &middle).exists());
    assert_eq!(
        tokio::fs::read(source).await.unwrap(),
        vec![4; SIZE as usize]
    );
    drop(context);
    assert_checkout_bytes(&f, "oldest", &vec![1; SIZE as usize]).await;
}

#[tokio::test]
async fn sparse_move_charges_only_publication_metadata_and_preserves_an_independent_home() {
    let mut f = Fixture::new().await;
    let old = commit_dense(&f, "old", 1, "2026-10-15T08:00:00Z").await;
    let metadata_peak = runner_host::state_file::HOME_METADATA_MAX_BYTES + 8192;
    f.cache = with_space(
        &f,
        FsStats {
            total_bytes: 100 * GIB,
            available_bytes: 50 * GIB + metadata_peak,
            ..FsStats::default()
        },
    );
    let context = f
        .context(
            "sparse",
            b"sparse candidate",
            "2026-10-15T08:03:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let source = f.paths.active_home_image(&context.sandbox_id());
    let original = tokio::fs::read(&source).await.unwrap();
    assert!(std::fs::metadata(&source).unwrap().blocks() * 512 < SIZE);
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    assert!(f.image("old", &old).exists());
    drop(context);
    assert_checkout_bytes(&f, "sparse", &original).await;
}

#[tokio::test]
async fn failed_replacement_after_transfer_preserves_previous_commit_and_retains_cleanup_custody() {
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    let previous = commit_dense(&f, "thread", 3, "2026-10-15T08:02:00Z").await;
    f.cache = scaled_healthy_cache(&f);
    let context = dense_context(&f, "thread", 4, "2026-10-15T08:03:00Z").await;
    f.cache.inner.publication_fault.store(
        PublicationFault::BeforeMetadataRename as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    assert!(context.promote().await.is_err());
    assert!(f.image("oldest", &oldest).exists());
    assert!(f.image("middle", &middle).exists());
    assert_eq!(
        f.metadata("thread").await.image_generation,
        previous.image_generation
    );
    assert_eq!(
        tokio::fs::read(f.image("thread", &previous)).await.unwrap(),
        vec![3; SIZE as usize]
    );
    let candidate = f
        .cache
        .entry_paths(&f.key("thread"))
        .image(&context.publication_generation())
        .unwrap();
    assert_eq!(
        tokio::fs::read(&candidate).await.unwrap(),
        vec![4; SIZE as usize]
    );
    drop(context);
    let before = f.cache.total_cache_allocated_bytes().await.unwrap();
    assert!(f.cache.gc(false).await.unwrap() > 0);
    assert!(f.cache.total_cache_allocated_bytes().await.unwrap() < before);
    assert!(!candidate.exists());
    assert_checkout_bytes(&f, "thread", &vec![3; SIZE as usize]).await;
}

#[tokio::test]
async fn healthy_stopped_publication_burst_keeps_every_completed_home_reusable() {
    let f = Fixture::new().await;
    let mut pending = Vec::new();
    for byte in 1..=8_u8 {
        let key = format!("stopped-{byte}");
        pending.push(dense_context(&f, &key, byte, "2026-10-15T08:03:00Z").await);
    }
    let outcomes = futures_util::future::join_all(pending.into_iter().map(|context| async move {
        let outcome = context.promote().await.unwrap();
        drop(context);
        outcome
    }))
    .await;
    assert!(
        outcomes
            .iter()
            .all(|outcome| *outcome == HomeImagePromotionOutcome::Promoted)
    );
    for byte in 1..=8_u8 {
        assert_checkout_bytes(&f, &format!("stopped-{byte}"), &vec![byte; SIZE as usize]).await;
    }
}
