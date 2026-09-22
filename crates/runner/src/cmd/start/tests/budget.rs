use super::super::*;
use super::support::{
    TestParkedIdleCandidateSpec, assert_run_exits_within, context_with_session, minimal_context,
    mock_run_config, mock_run_config_with_overrides, push_job, seed_idle_pool_with_overrides,
    seed_idle_pool_with_timing, shutdown, status_idle_reuse_keys, test_profiles, two_profiles,
    wait_budget_count, wait_cancel_token, wait_discover_entered,
    wait_status_idle_reuse_keys_and_active_runs,
};

#[test]
fn host_cpu_placement_policy_uses_worker_mode_and_budget_ratio() {
    let budget = ResourceBudget::new(4, 32_768, 2.0, 8);

    let production = host_cpu_placement_config(&budget, false).unwrap();
    assert_eq!(production.control_weight(), 200);
    assert_eq!(production.guests_weight(), 9_800);
    assert_eq!(production.mode(), sandbox::HostCpuPlacementMode::Required);

    let local = host_cpu_placement_config(&budget, true).unwrap();
    assert_eq!(local.control_weight(), 200);
    assert_eq!(local.guests_weight(), 9_800);
    assert_eq!(local.mode(), sandbox::HostCpuPlacementMode::PreferManaged);
}

// -----------------------------------------------------------------------
// Test 11: Budget full → job skipped (not claimed) → budget freed → next job succeeds
//
// Different from test 4 (claim failure): here try_reserve returns false
// so claim() is never called. The job stays in the channel but the main
// loop moves on. After the running job completes and frees budget, the
// next discover picks up the waiting job.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn budget_full_skips_then_resumes() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    // Budget for exactly 1 job (2 vcpu, 4096 MB).
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    // First job: claims the entire budget.
    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));

    let _token_1 = wait_cancel_token(&env.cancel_tokens, id1, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    // Second job: pushed while budget is full. It must remain queued until
    // the first job releases its budget lease.
    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));

    // Job 1 completes after the gate opens → budget freed.
    gate.notify_one();
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");

    // After budget is freed, the main loop re-enters the normal select!
    // and discovers job 2 from the channel.
    let _token_2 = wait_cancel_token(&env.cancel_tokens, id2, Duration::from_secs(5)).await;
    gate.notify_one();
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "second job should complete after budget is freed"
    );

    shutdown(&env, run_handle).await;
}

