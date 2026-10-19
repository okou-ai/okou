use std::collections::BTreeMap;

use crate::blank_pool::{
    BlankPoolReplenisher, BlankPrepareResult, BlankProfile, GuardedBlankPoolRequest,
};
use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::lifecycle::RunnerMode;

use super::*;

#[tokio::test]
async fn guarded_finish_cancellation_keeps_the_borrowed_incoming_owner_complete() {
    let (mut owner, mut old) = AgedFixture::new().await;
    let source = owner.fixture.gate_observation(1);
    let reservation = owner
        .fixture
        .pool
        .lock()
        .await
        .take_reserved(&old.key)
        .unwrap();
    let (id, blank_exit) = owner.fixture.blank().await;
    let (new_exit, backing) = MockBackingProcess::channel();
    let candidate = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new("finish-incoming-blank").with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(&owner.fixture.budget, 2, 2048).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    let mut incoming = IdlePoolIncoming::park(candidate);
    incoming.capture_backing().unwrap();
    {
        let f = &owner.fixture;
        let finish = owner.replenisher.finish_guarded_preparation(
            &mut incoming,
            GuardedBlankPoolRequest {
                mode: RunnerMode::Running,
                pool: &f.pool,
                budget: &f.budget,
                admission: &owner.admission,
                status: &f.status,
                tracker: &f.tracker,
                operations: &f.operations,
                envelope: envelope(),
            },
        );
        tokio::pin!(finish);
        tokio::select! { () = source.wait_entered() => {}, result = &mut finish => panic!("held finish completed: {result:?}") }
    }
    assert_eq!(incoming.sandbox_id(), Some(id));
    assert_eq!(owner.fixture.budget.allocated(), (6, 6144, 3));
    assert_eq!(
        owner
            .fixture
            .operations
            .snapshot()
            .unwrap()
            .registered_operations,
        0
    );
    old.assert_active_bytes().await;
    old.confirm_exit();
    blank_exit.confirm_exit();
    new_exit.confirm_exit();
    reservation
        .into_destroy_job()
        .run_with_context("fixture_reserved_before_blank_finish")
        .await;
    owner.fixture.recover_incoming(incoming).await;
    owner.fixture.recover().await;
}

#[tokio::test]
async fn guarded_blank_finish_refuses_exact_incoming_without_replacing_either_home_owner() {
    let (mut owner, mut old) = AgedFixture::new().await;
    let (mut incoming, mut new) = owner.fixture.incoming(&old.key).await;
    let f = &owner.fixture;
    let result = owner
        .replenisher
        .finish_guarded_preparation(
            &mut incoming,
            GuardedBlankPoolRequest {
                mode: RunnerMode::Running,
                pool: &f.pool,
                budget: &f.budget,
                admission: &owner.admission,
                status: &f.status,
                tracker: &f.tracker,
                operations: &f.operations,
                envelope: envelope(),
            },
        )
        .await;
    assert!(matches!(
        result,
        Err(MemoryOperationError::OwnershipInvariant)
    ));
    assert_eq!(incoming.sandbox_id(), Some(new.id));
    assert_eq!(f.budget.allocated(), (4, 4096, 2));
    assert_eq!(f.operations.snapshot().unwrap().registered_operations, 0);
    old.assert_active_bytes().await;
    new.assert_active_bytes().await;
    old.confirm_exit();
    new.confirm_exit();
    owner.fixture.recover_incoming(incoming).await;
    owner.fixture.recover().await;
}

struct AgedFixture {
    fixture: BatchFixture,
    replenisher: BlankPoolReplenisher,
    admission: PreSpawnAdmission,
    blank: Arc<MockSandboxOverrides>,
}

impl AgedFixture {
    async fn new() -> (Self, ParkedHome) {
        let mut fixture = BatchFixture::new().await;
        fixture.budget = Arc::new(ResourceBudget::new(16, 16384, 1.0, 0));
        fixture.pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        let (candidate, home) = fixture.candidate("thread:guarded-aged-home", true).await;
        assert!(matches!(
            fixture.pool.lock().await.park_at_for_test(
                candidate,
                std::time::Instant::now() - Duration::from_secs(40 * 60)
            ),
            ParkResult::Parked
        ));
        let blank = Arc::new(MockSandboxOverrides::new());
        let factory: crate::SharedFactory =
            Arc::new(Box::new(MockSandboxFactory::with_overrides(blank.clone())));
        let profiles = BTreeMap::from([(
            "vm0/default".into(),
            BlankProfile {
                vcpu: 2,
                memory_mb: 2048,
                rootfs_hash: "test-rootfs".into(),
                home_disk_mb: 10240,
            },
        )]);
        let factories = BTreeMap::from([("vm0/default".into(), (factory, true))]);
        let replenisher =
            BlankPoolReplenisher::new(&profiles, &factories, &fixture.budget, 1, None);
        (
            Self {
                fixture,
                replenisher,
                admission: PreSpawnAdmission::new(2).unwrap(),
                blank,
            },
            home,
        )
    }

