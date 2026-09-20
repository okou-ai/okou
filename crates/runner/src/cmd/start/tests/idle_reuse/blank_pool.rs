use super::super::super::*;
use super::super::support::{
    TestParkedIdleCandidateSpec, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_overrides, push_job, seed_idle_pool_with_timing,
    seed_workspace_cache_state, shutdown, test_profiles, two_profiles, wait_budget_count,
    wait_idle_pool_len,
};
use super::blank_session_history::history_context;

use crate::paths::RunnerPaths;
use crate::types::{SandboxReuseResult, WorkspaceReuseResult};
use crate::workspace_image_cache::WorkspaceImageCache;

#[tokio::test(start_paused = true)]
async fn blank_pool_prepares_and_serves_a_job_without_changing_reuse_attribution() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(calls.blank_park_call_count(), 1);
    assert_eq!(calls.workspace_drive_mount_calls(), 1);
    let create_configs = calls.create_configs();
    assert_eq!(create_configs.len(), 1);
    assert!(
        create_configs[0]
            .workspace_drive
            .as_ref()
            .expect("blank sandbox should have a workspace drive")
            .seed_image
            .is_none()
    );
    assert_eq!(calls.start_run_control_ids(), vec![None]);
    assert!(calls.run_control_bind_calls().is_empty());
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::NotConfigured)
    );
    assert_eq!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(calls.workspace_drive_mount_calls(), 1);

    shutdown(&env, run_handle).await;
    let status: serde_json::Value = serde_json::from_str(
        &tokio::fs::read_to_string(env._temp_dir.path().join("status.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["mode"], "stopped");
    assert!(status.get("idle_sandboxes").is_none());
    assert!(status.get("blank_sandboxes").is_none());
}

#[tokio::test(start_paused = true)]
async fn full_capacity_claims_compatible_blank_before_pressure_eviction() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
    let parked_at = std::time::Instant::now();
    for reuse_key in [
        "capacity-1",
        "capacity-2",
        "capacity-3",
        "capacity-4",
        "capacity-5",
        "capacity-6",
    ] {
        seed_idle_pool_with_timing(
            &idle_pool,
            &budget,
            TestParkedIdleCandidateSpec {
                reuse_key,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 4096,
                history_generation_run_id: None,
                parked_at,
            },
        )
        .await;
    }
    assert_eq!(budget.allocated().2, 7);

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("full-capacity job should claim the compatible blank");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_eq!(completion.sandbox_id, Some(blank_sandbox_id));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn exact_idle_that_parks_during_claim_takes_priority_over_reserved_blank() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
    env.handle.block_claims();

    let run_id = RunId::new_v4();
    let reuse_key = "claim-time-exact-priority";
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, reuse_key)),
    );
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await,
        "provider claim did not reach its boundary"
    );
    seed_idle_pool_with_timing(
        &idle_pool,
        &budget,
        TestParkedIdleCandidateSpec {
            reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: None,
            parked_at: std::time::Instant::now(),
        },
    )
    .await;
    let exact_sandbox_id = idle_pool
        .lock()
        .await
        .status_snapshot()
        .idle_sandboxes
        .into_iter()
        .find(|sandbox| sandbox.sandbox_id != blank_sandbox_id)
        .expect("exact sandbox should be parked during claim")
        .sandbox_id;

    env.handle.unblock_claims();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should use the exact sandbox that parked during claim");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(exact_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn full_exact_pool_yields_oldest_aged_capacity_to_one_blank() {
    let (config, env) = mock_run_config(test_profiles(), 12, 24_576, 5);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let now = std::time::Instant::now();
    for (reuse_key, idle_for) in [
        ("oldest-aged", Duration::from_secs(45 * 60)),
        ("newer-aged", Duration::from_secs(31 * 60)),
        ("young-1", Duration::from_secs(29 * 60)),
        ("young-2", Duration::from_secs(20 * 60)),
        ("young-3", Duration::from_secs(10 * 60)),
    ] {
        seed_idle_pool_with_timing(
            &idle_pool,
            &budget,
            TestParkedIdleCandidateSpec {
                reuse_key,
                profile_name: "vm0/default",
                vcpu: 2,
                memory_mb: 4096,
                history_generation_run_id: None,
                parked_at: now - idle_for,
            },
        )
        .await;
    }
    assert_eq!(budget.allocated().2, 5);
    let mut pool_changes = idle_pool.lock().await.subscribe_changes();
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if idle_pool.lock().await.blank_len() == 1 {
                break;
            }
            pool_changes
                .changed()
                .await
                .expect("idle pool change channel should remain open");
        }
    })
    .await
    .expect("aged exact capacity should become a blank sandbox");

    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.len(), 5);
        assert_eq!(pool.blank_len(), 1);
        assert!(!pool.has_reusable("oldest-aged", "vm0/default", &None));
        assert!(pool.has_reusable("newer-aged", "vm0/default", &None));
        assert!(pool.has_reusable("young-1", "vm0/default", &None));
    }
    assert_eq!(budget.allocated().2, 5);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn blank_mount_failure_destroys_sandbox_before_releasing_budget() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.push_workspace_drive_mount_result(Ok(sandbox::ExecResult::new(
        64,
        Vec::new(),
        b"simulated workspace mount failure".to_vec(),
    )));
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("failed blank mount should enter factory destroy");
    assert_eq!(calls.workspace_drive_mount_calls(), 1);
    assert_eq!(idle_pool.lock().await.blank_len(), 0);
    assert_eq!(
        budget.allocated().2,
        1,
        "blank budget must remain owned until physical destroy completes"
    );

    destroy_gate.release_many(1);
    shutdown(&env, run_handle).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}

