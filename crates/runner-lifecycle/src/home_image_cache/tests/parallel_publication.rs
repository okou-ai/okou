use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;
use std::future::{Future as _, poll_fn};
use std::os::unix::fs::MetadataExt;
use std::sync::Arc;
use std::time::Duration;

mod pressure_admission;

async fn context(f: &Fixture, key: &str) -> HomeImagePromotionContext {
    f.context(
        key,
        key.as_bytes(),
        "2026-10-16T11:00:00Z",
        HomeCacheTerminalStatus::Success,
        StorageFingerprints::default(),
    )
    .await
}

async fn published_bytes(f: &Fixture, key: &str, expected: &[u8]) {
    let metadata = f.metadata(key).await;
    assert_eq!(
        tokio::fs::read(f.image(key, &metadata)).await.unwrap(),
        expected
    );
    assert_eq!(f.lease(key).await.result(), HomeCacheCheckoutResult::Hit);
}

#[tokio::test]
async fn blocked_physical_sync_allows_an_independent_key_to_commit() {
    let mut f = Fixture::new().await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache.publication_sync_test_gate = Some(gate.clone());
    let first = context(&f, "blocked").await;
    let original = tokio::fs::read(f.paths.active_home_image(&first.sandbox_id()))
        .await
        .unwrap();
    let task = tokio::spawn(async move { first.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    f.cache.publication_sync_test_gate = None;
    let second = context(&f, "independent").await;
    let second_bytes = tokio::fs::read(f.paths.active_home_image(&second.sandbox_id()))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), second.promote())
            .await
            .unwrap()
            .unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(second);
    published_bytes(&f, "independent", &second_bytes).await;
    assert!(!f.cache.entry_paths(&f.key("blocked")).metadata().exists());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.entry_lock_path(&f.key("blocked")))
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    gate.release();
    assert_eq!(
        task.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    published_bytes(&f, "blocked", &original).await;
}

