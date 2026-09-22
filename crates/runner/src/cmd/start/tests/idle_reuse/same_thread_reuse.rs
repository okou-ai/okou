use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, seed_idle_pool, shutdown, test_profiles, two_profiles, wait_budget_count,
    wait_idle_pool_reuse_keys,
};

use runner_types::types::{SandboxReuseResult, WorkspaceReuseResult};

// -----------------------------------------------------------------------
// Test 13: Same-thread work reuses an idle sandbox
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn same_thread_reuses_idle_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);

    // Pre-seed: park a sandbox for reuse key "sess-reuse" with matching profile.
    let seeded_sandbox_id =
        seed_idle_pool(&idle_pool, &budget, "sess-reuse", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Push job for same reuse key — should reuse the idle sandbox.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-reuse")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::Reused),
        "reuse_result should be Reused"
    );
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::SandboxReused),
    );
    assert_eq!(
        completion.sandbox_id,
        Some(seeded_sandbox_id),
        "reused completion should carry the seeded sandbox id"
    );

    // After reuse + re-park: pool should still have 1 entry, budget count=1.
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-reuse"], Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "sandbox should be re-parked after reuse");
    }
    assert_eq!(
        budget.allocated().2,
        1,
        "budget should remain at 1 (reused, not additive)"
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 13b: Job with no reuse key reports NoReuseKey
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn job_without_reuse_key_reports_no_reuse_key() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey),
    );
    assert!(
        completion.sandbox_id.is_some(),
        "fresh create still allocates a sandbox id",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn invalid_reserved_resume_session_fails_before_reuse() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:invalid-resume-reserved";
    let invalid_session_id = "../invalid-session";
    let seeded_sandbox_id =
        seed_idle_pool(&idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_string());
    context.resume_session = Some(runner_types::types::ResumeSession::inline(
        invalid_session_id.to_string(),
        String::new(),
    ));
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_string())),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(completion.reuse_result, None);
    assert_eq!(completion.sandbox_id, None);
    let error = completion.error.as_deref().expect("error should be set");
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(invalid_session_id));
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
        seeded_sandbox_id,
        "invalid continuation metadata must restore the reserved sandbox",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn invalid_resume_session_fails_before_fresh_sandbox_creation() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    let reuse_key = "thread:invalid-resume-fresh";
    let invalid_session_id = "../invalid-fresh-session";
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_string());
    context.resume_session = Some(runner_types::types::ResumeSession::inline(
        invalid_session_id.to_string(),
        String::new(),
    ));

    push_job(&env, run_id, "vm0/default", Some(context));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(completion.reuse_result, None);
    assert_eq!(completion.sandbox_id, None);
    let error = completion.error.as_deref().expect("error should be set");
    assert!(error.contains("invalid session_id"));
    assert!(!error.contains(invalid_session_id));
    assert!(
        overrides.create_configs().is_empty(),
        "invalid continuation metadata must fail before sandbox creation",
    );
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 14: Profile mismatch destroys stale and creates new
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn profile_mismatch_destroys_stale_sandbox() {
    let (config, env) = mock_run_config(two_profiles(), 16, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);

    // Pre-seed: park a "vm0/default" (2vcpu) sandbox for session "sess-mm".
    seed_idle_pool(&idle_pool, &budget, "sess-mm", "vm0/default", 2, 4096).await;

    let run_handle = tokio::spawn(run(config));

    // Push job for "vm0/large" (4vcpu) with same reuse key — profile mismatch.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/large",
        Some(context_with_session(run_id, "sess-mm")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let completion = completion.unwrap();
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::ProfileMismatch),
        "reuse_result should be ProfileMismatch when profile differs"
    );
    assert!(
        completion.sandbox_id.is_some(),
        "freshly created sandbox still reports its id"
    );

    // Stale sandbox destruction runs in a background destroy_task. Poll until
    // its budget is released rather than using a fixed sleep.
    // Expected: stale 2vcpu released, new 4vcpu held → count=1.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "new sandbox should be parked");
    }
    let (alloc_vcpu, alloc_mem, alloc_count) = budget.allocated();
    assert_eq!(alloc_count, 1, "only new sandbox should hold budget");
    assert_eq!(alloc_vcpu, 4, "new sandbox is vm0/large (4 vcpu)");
    assert_eq!(alloc_mem, 8192, "new sandbox is vm0/large (8192 MB)");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Reuse-enabled job whose session has no idle entry reports PoolMiss
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn reuse_enabled_empty_pool_reports_pool_miss() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);

    let run_handle = tokio::spawn(run(config));

    // Empty pool + resume_session set + feature on → PoolMiss branch.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-missing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::PoolMiss),
        "empty-pool reuse attempt must tag PoolMiss",
    );
    assert!(
        completion.sandbox_id.is_some(),
        "fresh create still allocates a sandbox id",
    );
    // Sanity: no one was in the pool to begin with.
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "fresh-create sandbox re-parks into the pool",
    );

    shutdown(&env, run_handle).await;
}
