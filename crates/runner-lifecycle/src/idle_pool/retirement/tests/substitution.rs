use super::*;
use crate::idle_pool::{
    IdlePool, IdlePoolConfig, IdlePoolRetirement, IdleSandboxIdentity, ParkResult,
};
use sandbox_mock::MockBackingProcess;

#[tokio::test]
async fn rejected_substitution_restores_original_claim_and_full_owner_then_transfers_before_exit() {
    let env = Env::new(64).await;
    let (exit, backing) = MockBackingProcess::channel();
    let mut fixture = JobFixture::new("thread:substitution-original", Some(backing)).await;
    let mut pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    let mut candidate = fixture.candidate();
    candidate.capture_retirement_backing().unwrap();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let identity = IdleSandboxIdentity::Exact(fixture.reuse_key.clone());
    let original = pool.retirement_candidate(&identity).unwrap();
    let revision = pool.status_snapshot().revision;
    let mut retirement =
        IdlePoolRetirement::new(original.clone(), &env.operations, envelope()).unwrap();
    retirement.try_grant().await.unwrap();
    env.operations.close_and_wait().await.unwrap();
    assert_eq!(
        retirement
            .start_for_substitution(&mut pool, "closed_substitution")
            .err()
            .unwrap()
            .into_error(),
        MemoryOperationError::Closed
    );
    assert_eq!(pool.status_snapshot().revision, revision);
    fixture.untouched().await;
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));

    // The original public claim still matches: rejection changed no epoch/age/data.
    let fresh = Env::new(64).await;
    let mut retirement = IdlePoolRetirement::new(original, &fresh.operations, envelope()).unwrap();
    retirement.try_grant().await.unwrap();
    let started = retirement
        .start_for_substitution(&mut pool, "accepted_substitution")
        .unwrap();
    assert!(pool.is_empty());
    let replacement =
        ResourceBudget::try_substitute_leases(&fixture.budget, vec![started.budget_lease], 2, 8)
            .ok()
            .unwrap();
    assert_eq!(fixture.budget.allocated(), (2, 8, 1));
    assert_eq!(
        fresh.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    let (task, retained) = started.cleanup.into_parts();
    let completion = task.join();
    tokio::pin!(completion);
    assert!(futures_util::poll!(completion.as_mut()).is_pending());
    drop(replacement);
    assert_eq!(
        fresh.operations.snapshot().unwrap().cleanup_growth_bytes,
        9 * MIB
    );
    exit.confirm_exit();
    let result = tokio::time::timeout(WAIT, completion)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        result,
        crate::idle_pool::ActivationCleanupOutcome::Completed { .. }
    ));
    assert!(retained.take_completed_lease().is_err());
    assert!(retained.needs_retention());
    retained.release_completed_substitution().unwrap();
    assert!(!retained.needs_retention());
    fixture.saved().await;
    assert_eq!(
        fresh
            .operations
            .close_and_wait()
            .await
            .unwrap()
            .registered_operations,
        0
    );
}
