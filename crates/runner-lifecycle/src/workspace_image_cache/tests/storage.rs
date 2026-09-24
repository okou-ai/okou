use tokio::fs;

use super::super::fs::{
    allocated_bytes, fs_stats_from_statvfs, has_copy_headroom, sparse_copy_with_timeout,
    statvfs_bytes_sync, statvfs_for_path, workspace_cache_path_allocated_bytes,
};
use super::super::{CacheBudget, FsStats, GIB, WorkspaceImageCache};
use crate::error::LifecycleError;
use runner_host::paths::RunnerPaths;

#[test]
fn budget_uses_automatic_bounds() {
    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: 2_000 * GIB,
        available_bytes: 1_000 * GIB,
    });
    assert_eq!(budget.max_cache_bytes, 1_000 * GIB);
    assert_eq!(budget.target_after_gc_bytes, 750 * GIB);
    assert_eq!(budget.min_free_bytes, 200 * GIB);
    assert_eq!(budget.max_entry_bytes, 32 * GIB);
}

#[test]
fn budget_uses_half_of_filesystem_for_smaller_hosts() {
    let budget = CacheBudget::from_fs_stats(FsStats {
        total_bytes: 400 * GIB,
        available_bytes: 300 * GIB,
    });
    assert_eq!(budget.max_cache_bytes, 200 * GIB);
    assert_eq!(budget.target_after_gc_bytes, 150 * GIB);
    assert_eq!(budget.min_free_bytes, 50 * GIB);
    assert_eq!(budget.max_entry_bytes, 20 * GIB);
}

#[test]
fn fs_stats_path_prefers_existing_cache_dir() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    let cache_dir = crate::test_fixtures::runner_workspace_image_cache_dir(&paths);
    std::fs::create_dir_all(&cache_dir).unwrap();
    let cache = WorkspaceImageCache::new(paths.clone());

    assert_eq!(cache.workspace_image_cache_fs_stats_path(), cache_dir);
}

#[test]
fn fs_stats_path_falls_back_to_existing_parent_when_cache_dir_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    std::fs::create_dir_all(paths.base_dir()).unwrap();
    let cache = WorkspaceImageCache::new(paths.clone());

    assert_eq!(
        cache.workspace_image_cache_fs_stats_path(),
        paths.base_dir().to_path_buf()
    );
}

#[tokio::test]
async fn real_fs_stats_queries_selected_existing_parent() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    std::fs::create_dir_all(paths.base_dir()).unwrap();
    let cache = WorkspaceImageCache::new(paths.clone());

    assert!(!crate::test_fixtures::runner_workspace_image_cache_dir(&paths).exists());
    assert_eq!(
        cache.workspace_image_cache_fs_stats_path(),
        paths.base_dir().to_path_buf()
    );

    let stats = cache.query_fs_stats().await.unwrap();

    assert!(stats.total_bytes > 0);
    assert!(stats.available_bytes <= stats.total_bytes);
}

#[test]
fn statvfs_conversion_uses_fragment_size_and_saturates() {
    let dir = tempfile::tempdir().unwrap();
    let mut stats = statvfs_for_path(dir.path()).unwrap();
    stats.f_bsize = 11;
    stats.f_frsize = 3;
    stats.f_blocks = 4;
    stats.f_bavail = 5;

    assert_eq!(
        fs_stats_from_statvfs(&stats),
        FsStats {
            total_bytes: 12,
            available_bytes: 15,
        }
    );

    stats.f_frsize = 2;
    stats.f_blocks = u64::MAX;
    stats.f_bavail = u64::MAX;

    assert_eq!(
        fs_stats_from_statvfs(&stats),
        FsStats {
            total_bytes: u64::MAX,
            available_bytes: u64::MAX,
        }
    );
}

#[test]
fn statvfs_missing_path_preserves_io_error() {
    let dir = tempfile::tempdir().unwrap();
    let error = statvfs_bytes_sync(&dir.path().join("missing"))
        .expect_err("missing path should fail statvfs");
    let LifecycleError::Io(error) = error else {
        panic!("missing path should preserve the io error");
    };

    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
}

#[test]
fn statvfs_nul_path_is_rejected_without_path_contents() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let path =
        std::path::PathBuf::from(OsString::from_vec(b"private-statvfs-path\0suffix".to_vec()));
    let message = statvfs_bytes_sync(&path)
        .expect_err("nul path should fail before statvfs")
        .to_string();

    assert_eq!(message, "internal error: statvfs path contains nul byte");
    assert!(!message.contains("private-statvfs-path"));
}

