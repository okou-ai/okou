use std::process::Stdio;

use runner_lifecycle::host_memory_operations::MemoryOperationPlan;
use tokio::io::AsyncWriteExt;

use super::*;

mod accepted_reads;

#[tokio::test]
async fn job_free_physical_pressure_retires_while_logical_capacity_is_free() {
    let fixture = fixture(24).await;
    let mut home = fixture.park("thread:no-job-pressure", true).await;
    home.confirm_exit();
    let fitting = ResourceBudget::try_reserve_lease(&fixture.budget, 6, 6144).unwrap();
    drop(fitting);
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    snapshot(&mut updates, |state| {
        state
            .last_wave
            .as_ref()
            .is_some_and(|report| report.completed == 1)
    })
    .await;
    let stopped = owner.shutdown().await.unwrap();
    assert!(stopped.stopped);
    assert!(!stopped.decision.wave_inflight);
    fixture.tracker.close_and_wait().await;
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    home.assert_cached_bytes().await;
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn ample_ram_with_logical_exhaustion_and_unknown_reads_never_retires() {
    let fixture = fixture(64).await;
    let mut home = fixture.park("thread:logical-only-pressure", true).await;
    let full = ResourceBudget::try_reserve_lease(&fixture.budget, 6, 6144).unwrap();
    assert!(ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).is_none());
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    snapshot(&mut updates, |state| {
        state.decision.state == HostPressureState::Ready
    })
    .await;
    tokio::fs::write(&fixture.meminfo, b"not a meminfo sample\n")
        .await
        .unwrap();
    let unknown = snapshot(&mut updates, |state| {
        state.decision.state == HostPressureState::Unknown
    })
    .await;
    assert!(unknown.last_wave.is_none());
    owner.shutdown().await.unwrap();
    assert_eq!(home.overrides.kill_call_count(), 0);
    assert_eq!(fixture.budget.allocated(), (8, 8192, 2));
    home.assert_active_bytes().await;
    drop(full);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn completed_pressure_victim_releases_its_full_lease_while_another_tail_is_held() {
    let fixture = fixture(24).await;
    let mut completed = fixture.park("thread:completed-pressure-victim", true).await;
    let mut held = fixture.park("thread:held-pressure-victim", true).await;
    completed.confirm_exit();
    held.confirm_exit();
    let destroy = MockLifecycleGate::new();
    let kill = MockLifecycleGate::new();
    completed
        .overrides
        .set_destroy_lifecycle_gate(destroy.clone());
    held.overrides.set_kill_lifecycle_gate(kill.clone());
    let owner = IdlePressureOwner::spawn(config(&fixture, 2)).unwrap();
    let mut updates = owner.subscribe();
    destroy.wait_entered(1, WAIT).await.unwrap();
    kill.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    assert!(ResourceBudget::try_reserve_lease(&fixture.budget, 6, 6144).is_none());
    destroy.release_one();
    let mut leases = Vec::new();
    let fitting = tokio::time::timeout(
        WAIT,
        ResourceBudget::substitute_leases_when_available(&fixture.budget, &mut leases, 6, 6144),
    )
    .await
    .unwrap();
    assert_eq!(fixture.budget.allocated(), (8, 8192, 2));
    completed.assert_cached_bytes().await;
    held.assert_active_bytes().await;
    drop(fitting);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    let pending = updates.borrow_and_update().clone();
    assert!(pending.decision.wave_inflight);
    assert!(pending.last_wave.is_none());
    let stopping = owner.shutdown();
    tokio::pin!(stopping);
    assert!(futures_util::poll!(stopping.as_mut()).is_pending());
    kill.release_one();
    let stopped = tokio::time::timeout(WAIT, stopping).await.unwrap().unwrap();
    let report = stopped.last_wave.unwrap();
    assert!(report.is_resolved());
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (2, 2, 0)
    );
    fixture.tracker.close_and_wait().await;
    held.assert_cached_bytes().await;
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn owned_child_exit_and_held_tail_keep_sampling_fitting_work_and_shutdown_independent() {
    let fixture = fixture(24).await;
    let mut home = fixture.park("thread:owned-child-pressure", true).await;
    let completion = home.exit.take().unwrap();
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "read gate; exit 7"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let child_wait = tokio::spawn(async move {
        assert_eq!(child.wait().await.unwrap().code(), Some(7));
        completion.confirm_exit();
    });
    let kill = MockLifecycleGate::new();
    let destroy = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    home.overrides.set_destroy_lifecycle_gate(destroy.clone());
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    kill.wait_entered(1, WAIT).await.unwrap();
    input.write_all(b"exit\n").await.unwrap();
    child_wait.await.unwrap();
    started(&fixture, 1).await;
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        MIB
    );
    available_bytes(&fixture, 64).await;
    let observed = snapshot(&mut updates, |state| {
        state.decision.available_bytes == Some(64 * MIB)
    })
    .await;
    assert!(observed.decision.wave_inflight);
    assert!(observed.last_wave.is_none());
    let fitting = fixture
        .operations
        .request(MemoryOperationPlan::Fresh {
            memory_mib: 1,
            preparation_bytes: 0,
        })
        .unwrap()
        .try_grant()
        .await
        .unwrap();
    drop(fitting);
    let stopped = owner.shutdown();
    let joined = fixture.tracker.close_and_wait();
    tokio::pin!(stopped, joined);
    assert!(futures_util::poll!(stopped.as_mut()).is_pending());
    assert!(futures_util::poll!(joined.as_mut()).is_pending());
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    kill.release_one();
    destroy.wait_entered(1, WAIT).await.unwrap();
    assert!(futures_util::poll!(stopped.as_mut()).is_pending());
    destroy.release_one();
    assert!(
        tokio::time::timeout(WAIT, stopped)
            .await
            .unwrap()
            .unwrap()
            .last_wave
            .unwrap()
            .is_resolved()
    );
    tokio::time::timeout(WAIT, joined).await.unwrap();
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    home.assert_cached_bytes().await;
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn uncertain_settlement_retains_wave_custody_and_original_full_lease_after_shutdown() {
    let fixture = fixture(24).await;
    let mut home = fixture.park("thread:uncertain-pressure", true).await;
    home.confirm_exit();
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    kill.wait_entered(1, WAIT).await.unwrap();
    started(&fixture, 1).await;
    tokio::fs::write(&fixture.meminfo, b"lost fresh settlement observation\n")
        .await
        .unwrap();
    kill.release_one();
    let uncertain = snapshot(&mut updates, |state| {
        state
            .last_wave
            .as_ref()
            .is_some_and(|report| report.uncertain == 1)
    })
    .await;
    assert!(uncertain.decision.wave_inflight);
    assert!(!uncertain.last_wave.unwrap().is_resolved());
    assert!(owner.shutdown().await.unwrap().decision.wave_inflight);
    fixture.tracker.close_and_wait().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert!(ResourceBudget::try_reserve_lease(&fixture.budget, 8, 8192).is_none());
    let custody = fixture.tracker.take_retained_pressure_owners().unwrap();
    assert_eq!(custody.len(), 1);
    assert!(custody[0].take_completed_lease().is_err());
    let retained = custody[0].take_owner().unwrap();
    assert_eq!(retained.sandbox_id(), home.id);
    assert_eq!(
        retained.state(),
        runner_lifecycle::idle_pool::IdleActivationState::Destroyed
    );
    assert!(!retained.cleanup_completed());
    let physical = fixture.operations.close_and_wait().await.unwrap();
    assert_eq!(
        (physical.uncertain, physical.cleanup_growth_bytes),
        (1, MIB)
    );
    drop(retained); // Explicit fixture reconciliation, never physical relief proof.
    home.assert_cached_bytes().await;
}

#[tokio::test]
async fn required_preparation_failure_keeps_pressure_victim_and_original_home_owned() {
    for phase in ["prepare-for-cache", "--freeze"] {
        let fixture = fixture(24).await;
        let mut home = fixture
            .park("thread:required-pressure-preparation", true)
            .await;
        home.overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
            pattern: phase.into(),
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"required pressure saving refused".to_vec(),
        });
        home.confirm_exit();
        let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
        let mut updates = owner.subscribe();
        let held = snapshot(&mut updates, |state| state.last_wave.is_some()).await;
        let report = held.last_wave.unwrap();
        assert_eq!((report.completed, report.uncertain), (0, 1));
        assert!(!report.is_resolved());
        assert!(owner.shutdown().await.unwrap().decision.wave_inflight);
        fixture.tracker.close_and_wait().await;
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        assert_eq!(home.overrides.kill_call_count(), 0);
        assert_eq!(home.overrides.destroy_call_count(), 0);
        home.assert_active_bytes().await;
        let physical = fixture.operations.close_and_wait().await.unwrap();
        assert_eq!(
            (physical.uncertain, physical.cleanup_growth_bytes),
            (2, 9 * MIB)
        );
        let custody = fixture.tracker.take_retained_pressure_owners().unwrap();
        assert_eq!(custody.len(), 1);
        let retained = custody[0].take_owner().unwrap();
        assert_eq!(retained.sandbox_id(), home.id);
        assert!(!retained.cleanup_completed());
        drop(retained);
    }
}

