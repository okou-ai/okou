use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides, push_job, seed_idle_pool, shutdown,
    test_profiles, wait_budget_count, wait_cancel_handle, wait_cancel_token_removed,
    wait_status_idle_reuse_keys_and_active_runs, wait_workspace_cache_reuse_keys,
};
use super::support::assert_successful_completion_for_run;

use crate::idle_pool::ParkingState;
use crate::paths::RunnerPaths;
use crate::workspace_image_cache::WorkspaceImageCache;
use sandbox_mock::MockLifecycleGate;

fn severe_memory_retention() -> sandbox::SandboxParkOutcome {
    sandbox::SandboxParkOutcome::NonReusable(
        sandbox::SandboxParkNonReusableReason::SevereMemoryRetention(Box::new(
            sandbox::SevereMemoryRetentionDiagnostics {
                requested_target_mib: 3584,
                first_observed_target_mib: Some(3584),
                observed_target_mib: Some(3584),
                target_observed: true,
                first_actual_mib: Some(2048),
                previous_actual_mib: Some(2300),
                actual_mib: Some(2448),
                max_actual_mib: Some(2448),
                deficit_mib: Some(1136),
                actual_delta_mib: Some(400),
                elapsed_ms: 5000,
                sample_count: 9,
                reported_free_memory_bytes: Some(8 * 1024 * 1024),
                reported_available_memory_bytes: Some(8 * 1024 * 1024),
                reported_total_memory_bytes: Some(4_i64 * 1024 * 1024 * 1024),
                reported_swap_in_bytes: Some(11),
                reported_swap_out_bytes: Some(12),
                reported_major_faults: Some(13),
                reported_minor_faults: Some(14),
                reported_disk_caches_bytes: Some(15),
                progress_extension_blocker: Some("fresh_guest_available_reserve_insufficient"),
                guest_memory_snapshot_attempted: true,
                guest_memory_snapshot: Some(sandbox::GuestMemorySnapshot {
                    mem_total_bytes: 1,
                    mem_free_bytes: 2,
                    mem_available_bytes: 3,
                    buffers_bytes: 4,
                    cached_bytes: 5,
                    anon_pages_bytes: 6,
                    mapped_bytes: 7,
                    dirty_bytes: 8,
                    writeback_bytes: 9,
                    shmem_bytes: 10,
                    slab_bytes: 11,
                    slab_reclaimable_bytes: 12,
                    slab_unreclaimable_bytes: 13,
                    unevictable_bytes: 14,
                    kernel_stack_bytes: 15,
                    page_tables_bytes: 16,
                    swap_total_bytes: 17,
                    swap_free_bytes: 18,
                }),
            },
        )),
    )
}

/// When `Sandbox::park()` returns an error, the runner falls back to
/// `stop_and_destroy_sandbox` and does NOT insert into the idle pool.
#[tokio::test(start_paused = true)]
async fn park_failure_destroys_sandbox_and_skips_pool() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Park,
        message: "simulated balloon failure".into(),
    }));
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-fail")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "job should complete normally");
    assert_eq!(c.unwrap().exit_code, 0);

    // park failure → destroy → budget fully released, pool empty.
    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "park failure must NOT insert into pool"
    );
    assert_eq!(
        counter.park_call_count(),
        1,
        "park() should have been attempted exactly once"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn park_failure_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_park_cleanup(
        "sess-park-fail-cache",
        |overrides| {
            overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Park,
                message: "simulated balloon failure".into(),
            }));
        },
        true,
        0,
    )
    .await;
}

#[tokio::test]
async fn non_reusable_park_destroy_panic_preserves_workspace_cache_and_cleanup() {
    assert_workspace_cache_after_park_cleanup(
        "sess-severe-retention-destroy-panic-cache",
        |overrides| {
            overrides.push_park_result(Ok(severe_memory_retention()));
            overrides.push_destroy_panic("simulated non-reusable destroy panic");
        },
        true,
        1,
    )
    .await;
}

#[tokio::test]
async fn park_panic_skips_workspace_cache_before_destroy() {
    assert_workspace_cache_after_park_cleanup(
        "sess-park-panic-cache",
        |overrides| overrides.push_park_panic("simulated park panic"),
        false,
        0,
    )
    .await;
}

