use super::fixtures::*;
use super::*;

async fn assert_rootfs_lock_held(home: &HomePaths, hash: &str) {
    let error = lock::try_acquire(home.rootfs_lock(hash)).await.unwrap_err();
    assert!(
        error.to_string().contains("lock is already held"),
        "unexpected rootfs lock error: {error}"
    );
}

#[tokio::test]
async fn existing_rootfs_best_effort_allows_missing_r2_cache() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "best-effort-local-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
        .await
        .unwrap();
    let guests = test_guest_binaries();
    let input = rootfs_input(&home, &rootfs, &guests, TemplateCache::Disabled);

    let guard = std::sync::Arc::new(
        lock::acquire(home.rootfs_lock("best-effort-local-hash"))
            .await
            .unwrap(),
    );
    ensure_rootfs_under_lock(input, guard).await.unwrap();
    assert!(
        rootfs.rootfs().exists(),
        "best-effort build must not remove a valid local rootfs when R2 is missing"
    );
}

#[tokio::test]
async fn existing_rootfs_completes_while_template_writer_is_active() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "release-local-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
        .await
        .unwrap();
    let guests = test_guest_binaries();
    let input = rootfs_input(&home, &rootfs, &guests, TemplateCache::Disabled);
    let _template_writer = lock::acquire(home.template_lock("test-template-hash"))
        .await
        .unwrap();

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        ensure_rootfs_under_lock(
            input,
            std::sync::Arc::new(
                lock::acquire(home.rootfs_lock("release-local-hash"))
                    .await
                    .unwrap(),
            ),
        ),
    )
    .await
    .expect("an existing rootfs must not wait for a template writer")
    .unwrap();

    assert_eq!(
        tokio::fs::read(rootfs.rootfs()).await.unwrap(),
        b"local-rootfs"
    );
}

#[tokio::test]
async fn is_rootfs_present_checks_rootfs_file() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "test-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();

    assert!(!is_rootfs_present(&rootfs).await.unwrap());

    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    assert!(is_rootfs_present(&rootfs).await.unwrap());
}

#[tokio::test]
async fn cached_rootfs_requires_a_matching_cli_sidecar() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "cli-rootfs-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"committed-rootfs")
        .await
        .unwrap();

    let artifact =
        okou_cli::test_support::stage_fixture(b"tarball-bytes", "9.353.0", "1.36.0").await;
    let error = verify_cli_sidecar(&rootfs, Some(&artifact))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("sidecar"), "{error}");

    tokio::fs::write(rootfs.okou_cli_manifest(), b"wrong identity")
        .await
        .unwrap();
    let error = verify_cli_sidecar(&rootfs, Some(&artifact))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("does not match"), "{error}");

    tokio::fs::write(
        rootfs.okou_cli_manifest(),
        artifact.installed_manifest_bytes(),
    )
    .await
    .unwrap();
    verify_cli_sidecar(&rootfs, Some(&artifact)).await.unwrap();
}

#[tokio::test]
async fn rootfs_image_lock_uses_shared_for_existing_rootfs_in_use() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs_hash = "existing-rootfs-hash";
    let rootfs = RootfsPaths::new(&home, rootfs_hash);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
    let _running_runner = lock::acquire_shared(home.rootfs_lock(rootfs_hash))
        .await
        .unwrap();

    let image_lock = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        acquire_rootfs_lock_for_image_build(&home, rootfs_hash, &rootfs),
    )
    .await
    .expect("existing rootfs must not wait for an exclusive lock")
    .unwrap();

    assert!(image_lock.is_shared());
    assert_rootfs_lock_held(&home, rootfs_hash).await;
}

#[tokio::test]
async fn rootfs_image_lock_uses_exclusive_for_missing_rootfs() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs_hash = "missing-rootfs-hash";
    let rootfs = RootfsPaths::new(&home, rootfs_hash);

    let image_lock = acquire_rootfs_lock_for_image_build(&home, rootfs_hash, &rootfs)
        .await
        .unwrap();

    assert!(image_lock.is_exclusive());
    assert_rootfs_lock_held(&home, rootfs_hash).await;
}

#[tokio::test]
async fn rootfs_image_lock_retries_exclusive_when_existing_rootfs_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs_hash = "disappearing-rootfs-hash";
    let rootfs = RootfsPaths::new(&home, rootfs_hash);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();

    let mut removed = false;
    let image_lock = acquire_rootfs_lock_for_image_build_inner(
        &home,
        rootfs_hash,
        &rootfs,
        || {
            if !removed {
                std::fs::remove_file(rootfs.rootfs()).unwrap();
                removed = true;
            }
        },
        || {},
    )
    .await
    .unwrap();

    assert!(removed);
    assert!(image_lock.is_exclusive());
}

#[tokio::test]
async fn rootfs_image_lock_retries_shared_when_another_builder_commits_rootfs() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs_hash = "committed-by-other-builder-hash";
    let rootfs = RootfsPaths::new(&home, rootfs_hash);
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    let builder_lock = lock::acquire(home.rootfs_lock(rootfs_hash)).await.unwrap();
    let (exclusive_lock_started, exclusive_lock_attempt) = tokio::sync::oneshot::channel();

    let task_home = home.clone();
    let task_rootfs_hash = rootfs_hash.to_string();
    let image_lock_task = tokio::spawn(async move {
        let task_rootfs = RootfsPaths::new(&task_home, &task_rootfs_hash);
        let mut exclusive_lock_started = Some(exclusive_lock_started);
        acquire_rootfs_lock_for_image_build_inner(
            &task_home,
            &task_rootfs_hash,
            &task_rootfs,
            || {},
            || {
                if let Some(started) = exclusive_lock_started.take() {
                    started.send(()).unwrap();
                }
            },
        )
        .await
    });

    // Rule out the initial shared path: the builder still holds its flock when
    // acquisition observes missing rootfs and reaches the exclusive attempt.
    tokio::time::timeout(std::time::Duration::from_secs(2), exclusive_lock_attempt)
        .await
        .expect("acquisition must reach the exclusive attempt before rootfs commit")
        .unwrap();
    tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
    drop(builder_lock);

    let image_lock = tokio::time::timeout(std::time::Duration::from_secs(2), image_lock_task)
        .await
        .expect("builder should retry with a shared lock after rootfs commit")
        .unwrap()
        .unwrap();

    assert!(image_lock.is_shared());
    assert!(matches!(
        lock::try_acquire_or_busy(home.rootfs_lock(rootfs_hash))
            .await
            .unwrap(),
        lock::TryLock::Busy
    ));
    let other_reader = lock::try_acquire_shared_or_busy(home.rootfs_lock(rootfs_hash))
        .await
        .unwrap();
    assert!(matches!(other_reader, lock::TryLock::Acquired(_)));
}

#[tokio::test]
async fn is_rootfs_present_nonexistent_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "does-not-exist");

    assert!(!is_rootfs_present(&rootfs).await.unwrap());
}