#[test]
fn copy_headroom_requires_min_free_after_copy() {
    let budget = CacheBudget {
        max_cache_bytes: 100,
        target_after_gc_bytes: 75,
        min_free_bytes: 50,
        max_entry_bytes: 100,
    };

    assert!(has_copy_headroom(
        FsStats {
            total_bytes: 200,
            available_bytes: 75,
        },
        budget,
        25,
    ));
    assert!(!has_copy_headroom(
        FsStats {
            total_bytes: 200,
            available_bytes: 74,
        },
        budget,
        25,
    ));
}

#[tokio::test]
async fn workspace_cache_path_allocated_bytes_does_not_follow_root_symlink_to_directory() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    tokio::fs::create_dir_all(&target).await.unwrap();
    tokio::fs::write(target.join("payload"), vec![1_u8; 1024 * 1024])
        .await
        .unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let link_allocated = allocated_bytes(&fs::symlink_metadata(&link).await.unwrap());
    let target_allocated = workspace_cache_path_allocated_bytes(&target).await;
    let actual = workspace_cache_path_allocated_bytes(&link).await;

    assert_eq!(actual, link_allocated);
    assert!(
        target_allocated > link_allocated,
        "test setup should make following the symlink visibly larger"
    );
}

#[tokio::test]
async fn workspace_cache_path_allocated_bytes_does_not_follow_nested_symlink_to_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let real_nested = root.join("real-nested");
    tokio::fs::create_dir_all(&real_nested).await.unwrap();
    tokio::fs::write(real_nested.join("payload"), vec![1_u8; 1024 * 1024])
        .await
        .unwrap();
    let external_target = dir.path().join("external-target");
    tokio::fs::create_dir_all(&external_target).await.unwrap();
    tokio::fs::write(external_target.join("payload"), vec![1_u8; 8 * 1024 * 1024])
        .await
        .unwrap();
    let nested_link = root.join("external-link");
    std::os::unix::fs::symlink(&external_target, &nested_link).unwrap();

    let root_allocated = allocated_bytes(&fs::symlink_metadata(&root).await.unwrap());
    let real_nested_allocated = workspace_cache_path_allocated_bytes(&real_nested).await;
    let nested_link_allocated = allocated_bytes(&fs::symlink_metadata(&nested_link).await.unwrap());
    let external_target_allocated = workspace_cache_path_allocated_bytes(&external_target).await;
    let expected = root_allocated
        .saturating_add(real_nested_allocated)
        .saturating_add(nested_link_allocated);

    let actual = workspace_cache_path_allocated_bytes(&root).await;

    assert_eq!(actual, expected);
    assert!(
        external_target_allocated > nested_link_allocated,
        "test setup should make following the nested symlink visibly larger"
    );
}

#[tokio::test]
async fn sparse_copy_times_out_when_copy_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("blocked.fifo");
    let destination = dir.path().join("out.ext4");
    let status = std::process::Command::new("mkfifo")
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success());

    let err = sparse_copy_with_timeout(&source, &destination, std::time::Duration::ZERO)
        .await
        .unwrap_err();
    let message = err.to_string();

    assert!(message.contains("timed out after"));
    assert!(message.contains(&source.display().to_string()));
    assert!(message.contains(&destination.display().to_string()));
}

#[tokio::test]
async fn sparse_copy_reports_failed_command_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("missing.ext4");
    let destination = dir.path().join("out.ext4");

    let err = sparse_copy_with_timeout(&source, &destination, std::time::Duration::from_secs(1))
        .await
        .unwrap_err();
    let message = err.to_string();
    let (_, stderr) = message.split_once(" failed: ").unwrap();

    assert!(message.contains("cp --sparse=always --no-dereference"));
    assert!(message.contains(&source.display().to_string()));
    assert!(message.contains(&destination.display().to_string()));
    assert!(!stderr.trim().is_empty());
}

#[tokio::test]
async fn sparse_copy_preserves_non_utf8_paths() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let dir = tempfile::tempdir().unwrap();
    let source = dir
        .path()
        .join(OsString::from_vec(b"source-\xff.ext4".to_vec()));
    let destination = dir
        .path()
        .join(OsString::from_vec(b"destination-\xff.ext4".to_vec()));
    let content = b"workspace image";
    tokio::fs::write(&source, content).await.unwrap();

    sparse_copy_with_timeout(&source, &destination, std::time::Duration::from_secs(1))
        .await
        .unwrap();

    assert_eq!(tokio::fs::read(destination).await.unwrap(), content);
}
