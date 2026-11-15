use std::collections::BTreeMap;
use std::time::Duration;

use super::super::*;
use crate::blank_pool::BlankPoolReplenisher;
use crate::provider_test_support::MockJobProvider;
use runner_lifecycle::idle_pool::{IdlePool, IdlePoolConfig};
use runner_types::ids::RunId;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn existing_run_registration_guards_supplied_work_without_http_history() {
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
    let (_mode_tx, mode_rx) = watch::channel(RunnerMode::Running);
    let cancel_tokens = RunCancellationRegistry::new();
    let run_id = RunId::new_v4();
    let existing = cancel_tokens.register(run_id).await.unwrap();
    let notify = Arc::new(Notify::new());
    let tracker = IdleDestroyTracker::new(Arc::clone(&notify));
    let diagnostics =
        BlankPoolReplenisher::new(&BTreeMap::new(), &BTreeMap::new(), &budget, 0, None)
            .diagnostics();
    let active_runs = runner_lifecycle::active_runs::ActiveRuns::new(Arc::clone(&notify));
    let ctx = AcceptanceResources {
        active_runs: &active_runs,
        idle_pool: &pool,
        status: &status,
        mode_rx: &mode_rx,
        cancel_tokens: &cancel_tokens,
        provider: provider.as_ref(),
        budget: &budget,
        idle_destroy_tracker: &tracker,
        reuse_state_notify: &notify,
        blank_pool_diagnostics: &diagnostics,
    };
    let context = serde_json::from_value(serde_json::json!({
        "runId": run_id, "sandboxToken": "run-token", "prompt": "hello",
        "cliAgentType": "", "platformEnvironment": {}, "connectorRuntimeTargets": []
    }))
    .unwrap();
    let pool_holder = pool.lock().await;
    let (ready, _) = oneshot::channel();
    let outcome = tokio::time::timeout(
        Duration::from_secs(1),
        accept_supplied(
            context,
            AcceptanceRequest {
                profile_name: "vm0/default",
                job_vcpu: 2,
                job_memory: 4096,
                device_rate_limits: &None,
            },
            tokio::time::Instant::now() + Duration::from_secs(5),
            &ctx,
            ready,
        ),
    )
    .await
    .expect("a registered Run must not wait for resource acceptance again");
    assert!(matches!(outcome, SuppliedAcceptance::Unknown));
    assert!(cancel_tokens.handle(run_id).await.is_some());
    assert!(!existing.handle().is_cancelled());
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(handle.claim_candidates().is_empty());
    assert!(handle.completions.lock().unwrap().is_empty());
    drop(pool_holder);
    existing.unregister().await;
    tracker.close_and_wait().await;
}