/// Budget-exhausted mode must not poll discovery. A queued job should
/// remain undiscovered until a running job frees budget, otherwise the
/// runner may claim work it cannot admit.
#[tokio::test(start_paused = true)]
async fn budget_exhausted_buffers_discovery_until_budget_frees() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
    let _token_1 = wait_cancel_token(&env.cancel_tokens, id1, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));
    assert!(
        !env.handle
            .wait_discover_entered(Duration::from_millis(100))
            .await,
        "discovery must not be polled while budget is exhausted"
    );
    assert!(
        !env.cancel_tokens.contains(id2).await,
        "queued job must not be claimed while budget is exhausted",
    );
    assert!(
        env.handle
            .completions
            .lock()
            .unwrap()
            .iter()
            .all(|c| c.run_id != id2),
        "queued job must not complete before budget frees",
    );

    gate.notify_one();
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");

    let _token_2 = wait_cancel_token(&env.cancel_tokens, id2, Duration::from_secs(5)).await;
    gate.notify_one();
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "queued job should complete after budget is freed",
    );
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 15: Idle sandboxes remain reusable until capacity is needed
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn idle_sandbox_remains_reusable_until_capacity_is_needed() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let now = std::time::Instant::now();

    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkedIdleCandidateSpec {
            reuse_key: "sess-old",
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: None,
            parked_at: now - Duration::from_secs(3600),
        },
    )
    .await;
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "should have 1 seeded entry"
    );
    assert_eq!(budget.allocated().2, 1, "seeded entry holds budget");

    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    tokio::time::advance(Duration::from_secs(3600)).await;
    assert_eq!(idle_pool.lock().await.len(), 1, "idle age must not evict");
    assert_eq!(budget.allocated().2, 1, "aged idle sandbox keeps its lease");

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-old")),
    );
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("aged idle sandbox should remain reusable");
    assert_eq!(
        completion.reuse_result,
        Some(runner_types::types::SandboxReuseResult::Reused)
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 16: Budget exhausted → evict idle sandbox → admit new job
// -----------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn budget_pressure_starts_fresh_sandbox_before_idle_destroy_finishes() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    fresh_overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    // Budget: exactly 1 default job (2 vcpu, 4096 MB).
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 2, Arc::clone(&fresh_overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);

    // Pre-seed: idle sandbox fills the entire budget.
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "sess-evict",
        "vm0/default",
        2,
        4096,
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "budget should be exhausted after seeding"
    );

    let run_handle = tokio::spawn(run(config));

    // Push new job — budget is full, but idle pool has an entry to evict.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("idle sandbox should enter tracked destroy");
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("fresh sandbox should activate while idle destroy is blocked");
    assert_eq!(
        budget.allocated(),
        (2, 4096, 1),
        "incoming lease should atomically replace the idle lease"
    );
    assert_eq!(idle_pool.lock().await.len(), 0);

    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh job should complete while retired idle cleanup remains blocked");
    assert_eq!(completion.exit_code, 0);

    env.drain();
    env.cancel.cancel();
    env.start_observer
        .wait_destroy_tasks_drain_entered(Duration::from_secs(5))
        .await;
    assert!(
        !env.start_observer.destroy_tasks_drain_was_completed(),
        "shutdown must wait for the tracked retired idle destroy"
    );
    destroy_gate.release_one();
    env.start_observer
        .wait_destroy_tasks_drain_completed(Duration::from_secs(5))
        .await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "shutdown should finish after retired idle destroy completes",
    )
    .await;
}

