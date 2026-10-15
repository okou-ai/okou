use super::super::fs::{
    PinnedImage, fs_stats_from_statvfs, statvfs_bytes, statvfs_for_path, sync_directory,
    sync_private_file,
};
use super::super::types::FsStats;
use super::support::{Fixture, SIZE, write_image};
use crate::error::LifecycleError;
use std::error::Error;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use sha2::{Digest, Sha256};

fn assert_missing_path_context(error: LifecycleError, operation: &str, path: &Path) {
    let LifecycleError::Io(error) = error else {
        panic!("expected a filesystem error, got {error}");
    };
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    let original = error
        .source()
        .and_then(|source| source.downcast_ref::<std::io::Error>())
        .expect("the original I/O error must remain available");
    assert_eq!(original.raw_os_error(), Some(libc::ENOENT));
    assert_eq!(original.kind(), error.kind());
    let message = error.to_string();
    assert!(message.contains(&format!("home cache {operation} path_id=")));
    assert!(message.contains(&hex::encode(Sha256::digest(path.as_os_str().as_bytes()))));
    assert!(!message.contains("private-workload-name"));
    assert!(!message.contains(path.to_string_lossy().as_ref()));
}

#[test]
fn statvfs_conversion_uses_fragment_size_and_available_counters() {
    let dir = tempfile::tempdir().unwrap();
    let mut stats = statvfs_for_path(dir.path()).unwrap();
    stats.f_bsize = 8192;
    stats.f_frsize = 1024;
    stats.f_blocks = 13;
    stats.f_bfree = 7;
    stats.f_bavail = 5;
    stats.f_files = 19;
    stats.f_ffree = 11;
    stats.f_favail = 3;

    assert_eq!(
        fs_stats_from_statvfs(&stats),
        FsStats {
            total_bytes: 13312,
            available_bytes: 5120,
            total_inodes: 19,
            available_inodes: 3,
        }
    );
}

#[test]
fn statvfs_conversion_saturates_bytes_without_scaling_inodes() {
    let dir = tempfile::tempdir().unwrap();
    let mut stats = statvfs_for_path(dir.path()).unwrap();
    stats.f_bsize = 1;
    stats.f_frsize = 2;
    stats.f_blocks = u64::MAX;
    stats.f_bfree = u64::MAX - 1;
    stats.f_bavail = u64::MAX / 2 + 1;
    stats.f_files = 19;
    stats.f_ffree = 11;
    stats.f_favail = 3;

    assert_eq!(
        fs_stats_from_statvfs(&stats),
        FsStats {
            total_bytes: u64::MAX,
            available_bytes: u64::MAX,
            total_inodes: 19,
            available_inodes: 3,
        }
    );
}

#[tokio::test]
async fn real_filesystem_stats_use_existing_parent_without_creating_cache_dirs() {
    let fixture = Fixture::new().await;
    let root = fixture.cache.home_image_cache_dir();
    assert!(!root.exists());
    let existing = fixture.cache.home_image_cache_fs_stats_path();
    assert!(existing.exists());
    assert!(root.starts_with(&existing));
    let stats = fixture.cache.query_fs_stats().await.unwrap();
    let parent = statvfs_bytes(&existing).await.unwrap();
    assert_eq!(stats.total_bytes, parent.total_bytes);
    assert!(stats.total_bytes > 0);
    assert!(stats.available_bytes <= stats.total_bytes);
    assert_eq!(stats.total_inodes, parent.total_inodes);
    assert!(stats.total_inodes > 0);
    assert!(stats.available_inodes <= stats.total_inodes);
    assert!(!root.exists());
}

#[tokio::test]
async fn real_filesystem_stats_propagate_missing_and_invalid_path_errors() {
    let fixture = Fixture::new().await;
    let missing = fixture
        .dir
        .path()
        .join("private-workload-name\nnot-present");
    assert_missing_path_context(
        statvfs_bytes(&missing).await.unwrap_err(),
        "statvfs",
        &missing,
    );
    let nul_path =
        std::path::PathBuf::from(std::ffi::OsString::from_vec(b"invalid\0path".to_vec()));
    assert!(statvfs_bytes(&nul_path).await.is_err());
}

#[tokio::test]
async fn image_validation_and_sync_failures_retain_os_errors_without_disclosing_paths() {
    let fixture = Fixture::new().await;
    let missing = fixture
        .dir
        .path()
        .join("private-workload-name\nnot-present");
    assert_missing_path_context(
        sync_directory(&missing).await.unwrap_err(),
        "open_directory",
        &missing,
    );
    assert_missing_path_context(
        sync_private_file(&missing).await.unwrap_err(),
        "open_private_file",
        &missing,
    );
    assert_missing_path_context(
        PinnedImage::open(&missing, SIZE)
            .err()
            .expect("missing image must fail to open"),
        "open_image",
        &missing,
    );

    write_image(&missing, b"unpublished", SIZE);
    let pinned = PinnedImage::open(&missing, SIZE).unwrap();
    std::fs::remove_file(&missing).unwrap();
    assert_missing_path_context(
        pinned.validate_path(&missing).unwrap_err(),
        "symlink_metadata",
        &missing,
    );
}
