//! Real guarded logical owner coverage, sharing the canonical file/home fixture.

use runner_lifecycle::host_memory_operations::MemoryOperationPlan;
use sandbox::Sandbox;

use super::*;

mod admission;
mod ownership;

impl BatchFixture {
    pub(super) async fn logical(&self, vcpu: u32, memory_mb: u32) -> GuardedIdlePressureResult {
        self.logical_request(IdlePressureRequest {
            run_id: RunId::new_v4(),
            reuse_key: None,
            profile_name: "vm0/default",
            device_rate_limits: &None,
            allow_compatible_blank: false,
            blank_pool_diagnostics: None,
            vcpu,
            memory_mb,
            context: "test_guarded_logical_pressure",
        })
        .await
    }

    async fn logical_request(
        &self,
        selection: IdlePressureRequest<'_>,
    ) -> GuardedIdlePressureResult {
        select_idle_entries_for_guarded_pressure(
            &self.pool,
            &self.status,
            &self.tracker,
            &self.budget,
            &self.operations,
            Vec::new(),
            GuardedIdlePressureRequest {
                selection,
                envelope: IdleRetirementEnvelope {
                    live_growth_bytes: 8 * MIB,
                    tail_growth_bytes: MIB,
                },
            },
        )
        .await
    }
}

async fn finish_retirements(result: &mut GuardedIdlePressureResult) {
    for task in &mut result.retirements {
        let outcome = tokio::time::timeout(WAIT, task.join())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(outcome.outcome, DestroyOutcome::Completed);
    }
}

fn fresh(result: &mut GuardedIdlePressureResult) -> BudgetLease {
    let IdlePressureSelection::Fresh(lease) = std::mem::replace(
        &mut result.selection,
        IdlePressureSelection::Exhausted(Vec::new()),
    ) else {
        panic!("guarded selector did not transfer fitting capacity");
    };
    lease
}

#[tokio::test]
async fn full_profile_multi_victim_transfer_keeps_old_and_new_physical_growth_covered() {
    let mut fixture = BatchFixture::new().await;
    let mut bounds = policy();
    bounds.bounds.host_total_bytes = 64 * 1024 * MIB;
    tokio::fs::write(&fixture.meminfo, "MemAvailable: 67108864 kB\n")
        .await
        .unwrap();
    fixture.operations =
        HostMemoryOperations::new(bounds, Arc::new(FileSource(fixture.meminfo.clone()))).unwrap();
    let mut first = fixture.park("thread:logical-first", true).await;
    let mut second = fixture.park("thread:logical-second", true).await;
    let mut spare = fixture.park("thread:logical-spare", true).await;
    let kill = MockLifecycleGate::new();
    first.overrides.set_kill_lifecycle_gate(kill.clone());
    second.overrides.set_kill_lifecycle_gate(kill.clone());
    let mut result = tokio::time::timeout(WAIT, fixture.logical(4, 4096))
        .await
        .unwrap();
    let lease = fresh(&mut result);
    assert_eq!((lease.vcpu(), lease.memory_mb()), (4, 4096));
    assert_eq!(fixture.budget.allocated(), (6, 6144, 2));
    assert_eq!(result.retirements.len(), 2);
    assert!(result.not_started.is_empty());
    assert!(result.status_error.is_none());
    kill.wait_entered(2, WAIT).await.unwrap();
    let snapshot = fixture.pool.lock().await.status_snapshot();
    assert_eq!(snapshot.idle_sandboxes.len(), 1);
    assert_eq!(snapshot.idle_sandboxes[0].sandbox_id, spare.id);
    assert_eq!(spare.overrides.kill_call_count(), 0);
    spare.assert_active_bytes().await;

    // A real new preparation owner progresses while both old backings lack exit proof.
    let mut request = fixture
        .operations
        .request(MemoryOperationPlan::Fresh {
            memory_mib: 4096,
            preparation_bytes: MIB,
        })
        .unwrap();
    let permit = request.try_grant().await.unwrap();
    let ready = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let entered = ready.clone();
    let resume = release.clone();
    let (new_exit, new_backing) = MockBackingProcess::channel();
    let task = permit
        .spawn(move |mut operation| async move {
            let mut sandbox =
                MockSandbox::new("new-covered-foreground").with_backing_process(new_backing);
            operation
                .bind_backing(sandbox.backing_process().unwrap())
                .unwrap();
            sandbox.start().await.unwrap();
            entered.notify_one();
            resume.notified().await;
            operation.complete_phase().await.unwrap();
        })
        .unwrap();
    tokio::time::timeout(WAIT, ready.notified()).await.unwrap();
    let physical = fixture.operations.snapshot().unwrap();
    assert_eq!(physical.ordinary_growth_bytes, 4097 * MIB);
    assert_eq!(physical.cleanup_growth_bytes, 18 * MIB);
    assert_eq!(physical.started, 5);
    // Logical release and persisted pool removal do not reduce physical coverage.
    drop(lease);
    assert_eq!(
        fixture.operations.snapshot().unwrap().cleanup_growth_bytes,
        18 * MIB
    );
    tokio::fs::write(&fixture.meminfo, "MemAvailable: 8192 kB\n")
        .await
        .unwrap();
    let mut forbidden = fixture
        .operations
        .request(MemoryOperationPlan::HostIo { growth_bytes: MIB })
        .unwrap();
    assert!(matches!(
        forbidden.try_grant().await,
        Err(MemoryOperationError::InsufficientHeadroom { .. })
    ));
    drop(forbidden);
    tokio::fs::write(&fixture.meminfo, "MemAvailable: 67108864 kB\n")
        .await
        .unwrap();
    release.notify_one();
    task.join().await.unwrap();
    new_exit.confirm_exit();
    first.confirm_exit();
    second.confirm_exit();
    kill.release_one();
    kill.release_one();
    finish_retirements(&mut result).await;
    first.assert_cached_bytes().await;
    second.assert_cached_bytes().await;
    spare.confirm_exit();
    fixture.recover().await;
    assert_eq!(
        fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
}
