use std::collections::HashMap;
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};

use super::*;
use crate::cmd::gc::test_support::{
    assert_is_symlink, old_gc_time, set_mtime, set_soft_nofile_limit_for_child, test_home,
};
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use runner_host::lock;

fn rootfs_state_with_deletion(
    rootfs_path: PathBuf,
    rootfs_hash: &str,
    snapshot_hash: &str,
) -> RootfsState {
    RootfsState {
        path: rootfs_path,
        hash: rootfs_hash.to_owned(),
        snapshot_dispositions: HashMap::from([(
            snapshot_hash.to_owned(),
            SnapshotDisposition::Delete,
        )]),
    }
}

async fn assert_incomplete_snapshot_scan_keeps_rootfs(dry_run: bool) {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_dir = home.images_dir().join("rootfs_incomplete_scan");
    let snapshots_dir = rootfs_dir.join("snapshots");
    let snapshot_dirs = [
        snapshots_dir.join("snapshot_a"),
        snapshots_dir.join("snapshot_b"),
    ];
    for snapshot_dir in &snapshot_dirs {
        std::fs::create_dir_all(snapshot_dir).unwrap();
        std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
        set_mtime(snapshot_dir, old_gc_time());
    }
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&rootfs_dir, old_gc_time());

    let report = gc_nested_images_with_injected_snapshot_scan_error(
        &home,
        Some(0),
        dry_run,
        &ProtectedImageRefs::new(),
        1,
    )
    .await
    .unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        rootfs_dir.exists(),
        "an incompletely scanned rootfs must survive"
    );
    for snapshot_dir in snapshot_dirs {
        assert!(
            snapshot_dir.exists(),
            "all snapshots must survive an incomplete directory scan"
        );
    }
}

async fn assert_incomplete_action_scan_keeps_rootfs(dry_run: bool) {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_dir = home.images_dir().join("rootfs_incomplete_action_scan");
    let snapshots_dir = rootfs_dir.join("snapshots");
    let snapshot_dirs = [
        snapshots_dir.join("snapshot_a"),
        snapshots_dir.join("snapshot_b"),
    ];
    for snapshot_dir in &snapshot_dirs {
        std::fs::create_dir_all(snapshot_dir).unwrap();
        std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
        set_mtime(snapshot_dir, old_gc_time());
    }
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&rootfs_dir, old_gc_time());

    let report = gc_nested_images_with_injected_action_scan_error(
        &home,
        Some(0),
        dry_run,
        &ProtectedImageRefs::new(),
        1,
    )
    .await
    .unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        rootfs_dir.exists(),
        "a rootfs with an incomplete action scan must survive"
    );
    for snapshot_dir in snapshot_dirs {
        assert!(
            snapshot_dir.exists(),
            "action must not start before the current snapshot scan completes"
        );
    }
}

#[tokio::test]
async fn gc_nested_images_fails_closed_after_snapshot_scan_error() {
    assert_incomplete_snapshot_scan_keeps_rootfs(false).await;
}

#[tokio::test]
async fn gc_nested_images_dry_run_ignores_incomplete_snapshot_scan() {
    assert_incomplete_snapshot_scan_keeps_rootfs(true).await;
}

#[tokio::test]
async fn gc_nested_images_fails_closed_after_action_scan_error() {
    assert_incomplete_action_scan_keeps_rootfs(false).await;
}

#[tokio::test]
async fn gc_nested_images_dry_run_ignores_incomplete_action_scan() {
    assert_incomplete_action_scan_keeps_rootfs(true).await;
}

#[tokio::test]
async fn gc_nested_images_empty_dir_returns_zero() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let freed = gc_nested_images(&home, Some(1), false).await.unwrap();
    assert_eq!(freed, 0);
}

#[tokio::test]
async fn gc_nested_images_keeps_locked_current_template_warm_dir() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let warm_dir = home.images_dir().join("template-warm-abc123");
    std::fs::create_dir_all(&warm_dir).unwrap();
    std::fs::write(warm_dir.join("attempt-old.tmp"), b"partial").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&warm_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let lock_file = lock::open_lock_file(&home.template_lock("abc123")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(warm_dir.exists(), "active warm rootfs dir must survive GC");
}

#[tokio::test]
async fn gc_nested_images_does_not_treat_legacy_name_as_template_warm_dir() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let legacy_dir = home.images_dir().join("template-abc123.warm.tmp");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(legacy_dir.join("template.ext4"), b"partial").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&legacy_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let lock_file = lock::open_lock_file(&home.template_lock("abc123")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert!(
        !legacy_dir.exists(),
        "the retired name must not be protected by the template lock"
    );
    assert!(freed > 0);
}

