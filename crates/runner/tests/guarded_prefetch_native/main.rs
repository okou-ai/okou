#![cfg(target_os = "linux")]

//! Opt-in real procfs/disposable snapshot prefetch. Inputs are supplied
//! measurements, not production defaults or proof of combined native Guests.

use std::{error::Error, num::NonZeroUsize, path::PathBuf, sync::Arc, time::Duration};

use runner_lifecycle::{
    host_memory_operations::{
        HostMemoryOperations, MemoryOperationPolicy, ProcMemoryObservationSource,
    },
    host_memory_policy::HostMemoryBounds,
    host_memory_pressure::HostPressurePolicy,
    idle_pool::{IdlePool, IdlePoolConfig, IdleRetirementEnvelope},
    prefetch::{GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks},
    status::StatusTracker,
};
use runner_supervisor::{
    idle_lifecycle::IdleDestroyTracker,
    idle_pressure::{IdlePressureConfig, IdlePressureOwner},
};
use serde::Deserialize;
use tokio::sync::{Mutex, Notify};

#[derive(Deserialize)]
struct Inputs {
    bounds: SuppliedBounds,
    max_sample_age_millis: u64,
    max_operations: usize,
    max_cleanup_inflight: usize,
    recovery_sustain_millis: u64,
    wave_cooldown_millis: u64,
    optional_start_interval_millis: u64,
    sample_period_millis: u64,
    live_growth_bytes: u64,
    tail_growth_bytes: u64,
    prefetch_overhead_bytes: u64,
    snapshot_memory_mb: u32,
}

#[derive(Deserialize)]
struct SuppliedBounds {
    host_total_bytes: u64,
    operating_floor_bytes: u64,
    cleanup_reserve_bytes: u64,
    critical_available_bytes: u64,
    recovery_available_bytes: u64,
}

impl SuppliedBounds {
    fn policy(&self) -> HostMemoryBounds {
        HostMemoryBounds {
            host_total_bytes: self.host_total_bytes,
            operating_floor_bytes: self.operating_floor_bytes,
            cleanup_reserve_bytes: self.cleanup_reserve_bytes,
            critical_available_bytes: self.critical_available_bytes,
            recovery_available_bytes: self.recovery_available_bytes,
        }
    }
}

#[tokio::test]
#[ignore = "requires disposable snapshot artifact, real host observations and supplied measured policy"]
async fn guarded_snapshot_prefetch_joins_real_io_with_supplied_host_envelope()
-> Result<(), Box<dyn Error + Send + Sync>> {
    let policy_path = PathBuf::from(std::env::var("OKOU_TEST_PREFETCH_POLICY")?);
    let inputs: Inputs = serde_json::from_slice(&std::fs::read(policy_path)?)?;
    let artifact = PathBuf::from(std::env::var("OKOU_TEST_PREFETCH_SNAPSHOT")?);
    let owned = tempfile::tempdir()?;
    let snapshot = owned.path().join("memory.bin");
    tokio::fs::copy(artifact, &snapshot).await?;
    let expected = tokio::fs::metadata(&snapshot).await?.len();
    let operations = HostMemoryOperations::new(
        MemoryOperationPolicy {
            bounds: inputs.bounds.policy(),
            max_sample_age: Duration::from_millis(inputs.max_sample_age_millis),
            max_operations: inputs.max_operations,
            max_cleanup_inflight: inputs.max_cleanup_inflight,
        },
        Arc::new(ProcMemoryObservationSource),
    )?;
    let status = Arc::new(StatusTracker::new(
        owned.path().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await?;
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: Arc::new(Mutex::new(IdlePool::new(IdlePoolConfig { max_idle: 1 }))),
        status,
        tracker: tracker.clone(),
        operations: operations.clone(),
        policy: HostPressurePolicy {
            bounds: inputs.bounds.policy(),
            max_sample_age: Duration::from_millis(inputs.max_sample_age_millis),
            recovery_sustain: Duration::from_millis(inputs.recovery_sustain_millis),
            wave_cooldown: Duration::from_millis(inputs.wave_cooldown_millis),
            optional_start_interval: Duration::from_millis(inputs.optional_start_interval_millis),
            max_wave_entries: NonZeroUsize::MIN,
        },
        sample_period: Duration::from_millis(inputs.sample_period_millis),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: inputs.live_growth_bytes,
            tail_growth_bytes: inputs.tail_growth_bytes,
        },
    })?;
    let started = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: snapshot,
            memory_mb: inputs.snapshot_memory_mb,
        }],
        u64::from(inputs.snapshot_memory_mb),
        GuardedPrefetchConfig {
            pressure: pressure.optional_preparation(),
            overhead_bytes: inputs.prefetch_overhead_bytes,
        },
    );
    let (mut prefetch, mut latest) = match started {
        Ok(started) => started,
        Err(error) => {
            pressure.shutdown().await?;
            tracker.close_and_wait().await;
            operations.close_and_wait().await?;
            return Err(error.into());
        }
    };
    let completed = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let result = latest.borrow_and_update().clone();
            if result.finished {
                return Ok::<_, tokio::sync::watch::error::RecvError>(result);
            }
            latest.changed().await?;
        }
    })
    .await;
    // Even timeout/refusal joins real owners. It is not physical completion.
    prefetch.cancel();
    prefetch.drain().await;
    pressure.shutdown().await?;
    tracker.close_and_wait().await;
    let settled = operations.close_and_wait().await?;
    let result = completed??;
    assert_eq!(
        (result.completed, result.failed, result.uncertain),
        (1, 0, 0)
    );
    assert_eq!(result.read_bytes, expected);
    assert_eq!(
        (settled.registered_operations, settled.tracked_tasks),
        (0, 0)
    );
    Ok(())
}
