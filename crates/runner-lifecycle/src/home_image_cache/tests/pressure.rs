use super::super::*;
use super::support::*;
use std::os::unix::fs::MetadataExt;
use std::time::Duration;

fn low_space(cache: &HomeImageCache) {
    cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
}

#[tokio::test]
async fn foreground_target_and_cheap_background_watermarks_remain_independent() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 62 * GIB + GIB / 2,
        ..FsStats::default()
    });
    f.cache.reset_gc_root_scan_count();
    f.cache.probe_home_cache_pressure().await.unwrap();
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    assert!(f.image("home", &committed).exists());
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 55 * GIB,
        ..FsStats::default()
    });
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let demand = f
        .cache
        .reclaim_home_image_headroom(device, 51 * GIB, reclamation_deadline())
        .await
        .unwrap();
    assert_eq!(demand.status, HomeCacheReclaimStatus::TargetSatisfied);
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    assert!(f.image("home", &committed).exists());
    f.cache.probe_home_cache_pressure().await.unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert_eq!(f.cache.gc_root_scan_count(), 1);
    assert!(!f.image("home", &committed).exists());
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn pressure_discovery_rejects_an_intervening_publication() {
    use std::sync::Arc;
    let f = Fixture::new().await;
    f.commit("home", b"previous", "2026-10-09T09:00:00Z").await;
    low_space(&f.cache);
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let cache = f
        .cache
        .clone()
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 75 * GIB,
        ..FsStats::default()
    });
    let replacement = f
        .commit("home", b"replacement", "2026-10-09T10:00:00Z")
        .await;
    low_space(&f.cache);
    release.add_permits(1);
    worker.await.unwrap().unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(f.image("home", &replacement).exists());
    assert_eq!(
        f.metadata("home").await.image_generation,
        replacement.image_generation
    );
}

#[tokio::test]
async fn count_only_routine_collection_stops_at_the_independent_entry_cap_below_high_water() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new().await;
    // Physical GC deliberately accepts independently produced current commits;
    // construct its real persisted input without consumer-specific eligibility.
    for i in 0..=1024 {
        let key = format!("{i:064x}");
        f.cache.ensure_home_cache_entry_dir(&key).await.unwrap();
        let paths = f.cache.entry_paths(&key);
        let generation = uuid::Uuid::new_v4().to_string();
        let image = paths.image(&generation).unwrap();
        write_image(&image, b"home", SIZE);
        let identity =
            metadata::HomeImageFileIdentity::from_metadata(&std::fs::metadata(image).unwrap());
        let physical = serde_json::json!({
            "imageGeneration": generation, "currentImage": identity,
            "logicalImageSizeBytes": SIZE, "lastUsedAt": "2026-10-09T09:00:00Z"
        });
        std::fs::write(paths.metadata(), serde_json::to_vec(&physical).unwrap()).unwrap();
        std::fs::set_permissions(paths.metadata(), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 62 * GIB + GIB / 2,
        ..FsStats::default()
    });
    assert!(
        f.cache
            .try_routine_gc(Duration::ZERO)
            .await
            .unwrap()
            .unwrap()
            > 0
    );
    assert_eq!(
        std::fs::read_dir(f.cache.home_image_cache_dir())
            .unwrap()
            .count(),
        1024
    );
    assert!(
        !f.cache
            .entry_paths(&format!("{:064x}", 0))
            .entry_dir()
            .exists()
    );
    assert!(
        f.cache
            .entry_paths(&format!("{:064x}", 1024))
            .entry_dir()
            .exists()
    );
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
}

