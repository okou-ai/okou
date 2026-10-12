mod admission;
mod boundaries;
mod lifetime;
mod retirement;
mod settlement;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{
    HostMemoryOperations, MemoryGrowthPermit, MemoryObservationSource, MemoryOperation,
    MemoryOperationError as Error, MemoryOperationPlan as Plan, MemoryOperationPolicy,
};
use crate::host_memory_policy::HostMemoryBounds;

const MIB: u64 = 1024 * 1024;

// Synthetic measured-input/availability fixtures, never production calibration.
fn policy() -> MemoryOperationPolicy {
    MemoryOperationPolicy {
        bounds: HostMemoryBounds {
            host_total_bytes: 64 * MIB,
            operating_floor_bytes: 2 * MIB,
            cleanup_reserve_bytes: 4 * MIB,
            critical_available_bytes: 2 * MIB,
            recovery_available_bytes: 8 * MIB,
        },
        max_sample_age: Duration::from_secs(10),
        max_operations: 16,
        max_cleanup_inflight: 2,
    }
}

struct ReadGate {
    captured: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

/// External procfs I/O fixture. Delaying delivery preserves the actual read's
/// timestamp; neither private ledger fields nor fabricated observations are used.
struct FileSource {
    path: PathBuf,
    next_read: Mutex<Option<ReadGate>>,
}

impl FileSource {
    fn gate_next_read(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (captured, observed) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        let previous = self.next_read.lock().unwrap().replace(ReadGate {
            captured,
            release: wait,
        });
        assert!(previous.is_none());
        (observed, release)
    }

    async fn available(&self, mib: u64) {
        tokio::fs::write(&self.path, format!("MemAvailable: {} kB\n", mib * 1024))
            .await
            .unwrap();
    }
}

impl MemoryObservationSource for FileSource {
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

struct Env {
    dir: TempDir,
    source: Arc<FileSource>,
    operations: HostMemoryOperations,
}

impl Env {
    async fn new(available_mib: u64) -> Self {
        Self::with_policy(available_mib, policy()).await
    }

    async fn with_policy(available_mib: u64, policy: MemoryOperationPolicy) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = Arc::new(FileSource {
            path: dir.path().join("meminfo"),
            next_read: Mutex::new(None),
        });
        source.available(available_mib).await;
        let operations = HostMemoryOperations::new(policy, source.clone()).unwrap();
        Self {
            dir,
            source,
            operations,
        }
    }
}

fn fresh(memory_mib: u32) -> Plan {
    Plan::Fresh {
        memory_mib,
        preparation_bytes: 0,
    }
}

async fn grant(operations: &HostMemoryOperations, plan: Plan) -> MemoryGrowthPermit {
    let mut request = operations.request(plan).unwrap();
    for _ in 0..16 {
        match request.try_grant().await {
            Ok(permit) => return permit,
            Err(Error::AccountingChanged) => tokio::task::yield_now().await,
            Err(error) => panic!("fixture grant failed: {error}"),
        }
    }
    panic!("fixture admission never reached a stable observation")
}

async fn complete(operation: &mut MemoryOperation) {
    for _ in 0..16 {
        match operation.complete_phase().await {
            Ok(()) => return,
            Err(Error::AccountingChanged) => tokio::task::yield_now().await,
            Err(error) => panic!("fixture positive phase settlement failed: {error}"),
        }
    }
    panic!("fixture settlement never reached a stable observation")
}

async fn pending_shutdown(
    operations: HostMemoryOperations,
) -> tokio::task::JoinHandle<super::Result<super::MemoryOperationSnapshot>> {
    let (started, observed) = oneshot::channel();
    let shutdown = tokio::spawn(async move {
        let close = operations.close_and_wait();
        tokio::pin!(close);
        assert!(futures_util::poll!(close.as_mut()).is_pending());
        started.send(()).unwrap();
        close.await
    });
    observed.await.unwrap();
    shutdown
}
