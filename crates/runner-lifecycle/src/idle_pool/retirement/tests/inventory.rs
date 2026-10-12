use sandbox_mock::{MockBackingProcess, MockLifecycleGate};
use std::sync::atomic::{AtomicU8, Ordering};

use super::*;
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdlePoolRetirement, IdleSandboxIdentity, ParkResult,
    RestoreReservedIdleResult,
};

fn park(fixture: &mut JobFixture, pool: &mut IdlePool) -> IdleSandboxIdentity {
    let mut candidate = fixture.candidate();
    candidate.capture_retirement_backing().unwrap();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    IdleSandboxIdentity::Exact(fixture.reuse_key.clone())
}

fn pending(pool: &IdlePool, identity: &IdleSandboxIdentity, env: &Env) -> IdlePoolRetirement {
    IdlePoolRetirement::new(
        pool.retirement_candidate(identity).unwrap(),
        &env.operations,
        envelope(),
    )
    .unwrap()
}

struct FaultBacking {
    original: sandbox::BackingProcessIdentity,
    replacement: sandbox::BackingProcessIdentity,
    fault: AtomicU8,
}

#[async_trait::async_trait]
impl SandboxBackingProcess for FaultBacking {
    fn identity(&self) -> sandbox::BackingProcessIdentity {
        match self.fault.load(Ordering::SeqCst) {
            1 => panic!("injected provider capture failure"),
            2 => self.replacement,
            _ => self.original,
        }
    }