#[tokio::test]
async fn gc_nested_images_keeps_recent_current_template_warm_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let warm_dir = home.images_dir().join("template-warm-abc123");
    std::fs::create_dir_all(&warm_dir).unwrap();
    std::fs::write(warm_dir.join("attempt-new.tmp"), b"partial").unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        warm_dir.exists(),
        "recent warm rootfs dir must survive the GC grace window"
    );
}

#[tokio::test]
async fn gc_nested_images_removes_stale_current_template_warm_dir() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let warm_dir = home.images_dir().join("template-warm-abc123");
    std::fs::create_dir_all(&warm_dir).unwrap();
    std::fs::write(warm_dir.join("attempt-old.tmp"), b"partial").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&warm_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert!(
        !warm_dir.exists(),
        "stale warm rootfs dir should be removed"
    );
    assert!(freed > 0);
}

#[tokio::test]
async fn gc_nested_images_dry_run_reports_stale_current_template_warm_dir() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let warm_dir = home.images_dir().join("template-warm-abc123");
    std::fs::create_dir_all(&warm_dir).unwrap();
    std::fs::write(warm_dir.join("attempt-old.tmp"), b"partial").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&warm_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let (expected_size, _) = dir_stats(&warm_dir).await;
    assert!(expected_size > 0, "test fixture must have non-zero size");

    let freed = gc_nested_images(&home, Some(0), true).await.unwrap();

    assert!(
        warm_dir.exists(),
        "dry-run must preserve the warm directory"
    );
    assert_eq!(freed, expected_size);
}

#[tokio::test]
async fn gc_nested_images_keeps_latest_single_rootfs() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Create rootfs with two snapshots
    let rootfs_dir = images_dir.join("rootfs_aaa");
    let snap_old = rootfs_dir.join("snapshots").join("snap_old");
    let snap_new = rootfs_dir.join("snapshots").join("snap_new");
    for d in [&snap_old, &snap_new] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
    }
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Set distinct mtimes — old snapshot is clearly old
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&snap_old)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    let new_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    std::fs::File::open(&snap_new)
        .unwrap()
        .set_times(FileTimes::new().set_modified(new_time))
        .unwrap();

    let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

    assert!(snap_new.exists(), "newest snapshot should survive");
    assert!(!snap_old.exists(), "oldest snapshot should be deleted");
    assert!(
        rootfs_dir.join("rootfs.ext4").exists(),
        "rootfs should survive"
    );
    assert!(freed > 0);
}

/// Global top-N across rootfs: three distinct rootfs each with a single
/// snapshot. `keep_latest=1` keeps only the globally newest; the other
/// two rootfs become orphan (no surviving snapshot) and get deleted
/// alongside their lone snapshot.
#[tokio::test]
async fn gc_nested_images_keeps_global_top_n_across_rootfs() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let specs: [(&str, &str, u64); 3] = [
        ("rootfs_oldest", "snap_oldest", 1_000_000),
        ("rootfs_middle", "snap_middle", 2_000_000),
        ("rootfs_newest", "snap_newest", 3_000_000),
    ];

    for (rootfs_name, snap_name, mtime_secs) in &specs {
        let rootfs_dir = images_dir.join(rootfs_name);
        let snap = rootfs_dir.join("snapshots").join(snap_name);
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(*mtime_secs);
        std::fs::File::open(&snap)
            .unwrap()
            .set_times(FileTimes::new().set_modified(t))
            .unwrap();
        // Age-gate the rootfs dir so orphan cleanup is eligible.
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(t))
            .unwrap();
    }

    let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

    // Only the globally newest rootfs+snapshot should survive.
    assert!(
        images_dir.join("rootfs_newest").exists(),
        "globally newest rootfs should survive"
    );
    assert!(
        images_dir
            .join("rootfs_newest/snapshots/snap_newest")
            .exists(),
        "globally newest snapshot should survive"
    );
    assert!(
        !images_dir.join("rootfs_middle").exists(),
        "middle rootfs should be deleted (snapshot not in top-1)"
    );
    assert!(
        !images_dir.join("rootfs_oldest").exists(),
        "oldest rootfs should be deleted (snapshot not in top-1)"
    );
    assert!(freed > 0);
}

