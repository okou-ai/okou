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
    ensure_rootfs_under_lock(input, TemplateLockRelease::none(), guard)
        .await
        .unwrap();
    assert!(
        rootfs.rootfs().exists(),
        "best-effort build must not remove a valid local rootfs when R2 is missing"
    );
}

#[tokio::test]
async fn existing_rootfs_releases_template_lock_callback() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "release-local-hash");
    tokio::fs::create_dir_all(rootfs.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"local-rootfs")
        .await
        .unwrap();
    let guests = test_guest_binaries();
    let input = rootfs_input(&home, &rootfs, &guests, TemplateCache::Disabled);
    let released = Arc::new(AtomicUsize::new(0));
    let released_for_callback = Arc::clone(&released);

    ensure_rootfs_under_lock(
        input,
        TemplateLockRelease::from_release(move || {
            released_for_callback.fetch_add(1, Ordering::SeqCst);
        }),
        Arc::new(
            lock::acquire(home.rootfs_lock("release-local-hash"))
                .await
                .unwrap(),
        ),
    )
    .await
    .unwrap();

    assert_eq!(released.load(Ordering::SeqCst), 1);
}

#[test]
fn template_lock_release_runs_on_drop() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let released = Arc::new(AtomicUsize::new(0));
    let released_for_callback = Arc::clone(&released);
    {
        let _release = TemplateLockRelease::from_release(move || {
            released_for_callback.fetch_add(1, Ordering::SeqCst);
        });
    }

    assert_eq!(released.load(Ordering::SeqCst), 1);
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
    let image_lock = acquire_rootfs_lock_for_image_build_inner(&home, rootfs_hash, &rootfs, || {
        if !removed {
            std::fs::remove_file(rootfs.rootfs()).unwrap();
            removed = true;
        }
    })
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

    let task_home = home.clone();
    let task_rootfs_hash = rootfs_hash.to_string();
    let image_lock_task = tokio::spawn(async move {
        let task_rootfs = RootfsPaths::new(&task_home, &task_rootfs_hash);
        acquire_rootfs_lock_for_image_build(&task_home, &task_rootfs_hash, &task_rootfs).await
    });

    tokio::fs::write(rootfs.rootfs(), b"rootfs").await.unwrap();
    drop(builder_lock);

    let image_lock = tokio::time::timeout(std::time::Duration::from_secs(2), image_lock_task)
        .await
        .expect("builder should retry with a shared lock after rootfs commit")
        .unwrap()
        .unwrap();

    assert!(image_lock.is_shared());
}

#[tokio::test]
async fn is_rootfs_present_nonexistent_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = runner_host::paths::HomePaths::with_root(dir.path().to_path_buf());
    let rootfs = RootfsPaths::new(&home, "does-not-exist");

    assert!(!is_rootfs_present(&rootfs).await.unwrap());
}
