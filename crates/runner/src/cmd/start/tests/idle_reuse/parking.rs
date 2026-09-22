use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, seed_idle_pool, shutdown, test_profiles, wait_budget_count, wait_discover_entered,
    wait_idle_pool_reuse_keys, wait_sandbox_lifecycle_counts,
    wait_status_idle_empty_with_active_run, wait_status_idle_reuse_keys_and_active_runs,
};

use runner_types::types::SandboxReuseResult;

// -----------------------------------------------------------------------
// Test 9: idle pool park/take is gated on reuse-key availability.
// -----------------------------------------------------------------------

fn context_with_session_opt(
    run_id: RunId,
    session_id: Option<&str>,
) -> runner_types::types::ExecutionContext {
    let mut ctx = minimal_context(run_id);
    if let Some(sid) = session_id {
        ctx.reuse_key = Some(format!("thread:idle-{sid}"));
        ctx.resume_session = Some(runner_types::types::ResumeSession::inline(
            sid.to_string(),
            String::new(),
        ));
    }
    ctx
}

#[tokio::test(start_paused = true)]
async fn job_with_session_parks_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let ctx = context_with_session_opt(run_id, Some("sess-1"));
    push_job(&env, run_id, "vm0/default", Some(ctx));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    let pool = env.idle_pool.lock().await;
    assert_eq!(
        pool.len(),
        1,
        "sandbox should be parked when session is present"
    );
    assert!(
        pool.held_reuse_keys()
            .contains(&"thread:idle-sess-1".to_string())
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn job_without_reuse_key_does_not_park() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    // Neither a continuation session nor a reuse key is available.
    let ctx = context_with_session_opt(run_id, None);
    push_job(&env, run_id, "vm0/default", Some(ctx));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    let pool = env.idle_pool.lock().await;
    assert_eq!(
        pool.len(),
        0,
        "sandbox should not be parked without a reuse key"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn job_without_cli_session_parks_and_reuses_by_reuse_key() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "thread:no-cli-session";
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let heartbeat_count = env.handle.heartbeat_count();

    let first_run_id = RunId::new_v4();
    let mut first_context = minimal_context(first_run_id);
    first_context.reuse_key = Some(reuse_key.into());
    push_job(&env, first_run_id, "vm0/default", Some(first_context));
    let first_completion = env
        .handle
        .wait_completion(first_run_id, Duration::from_secs(5))
        .await
        .expect("first job should complete");
    assert_eq!(first_completion.exit_code, 0);
    let sandbox_id = first_completion
        .sandbox_id
        .expect("first job should report its sandbox id");
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &env._temp_dir.path().join("status.json"),
        &[reuse_key],
        &[],
        Duration::from_secs(5),
    )
    .await;
    let heartbeat_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (advertised, current_count, observed_heartbeats) = {
            let heartbeats = env
                .handle
                .heartbeats
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            (
                heartbeats[heartbeat_count..].iter().any(|heartbeat| {
                    heartbeat
                        .held_sandbox_states
                        .iter()
                        .any(|state| state.reuse_key == reuse_key)
                }),
                heartbeats.len(),
                heartbeats[heartbeat_count..].to_vec(),
            )
        };
        if advertised {
            break;
        }
        let remaining = heartbeat_deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero()
                && env
                    .handle
                    .wait_heartbeat_past(current_count, remaining)
                    .await,
            "post-park heartbeat should advertise the reusable sandbox; heartbeats: {observed_heartbeats:?}",
        );
    }
    {
        let pool = idle_pool.lock().await;
        let sandbox_states = pool.held_sandbox_states();
        assert_eq!(sandbox_states.len(), 1);
        assert_eq!(sandbox_states[0].reuse_key, reuse_key);
    }

    let second_run_id = RunId::new_v4();
    let mut second_context = minimal_context(second_run_id);
    second_context.reuse_key = Some(reuse_key.into());
    push_job(&env, second_run_id, "vm0/default", Some(second_context));
    let second_completion = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second job should complete");
    assert_eq!(second_completion.exit_code, 0);
    assert_eq!(
        second_completion.reuse_result,
        Some(SandboxReuseResult::Reused),
    );
    assert_eq!(second_completion.sandbox_id, Some(sandbox_id));
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 10: Successful job parks sandbox in idle pool
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn successful_job_parks_in_idle_pool() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    assert_eq!(completion.unwrap().exit_code, 0);

    // sandbox should be parked in idle pool, holding budget.
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-park"], Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 1, "sandbox should be parked");
        assert!(
            pool.held_reuse_keys().contains(&"sess-park".to_string()),
            "parked session should be sess-park"
        );
    }
    let (_, _, count) = budget.allocated();
    assert_eq!(count, 1, "parked sandbox should hold budget");

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn completion_report_starts_while_sandbox_park_is_blocked() {
    let park_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let reuse_key = "thread:completion-before-park";
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(context));

    park_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("sandbox park should reach the lifecycle gate");
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("host completion should be reported before park finishes");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(budget.allocated().2, 1, "active budget must remain held");
    assert_eq!(idle_pool.lock().await.len(), 0);
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;

    park_gate.release_one();
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[reuse_key],
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(budget.allocated().2, 1, "idle sandbox must own the budget");

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn sandbox_finalization_progresses_while_completion_report_is_blocked() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    env.handle.block_completions();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let reuse_key = "thread:park-before-completion";
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(context));

    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("blocked host completion should record its request");
    assert_eq!(env.handle.completion_in_flight(), 1);
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[reuse_key],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        budget.allocated().2,
        1,
        "finalization must transfer budget ownership without releasing it",
    );

    env.handle.unblock_completions();
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[reuse_key],
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(env.handle.completion_in_flight(), 0);
    assert_eq!(
        budget.allocated().2,
        1,
        "idle sandbox must retain the budget"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn provider_can_require_finalization_before_completion_is_observable() {
    let park_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    env.handle.require_finalization_before_completion();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let reuse_key = "thread:completion-after-park";
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(context));

    park_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("sandbox park should reach the lifecycle gate");
    assert!(
        env.handle
            .wait_completion(run_id, Duration::ZERO)
            .await
            .is_none(),
        "provider completion must remain hidden until sandbox finalization finishes",
    );
    wait_status_idle_empty_with_active_run(&status_path, run_id, Duration::from_secs(5)).await;

    park_gate.release_one();
    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("provider completion should be reported after sandbox finalization");
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[reuse_key],
        &[],
        Duration::from_secs(5),
    )
    .await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 11: Job without a reuse key destroys its sandbox (no parking)
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn job_without_reuse_key_destroys_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    // No reuse key means the sandbox has no identity under which to park.
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    assert_eq!(completion.unwrap().exit_code, 0);

    // The active budget lease is dropped after provider.complete() in the
    // spawned task, so wait_completion returning doesn't guarantee it has
    // executed yet.
    // Poll until budget is fully released rather than using a fixed sleep.
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    // No parking — pool empty, budget fully released.
    assert_eq!(idle_pool.lock().await.len(), 0, "pool should be empty");

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 19: Two sequential jobs for same reuse key → take + reuse + re-park
//
// Exercises the full reuse cycle: park → take → reuse → park.
// After two jobs the pool should have exactly 1 entry (the second job's
// sandbox) and the budget count should be 1.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn sequential_same_reuse_key_cycle() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    // Job 1: parks sandbox for reuse key "sess-seq".
    let id1 = RunId::new_v4();
    push_job(
        &env,
        id1,
        "vm0/default",
        Some(context_with_session(id1, "sess-seq")),
    );
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "job 1 should complete");
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-seq"], Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "job 1 sandbox should be parked"
    );

    // Job 2: same reuse key → take → reuse → re-park.
    let id2 = RunId::new_v4();
    push_job(
        &env,
        id2,
        "vm0/default",
        Some(context_with_session(id2, "sess-seq")),
    );
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(c2.is_some(), "job 2 should complete");
    assert_eq!(
        c2.unwrap().reuse_result,
        Some(SandboxReuseResult::Reused),
        "job 2 should reuse the first job's parked sandbox",
    );
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-seq"], Duration::from_secs(5)).await;

    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "pool should have 1 entry after two sequential jobs"
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "only one sandbox should hold budget"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn same_thread_reuses_sandbox_across_provider_session_change() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));
    let reuse_key = "thread:chat-thread";

    let first_run_id = RunId::new_v4();
    let mut first_context = context_with_session(first_run_id, "provider-session-a");
    first_context.reuse_key = Some(reuse_key.into());
    push_job(&env, first_run_id, "vm0/default", Some(first_context));
    assert!(
        env.handle
            .wait_completion(first_run_id, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    let second_run_id = RunId::new_v4();
    let mut second_context = context_with_session(second_run_id, "provider-session-b");
    second_context.reuse_key = Some(reuse_key.into());
    push_job(&env, second_run_id, "vm0/default", Some(second_context));
    let completion = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::Reused),
        "the thread reuse key should select the first job's parked sandbox"
    );
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