#[tokio::test]
async fn fresh_create_failure_does_not_cancel_retired_idle_destroy() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    fresh_overrides.push_create_result(Err(sandbox::SandboxError::Initialization {
        phase: sandbox::SandboxInitializationPhase::SandboxAllocation,
        message: "create failed after idle retirement".into(),
    }));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, fresh_overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "sess-create-failure-retirement",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("idle destroy should remain tracked before fresh creation");
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh create failure should report completion without waiting for old destroy");
    assert_eq!(completion.exit_code, 1);
    assert!(
        completion
            .error
            .is_some_and(|error| error.contains("create failed after idle retirement"))
    );
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(destroy_gate.entered_count(), 1);

    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn smaller_fresh_profile_releases_only_net_idle_capacity() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(two_profiles(), 5, 8192, 2, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-large-idle",
        "vm0/large",
        4,
        8192,
    )
    .await;

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("large idle sandbox should enter tracked destroy");
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("smaller fresh sandbox should activate before destroy completes");
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(
        budget.can_afford(2, 4096),
        "unused half of the retired large lease should remain admittable"
    );

    destroy_gate.release_one();
    wait_gate.release_one();
    destroy_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("fresh sandbox should enter normal active cleanup");
    destroy_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("smaller fresh job should complete");
    assert_eq!(completion.exit_code, 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn budget_pressure_evicts_oldest_idle_regardless_of_age() {
    let (config, env) = mock_run_config(two_profiles(), 7, 12288, 3);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let now = std::time::Instant::now();

    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkedIdleCandidateSpec {
            reuse_key: "sess-old-active",
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: None,
            parked_at: now - Duration::from_secs(100),
        },
    )
    .await;
    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkedIdleCandidateSpec {
            reuse_key: "sess-newer-large",
            profile_name: "vm0/large",
            vcpu: 4,
            memory_mb: 8192,
            history_generation_run_id: None,
            parked_at: now - Duration::from_secs(10),
        },
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "seeded idle entries should exhaust budget"
    );

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job should complete after oldest idle capacity is reclaimed"
    );
    assert_eq!(completion.unwrap().exit_code, 0);

    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let reuse_keys = idle_pool.lock().await.held_reuse_keys();
    assert_eq!(
        reuse_keys,
        vec!["sess-newer-large".to_string()],
        "oldest idle entry should be reclaimed regardless of age"
    );
    assert_eq!(
        status_idle_reuse_keys(&status_path).await,
        vec!["sess-newer-large".to_string()],
        "status.json should reflect the remaining idle sandbox"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn larger_profile_batches_required_oldest_idle_entries_before_status_write() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    fresh_overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(two_profiles(), 7, 12288, 4, fresh_overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let status_write_started = Arc::new(tokio::sync::Notify::new());
    let status_write_release = Arc::new(tokio::sync::Semaphore::new(0));
    let status = Arc::new(StatusTracker::new_with_write_gate(
        status_path.clone(),
        3,
        Arc::clone(&status_write_started),
        Arc::clone(&status_write_release),
    ));
    config.shared.status = Arc::clone(&status);

    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "sess-a-oldest",
        "vm0/default",
        2,
        4096,
    )
    .await;
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "sess-b-middle",
        "vm0/default",
        2,
        4096,
    )
    .await;
    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &idle_overrides,
        "sess-c-newest",
        "vm0/default",
        2,
        4096,
    )
    .await;
    assert!(
        !budget.can_afford(4, 8192),
        "seeded idle entries should exhaust budget"
    );

    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    let idle_write_started = status_write_started.notified();
    push_job(&env, run_id, "vm0/large", Some(minimal_context(run_id)));
    tokio::select! {
        () = idle_write_started => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("large run completed before batched idle status write: {completion:?}");
        }
    }

    destroy_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("both required idle destroys should be tracker-owned before status persistence");
    assert_eq!(wait_gate.entered_count(), 0);
    assert_eq!(status.idle_info_update_request_count(), 1);
    assert_eq!(budget.allocated(), (6, 12288, 2));

    let reuse_keys = idle_pool.lock().await.held_reuse_keys();
    assert_eq!(
        reuse_keys,
        vec!["sess-c-newest".to_string()],
        "only the newest unneeded idle entry should remain"
    );

    status_write_release.add_permits(1);
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("large fresh sandbox should activate after one idle status write");
    assert_eq!(status.idle_info_update_request_count(), 1);
    assert_eq!(
        status_idle_reuse_keys(&status_path).await,
        vec!["sess-c-newest".to_string()],
        "status.json should reflect only the remaining idle sandbox"
    );

    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("large job should complete while retired cleanup remains blocked");
    assert_eq!(completion.exit_code, 0);
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    destroy_gate.release_one();
    destroy_gate.release_one();
    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn idle_sandbox_is_reclaimed_only_after_candidate_discovery() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 2);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-pressure-status")),
    );
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete and park");
    assert_eq!(completion.unwrap().exit_code, 0);

    // The single parked sandbox fills the whole budget. It must remain reusable
    // until a concrete candidate proves that generic capacity is needed.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        1,
        "idle sandbox should be retained"
    );
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &["sess-pressure-status"],
        &[],
        Duration::from_secs(5),
    )
    .await;

    let generic_run_id = RunId::new_v4();
    push_job(
        &env,
        generic_run_id,
        "vm0/default",
        Some(minimal_context(generic_run_id)),
    );
    let generic_completion = env
        .handle
        .wait_completion(generic_run_id, Duration::from_secs(5))
        .await;
    assert!(
        generic_completion.is_some(),
        "generic job should run after candidate-aware idle reclamation"
    );

    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(idle_pool.lock().await.len(), 0, "idle pool should be empty");
    assert!(
        status_idle_reuse_keys(&status_path).await.is_empty(),
        "status.json should clear the candidate-reclaimed idle sandbox"
    );

    shutdown(&env, run_handle).await;
}
