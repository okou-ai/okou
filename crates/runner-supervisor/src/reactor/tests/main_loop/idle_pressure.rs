use std::num::NonZeroUsize;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPolicy,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::host_memory_pressure::HostPressurePolicy;
use runner_lifecycle::idle_pool::{IdleRetirementEnvelope, ParkResult, ParkedIdleCandidate};
use sandbox::{SandboxFactory, SandboxId};
use sandbox_mock::{
    MockBackingProcess, MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides,
};

use crate::idle_pressure::{IdlePressureConfig, IdlePressureOwner};

use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, push_job, seed_idle_pool, shutdown, test_profiles,
    wait_discover_entered,
};

const MIB: u64 = 1024 * 1024;

struct ProcFile(PathBuf);

impl MemoryObservationSource for ProcFile {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

#[tokio::test]
async fn job_free_pressure_and_held_cleanup_leave_real_reactor_heartbeat_and_fitting_job_progressing()
 {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (heartbeat, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let tracker = IdleDestroyTracker::new(config.shared.reuse_state_notify.clone());
    let status = config.shared.status.clone();
    let pool = config.shared.idle_pool.clone();
    let logical = config.capacity.budget.clone();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let kill = MockLifecycleGate::new();
    overrides.set_kill_lifecycle_gate(kill.clone());
    let (exit, backing) = MockBackingProcess::channel();
    let id = SandboxId::new_v4();
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(overrides.clone()),
    ));
    let mut blank = ParkedIdleCandidate::blank(
        Box::new(
            MockSandbox::with_overrides(id.to_string(), overrides).with_backing_process(backing),
        ),
        factory,
        ResourceBudget::try_reserve_lease(&logical, 2, 4096).unwrap(),
        id,
        "vm0/default".into(),
        config.runner.profiles["vm0/default"].rootfs_hash.clone(),
        None,
    );
    blank.capture_retirement_backing().unwrap();
    assert!(matches!(pool.lock().await.park(blank), ParkResult::Parked));
    let reuse_key = RunId::new_v4().to_string();
    let reused = seed_idle_pool(&pool, &logical, &reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let meminfo = env._temp_dir.path().join("pressure-meminfo");
    tokio::fs::write(&meminfo, "MemAvailable: 24576 kB\n")
        .await
        .unwrap();
    let bounds = HostMemoryBounds {
        host_total_bytes: 64 * MIB,
        operating_floor_bytes: 2 * MIB,
        cleanup_reserve_bytes: 4 * MIB,
        critical_available_bytes: 32 * MIB,
        recovery_available_bytes: 48 * MIB,
    };
    let operations = HostMemoryOperations::new(
        MemoryOperationPolicy {
            bounds,
            max_sample_age: Duration::from_secs(10),
            max_operations: 16,
            max_cleanup_inflight: 4,
        },
        Arc::new(ProcFile(meminfo.clone())),
    )
    .unwrap();
    // Explicit component assembly, joined before the real reactor's dependency
    // teardown. Full production physical admission remains the separate P4 gate.
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool,
        status,
        tracker: tracker.clone(),
        operations: operations.clone(),
        policy: HostPressurePolicy {
            bounds,
            max_sample_age: Duration::from_secs(10),
            recovery_sustain: Duration::from_millis(10),
            wave_cooldown: Duration::from_millis(20),
            optional_start_interval: Duration::from_millis(10),
            max_wave_entries: NonZeroUsize::new(1).unwrap(),
        },
        sample_period: Duration::from_millis(5),
        envelope: IdleRetirementEnvelope {
            live_growth_bytes: 8 * MIB,
            tail_growth_bytes: MIB,
        },
    })
    .unwrap();
    kill.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert!(env.handle.claim_candidates().is_empty());
    exit.confirm_exit();
    // Live settlement and the sampler read concurrently. Publish a complete
    // snapshot instead of exposing an in-place write's truncation window.
    let next_meminfo = meminfo.with_extension("next");
    tokio::fs::write(&next_meminfo, "MemAvailable: 65536 kB\n")
        .await
        .unwrap();
    tokio::fs::rename(next_meminfo, &meminfo).await.unwrap();
    let before = env.handle.heartbeat_count();
    heartbeat.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while env.handle.heartbeat_count() <= before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, &reuse_key)),
    );
    let completed = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(completed.sandbox_id, Some(reused), "{completed:?}");
    assert_eq!(
        completed.reuse_result,
        Some(runner_types::types::SandboxReuseResult::Reused)
    );
    assert_eq!(env.handle.claim_candidates().len(), 1);
    let joined = pressure.shutdown();
    tokio::pin!(joined);
    assert!(futures_util::poll!(joined.as_mut()).is_pending());
    kill.release_one();
    let stopped = tokio::time::timeout(Duration::from_secs(5), joined)
        .await
        .unwrap()
        .unwrap();
    let report = stopped.last_wave.unwrap();
    assert!(report.is_resolved(), "{report:?}");
    tracker.close_and_wait().await;
    assert_eq!(
        operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    shutdown(&env, run_handle).await;
    assert_eq!(logical.allocated(), (0, 0, 0));
}
