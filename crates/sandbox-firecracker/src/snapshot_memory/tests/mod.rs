use std::sync::Mutex;

use futures_util::FutureExt;

use super::*;

#[derive(Clone)]
pub(super) struct WorkHook(Arc<Mutex<Option<WorkGate>>>);

struct WorkGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

impl WorkHook {
    pub(super) fn wait(&self) {
        let Some(gate) = self.0.lock().unwrap().take() else {
            return;
        };
        gate.entered.send(()).unwrap();
        gate.release.recv().unwrap();
    }
}

#[tokio::test]
async fn shared_work_stays_owned_across_cancelled_shutdown() {
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file().set_len(4096).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hook = WorkHook(Arc::new(Mutex::new(Some(WorkGate {
        entered: entered_tx,
        release: release_rx,
    }))));
    let mut owner = SnapshotMemoryPrefetch::start(file.path().to_path_buf(), Some(hook));
    let handle = owner.handle();
    assert!(handle.request(WorkKind::Learn, UNTRAINED));
    entered_rx.await.unwrap();
    assert!(!handle.request(WorkKind::Learn, UNTRAINED));

    // Poll shutdown through cancellation and into its join, then drop only
    // that waiter. The physical producer and single-flight reservation remain.
    assert!(owner.shutdown().now_or_never().is_none());
    assert!(handle.control.stop.is_cancelled());
    assert!(handle.control.busy.load(Ordering::Acquire));
    assert!(owner.worker.is_some());
    assert!(!handle.request(WorkKind::Learn, UNTRAINED));

    release_tx.send(()).unwrap();
    owner.shutdown().await;
    assert!(owner.worker.is_none());
    assert!(!handle.control.busy.load(Ordering::Acquire));
    assert!(handle.tx.is_closed());
    assert!(!handle.request(WorkKind::Prefetch, TRAINED));
}

#[tokio::test]
async fn abnormal_owner_drop_signals_and_retires_the_physical_producer() {
    let file = tempfile::NamedTempFile::new().unwrap();
    file.as_file().set_len(4096).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hook = WorkHook(Arc::new(Mutex::new(Some(WorkGate {
        entered: entered_tx,
        release: release_rx,
    }))));
    let mut owner = SnapshotMemoryPrefetch::start(file.path().to_path_buf(), Some(hook));
    let handle = owner.handle();
    handle.learn();
    entered_rx.await.unwrap();
    // Retain an observer solely to positively join after exercising owner Drop.
    let worker = owner.worker.take().unwrap();
    drop(owner);
    assert!(handle.control.stop.is_cancelled());
    assert!(handle.control.busy.load(Ordering::Acquire));
    release_tx.send(()).unwrap();
    worker.await.unwrap();
    assert!(handle.tx.is_closed());
    assert!(!handle.control.busy.load(Ordering::Acquire));
}
