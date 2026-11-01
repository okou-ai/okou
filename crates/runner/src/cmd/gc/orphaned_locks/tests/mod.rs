use nix::fcntl::{Flock, FlockArg};

use super::*;
use crate::cmd::gc::test_support::test_home;
use runner_host::lock;

#[tokio::test]
async fn gc_orphaned_locks_preserves_only_current_service_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();
    let version_service_lock = RunnerServiceUnit::from_suffix("v1.0.0")
        .unwrap()
        .lock_path(&home);
    let staging_service_lock = RunnerServiceUnit::from_suffix("staging")
        .unwrap()
        .lock_path(&home);
    let historical_service_lock = locks_dir.join("service-vm0-runner-OLD_NAME.lock");
    let stale_lock = locks_dir.join("home-image-cache-test.lock");
    std::fs::write(&version_service_lock, "").unwrap();
    std::fs::write(&staging_service_lock, "").unwrap();
    std::fs::write(&historical_service_lock, "").unwrap();
    std::fs::write(&stale_lock, "").unwrap();

    let report = gc_orphaned_locks(&home, false).await.unwrap();

    assert_eq!(report.activity_count, 2);
    assert_eq!(report.freed_bytes, 0);
    assert!(
        version_service_lock.exists(),
        "canonical version service locks must survive orphaned lock cleanup"
    );
    assert!(
        staging_service_lock.exists(),
        "canonical non-semver service locks must survive orphaned lock cleanup"
    );
    assert!(
        !historical_service_lock.exists(),
        "free historical service lock names should be cleaned as ordinary locks"
    );
    assert!(
        !stale_lock.exists(),
        "ordinary free locks should still be cleaned"
    );
}

#[tokio::test]
async fn gc_orphaned_locks_preserves_held_historical_service_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let historical_service_lock = home.locks_dir().join("service-vm0-runner-OLD_NAME.lock");
    let lock_file = lock::open_lock_file(&historical_service_lock).unwrap();
    let _held_lock = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let report = gc_orphaned_locks(&home, false).await.unwrap();

    assert_eq!(report.activity_count, 0);
    assert_eq!(report.freed_bytes, 0);
    assert!(
        historical_service_lock.exists(),
        "held historical service locks must survive orphaned lock cleanup"
    );
}

#[tokio::test]
async fn gc_orphaned_locks_preserves_host_global_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();
    let reload_lock = home.systemd_daemon_reload_lock();
    let gc_lock = home.gc_lock();
    let stale_lock = locks_dir.join("home-image-cache-test.lock");
    std::fs::write(&reload_lock, "").unwrap();
    std::fs::write(&gc_lock, "").unwrap();
    std::fs::write(&stale_lock, "").unwrap();

    let report = gc_orphaned_locks(&home, false).await.unwrap();

    assert_eq!(report.activity_count, 1);
    assert_eq!(report.freed_bytes, 0);
    assert!(
        reload_lock.exists(),
        "the shared systemd reload lock must keep a stable inode"
    );
    assert!(
        gc_lock.exists(),
        "the global GC lock must keep a stable inode"
    );
    assert!(
        !stale_lock.exists(),
        "ordinary free locks should still be cleaned"
    );
}

#[tokio::test]
async fn gc_orphaned_locks_preserves_base_dir_locks() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let locks_dir = home.locks_dir();
    std::fs::create_dir_all(&locks_dir).unwrap();
    let base_dir_lock = locks_dir.join("base-dir-dead.lock");
    let stale_lock = locks_dir.join("home-image-cache-test.lock");
    std::fs::write(&base_dir_lock, "/data/dead-runner").unwrap();
    std::fs::write(&stale_lock, "").unwrap();

    let report = gc_orphaned_locks(&home, false).await.unwrap();

    assert_eq!(report.activity_count, 1);
    assert_eq!(report.freed_bytes, 0);
    assert!(
        base_dir_lock.exists(),
        "base-dir locks must remain available for workspace GC retry"
    );
    assert!(
        !stale_lock.exists(),
        "ordinary free locks should still be cleaned"
    );
}
