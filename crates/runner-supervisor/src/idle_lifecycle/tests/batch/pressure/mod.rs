use std::num::NonZeroUsize;

use crate::idle_pressure::{IdlePressureConfig, IdlePressureOwner, IdlePressureSnapshot};
use runner_lifecycle::host_memory_pressure::{HostPressurePolicy, HostPressureState};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::*;

mod owner;
mod waves;

fn physical_policy() -> MemoryOperationPolicy {
    MemoryOperationPolicy {
        bounds: HostMemoryBounds {
            critical_available_bytes: 32 * MIB,
            recovery_available_bytes: 48 * MIB,
            ..policy().bounds
        },
        max_cleanup_inflight: 8,
        ..policy()
    }
}

async fn fixture(available: u64) -> BatchFixture {
    let mut fixture = BatchFixture::new().await;
    // Nine host CPUs leave capacity for four two-vCPU guest leases after the
    // production host reservation; RAM remains exactly bounded.
    fixture.budget = Arc::new(ResourceBudget::new(9, 8192, 1.0, 0));
    available_bytes(&fixture, available).await;
    fixture.operations = HostMemoryOperations::new(
        physical_policy(),
        Arc::new(FileSource(fixture.meminfo.clone())),
    )
    .unwrap();
    fixture
}

async fn available_bytes(fixture: &BatchFixture, mib: u64) {
    tokio::fs::write(
        &fixture.meminfo,
        format!("MemAvailable: {} kB\n", mib * 1024),
    )
    .await
    .unwrap();
}

fn config(fixture: &BatchFixture, count: usize) -> IdlePressureConfig {
    IdlePressureConfig {
        pool: fixture.pool.clone(),
        status: fixture.status.clone(),
        tracker: fixture.tracker.clone(),
        operations: fixture.operations.clone(),
        policy: HostPressurePolicy {
            bounds: fixture.operations.policy().bounds,
            max_sample_age: fixture.operations.policy().max_sample_age,
            recovery_sustain: Duration::from_millis(10),
            wave_cooldown: Duration::from_millis(20),
            optional_start_interval: Duration::from_millis(10),
            max_wave_entries: NonZeroUsize::new(count).unwrap(),
        },
        sample_period: Duration::from_millis(5),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        },
    }
}

fn gate(fixture: &mut BatchFixture, hold_on: usize) -> Arc<GatedSource> {
    let source = GatedSource::new(fixture.meminfo.clone(), hold_on);
    fixture.operations = HostMemoryOperations::new(physical_policy(), source.clone()).unwrap();
    source
}

fn wave(
    fixture: &BatchFixture,
    count: usize,
    cancel: CancellationToken,
) -> IdleCleanupTask<IdlePressureWaveReport> {
    let input = config(fixture, count);
    fixture
        .tracker
        .start_pressure_wave(crate::idle_lifecycle::pressure::IdlePressureWaveRequest {
            pool: input.pool,
            status: input.status,
            operations: input.operations,
            policy: input.policy,
            envelope: input.envelope,
            cancel,
        })
        .unwrap()
}

async fn result(task: &mut IdleCleanupTask<IdlePressureWaveReport>) -> IdlePressureWaveReport {
    tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap()
}

async fn snapshot(
    latest: &mut watch::Receiver<IdlePressureSnapshot>,
    predicate: impl Fn(&IdlePressureSnapshot) -> bool,
) -> IdlePressureSnapshot {
    tokio::time::timeout(WAIT, async {
        loop {
            let value = latest.borrow_and_update().clone();
            if predicate(&value) {
                return value;
            }
            latest.changed().await.unwrap();
        }
    })
    .await
    .unwrap()
}

async fn started(fixture: &BatchFixture, count: usize) {
    tokio::time::timeout(WAIT, async {
        while fixture.operations.snapshot().unwrap().started != count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
