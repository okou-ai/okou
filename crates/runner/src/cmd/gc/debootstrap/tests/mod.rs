use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};

use super::*;
use crate::cmd::gc::test_support::{old_gc_time, set_mtime, test_home};
use runner_host::lock;

#[tokio::test]
async fn gc_debootstrap_missing_cache_dir_does_not_create_lock() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        !home.debootstrap_dir().exists(),
        "missing debootstrap cache dir should remain absent"
    );
    assert!(
        !home.debootstrap_lock().exists(),
        "GC must not create the debootstrap lock when there is no cache dir"
    );
}

#[tokio::test]
async fn gc_debootstrap_skips_when_cache_lock_is_held() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let cache_tar = debootstrap_dir.join("noble-amd64.tar");
    std::fs::write(&cache_tar, b"cached").unwrap();
    std::fs::File::open(&cache_tar)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
        )
        .unwrap();

    let lock_file = lock::open_lock_file(&home.debootstrap_lock()).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockExclusive).unwrap();

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        cache_tar.exists(),
        "active debootstrap cache tarball must survive GC"
    );
}

#[tokio::test]
async fn gc_debootstrap_keeps_its_lock_file() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let lock_path = home.debootstrap_lock();
    drop(lock::open_lock_file(&lock_path).unwrap());
    std::fs::File::open(&lock_path)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
        )
        .unwrap();

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        lock_path.exists(),
        "debootstrap GC must not remove its own lock file"
    );
}

#[tokio::test]
async fn gc_debootstrap_ignores_non_cache_files() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let unrelated = debootstrap_dir.join("README");
    let retired_tmp = debootstrap_dir.join("noble-amd64.tar.tmp.123");
    std::fs::write(&unrelated, b"metadata").unwrap();
    std::fs::write(&retired_tmp, b"retired partial").unwrap();
    for path in [&unrelated, &retired_tmp] {
        std::fs::File::open(path)
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
            )
            .unwrap();
    }

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert_eq!(report, GcReport::default());
    assert!(
        unrelated.exists(),
        "debootstrap GC should only remove cache tarballs"
    );
    assert!(
        retired_tmp.exists(),
        "retired debootstrap temp tarball names are outside GC ownership"
    );
}

#[tokio::test]
async fn gc_debootstrap_reports_zero_byte_removal_as_activity() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let cache_tar = debootstrap_dir.join("noble-amd64.tar");
    std::fs::write(&cache_tar, b"").unwrap();
    std::fs::File::open(&cache_tar)
        .unwrap()
        .set_times(
            FileTimes::new().set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)),
        )
        .unwrap();

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert!(
        !cache_tar.exists(),
        "eligible empty tarball should be removed"
    );
    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 1);
    assert!(!report.is_empty());
}

#[tokio::test]
async fn gc_debootstrap_dry_run_preserves_and_reports_eligible_tarballs() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let stable_tar = debootstrap_dir.join("noble-amd64.tar");
    let temp_tar = debootstrap_dir.join("noble-amd64.tmp.mktemp.a9Bc2D.tar");
    std::fs::write(&stable_tar, b"stable cache").unwrap();
    std::fs::write(&temp_tar, b"partial cache").unwrap();
    let expected_bytes =
        std::fs::metadata(&stable_tar).unwrap().len() + std::fs::metadata(&temp_tar).unwrap().len();
    let old_time = old_gc_time();
    set_mtime(&stable_tar, old_time);
    set_mtime(&temp_tar, old_time);

    let report = gc_debootstrap(&home, Some(0), true).await.unwrap();

    assert_eq!(report.freed_bytes, expected_bytes);
    assert_eq!(report.activity_count, 2);
    assert!(
        stable_tar.exists(),
        "dry-run must preserve an eligible stable tarball"
    );
    assert!(
        temp_tar.exists(),
        "dry-run must preserve an eligible temporary tarball"
    );
}