#[tokio::test]
async fn pressure_continuation_bounds_turns_and_keeps_one_complete_lru_inventory() {
    let f = Fixture::new().await;
    for i in 0..33 {
        f.commit(&format!("home-{i:02}"), b"home", "2026-10-09T09:00:00Z")
            .await;
    }
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    f.cache.reset_gc_root_scan_count();
    let mut worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    let mut previous = 33;
    let mut turns = 0;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            tokio::select! {
                result = &mut worker => {
                    result.unwrap().unwrap();
                    break;
                }
                () = gate.wait_entered(Duration::from_secs(5)) => {
                    assert_eq!(f.cache.gc_root_scan_count(), 1);
                    let count = std::fs::read_dir(f.cache.home_image_cache_dir()).unwrap().count();
                    assert!(count <= previous && previous - count <= 16);
                    previous = count;
                    turns += 1;
                    gate.release();
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(turns >= 3);
    f.cache.drain_pressure_reclamation().await;
    assert!(f.cache.held_home_states().await.is_empty());
    // A pressure-only turn never marks routine maintenance complete.
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn routine_pressure_turn_releases_collector_and_retains_inventory_between_turns() {
    let f = Fixture::new().await;
    for i in 0..33 {
        f.commit(&format!("home-{i:02}"), b"home", "2026-10-09T09:00:00Z")
            .await;
    }
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    f.cache.reset_gc_root_scan_count();
    let worker = tokio::spawn(async move { cache.try_routine_gc(Duration::ZERO).await });
    gate.wait_entered(Duration::from_secs(5)).await;
    assert_eq!(f.cache.gc_root_scan_count(), 1);
    gate.release();
    // The first turn admitted at most 16 victims. The collector owner is free
    // while the accepted routine task retains its remaining inventory.
    gate.wait_entered(Duration::from_secs(5)).await;
    assert!(
        (17..=33).contains(
            &std::fs::read_dir(f.cache.home_image_cache_dir())
                .unwrap()
                .count()
        )
    );
    let lock = runner_host::lock::try_acquire(f.cache.routine_gc_lock_path())
        .await
        .unwrap();
    drop(lock);
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        0
    );
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 75 * GIB,
        ..FsStats::default()
    });
    let published = f
        .commit("intervening", b"new-home", "2026-10-09T10:00:00Z")
        .await;
    gate.release();
    gate.wait_entered(Duration::from_secs(5)).await;
    gate.release();
    assert!(worker.await.unwrap().unwrap().is_some());
    assert_eq!(f.cache.gc_root_scan_count(), 1);
    assert!(f.image("intervening", &published).exists());
    assert_eq!(
        std::fs::metadata(f.cache.routine_gc_lock_path())
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn yielded_routine_turn_honors_another_collectors_completion_marker() {
    let f = Fixture::new().await;
    for i in 0..33 {
        f.commit(&format!("home-{i:02}"), b"home", "2026-10-09T09:00:00Z")
            .await;
    }
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    let worker = tokio::spawn(async move { cache.try_routine_gc(Duration::from_secs(3600)).await });
    gate.wait_entered(Duration::from_secs(5)).await;
    gate.release();
    gate.wait_entered(Duration::from_secs(5)).await;

    let other = HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        f.cache.inner.cache_dir.clone(),
        f.cache.inner.lock_dir.clone(),
        &f.cache.inner.cache_scope,
        FsStats {
            total_bytes: 2000 * GIB,
            available_bytes: 1000 * GIB,
            ..FsStats::default()
        },
    );
    assert!(
        other
            .try_routine_gc(Duration::ZERO)
            .await
            .unwrap()
            .is_some()
    );
    let remaining = std::fs::read_dir(f.cache.home_image_cache_dir())
        .unwrap()
        .count();
    assert!((17..=33).contains(&remaining));
    gate.release();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(f.cache.home_image_cache_dir())
            .unwrap()
            .count(),
        remaining
    );
}

