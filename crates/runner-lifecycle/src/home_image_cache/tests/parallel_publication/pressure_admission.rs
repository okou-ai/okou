use super::*;

#[tokio::test]
async fn pressured_publishers_join_one_accepted_reclaim_before_retrying() {
    let (mut f, _destination) = fixture().await;
    f.commit("reclaim-victim", b"old", "2026-10-16T10:00:00Z")
        .await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    f.cache = f
        .cache
        .clone()
        .with_gc_inventory_test_gate(1, entered.clone(), release.clone());
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    let first = context(&f, "reclaim-first").await;
    let first_bytes = tokio::fs::read(f.paths.active_home_image(&first.sandbox_id()))
        .await
        .unwrap();
    let first = tokio::spawn(async move { first.promote().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    f.cache.inner.pressure_demand_accepted.notified().await;
    let second = context(&f, "reclaim-second").await;
    let second_bytes = tokio::fs::read(f.paths.active_home_image(&second.sandbox_id()))
        .await
        .unwrap();
    let second = tokio::spawn(async move { second.promote().await });
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache.inner.pressure_demand_accepted.notified(),
    )
    .await
    .unwrap();
    assert!(!first.is_finished() && !second.is_finished());
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 100 * GIB,
        available_bytes: 50 * GIB + 3 * SIZE,
        ..FsStats::default()
    });
    release.add_permits(1);
    for task in [first, second] {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
    }
    published_bytes(&f, "reclaim-first", &first_bytes).await;
    published_bytes(&f, "reclaim-second", &second_bytes).await;
    f.cache.drain_checkout_handoffs().await;
    f.cache.drain_pressure_reclamation().await;
}

async fn fixture() -> (Fixture, tempfile::TempDir) {
    let mut f = Fixture::new().await;
    let destination = tempfile::tempdir_in("/dev/shm").unwrap();
    f.cache = HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        destination.path().join("cache"),
        f.cache.inner.lock_dir.clone(),
        "group-a",
        FsStats {
            total_bytes: 100 * GIB,
            available_bytes: 50 * GIB + 3 * SIZE,
            ..FsStats::default()
        },
    );
    (f, destination)
}

async fn entered(f: &Fixture, count: u32) {
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache
            .inner
            .publication_admission_entered
            .acquire_many(count),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
}

#[tokio::test]
async fn pressured_copy_reuses_all_io_slots_without_excluding_another_owners_move() {
    let (mut f, destination) = fixture().await;
    let gate = HomeImagePrepareLockTestGate::default();
    f.cache.publication_copy_test_gate = Some(gate.clone());
    let first = context(&f, "pressure-first").await;
    let active = f.paths.active_home_image(&first.sandbox_id());
    let first_bytes = tokio::fs::read(&active).await.unwrap();
    assert_ne!(
        std::fs::metadata(&active).unwrap().dev(),
        std::fs::metadata(destination.path()).unwrap().dev()
    );
    let first = tokio::spawn(async move { first.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    assert_eq!(f.cache.inner.publication_admission.available_permits(), 0);
    let second = context(&f, "pressure-second").await;
    let second_bytes = tokio::fs::read(f.paths.active_home_image(&second.sandbox_id()))
        .await
        .unwrap();
    let second_paths = f.cache.entry_paths(&f.key("pressure-second"));
    let staging = second_paths.tmp_image(second.run_id());
    let second = tokio::spawn(async move { second.promote().await });
    entered(&f, 3).await;
    assert!(!second.is_finished());
    assert!(!staging.exists());
    assert!(!second_paths.metadata().exists());

    let move_dir = tempfile::tempdir_in(destination.path()).unwrap();
    let mut mover = Fixture::new().await;
    mover.paths = runner_host::paths::RunnerPaths::new(move_dir.path().join("runner"));
    mover.cache = HomeImageCache::with_cache_dirs_and_fs_stats(
        mover.paths.clone(),
        f.cache.inner.cache_dir.clone(),
        f.cache.inner.lock_dir.clone(),
        "group-a",
        FsStats {
            total_bytes: 100 * GIB,
            available_bytes: 50 * GIB + 3 * SIZE,
            ..FsStats::default()
        },
    );
    let moved = context(&mover, "pressure-move").await;
    let moved_bytes = tokio::fs::read(mover.paths.active_home_image(&moved.sandbox_id()))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), moved.promote())
            .await
            .unwrap()
            .unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(moved);
    published_bytes(&mover, "pressure-move", &moved_bytes).await;
    assert!(!first.is_finished());
    assert!(!second.is_finished());
    gate.release();
    gate.wait_entered(Duration::from_secs(5)).await;
    gate.release();
    for task in [first, second] {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
    }
    published_bytes(&f, "pressure-first", &first_bytes).await;
    published_bytes(&f, "pressure-second", &second_bytes).await;
}

#[tokio::test]
async fn pressured_copy_upgrade_obeys_the_existing_admission_deadline() {
    let (mut f, _destination) = fixture().await;
    let held = f
        .cache
        .inner
        .publication_admission
        .acquire_many(3)
        .await
        .unwrap();
    let notified = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    f.cache.publication_io_held_test_gate = Some((notified.clone(), release.clone()));
    let owned = context(&f, "pressure-deadline").await;
    let active = f.paths.active_home_image(&owned.sandbox_id());
    let original = tokio::fs::read(&active).await.unwrap();
    let task = tokio::spawn(async move {
        let result = owned.promote().await;
        (owned, result)
    });
    tokio::time::timeout(Duration::from_secs(5), notified.notified())
        .await
        .unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(20)).await;
    tokio::time::resume();
    release.add_permits(1);
    entered(&f, 2).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(11)).await;
    let advanced = tokio::time::Instant::now();
    let (owned, result) = task.await.unwrap();
    assert_eq!(tokio::time::Instant::now(), advanced);
    tokio::time::resume();
    assert_eq!(
        result.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert_eq!(tokio::fs::read(&active).await.unwrap(), original);
    assert!(
        !f.cache
            .entry_paths(&f.key("pressure-deadline"))
            .metadata()
            .exists()
    );
    drop(held);
    release.add_permits(2);
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(owned);
    published_bytes(&f, "pressure-deadline", &original).await;
}
