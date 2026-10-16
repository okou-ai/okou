use super::super::*;
use super::support::*;
use std::os::unix::fs::{MetadataExt, symlink};

#[tokio::test]
async fn opaque_entry_survives_gc_while_reader_eligibility_and_orphan_cleanup_stay_separate() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    // Another writer can use a different addressing formula with the same
    // committed-image format. Moving the directory preserves pinned file identity.
    let opaque_key = "a".repeat(64);
    assert_ne!(opaque_key, f.key("thread"));
    let paths = f.cache.entry_paths(&opaque_key);
    std::fs::rename(
        f.cache.entry_paths(&f.key("thread")).entry_dir(),
        paths.entry_dir(),
    )
    .unwrap();
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let orphan_bytes = std::fs::metadata(&orphan).unwrap().blocks() * 512;
    assert_eq!(f.cache.gc(false).await.unwrap(), orphan_bytes);
    assert!(!orphan.exists());
    assert!(paths.image(&committed.image_generation).unwrap().exists());
    assert!(f.cache.total_cache_allocated_bytes().await.unwrap() > 0);
    let inspection = f.cache.inspect().await.unwrap();
    assert_eq!(inspection.summary.invalid_entries, 1);
    assert_eq!(
        inspection.entries[0].reason.as_deref(),
        Some("cache key mismatch")
    );
    assert_eq!(
        f.lease("thread").await.result(),
        HomeCacheCheckoutResult::Miss
    );
}

#[tokio::test]
async fn opaque_entry_is_reclaimable_under_pressure_with_dry_run_and_held_lock_protection() {
    let f = Fixture::new().await;
    f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let opaque_key = "b".repeat(64);
    let paths = f.cache.entry_paths(&opaque_key);
    std::fs::rename(
        f.cache.entry_paths(&f.key("thread")).entry_dir(),
        paths.entry_dir(),
    )
    .unwrap();
    let allocated = super::super::fs::measured_entry_bytes(paths.entry_dir())
        .await
        .unwrap();
    let pressured = HomeImageCache::with_cache_dirs_and_fs_stats(
        f.paths.clone(),
        f.cache.home_image_cache_dir().to_owned(),
        f.cache.inner.lock_dir.clone(),
        "group-a",
        FsStats {
            available_bytes: 0,
            total_bytes: TEST_FS_TOTAL_BYTES,
            ..FsStats::default()
        },
    );
    let lock = runner_host::lock::acquire(pressured.entry_lock_path(&opaque_key))
        .await
        .unwrap();
    assert!(pressured.total_cache_allocated_bytes().await.unwrap() >= allocated);
    assert_eq!(pressured.gc(false).await.unwrap(), 0);
    assert!(paths.metadata().exists());
    drop(lock);
    assert_eq!(pressured.gc(true).await.unwrap(), allocated);
    assert!(paths.metadata().exists());
    assert_eq!(pressured.gc(false).await.unwrap(), allocated);
    assert!(!paths.entry_dir().exists());
}

#[tokio::test]
async fn opaque_address_does_not_exempt_a_corrupt_committed_image_from_safe_cleanup() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&"c".repeat(64));
    std::fs::rename(
        f.cache.entry_paths(&f.key("thread")).entry_dir(),
        paths.entry_dir(),
    )
    .unwrap();
    let image = paths.image(&committed.image_generation).unwrap();
    let sentinel = f.dir.path().join("sentinel");
    std::fs::write(&sentinel, b"preserved").unwrap();
    std::fs::remove_file(&image).unwrap();
    symlink(&sentinel, &image).unwrap();
    assert!(f.cache.gc(false).await.unwrap() > 0);
    assert!(!paths.entry_dir().exists());
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserved");
}

