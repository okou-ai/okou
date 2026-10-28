use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc;

use super::*;

// Releasing on unwind keeps a failing assertion from pinning runtime shutdown.
struct ReleaseBlockingWorker(mpsc::Sender<()>);

impl Drop for ReleaseBlockingWorker {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

async fn occupy_blocking_worker() -> (ReleaseBlockingWorker, tokio::task::JoinHandle<()>) {
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, wait) = mpsc::channel();
    let release = ReleaseBlockingWorker(release);
    let worker = tokio::task::spawn_blocking(move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5))
            .expect("test did not release its blocking worker");
    });
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .expect("blocking worker did not start")
        .unwrap();
    (release, worker)
}

fn acquire(lock_path: &Path) -> Flock<File> {
    match lock::try_acquire_or_busy_blocking(lock_path).unwrap() {
        lock::TryLock::Acquired(guard) => guard,
        lock::TryLock::Busy => panic!("test lock unexpectedly busy"),
    }
}

async fn wait_for_publication_lock(lock_path: &Path) -> Flock<File> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match lock::try_acquire_or_busy_blocking(lock_path).unwrap() {
                lock::TryLock::Acquired(guard) => return guard,
                lock::TryLock::Busy => tokio::task::yield_now().await,
            }
        }
    })
    .await
    .expect("publication did not retire its physical lock")
}

#[test]
fn cancelled_publication_retains_lock_until_queued_file_work_finishes() {
    let directory = tempfile::tempdir().unwrap();
    let cache_path = directory.path().join("catalog.json");
    let lock_path = directory.path().join("catalog.lock");
    let guard = acquire(&lock_path);
    let cache = BuiltinFirewallCatalogCache::from_catalog(catalog("github"));
    let expected = serde_json::to_vec(&cache).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();

    runtime.block_on(async {
        let (release, worker) = occupy_blocking_worker().await;
        let mut publication = Box::pin(publish_catalog_cache(
            cache_path.clone(),
            expected.clone(),
            guard,
        ));
        // The only blocking worker is occupied. This poll admits publication,
        // then leaves its observer pending before any file work can execute.
        assert!(futures_util::poll!(publication.as_mut()).is_pending());
        drop(publication);

        assert!(
            matches!(
                lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
                lock::TryLock::Busy
            ),
            "cancelled publication released authority before accepted file work finished"
        );

        drop(release);
        worker.await.unwrap();
        // Acquiring the actual flock observes physical retirement even though
        // the original publication result no longer has a waiter.
        let completed = wait_for_publication_lock(&lock_path).await;
        assert_eq!(std::fs::read(&cache_path).unwrap(), expected);
        assert_eq!(
            std::fs::metadata(&cache_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
        drop(completed);

        write_catalog_cache(&cache_path, &lock_path, catalog("replacement"))
            .await
            .unwrap();
        let replacement = read_catalog_cache(&cache_path).await.unwrap().unwrap();
        assert!(replacement.firewalls.contains_key("replacement"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    });
}

#[tokio::test]
async fn failed_publication_retires_staging_and_releases_lock() {
    let directory = tempfile::tempdir().unwrap();
    let cache_path = directory.path().join("catalog.json");
    let lock_path = directory.path().join("catalog.lock");
    // A directory cannot be replaced by the private atomic file rename.
    std::fs::create_dir(&cache_path).unwrap();

    let error = write_catalog_cache(&cache_path, &lock_path, catalog("github"))
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("rename state file"),
        "unexpected publication error: {error}"
    );
    let released = acquire(&lock_path);
    assert!(cache_path.is_dir());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    drop(released);
    std::fs::remove_dir(&cache_path).unwrap();
    write_catalog_cache(&cache_path, &lock_path, catalog("github"))
        .await
        .unwrap();
    let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
    assert_eq!(cache.catalog_version, "test-catalog");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}
