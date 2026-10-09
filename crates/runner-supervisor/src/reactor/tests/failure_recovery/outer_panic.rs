use super::super::super::*;
use super::super::support::{
    TEST_HEARTBEAT_GENERATION, TEST_RUNNER_ID, context_with_session, minimal_context,
    mock_run_config_with_overrides, push_job, shutdown, test_profiles, wait_budget_count,
    wait_cancel_token, wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_len,
    wait_status_idle_reuse_keys_and_active_runs,
};
use super::support::{assert_no_completion_for_run, assert_successful_completion_for_run};

use sandbox_mock::MockLifecycleGate;

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_idle_pool_owned_cleans_token_and_active_status() {
    let (mut config, env) = mock_run_config_with_overrides(
        test_profiles(),
        8,
        16384,
        4,
        Arc::new(sandbox_mock::MockSandboxOverrides::new()),
    );
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::IdlePoolOwned);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-outer-panic-idle")),
    );

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &["sess-outer-panic-idle"],
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report before idle-pool finalization panics",
    )
    .await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_handoff_keeps_successor_owned_sandbox() {
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::HandoffOwned);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reuse_key = "thread:outer-panic-handoff";
    let predecessor_run_id = RunId::new_v4();
    let mut predecessor_context = minimal_context(predecessor_run_id);
    predecessor_context.reuse_key = Some(reuse_key.to_owned());
    push_job(
        &env,
        predecessor_run_id,
        "vm0/default",
        Some(predecessor_context),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should be running before its successor is discovered");
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let successor_run_id = RunId::new_v4();
    let mut successor_context = minimal_context(successor_run_id);
    successor_context.reuse_key = Some(reuse_key.to_owned());
    env.provider
        .set_claim_result(successor_run_id, Some(successor_context));
    env.handle
        .discover_tx
        .send(
            runner_provider::JobCandidate::new(successor_run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference(runner_provider::ActiveRunnerPreference::new(
                    runner_host::runner_process_identity::RunnerProcessIdentity::new(
                        TEST_RUNNER_ID.parse().unwrap(),
                        TEST_HEARTBEAT_GENERATION,
                    )
                    .unwrap(),
                    runner_provider::RunnerPreferenceTier::FinalizingPredecessor,
                    std::time::Instant::now() + Duration::from_secs(30),
                )),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    wait_gate.release_one();
    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("successor should activate the handed-off sandbox before panic cleanup");
    wait_cancel_token_removed(&cancel_tokens, predecessor_run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[successor_run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    wait_gate.release_one();
    let predecessor_completion = env
        .handle
        .wait_completion(predecessor_run_id, Duration::from_secs(5))
        .await
        .expect("predecessor completion should survive post-handoff panic");
    let successor_completion = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete with the handed-off sandbox");
    assert_eq!(
        successor_completion.reuse_result,
        Some(runner_types::types::SandboxReuseResult::Reused)
    );
    assert_eq!(
        successor_completion.sandbox_id, predecessor_completion.sandbox_id,
        "panic cleanup must not destroy the successor-owned sandbox"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_active_unknown_reconciles_on_shutdown_final_scan() {
    let (mut config, env) = mock_run_config_with_overrides(
        test_profiles(),
        8,
        16384,
        4,
        Arc::new(sandbox_mock::MockSandboxOverrides::new()),
    );
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ActiveOrUnknown);
    config.orphan_reap.process_discovery = Some(OrphanReapProcessDiscovery {
        firecrackers: Arc::new(Vec::new()),
        proc_scan_complete: true,
        incomplete_for_current_runner: false,
    });
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    shutdown(&env, run_handle).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_no_completion_for_run(
        &env,
        run_id,
        "outer job panic before executor completion must not synthesize provider completion",
    );
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_active_stop_panic_preserves_status_for_reconciliation() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_stop_panic("simulated active stop panic");
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, Arc::clone(&overrides));
    // This hook runs after destroy bookkeeping for completed and uncertain outcomes.
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::DestroyCompleted);
    config.orphan_reap.process_discovery = Some(OrphanReapProcessDiscovery {
        firecrackers: Arc::new(Vec::new()),
        proc_scan_complete: true,
        incomplete_for_current_runner: false,
    });
    let budget = Arc::clone(&config.capacity.budget);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("active destroy should still run after stop panic"),
        1
    );
    let _token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    destroy_gate.release_one();

    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report before destroy bookkeeping panics",
    )
    .await;

    shutdown(&env, run_handle).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "orphan reconciliation must not duplicate host completion",
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn outer_job_panic_after_destroy_completed_cleans_token_and_active_status() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::DestroyCompleted);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_eq!(
        destroy_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .expect("active destroy should enter gate"),
        1
    );
    let _token = wait_cancel_token(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    destroy_gate.release_one();

    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report before completed destroy bookkeeping panics",
    )
    .await;

    shutdown(&env, run_handle).await;
}