#[tokio::test(start_paused = true)]
async fn blank_backed_run_becomes_exact_reuse_and_wins_over_refilled_blank() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;
    let reuse_key = "session-blank-to-exact";

    let first_run_id = RunId::new_v4();
    push_job(
        &env,
        first_run_id,
        "vm0/default",
        Some(context_with_session(first_run_id, reuse_key)),
    );
    let first = env
        .handle
        .wait_completion(first_run_id, Duration::from_secs(5))
        .await
        .expect("blank-backed job should complete");

    assert_eq!(first.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(first.sandbox_id, Some(blank_sandbox_id));
    wait_idle_pool_len(&idle_pool, 2, Duration::from_secs(5)).await;
    {
        let pool = idle_pool.lock().await;
        assert_eq!(pool.blank_len(), 1);
        assert!(pool.has_reusable(reuse_key, "vm0/default", &None));
    }

    let second_run_id = RunId::new_v4();
    push_job(
        &env,
        second_run_id,
        "vm0/default",
        Some(context_with_session(second_run_id, reuse_key)),
    );
    let second = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("exact-reuse job should complete");

    assert_eq!(second.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(second.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn blank_unpark_failure_falls_back_without_changing_cold_attribution() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let history = b"{\"type\":\"init\"}\n";
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history");
            then.status(200).body(history);
        })
        .await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated blank unpark failure".into(),
    }));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    let mut context = history_context(run_id, server.url("/history"), history);
    context.reuse_key = Some("session-blank-unpark-failure".into());
    push_job(&env, run_id, "vm0/default", Some(context));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh fallback should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(calls.unpark_call_count(), 1);
    assert_eq!(calls.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
    history_mock.assert_calls_async(1).await;
}

