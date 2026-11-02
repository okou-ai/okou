use super::*;
use std::os::unix::fs::symlink;

fn counters() -> libc::statvfs {
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    stat.f_frsize = 1024;
    stat.f_blocks = 100;
    stat.f_bfree = 40;
    stat.f_bavail = 30;
    stat.f_files = 80;
    stat.f_ffree = 20;
    stat.f_favail = 10;
    stat
}

#[test]
fn independent_available_and_used_counters() {
    let observed = from_stat(&counters()).unwrap();
    assert_eq!(
        observed,
        FilesystemObservation {
            total_bytes: 102400,
            used_bytes: 61440,
            available_bytes: 30720,
            total_inodes: 80,
            used_inodes: 60,
            available_inodes: 10
        }
    );
    assert_eq!(
        serde_json::to_value(observed).unwrap()["available_inodes"],
        10
    );
}

#[test]
fn impossible_and_overflow_counters_are_unavailable() {
    let mut stat = counters();
    stat.f_bfree = 101;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_bavail = 41;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_ffree = 81;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_favail = 21;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_blocks = u64::MAX;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_bfree = u64::MAX;
    assert!(from_stat(&stat).is_none());
    let mut stat = counters();
    stat.f_frsize = 0;
    assert!(from_stat(&stat).is_none());
}

#[test]
fn measured_zero_is_a_real_observation() {
    let mut stat = counters();
    stat.f_bfree = stat.f_blocks;
    stat.f_ffree = stat.f_files;
    let observed = from_stat(&stat).unwrap();
    assert_eq!(observed.used_bytes, 0);
    assert_eq!(observed.used_inodes, 0);
}

#[test]
fn missing_unmounted_and_symlink_home_are_not_rootfs() {
    let dir = tempfile::tempdir().unwrap();
    assert!(observe_at(dir.path()).0.is_some());
    assert!(observe_at(dir.path()).1.is_none());
    std::fs::create_dir_all(dir.path().join("home/user")).unwrap();
    assert!(observe_at(dir.path()).1.is_none());
    std::fs::remove_dir(dir.path().join("home/user")).unwrap();
    symlink("/", dir.path().join("home/user")).unwrap();
    assert!(observe_at(dir.path()).1.is_none());
    std::fs::remove_file(dir.path().join("home/user")).unwrap();
    std::fs::remove_dir(dir.path().join("home")).unwrap();
    symlink("/", dir.path().join("home")).unwrap();
    assert!(observe_at(dir.path()).1.is_none());
}

#[test]
fn descriptor_sample_survives_directory_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sample");
    std::fs::create_dir(&path).unwrap();
    let file = File::open(&path).unwrap();
    std::fs::rename(&path, dir.path().join("retained")).unwrap();
    symlink("/", &path).unwrap();
    assert!(sample(&file).is_some());
}