/// Test 22: a discovered CLI session ID is metadata, not a reuse key.
///
/// A job without a reuse key reads a CLI-generated session ID from the guest.
/// That provider identity must not replace a parked sandbox whose reuse key
/// happens to have the same text.
#[tokio::test(start_paused = true)]
async fn discovered_cli_session_does_not_substitute_for_reuse_key() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "/.vm0/guest-agent/runs/".into(),
        exit_code: 0,
        stdout: b"sess-evict".to_vec(),
        stderr: Vec::new(),
    });
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);

    let seeded_sandbox_id =
        seed_idle_pool(&idle_pool, &budget, "sess-evict", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "pre-seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));

    // Push job WITHOUT resume_session — first run, no session context.
    // read_guest_cli_agent_session_id() will be called and return "sess-evict"
    // via the exec matcher.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);

    // The new sandbox is destroyed while the pre-existing idle sandbox keeps
    // its lease, so the net budget count remains one.
    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    let pool = idle_pool.lock().await;
    assert_eq!(pool.len(), 1, "the existing idle sandbox should remain");
    assert_eq!(
        pool.held_reuse_keys(),
        vec!["sess-evict"],
        "the discovered CLI session ID must not create a reuse identity"
    );
    assert_eq!(
        pool.status_snapshot().idle_sandboxes[0].sandbox_id,
        seeded_sandbox_id
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Tests 23-25: park / unpark idle-transition orchestration (#9102)
// -----------------------------------------------------------------------

/// Two sequential jobs on the same reuse key produce park=2 / unpark=1:
/// the first job's post-exit park, plus the second job's take (unpark)
/// and post-exit re-park. Verifies the full reuse cycle drives the
/// new trait hooks symmetrically.
#[tokio::test(start_paused = true)]
async fn reuse_cycle_invokes_park_and_unpark_symmetrically() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    // Job 1: fresh create → run → park.
    let id1 = RunId::new_v4();
    push_job(
        &env,
        id1,
        "vm0/default",
        Some(context_with_session(id1, "sess-reuse-cycle")),
    );
    assert!(
        env.handle
            .wait_completion(id1, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_sandbox_lifecycle_counts(&counter, 1, 0, Duration::from_secs(5)).await;
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-reuse-cycle"], Duration::from_secs(5)).await;

    // Job 2: same reuse key → take (unpark) → run → re-park.
    let id2 = RunId::new_v4();
    push_job(
        &env,
        id2,
        "vm0/default",
        Some(context_with_session(id2, "sess-reuse-cycle")),
    );
    assert!(
        env.handle
            .wait_completion(id2, Duration::from_secs(5))
            .await
            .is_some()
    );
    wait_sandbox_lifecycle_counts(&counter, 2, 1, Duration::from_secs(5)).await;
    assert_eq!(
        counter.park_call_count(),
        2,
        "park() should fire once per job"
    );
    assert_eq!(
        counter.unpark_call_count(),
        1,
        "unpark() should fire only for the reused job"
    );
    assert_eq!(idle_pool.lock().await.len(), 1);

    shutdown(&env, run_handle).await;
}

/// A successful job with a session triggers `Sandbox::park()` exactly once
/// when the sandbox is handed off to the idle pool.
#[tokio::test(start_paused = true)]
async fn park_called_when_sandbox_enters_idle_pool() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-hook")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");

    wait_sandbox_lifecycle_counts(&counter, 1, 0, Duration::from_secs(5)).await;
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-park-hook"], Duration::from_secs(5)).await;
    assert_eq!(
        counter.park_call_count(),
        1,
        "park() should have been called exactly once"
    );
    assert_eq!(
        counter.unpark_call_count(),
        0,
        "unpark() must not be called for a fresh park"
    );
    assert_eq!(idle_pool.lock().await.len(), 1, "sandbox should be parked");

    shutdown(&env, run_handle).await;
}
