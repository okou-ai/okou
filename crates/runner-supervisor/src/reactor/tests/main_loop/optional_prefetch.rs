use std::num::NonZeroUsize;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPolicy,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::host_memory_pressure::HostPressurePolicy;
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};

use crate::idle_pressure::{IdlePressureConfig, IdlePressureOwner};

use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, push_job, shutdown, test_profiles, wait_discover_entered,
};

struct Source(PathBuf);

mod blank;

impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

#[tokio::test]
async fn guarded_prefetch_recovers_beside_real_reactor_and_preserves_fitting_job() {
    const MIB: u64 = 1024 * 1024;
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let meminfo = env._temp_dir.path().join("optional-meminfo");
    tokio::fs::write(&meminfo, "MemAvailable: 12288 kB\n")
        .await
        .unwrap();
    let snapshot = env._temp_dir.path().join("snapshot-memory");
    tokio::fs::write(&snapshot, vec![7; 8192]).await.unwrap();
    let bounds = HostMemoryBounds {
        host_total_bytes: 64 * MIB,
        operating_floor_bytes: 4 * MIB,
        cleanup_reserve_bytes: 4 * MIB,
        critical_available_bytes: 16 * MIB,
        recovery_available_bytes: 24 * MIB,
    };
    let operations = HostMemoryOperations::new(
        MemoryOperationPolicy {
            bounds,
            max_sample_age: Duration::from_secs(5),
            max_operations: 16,
            max_cleanup_inflight: 4,
        },
        Arc::new(Source(meminfo.clone())),
    )
    .unwrap();
    let tracker = IdleDestroyTracker::new(config.shared.reuse_state_notify.clone());
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: config.shared.idle_pool.clone(),
        status: config.shared.status.clone(),
        tracker: tracker.clone(),
        operations: operations.clone(),
        policy: HostPressurePolicy {
            bounds,
            max_sample_age: operations.policy().max_sample_age,
            recovery_sustain: Duration::from_millis(10),
            wave_cooldown: Duration::from_millis(10),
            optional_start_interval: Duration::from_millis(10),
            max_wave_entries: NonZeroUsize::MIN,
        },
        sample_period: Duration::from_millis(5),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: MIB,
            tail_growth_bytes: MIB,
        },
    })
    .unwrap();
    let (mut prefetch, mut latest) = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: snapshot.clone(),
            memory_mb: 1,
        }],
        1,
        GuardedPrefetchConfig {
            pressure: pressure.optional_preparation(),
            overhead_bytes: MIB,
        },
    )
    .unwrap();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert_eq!(latest.borrow().accepted, 0);
    // Both the independent controller and the real reactor keep progressing;
    // this logical job does not manufacture physical optional permission.
    let id = RunId::new_v4();
    push_job(
        &env,
        id,
        "vm0/default",
        Some(context_with_session(id, "optional-fits")),
    );
    assert_eq!(
        env.handle
            .wait_completion(id, Duration::from_secs(5))
            .await
            .unwrap()
            .exit_code,
        0
    );
    let next = meminfo.with_extension("next");
    tokio::fs::write(&next, "MemAvailable: 49152 kB\n")
        .await
        .unwrap();
    tokio::fs::rename(next, &meminfo).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = latest.borrow_and_update().clone();
            if value.finished {
                break value;
            }
            latest.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        (result.completed, result.read_bytes, result.uncertain),
        (1, 8192, 0)
    );
    assert_eq!(tokio::fs::read(snapshot).await.unwrap(), vec![7; 8192]);
    prefetch.drain().await;
    pressure.shutdown().await.unwrap();
    tracker.close_and_wait().await;
    shutdown(&env, runner).await;
    let settled = operations.close_and_wait().await.unwrap();
    assert_eq!(
        (settled.registered_operations, settled.tracked_tasks),
        (0, 0)
    );
}