/// Top-N selection must pick across rootfs boundaries — if rootfs A has
/// the newest snapshot and rootfs B has the second-newest, `keep_latest=2`
/// must keep one from each rather than greedily draining A. Regression
/// guard: a bug that reintroduced per-rootfs buckets would keep only A
/// and drop B entirely.
#[tokio::test]
async fn gc_nested_images_top_n_spans_multiple_rootfs() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Two rootfs, each with one old snapshot. Rootfs A's snapshot is
    // newer than rootfs B's.
    let rootfs_a = images_dir.join("rootfs_a");
    let snap_a = rootfs_a.join("snapshots").join("snap_a");
    let rootfs_b = images_dir.join("rootfs_b");
    let snap_b = rootfs_b.join("snapshots").join("snap_b");
    for d in [&snap_a, &snap_b] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
    }
    std::fs::write(rootfs_a.join("rootfs.ext4"), b"rootfs_a").unwrap();
    std::fs::write(rootfs_b.join("rootfs.ext4"), b"rootfs_b").unwrap();

    let time_b = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let time_a = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    std::fs::File::open(&snap_a)
        .unwrap()
        .set_times(FileTimes::new().set_modified(time_a))
        .unwrap();
    std::fs::File::open(&snap_b)
        .unwrap()
        .set_times(FileTimes::new().set_modified(time_b))
        .unwrap();

    // keep_latest=2 with 2 total candidates across 2 rootfs → both stay.
    let freed = gc_nested_images(&home, Some(2), false).await.unwrap();
    assert!(snap_a.exists(), "snap_a (newest) must survive");
    assert!(
        snap_b.exists(),
        "snap_b (older, but still in top-2 globally) must survive"
    );
    assert_eq!(freed, 0, "no candidates should have been deleted");
}

/// Locked and recent snapshots are protected but must NOT consume a
/// top-N slot — the quota applies only to the eligible (unlocked,
/// old-enough) candidate pool. Regression guard for a variant where
/// `keep_latest` was implemented against the raw snapshot count.
#[tokio::test]
async fn gc_nested_images_locked_and_recent_snapshots_dont_consume_top_n() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // rootfs_locked: one locked snapshot (in use) — protected, outside quota.
    let rootfs_locked = images_dir.join("rootfs_locked");
    let snap_locked = rootfs_locked.join("snapshots").join("snap_locked");
    std::fs::create_dir_all(&snap_locked).unwrap();
    std::fs::write(snap_locked.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_locked.join("rootfs.ext4"), b"r").unwrap();
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&snap_locked)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    // rootfs_recent: one recent snapshot (< GC_MIN_AGE) — protected, outside quota.
    let rootfs_recent = images_dir.join("rootfs_recent");
    let snap_recent = rootfs_recent.join("snapshots").join("snap_recent");
    std::fs::create_dir_all(&snap_recent).unwrap();
    std::fs::write(snap_recent.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_recent.join("rootfs.ext4"), b"r").unwrap();
    // snap_recent mtime stays at "now" (default), so age < GC_MIN_AGE.

    // rootfs_old: two eligible old snapshots, only one should survive keep_latest=1.
    let rootfs_old = images_dir.join("rootfs_old");
    let snap_old_a = rootfs_old.join("snapshots").join("snap_old_a");
    let snap_old_b = rootfs_old.join("snapshots").join("snap_old_b");
    for d in [&snap_old_a, &snap_old_b] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
    }
    std::fs::write(rootfs_old.join("rootfs.ext4"), b"r").unwrap();
    let older = SystemTime::UNIX_EPOCH + Duration::from_secs(500_000);
    let newer = SystemTime::UNIX_EPOCH + Duration::from_secs(900_000);
    std::fs::File::open(&snap_old_a)
        .unwrap()
        .set_times(FileTimes::new().set_modified(older))
        .unwrap();
    std::fs::File::open(&snap_old_b)
        .unwrap()
        .set_times(FileTimes::new().set_modified(newer))
        .unwrap();

    // Hold a shared lock on snap_locked (simulating runner start).
    let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_locked")).unwrap();
    let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

    let freed = gc_nested_images(&home, Some(1), false).await.unwrap();

    // Protected: untouched.
    assert!(snap_locked.exists(), "locked snapshot must survive");
    assert!(snap_recent.exists(), "recent snapshot must survive");
    // Eligible pool = {snap_old_a, snap_old_b}. keep_latest=1 → snap_old_b
    // (newer mtime) survives, snap_old_a is deleted. Crucially, the quota
    // was NOT consumed by snap_locked or snap_recent.
    assert!(snap_old_b.exists(), "newer eligible snapshot must survive");
    assert!(
        !snap_old_a.exists(),
        "older eligible snapshot must be deleted (top-1 quota spent on snap_old_b)"
    );
    // rootfs_old still has snap_old_b → rootfs dir survives.
    assert!(rootfs_old.exists(), "rootfs with surviving snapshot stays");
    assert!(freed > 0);
}