#[tokio::test]
async fn observer_loss_keeps_physical_locks_and_shutdown_joins_publication() {
    let mut f = Fixture::new().await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache.publication_sync_test_gate = Some(gate.clone());
    let owned = context(&f, "cancelled-observer").await;
    let bytes = tokio::fs::read(f.paths.active_home_image(&owned.sandbox_id()))
        .await
        .unwrap();
    let observer = tokio::spawn(async move { owned.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(
            f.cache.entry_lock_path(&f.key("cancelled-observer"))
        )
        .await
        .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    f.cache.gc(false).await.unwrap();
    let mut shutdown = Box::pin(async {
        f.cache.drain_checkout_handoffs().await;
        f.cache.drain_pressure_reclamation().await;
    });
    poll_fn(|cx| {
        assert!(shutdown.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    gate.release();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    f.cache.publication_sync_test_gate = None;
    published_bytes(&f, "cancelled-observer", &bytes).await;
}

#[tokio::test]
async fn observer_loss_cannot_change_an_accepted_generations_history_proof() {
    let mut f = Fixture::new().await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache.publication_sync_test_gate = Some(gate.clone());
    let mut owned = context(&f, "sealed-proof").await;
    let proof = binding(&owned.publication_generation());
    owned.set_home_history_proof(Some(proof.clone())).unwrap();
    let mut publication = Box::pin(owned.promote());
    tokio::select! {
        result = publication.as_mut() => panic!("publication finished before physical sync: {result:?}"),
        () = gate.wait_entered(Duration::from_secs(5)) => {}
    }
    drop(publication);
    assert!(owned.set_home_history_proof(None).is_err());
    gate.release();
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(owned);
    assert_eq!(
        f.metadata("sealed-proof").await.history_proof.as_ref(),
        Some(&proof)
    );
}

#[tokio::test]
async fn a_context_serializes_observers_without_repeating_physical_publication() {
    let mut f = Fixture::new().await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache.publication_sync_test_gate = Some(gate.clone());
    let owned = Arc::new(context(&f, "one-generation").await);
    let first = owned.clone();
    let first = tokio::spawn(async move { first.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    let second = owned.clone();
    let mut second = tokio::spawn(async move { second.promote().await });
    poll_fn(|cx| {
        assert!(std::pin::Pin::new(&mut second).poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    gate.release();
    assert_eq!(
        first.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    assert_eq!(
        second.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    let metadata = f.metadata("one-generation").await;
    assert_eq!(metadata.image_generation, owned.publication_generation());
    let committed = tokio::fs::read(f.cache.entry_paths(&f.key("one-generation")).metadata())
        .await
        .unwrap();
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    assert_eq!(
        tokio::fs::read(f.cache.entry_paths(&f.key("one-generation")).metadata())
            .await
            .unwrap(),
        committed
    );
}

#[tokio::test]
async fn required_retry_resumes_moved_candidate_and_uncertain_metadata_phases() {
    for fault in [
        PublicationFault::BeforeImageSync,
        PublicationFault::AfterImageSync,
        PublicationFault::BeforeCandidateDirectorySync,
        PublicationFault::BeforeMetadataSync,
        PublicationFault::PartialMetadataWrite,
        PublicationFault::BeforeMetadataRename,
        PublicationFault::AfterMetadataRename,
    ] {
        let f = Fixture::new().await;
        let old = f.commit("retry", b"old", "2026-10-16T10:00:00Z").await;
        let old_bytes = tokio::fs::read(f.image("retry", &old)).await.unwrap();
        let owned = context(&f, "retry").await;
        let active = f.paths.active_home_image(&owned.sandbox_id());
        let expected = tokio::fs::read(&active).await.unwrap();
        f.cache
            .inner
            .publication_fault
            .store(fault as usize, std::sync::atomic::Ordering::SeqCst);
        assert!(owned.promote().await.is_err());
        assert!(
            !active.exists(),
            "retry must handle the actual moved location"
        );
        assert_eq!(
            tokio::fs::read(f.image("retry", &old)).await.unwrap(),
            old_bytes
        );
        assert_eq!(
            owned.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        drop(owned);
        published_bytes(&f, "retry", &expected).await;
    }
}

#[tokio::test]
async fn retained_failure_capsules_do_not_occupy_all_physical_io_slots() {
    let f = Fixture::new().await;
    let mut retained = Vec::new();
    for index in 0..4 {
        let key = format!("retained-{index}");
        let owned = context(&f, &key).await;
        f.cache.inner.publication_fault.store(
            PublicationFault::BeforeImageSync as usize,
            std::sync::atomic::Ordering::SeqCst,
        );
        assert!(owned.promote().await.is_err());
        retained.push(owned);
    }
    let independent = context(&f, "after-failures").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), independent.promote())
            .await
            .unwrap()
            .unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    for owned in retained {
        assert_eq!(
            owned.promote().await.unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
    }
}

#[tokio::test]
async fn blocked_copy_allows_same_runner_move_to_commit() {
    let mut f = Fixture::new().await;
    let gate = HomeImagePrepareLockTestGate::default();
    f.cache.publication_copy_test_gate = Some(gate.clone());
    let copied = context(&f, "copy").await;
    let copy_bytes = tokio::fs::read(f.paths.active_home_image(&copied.sandbox_id()))
        .await
        .unwrap();
    f.cache.inner.publication_fault.store(
        PublicationFault::UnexpectedExdev as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    let copying = tokio::spawn(async move { copied.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    f.cache.publication_copy_test_gate = None;
    let moved = context(&f, "move").await;
    let move_bytes = tokio::fs::read(f.paths.active_home_image(&moved.sandbox_id()))
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
    published_bytes(&f, "move", &move_bytes).await;
    gate.release();
    assert_eq!(
        copying.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    published_bytes(&f, "copy", &copy_bytes).await;
}

#[tokio::test]
async fn manual_collection_defers_to_the_same_singleton_as_background_collection() {
    let f = Fixture::new().await;
    let old = f.commit("survivor", b"home", "2026-10-16T10:00:00Z").await;
    let orphan = f
        .cache
        .entry_paths(&f.key("survivor"))
        .tmp_image(runner_types::ids::RunId::new_v4());
    write_image(&orphan, b"orphan", SIZE);
    let owner = runner_host::lock::acquire(f.cache.routine_gc_lock_path())
        .await
        .unwrap();
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
    assert!(orphan.exists());
    assert!(
        f.cache
            .try_routine_gc(Duration::ZERO)
            .await
            .unwrap()
            .is_none()
    );
    let independent = context(&f, "publisher").await;
    assert_eq!(
        independent.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(owner);
    assert!(f.cache.gc(false).await.unwrap() > 0);
    assert!(!orphan.exists());
    assert!(f.image("survivor", &old).exists());
}

#[tokio::test]
async fn independent_cross_device_copies_share_four_io_slots() {
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
    let gate = HomeImagePrepareLockTestGate::default();
    f.cache.publication_copy_test_gate = Some(gate.clone());
    let mut copying = Vec::new();
    for index in 0..4 {
        let key = format!("concurrent-copy-{index}");
        let owned = context(&f, &key).await;
        let active = f.paths.active_home_image(&owned.sandbox_id());
        let expected = tokio::fs::read(&active).await.unwrap();
        assert_ne!(
            std::fs::metadata(&active).unwrap().dev(),
            std::fs::metadata(destination.path()).unwrap().dev()
        );
        let task = tokio::spawn(async move { owned.promote().await });
        gate.wait_entered(Duration::from_secs(5)).await;
        assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
        copying.push((key, expected, task));
    }

    let fifth = context(&f, "fifth-copy").await;
    let expected = tokio::fs::read(f.paths.active_home_image(&fifth.sandbox_id()))
        .await
        .unwrap();
    let paths = f.cache.entry_paths(&f.key("fifth-copy"));
    let staging = paths.tmp_image(fifth.run_id());
    let fifth = tokio::spawn(async move { fifth.promote().await });
    tokio::time::timeout(
        Duration::from_secs(5),
        f.cache.inner.publication_admission_entered.acquire_many(5),
    )
    .await
    .unwrap()
    .unwrap()
    .forget();
    assert!(!fifth.is_finished());
    assert!(!staging.exists());
    assert!(!paths.metadata().exists());

    gate.release();
    gate.wait_entered(Duration::from_secs(5)).await;
    for _ in 0..4 {
        gate.release();
    }
    copying.push(("fifth-copy".into(), expected, fifth));
    for (key, expected, task) in copying {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            HomeImagePromotionOutcome::Promoted
        );
        published_bytes(&f, &key, &expected).await;
    }
}

#[tokio::test]
async fn copy_retry_retains_its_destination_and_rejects_a_replacement_inode() {
    for replace in [false, true] {
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
        let owned = context(&f, "copy-retry").await;
        let active = f.paths.active_home_image(&owned.sandbox_id());
        let expected = tokio::fs::read(&active).await.unwrap();
        f.cache.inner.publication_fault.store(
            PublicationFault::BeforeCopy as usize,
            std::sync::atomic::Ordering::SeqCst,
        );
        assert!(owned.promote().await.is_err());
        let staging = f
            .cache
            .entry_paths(&f.key("copy-retry"))
            .tmp_image(owned.run_id());
        assert!(staging.exists());
        assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
        if replace {
            tokio::fs::remove_file(&staging).await.unwrap();
            write_image(&staging, b"different-owner", SIZE);
            let replacement = tokio::fs::read(&staging).await.unwrap();
            assert!(owned.promote().await.is_err());
            assert_eq!(tokio::fs::read(&staging).await.unwrap(), replacement);
            assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
        } else {
            assert_eq!(
                owned.promote().await.unwrap(),
                HomeImagePromotionOutcome::Promoted
            );
            drop(owned);
            published_bytes(&f, "copy-retry", &expected).await;
        }
    }
}

#[tokio::test]
async fn interrupted_unexpected_copy_resumes_copy_even_when_device_numbers_match() {
    let mut f = Fixture::new().await;
    let gate = HomeImagePrepareLockTestGate::default();
    f.cache.publication_copy_test_gate = Some(gate.clone());
    let owned = context(&f, "same-device-copy").await;
    let active = f.paths.active_home_image(&owned.sandbox_id());
    let expected = tokio::fs::read(&active).await.unwrap();
    assert_eq!(
        std::fs::metadata(&active).unwrap().dev(),
        std::fs::metadata(f.cache.home_image_cache_fs_stats_path())
            .unwrap()
            .dev()
    );
    f.cache.inner.publication_fault.store(
        PublicationFault::UnexpectedExdev as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    let attempt = tokio::spawn(async move {
        let result = owned.promote().await;
        (owned, result)
    });
    gate.wait_entered(Duration::from_secs(5)).await;
    f.cache.inner.publication_fault.store(
        PublicationFault::BeforeCopy as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    gate.release();
    let (owned, result) = attempt.await.unwrap();
    assert!(result.is_err());
    assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
    assert!(
        f.cache
            .entry_paths(&f.key("same-device-copy"))
            .tmp_image(owned.run_id())
            .exists()
    );
    gate.release();
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(owned);
    published_bytes(&f, "same-device-copy", &expected).await;
}

#[tokio::test]
async fn publication_deadline_stops_gc_observation_without_abandoning_the_collector() {
    let mut f = Fixture::new().await;
    let committed = f
        .commit("gc-entry", b"preserved", "2026-10-16T10:00:00Z")
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
    let owned = context(&f, "waiting-gc").await;
    let active = f.paths.active_home_image(&owned.sandbox_id());
    let expected = tokio::fs::read(&active).await.unwrap();
    let publication = tokio::spawn(async move { owned.promote().await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    assert_eq!(
        publication.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    tokio::time::resume();
    assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
    assert!(matches!(
        runner_host::lock::try_acquire_or_busy(f.cache.routine_gc_lock_path())
            .await
            .unwrap(),
        runner_host::lock::TryLock::Busy
    ));
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 2_000 * GIB,
        available_bytes: 1_000 * GIB,
        ..FsStats::default()
    });
    let independent = context(&f, "gc-independent").await;
    assert_eq!(
        independent.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(independent);
    let mut shutdown = Box::pin(async {
        f.cache.drain_checkout_handoffs().await;
        f.cache.drain_pressure_reclamation().await;
    });
    poll_fn(|cx| {
        assert!(shutdown.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    assert!(f.image("gc-entry", &committed).exists());
}
