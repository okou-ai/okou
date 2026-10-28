use std::collections::BTreeMap;
use std::time::Duration;

use super::super::*;
use crate::blank_pool::BlankPoolReplenisher;
use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use crate::provider_test_support::MockJobProvider;
use runner_lifecycle::guest_timezone::GuestTimezoneIntent;
use runner_lifecycle::home_promotion::test_support::add_healthy_cache_preparation_matcher;
use runner_lifecycle::idle_pool::{
    IdlePool, IdlePoolConfig, ParkResult, test_support::ParkedIdleCandidateBuilder,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn stale_exact_journal_waits_for_the_newer_inventory_to_be_durable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("status.json");
    let write_started = Arc::new(Notify::new());
    let release_write = Arc::new(tokio::sync::Semaphore::new(0));
    let status = Arc::new(StatusTracker::new_with_atomic_write_gate(
        path.clone(),
        2,
        Arc::clone(&write_started),
        Arc::clone(&release_write),
    ));
    let budget = Arc::new(ResourceBudget::new(5, 8192, 1.0, 2));
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    add_healthy_cache_preparation_matcher(&overrides);
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 2,
    })));
    let sandbox_id = SandboxId::new_v4();
    let history = RunId::new_v4();
    let second_history = RunId::new_v4();
    for (reuse_key, id, generation) in [
        ("first", sandbox_id, history),
        ("second", SandboxId::new_v4(), second_history),
    ] {
        let candidate = ParkedIdleCandidateBuilder::new(
            reuse_key,
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        )
        .with_sandbox(Box::new(sandbox_mock::MockSandbox::with_overrides(
            id.to_string(),
            Arc::clone(&overrides),
        )))
        .with_sandbox_id(id)
        .with_source_run_id(generation)
        .with_guest_timezone_intent(GuestTimezoneIntent::Default)
        .build();
        assert!(matches!(
            pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
    }
    let initial_snapshot = pool.lock().await.status_snapshot();
    status.set_idle_snapshot(initial_snapshot).await.unwrap();
    let first = reserve_source_idle_for_spawn(&pool, "first", "vm0/default", &None, history)
        .await
        .unwrap();
    let second =
        reserve_source_idle_for_spawn(&pool, "second", "vm0/default", &None, second_history)
            .await
            .unwrap();
    let newer_snapshot = pool.lock().await.status_snapshot();
    let publishing = Arc::clone(&status);
    let write = tokio::spawn(async move { publishing.set_idle_snapshot(newer_snapshot).await });
    tokio::time::timeout(Duration::from_secs(2), write_started.notified())
        .await
        .expect("newer inventory must reach the actual pending write");

    let run_id = RunId::new_v4();
    let (provider, handle) = MockJobProvider::new(CancellationToken::new());
    handle.block_claim(run_id);
    let (_, mode_rx) = watch::channel(RunnerMode::Running);
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
    let PreferencePreparation::Ready(prepared) = exact_speculative_preparation(
        JobCandidate::new(run_id, "vm0/default".into()).with_reuse_key(Some("first".into())),
        first,
    ) else {
        panic!("exclusive exact reservation must be ready");
    };
    let (ready, _) = oneshot::channel();
    let admission = claim_with_local_admission(
        ClaimAdmissionRequest {
            prepared,
            run_id,
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
    assert_eq!(handle.claim_candidates().len(), 1);
    assert_eq!(
        overrides.unpark_call_count(),
        0,
        "ignoring an older snapshot does not prove the newer inventory is durable"
    );
    assert!(overrides.guest_state_restore_calls().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
    assert!(
        persisted["idle_sandboxes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["sandbox_id"] == sandbox_id.to_string() })
    );

    release_write.add_permits(1);
    assert!(write.await.unwrap().unwrap());
    let observer = async {
        assert!(
            overrides
                .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
                .await
        );
        let persisted: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        assert!(persisted.get("idle_sandboxes").is_none());
        handle.unblock_claim(run_id);
    };
    let (outcome, ()) = tokio::join!(admission, observer);
    assert!(outcome.is_none());
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(handle.completions.lock().unwrap().is_empty());
    rollback_reserved_idle_for_spawn(second, &pool, &status, &notify, &tracker).await;
    assert_eq!(pool.lock().await.len(), 2);
    assert_eq!(budget.allocated(), (4, 8192, 2));
    for job in pool.lock().await.drain() {
        drop(tracker.spawn_job(job, "stale_exact_journal_test_shutdown"));
    }
    tracker.close_and_wait().await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
