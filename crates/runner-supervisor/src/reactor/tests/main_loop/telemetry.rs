use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_api_url,
    mock_run_config_with_overrides_and_api_url, push_job, seed_idle_pool, shutdown, test_profiles,
    wait_discover_entered,
};
use crate::home_image_cache::HomeImageCache;
use runner_host::paths::RunnerPaths;

#[tokio::test]
async fn telemetry_flush_includes_start_loop_claim_phase_spans() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_admission_to_executor_start")
                .body_includes("runner_claim_resume_session_validation")
                .body_includes("runner_claim_device_rate_limits")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_home_cache_state_lookup")
                .body_includes("runner_claim_active_status_publish")
                .body_includes("runner_claim_spawn_job_setup")
                .body_includes("runner_claim_task_schedule_wait")
                .body_includes("runner_claim_blank_pool_selection")
                .body_includes(r#""outcome":"miss""#)
                .body_includes(r#""reason":"disabled_plan""#)
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
async fn telemetry_flush_classifies_home_cache_finalization() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_host_finalization_home_cache")
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
        .home_disk_mb = 16;
    let (mut config, env) = mock_run_config_with_overrides_and_api_url(
        profiles,
        8,
        32768,
        4,
        Arc::clone(&overrides),
        &server.base_url(),
    );
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let home_cache = HomeImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .expect("test executor config should be unique")
        .home_cache = Some(home_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-telemetry-home-cache")),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before the home image is written");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded")
        .id;
    let active_image = runner_paths.active_home_image(&sandbox_id);
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
async fn telemetry_flush_preserves_claim_spans_and_publishes_settled_reuse() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_idle_reuse_lookup")
                .body_includes("runner_claim_idle_unpark")
                .body_includes("runner_claim_task_schedule_wait");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let startup_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_sandbox_startup")
                .body_includes(r#""runner_startup_path":"sandbox""#);
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let (config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    let idle_pool = config.shared.idle_pool.clone();
    let budget = config.capacity.budget.clone();
    let reused_sandbox_id = seed_idle_pool(
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
    assert_eq!(completion.sandbox_id, Some(reused_sandbox_id));

    assert_eq!(completion.exit_code, 0);

    shutdown(&env, run_handle).await;

    telemetry_mock.assert_calls_async(1).await;
    startup_mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn invalid_resume_session_flushes_blank_selection_without_startup_fact() {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let reuse_telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_sandbox_startup");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let blank_selection_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("runner_claim_blank_pool_selection")
                .body_includes(r#""outcome":"miss""#)
                .body_includes(r#""reason":"disabled_plan""#);
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

    shutdown(&env, run_handle).await;

    reuse_telemetry_mock.assert_calls_async(0).await;
    blank_selection_mock.assert_calls_async(1).await;
}