async fn assert_workspace_cache_after_park_cleanup(
    session_id: &str,
    configure_park: impl FnOnce(&sandbox_mock::MockSandboxOverrides),
    expect_cache: bool,
    expected_unpark_calls: u32,
) {
    let wait_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    configure_park(&overrides);
    let counter = Arc::clone(&overrides);

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let context = context_with_session(run_id, session_id);
    push_job(&env, run_id, "vm0/default", Some(context));

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the active workspace image is written");
    let sandbox_id = counter
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    counter.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete normally after park cleanup destroy");
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(counter.unpark_call_count(), expected_unpark_calls);
    assert_eq!(counter.destroy_call_count(), 1);
    if expect_cache {
        wait_workspace_cache_reuse_keys(&workspace_cache, &[session_id], Duration::from_secs(2))
            .await;
    } else {
        let held = workspace_cache.held_workspace_states().await;
        assert!(held.is_empty());
    }

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn non_reusable_park_keeps_budget_until_destroy_and_never_enters_idle_status() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Ok(severe_memory_retention()));
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-severe-retention")),
    );

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "non-reusable parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "non-reusable parked sandbox should be sent to destroy exactly once",
        "non-reusable parked sandbox must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "non-reusable parked sandbox must never enter the idle pool",
    )
    .await;
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
        "host completion should report while non-reusable sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    assert_post_destroy_cleanup(&budget, &idle_pool, None, run_id, 0, 0).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(counter.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn repeated_non_reusable_parks_use_fresh_sandboxes() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Ok(severe_memory_retention()));
    overrides.push_park_result(Ok(severe_memory_retention()));
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    for run_id in [RunId::new_v4(), RunId::new_v4()] {
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(
                run_id,
                "sess-repeated-severe-retention",
            )),
        );
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .expect("successful job should complete after non-reusable sandbox destroy");
        assert_eq!(completion.exit_code, 0);
        assert!(completion.error.is_none());
        wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
        assert_idle_pool_len(
            &idle_pool,
            0,
            "repeated non-reusable sandboxes must never cycle through the idle pool",
        )
        .await;
    }

    assert_eq!(counter.create_configs().len(), 2);
    assert_eq!(counter.park_call_count(), 2);
    assert_eq!(counter.unpark_call_count(), 0);
    assert_eq!(counter.destroy_call_count(), 2);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_during_sandbox_park_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_late_cancellation(
        "sess-cancel-during-park-cache",
        LateCancellationPoint::DuringPark,
    )
    .await;
}

#[tokio::test]
async fn cancellation_before_idle_pool_transfer_promotes_workspace_cache_before_destroy() {
    assert_workspace_cache_after_late_cancellation(
        "sess-cancel-before-pool-cache",
        LateCancellationPoint::BeforeIdlePoolTransfer,
    )
    .await;
}

enum LateCancellationPoint {
    DuringPark,
    BeforeIdlePoolTransfer,
}

async fn wait_lifecycle_gate_entered(gate: &MockLifecycleGate, message: &str) {
    assert_eq!(
        gate.wait_entered(1, Duration::from_secs(5))
            .await
            .expect(message),
        1
    );
}

fn assert_destroy_in_flight(
    counter: &sandbox_mock::MockSandboxOverrides,
    budget: &ResourceBudget,
    expected_budget_count: usize,
    destroy_message: &str,
    budget_message: &str,
) {
    assert_eq!(counter.destroy_call_count(), 1, "{destroy_message}");
    assert_eq!(
        budget.allocated().2,
        expected_budget_count,
        "{budget_message}"
    );
}

async fn assert_idle_pool_len(idle_pool: &SharedIdlePool, expected_len: usize, message: &str) {
    assert_eq!(idle_pool.lock().await.len(), expected_len, "{message}");
}

async fn assert_post_destroy_cleanup(
    budget: &ResourceBudget,
    idle_pool: &SharedIdlePool,
    cancel_tokens: Option<&RunCancellationRegistry>,
    run_id: RunId,
    expected_budget_count: usize,
    expected_idle_len: usize,
) {
    wait_budget_count(budget, expected_budget_count, Duration::from_secs(2)).await;
    if let Some(cancel_tokens) = cancel_tokens {
        wait_cancel_token_removed(cancel_tokens, run_id, Duration::from_secs(2)).await;
    }
    assert_eq!(idle_pool.lock().await.len(), expected_idle_len);
}