#[tokio::test]
async fn gc_debootstrap_removes_stale_temp_tarballs_but_keeps_recent_ones() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let stale_tmp = debootstrap_dir.join("noble-amd64.tmp.mktemp.a9Bc2D.tar");
    let recent_tmp = debootstrap_dir.join("noble-amd64.tmp.mktemp.e3Fg4H.tar");
    std::fs::write(&stale_tmp, b"stale partial").unwrap();
    std::fs::write(&recent_tmp, b"recent partial").unwrap();
    let stale_size = std::fs::metadata(&stale_tmp).unwrap().len();
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    std::fs::File::open(&stale_tmp)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();

    let report = gc_debootstrap(&home, Some(0), false).await.unwrap();

    assert_eq!(report.freed_bytes, stale_size);
    assert_eq!(report.activity_count, 1);
    assert!(
        !stale_tmp.exists(),
        "stale debootstrap temp tarball should be GC'd"
    );
    assert!(
        recent_tmp.exists(),
        "recent debootstrap temp tarball may still belong to an active build"
    );
}

#[tokio::test]
async fn gc_debootstrap_temp_tarballs_do_not_consume_keep_latest_slots() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let stable_tar = debootstrap_dir.join("noble-amd64.tar");
    let newer_tmp = debootstrap_dir.join("noble-amd64.tmp.mktemp.a9Bc2D.tar");
    let other_tmp = debootstrap_dir.join("noble-amd64.tmp.mktemp.e3Fg4H.tar");
    std::fs::write(&stable_tar, b"stable").unwrap();
    std::fs::write(&newer_tmp, b"newer partial").unwrap();
    std::fs::write(&other_tmp, b"other partial").unwrap();
    let temp_size =
        std::fs::metadata(&newer_tmp).unwrap().len() + std::fs::metadata(&other_tmp).unwrap().len();
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let newer_time = old_time + Duration::from_secs(60);
    std::fs::File::open(&stable_tar)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    std::fs::File::open(&newer_tmp)
        .unwrap()
        .set_times(FileTimes::new().set_modified(newer_time))
        .unwrap();
    std::fs::File::open(&other_tmp)
        .unwrap()
        .set_times(FileTimes::new().set_modified(newer_time))
        .unwrap();

    let report = gc_debootstrap(&home, Some(1), false).await.unwrap();

    assert_eq!(report.freed_bytes, temp_size);
    assert_eq!(report.activity_count, 2);
    assert!(
        stable_tar.exists(),
        "keep_latest should protect the stable debootstrap tarball"
    );
    assert!(
        !newer_tmp.exists(),
        "stale temp tarballs must not consume keep_latest slots"
    );
    assert!(!other_tmp.exists());
}

#[tokio::test]
async fn gc_debootstrap_unmarked_tmp_tarball_name_is_stable() {
    use std::fs::FileTimes;

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let debootstrap_dir = home.debootstrap_dir();
    std::fs::create_dir_all(&debootstrap_dir).unwrap();
    let stable_tar = debootstrap_dir.join("noble-amd64.tmp.release.tar");
    let temp_tar = debootstrap_dir.join("noble-amd64.tmp.mktemp.a9Bc2D.tar");
    std::fs::write(&stable_tar, b"stable").unwrap();
    std::fs::write(&temp_tar, b"temp").unwrap();
    let temp_size = std::fs::metadata(&temp_tar).unwrap().len();
    let old_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let newer_time = old_time + Duration::from_secs(60);
    std::fs::File::open(&temp_tar)
        .unwrap()
        .set_times(FileTimes::new().set_modified(old_time))
        .unwrap();
    std::fs::File::open(&stable_tar)
        .unwrap()
        .set_times(FileTimes::new().set_modified(newer_time))
        .unwrap();

    let report = gc_debootstrap(&home, Some(1), false).await.unwrap();

    assert_eq!(report.freed_bytes, temp_size);
    assert_eq!(report.activity_count, 1);
    assert!(
        stable_tar.exists(),
        "unmarked .tmp. tarball names should remain stable debootstrap cache tarballs"
    );
    assert!(
        !temp_tar.exists(),
        "mktemp debootstrap temp tarball should be removed"
    );
}