    async fn exit_confirmed(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn failed_recapture_or_changed_provider_proof_cannot_start_pool_cleanup() {
    for changed_after_registration in [false, true] {
        let env = Env::new(64).await;
        let backing = Arc::new(FaultBacking {
            original: sandbox::BackingProcessIdentity::new_generation(),
            replacement: sandbox::BackingProcessIdentity::new_generation(),
            fault: AtomicU8::new(0),
        });
        let mut fixture = JobFixture::new("thread:pool-backing-fault", Some(backing.clone())).await;
        let mut candidate = fixture.candidate();
        candidate.capture_retirement_backing().unwrap();
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let identity = IdleSandboxIdentity::Exact(fixture.reuse_key.clone());
        if changed_after_registration {
            assert!(matches!(pool.park(candidate), ParkResult::Parked));
            let mut retirement = pending(&pool, &identity, &env);
            backing.fault.store(2, Ordering::SeqCst);
            assert_eq!(
                retirement.try_grant().await,
                Err(MemoryOperationError::OwnershipInvariant)
            );
            assert_eq!(
                retirement
                    .start(&mut pool, "must_not_start_changed_backing")
                    .err()
                    .unwrap()
                    .into_error(),
                MemoryOperationError::Consumed
            );
        } else {
            backing.fault.store(1, Ordering::SeqCst);
            assert_eq!(
                candidate.capture_retirement_backing(),
                Err(MemoryOperationError::ProducerLost)
            );
            assert!(matches!(pool.park(candidate), ParkResult::Parked));
            assert!(matches!(
                pool.retirement_candidate(&identity),
                Err(MemoryOperationError::MissingBacking)
            ));
        }
        fixture.untouched().await;
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
        backing.fault.store(0, Ordering::SeqCst);
        pool.drain()
            .pop()
            .unwrap()
            .run_with_context("fixture_backing_fault_recovery")
            .await;
    }
}

#[tokio::test]
async fn duplicate_ready_claim_cannot_retire_an_already_accepted_insertion_twice() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:pool-duplicate", Some(backing)).await;
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let identity = park(&mut fixture, &mut pool);
    let mut first = pending(&pool, &identity, &env);
    let mut second = pending(&pool, &identity, &env);
    first.try_grant().await.unwrap();
    second.try_grant().await.unwrap();
    exit.confirm_exit();
    let task = first.start(&mut pool, "fixture_first_pool_claim").unwrap();
    assert_eq!(
        second
            .start(&mut pool, "must_not_retire_twice")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::ResourceChanged
    );
    let result = task.join().await.unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    drop(result.budget_lease);
    fixture.saved().await;
    assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn replacement_under_the_same_reuse_key_preserves_the_new_owner_and_both_home_images() {
    let env = Env::new(64).await;
    let (old_exit, old_backing) = MockBackingProcess::channel();
    let (new_exit, new_backing) = MockBackingProcess::channel();
    let mut old = JobFixture::new("thread:pool-replacement", Some(old_backing)).await;
    let mut new = JobFixture::new("thread:pool-replacement", Some(new_backing)).await;
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let identity = park(&mut old, &mut pool);
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    let mut replacement = new.candidate();
    replacement.capture_retirement_backing().unwrap();
    let ParkResult::Replaced(displaced) = pool.park(replacement) else {
        panic!("must replace the original parked entry");
    };
    old_exit.confirm_exit();
    displaced
        .run_with_context("fixture_explicit_displaced_recovery")
        .await;
    old.saved().await;
    assert_eq!(
        retirement
            .start(&mut pool, "must_not_retire_replacement")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::ResourceChanged
    );
    new.untouched().await;
    let mut fresh = pending(&pool, &identity, &env);
    fresh.try_grant().await.unwrap();
    new_exit.confirm_exit();
    let result = fresh
        .start(&mut pool, "fixture_replacement_owner")
        .unwrap()
        .join()
        .await
        .unwrap();
    drop(result.budget_lease);
    new.saved().await;
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
}

#[tokio::test]
async fn blank_entry_rejection_restores_its_original_claim_and_final_acceptance_releases_lease() {
    use crate::idle_pool::ParkedIdleCandidate;
    let env = Env::new(64).await;
    let budget = Arc::new(ResourceBudget::new(2, 8, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 8).unwrap();
    let id = sandbox::SandboxId::new_v4();
    let (exit, backing) = MockBackingProcess::channel();
    let mut candidate = ParkedIdleCandidate::blank(
        Box::new(MockSandbox::new(id.to_string()).with_backing_process(backing)),
        Arc::new(Box::new(MockSandboxFactory::new())),
        lease,
        id,
        "vm0/default".into(),
        "test-rootfs".into(),
        None,
    );
    candidate.capture_retirement_backing().unwrap();
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let identity = IdleSandboxIdentity::Blank(id);
    let original = pool.retirement_candidate(&identity).unwrap();
    let mut retirement = pending(&pool, &identity, &env);
    retirement.try_grant().await.unwrap();
    env.operations.close_and_wait().await.unwrap();
    let revision = pool.status_snapshot().revision;
    assert_eq!(
        retirement
            .start(&mut pool, "closed_blank_start")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::Closed
    );
    assert_eq!(pool.status_snapshot().revision, revision);
    assert_eq!(budget.allocated(), (2, 8, 1));
    let fresh_env = Env::new(64).await;
    let mut retry = IdlePoolRetirement::new(original, &fresh_env.operations, envelope()).unwrap();
    retry.try_grant().await.unwrap();
    exit.confirm_exit();
    let result = retry
        .start(&mut pool, "fixture_blank_owner")
        .unwrap()
        .join()
        .await
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    assert!(!result.home_cache_promoted);
    drop(result.budget_lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(pool.status_snapshot().blank_sandboxes.is_empty());
}

#[tokio::test]
async fn invalid_or_partial_registration_and_ungranted_start_preserve_pool_resources() {
    for case in 0..4 {
        let env = Env::with_policy(
            64,
            MemoryOperationPolicy {
                max_operations: if case == 2 { 1 } else { 16 },
                max_cleanup_inflight: if case == 2 { 1 } else { 4 },
                ..policy()
            },
        )
        .await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:pool-registration", Some(backing)).await;
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let identity = park(&mut fixture, &mut pool);
        let revision = pool.status_snapshot().revision;
        let mut bounds = envelope();
        if case == 0 {
            bounds.live_growth_bytes = 0;
        }
        if case == 1 {
            bounds.tail_growth_bytes = 0;
        }
        let admission = IdlePoolRetirement::new(
            pool.retirement_candidate(&identity).unwrap(),
            &env.operations,
            bounds,
        );
        if case == 3 {
            assert_eq!(
                admission
                    .unwrap()
                    .start(&mut pool, "ungranted_pool_start")
                    .err()
                    .unwrap()
                    .into_error(),
                MemoryOperationError::Consumed
            );
        } else {
            assert!(matches!(
                admission,
                Err(MemoryOperationError::UnsupportedGrowth | MemoryOperationError::OperationLimit)
            ));
        }
        assert_eq!(pool.status_snapshot().revision, revision);
        assert!(pool.retirement_candidate(&identity).is_ok());
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
        fixture.untouched().await;
        exit.confirm_exit();
        pool.drain()
            .pop()
            .unwrap()
            .run_with_context("fixture_pool_registration_recovery")
            .await;
    }
}

#[test]
fn no_runtime_start_restores_the_original_public_claim_before_returning() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (env, fixture, mut pool, identity, original, retirement, exit) = runtime.block_on(async {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:pool-no-runtime", Some(backing)).await;
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let identity = park(&mut fixture, &mut pool);
        let original = pool.retirement_candidate(&identity).unwrap();
        let mut retirement = pending(&pool, &identity, &env);
        retirement.try_grant().await.unwrap();
        (env, fixture, pool, identity, original, retirement, exit)
    });
    let revision = pool.status_snapshot().revision;
    assert_eq!(
        retirement
            .start(&mut pool, "no_runtime_pool_start")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::NoRuntime
    );
    assert_eq!(pool.status_snapshot().revision, revision);
    assert!(pool.retirement_candidate(&identity).is_ok());
    runtime.block_on(async {
        fixture.untouched().await;
        let mut retry = IdlePoolRetirement::new(original, &env.operations, envelope()).unwrap();
        retry.try_grant().await.unwrap();
        exit.confirm_exit();
        let result = retry
            .start(&mut pool, "fixture_pool_runtime_retry")
            .unwrap()
            .join()
            .await
            .unwrap();
        drop(result.budget_lease);
        fixture.saved().await;
        assert_eq!(fixture.budget.allocated(), (0, 0, 0));
    });
}

#[tokio::test]
async fn cancelled_or_denied_admission_keeps_inventory_lease_and_complete_home_bytes() {
    for available in [9, 10, 64] {
        let env = Env::new(available).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:pool-no-progress", Some(backing)).await;
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let identity = park(&mut fixture, &mut pool);
        let revision = pool.status_snapshot().revision;
        let mut retirement = pending(&pool, &identity, &env);
        if available == 64 {
            let (seen, release) = env.source.gate_read();
            {
                let grant = retirement.try_grant();
                tokio::pin!(grant);
                tokio::select! {
                    () = async { seen.await.unwrap() } => {},
                    result = &mut grant => panic!("held grant returned {result:?}"),
                }
            }
            drop(release);
        } else {
            assert!(matches!(
                retirement.try_grant().await,
                Err(MemoryOperationError::InsufficientHeadroom { .. })
            ));
        }
        assert_eq!(pool.status_snapshot().revision, revision);
        assert!(pool.retirement_candidate(&identity).is_ok());
        fixture.untouched().await;
        drop(retirement);
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
        exit.confirm_exit();
        pool.drain()
            .pop()
            .unwrap()
            .run_with_context("fixture_pool_recovery")
            .await;
    }
}

#[tokio::test]
async fn guarded_inventory_refuses_absent_backing_and_uncaptured_candidates() {
    for has_backing in [false, true] {
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new(
            "thread:pool-missing-proof",
            has_backing.then_some(backing as Arc<dyn SandboxBackingProcess>),
        )
        .await;
        let mut candidate = fixture.candidate();
        if !has_backing {
            assert_eq!(
                candidate.capture_retirement_backing(),
                Err(MemoryOperationError::MissingBacking)
            );
        }
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        assert!(matches!(
            pool.retirement_candidate(&IdleSandboxIdentity::Exact(fixture.reuse_key.clone())),
            Err(MemoryOperationError::MissingBacking)
        ));
        fixture.untouched().await;
        exit.confirm_exit();
        pool.drain()
            .pop()
            .unwrap()
            .run_with_context("fixture_missing_proof_recovery")
            .await;
    }
}

#[tokio::test]
async fn reserve_restore_same_sandbox_and_parked_age_invalidates_waiting_retirement() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:pool-aba", Some(backing)).await;
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let identity = park(&mut fixture, &mut pool);
    let before = pool.retirement_candidate(&identity).unwrap();
    let mut retirement = IdlePoolRetirement::new(before, &env.operations, envelope()).unwrap();
    let (seen, release) = env.source.gate_read();
    {
        let grant = retirement.try_grant();
        tokio::pin!(grant);
        tokio::select! {
            () = async { seen.await.unwrap() } => {},
            result = &mut grant => panic!("held grant returned {result:?}"),
        }
        let reserved = pool.take_reserved(&fixture.reuse_key).unwrap();
        assert!(matches!(
            pool.restore_reserved(reserved),
            RestoreReservedIdleResult::Restored
        ));
        release.send(()).unwrap();
        grant.await.unwrap();
    }
    assert_eq!(
        retirement
            .start(&mut pool, "must_not_retire_reinserted")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::ResourceChanged
    );
    fixture.untouched().await;
    assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
    exit.confirm_exit();
    let mut fresh = pending(&pool, &identity, &env);
    fresh.try_grant().await.unwrap();
    let result = fresh
        .start(&mut pool, "fixture_fresh_pool_retirement")
        .unwrap()
        .join()
        .await
        .unwrap();
    assert_eq!(result.outcome, DestroyOutcome::Completed);
    drop(result.budget_lease);
    fixture.saved().await;
}

#[tokio::test]
async fn wrong_pool_and_late_authority_close_never_lose_the_original_entry() {
    for closed in [false, true] {
        let env = Env::new(64).await;
        let (exit, backing) = MockBackingProcess::channel();
        let mut fixture = JobFixture::new("thread:pool-rejected-start", Some(backing)).await;
        let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
        let identity = park(&mut fixture, &mut pool);
        let before = pool.retirement_candidate(&identity).unwrap();
        let revision = pool.status_snapshot().revision;
        let mut retirement = pending(&pool, &identity, &env);
        retirement.try_grant().await.unwrap();
        if closed {
            env.operations.close_and_wait().await.unwrap();
            assert_eq!(
                retirement
                    .start(&mut pool, "closed_pool_start")
                    .err()
                    .unwrap()
                    .into_error(),
                MemoryOperationError::Closed
            );
            let after = pool.retirement_candidate(&identity).unwrap();
            // Native private resource fields are not assertions: the original
            // public claim remains usable after a rejected paired transfer.
            let fresh_env = Env::new(64).await;
            let mut original =
                IdlePoolRetirement::new(before, &fresh_env.operations, envelope()).unwrap();
            original.try_grant().await.unwrap();
            fixture.untouched().await;
            assert_eq!(pool.status_snapshot().revision, revision);
            drop(after);
            exit.confirm_exit();
            let result = original
                .start(&mut pool, "fixture_original_claim_restored")
                .unwrap()
                .join()
                .await
                .unwrap();
            drop(result.budget_lease);
            fixture.saved().await;
        } else {
            let mut other = IdlePool::new(IdlePoolConfig { max_idle: 1 });
            assert_eq!(
                retirement
                    .start(&mut other, "wrong_pool")
                    .err()
                    .unwrap()
                    .into_error(),
                MemoryOperationError::OwnershipInvariant
            );
            assert_eq!(pool.status_snapshot().revision, revision);
            fixture.untouched().await;
            exit.confirm_exit();
            pool.drain()
                .pop()
                .unwrap()
                .run_with_context("fixture_wrong_pool_recovery")
                .await;
        }
        assert_eq!(env.operations.snapshot().unwrap().registered_operations, 0);
    }
}

#[tokio::test]
async fn independent_insertions_can_start_while_another_real_cleanup_tail_is_held() {
    let env = Env::new(64).await;
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 2 });
    let (exit_a, backing_a) = MockBackingProcess::channel();
    let (exit_b, backing_b) = MockBackingProcess::channel();
    let mut a = JobFixture::new("thread:pool-independent-a", Some(backing_a)).await;
    let mut b = JobFixture::new("thread:pool-independent-b", Some(backing_b)).await;
    let held = MockLifecycleGate::new();
    a.overrides.set_destroy_lifecycle_gate(held.clone());
    let id_a = park(&mut a, &mut pool);
    let id_b = park(&mut b, &mut pool);
    let mut pending_a = pending(&pool, &id_a, &env);
    let mut pending_b = pending(&pool, &id_b, &env);
    pending_a.try_grant().await.unwrap();
    pending_b.try_grant().await.unwrap();
    exit_a.confirm_exit();
    exit_b.confirm_exit();
    let task_a = pending_a
        .start(&mut pool, "fixture_held_pool_tail")
        .unwrap();
    held.wait_entered(1, WAIT).await.unwrap();
    let result_b = pending_b
        .start(&mut pool, "fixture_independent_pool_tail")
        .unwrap()
        .join()
        .await
        .unwrap();
    assert_eq!(result_b.outcome, DestroyOutcome::Completed);
    drop(result_b.budget_lease);
    b.saved().await;
    assert_eq!(a.budget.allocated(), (2, 8, 1));
    held.release_one();
    let result_a = task_a.join().await.unwrap();
    drop(result_a.budget_lease);
    a.saved().await;
    assert_eq!(
        env.operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}