/// A rootfs whose mtime is younger than `GC_MIN_AGE` must NOT be
/// orphan-deleted, even after all its old snapshots are pruned. The
/// `any_snapshot_survives=false` branch in Phase 3 routes through
/// `try_delete_orphan_rootfs` which applies a second age check against
/// the rootfs-dir mtime itself. Covers the invariant that removing a
/// snapshot subdir does NOT bump the rootfs-dir mtime (only its
/// `snapshots/` child's mtime), so a freshly-built rootfs is preserved
/// during its build-release race window.
#[tokio::test]
async fn gc_nested_images_recent_rootfs_with_all_old_snaps_stays() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_recent_shell");
    let snap = rootfs_dir.join("snapshots").join("snap_old");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Snapshot is old — eligible for deletion.
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&snap)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    // Rootfs dir itself stays at mtime "now" (default) — inside GC_MIN_AGE.

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert!(
        !snap.exists(),
        "old snapshot is eligible and must be deleted"
    );
    assert!(
        rootfs_dir.exists(),
        "rootfs dir is recent — must survive even with no snapshots left"
    );
    assert!(
        rootfs_dir.join("rootfs.ext4").exists(),
        "rootfs file must still be on disk"
    );
    assert!(freed > 0, "snapshot bytes should be counted as freed");
}

/// Dry-run under global top-N across multiple rootfs: the reported
/// `freed` bytes must equal what a real run would free, with each
/// orphaned rootfs contributing its *full* directory size (snapshot
/// bytes + rootfs files) exactly once. Regression guard for the
/// per-rootfs `dry_run_snapshot_bytes` overlap vector — an off-by-one
/// or wrong-index subtraction would show up as a byte mismatch here.
#[tokio::test]
async fn gc_nested_images_dry_run_global_top_n_byte_accounting() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Three rootfs, each with one old snapshot, strictly increasing mtimes.
    let specs: [(&str, &str, u64); 3] = [
        ("rootfs_1", "snap_1", 1_000_000),
        ("rootfs_2", "snap_2", 2_000_000),
        ("rootfs_3", "snap_3", 3_000_000),
    ];
    for (rootfs_name, snap_name, mtime_secs) in &specs {
        let rootfs_dir = images_dir.join(rootfs_name);
        let snap = rootfs_dir.join("snapshots").join(snap_name);
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
        let t = SystemTime::UNIX_EPOCH + Duration::from_secs(*mtime_secs);
        std::fs::File::open(&snap)
            .unwrap()
            .set_times(FileTimes::new().set_modified(t))
            .unwrap();
        // Age-gate the rootfs dir so orphan cleanup is eligible in
        // both dry-run and real-mode.
        std::fs::File::open(&rootfs_dir)
            .unwrap()
            .set_times(FileTimes::new().set_modified(t))
            .unwrap();
    }

    // Expected: dry-run with keep_latest=1 would wipe rootfs_1 and
    // rootfs_2 in full; rootfs_3's snapshot survives as top-1. The
    // reported bytes should equal the full dir size of rootfs_1 +
    // rootfs_2 (captured BEFORE dry-run, because dry-run leaves disk
    // untouched and we can measure after).
    let (rootfs_1_bytes, _) = dir_stats(&images_dir.join("rootfs_1")).await;
    let (rootfs_2_bytes, _) = dir_stats(&images_dir.join("rootfs_2")).await;
    let expected = rootfs_1_bytes + rootfs_2_bytes;
    assert!(expected > 0, "test fixture must have non-zero size");

    let freed = gc_nested_images(&home, Some(1), true).await.unwrap();

    // Dry-run leaves everything in place.
    assert!(images_dir.join("rootfs_1").exists());
    assert!(images_dir.join("rootfs_2").exists());
    assert!(images_dir.join("rootfs_3").exists());
    assert_eq!(
        freed, expected,
        "dry-run bytes must match the sum of orphaned rootfs dir sizes"
    );
}

#[tokio::test]
async fn gc_nested_images_orphaned_rootfs_old_enough() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    // Rootfs with no snapshots/ directory at all
    let rootfs_dir = images_dir.join("orphan_rootfs");
    std::fs::create_dir_all(&rootfs_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Make it old enough for GC
    let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::open(&rootfs_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let freed = gc_nested_images(&home, None, false).await.unwrap();
    assert!(!rootfs_dir.exists(), "orphaned rootfs should be deleted");
    assert!(freed > 0);
}

#[tokio::test]
async fn gc_nested_images_reports_zero_byte_rootfs_removal_as_activity() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    let rootfs_dir = home.images_dir().join("empty_rootfs");
    std::fs::create_dir_all(&rootfs_dir).unwrap();
    std::fs::File::open(&rootfs_dir)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
        )
        .unwrap();
    let (rootfs_size, _) = dir_stats(&rootfs_dir).await;
    assert_eq!(rootfs_size, 0, "fixture must exercise zero-byte cleanup");

    let report =
        gc_nested_images_with_protected_refs(&home, None, false, &ProtectedImageRefs::new())
            .await
            .unwrap();

    assert!(
        !rootfs_dir.exists(),
        "eligible empty rootfs should be removed"
    );
    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 1);
}

