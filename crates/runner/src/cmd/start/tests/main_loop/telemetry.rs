use super::super::super::*;
use super::super::support::{
    SpeculativeIdleSeedSpec, context_with_session, minimal_context, mock_run_config_with_api_url,
    mock_run_config_with_overrides_and_api_url, push_job, seed_idle_pool,
    seed_idle_pool_with_speculative_timezone, shutdown, test_profiles, test_runner_identity,
    wait_budget_count, wait_cancel_handle, wait_cancel_token_removed, wait_discover_entered,
};
use crate::paths::RunnerPaths;
use crate::workspace_image_cache::WorkspaceImageCache;

#[tokio::test]
async fn telemetry_flush_includes_start_loop_claim_phase_spans() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_to_executor_start")
                .body_includes("runner_claim_resume_session_validation")
                .body_includes("runner_claim_device_rate_limits")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_workspace_cache_state_lookup")
                .body_includes("runner_claim_active_status_publish")
                .body_includes("runner_claim_spawn_job_setup")
                .body_includes("runner_claim_task_schedule_wait")
                .body_includes(r#""runner_pre_spawn_concurrency_bucket":"1""#)
                .body_includes(r#""runner_resource_budget_vcpu_utilization_bucket":"26_50""#)
                .body_includes(r#""runner_resource_budget_memory_utilization_bucket":"0_25""#)
                .body_includes(r#""runner_resource_budget_lease_count_bucket":"1""#)
                .body_includes("runner_host_finalization_started")
                .body_includes("runner_host_reuse_preparation")
                .body_includes("runner_host_physical_park")
                .body_includes("runner_host_idle_publication")
                .body_includes("runner_host_finalization_reusable_sandbox")
                .body_includes("runner_host_completion_fallback")
                .body_includes("runner_active_reuse_key_released");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-claim-timing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_flush_classifies_no_resource_finalization() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_host_finalization_no_resource")
                .body_includes("runner_host_completion_fallback");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_flush_classifies_workspace_cache_finalization() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_host_finalization_workspace_cache")
                .body_includes("runner_host_completion_fallback")
                .body_includes("runner_active_reuse_key_released");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let mut profiles = test_profiles();
    profiles
        .get_mut("vm0/default")
        .expect("default profile should exist")
        .workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config_with_overrides_and_api_url(
        profiles,
        8,
        32768,
        4,
        Arc::clone(&overrides),
        &server.base_url(),
    );
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .expect("test executor config should be unique")
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(
            run_id,
            "sess-telemetry-workspace-cache",
        )),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the workspace image is written");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().expect("image should have a parent"))
        .await
        .unwrap();
    let file = tokio::fs::File::create(active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);
    assert!(env.parking_gate.soft_drain());
    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 1);

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_flush_classifies_failed_finalization() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_host_finalization_failed")
                .body_includes("runner_host_completion_fallback");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_stop_panic("simulated finalization stop panic");
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        8,
        32768,
        4,
        overrides,
        &server.base_url(),
    );
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn telemetry_flush_includes_reuse_hit_claim_phase_spans() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("sandbox_reuse_hit")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_idle_unpark")
                .body_includes("runner_claim_task_schedule_wait");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let idle_pool = config.shared.idle_pool.clone();
    let budget = config.capacity.budget.clone();
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-reuse-claim-timing",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-reuse-claim-timing")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(crate::types::SandboxReuseResult::Reused)
    );

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn invalid_resume_session_emits_no_reuse_telemetry() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let reuse_telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("sandbox_reuse_");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();

    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "../invalid-session")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(completion.reuse_result, None);

    shutdown(&env, run_handle).await;

    reuse_telemetry_mock.assert_calls_async(0).await;
}

