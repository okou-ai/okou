use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config, push_job, shutdown, test_profiles, wait_cancel_token_removed,
    wait_discover_entered,
};

// -----------------------------------------------------------------------
// Test 1: Normal discover → claim → execute → complete
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn main_loop_discover_claim_execute_complete() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let c = completion.unwrap();
    assert_eq!(c.exit_code, 0);
    assert!(c.error.is_none());

    shutdown(&env, run_handle).await;
}

/// Regression for #11157: normal Running mode with available budget must
/// still reap completed job tasks so their cancellation registrations do not
/// remain until a later drain, shutdown, or budget-exhausted wait.
#[tokio::test(start_paused = true)]
async fn running_reaps_completed_jobs_without_budget_exhaustion() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 8: Two successful jobs in sequence
//
// After the first job completes, discover_fut is recreated
// (Box::pin(provider.discover())). The second job must be discovered,
// claimed, executed, and completed through the recreated future.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn two_sequential_jobs_complete() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // First job
    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");
    assert_eq!(c1.unwrap().exit_code, 0);

    // Second job — exercises the recreated discover_fut path
    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "second job should complete via recreated discover_fut"
    );
    assert_eq!(c2.unwrap().exit_code, 0);

    shutdown(&env, run_handle).await;
}
