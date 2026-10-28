use std::future::{Future, poll_fn};
use std::sync::mpsc;
use std::task::Poll;
use std::time::Duration;

use super::*;

struct ReleaseBlockingWorker(mpsc::Sender<()>);

impl Drop for ReleaseBlockingWorker {
    fn drop(&mut self) {
        // A failed assertion must still release the worker before runtime Drop.
        let _ = self.0.send(());
    }
}

async fn occupy_blocking_worker() -> (ReleaseBlockingWorker, tokio::task::JoinHandle<()>) {
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, wait) = mpsc::channel();
    let release = ReleaseBlockingWorker(release);
    let task = tokio::task::spawn_blocking(move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5))
            .expect("test did not release its blocking worker");
    });
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .expect("blocking worker did not start")
        .unwrap();
    (release, task)
}

async fn wait_for_publication_lock(path: &Path) -> Flock<File> {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match lock::try_acquire_or_busy_blocking(path).unwrap() {
                lock::TryLock::Acquired(guard) => return guard,
                lock::TryLock::Busy => tokio::task::yield_now().await,
            }
        }
    })
    .await
    .expect("registry publication did not retire its physical lock")
}

#[test]
fn cancelled_registry_publication_keeps_successor_serialized() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let harness = RegistryHarness::new().await;
        let old_ip = "10.200.0.2";
        harness
            .handle
            .register_sandbox(old_ip, &base_registration())
            .await
            .unwrap();
        let transaction = harness
            .handle
            .connector_runtime_registry_transaction()
            .await
            .unwrap();
        // Exercise the physical handoff after a snapshot has been prepared,
        // independently of which mutation produced it. Full owner tests cover
        // registration, unregister and both connector transaction policies.
        let mut registry = read_registry(harness.registry_path()).await.unwrap();
        registry.sandboxes.remove(old_ip).unwrap();
        registry.updated_at += 1;
        let expected = serde_json::to_vec(&registry).unwrap();
        let (release, task) = occupy_blocking_worker().await;
        let mut publication = Box::pin(write_locked_registry(
            harness.registry_path(),
            &registry,
            transaction._guard,
        ));
        // This poll admits file work behind the occupied sole blocking worker.
        let pending = poll_fn(|cx| Poll::Ready(publication.as_mut().poll(cx).is_pending())).await;
        assert!(
            pending,
            "queued registry publication unexpectedly completed"
        );
        drop(publication);
        assert!(
            matches!(
                lock::try_acquire_or_busy_blocking(&harness.handle.lock_path).unwrap(),
                lock::TryLock::Busy
            ),
            "cancelled registry observer released authority before physical publication finished"
        );

        drop(release);
        task.await.unwrap();
        let completed = wait_for_publication_lock(&harness.handle.lock_path).await;
        assert_eq!(std::fs::read(harness.registry_path()).unwrap(), expected);
        assert_eq!(
            std::fs::metadata(harness.registry_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_dir(harness._dir.path()).unwrap().count(), 2);
        drop(completed);

        let successor_ip = "10.200.0.3";
        let successor = harness
            .handle
            .register_sandbox(successor_ip, &base_registration())
            .await
            .unwrap();
        let persisted = std::fs::read(harness.registry_path()).unwrap();
        assert_eq!(successor.digest, RegistryDigest::of(&persisted));
        let stored: ProxyRegistry = serde_json::from_slice(&persisted).unwrap();
        assert_eq!(stored.sandboxes.len(), 1);
        assert_eq!(stored.sandboxes[successor_ip].run_id, "run-test");
        assert!(!stored.sandboxes.contains_key(old_ip));
        assert_eq!(std::fs::read_dir(harness._dir.path()).unwrap().count(), 2);
    });
}

#[tokio::test]
async fn failed_locked_registry_publication_cleans_staging_and_unlocks() {
    let harness = RegistryHarness::new().await;
    let registry = read_registry(harness.registry_path()).await.unwrap();
    let transaction = harness
        .handle
        .connector_runtime_registry_transaction()
        .await
        .unwrap();
    std::fs::remove_file(harness.registry_path()).unwrap();
    std::fs::create_dir(harness.registry_path()).unwrap();

    let error =
        write_registry_with_reserve(harness.registry_path(), &registry, 0, transaction._guard)
            .await
            .unwrap_err();

    assert!(error.to_string().contains("rename state file"), "{error}");
    let released = wait_for_publication_lock(&harness.handle.lock_path).await;
    assert!(harness.registry_path().is_dir());
    assert_eq!(std::fs::read_dir(harness._dir.path()).unwrap().count(), 2);
    drop(released);
    std::fs::remove_dir(harness.registry_path()).unwrap();
    write_empty_registry(harness.registry_path()).await.unwrap();
    let publication = harness
        .handle
        .register_sandbox("10.200.0.3", &base_registration())
        .await
        .unwrap();
    let stored = std::fs::read(harness.registry_path()).unwrap();
    assert_eq!(publication.digest, RegistryDigest::of(&stored));
    let registry: ProxyRegistry = serde_json::from_slice(&stored).unwrap();
    assert_eq!(registry.sandboxes["10.200.0.3"].run_id, "run-test");
    assert_eq!(std::fs::read_dir(harness._dir.path()).unwrap().count(), 2);
}
