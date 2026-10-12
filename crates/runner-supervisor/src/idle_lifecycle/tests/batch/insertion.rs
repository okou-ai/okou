use runner_lifecycle::idle_pool::{IdlePoolIncoming, IdlePoolIncomingOwner};

use super::*;

mod admission;
mod aged;
mod ownership;

fn envelope() -> IdleRetirementEnvelope {
    IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    }
}

impl BatchFixture {
    async fn incoming(&self, key: &str) -> (IdlePoolIncoming, ParkedHome) {
        let (candidate, home) = self.candidate(key, true).await;
        let mut incoming = IdlePoolIncoming::park(candidate);
        incoming.capture_backing().unwrap();
        (incoming, home)
    }

    async fn insert(
        &self,
        incoming: &mut IdlePoolIncoming,
    ) -> Result<IdlePoolInsertionResult, MemoryOperationError> {
        self.tracker
            .insert_pool_entry(
                &self.pool,
                incoming,
                &self.operations,
                envelope(),
                "test_guarded_insertion",
            )
            .await
    }

    async fn recover_incoming(&self, incoming: IdlePoolIncoming) {
        let job = match incoming.into_owner().unwrap() {
            IdlePoolIncomingOwner::Parked(candidate) => {
                let mut owned = IdlePool::new(IdlePoolConfig { max_idle: 0 });
                assert!(matches!(owned.park(candidate), ParkResult::Parked));
                owned.drain().pop().unwrap()
            }
            IdlePoolIncomingOwner::Reserved(reservation) => reservation.into_destroy_job(),
        };
        job.run_with_context("fixture_incoming_disposal").await;
    }