#[tokio::test(start_paused = true)]
async fn foreground_admission_drains_cancelled_blank_start_before_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let start_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_start_lifecycle_gate(start_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let run_handle = tokio::spawn(run(config));

    start_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("blank sandbox start should enter the lifecycle gate");

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(
            run_id,
            "session-cancelled-blank-start",
        )),
    );
    start_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("foreground start should acquire admission while blank start drains");
    assert_eq!(
        calls.destroy_call_count(),
        0,
        "blank sandbox must remain owned until its in-flight start completes"
    );

    start_gate.release_many(2);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("foreground job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(calls.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn foreground_admission_drains_cancelled_blank_mount_before_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let mount_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_workspace_drive_mount_lifecycle_gate(mount_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let run_handle = tokio::spawn(run(config));

    assert!(
        calls
            .wait_workspace_drive_mount_call_count(1, Duration::from_secs(5))
            .await,
        "blank sandbox mount should enter the lifecycle gate"
    );

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(
            run_id,
            "session-cancelled-blank-mount",
        )),
    );
    assert!(
        calls
            .wait_workspace_drive_mount_call_count(2, Duration::from_secs(5))
            .await,
        "foreground mount should acquire admission while blank mount drains"
    );
    assert_eq!(
        calls.destroy_call_count(),
        0,
        "blank sandbox must remain owned until its in-flight mount completes"
    );

    mount_gate.release_many(2);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("foreground job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(calls.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn foreground_admission_cancels_blank_create_without_leaking_ownership() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let create_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_create_lifecycle_gate(create_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    create_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("blank sandbox create should enter the lifecycle gate");

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(
            run_id,
            "session-cancelled-blank-create",
        )),
    );
    create_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("foreground create should acquire admission after blank cancellation");
    assert_eq!(calls.destroy_call_count(), 0);
    assert_eq!(
        budget.allocated().2,
        1,
        "cancelled blank create must release its resource lease"
    );

    create_gate.release_many(2);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("foreground job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(calls.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn foreground_admission_drains_cancelled_blank_park_before_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let park_gate = sandbox_mock::MockLifecycleGate::new();
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let run_handle = tokio::spawn(run(config));

    park_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("blank sandbox park should enter the lifecycle gate");

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "session-cancelled-blank-park")),
    );
    park_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("foreground job should reach final park while blank park drains");
    assert_eq!(
        calls.destroy_call_count(),
        0,
        "blank sandbox must remain owned until its in-flight park completes"
    );

    park_gate.release_many(2);
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("cancelled blank sandbox should enter destroy after park completes");
    destroy_gate.release_many(2);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("foreground job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(calls.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn blank_park_and_kill_panics_keep_budget_owned_through_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let calls = Arc::clone(&overrides);
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.push_park_panic("simulated blank park panic");
    overrides.push_kill_panic("simulated blank kill panic");
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("panicked blank lifecycle should still reach factory destroy");
    assert_eq!(calls.destroy_call_count(), 1);
    assert_eq!(
        budget.allocated().2,
        1,
        "blank budget must remain owned until physical destroy completes"
    );

    destroy_gate.release_many(1);
    shutdown(&env, run_handle).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}

#[tokio::test(start_paused = true)]
async fn incompatible_profile_fresh_creates_without_consuming_blank_inventory() {
    let (config, env) = mock_run_config(two_profiles(), 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/large", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn workspace_cache_hit_takes_priority_over_compatible_blank_inventory() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    let reuse_key = "thread:blank-pool-workspace-priority";
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, "workspace-priority-session");
    context.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(context));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused)
    );
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));
    assert_eq!(idle_pool.lock().await.blank_len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn claimed_workspace_cache_metadata_takes_priority_over_reserved_blank() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let history = b"{\"type\":\"init\"}\n";
    let history_mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/history");
            then.status(200).body(history);
        })
        .await;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 16, 32_768, 8);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    let reuse_key = "thread:blank-pool-claimed-workspace-priority";
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_idle_pool_len(&idle_pool, 1, Duration::from_secs(5)).await;
    let blank_sandbox_id = idle_pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let run_id = RunId::new_v4();
    let mut context = history_context(run_id, server.url("/history"), history);
    context.reuse_key = Some(reuse_key.into());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(JobCandidate::new(run_id, "vm0/default".into()))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claimed workspace metadata should override the reserved blank");

    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::Reused)
    );
    assert_ne!(completion.sandbox_id, Some(blank_sandbox_id));

    shutdown(&env, run_handle).await;
    history_mock.assert_calls_async(1).await;
}
