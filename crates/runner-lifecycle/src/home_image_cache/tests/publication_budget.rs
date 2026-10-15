use super::super::*;
use super::support::*;
use crate::home_promotion::PreparedHomeImagePromotion;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::home_observation::{HomeObservationKind, HomeObservationOutcome};
use runner_storage::operation_test_support::RecordedHomeObservations;

fn with_max_bytes(f: &Fixture, maximum: u64) -> HomeImageCache {
    HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        f.cache.inner.cache_dir.clone(),
        f.cache.inner.lock_dir.clone(),
        &f.cache.inner.cache_scope,
        FsStats {
            total_bytes: maximum * 2,
            // Independent external observations isolate the retained-byte limit
            // from the fixed 50 GiB reserve using bounded, real file allocation.
            // This is intentionally not a physical statvfs snapshot.
            available_bytes: 100 * GIB,
            ..FsStats::default()
        },
    )
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
    let _capacity = runner_host::lock::acquire(f.cache.capacity_lock_path())
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
        lease.home_drive_config().unwrap().seed_image
    else {
        panic!("published image must be available for same-filesystem checkout");
    };
    assert_eq!(tokio::fs::read(image).await.unwrap(), expected);
}

#[tokio::test]
async fn pending_publication_reclaims_lru_images_below_the_existing_cache_limit() {
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    let newest = commit_dense(&f, "newest", 3, "2026-10-15T08:02:00Z").await;
    f.cache = with_max_bytes(&f, 5 * SIZE);
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let context = dense_context(&f, "candidate", 4, "2026-10-15T08:03:00Z").await;
    let source = f.paths.active_home_image(&context.sandbox_id());
    let candidate_bytes = super::super::fs::allocated_bytes(&std::fs::metadata(&source).unwrap());
    let pending = candidate_bytes + runner_host::state_file::HOME_METADATA_MAX_BYTES + 8192;
    let before = f.cache.total_cache_allocated_bytes().await.unwrap();
    let budget = CacheBudget::from_fs_stats(f.cache.fs_stats().await.unwrap());
    assert!(before < budget.max_cache_bytes);
    assert!(before + pending > budget.max_cache_bytes);
    assert!(before < budget.target_after_gc_bytes);

    let outcome = context.promote().await.unwrap();
    let after = f.cache.total_cache_allocated_bytes().await.unwrap();
    let publications: Vec<_> = recorded
        .events()
        .into_iter()
        .filter(|event| event.kind == HomeObservationKind::Publication)
        .collect();
    println!(
        "publication budget: existing={before} candidate={candidate_bytes} pending={pending} max={} target={} after={after} outcome={outcome:?} reasons={:?}",
        budget.max_cache_bytes,
        budget.target_after_gc_bytes,
        publications
            .iter()
            .map(|event| event.reason.as_deref())
            .collect::<Vec<_>>()
    );
    assert_eq!(outcome, HomeImagePromotionOutcome::Promoted);
    assert_eq!(publications.len(), 1);
    assert_eq!(publications[0].outcome, HomeObservationOutcome::Published);
    assert!(!f.image("oldest", &oldest).exists());
    assert!(!f.image("middle", &middle).exists());
    assert!(f.image("newest", &newest).exists());
    // The post-GC target includes demand, not just the old retained images.
    assert!(after <= budget.target_after_gc_bytes);
    drop(context);
    assert_checkout_bytes(&f, "candidate", &vec![4; SIZE as usize]).await;
    assert_checkout_bytes(&f, "newest", &vec![3; SIZE as usize]).await;
}

#[tokio::test]
async fn locked_images_preserve_required_publication_for_new_and_replacement_retry() {
    for replacing in [false, true] {
        let mut f = Fixture::new().await;
        let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
        let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
        let newest = commit_dense(&f, "newest", 3, "2026-10-15T08:02:00Z").await;
        f.cache = with_max_bytes(&f, 5 * SIZE);
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
        let prepared = PreparedHomeImagePromotion::required(context, "budget_retry");
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

        // The other old images remain protected. Missing the best-effort target
        // must not prevent a fresh hard-limit check from accepting this retry.
        drop(locks.remove(0));
        assert!(prepared.publish_required().await.unwrap());
        assert!(!source.exists());
        assert!(!f.image("oldest", &oldest).exists());
        assert!(f.image("middle", &middle).exists());
        assert_eq!(f.image("newest", &newest).exists(), !replacing);
        assert!(
            f.cache.total_cache_allocated_bytes().await.unwrap()
                <= CacheBudget::from_fs_stats(f.cache.fs_stats().await.unwrap()).max_cache_bytes
        );
        let publications: Vec<_> = recorded
            .events()
            .into_iter()
            .filter(|event| event.kind == HomeObservationKind::Publication)
            .collect();
        assert_eq!(publications.len(), 2);
        assert_eq!(publications[0].outcome, HomeObservationOutcome::Skipped);
        assert_eq!(publications[0].reason.as_deref(), Some("cache_budget"));
        assert_eq!(publications[1].outcome, HomeObservationOutcome::Published);
        drop(prepared);
        drop(locks);
        assert_checkout_bytes(&f, key, &vec![4; SIZE as usize]).await;
        assert_checkout_bytes(&f, "middle", &vec![2; SIZE as usize]).await;
    }
}

