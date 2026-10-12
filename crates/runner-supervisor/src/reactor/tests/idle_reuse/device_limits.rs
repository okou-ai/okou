use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides, push_job, seed_idle_pool_with_overrides,
    shutdown, test_profiles, wait_budget_count,
};

use runner_types::types::SandboxReuseResult;

fn device_rate_limits() -> sandbox::DeviceRateLimits {
    sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    }
}

#[tokio::test(start_paused = true)]
async fn configured_io_limiter_capacity_applies_limits_on_fresh_create() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let limits = device_rate_limits();
    config.capacity.device_rate_limits = Some(limits.clone());

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-io-limit")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));

    let create_configs = overrides.create_configs();
    assert_eq!(create_configs.len(), 1);
    assert_eq!(create_configs[0].device_rate_limits, Some(limits));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn absent_io_limiter_capacity_reuses_unlimited_idle_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-absent-io-capacity",
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
        Some(context_with_session(run_id, "sess-absent-io-capacity")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(seeded_sandbox_id));
    assert!(
        overrides
            .create_configs()
            .iter()
            .all(|config| config.device_rate_limits.is_none()),
        "absent host capacity should not apply limiter config"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn device_limit_mismatch_destroys_idle_sandbox_and_fresh_creates() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let limits = device_rate_limits();
    config.capacity.device_rate_limits = Some(limits.clone());

    let seeded_sandbox_id = seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &overrides,
        "sess-io-limit",
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
        Some(context_with_session(run_id, "sess-io-limit")),
    );

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::DeviceLimitMismatch),
    );
    assert_ne!(
        completion.sandbox_id,
        Some(seeded_sandbox_id),
        "limiter mismatch should force a fresh sandbox"
    );
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    let create_configs = overrides.create_configs();
    assert!(
        create_configs
            .iter()
            .any(|config| config.device_rate_limits == Some(limits.clone())),
        "fresh create should receive the configured limiter"
    );

    shutdown(&env, run_handle).await;
}
