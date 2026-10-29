use super::*;
use runner_host::paths::HomePaths;

#[tokio::test]
async fn local_file_publish_removes_stale_file_residue() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "cleanup-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    tokio::fs::write(rootfs.rootfs_staging(), b"crash-residue")
        .await
        .unwrap();
    assert!(rootfs.rootfs_staging().exists());

    publish.cleanup_stale_staging_best_effort();
    assert!(!rootfs.rootfs_staging().exists());
}

#[tokio::test]
async fn local_file_publish_removes_stale_directory_residue() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "cleanup-dir-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);

    tokio::fs::create_dir_all(rootfs.rootfs_staging().join("nested"))
        .await
        .unwrap();
    tokio::fs::write(
        rootfs.rootfs_staging().join("nested").join("partial"),
        b"leftover",
    )
    .await
    .unwrap();

    publish.cleanup_stale_staging_best_effort();
    assert!(!rootfs.rootfs_staging().exists());
}

#[tokio::test]
async fn local_file_publish_stale_cleanup_noop_when_absent() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "noop-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    // No staging file: must not error.
    publish.cleanup_stale_staging_best_effort();
    assert!(!rootfs.rootfs_staging().exists());
}

#[tokio::test]
async fn local_file_publish_stale_cleanup_leaves_committed_rootfs_alone() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "preserve-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    tokio::fs::write(rootfs.rootfs(), b"real-rootfs")
        .await
        .unwrap();
    tokio::fs::write(rootfs.rootfs_staging(), b"residue")
        .await
        .unwrap();

    publish.cleanup_stale_staging_best_effort();
    assert!(rootfs.rootfs().exists(), "committed rootfs must survive");
    assert!(!rootfs.rootfs_staging().exists());
}

#[tokio::test]
async fn local_file_publish_finish_removes_staging_after_error() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "failed-cleanup-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs_staging(), b"partial-rootfs")
        .await
        .unwrap();

    let err = publish
        .finish_after_result(Err(RunnerError::Internal("customize failed".into())))
        .unwrap_err();

    assert!(err.to_string().contains("customize failed"));
    assert!(!rootfs.rootfs_staging().exists());
}

#[tokio::test]
async fn local_file_publish_finish_preserves_original_error_when_cleanup_fails() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "failed-cleanup-dir-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.rootfs_staging())
        .await
        .unwrap();

    let err = publish
        .finish_after_result(Err(RunnerError::Internal("verify failed".into())))
        .unwrap_err();

    assert!(err.to_string().contains("verify failed"));
    assert!(
        rootfs.rootfs_staging().is_dir(),
        "cleanup failure must not mask the original build error"
    );
}

#[tokio::test]
async fn local_file_publish_commit_renames_to_rootfs() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "commit-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    tokio::fs::write(rootfs.rootfs_staging(), b"customized")
        .await
        .unwrap();

    publish.commit(None).unwrap();

    assert!(!rootfs.rootfs_staging().exists());
    assert!(rootfs.rootfs().exists());
    let content = tokio::fs::read(rootfs.rootfs()).await.unwrap();
    assert_eq!(content, b"customized");
}