#[tokio::test]
async fn future_consumer_metadata_does_not_invalidate_a_physical_commit_for_gc() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let mut future = serde_json::to_value(&committed).unwrap();
    // A future consumer can change its schema and eligibility while preserving
    // the physical commit contract used by independently executing GC.
    future["formatVersion"] = serde_json::json!(99);
    future["rootfsHash"] = serde_json::Value::Null;
    future["historyProof"] = serde_json::json!({"newProofContract": true});
    future["state"] = serde_json::json!("futureEligibilityState");
    future["reusePolicy"] = serde_json::json!({"revision": 2});
    std::fs::write(paths.metadata(), serde_json::to_vec(&future).unwrap()).unwrap();
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let allocated = std::fs::metadata(&orphan).unwrap().blocks() * 512;
    assert_eq!(f.cache.gc(false).await.unwrap(), allocated);
    assert!(!orphan.exists());
    assert!(paths.image(&committed.image_generation).unwrap().exists());
    let inspection = f.cache.inspect().await.unwrap();
    assert_eq!(inspection.summary.reusable_entries, 0);
    assert_eq!(
        inspection.entries[0].reason.as_deref(),
        Some("missing or invalid canonical metadata")
    );
}

#[tokio::test]
async fn fresh_accounting_counts_metadata_candidates_orphans_and_staging_under_locks() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let key = f.key("thread");
    let paths = f.cache.entry_paths(&key);
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let staging = paths.tmp_image(runner_types::ids::RunId::new_v4());
    write_image(&staging, b"staging", SIZE);
    let meta_staging = paths.tmp_metadata(runner_types::ids::RunId::new_v4());
    std::fs::write(&meta_staging, b"pending metadata").unwrap();
    let expected: u64 = [
        paths.entry_dir().to_owned(),
        paths.metadata(),
        f.image("thread", &committed),
        orphan.clone(),
        staging.clone(),
        meta_staging.clone(),
    ]
    .iter()
    .map(|p| std::fs::symlink_metadata(p).unwrap().blocks() * 512)
    .sum();
    assert_eq!(
        super::super::fs::measured_entry_bytes(paths.entry_dir())
            .await
            .unwrap(),
        expected
    );
    let locked = runner_host::lock::acquire(f.cache.entry_lock_path(&key))
        .await
        .unwrap();
    let total_locked = f.cache.total_cache_allocated_bytes().await.unwrap();
    assert!(total_locked >= expected);
    assert_eq!(f.cache.gc(false).await.unwrap(), 0);
    assert!(orphan.exists() && staging.exists());
    drop(locked);
    let freed = f.cache.gc(false).await.unwrap();
    assert!(freed > 0);
    assert!(!orphan.exists() && !staging.exists() && !meta_staging.exists());
    assert!(f.image("thread", &committed).exists());
    assert_eq!(
        f.metadata("thread").await.image_generation,
        committed.image_generation
    );
}

#[tokio::test]
async fn orphan_cleanup_and_invalid_entry_deletion_never_follow_symlinks() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let sentinel = f.dir.path().join("sentinel");
    std::fs::create_dir(&sentinel).unwrap();
    std::fs::write(sentinel.join("ordinary"), b"preserved").unwrap();
    let orphan = f
        .cache
        .entry_paths(&f.key("thread"))
        .image(&uuid::Uuid::new_v4().to_string())
        .unwrap();
    symlink(&sentinel, &orphan).unwrap();
    f.cache.gc(false).await.unwrap();
    assert!(!orphan.exists());
    assert_eq!(
        std::fs::read(sentinel.join("ordinary")).unwrap(),
        b"preserved"
    );
    assert!(f.image("thread", &committed).exists());
}

#[tokio::test]
async fn gc_dry_run_retains_generation_and_uses_actual_allocated_bytes() {
    let f = Fixture::new().await;
    let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let allocated = std::fs::metadata(&orphan).unwrap().blocks() * 512;
    assert!(allocated < SIZE);
    assert_eq!(f.cache.gc(true).await.unwrap(), allocated);
    assert!(orphan.exists());
    assert_eq!(
        f.metadata("thread").await.image_generation,
        metadata.image_generation
    );
}

