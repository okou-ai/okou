mod admission;
mod boundaries;
mod lifetime;
mod refresh;
mod retirement;
mod settlement;

use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;
use tokio::sync::oneshot;

use super::{
    HostMemoryOperations, MemoryGrowthPermit, MemoryOperation, MemoryOperationError as Error,
    MemoryOperationPlan as Plan, MemoryOperationPolicy,
};
use crate::host_memory_policy::HostMemoryBounds;
use crate::test_fixtures::memory_observation::FileMemoryObservationSource as FileSource;

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
        let source = Arc::new(FileSource::new(dir.path().join("meminfo")));
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