#[cfg(unix)]
#[tokio::test]
async fn try_delete_orphan_rootfs_skips_symlink_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.images_dir()).unwrap();

    let outside_rootfs = dir.path().join("outside-rootfs");
    std::fs::create_dir_all(&outside_rootfs).unwrap();
    std::fs::write(outside_rootfs.join("rootfs.ext4"), b"outside").unwrap();

    let rootfs_link = home.images_dir().join("rootfs_replaced");
    std::os::unix::fs::symlink(&outside_rootfs, &rootfs_link).unwrap();

    let freed = try_delete_orphan_rootfs(&rootfs_link, "rootfs_replaced", false).await;

    assert_eq!(freed, None);
    assert_is_symlink(&rootfs_link, "symlink replacement must remain");
    assert!(
        outside_rootfs.join("rootfs.ext4").exists(),
        "orphan-rootfs recheck must not delete a symlink replacement target"
    );
}

/// Dry-run over an orphaned rootfs (no `snapshots/` subdir) must count the
/// would-be-freed bytes via `try_delete_orphan_rootfs`. Regression guard
/// for the silent-zero bug where dry-run returned 0 and `run_gc` printed
/// "nothing to clean up" despite per-entry "would delete" log lines.
#[tokio::test]
async fn gc_nested_images_dry_run_reports_orphan_rootfs_bytes() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("orphan_rootfs_dry");
    std::fs::create_dir_all(&rootfs_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::open(&rootfs_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let (expected_size, _) = dir_stats(&rootfs_dir).await;
    assert!(expected_size > 0, "test fixture must have non-zero size");

    let freed = gc_nested_images(&home, None, true).await.unwrap();
    assert!(rootfs_dir.exists(), "dry-run must not delete orphan rootfs");
    assert_eq!(
        freed, expected_size,
        "dry-run must report would-be-freed bytes for orphan rootfs"
    );
}

/// Dry-run with keep_latest=0 over a rootfs whose only snapshot would be
/// deleted: the rootfs becomes logically orphan, so the total covers the
/// snapshot + rootfs.ext4 + metadata — i.e. the whole rootfs directory.
/// Mirrors what a real `gc` run would free (snapshot physically deleted,
/// then rootfs dir deleted).
#[tokio::test]
async fn gc_nested_images_dry_run_reports_would_be_freed() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_bbb");
    let snap = rootfs_dir.join("snapshots").join("snap_x");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&snap)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    // Age-gate the rootfs too so try_delete_orphan_rootfs doesn't
    // skip it as "too recent".
    std::fs::File::open(&rootfs_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    // The whole rootfs dir would vanish under real GC (all snapshots
    // deleted → rootfs becomes orphan → rootfs deleted). Dry-run must
    // report the same total.
    let (expected_size, _) = dir_stats(&rootfs_dir).await;
    assert!(expected_size > 0, "test fixture must have non-zero size");

    let freed = gc_nested_images(&home, Some(0), true).await.unwrap();
    assert!(snap.exists(), "dry-run must not delete snapshot");
    assert!(
        rootfs_dir.exists(),
        "dry-run must not delete rootfs directory"
    );
    assert_eq!(
        freed, expected_size,
        "dry-run must report total rootfs bytes when all snapshots would be deleted"
    );
}

/// Dry-run with keep_latest=1 over a rootfs with 2 eligible snapshots:
/// one snapshot would survive, rootfs is NOT orphan, total covers only
/// the deleted snapshot — not the rootfs itself.
#[tokio::test]
async fn gc_nested_images_dry_run_partial_kept_no_orphan() {
    use std::fs::FileTimes;
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_partial");
    let snap_old = rootfs_dir.join("snapshots").join("snap_old");
    let snap_new = rootfs_dir.join("snapshots").join("snap_new");
    for d in [&snap_old, &snap_new] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
    }
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&snap_old)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    let new_time = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    std::fs::File::open(&snap_new)
        .unwrap()
        .set_times(FileTimes::new().set_modified(new_time))
        .unwrap();

    let (expected_size, _) = dir_stats(&snap_old).await;
    assert!(expected_size > 0, "test fixture must have non-zero size");

    let freed = gc_nested_images(&home, Some(1), true).await.unwrap();
    assert!(snap_old.exists(), "dry-run must not delete snapshot");
    assert!(snap_new.exists(), "kept snapshot must survive dry-run");
    assert_eq!(
        freed, expected_size,
        "dry-run must report only the deleted snapshot bytes; rootfs stays because snap_new survives"
    );
}

