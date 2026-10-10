use super::super::*;
use super::support::*;
use std::os::unix::fs::{MetadataExt, symlink};

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

#[test]
fn budget_preserves_zero_small_and_saturating_arithmetic_boundaries() {
    for (total_bytes, maximum, target, reserve) in [
        (0, 0, 0, 50 * GIB),
        (1, 0, 0, 50 * GIB),
        (
            u64::MAX,
            u64::MAX / 100,
            (u64::MAX / 100) * 75 / 100,
            u64::MAX / 100,
        ),
    ] {
        let budget = CacheBudget::from_fs_stats(FsStats {
            total_bytes,
            total_inodes: 100,
            available_inodes: 0,
            ..FsStats::default()
        });
        assert_eq!(budget.max_cache_bytes, maximum);
        assert_eq!(budget.target_after_gc_bytes, target);
        assert_eq!(budget.min_free_bytes, reserve);
    }
}

#[test]
fn safe_default_budget_and_gc_target_are_exact_without_host_percentage_entry_cap() {
    let stats = FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 200 * GIB,
        ..FsStats::default()
    };
    let budget = CacheBudget::from_fs_stats(stats);
    assert_eq!(budget.max_cache_bytes, 200 * GIB);
    assert_eq!(budget.target_after_gc_bytes, 150 * GIB);
    assert_eq!(budget.min_free_bytes, 50 * GIB);
    let big = CacheBudget::from_fs_stats(FsStats {
        total_bytes: 2000 * GIB,
        available_bytes: 1000 * GIB,
        ..FsStats::default()
    });
    assert_eq!(big.min_free_bytes, 200 * GIB);
    assert!(!super::super::gc::gc_budget_satisfied(
        true,
        151 * GIB,
        1,
        stats,
        budget,
        0
    ));
    assert!(super::super::gc::gc_budget_satisfied(
        true,
        150 * GIB,
        1,
        stats,
        budget,
        0
    ));
    assert!(!super::super::fs::has_copy_headroom(
        FsStats {
            available_bytes: 50 * GIB,
            ..stats
        },
        budget,
        1
    ));
}