#[tokio::test]
async fn oversized_pending_image_does_not_evict_valid_old_images() {
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    f.cache = with_max_bytes(&f, SIZE + SIZE / 2);
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let context = dense_context(&f, "oversized", 4, "2026-10-15T08:03:00Z").await;
    let before = f.cache.total_cache_allocated_bytes().await.unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert_eq!(f.cache.total_cache_allocated_bytes().await.unwrap(), before);
    assert!(f.image("oldest", &oldest).exists());
    assert!(f.image("middle", &middle).exists());
    assert_eq!(
        tokio::fs::read(f.paths.active_home_image(&context.sandbox_id()))
            .await
            .unwrap(),
        vec![4; SIZE as usize]
    );
    let events = recorded.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, HomeObservationKind::Publication);
    assert_eq!(events[0].reason.as_deref(), Some("cache_budget"));
}

#[tokio::test]
async fn sparse_pending_image_uses_allocated_bytes_and_keeps_metadata_headroom() {
    let mut f = Fixture::new().await;
    let old = commit_dense(&f, "old", 1, "2026-10-15T08:00:00Z").await;
    f.cache = with_max_bytes(&f, SIZE + SIZE / 2);
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
    let allocated = super::super::fs::allocated_bytes(&std::fs::metadata(&source).unwrap());
    assert!(allocated < SIZE);
    let budget = CacheBudget::from_fs_stats(f.cache.fs_stats().await.unwrap());
    assert!(
        f.cache.total_cache_allocated_bytes().await.unwrap() + allocated < budget.max_cache_bytes
    );
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    // The metadata allowance, not the logical image length, requires eviction.
    assert!(!f.image("old", &old).exists());
    drop(context);
    assert_checkout_bytes(&f, "sparse", &original).await;
}

#[tokio::test]
async fn failed_replacement_after_reclamation_preserves_the_previous_commit() {
    let mut f = Fixture::new().await;
    let oldest = commit_dense(&f, "oldest", 1, "2026-10-15T08:00:00Z").await;
    let middle = commit_dense(&f, "middle", 2, "2026-10-15T08:01:00Z").await;
    let previous = commit_dense(&f, "thread", 3, "2026-10-15T08:02:00Z").await;
    f.cache = with_max_bytes(&f, 5 * SIZE);
    let context = dense_context(&f, "thread", 4, "2026-10-15T08:03:00Z").await;
    f.cache.inner.publication_fault.store(
        PublicationFault::BeforeMetadataRename as usize,
        std::sync::atomic::Ordering::SeqCst,
    );
    assert!(context.promote().await.is_err());
    assert!(!f.image("oldest", &oldest).exists());
    assert!(!f.image("middle", &middle).exists());
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
    // Uncommitted image and metadata staging remain counted until owner-safe GC.
    let before = f.cache.total_cache_allocated_bytes().await.unwrap();
    assert!(f.cache.gc(false).await.unwrap() > 0);
    assert!(f.cache.total_cache_allocated_bytes().await.unwrap() < before);
    assert!(!candidate.exists());
    assert_checkout_bytes(&f, "thread", &vec![3; SIZE as usize]).await;
}

#[tokio::test]
async fn stopped_publication_batch_reclaims_old_commits_and_keeps_new_bytes_reusable() {
    let mut f = Fixture::new().await;
    f.cache = with_max_bytes(&f, 5 * SIZE);
    let recorded = RecordedHomeObservations::default();
    f.cache = f.cache.with_telemetry(recorded.handle());
    let mut pending = Vec::new();
    for byte in 1..=8u8 {
        let key = format!("stopped-{byte}");
        let context = dense_context(&f, &key, byte, "2026-10-15T08:03:00Z").await;
        pending.push((key, byte, context));
    }
    let outcomes =
        futures_util::future::join_all(pending.into_iter().map(|(key, byte, context)| {
            let cache = f.cache.clone();
            async move {
                let outcome = context.promote().await.unwrap();
                assert_eq!(outcome, HomeImagePromotionOutcome::Promoted);
                let image = cache
                    .entry_paths(&cache.scoped_cache_key(PROFILE, &key, SIZE))
                    .image(&context.publication_generation())
                    .unwrap();
                assert_eq!(
                    tokio::fs::read(image).await.unwrap(),
                    vec![byte; SIZE as usize]
                );
                drop(context);
                outcome
            }
        }))
        .await;
    assert_eq!(outcomes.len(), 8);
    let events = recorded.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == HomeObservationKind::Publication
                && event.outcome == HomeObservationOutcome::Published)
            .count(),
        8
    );
    assert!(
        events
            .iter()
            .any(|event| event.kind == HomeObservationKind::Removal
                && event.reason.as_deref() == Some("cache_budget"))
    );
    let budget = CacheBudget::from_fs_stats(f.cache.fs_stats().await.unwrap());
    assert!(f.cache.total_cache_allocated_bytes().await.unwrap() <= budget.max_cache_bytes);
    let mut reusable = 0;
    for byte in 1..=8u8 {
        let key = format!("stopped-{byte}");
        if f.cache.entry_paths(&f.key(&key)).metadata().exists() {
            assert_checkout_bytes(&f, &key, &vec![byte; SIZE as usize]).await;
            reusable += 1;
        }
    }
    assert!(reusable > 0 && reusable < 8);
}
