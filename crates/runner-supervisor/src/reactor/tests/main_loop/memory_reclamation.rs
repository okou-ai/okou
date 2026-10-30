use std::path::Path;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use runner_host::host_memory::HostMemoryObservation;
use runner_lifecycle::host_memory_operations::MemoryObservationSource;
use runner_lifecycle::idle_pool::{
    ParkResult, ParkedIdleCandidate, RestoreReservedIdleResult,
    test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::BudgetLeaseWitness;
use sandbox::{SandboxFactory, SandboxId};
use sandbox_mock::{
    MockBackingProcess, MockBackingProcessCompletion, MockLifecycleGate, MockSandbox,
    MockSandboxFactory, MockSandboxOverrides,
};

use super::super::super::*;
use super::super::support::{
    MockRunEnv, minimal_context, mock_run_config, mock_run_config_with_overrides, push_job,
    shutdown, test_profiles, wait_idle_pool_len,
};

const WAIT: Duration = Duration::from_secs(5);

async fn available(path: &Path, mib: u64) {
    let next = path.with_extension("next");
    tokio::fs::write(&next, format!("MemAvailable: {} kB\n", mib * 1024))
        .await
        .unwrap();
    tokio::fs::rename(next, path).await.unwrap();
}

async fn memory_completed(env: &MockRunEnv, cursor: StartLoopCursor) {
    env.start_observer
        .wait_after(
            cursor,
            WAIT,
            "memory observation/cleanup completion",
            &mut |event| matches!(event, StartLoopEvent::IdleMemoryCompleted).then_some(()),
        )
        .await;
}

async fn memory_tick(env: &MockRunEnv, ticks: &mpsc::UnboundedSender<()>) {
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    env.start_observer
        .wait_after(cursor, WAIT, "memory tick", &mut |event| {
            matches!(event, StartLoopEvent::IdleMemoryTickConsumed).then_some(())
        })
        .await;
}

async fn seed(
    config: &RunConfig,
    overrides: &Arc<MockSandboxOverrides>,
    exact: Option<&str>,
    age: Duration,
) -> (SandboxId, MockBackingProcessCompletion, BudgetLeaseWitness) {
    let id = SandboxId::new_v4();
    let (exit, backing) = MockBackingProcess::channel();
    let sandbox = Box::new(
        MockSandbox::with_overrides(id.to_string(), overrides.clone())
            .with_backing_process(backing),
    );
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        MockSandboxFactory::with_overrides(overrides.clone()),
    ));
    let lease = ResourceBudget::try_reserve_lease(&config.capacity.budget, 2, 4096).unwrap();
    let lease_witness = lease.witness().unwrap();
    let candidate = match exact {
        Some(key) => ParkedIdleCandidateBuilder::new(key, lease)
            .with_sandbox(sandbox)
            .with_factory(factory)
            .with_sandbox_id(id)
            .with_profile_name("vm0/default")
            .with_rootfs_hash(config.runner.profiles["vm0/default"].rootfs_hash.clone())
            .with_last_completed_at("2026-10-27T00:00:00.000Z")
            .build(),
        None => ParkedIdleCandidate::blank(
            sandbox,
            factory,
            lease,
            id,
            "vm0/default".into(),
            config.runner.profiles["vm0/default"].rootfs_hash.clone(),
            None,
        ),
    };
    assert!(matches!(
        config
            .shared
            .idle_pool
            .lock()
            .await
            .park_at_for_test(candidate, std::time::Instant::now() - age),
        ParkResult::Parked
    ));
    (id, exit, lease_witness)
}

