use std::collections::BTreeMap;
use std::time::Duration;

use super::super::*;
use crate::blank_pool::BlankPoolReplenisher;
use crate::provider_test_support::MockJobProvider;
use runner_lifecycle::idle_pool::{IdlePool, IdlePoolConfig};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn fresh_claim_does_not_wait_for_a_second_pool_lock_after_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let status = Arc::new(StatusTracker::new(
        dir.path().join("status.json"),
        1,
        None,
        None,
    ));
    let budget = Arc::new(ResourceBudget::new(3, 4096, 1.0, 1));
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 0,
    })));
    let (provider, handle) = MockJobProvider::new(CancellationToken::new());
    let run_id = RunId::new_v4();
    handle.block_claim(run_id);
    let (_mode_tx, mode_rx) = watch::channel(RunnerMode::Running);
    let cancel_tokens = RunCancellationRegistry::new();
    let notify = Arc::new(Notify::new());
    let tracker = IdleDestroyTracker::new(Arc::clone(&notify));
    let active_runs = ActiveRuns::new(Arc::clone(&notify));
    let home = HomeCacheStateSnapshot::new();
    let diagnostics =
        BlankPoolReplenisher::new(&BTreeMap::new(), &BTreeMap::new(), &budget, 0, None)
            .diagnostics();
    let ctx = PreClaimResources {
        runner_identity: RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 1).unwrap(),
        idle_pool: &pool,
        status: &status,
        mode_rx: &mode_rx,
        cancel_tokens: &cancel_tokens,
        provider: provider.as_ref(),
        budget: &budget,
        active_runs: &active_runs,
        home_cache_snapshot: &home,
        sandbox_op_reporter: None,
        home_cache: None,
        idle_destroy_tracker: &tracker,
        reuse_state_notify: &notify,
        blank_pool_diagnostics: &diagnostics,
    };
    let first_holder = pool.lock().await;
    let (ready, mut admission_ready) = oneshot::channel();
    let admission = admit_and_claim(
        PreClaimRequest {
            candidate: JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some("thread:fresh-claim".into())),
            profile_name: "vm0/default",
            job_vcpu: 2,
            job_memory: 4096,
            home_disk_mb: 1,
            device_rate_limits: &None,
        },
        &ctx,
        ready,
    );
    tokio::pin!(admission);
    assert!(futures_util::poll!(admission.as_mut()).is_pending());
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(handle.claim_candidates().is_empty());
    assert!(cancel_tokens.handle(run_id).await.is_none());

    // Queue after initial selection, ahead of any optional second lookup.
    let next_holder = pool.lock();
    tokio::pin!(next_holder);
    assert!(futures_util::poll!(next_holder.as_mut()).is_pending());
    drop(first_holder);
    assert!(futures_util::poll!(admission.as_mut()).is_pending());
    let next_holder = tokio::time::timeout(Duration::from_secs(2), next_holder)
        .await
        .expect("queued pool holder should follow initial reservation");

    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());
    assert_eq!(
        handle.claim_candidates().len(),
        1,
        "owned fresh capacity must reach claim without another pool acquisition"
    );
    admission_ready.try_recv().unwrap();
    assert!(cancel_tokens.handle(run_id).await.is_some());

    handle.unblock_claim(run_id);
    let outcome = tokio::time::timeout(Duration::from_secs(2), admission)
        .await
        .expect("fresh rejection must release its lease while the pool remains locked");
    assert!(matches!(outcome, PreClaimOutcome::Deferred));
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(cancel_tokens.handle(run_id).await.is_none());
    assert!(handle.completions.lock().unwrap().is_empty());
    assert!(next_holder.is_empty());
    drop(next_holder);
    tracker.close_and_wait().await;
}