/// Empty `snapshots/` directory (not missing, just empty) → orphan rootfs deleted.
/// Different code path from "no snapshots/ dir at all" (which hits the NotFound branch).
#[tokio::test]
async fn gc_nested_images_empty_snapshots_dir_orphans_rootfs() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_empty_snaps");
    let snapshots_dir = rootfs_dir.join("snapshots");
    std::fs::create_dir_all(&snapshots_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Make rootfs old enough for GC.
    let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::open(&rootfs_dir)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let freed = gc_nested_images(&home, None, false).await.unwrap();
    assert!(
        !rootfs_dir.exists(),
        "orphaned rootfs (empty snapshots/) should be deleted"
    );
    assert!(freed > 0);
}

/// Snapshots younger than GC_MIN_AGE are unconditionally kept, even with keep_latest=0.
#[tokio::test]
async fn gc_nested_images_recent_snapshot_protected() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_recent");
    let snap = rootfs_dir.join("snapshots").join("snap_fresh");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // mtime is NOW (default) — well within GC_MIN_AGE.
    // keep_latest=0 would delete everything, but GC_MIN_AGE protects.
    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
    assert!(
        snap.exists(),
        "recent snapshot must survive despite keep_latest=0"
    );
    assert!(
        rootfs_dir.exists(),
        "rootfs must survive (has protected snapshot)"
    );
    assert_eq!(freed, 0);
}

/// When the rootfs lock is held, GC skips the whole rootfs. This avoids
/// racing `runner start`, which acquires shared rootfs before shared
/// snapshot and may be between those two locks.
async fn assert_locked_rootfs_keeps_all_snapshots() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("can_delete_rootfs");
    let snap_used = rootfs_dir.join("snapshots").join("snap_used");
    let snap_old = rootfs_dir.join("snapshots").join("snap_old");
    for d in [&snap_used, &snap_old] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("snapshot.bin"), b"data").unwrap();
    }
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Make snap_old old enough to be GC-eligible.
    let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::open(&snap_old)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    // Simulate `runner start` holding shared locks on rootfs + snap_used.
    let rootfs_lock_path = home.rootfs_lock("can_delete_rootfs");
    let rootfs_lock_file = lock::open_lock_file(&rootfs_lock_path).unwrap();
    let _rootfs_held = Flock::lock(rootfs_lock_file, FlockArg::LockShared).unwrap();
    let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_used")).unwrap();
    let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
    assert!(
        snap_old.exists(),
        "unlocked old snapshot should survive while rootfs lock is held"
    );
    assert!(snap_used.exists(), "locked snapshot must survive");
    assert!(rootfs_dir.exists(), "rootfs must survive (lock held)");
    assert_eq!(freed, 0);
}

#[tokio::test]
async fn gc_nested_images_locked_rootfs_keeps_all_snapshots() {
    assert_locked_rootfs_keeps_all_snapshots().await;
}

/// A locked snapshot must survive even with keep_latest=0 and old mtime.
#[tokio::test]
async fn gc_nested_images_skips_locked_snapshot() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let images_dir = home.images_dir();
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();

    let rootfs_dir = images_dir.join("rootfs_lock_test");
    let snap = rootfs_dir.join("snapshots").join("snap_locked");
    std::fs::create_dir_all(&snap).unwrap();
    std::fs::write(snap.join("snapshot.bin"), b"data").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();

    // Make old enough to be GC-eligible.
    let old_time = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    std::fs::File::open(&snap)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    // Hold a shared lock on the snapshot (simulating runner start).
    let snap_lock_file = lock::open_lock_file(&home.snapshot_lock("snap_locked")).unwrap();
    let _snap_held = Flock::lock(snap_lock_file, FlockArg::LockShared).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();
    assert!(snap.exists(), "locked snapshot must survive");
    assert_eq!(freed, 0);
}