#[tokio::test]
async fn memavailable_reclaims_blank_then_oldest_idle_without_a_job() {
    let (mut config, env) = mock_run_config(test_profiles(), 16, 32768, 8);
    let meminfo = env._temp_dir.path().join("meminfo");
    available(&meminfo, 4096).await;
    let (ticks, receiver) = mpsc::unbounded_channel();
    config.test_hooks.manual_idle_memory_rx = Some(receiver);
    let overrides = Arc::new(MockSandboxOverrides::new());
    let destroy = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy.clone());
    let (old, old_exit, _) = seed(&config, &overrides, Some("old"), Duration::from_secs(60)).await;
    let (new, _, _) = seed(&config, &overrides, Some("new"), Duration::ZERO).await;
    let (blank, blank_exit, _) = seed(&config, &overrides, None, Duration::ZERO).await;
    let (reserved, _, _) = seed(
        &config,
        &overrides,
        Some("reserved"),
        Duration::from_secs(120),
    )
    .await;
    let pool = config.shared.idle_pool.clone();
    let reservation = pool.lock().await.take_reserved("reserved").unwrap();
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    memory_completed(&env, StartLoopCursor(0)).await;
    assert_eq!(
        overrides.destroy_call_count(),
        0,
        "watermark equality preserves inventory"
    );
    assert_eq!(pool.lock().await.len(), 3);

    available(&meminfo, 0).await;
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert!(!pool.lock().await.contains_sandbox_id(blank));
    assert!(pool.lock().await.contains_sandbox_id(old));
    assert_eq!(
        budget.allocated(),
        (8, 16384, 4),
        "selected full lease remains held"
    );
    memory_tick(&env, &ticks).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(pool.lock().await.contains_sandbox_id(old));
    blank_exit.confirm_exit();
    destroy.release_one();
    memory_completed(&env, cursor).await;

    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    destroy.wait_entered(2, WAIT).await.unwrap();
    assert!(!pool.lock().await.contains_sandbox_id(old));
    assert!(pool.lock().await.contains_sandbox_id(new));
    // Recovery during cleanup is observed after its positive physical completion.
    available(&meminfo, 4096).await;
    old_exit.confirm_exit();
    destroy.release_one();
    memory_completed(&env, cursor).await;
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    assert_eq!(overrides.destroy_call_count(), 2);
    assert!(env.handle.claim_candidates().is_empty());
    assert!(matches!(
        pool.lock().await.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    assert!(pool.lock().await.contains_sandbox_id(reserved));
    // Teardown reuses ordinary cleanup for the two remaining exact entries.
    destroy.release_one();
    destroy.release_one();
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn unknown_memory_suppresses_blank_refill_and_fresh_headroom_restores_it() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32768, 8, overrides.clone());
    let meminfo = env._temp_dir.path().join("meminfo");
    tokio::fs::write(&meminfo, "MemTotal: 32768 kB\n")
        .await
        .unwrap();
    let (ticks, receiver) = mpsc::unbounded_channel();
    config.test_hooks.manual_idle_memory_rx = Some(receiver);
    let pool = config.shared.idle_pool.clone();
    let runner = tokio::spawn(run(config));
    memory_completed(&env, StartLoopCursor(0)).await;
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    assert!(pool.lock().await.is_empty());
    assert!(overrides.create_configs().is_empty());
    available(&meminfo, 8192).await;
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    start.wait_entered(1, WAIT).await.unwrap();
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    start.release_one();
    wait_idle_pool_len(&pool, 1, WAIT).await;
    assert_eq!(overrides.blank_park_call_count(), 1);
    assert_eq!(
        overrides.destroy_call_count(),
        0,
        "healthy sampling must preserve accepted preparation"
    );
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn falling_memavailable_cancels_optional_blank_preparation_through_owned_cleanup() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let start = MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32768, 8, overrides.clone());
    let meminfo = env._temp_dir.path().join("meminfo");
    available(&meminfo, 8192).await;
    let (ticks, receiver) = mpsc::unbounded_channel();
    config.test_hooks.manual_idle_memory_rx = Some(receiver);
    let pool = config.shared.idle_pool.clone();
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    start.wait_entered(1, WAIT).await.unwrap();
    available(&meminfo, 0).await;
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    assert_eq!(
        budget.allocated(),
        (2, 4096, 1),
        "accepted preparation stays owned until its IO returns"
    );
    start.release_one();
    tokio::time::timeout(WAIT, async {
        while budget.allocated().2 != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let cursor = env.start_observer.cursor();
    ticks.send(()).unwrap();
    memory_completed(&env, cursor).await;
    assert!(pool.lock().await.is_empty());
    assert_eq!(overrides.create_configs().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    shutdown(&env, runner).await;
}

async fn held_cleanup(uncertain: bool) {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    available(&env._temp_dir.path().join("meminfo"), 0).await;
    let (ticks, receiver) = mpsc::unbounded_channel();
    config.test_hooks.manual_idle_memory_rx = Some(receiver);
    let (heartbeat, receiver) = mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let overrides = Arc::new(MockSandboxOverrides::new());
    let destroy = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy.clone());
    let (victim, exit, victim_lease_witness) =
        seed(&config, &overrides, None, Duration::ZERO).await;
    seed(&config, &overrides, Some("remaining-idle"), Duration::ZERO).await;
    let pool = config.shared.idle_pool.clone();
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert!(!pool.lock().await.contains_sandbox_id(victim));
    assert_eq!(victim_lease_witness.resources(), (2, 4096));
    assert!(victim_lease_witness.is_active());
    assert_eq!(budget.allocated(), (4, 8192, 2));
    let before = env.handle.heartbeat_count();
    heartbeat.send(()).unwrap();
    tokio::time::timeout(WAIT, async {
        while env.handle.heartbeat_count() <= before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completed = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(completed.exit_code, 0);
    memory_tick(&env, &ticks).await;
    assert_eq!(
        overrides.destroy_call_count(),
        1,
        "only one pressure-owned cleanup may proceed"
    );
    if uncertain {
        let cursor = env.start_observer.cursor();
        exit.fail_wait();
        destroy.release_one();
        memory_completed(&env, cursor).await;
        assert!(
            victim_lease_witness.is_active(),
            "uncertain cleanup retains its original full lease after completion"
        );
        memory_tick(&env, &ticks).await;
        assert_eq!(
            overrides.destroy_call_count(),
            1,
            "uncertainty fences further reclamation"
        );
        assert!(
            victim_lease_witness.is_active(),
            "uncertain cleanup retains its original full lease after a fenced tick"
        );
    } else {
        let cursor = env.start_observer.cursor();
        env.cancel.cancel();
        env.start_observer
            .wait_after(cursor, WAIT, "reclaimer teardown join", &mut |event| {
                matches!(event, StartLoopEvent::MaintenanceDrainEntered).then_some(())
            })
            .await;
        assert!(
            !runner.is_finished(),
            "normal shutdown must join accepted cleanup"
        );
        assert!(budget.allocated().2 >= 1);
        exit.confirm_exit();
        destroy.release_one();
    }
    destroy.release_one();
    shutdown(&env, runner).await;
    assert!(!victim_lease_witness.is_active());
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn pressure_cleanup_keeps_heartbeat_jobs_and_joined_shutdown_progressing() {
    held_cleanup(false).await;
}

#[tokio::test]
async fn uncertain_pressure_cleanup_retains_its_lease_and_stops_new_selections() {
    held_cleanup(true).await;
}

struct ObservedFile {
    path: PathBuf,
    observed: Arc<tokio::sync::Notify>,
}

impl MemoryObservationSource for ObservedFile {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async {
            let observation = HostMemoryObservation::read_at(&self.path).await;
            self.observed.notify_one();
            observation
        })
    }
}

#[tokio::test]
async fn stale_or_draining_observations_cannot_remove_inventory_after_a_pool_wait() {
    for stale in [false, true] {
        let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
        let path = env._temp_dir.path().join("meminfo");
        available(&path, 0).await;
        let overrides = Arc::new(MockSandboxOverrides::new());
        seed(&config, &overrides, None, Duration::ZERO).await;
        let observed = Arc::new(tokio::sync::Notify::new());
        let mut reclaimer = IdleMemoryReclaimer::new(4096);
        reclaimer.set_source(Arc::new(ObservedFile {
            path,
            observed: observed.clone(),
        }));
        let tracker = IdleDestroyTracker::new(config.shared.reuse_state_notify.clone());
        let (mode, receiver) = tokio::sync::watch::channel(RunnerMode::Running);
        let held = config.shared.idle_pool.lock().await;
        reclaimer.request(
            &config.shared.idle_pool,
            &config.shared.status,
            &tracker,
            &receiver,
        );
        tokio::time::timeout(WAIT, observed.notified())
            .await
            .unwrap();
        if stale {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(20)).await;
            tokio::time::resume();
        } else {
            mode.send_replace(RunnerMode::Draining);
        }
        drop(held);
        tokio::time::timeout(WAIT, reclaimer.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.shared.idle_pool.lock().await.len(), 1);
        assert_eq!(overrides.destroy_call_count(), 0);
        assert!(!reclaimer.can_prepare_blank());
        reclaimer.drain().await.unwrap();
        drain_idle_pool(
            &config.shared.idle_pool,
            &config.shared.status,
            &tracker,
            "fixture_shutdown",
        )
        .await;
        tracker.close_and_wait().await;
        env.shutdown_startup_api().await;
    }
}
