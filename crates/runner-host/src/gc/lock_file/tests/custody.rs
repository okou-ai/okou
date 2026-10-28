use std::future::Future;
use std::path::Path;
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;

use super::super::*;

const WAIT: Duration = Duration::from_secs(5);

struct ReleaseWorkerOnDrop(Option<mpsc::Sender<()>>);

impl Drop for ReleaseWorkerOnDrop {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

fn occupy_blocking_worker(runtime: &Runtime) -> (ReleaseWorkerOnDrop, JoinHandle<()>) {
    let (started, started_rx) = mpsc::sync_channel(0);
    let (release, release_rx) = mpsc::channel();
    let gate = ReleaseWorkerOnDrop(Some(release));
    let worker = runtime.spawn_blocking(move || {
        started.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    started_rx.recv_timeout(WAIT).unwrap();
    (gate, worker)
}

fn acquire(path: &Path) -> Flock<std::fs::File> {
    match probe_lock(path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("test lock unexpectedly held"),
        LockProbe::Error(error) => panic!("cannot acquire test lock: {error}"),
    }
}

#[test]
fn cancelled_lock_removal_retains_authority_until_physical_unlink() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("resource.lock");
    let lock = acquire(&path);
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    let mut removal = Box::pin(remove_unused_lock_after_probe(
        &path,
        lock,
        "resource.lock",
        false,
    ));
    let entered = runtime.enter();
    assert!(
        removal
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);
    drop(removal);

    assert!(
        matches!(probe_existing_lock(&path), ExistingLockProbe::Held),
        "cancelled GC observer released authority before physical unlink retired"
    );

    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker.await.unwrap();
            while path.try_exists().unwrap() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("accepted physical unlink did not retire");
    });

    let successor = acquire(&path);
    std::fs::write(&path, b"successor").unwrap();
    runtime.block_on(async {
        tokio::time::timeout(WAIT, runtime.spawn_blocking(|| ()))
            .await
            .unwrap()
            .unwrap();
    });
    assert!(crate::lock::lock_matches_path(&successor, &path).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"successor");
}

#[test]
fn queued_lock_removal_preserves_replacement_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("resource.lock");
    let old_path = dir.path().join("retired.lock");
    let lock = acquire(&path);
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let (gate, worker) = occupy_blocking_worker(&runtime);
    let mut removal = Box::pin(remove_unused_lock_after_probe(
        &path,
        lock,
        "resource.lock",
        false,
    ));
    let entered = runtime.enter();
    assert!(
        removal
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    drop(entered);

    std::fs::rename(&path, &old_path).unwrap();
    let replacement = acquire(&path);
    std::fs::write(&path, b"replacement owner").unwrap();
    drop(gate);
    let removed = runtime.block_on(async {
        tokio::time::timeout(WAIT, worker).await.unwrap().unwrap();
        tokio::time::timeout(WAIT, removal).await.unwrap()
    });

    assert!(
        !removed,
        "queued GC removal unlinked a replacement lock inode"
    );
    assert!(crate::lock::lock_matches_path(&replacement, &path).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement owner");
}

struct PhysicalTaskPanic;

struct PanicOnWorkerEvent(std::thread::ThreadId);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for PanicOnWorkerEvent {
    fn on_event(
        &self,
        _event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if std::thread::current().id() != self.0 {
            std::panic::panic_any(PhysicalTaskPanic);
        }
    }
}

#[test]
fn physical_task_panic_preserves_payload_and_retires_guard() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("resource.lock");
    let lock = acquire(&path);
    std::fs::write(&path, b"retained lock").unwrap();
    let runtime = Builder::new_current_thread().enable_all().build().unwrap();
    let subscriber =
        tracing_subscriber::registry().with(PanicOnWorkerEvent(std::thread::current().id()));

    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(
            remove_unused_lock_after_probe(&path, lock, "resource.lock", true)
                .with_subscriber(subscriber),
        )
    }))
    .expect_err("physical task panic was converted into a normal result");

    assert!(panic.is::<PhysicalTaskPanic>());
    let successor = acquire(&path);
    assert!(crate::lock::lock_matches_path(&successor, &path).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"retained lock");
}
