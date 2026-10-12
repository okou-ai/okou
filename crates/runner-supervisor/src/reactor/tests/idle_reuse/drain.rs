use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, context_with_session, mock_run_config, mock_run_config_with_overrides,
    push_job, seed_idle_pool, seed_idle_pool_with_overrides, shutdown, test_profiles,
    wait_cancel_token, wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_reuse_keys,
    wait_parking_state, wait_status_idle_reuse_keys_and_active_runs, wait_status_mode,
};

use crate::SharedFactory;
use crate::idle_pool::{ParkResult, ParkingState, test_support::ParkedIdleCandidateBuilder};
use sandbox::SandboxId;

#[tokio::test]
async fn soft_drain_processes_resume_and_stopping_while_destroy_is_blocked() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "blocked-soft-drain",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    env.drain();
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    env.resume();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    env.trigger_stopping().await;
    env.start_observer
        .wait_destroy_tasks_drain_entered(Duration::from_secs(5))
        .await;
    assert!(!env.start_observer.destroy_tasks_drain_was_completed());
    assert_eq!(budget.allocated().2, 1);
    destroy_gate.release_one();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "shutdown must join the independent soft drain",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn renewed_soft_drain_waits_for_inventory_parked_after_resume() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "first-drain",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    env.drain();
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let factory: SharedFactory = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let sandbox_id = SandboxId::new_v4();
    let sandbox = factory
        .create(sandbox::SandboxConfig {
            id: sandbox_id,
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            home_drive: None,
        })
        .await
        .unwrap();
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let candidate = ParkedIdleCandidateBuilder::new("after-resume", lease)
        .with_sandbox_id(sandbox_id)
        .with_sandbox(sandbox)
        .with_factory(factory)
        .build();
    {
        let mut pool = idle_pool.lock().await;
        // No yield between lifecycle transitions: the watch may expose only
        // the renewed Draining value to the reactor.
        env.resume();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        env.drain();
    }
    destroy_gate.release_one();
    destroy_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .unwrap();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    let wire: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&status_path).await.unwrap()).unwrap();
    assert_eq!(
        wire["mode"], "draining",
        "a prior drain must not complete the resumed generation"
    );
    assert_eq!(budget.allocated().2, 1);
    destroy_gate.release_one();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "renewed drain must wait for its own batch",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

// -----------------------------------------------------------------------
// Test 17: Shutdown drains idle pool and releases budget
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn shutdown_drains_idle_pool() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);

    // Pre-seed: two idle entries holding budget.
    seed_idle_pool(&idle_pool, &budget, "sess-drain-1", "vm0/default", 2, 4096).await;
    seed_idle_pool(&idle_pool, &budget, "sess-drain-2", "vm0/default", 2, 4096).await;
    assert_eq!(idle_pool.lock().await.len(), 2);
    assert_eq!(budget.allocated().2, 2);

    let run_handle = tokio::spawn(run(config));

    // Immediately shutdown — drain should destroy all idle entries.
    shutdown(&env, run_handle).await;

    // After shutdown: pool empty, budget fully released.
    assert_eq!(idle_pool.lock().await.len(), 0, "pool should be drained");
    let (_, _, count) = budget.allocated();
    assert_eq!(count, 0, "all budget should be released after drain");
}

/// Active soft drain closes parking for successful jobs that complete
/// before SIGUSR2 resume. The sandbox is destroyed and budget is released
/// instead of late-parking into an already-drained pool.
#[tokio::test]
async fn job_completing_during_active_draining_is_not_parked() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "pending-idle-cleanup",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    // Claim a gated job with a reusable session while Running.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-late-park")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining with an independently blocked idle cleanup and active job.
    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "Draining mode should have detached idle inventory",
    );

    // Release the gate while still Draining: parking is closed, so the
    // successful job destroys its sandbox instead of parking it.
    gate.notify_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete");
    assert_eq!(c.unwrap().exit_code, 0);
    // Only the reactor's job-result branch retires this registration. It must
    // progress while the separate idle cleanup still owns its lease.
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 1);

    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "active draining must reject post-job parking",
    );

    destroy_gate.release_one();
    // The accepted idle batch and active job both settle before natural stop.
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "natural drain should exit within 5s",
    )
    .await;

    // Leak proof: pool empty, budget fully released.
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "teardown must leave no idle sandbox",
    );
    assert_eq!(
        budget.allocated().2,
        0,
        "budget must be fully released (no held entries, no stray reservations)",
    );
}

/// Regression for #11162: once SIGUSR2 has logically resumed the runner,
/// parking is open even if the main loop has not yet processed the Running
/// tick. The silent mode flip keeps the main loop in the pre-ack window
/// deterministically.
#[tokio::test]
async fn soft_drain_resume_opens_parking_before_running_ack() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-soft-resume-race")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;

    // Simulate SIGUSR2's ordering while suppressing the watch wake: open
    // parking first, then make Running visible without letting the main
    // loop run its top-of-loop Running branch.
    env.parking_gate.open_after_soft_drain();
    env.mode_tx.send_if_modified(|mode| {
        *mode = RunnerMode::Running;
        false
    });
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Running);

    gate.notify_one();
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete after logical resume");
    assert_eq!(c.unwrap().exit_code, 0);

    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "job should park even before the main loop acknowledges Running",
    );
    assert_eq!(
        budget.allocated().2,
        1,
        "parked sandbox should retain its budget lease",
    );

    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s",
    )
    .await;
}

/// Regression (G2): on SIGTERM from Running, teardown's
/// `drain_idle_pool` is the *only* site that clears `idle_sandboxes` in
/// `status.json` — Draining mode is skipped entirely. Pre-fix, the
/// stale list leaked into the final `"stopped"` snapshot.
#[tokio::test(start_paused = true)]
async fn shutdown_clears_idle_sandboxes_in_status_json() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    // Park a sandbox via a normal job → status.json records the idle sandbox.
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-status-clean")),
    );
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-status-clean"], Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 1, "sandbox parked");

    // Pre-shutdown sanity: status.json lists the idle sandbox.
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &["sess-status-clean"],
        &[],
        Duration::from_secs(5),
    )
    .await;
    let pre: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    let pre_len = pre
        .get("idle_sandboxes")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(
        pre_len, 1,
        "pre-shutdown status.json should list the sandbox"
    );

    // SIGTERM path: Draining mode is bypassed, so teardown's
    // drain_idle_pool is the only site that can clear idle_sandboxes.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s",
    )
    .await;

    // Post-shutdown: mode=stopped, idle_sandboxes empty/absent.
    let post: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert_eq!(post["mode"], "stopped");
    let post_len = post
        .get("idle_sandboxes")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(
        post_len, 0,
        "status.json idle_sandboxes must be cleared after shutdown: {post}",
    );
}