#[tokio::test]
async fn cancelled_finalizing_handoff_flushes_outcome_without_executor() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"cancelled""#)
                .body_includes(r#""reason":"successor_cancelled""#)
                .body_includes(r#""error":"cancelled""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 2, 4096, 1, &server.base_url());
    let reuse_key = "thread:cancelled-finalizing-handoff-telemetry";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(30),
                    ),
                ),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    cancellation.request_hard_cancellation().await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cancelled finalizing handoff should report completion");
    assert_eq!(completion.exit_code, 137);

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn finalizing_no_exact_fallback_reports_atomic_idle_miss() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"no_exact""#)
                .body_includes(r#""reason":"predecessor_no_exact""#)
                .body_includes("runner_claim_finalizing_exact_idle_lookup")
                .body_includes(r#""outcome":"miss""#)
                .body_includes(r#""reason":"absent""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 2, 4096, 1, &server.base_url());
    let reuse_key = "thread:no-exact-fallback-telemetry";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(30),
                    ),
                ),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    assert!(predecessor_reuse.publish_no_exact_sandbox());
    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("no-exact fallback should complete");

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn finalizing_handoff_deadline_reports_fallback_reason() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"not_accepted_before_deadline""#)
                .body_includes(r#""reason":"handoff_acceptance_deadline""#)
                .body_includes("runner_claim_finalizing_exact_idle_lookup")
                .body_includes(r#""outcome":"miss""#)
                .body_includes(r#""reason":"absent""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 2, 4096, 1, &server.base_url());
    let reuse_key = "thread:handoff-deadline-telemetry";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    assert!(predecessor_reuse.mark_finalizing(std::time::Instant::now()));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(1),
                    ),
                ),
        )
        .unwrap();

    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("deadline fallback should complete");

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn finalizing_handoff_activation_failure_is_not_reported_as_accepted() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_wait")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"activation_failed""#)
                .body_includes(r#""reason":"exact_activation_fallback""#)
                .body_includes(r#""error":"activation_failed""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated handoff activation failure".into(),
    }));
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        2,
        4096,
        1,
        overrides,
        &server.base_url(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reuse_key = "thread:failed-finalizing-handoff-activation";
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
        .expect("predecessor should still be running when the successor is claimed");
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(30),
                    ),
                ),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    wait_gate.release_one();
    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("fresh fallback should start after handoff activation fails");
    wait_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh fallback should complete");
    assert_eq!(
        completion.reuse_result,
        Some(crate::types::SandboxReuseResult::UnparkFailed)
    );

    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn published_exact_activation_failure_is_reported_as_activation_failed() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"activation_failed""#)
                .body_includes(r#""reason":"exact_activation_fallback""#)
                .body_includes(r#""error":"activation_failed""#)
                .body_includes("runner_claim_finalizing_exact_idle_lookup")
                .body_includes(r#""outcome":"hit""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated published exact activation failure".into(),
    }));
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        2,
        4096,
        1,
        Arc::clone(&overrides),
        &server.base_url(),
    );
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:failed-published-exact-activation";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(30),
                    ),
                ),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: predecessor_run_id,
            guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await;
    assert!(predecessor_reuse.publish_exact_sandbox());

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fresh fallback should complete after exact activation fails");
    assert_eq!(
        completion.reuse_result,
        Some(crate::types::SandboxReuseResult::UnparkFailed)
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn finalizing_handoff_activation_failure_retains_lease_until_completion() {
    assert_finalizing_activation_failure_retains_lease_until_completion(true).await;
}

#[tokio::test]
async fn published_exact_finalizing_activation_failure_retains_lease_until_completion() {
    assert_finalizing_activation_failure_retains_lease_until_completion(false).await;
}

async fn assert_finalizing_activation_failure_retains_lease_until_completion(direct_handoff: bool) {
    use httpmock::prelude::*;

    use crate::idle_pool::ParkResult;
    use crate::idle_pool::test_support::ParkedIdleCandidateBuilder;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_finalizing_handoff")
                .body_includes(r#""outcome":"activation_failed""#)
                .body_includes(r#""reason":"exact_activation_failed""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated finalizing activation failure".into(),
    }));
    overrides.push_destroy_panic("simulated uncertain activation cleanup");
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        2,
        4096,
        1,
        Arc::clone(&overrides),
        &server.base_url(),
    );
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:finalizing-failure-completion";
    let predecessor_run_id = RunId::new_v4();
    let predecessor = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let publisher = predecessor.reuse_publisher();
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let factory: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&overrides)),
    ));
    let candidate = ParkedIdleCandidateBuilder::new(reuse_key, lease)
        .with_history_generation_run_id(predecessor_run_id)
        .with_factory(factory)
        .with_sandbox(Box::new(sandbox_mock::MockSandbox::with_overrides(
            "finalizing-failure-completion",
            Arc::clone(&overrides),
        )))
        .build();
    env.handle.block_completions();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(predecessor_run_id))
                .with_runner_preference_for_test(
                    crate::provider::ActiveRunnerPreference::ranked_for_test(
                        test_runner_identity(),
                        crate::provider::RunnerPreferenceTier::FinalizingPredecessor,
                        std::time::Instant::now() + Duration::from_secs(30),
                    ),
                ),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    if direct_handoff {
        assert!(
            tokio::time::timeout(
                Duration::from_secs(5),
                publisher.handoff_signal().wait_and_accept(),
            )
            .await
            .expect("successor should request direct handoff")
        );
        assert!(matches!(
            publisher.deliver_exact_handoff(candidate, predecessor_run_id),
            active_runs::ActiveRunHandoffDeliveryResult::Delivered
        ));
    } else {
        assert!(matches!(
            env.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        assert!(publisher.publish_exact_sandbox());
    }

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("uncertain activation cleanup should complete without an executor");
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(
        completion.reuse_result,
        Some(crate::types::SandboxReuseResult::UnparkFailed)
    );
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("cleanup was uncertain"))
    );
    assert_eq!(env.handle.completion_in_flight(), 1);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(!env.active_runs.contains(run_id));
    assert!(
        tokio::time::timeout(
            Duration::from_secs(5),
            cancellation.request_hard_cancellation()
        )
        .await
        .expect("failure must release the transfer guard before completion returns")
    );
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.destroy_call_count(), 1);

    env.handle.unblock_completions();
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    drop(predecessor);
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}
