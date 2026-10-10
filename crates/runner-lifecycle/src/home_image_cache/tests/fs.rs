use super::super::fs::statvfs_bytes;
use super::support::Fixture;
use std::os::unix::ffi::OsStringExt;

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
    assert!(
        statvfs_bytes(&fixture.dir.path().join("not-present"))
            .await
            .is_err()
    );
    let nul_path =
        std::path::PathBuf::from(std::ffi::OsString::from_vec(b"invalid\0path".to_vec()));
    assert!(statvfs_bytes(&nul_path).await.is_err());
}