    async fn start(&mut self) {
        let f = &self.fixture;
        self.replenisher
            .maybe_start_guarded(GuardedBlankPoolRequest {
                mode: RunnerMode::Running,
                pool: &f.pool,
                budget: &f.budget,
                admission: &self.admission,
                status: &f.status,
                tracker: &f.tracker,
                operations: &f.operations,
                envelope: envelope(),
            })
            .await;
        assert!(self.replenisher.is_preparing());
    }

    async fn finish(&mut self) -> BlankPrepareResult {
        tokio::time::timeout(WAIT, self.replenisher.wait_for_preparation())
            .await
            .unwrap()
            .unwrap()
    }
}

#[tokio::test]
async fn guarded_aged_conversion_saves_required_home_before_creating_a_blank() {
    let (mut owner, mut home) = AgedFixture::new().await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    owner.start().await;
    kill.wait_entered(1, WAIT).await.unwrap();
    assert!(owner.fixture.pool.lock().await.is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert!(owner.blank.create_configs().is_empty());
    home.confirm_exit();
    kill.release_one();
    let BlankPrepareResult::Ready {
        candidate,
        retired_exact,
    } = owner.finish().await
    else {
        panic!("blank preparation failed")
    };
    assert!(retired_exact);
    assert_eq!(owner.blank.create_configs().len(), 1);
    home.assert_cached_bytes().await;
    // Dispose only this fixture's new caller-owned candidate after assertions.
    let incoming = IdlePoolIncoming::park(*candidate);
    owner.fixture.recover_incoming(incoming).await;
    owner.fixture.recover().await;
}

#[tokio::test]
async fn guarded_aged_headroom_refusal_preserves_inventory_promotion_and_lease() {
    let (mut owner, mut home) = AgedFixture::new().await;
    tokio::fs::write(&owner.fixture.meminfo, "MemAvailable: 9216 kB\n")
        .await
        .unwrap();
    let revision = owner.fixture.pool.lock().await.revision();
    owner.start().await;
    assert!(matches!(
        owner.finish().await,
        BlankPrepareResult::Failed(_)
    ));
    assert_eq!(owner.fixture.pool.lock().await.revision(), revision);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.kill_call_count(), 0);
    assert!(owner.blank.create_configs().is_empty());
    home.assert_active_bytes().await;
    assert_eq!(
        owner
            .fixture
            .operations
            .snapshot()
            .unwrap()
            .registered_operations,
        0
    );
    home.confirm_exit();
    owner.fixture.recover().await;
}

#[tokio::test]
async fn guarded_aged_grant_wait_is_independent_and_foreground_preemption_leaves_original_pool_owner()
 {
    let (mut owner, mut home) = AgedFixture::new().await;
    let source = owner.fixture.gate_observation(1);
    tokio::time::timeout(WAIT, owner.start()).await.unwrap();
    source.wait_entered().await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let foreground = tokio::time::timeout(WAIT, owner.admission.acquire(2, &cancel))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        owner.finish().await,
        BlankPrepareResult::Failed(_)
    ));
    assert_eq!(
        owner
            .fixture
            .pool
            .lock()
            .await
            .status_snapshot()
            .idle_sandboxes[0]
            .sandbox_id,
        home.id
    );
    assert_eq!(home.overrides.kill_call_count(), 0);
    assert!(owner.blank.create_configs().is_empty());
    home.assert_active_bytes().await;
    assert_eq!(
        owner
            .fixture
            .operations
            .snapshot()
            .unwrap()
            .registered_operations,
        0
    );
    drop(foreground);
    home.confirm_exit();
    owner.fixture.recover().await;
}

