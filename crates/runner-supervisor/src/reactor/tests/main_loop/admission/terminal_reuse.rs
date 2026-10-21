use super::*;
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

#[tokio::test]
async fn cooperative_cancellation_cleanup_reuses_generic_sandbox_for_waiting_successor() {
    assert_cleanup_reuses_sandbox(true, 1, None).await;
}

#[tokio::test]
async fn nonzero_exit_cleanup_reuses_generic_sandbox_for_waiting_successor() {
    assert_cleanup_reuses_sandbox(false, 1, None).await;
}

#[tokio::test]
async fn independent_source_takes_precedence_over_unrelated_native_generation() {
    assert_cleanup_reuses_sandbox(true, 1, Some(RunId::new_v4())).await;
}

#[tokio::test]
async fn successful_source_without_native_continuation_uses_generic_activation() {
    assert_cleanup_reuses_sandbox(false, 0, None).await;
}

pub(super) fn generic_finalizing_candidate(
    run_id: RunId,
    reuse_key: &str,
    source: RunId,
    deadline: std::time::Instant,
) -> runner_provider::JobCandidate {
    runner_provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(reuse_key.into()))
        .with_runner_preference(ActiveRunnerPreference::new(
            RunnerProcessIdentity::new(TEST_RUNNER_ID.parse().unwrap(), TEST_HEARTBEAT_GENERATION)
                .unwrap(),
            runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(source),
            deadline,
        ))
}

async fn assert_cleanup_reuses_sandbox(
    cancelled: bool,
    exit_code: i32,
    native_generation: Option<RunId>,
) {
    let process_gate = MockLifecycleGate::new();
    let park_gate = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(process_gate.clone());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(
        1,
        exit_code,
        Vec::new(),
        Vec::new(),
    ));
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:terminal-cleanup-reuse";
    let predecessor = RunId::new_v4();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    push_job(
        &env,
        predecessor,
        "vm0/default",
        Some(context_with_reuse_key(predecessor, reuse_key)),
    );
    process_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    if cancelled {
        let cancellation =
            wait_cancel_handle(&env.cancel_tokens, predecessor, Duration::from_secs(5)).await;
        cancellation.request_cooperative_user_cancellation().await;
        assert!(
            overrides
                .wait_for_process_control_calls(1, Duration::from_secs(5))
                .await
        );
    }
    process_gate.release_one();
    park_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(budget.allocated(), (2, 4096, 1));

    let successor = RunId::new_v4();
    let context = native_generation.map_or_else(
        || context_with_reuse_key(successor, reuse_key),
        |source| context_with_native_source(successor, reuse_key, source),
    );
    env.provider.set_claim_result(successor, Some(context));
    env.handle
        .discover_tx
        .send(
            generic_finalizing_candidate(
                successor,
                reuse_key,
                predecessor,
                std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
            )
            .with_history_generation_run_id(native_generation),
        )
        .unwrap();
    wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_completion(successor, Duration::ZERO)
            .await
            .is_none()
    );
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "waiting must not start a fresh sandbox"
    );

    park_gate.release_one();
    process_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("the waiting successor must activate the newly parked generic sandbox");
    let first = env
        .handle
        .wait_completion(predecessor, Duration::from_secs(5))
        .await
        .unwrap();
    if cancelled || exit_code != 0 {
        assert_ne!(first.exit_code, 0);
    } else {
        assert_eq!(first.exit_code, 0);
    }
    assert_eq!(
        overrides.create_configs().len(),
        1,
        "reuse must not allocate a second sandbox"
    );
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(
        overrides
            .completed_final_exec_park_handoff_points()
            .is_empty(),
        "a provider that completed full park must reuse the parked sandbox"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    park_gate.release_one();
    process_gate.release_one();
    let second = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(second.sandbox_id, first.sandbox_id);
    assert_eq!(second.exit_code, 0);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn resolved_finalizing_preference_consumes_ready_generic_sandbox() {
    assert_ready_sandbox(false).await;
}

#[tokio::test]
async fn source_exact_preference_consumes_and_republishes_actual_producer_without_native_history() {
    assert_ready_sandbox(true).await;
}

async fn assert_ready_sandbox(source_exact: bool) {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let reuse_key = "thread:ready-terminal-sandbox";
    let sandbox_id = seed_idle_pool_with_overrides(
        &env.idle_pool,
        &config.capacity.budget,
        &overrides,
        reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let producer = env.idle_pool.lock().await.held_sandbox_states()[0]
        .reusable_sandbox
        .source_run_id;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let successor = RunId::new_v4();
    env.provider.set_claim_result(
        successor,
        Some(context_with_reuse_key(successor, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(ranked_candidate(
            successor,
            Some(reuse_key),
            if source_exact {
                runner_provider::RunnerPreferenceTarget::SourceSandbox(producer)
            } else {
                runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(RunId::new_v4())
            },
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .expect("resolved producer must not defer its already-ready generic resource");
    assert_eq!(completion.sandbox_id, Some(sandbox_id));
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    assert_eq!(overrides.unpark_call_count(), 1);
    crate::reactor::tests::support::wait_idle_pool_reuse_keys(
        &env.idle_pool,
        &[reuse_key],
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        env.idle_pool.lock().await.held_sandbox_states()[0]
            .reusable_sandbox
            .source_run_id,
        successor
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn resolved_finalizing_preference_consumes_ready_home_cache() {
    assert_finalizing_preference_consumes_home_cache(false, false).await;
}

#[tokio::test]
async fn source_home_preference_consumes_matching_home_before_generic_sandbox() {
    assert_finalizing_preference_consumes_home_cache(false, true).await;
}

#[tokio::test]
async fn waiting_finalizing_successor_consumes_home_without_exact_sandbox() {
    assert_finalizing_preference_consumes_home_cache(true, false).await;
}

async fn assert_finalizing_preference_consumes_home_cache(waiting: bool, source_home: bool) {
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 4, 8192, 2, Arc::clone(&overrides));
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let reuse_key = "thread:ready-terminal-home";
    let predecessor =
        seed_home_cache_state(&cache, &paths, reuse_key, "vm0/default", image_size_bytes).await;
    let guard = waiting.then(|| {
        env.active_runs
            .register(predecessor, Some(reuse_key.into()), "vm0/default".into())
    });
    if source_home {
        seed_idle_pool_with_overrides(
            &env.idle_pool,
            &config.capacity.budget,
            &overrides,
            reuse_key,
            "vm0/default",
            2,
            4096,
        )
        .await;
    }
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let successor = RunId::new_v4();
    env.provider.set_claim_result(
        successor,
        Some(context_with_reuse_key(successor, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(ranked_candidate(
            successor,
            Some(reuse_key),
            if source_home {
                runner_provider::RunnerPreferenceTarget::SourceHomeCache(predecessor)
            } else {
                runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(predecessor)
            },
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    if let Some(guard) = &guard {
        wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
        assert!(guard.reuse_publisher().publish_no_exact_sandbox());
    }
    env.handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .expect("resolved producer must admit its ready home with available capacity");
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    let created = overrides.create_configs();
    assert_eq!(created.len(), if source_home { 2 } else { 1 });
    assert!(
        created
            .last()
            .unwrap()
            .home_drive
            .as_ref()
            .unwrap()
            .seed_image
            .is_some(),
        "the admitted successor must pass the actual cached home into sandbox creation"
    );
    drop(guard);
    shutdown(&env, run_handle).await;
}