#[tokio::test]
async fn gc_rootfs_action_keeps_candidate_locked_after_inventory() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_hash = "rootfs_action_lock";
    let snapshot_hash = "snapshot_action_lock";
    let rootfs_dir = home.images_dir().join(rootfs_hash);
    let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
    std::fs::create_dir_all(&snapshot_dir).unwrap();
    std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&snapshot_dir, old_gc_time());
    set_mtime(&rootfs_dir, old_gc_time());

    let state = rootfs_state_with_deletion(rootfs_dir.clone(), rootfs_hash, snapshot_hash);
    let snapshot_lock_file = lock::open_lock_file(&home.snapshot_lock(snapshot_hash)).unwrap();
    let _snapshot_lock = Flock::lock(snapshot_lock_file, FlockArg::LockShared).unwrap();
    let mut action_entry_reader = GcDirEntryReader::new();

    let report = gc_rootfs_action(&home, &state, false, &mut action_entry_reader).await;

    assert_eq!(report, GcReport::default());
    assert!(
        snapshot_dir.exists(),
        "a candidate locked after inventory must survive action"
    );
    assert!(rootfs_dir.exists(), "the candidate's rootfs must survive");
}

#[tokio::test]
async fn gc_rootfs_action_keeps_candidate_with_rootfs_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_hash = "rootfs_action_rootfs_lock";
    let snapshot_hash = "snapshot_action_rootfs_lock";
    let rootfs_dir = home.images_dir().join(rootfs_hash);
    let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
    std::fs::create_dir_all(&snapshot_dir).unwrap();
    std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&snapshot_dir, old_gc_time());
    set_mtime(&rootfs_dir, old_gc_time());

    let state = rootfs_state_with_deletion(rootfs_dir.clone(), rootfs_hash, snapshot_hash);
    let rootfs_lock_path = home.rootfs_lock(rootfs_hash);
    let rootfs_lock_file = lock::open_lock_file(&rootfs_lock_path).unwrap();
    let _rootfs_lock = Flock::lock(rootfs_lock_file, FlockArg::LockShared).unwrap();
    let mut action_entry_reader = GcDirEntryReader::new();

    let report = gc_rootfs_action(&home, &state, false, &mut action_entry_reader).await;

    assert_eq!(report, GcReport::default());
    assert!(
        snapshot_dir.exists(),
        "a candidate protected by the rootfs lock must survive action"
    );
    assert!(rootfs_dir.exists(), "the candidate's rootfs must survive");
}

#[tokio::test]
async fn gc_rootfs_action_keeps_candidate_that_became_recent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_hash = "rootfs_action_recent";
    let snapshot_hash = "snapshot_action_recent";
    let rootfs_dir = home.images_dir().join(rootfs_hash);
    let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
    std::fs::create_dir_all(&snapshot_dir).unwrap();
    std::fs::write(snapshot_dir.join("snapshot.bin"), b"snapshot").unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&snapshot_dir, old_gc_time());
    set_mtime(&rootfs_dir, old_gc_time());

    let state = rootfs_state_with_deletion(rootfs_dir.clone(), rootfs_hash, snapshot_hash);
    set_mtime(&snapshot_dir, SystemTime::now());
    let mut action_entry_reader = GcDirEntryReader::new();

    let report = gc_rootfs_action(&home, &state, false, &mut action_entry_reader).await;

    assert_eq!(report, GcReport::default());
    assert!(
        snapshot_dir.exists(),
        "a candidate that became recent after inventory must survive action"
    );
    assert!(rootfs_dir.exists(), "the candidate's rootfs must survive");
}