struct PanicReader;

#[tokio::test]
async fn publication_refusal_retains_pressure_saving_custody_after_exact_exit() {
    let fixture = fixture(24).await;
    let mut home = fixture
        .park("thread:required-pressure-publication", true)
        .await;
    // An infeasible filesystem reserve refuses publication without changing source bytes.
    home.cache
        .set_fs_stats_for_test(runner_lifecycle::home_image_cache::FsStats {
            total_bytes: 1,
            available_bytes: 0,
            ..Default::default()
        });
    home.confirm_exit();
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    let held = snapshot(&mut updates, |state| state.last_wave.is_some()).await;
    let report = held.last_wave.unwrap();
    assert_eq!((report.completed, report.uncertain), (0, 1));
    assert!(!report.is_resolved());
    assert!(held.decision.wave_inflight);
    assert!(owner.shutdown().await.unwrap().decision.wave_inflight);
    fixture.tracker.close_and_wait().await;
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.destroy_call_count(), 0);
    home.assert_active_bytes().await;
    assert_eq!(
        fixture.operations.close_and_wait().await.unwrap().uncertain,
        1
    );
    let custody = fixture.tracker.take_retained_pressure_owners().unwrap();
    assert_eq!(custody.len(), 1);
    let retained = custody[0].take_owner().unwrap();
    assert_eq!(retained.sandbox_id(), home.id);
    assert_eq!(
        retained.state(),
        runner_lifecycle::idle_pool::IdleActivationState::Exited
    );
    drop(retained);
}