#[tokio::test]
async fn policy_uses_the_callers_remaining_deadline_and_retains_accepted_work() {
    let f = Fixture::new().await;
    let committed = f
        .commit("home", b"owned-home", "2026-10-09T09:00:00Z")
        .await;
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let allowance = sandbox::HOME_DRIVE_RECLAIM_OBSERVATION;

    // Some of the caller's nondefault allowance has already elapsed before
    // entering the policy. No real filesystem work is pending while paused.
    tokio::time::pause();
    let deadline = tokio::time::Instant::now() + allowance * 4;
    tokio::time::advance(allowance).await;
    tokio::time::resume();
    let policy = cache.home_drive_pressure_policy();
    let mut observer = policy.reclaim(device, 60 * GIB, deadline);
    tokio::select! {
        () = &mut observer => panic!("observer ended before accepting gated recovery"),
        () = gate.wait_entered(Duration::from_secs(5)) => {}
    }

    // Physical IO and lock setup has completed and the worker is parked. Poll
    // the observer directly, so the result does not depend on task scheduling.
    tokio::time::pause();
    tokio::time::advance(allowance).await;
    let still_observing = futures_util::poll!(&mut observer).is_pending();
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    // Tokio timers round up to the next millisecond.
    tokio::time::advance(remaining + Duration::from_millis(1)).await;
    let expired = still_observing && futures_util::poll!(&mut observer).is_ready();
    tokio::time::resume();

    assert!(f.image("home", &committed).exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    let drain = cache.drain_pressure_reclamation();
    tokio::pin!(drain);
    assert!(futures_util::poll!(&mut drain).is_pending());
    gate.release();
    drain.await;
    assert!(
        still_observing,
        "policy imposed a separate default allowance"
    );
    assert!(expired, "policy restarted or ignored the caller's deadline");
    assert!(!f.image("home", &committed).exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn demand_timeout_keeps_accepted_lock_custody_and_shutdown_joins_the_worker() {
    let f = Fixture::new().await;
    let committed = f
        .commit("home", b"owned-home", "2026-10-09T09:00:00Z")
        .await;
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let observer_cache = cache.clone();
    let observer = tokio::spawn(async move {
        observer_cache
            .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
            .await
    });
    gate.wait_entered(Duration::from_secs(5)).await;
    // The real filesystem/lock boundary has completed. Advance only the
    // observer's in-process deadline, then resume before more kernel IO.
    tokio::time::pause();
    tokio::time::advance(sandbox::HOME_DRIVE_RECLAIM_OBSERVATION).await;
    tokio::time::resume();
    let observed = observer.await.unwrap().unwrap();
    assert_eq!(observed.status, HomeCacheReclaimStatus::ObserverTimedOut);
    assert!(observed.available_after.is_none());
    assert!(f.image("home", &committed).exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    let drain = cache.drain_pressure_reclamation();
    tokio::pin!(drain);
    assert!(futures_util::poll!(&mut drain).is_pending());
    gate.release();
    drain.await;
    assert!(!f.image("home", &committed).exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Acquired(_)
    ));
}

#[tokio::test]
async fn cancelled_observer_does_not_cancel_accepted_reclamation() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let observer_cache = cache.clone();
    let observer = tokio::spawn(async move {
        observer_cache
            .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
            .await
    });
    gate.wait_entered(Duration::from_secs(5)).await;
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    gate.release();
    cache.drain_pressure_reclamation().await;
    assert!(!f.image("home", &committed).exists());
}

#[tokio::test]
async fn demand_contention_preserves_entries_and_a_later_request_can_reclaim() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    low_space(&f.cache);
    let device = std::fs::metadata(f.cache.home_image_cache_dir())
        .unwrap()
        .dev();
    let lock = runner_host::lock::acquire(f.cache.routine_gc_lock_path())
        .await
        .unwrap();
    let outcome = f
        .cache
        .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
        .await
        .unwrap();
    assert_eq!(outcome.status, HomeCacheReclaimStatus::Contended);
    assert!(f.image("home", &committed).exists());
    drop(lock);
    let outcome = f
        .cache
        .reclaim_home_image_headroom(device, 60 * GIB, reclamation_deadline())
        .await
        .unwrap();
    assert_eq!(outcome.status, HomeCacheReclaimStatus::NoEligibleProgress);
    assert_eq!(outcome.available_after, Some(1));
    assert!(outcome.removed_allocated_bytes > 0);
    assert!(!f.image("home", &committed).exists());
    f.cache.drain_pressure_reclamation().await;
}

#[tokio::test]
async fn pressure_never_evicts_a_more_recently_used_victim() {
    let f = Fixture::new().await;
    let previous = f.commit("home", b"previous", "2026-10-09T09:00:00Z").await;
    low_space(&f.cache);
    let gate = HomeImagePrepareLockTestGate::default();
    let cache = f.cache.clone().with_pressure_turn_test_gate(gate.clone());
    let worker = tokio::spawn(async move { cache.probe_home_cache_pressure().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    // A prior observation loses last-use authority before its try-entry step.
    let mut newer = f.metadata("home").await;
    newer.last_used_at = "2026-10-10T09:00:00Z".into();
    let entry = runner_host::lock::acquire(f.cache.entry_lock_path(&f.key("home")))
        .await
        .unwrap();
    std::fs::write(
        f.cache.entry_paths(&f.key("home")).metadata(),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    drop(entry);
    gate.release();
    worker.await.unwrap().unwrap();
    f.cache.drain_pressure_reclamation().await;
    assert!(f.image("home", &previous).exists());
    assert_eq!(f.metadata("home").await.last_used_at, newer.last_used_at);
}

#[tokio::test]
async fn different_receiving_device_does_not_reclaim_this_cache() {
    let f = Fixture::new().await;
    let committed = f.commit("home", b"home", "2026-10-09T09:00:00Z").await;
    low_space(&f.cache);
    let other = tempfile::tempdir_in("/dev/shm").unwrap();
    let other_device = std::fs::metadata(other.path()).unwrap().dev();
    assert_ne!(
        other_device,
        std::fs::metadata(f.cache.home_image_cache_dir())
            .unwrap()
            .dev()
    );
    f.cache.reset_gc_root_scan_count();
    let outcome = f
        .cache
        .reclaim_home_image_headroom(other_device, 60 * GIB, reclamation_deadline())
        .await
        .unwrap();
    assert_eq!(outcome.status, HomeCacheReclaimStatus::DifferentFilesystem);
    assert_eq!(f.cache.gc_root_scan_count(), 0);
    assert!(f.image("home", &committed).exists());
}

#[tokio::test]
async fn real_filesystem_observations_do_not_claim_release_of_an_open_unlinked_image() {
    use std::io::{Read, Seek, SeekFrom};
    let f = Fixture::new().await;
    let committed = f
        .commit("home", b"still-open", "2026-10-09T09:00:00Z")
        .await;
    let mut image = std::fs::File::open(f.image("home", &committed)).unwrap();
    let allocation = image.metadata().unwrap().blocks();
    assert!(allocation > 0);
    let cache = f.cache.clone().with_actual_fs_stats_for_test();
    let stats = cache.query_fs_stats().await.unwrap();
    let device = image.metadata().unwrap().dev();
    // A held positive allocation makes all filesystem capacity unavailable as
    // a free-space target, independent of other writers' timing.
    let outcome = cache
        .reclaim_home_image_headroom(device, stats.total_bytes, reclamation_deadline())
        .await
        .unwrap();
    assert!(matches!(
        outcome.status,
        HomeCacheReclaimStatus::NoEligibleProgress | HomeCacheReclaimStatus::ObserverTimedOut
    ));
    cache.drain_pressure_reclamation().await;
    if let Some(available) = outcome.available_after {
        assert!(available < stats.total_bytes);
    }
    assert!(cache.query_fs_stats().await.unwrap().available_bytes < stats.total_bytes);
    assert!(!f.image("home", &committed).exists());
    assert_eq!(image.metadata().unwrap().blocks(), allocation);
    image.seek(SeekFrom::Start(4096)).unwrap();
    let mut marker = [0; 10];
    image.read_exact(&mut marker).unwrap();
    assert_eq!(&marker, b"still-open");
    cache.drain_pressure_reclamation().await;
}
