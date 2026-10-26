use std::collections::BTreeMap;
use std::num::NonZeroUsize;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::host_memory_operations::{
    HostMemoryOperations, MemoryObservationSource, MemoryOperationPolicy,
};
use runner_lifecycle::host_memory_policy::HostMemoryBounds;
use runner_lifecycle::host_memory_pressure::HostPressurePolicy;
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;

use crate::blank_pool::{BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest};
use crate::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use sandbox_mock::{
    MockBackingProcess, MockLifecycleGate, MockSandboxFactory, MockSandboxOverrides,
};

use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, push_job, shutdown, test_profiles, wait_discover_entered,
};

struct Source(PathBuf);

impl MemoryObservationSource for Source {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(HostMemoryObservation::read_at(&self.0))
    }
}

#[tokio::test]
async fn fitting_job_in_real_reactor_preempts_optional_cpu_while_guest_io_remains_owned() {
    const MIB: u64 = 1024 * 1024;
    let (config, env) = mock_run_config(test_profiles(), 16, 32768, 8);
    let meminfo = env._temp_dir.path().join("blank-pressure-meminfo");
    tokio::fs::write(&meminfo, "MemAvailable: 33554432 kB\n")
        .await
        .unwrap();
    let bounds = HostMemoryBounds {
        host_total_bytes: 32768 * MIB,
        operating_floor_bytes: 16 * MIB,
        cleanup_reserve_bytes: 16 * MIB,
        critical_available_bytes: 8192 * MIB,
        recovery_available_bytes: 16384 * MIB,
    };
    let operations = HostMemoryOperations::new(
        MemoryOperationPolicy {
            bounds,
            max_sample_age: Duration::from_secs(5),
            max_operations: 16,
            max_cleanup_inflight: 4,
        },
        Arc::new(Source(meminfo)),
    )
    .unwrap();
    let tracker = IdleDestroyTracker::new(config.shared.reuse_state_notify.clone());
    let envelope = IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    };
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
        envelope,
    })
    .unwrap();
    let control = pressure.optional_preparation();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let changed = control.changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if control.decision().state
                == runner_lifecycle::host_memory_pressure::HostPressureState::Ready
            {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    let overrides = Arc::new(MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start.clone());
    let (exit, backing) = MockBackingProcess::channel();
    let factory = MockSandboxFactory::with_overrides(overrides.clone());
    factory.push_create_backing(backing);
    let factory: crate::SharedFactory = Arc::new(Box::new(factory));
    let profiles = BTreeMap::from([(
        "vm0/default".into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: "test-rootfs".into(),
            home_disk_mb: 32,
        },
    )]);
    let factories = BTreeMap::from([("vm0/default".into(), (factory, true))]);
    let budget = config.capacity.budget.clone();
    let pool = config.shared.idle_pool.clone();
    let status = config.shared.status.clone();
    let admission = config.exec_config.pre_spawn_admission.clone();
    let mut blank = BlankPoolReplenisher::new(&profiles, &factories, &budget, 1, None);
    assert!(
        blank
            .maybe_start_optional(OptionalBlankPoolRequest {
                mode: RunnerMode::Running,
                pool: &pool,
                budget: &budget,
                admission: &admission,
                status: &status,
                tracker: &tracker,
                pressure: &control,
                preparation_bytes: MIB,
                envelope,
            })
            .unwrap()
    );
    start.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let id = RunId::new_v4();
    push_job(
        &env,
        id,
        "vm0/default",
        Some(context_with_session(id, "optional-blank-foreground")),
    );
    assert_eq!(
        env.handle
            .wait_completion(id, Duration::from_secs(5))
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert!(budget.allocated().0 >= 2);
    assert_eq!(overrides.destroy_call_count(), 0);
    {
        let waited = blank.wait_for_optional_preparation();
        tokio::pin!(waited);
        assert!(futures_util::poll!(waited.as_mut()).is_pending());
        start.release_one();
        let result = tokio::time::timeout(Duration::from_secs(5), waited)
            .await
            .unwrap()
            .unwrap();
        assert!(!result.snapshot().prepared && result.snapshot().retained_resource);
    }
    exit.confirm_exit();
    blank.shutdown_optional(&tracker).await.unwrap();
    pressure.shutdown().await.unwrap();
    tracker.close_and_wait().await;
    shutdown(&env, runner).await;
}