async fn assert_workspace_cache_after_late_cancellation(
    session_id: &str,
    cancellation_point: LateCancellationPoint,
) {
    let wait_gate = MockLifecycleGate::new();
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let counter = Arc::clone(&overrides);

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    let context = context_with_session(run_id, session_id);
    push_job(&env, run_id, "vm0/default", Some(context));
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the active workspace image is written");
    let sandbox_id = counter
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    counter.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;

    match cancellation_point {
        LateCancellationPoint::DuringPark => {
            cancel_handle.request_hard_cancellation().await;
            park_gate.release_one();
        }
        LateCancellationPoint::BeforeIdlePoolTransfer => {
            let pool_guard = idle_pool.lock().await;
            park_gate.release_one();
            env.start_observer
                .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
                .await;
            cancel_handle.request_hard_cancellation().await;
            drop(pool_guard);
        }
    }

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled sandbox should be sent to destroy exactly once",
        "cancelled sandbox must retain budget while destroy is in-flight",
    );
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report while cancelled sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;
    wait_workspace_cache_reuse_keys(&workspace_cache, &[session_id], Duration::from_secs(2)).await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn park_panic_destroys_sandbox_reports_completion_and_releases_budget() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_panic("simulated park panic");
    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-park-panic")),
    );

    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(c.is_some(), "park panic must not skip provider.complete");
    assert_eq!(c.unwrap().exit_code, 0);

    wait_budget_count(&budget, 0, Duration::from_secs(2)).await;
    assert_eq!(idle_pool.lock().await.len(), 0);
    assert_eq!(counter.park_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn pool_full_rejected_sandbox_keeps_budget_until_destroy_and_completion() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    {
        let mut pool = idle_pool.lock().await;
        *pool = IdlePool::new(IdlePoolConfig { max_idle: 1 });
    }
    seed_idle_pool(&idle_pool, &budget, "sess-existing", "vm0/default", 2, 4096).await;
    assert_eq!(budget.allocated().2, 1, "seeded idle entry holds budget");

    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-rejected")),
    );

    wait_lifecycle_gate_entered(&destroy_gate, "pool-full destroy should enter gate").await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        2,
        "rejected sandbox should be sent to destroy",
        "rejected active sandbox must retain its budget while destroy is in-flight",
    );
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report while rejected sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    let pool = idle_pool.lock().await;
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.held_reuse_keys(), vec!["sess-existing"]);
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn parking_gate_closing_after_sandbox_park_rejects_and_waits_for_destroy() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-race-rejected")),
    );

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    assert_eq!(counter.park_call_count(), 1);
    assert_eq!(env.parking_gate.state(), ParkingState::Open);

    env.drain();
    assert_eq!(env.parking_gate.state(), ParkingState::SoftDraining);

    park_gate.release_one();
    wait_lifecycle_gate_entered(
        &destroy_gate,
        "rejected parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "rejected sandbox should be sent to destroy exactly once",
        "rejected sandbox must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "closed gate must reject the candidate instead of parking it",
    )
    .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report while rejected sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    assert_post_destroy_cleanup(&budget, &idle_pool, None, run_id, 0, 0).await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_while_waiting_for_idle_pool_lock_destroys_instead_of_parking() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel-while-locking")),
    );
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    let pool_guard = idle_pool.lock().await;
    park_gate.release_one();
    env.start_observer
        .wait_before_idle_pool_ownership_transfer(run_id, Duration::from_secs(5))
        .await;
    cancel_handle.request_hard_cancellation().await;
    drop(pool_guard);

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled lock-waiting sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled sandbox should be sent to destroy exactly once",
        "cancelled sandbox must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "cancelled sandbox must not enter the idle pool after waiting for the lock",
    )
    .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report while cancelled sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_during_sandbox_park_destroys_instead_of_parking() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Ok(severe_memory_retention()));
    let park_gate = MockLifecycleGate::new();
    let destroy_gate = MockLifecycleGate::new();
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());

    let counter = Arc::clone(&overrides);
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 16384, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let cancel_tokens = config.provider.cancel_tokens.clone();
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-cancel-while-parking")),
    );
    let cancel_handle = wait_cancel_handle(&cancel_tokens, run_id, Duration::from_secs(5)).await;

    wait_lifecycle_gate_entered(&park_gate, "sandbox park should enter gate").await;
    assert_eq!(counter.park_call_count(), 1);

    cancel_handle.request_hard_cancellation().await;
    park_gate.release_one();

    wait_lifecycle_gate_entered(
        &destroy_gate,
        "cancelled parked sandbox should enter destroy gate",
    )
    .await;
    assert_destroy_in_flight(
        &counter,
        &budget,
        1,
        "cancelled sandbox should be sent to destroy exactly once",
        "cancelled sandbox must retain budget while destroy is in-flight",
    );
    assert_idle_pool_len(
        &idle_pool,
        0,
        "cancelled sandbox must not enter the idle pool after park returns",
    )
    .await;
    assert_successful_completion_for_run(
        &env,
        run_id,
        "host completion should report while cancelled sandbox destroy is blocked",
    )
    .await;
    destroy_gate.release_one();

    assert_post_destroy_cleanup(&budget, &idle_pool, Some(&cancel_tokens), run_id, 0, 0).await;

    shutdown(&env, run_handle).await;
}
