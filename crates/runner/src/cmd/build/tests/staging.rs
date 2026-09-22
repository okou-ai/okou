use super::*;

#[tokio::test]
async fn temp_dir_cleanup_failure_fails_successful_operation() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("not-a-dir");
    tokio::fs::write(&file_path, b"not a directory")
        .await
        .unwrap();

    let err = finish_temp_dir_result(&file_path, "test temp dir", Ok(()))
        .await
        .unwrap_err();

    assert!(
        err.to_string().contains("remove test temp dir"),
        "cleanup failure should surface on success, got {err}"
    );
}

#[tokio::test]
async fn temp_dir_cleanup_preserves_original_error() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("not-a-dir");
    tokio::fs::write(&file_path, b"not a directory")
        .await
        .unwrap();

    let err = finish_temp_dir_result(
        &file_path,
        "test temp dir",
        Err(RunnerError::Internal("original failure".into())),
    )
    .await
    .unwrap_err();

    assert!(
        err.to_string().contains("original failure"),
        "original error should win when operation and cleanup both fail, got {err}"
    );
}

/// Staging contract: the in-progress `rootfs.ext4.staging` must not
/// cause `is_rootfs_present` to report the rootfs as built. If it did,
/// a crashed build partway through customization would still fast-path
/// on the next run, reintroducing #11007.
#[tokio::test]
async fn is_rootfs_present_ignores_staging_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "staging-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    // Staging alone means not present.
    tokio::fs::write(rootfs.rootfs_staging(), b"partial")
        .await
        .unwrap();
    assert!(!is_rootfs_present(&rootfs).await.unwrap());

    // Committed file means present, even with lingering staging.
    tokio::fs::write(rootfs.rootfs(), b"committed")
        .await
        .unwrap();
    assert!(is_rootfs_present(&rootfs).await.unwrap());
}

/// End-to-end contract simulation for the template materialization +
/// customization path: the verified template is moved into staging,
/// customization mutates staging, and commit atomically publishes the rootfs.
#[tokio::test]
async fn staging_contract_happy_path() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "happy-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    // Simulate a verified template being moved into staging.
    tokio::fs::write(rootfs.rootfs_staging(), b"template-download")
        .await
        .unwrap();

    // Customize staging, then commit.
    tokio::fs::write(rootfs.rootfs_staging(), b"customized")
        .await
        .unwrap();
    publish.commit().await.unwrap();

    assert!(rootfs.rootfs().exists());
    assert!(!rootfs.rootfs_staging().exists());
    assert!(is_rootfs_present(&rootfs).await.unwrap());
}

/// Crash simulation: template download succeeded, but the process died before
/// normal error cleanup could run. The next build must see no committed
/// rootfs and stale staging cleanup must wipe the partial file.
#[tokio::test]
async fn staging_contract_crash_leaves_recoverable_state() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "fail-hash");
    let publish = LocalFilePublish::for_rootfs(&rootfs);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    tokio::fs::write(rootfs.rootfs_staging(), b"template-download")
        .await
        .unwrap();
    // Pretend the process crashed: staging persists, rootfs.ext4 absent.

    assert!(!is_rootfs_present(&rootfs).await.unwrap());
    assert!(rootfs.rootfs_staging().exists());

    // Next build's cleanup step.
    publish.cleanup_stale_staging_best_effort().await;
    assert!(!rootfs.rootfs_staging().exists());
    assert!(!is_rootfs_present(&rootfs).await.unwrap());
}

#[tokio::test]
async fn stale_template_attempt_dir_is_removed_before_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "template-build-residue-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    let build_dir = rootfs.dir().join(format!(
        "{TEMPLATE_BUILD_DIR_PREFIX}old{TEMPLATE_ATTEMPT_DIR_SUFFIX}"
    ));
    tokio::fs::create_dir_all(build_dir.join("nested"))
        .await
        .unwrap();
    tokio::fs::write(build_dir.join("nested").join("partial"), b"leftover")
        .await
        .unwrap();

    cleanup_stale_template_attempt_dirs(rootfs.dir(), TEMPLATE_BUILD_DIR_PREFIX)
        .await
        .unwrap();

    assert!(
        !build_dir.exists(),
        "stale local template build output must not survive into a later R2-hit build"
    );
}

#[tokio::test]
async fn stale_template_attempt_file_is_removed_before_reuse() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "template-build-file-residue-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    let build_dir = rootfs.dir().join(format!(
        "{TEMPLATE_BUILD_DIR_PREFIX}old{TEMPLATE_ATTEMPT_DIR_SUFFIX}"
    ));
    tokio::fs::write(&build_dir, b"not a directory")
        .await
        .unwrap();

    cleanup_stale_template_attempt_dirs(rootfs.dir(), TEMPLATE_BUILD_DIR_PREFIX)
        .await
        .unwrap();

    assert!(
        !build_dir.exists(),
        "stale local template build file must not block later template materialization"
    );
}

#[tokio::test]
async fn template_attempt_cleanup_preserves_other_hash_parent() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let this_parent = template_warm_parent_dir(&home, "this-hash");
    let other_parent = template_warm_parent_dir(&home, "other-hash");
    let this_dir = template_attempt_dir(&this_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
    let other_dir = template_attempt_dir(&other_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX);
    tokio::fs::create_dir_all(&this_dir).await.unwrap();
    tokio::fs::create_dir_all(&other_dir).await.unwrap();

    cleanup_stale_template_attempt_dirs(&this_parent, TEMPLATE_WARM_ATTEMPT_DIR_PREFIX)
        .await
        .unwrap();

    assert!(!this_dir.exists());
    assert!(
        other_dir.exists(),
        "template warm cleanup for one hash must not remove another hash's active attempt"
    );
}