#[tokio::test]
async fn dropped_pressure_owner_does_not_abort_accepted_saving_or_release_its_full_lease() {
    let fixture = fixture(24).await;
    let mut home = fixture.park("thread:dropped-pressure-owner", true).await;
    home.confirm_exit();
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    kill.wait_entered(1, WAIT).await.unwrap();
    drop(owner);
    let joined = fixture.tracker.close_and_wait();
    tokio::pin!(joined);
    assert!(futures_util::poll!(joined.as_mut()).is_pending());
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    kill.release_one();
    let stopped = snapshot(&mut updates, |state| state.stopped).await;
    assert!(stopped.last_wave.unwrap().is_resolved());
    tokio::time::timeout(WAIT, joined).await.unwrap();
    home.assert_cached_bytes().await;
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}

#[tokio::test]
async fn stopping_a_recovered_owner_invalidates_optional_readiness() {
    let fixture = fixture(64).await;
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    snapshot(&mut updates, |state| state.decision.optional_start_ready).await;
    owner.stop();
    let stopped = snapshot(&mut updates, |state| state.stopped).await;
    assert_eq!(stopped.decision.state, HostPressureState::Unknown);
    assert!(!stopped.decision.optional_start_ready);
    owner.shutdown().await.unwrap();
    fixture.tracker.close_and_wait().await;
    fixture.operations.close_and_wait().await.unwrap();
}

#[tokio::test]
async fn failed_and_lost_backing_waits_preserve_uncertainty_and_complete_logical_custody() {
    for failed in [false, true] {
        let fixture = fixture(24).await;
        let mut home = fixture.park("thread:lost-pressure-backing", true).await;
        let exit = home.exit.take().unwrap();
        if failed {
            exit.fail_wait();
        } else {
            drop(exit);
        }
        let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
        let mut updates = owner.subscribe();
        let uncertain = snapshot(&mut updates, |state| {
            state
                .last_wave
                .as_ref()
                .is_some_and(|report| report.uncertain == 1)
        })
        .await;
        assert!(uncertain.decision.wave_inflight);
        assert!(owner.shutdown().await.unwrap().decision.wave_inflight);
        fixture.tracker.close_and_wait().await;
        assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
        let physical = fixture.operations.close_and_wait().await.unwrap();
        assert_eq!(
            (physical.uncertain, physical.cleanup_growth_bytes),
            (2, 9 * MIB)
        );
        home.assert_active_bytes().await;
        let custody = fixture.tracker.take_retained_pressure_owners().unwrap();
        assert_eq!(custody.len(), 1);
        drop(custody);
    }
}

