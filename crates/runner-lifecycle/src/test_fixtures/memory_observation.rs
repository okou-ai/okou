//! Real meminfo observations with a one-shot hold after sampling, before delivery.

use std::path::PathBuf;
use std::sync::Mutex;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use tokio::sync::oneshot;

use crate::host_memory_operations::MemoryObservationSource;

struct ReadGate {
    captured: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

/// Caller-owned procfs-format input; delayed delivery never renews the sample's age.
pub struct FileMemoryObservationSource {
    /// The caller owns this file and its containing temporary directory.
    pub path: PathBuf,
    next_read: Mutex<Option<ReadGate>>,
}

impl FileMemoryObservationSource {
    /// Select the real input path without creating or taking ownership of its file.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            next_read: Mutex::new(None),
        }
    }

    /// Hold delivery of the next captured read until the returned sender releases it.
    ///
    /// The receiver acknowledges the completed file read, not merely entry to it.
    /// Panics if another gate is still pending. Reads fail loudly if either gate
    /// endpoint is lost, preserving cancelled-producer coverage in the caller.
    pub fn gate_next_read(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (captured, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let previous = self.next_read.lock().unwrap().replace(ReadGate {
            captured,
            release: wait,
        });
        assert!(previous.is_none());
        (observed, release)
    }

    /// Write synthetic availability in MiB to the caller's actual meminfo file.
    pub async fn available(&self, mib: u64) {
        tokio::fs::write(&self.path, format!("MemAvailable: {} kB\n", mib * 1024))
            .await
            .unwrap();
    }
}

impl MemoryObservationSource for FileMemoryObservationSource {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            let gate = self.next_read.lock().unwrap().take();
            let observation = HostMemoryObservation::read_at(&self.path).await;
            if let Some(gate) = gate {
                gate.captured.send(()).unwrap();
                gate.release.await.unwrap();
            }
            observation
        })
    }
}
