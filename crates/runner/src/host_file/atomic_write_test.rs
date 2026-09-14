//! A one-shot, path-scoped gate for an already-dispatched atomic replacement.
//!
//! The gated operation still performs the real Tokio rename. Its independent
//! task models blocking filesystem work that continues after its waiter is
//! cancelled, allowing tests to control that ordering without sleeps or globals
//! that affect unrelated files. Dropping the gate releases the operation.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

static GATES: LazyLock<Mutex<HashMap<PathBuf, RenameOperation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct RenameOperation {
    entered: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
    settled: oneshot::Sender<()>,
}

pub(crate) struct AtomicRenameGate {
    path: PathBuf,
    entered: oneshot::Receiver<()>,
    release: Option<oneshot::Sender<()>>,
    settled: oneshot::Receiver<()>,
}

impl AtomicRenameGate {
    pub(crate) fn new(path: &Path) -> Self {
        let (entered_tx, entered) = oneshot::channel();
        let (release, release_rx) = oneshot::channel();
        let (settled_tx, settled) = oneshot::channel();
        let previous = GATES.lock().unwrap().insert(
            path.to_path_buf(),
            RenameOperation {
                entered: entered_tx,
                release: release_rx,
                settled: settled_tx,
            },
        );
        assert!(previous.is_none(), "only one rename gate may own a path");
        Self {
            path: path.to_path_buf(),
            entered,
            release: Some(release),
            settled,
        }
    }

    pub(crate) async fn wait_entered(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), &mut self.entered)
            .await
            .expect("atomic replacement should start")
            .expect("atomic replacement should signal entry");
    }

    pub(crate) async fn finish(mut self) {
        drop(self.release.take());
        tokio::time::timeout(Duration::from_secs(5), &mut self.settled)
            .await
            .expect("atomic replacement should settle")
            .expect("atomic replacement should signal completion");
    }
}

impl Drop for AtomicRenameGate {
    fn drop(&mut self) {
        GATES.lock().unwrap().remove(&self.path);
    }
}

pub(super) async fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let operation = GATES.lock().unwrap().remove(to);
    let Some(operation) = operation else {
        return tokio::fs::rename(from, to).await;
    };
    let from = from.to_path_buf();
    let to = to.to_path_buf();
    tokio::spawn(async move {
        let _ = operation.entered.send(());
        let _ = operation.release.await;
        let result = tokio::fs::rename(from, to).await;
        let _ = operation.settled.send(());
        result
    })
    .await
    .map_err(io::Error::other)?
}
