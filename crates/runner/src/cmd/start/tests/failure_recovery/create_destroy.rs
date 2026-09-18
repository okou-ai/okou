use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_overrides, push_job, shutdown,
    status_idle_reuse_keys_and_active_runs, test_profiles, wait_budget_count, wait_cancel_handle,
    wait_cancel_token_removed, wait_idle_pool_reuse_keys,
};
use crate::types::SandboxReuseResult;
use guest_contracts::diagnostics::{
    AgentFramework, CliTerminationDiagnostic, CliTerminationReason, FailureClass,
    FailureDiagnostic, PromptMetadata,
};

#[tokio::test(start_paused = true)]
async fn active_destroy_panic_still_reports_completion_and_releases_budget() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    overrides.push_destroy_panic("simulated destroy panic");
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "destroy panic must not skip provider.complete"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(counter.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

/// Test 20: A healthy non-zero process exit remains failed but retains its sandbox.
#[tokio::test(start_paused = true)]
async fn nonzero_job_parks_and_successor_reuses_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "sess-fail";

    let failed_run_id = RunId::new_v4();
    push_job(
        &env,
        failed_run_id,
        "vm0/default",
        Some(context_with_session(failed_run_id, reuse_key)),
    );

    let failed = env
        .handle
        .wait_completion(failed_run_id, Duration::from_secs(5))
        .await
        .expect("non-zero job should complete");
    assert_eq!(failed.exit_code, 1);
    let sandbox_id = failed.sandbox_id.expect("failed run should own a sandbox");
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(
        budget.allocated().2,
        1,
        "parked sandbox should retain its budget"
    );
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);
    let held = idle_pool.lock().await.held_sandbox_states();
    assert_eq!(held.len(), 1);
    assert_eq!(
        held[0].reusable_sandbox.history_generation_run_id, None,
        "failed execution must not advertise an exact history generation",
    );

    let successor_run_id = RunId::new_v4();
    push_job(
        &env,
        successor_run_id,
        "vm0/default",
        Some(context_with_session(successor_run_id, reuse_key)),
    );

    let successor = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete");
    assert_eq!(successor.exit_code, 0);
    assert_eq!(successor.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(successor.sandbox_id, Some(sandbox_id));
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(overrides.park_call_count(), 2);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn full_root_filesystem_remains_failed_and_destroys_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 126, Vec::new(), Vec::new()));
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "guest-agent-binary".to_string(),
        exit_code: 0,
        stdout: b"/dev/root 8388608 8388608 0 100% /\n".to_vec(),
        stderr: Vec::new(),
    });
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-rootfs-full")),
    );

    let failed = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("rootfs exhaustion should report completion");
    assert_eq!(failed.exit_code, 126);
    assert_eq!(failed.error.as_deref(), Some("Agent exited with code 126"));
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(idle_pool.lock().await.held_sandbox_states().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn confirmed_execution_timeout_parks_and_successor_reuses_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(
        1,
        guest_contracts::diagnostics::AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
        Vec::new(),
        Vec::new(),
    ));
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliExecutionError,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("continue until the execution deadline"),
    )
    .with_cli_exit_code(143)
    .with_cli_termination(CliTerminationDiagnostic::new(
        CliTerminationReason::ExecutionTimeout,
    ));
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(Some(b"Agent execution timed out".to_vec())));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "sess-execution-timeout";

    let timed_out_run_id = RunId::new_v4();
    push_job(
        &env,
        timed_out_run_id,
        "vm0/default",
        Some(context_with_session(timed_out_run_id, reuse_key)),
    );

    let timed_out = env
        .handle
        .wait_completion(timed_out_run_id, Duration::from_secs(5))
        .await
        .expect("timed-out job should complete");
    assert_eq!(
        timed_out.exit_code,
        guest_contracts::diagnostics::AGENT_EXECUTION_TIMEOUT_EXIT_CODE,
    );
    assert_eq!(
        timed_out.error.as_deref(),
        Some("Agent execution timed out")
    );
    let sandbox_id = timed_out
        .sandbox_id
        .expect("timed-out run should own a sandbox");
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);
    let held = idle_pool.lock().await.held_sandbox_states();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].reusable_sandbox.history_generation_run_id, None);

    let successor_run_id = RunId::new_v4();
    push_job(
        &env,
        successor_run_id,
        "vm0/default",
        Some(context_with_session(successor_run_id, reuse_key)),
    );

    let successor = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete");
    assert_eq!(successor.exit_code, 0);
    assert_eq!(successor.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(successor.sandbox_id, Some(sandbox_id));
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(overrides.park_call_count(), 2);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cooperative_cancellation_parks_and_successor_reuses_sandbox() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "sess-cooperative-cancel";

    let cancelled_run_id = RunId::new_v4();
    push_job(
        &env,
        cancelled_run_id,
        "vm0/default",
        Some(context_with_session(cancelled_run_id, reuse_key)),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("source run should enter process wait");
    let cancel_handle =
        wait_cancel_handle(&cancel_tokens, cancelled_run_id, Duration::from_secs(5)).await;
    cancel_handle.request_cooperative_user_cancellation().await;
    assert!(
        overrides
            .wait_for_process_control_calls(1, Duration::from_secs(5))
            .await,
        "cooperative cancellation should reach the guest control channel",
    );
    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();

    let cancelled = env
        .handle
        .wait_completion(cancelled_run_id, Duration::from_secs(5))
        .await
        .expect("cooperatively cancelled run should complete");
    assert_eq!(cancelled.exit_code, 137);
    assert_eq!(cancelled.error.as_deref(), Some("cancelled by user"));
    let sandbox_id = cancelled
        .sandbox_id
        .expect("cancelled run should own a sandbox");
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);
    let held = idle_pool.lock().await.held_sandbox_states();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].reusable_sandbox.history_generation_run_id, None);

    let successor_run_id = RunId::new_v4();
    push_job(
        &env,
        successor_run_id,
        "vm0/default",
        Some(context_with_session(successor_run_id, reuse_key)),
    );
    let successor = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete");
    assert_eq!(successor.exit_code, 0);
    assert_eq!(successor.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(successor.sandbox_id, Some(sandbox_id));
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);
    assert_eq!(overrides.park_call_count(), 2);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

/// Test 21: A hard-cancelled job is destroyed instead of parked.
#[tokio::test(start_paused = true)]
async fn hard_cancelled_job_not_parked() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 4, 8192, 4, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel")),
    );

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before cancellation");
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;
    cancel_handle.request_hard_cancellation().await;

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "hard-cancelled job should still complete");
    let c = c.unwrap();
    assert_eq!(
        c.exit_code, 137,
        "hard cancellation yields synthetic SIGKILL"
    );
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "hard-cancelled job must not park"
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.park_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn create_failure_completes_and_cleans_run_state() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_create_result(Err(sandbox::SandboxError::Initialization {
        phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
        message: "create failed".into(),
    }));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("create failure should still report completion");
    assert_eq!(c.exit_code, 1);
    let error = c.error.expect("create failure should report an error");
    assert!(error.contains("create failed"), "got: {error}");

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    wait_cancel_token_removed(&cancel_tokens, run_id, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    let (_idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(
        active_runs.is_empty(),
        "create failure should remove active run from status"
    );

    shutdown(&env, run_handle).await;
}