#[tokio::test]
async fn guarded_aged_rechecks_target_or_original_repark_after_grant_wait() {
    for replace_with_blank in [false, true] {
        let (mut owner, mut home) = AgedFixture::new().await;
        let source = owner.fixture.gate_observation(0);
        owner.start().await;
        source.wait_entered().await;
        let mut reservation = Some(
            owner
                .fixture
                .pool
                .lock()
                .await
                .take_reserved(&home.key)
                .unwrap(),
        );
        let blank = if replace_with_blank {
            Some(owner.fixture.blank().await)
        } else {
            assert!(matches!(
                owner
                    .fixture
                    .pool
                    .lock()
                    .await
                    .restore_reserved(reservation.take().unwrap()),
                RestoreReservedIdleResult::Restored
            ));
            None
        };
        source.release.notify_one();
        assert!(matches!(
            owner.finish().await,
            BlankPrepareResult::Failed(_)
        ));
        assert_eq!(home.overrides.kill_call_count(), 0);
        assert!(owner.blank.create_configs().is_empty());
        home.assert_active_bytes().await;
        home.confirm_exit();
        if let Some((_, exit)) = blank {
            exit.confirm_exit();
            reservation
                .take()
                .unwrap()
                .into_destroy_job()
                .run_with_context("fixture_aged_reservation")
                .await;
        }
        owner.fixture.recover().await;
    }
}

#[tokio::test]
async fn guarded_aged_status_wait_keeps_cleanup_owned_and_releases_foreground_permit_on_preemption()
{
    let (mut owner, mut home) = AgedFixture::new().await;
    let status = owner.fixture.status.clone();
    let held = status.hold_state_for_test().await;
    let kill = MockLifecycleGate::new();
    home.overrides.set_kill_lifecycle_gate(kill.clone());
    owner.start().await;
    kill.wait_entered(1, WAIT).await.unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let foreground = tokio::time::timeout(WAIT, owner.admission.acquire(2, &cancel))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert!(ResourceBudget::try_reserve_lease(&owner.fixture.budget, 16, 16384).is_none());
    assert!(owner.fixture.operations.snapshot().unwrap().started > 0);
    let tracker = owner.fixture.tracker.clone();
    let shutdown = tracker.close_and_wait();
    tokio::pin!(shutdown);
    assert!(futures_util::poll!(&mut shutdown).is_pending());
    home.confirm_exit();
    kill.release_one();
    let foreground_budget = tokio::time::timeout(
        WAIT,
        ResourceBudget::substitute_leases_when_available(
            &owner.fixture.budget,
            &mut Vec::new(),
            16,
            16384,
        ),
    )
    .await
    .unwrap();
    tokio::time::timeout(WAIT, shutdown).await.unwrap();
    assert!(owner.blank.create_configs().is_empty());
    drop(held);
    assert!(matches!(
        owner.finish().await,
        BlankPrepareResult::Failed(_)
    ));
    home.assert_cached_bytes().await;
    drop(foreground_budget);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
    drop(foreground);
}

#[tokio::test]
async fn uncertain_aged_provider_cleanup_keeps_physical_coverage_and_never_creates_blank() {
    let (mut owner, mut home) = AgedFixture::new().await;
    home.overrides
        .push_kill_panic("synthetic aged cleanup panic");
    home.confirm_exit();
    owner.start().await;
    assert!(matches!(
        owner.finish().await,
        BlankPrepareResult::Failed(_)
    ));
    assert!(owner.blank.create_configs().is_empty());
    assert!(owner.fixture.operations.snapshot().unwrap().uncertain > 0);
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.destroy_call_count(), 0);
    home.assert_active_bytes().await;
    owner.fixture.recover().await;
}

#[tokio::test]
async fn guarded_aged_publication_refusal_retains_original_home_and_full_lease() {
    let (mut owner, mut home) = AgedFixture::new().await;
    // An infeasible filesystem reserve refuses publication without changing source bytes.
    home.cache
        .set_fs_stats_for_test(runner_lifecycle::home_image_cache::FsStats {
            total_bytes: 1,
            available_bytes: 0,
            ..Default::default()
        });
    home.confirm_exit();
    owner.start().await;
    assert!(matches!(
        owner.finish().await,
        BlankPrepareResult::Failed(_)
    ));
    assert!(owner.blank.create_configs().is_empty());
    assert_eq!(owner.fixture.budget.allocated(), (2, 2048, 1));
    assert_eq!(home.overrides.destroy_call_count(), 0);
    home.assert_active_bytes().await;
    owner.fixture.tracker.close_and_wait().await;
    assert_eq!(
        owner
            .fixture
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .uncertain,
        1
    );
    let retained = owner
        .fixture
        .tracker
        .take_retained_activation_owners()
        .unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].sandbox_id(), home.id);
    assert!(!retained[0].cleanup_completed());
    drop(retained);
    assert_eq!(owner.fixture.budget.allocated(), (0, 0, 0));
}