#[tokio::test]
async fn dry_run_pressure_counts_orphan_allocation_once_when_evicting_its_whole_entry() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let mut allocated = std::fs::metadata(paths.entry_dir()).unwrap().blocks() * 512;
    for entry in std::fs::read_dir(paths.entry_dir()).unwrap() {
        let metadata = std::fs::symlink_metadata(entry.unwrap().path()).unwrap();
        assert!(metadata.is_file());
        allocated += metadata.blocks() * 512;
    }
    f.cache.set_fs_stats_for_test(FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 1,
        ..FsStats::default()
    });
    assert_eq!(f.cache.gc(true).await.unwrap(), allocated);
    assert!(orphan.exists());
    assert!(f.image("thread", &committed).exists());
    assert_eq!(
        f.metadata("thread").await.image_generation,
        committed.image_generation
    );
}

#[tokio::test]
async fn dry_run_pre_cleanup_recovery_to_low_water_does_not_propose_valid_image_eviction() {
    let f = Fixture::new().await;
    let committed = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let paths = f.cache.entry_paths(&f.key("thread"));
    let orphan = paths.image(&uuid::Uuid::new_v4().to_string()).unwrap();
    write_image(&orphan, b"orphan", SIZE);
    let orphan_bytes = std::fs::metadata(&orphan).unwrap().blocks() * 512;
    assert!(orphan_bytes > 1);
    let stats = FsStats {
        total_bytes: 400 * GIB,
        ..FsStats::default()
    };
    let thresholds = HomeCachePressureThresholds::from_fs_stats(stats);
    f.cache.set_fs_stats_for_test(FsStats {
        available_bytes: thresholds.low_free_bytes - 1,
        ..stats
    });
    assert_eq!(f.cache.gc(true).await.unwrap(), orphan_bytes);
    assert!(orphan.exists());
    assert!(f.image("thread", &committed).exists());
    assert_eq!(
        f.metadata("thread").await.image_generation,
        committed.image_generation
    );
}

#[test]
fn pressure_watermarks_cover_small_infeasible_and_integer_boundaries() {
    let example = HomeCachePressureThresholds::from_fs_stats(FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 200 * GIB,
        ..FsStats::default()
    });
    assert_eq!(example.reserve_bytes, 50 * GIB);
    assert_eq!(example.low_free_bytes, 50 * GIB + 50 * GIB / 4);
    assert_eq!(example.high_free_bytes, 75 * GIB);
    assert!(example.reserve_feasible);
    for total_bytes in [0, 1, 40 * GIB] {
        let policy = HomeCachePressureThresholds::from_fs_stats(FsStats {
            total_bytes,
            ..FsStats::default()
        });
        assert_eq!(policy.reserve_bytes, 50 * GIB);
        assert!(!policy.reserve_feasible);
    }
    let largest = HomeCachePressureThresholds::from_fs_stats(FsStats {
        total_bytes: u64::MAX,
        ..FsStats::default()
    });
    assert_eq!(largest.reserve_bytes, u64::MAX / 10);
    assert!(largest.reserve_feasible);
    assert!(largest.reserve_bytes < largest.low_free_bytes);
    assert!(largest.low_free_bytes < largest.high_free_bytes);
    assert_eq!(largest.high_free_bytes, 2_767_011_611_056_432_741);
}

#[test]
fn foreground_peak_and_complete_legacy_projection_are_distinct_from_background_recovery() {
    let stats = FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 51 * GIB,
        ..FsStats::default()
    };
    let pressure = HomeCachePressureThresholds::from_fs_stats(stats);
    assert!(stats.available_bytes < pressure.low_free_bytes);
    assert!(super::super::fs::has_copy_headroom(stats, pressure, GIB));
    assert!(!super::super::fs::has_copy_headroom(
        stats,
        pressure,
        GIB + 1
    ));
    let complete = CacheBudget::from_observed_allocation(stats, Some(250 * GIB));
    assert!(complete.complete);
    assert_eq!(complete.max_cache_bytes, 251 * GIB);
    assert_eq!(complete.target_after_gc_bytes, 226 * GIB);
    let unavailable = CacheBudget::from_observed_allocation(stats, None);
    assert!(!unavailable.complete);
    assert_eq!(unavailable.max_cache_bytes, 0);
}