struct HeldRead {
    path: PathBuf,
    gate: std::sync::Mutex<Option<(Arc<Notify>, Arc<Notify>)>>,
    calls: AtomicUsize,
}

impl HeldRead {
    fn gate_next(&self) -> (Arc<Notify>, Arc<Notify>) {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        assert!(
            self.gate
                .lock()
                .unwrap()
                .replace((entered.clone(), release.clone()))
                .is_none()
        );
        (entered, release)
    }
}

impl MemoryObservationSource for HeldRead {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.lock().unwrap().take();
            let read = HostMemoryObservation::read_at(&self.path).await;
            if let Some((entered, release)) = gate {
                entered.notify_one();
                release.notified().await;
            }
            read
        })
    }
}

fn held_reader(fixture: &mut BatchFixture) -> Arc<HeldRead> {
    let reader = Arc::new(HeldRead {
        path: fixture.meminfo.clone(),
        gate: std::sync::Mutex::new(None),
        calls: AtomicUsize::new(0),
    });
    fixture.operations = HostMemoryOperations::new(physical_policy(), reader.clone()).unwrap();
    reader
}

#[tokio::test]
async fn a_read_started_before_wave_completion_cannot_offer_another_wave_after_recovery() {
    let mut fixture = fixture(24).await;
    let reader = held_reader(&mut fixture);
    let mut old = fixture.park("thread:pressure-freshness-old", true).await;
    let mut newer = fixture.park("thread:pressure-freshness-new", true).await;
    old.confirm_exit();
    let kill = MockLifecycleGate::new();
    old.overrides.set_kill_lifecycle_gate(kill.clone());
    let mut input = config(&fixture, 1);
    input.policy.wave_cooldown = Duration::from_nanos(1);
    let owner = IdlePressureOwner::spawn(input).unwrap();
    let mut updates = owner.subscribe();
    kill.wait_entered(1, WAIT).await.unwrap();
    started(&fixture, 1).await;
    let (entered, release) = reader.gate_next();
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    available_bytes(&fixture, 64).await;
    kill.release_one();
    snapshot(&mut updates, |state| {
        state
            .last_wave
            .as_ref()
            .is_some_and(|report| report.completed == 1)
    })
    .await;
    release.notify_one();
    let recovered = snapshot(&mut updates, |state| {
        state.decision.state == HostPressureState::Ready
    })
    .await;
    assert_eq!(recovered.last_wave.unwrap().completed, 1);
    assert_eq!(newer.overrides.kill_call_count(), 0);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    newer.assert_active_bytes().await;
    owner.shutdown().await.unwrap();
    old.assert_cached_bytes().await;
    newer.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn shutdown_joins_one_accepted_read_without_replaying_pending_ticks() {
    let mut fixture = fixture(64).await;
    let reader = held_reader(&mut fixture);
    let (entered, release) = reader.gate_next();
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    let stopping = owner.shutdown();
    tokio::pin!(stopping);
    assert!(futures_util::poll!(stopping.as_mut()).is_pending());
    assert_eq!(reader.calls.load(Ordering::SeqCst), 1);
    release.notify_one();
    assert!(
        !tokio::time::timeout(WAIT, stopping)
            .await
            .unwrap()
            .unwrap()
            .decision
            .wave_inflight
    );
    assert_eq!(reader.calls.load(Ordering::SeqCst), 1);
    fixture.tracker.close_and_wait().await;
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .tracked_tasks,
        0
    );
}

impl MemoryObservationSource for PanicReader {
    fn observe(&self) -> BoxFuture<'_, HostMemoryObservation> {
        Box::pin(async { panic!("external reader producer lost") })
    }
}

#[tokio::test]
async fn lost_sampler_invalidates_readiness_and_shutdown_reports_loss_without_cleanup() {
    let mut fixture = fixture(24).await;
    let mut home = fixture.park("thread:lost-pressure-reader", true).await;
    fixture.operations =
        HostMemoryOperations::new(physical_policy(), Arc::new(PanicReader)).unwrap();
    let owner = IdlePressureOwner::spawn(config(&fixture, 1)).unwrap();
    let mut updates = owner.subscribe();
    let lost = snapshot(&mut updates, |state| state.producer_lost).await;
    assert_eq!(lost.decision.state, HostPressureState::Unknown);
    assert!(!lost.decision.wave_ready);
    assert!(lost.last_wave.is_none());
    assert!(owner.shutdown().await.is_err());
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    home.assert_active_bytes().await;
    home.confirm_exit();
    fixture.recover().await;
}