#[cfg(unix)]
#[tokio::test]
async fn gc_nested_images_skips_symlink_rootfs_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    std::fs::create_dir_all(home.images_dir()).unwrap();

    let target_rootfs = dir.path().join("outside-rootfs");
    let target_snapshot = target_rootfs.join("snapshots").join("snap_old");
    std::fs::create_dir_all(&target_snapshot).unwrap();
    std::fs::write(target_snapshot.join("snapshot.bin"), b"outside").unwrap();
    set_mtime(&target_snapshot, old_gc_time());
    set_mtime(&target_rootfs, old_gc_time());

    let rootfs_link = home.images_dir().join("rootfs_link");
    std::os::unix::fs::symlink(&target_rootfs, &rootfs_link).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert_eq!(freed, 0);
    assert_is_symlink(&rootfs_link, "symlinked rootfs entry must remain");
    assert!(
        target_snapshot.exists(),
        "GC must not delete snapshots through a symlinked rootfs"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_nested_images_skips_symlink_snapshots_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_dir = home.images_dir().join("rootfs_with_symlink_snapshots");
    std::fs::create_dir_all(&rootfs_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&rootfs_dir, old_gc_time());

    let outside_snapshots = dir.path().join("outside-snapshots");
    let outside_snapshot = outside_snapshots.join("snap_old");
    std::fs::create_dir_all(&outside_snapshot).unwrap();
    std::fs::write(outside_snapshot.join("snapshot.bin"), b"outside").unwrap();
    set_mtime(&outside_snapshot, old_gc_time());
    std::os::unix::fs::symlink(&outside_snapshots, rootfs_dir.join("snapshots")).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        rootfs_dir.exists(),
        "rootfs with symlinked snapshots dir must be skipped, not orphan-deleted"
    );
    assert_is_symlink(
        &rootfs_dir.join("snapshots"),
        "symlinked snapshots dir must remain",
    );
    assert!(
        outside_snapshot.exists(),
        "GC must not delete snapshots through a symlinked snapshots dir"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_nested_images_symlink_snapshot_entry_preserves_rootfs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let rootfs_dir = home.images_dir().join("rootfs_with_symlink_snapshot");
    let snapshots_dir = rootfs_dir.join("snapshots");
    std::fs::create_dir_all(&snapshots_dir).unwrap();
    std::fs::write(rootfs_dir.join("rootfs.ext4"), b"rootfs").unwrap();
    set_mtime(&rootfs_dir, old_gc_time());

    let outside_snapshot = dir.path().join("outside-snapshot");
    std::fs::create_dir_all(&outside_snapshot).unwrap();
    std::fs::write(outside_snapshot.join("snapshot.bin"), b"outside").unwrap();
    set_mtime(&outside_snapshot, old_gc_time());
    let snapshot_link = snapshots_dir.join("snap_link");
    std::os::unix::fs::symlink(&outside_snapshot, &snapshot_link).unwrap();

    let freed = gc_nested_images(&home, Some(0), false).await.unwrap();

    assert_eq!(freed, 0);
    assert!(
        rootfs_dir.exists(),
        "symlinked snapshot entry must preserve its rootfs"
    );
    assert_is_symlink(&snapshot_link, "symlinked snapshot entry must remain");
    assert!(
        outside_snapshot.exists(),
        "GC must not delete a symlinked snapshot target"
    );
}

const LOW_FD_IMAGE_GC_CHILD_ENV: &str = "OKOU_RUNNER_LOW_FD_IMAGE_GC_CHILD";

#[tokio::test]
async fn gc_nested_images_many_candidates_does_not_exhaust_lock_fds() {
    run_ignored_child_test(
        "cmd::gc::images::tests::gc_nested_images_many_candidates_low_fd_child",
        (LOW_FD_IMAGE_GC_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(60),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by gc_nested_images_many_candidates_does_not_exhaust_lock_fds"]
async fn gc_nested_images_many_candidates_low_fd_child() {
    if !ignored_child_test_env_guard_enabled((LOW_FD_IMAGE_GC_CHILD_ENV, "1")) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let entry_count = 220usize;
    let keep_count = 20usize;
    for index in 0..entry_count {
        let rootfs_hash = format!("rootfs-low-fd-{index:03}");
        let snapshot_hash = format!("snapshot-low-fd-{index:03}");
        let rootfs_dir = home.images_dir().join(&rootfs_hash);
        let snapshot_dir = rootfs_dir.join("snapshots").join(snapshot_hash);
        std::fs::create_dir_all(&snapshot_dir).unwrap();
        std::fs::write(snapshot_dir.join("snapshot.bin"), [0u8; 4096]).unwrap();
        std::fs::write(rootfs_dir.join("rootfs.ext4"), [0u8; 4096]).unwrap();
        set_mtime(&snapshot_dir, old_gc_time());
        set_mtime(&rootfs_dir, old_gc_time());
    }

    let _nofile_limit = set_soft_nofile_limit_for_child(128);
    let freed = gc_nested_images(&home, Some(keep_count), false)
        .await
        .unwrap();

    let mut remaining_rootfs = 0usize;
    let mut remaining_snapshots = 0usize;
    for rootfs_entry in std::fs::read_dir(home.images_dir()).unwrap() {
        let rootfs_entry = rootfs_entry.unwrap();
        if !rootfs_entry.file_type().unwrap().is_dir() {
            continue;
        }
        remaining_rootfs += 1;
        for snapshot_entry in std::fs::read_dir(rootfs_entry.path().join("snapshots")).unwrap() {
            if snapshot_entry.unwrap().file_type().unwrap().is_dir() {
                remaining_snapshots += 1;
            }
        }
    }

    assert_eq!(
        remaining_rootfs, keep_count,
        "image GC left {remaining_rootfs} rootfs directories for keep count {keep_count}; freed {freed}"
    );
    assert_eq!(remaining_snapshots, keep_count);
    assert!(freed > 0, "low-FD image GC must remove old artifacts");
}