    async fn blank(&self) -> (SandboxId, MockBackingProcessCompletion) {
        let id = SandboxId::new_v4();
        let (exit, backing) = MockBackingProcess::channel();
        let mut candidate = ParkedIdleCandidate::blank(
            Box::new(MockSandbox::new(id.to_string()).with_backing_process(backing)),
            Arc::new(Box::new(MockSandboxFactory::new())),
            ResourceBudget::try_reserve_lease(&self.budget, 2, 2048).unwrap(),
            id,
            "vm0/default".into(),
            "test-rootfs".into(),
            None,
        );
        candidate.capture_retirement_backing().unwrap();
        assert!(matches!(
            self.pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        (id, exit)
    }
}

async fn complete(task: &mut GuardedIdleCleanupTask) -> RetainedIdleDestroyResult {
    tokio::time::timeout(WAIT, task.join())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn same_key_replacement_preserves_incoming_and_saves_the_original_complete_home() {
    let fixture = BatchFixture::new().await;
    let mut old = fixture.park("thread:atomic-incoming", true).await;
    let (mut incoming, mut new) = fixture.incoming(&old.key).await;
    let mut started = fixture.insert(&mut incoming).await.unwrap();
    assert!(incoming.into_owner().is_none());
    assert_eq!(started.snapshot.idle_sandboxes[0].sandbox_id, new.id);
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    new.assert_active_bytes().await;
    old.confirm_exit();
    let result = complete(started.retirement.as_mut().unwrap()).await;
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(result.home_cache_promoted);
    old.assert_cached_bytes().await;
    drop(result);
    assert_eq!(fixture.budget.allocated(), (2, 2048, 1));
    new.confirm_exit();
    fixture.recover().await;
    new.assert_cached_bytes().await;
}

#[tokio::test]
async fn exact_incoming_displaces_oldest_blank_at_capacity_but_blank_does_not_displace_exact() {
    let mut fixture = BatchFixture::new().await;
    fixture.pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let (blank_id, exit) = fixture.blank().await;
    let (mut incoming, mut home) = fixture.incoming("thread:exact-over-blank").await;
    let mut result = fixture.insert(&mut incoming).await.unwrap();
    assert!(result.snapshot.blank_sandboxes.is_empty());
    assert_ne!(home.id, blank_id);
    assert_eq!(result.snapshot.idle_sandboxes[0].sandbox_id, home.id);
    exit.confirm_exit();
    drop(complete(result.retirement.as_mut().unwrap()).await);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn blank_incoming_at_capacity_cannot_displace_an_exact_owner() {
    let mut fixture = BatchFixture::new().await;
    fixture.pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let mut home = fixture.park("thread:no-blank-displacement", true).await;
    let id = SandboxId::new_v4();
    let (exit, backing) = MockBackingProcess::channel();
    let candidate = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new(id.to_string()).with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        ResourceBudget::try_reserve_lease(&fixture.budget, 2, 2048).unwrap(),
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    let mut incoming = IdlePoolIncoming::park(candidate);
    incoming.capture_backing().unwrap();
    let revision = fixture.pool.lock().await.revision();
    assert!(matches!(
        fixture.insert(&mut incoming).await,
        Err(MemoryOperationError::ResourceChanged)
    ));
    assert_eq!(incoming.sandbox_id(), Some(id));
    assert_eq!(fixture.pool.lock().await.revision(), revision);
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    home.assert_active_bytes().await;
    assert_eq!(home.overrides.kill_call_count(), 0);
    exit.confirm_exit();
    home.confirm_exit();
    fixture.recover_incoming(incoming).await;
    fixture.recover().await;
}

#[tokio::test]
async fn insertion_without_a_victim_requires_backing_but_registers_no_physical_cleanup() {
    let fixture = BatchFixture::new().await;
    let (candidate, mut home) = fixture.candidate("thread:direct-incoming", false).await;
    let mut incoming = IdlePoolIncoming::park(candidate);
    assert!(matches!(
        fixture.insert(&mut incoming).await,
        Err(MemoryOperationError::MissingBacking)
    ));
    assert_eq!(incoming.sandbox_id(), Some(home.id));
    assert!(fixture.pool.lock().await.is_empty());
    incoming.capture_backing().unwrap();
    let result = fixture.insert(&mut incoming).await.unwrap();
    assert!(result.retirement.is_none());
    assert_eq!(
        fixture.operations.snapshot().unwrap().registered_operations,
        0
    );
    assert_eq!(result.snapshot.idle_sandboxes[0].sandbox_id, home.id);
    home.assert_active_bytes().await;
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn restore_at_capacity_retires_blank_and_preserves_original_exact_owner() {
    let mut fixture = BatchFixture::new().await;
    fixture.pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let mut home = fixture.park("thread:reserved-exact", true).await;
    let reservation = fixture.pool.lock().await.take_reserved(&home.key).unwrap();
    let (blank_id, exit) = fixture.blank().await;
    let mut incoming = match IdlePoolIncoming::restore(reservation) {
        Ok(incoming) => incoming,
        Err(_) => panic!("parked reservation rejected"),
    };
    incoming.capture_backing().unwrap();
    let mut result = fixture.insert(&mut incoming).await.unwrap();
    assert!(result.snapshot.blank_sandboxes.is_empty());
    assert_eq!(result.snapshot.idle_sandboxes[0].sandbox_id, home.id);
    assert_ne!(home.id, blank_id);
    home.assert_active_bytes().await;
    exit.confirm_exit();
    drop(complete(result.retirement.as_mut().unwrap()).await);
    home.confirm_exit();
    fixture.recover().await;
}

#[tokio::test]
async fn restore_never_replaces_same_identity_and_returns_original_reservation_unchanged() {
    let fixture = BatchFixture::new().await;
    let mut old = fixture.park("thread:restore-no-replace", true).await;
    let reservation = fixture.pool.lock().await.take_reserved(&old.key).unwrap();
    let mut new = fixture.park(&old.key, true).await;
    let mut incoming = match IdlePoolIncoming::restore(reservation) {
        Ok(incoming) => incoming,
        Err(_) => panic!("parked reservation rejected"),
    };
    incoming.capture_backing().unwrap();
    let revision = fixture.pool.lock().await.revision();
    assert!(matches!(
        fixture.insert(&mut incoming).await,
        Err(MemoryOperationError::ResourceChanged)
    ));
    assert_eq!(incoming.sandbox_id(), Some(old.id));
    old.assert_active_bytes().await;
    assert_eq!(fixture.budget.allocated(), (4, 4096, 2));
    let Some(IdlePoolIncomingOwner::Reserved(reservation)) = incoming.into_owner() else {
        panic!("restore lost its owner kind")
    };
    assert_eq!(fixture.pool.lock().await.revision(), revision);
    old.confirm_exit();
    reservation
        .into_destroy_job()
        .run_with_context("fixture_refused_restore")
        .await;
    new.confirm_exit();
    fixture.recover().await;
}
