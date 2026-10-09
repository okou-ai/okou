use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config, push_job, seed_idle_pool, seed_idle_pool_with_overrides,
    shutdown, test_profiles, wait_discover_entered, wait_idle_pool_len, wait_idle_pool_reuse_keys,
};
use crate::idle_prune_control::request;
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

#[tokio::test]
async fn prune_idle_publishes_workspace_cache_before_acknowledging() {
    use crate::idle_pool::{IdleParkRequest, IdleParkRequestParts, ParkResult};
    use crate::workspace_promotion::test_support::WorkspacePromotionFixture;
    use sandbox::{ResourceLimits, SandboxConfig, SandboxFactory};
    let fixture = WorkspacePromotionFixture::new("thread:pruned-workspace").await;
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let home = config.paths.home.clone();
    let base = config.paths.base_dir.clone();
    let identity = config.runner.identity;
    let overrides = Arc::new(MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    runner_lifecycle::workspace_promotion::test_support::add_healthy_cache_preparation_matcher(
        &overrides,
    );
    let factory: Arc<Box<dyn SandboxFactory>> = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(overrides),
    ));
    let sandbox = factory
        .create(SandboxConfig {
            id: fixture.sandbox_id,
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 4096,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .unwrap();
    let lease = ResourceBudget::try_reserve_lease(&config.capacity.budget, 2, 4096).unwrap();
    let park = IdleParkRequest::new(IdleParkRequestParts {
        run_id: RunId::new_v4(),
        sandbox,
        factory,
        reuse_key: fixture.reuse_key.clone(),
        sandbox_id: fixture.sandbox_id,
        profile_name: "vm0/default".into(),
        device_rate_limits: None,
        budget_lease: lease,
        source_ip: "10.0.0.1".into(),
        storage_fingerprints: crate::storage_fingerprints::StorageFingerprints::default(),
        restored_session_identity: None,
        history_generation_run_id: None,
        guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
        workspace_image_size_bytes: b"workspace image".len() as u64,
        workspace_promotion: Some(fixture.promotion),
        handoff: None,
    });
    let candidate = match park.park_for_idle().await {
        Ok(outcome) => outcome.expect_reusable(),
        Err(_) => panic!("park must succeed"),
    };
    assert!(matches!(
        config.shared.idle_pool.lock().await.park(candidate),
        ParkResult::Parked
    ));
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let report = request(&home, &base, identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.completed, 1);
    let cached = fixture.cache.held_workspace_states().await;
    assert_eq!(cached.len(), 1);
    assert_eq!(cached[0].reuse_key, fixture.reuse_key);
    shutdown(&env, runner).await;
    assert_eq!(fixture.cache.held_workspace_states().await.len(), 1);
}

#[tokio::test]
async fn prune_idle_preserves_blanks_reservations_and_later_job_parking() {
    let (config, env) = mock_run_config(test_profiles(), 16, 32768, 8);
    let home = config.paths.home.clone();
    let base = config.paths.base_dir.clone();
    let identity = config.runner.identity;
    let pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    seed_idle_pool(&pool, &budget, "pruned", "vm0/default", 2, 4096).await;
    seed_idle_pool(&pool, &budget, "reserved", "vm0/default", 2, 4096).await;
    let reservation = pool.lock().await.take_reserved("reserved").unwrap();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_idle_pool_len(&pool, 2, Duration::from_secs(5)).await;
    let blank = pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id;

    let report = request(&home, &base, identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 1, 0)
    );
    assert_eq!(
        pool.lock().await.status_snapshot().blank_sandboxes[0].sandbox_id,
        blank
    );
    assert_eq!(
        budget.allocated().2,
        2,
        "blank and reserved budgets remain owned"
    );
    assert_eq!(env.lifecycle.current_mode(), RunnerMode::Running);

    // A reservation outside the pool remains owned and can still be restored.
    let restored = pool.lock().await.restore_reserved(reservation);
    assert!(matches!(
        restored,
        crate::idle_pool::RestoreReservedIdleResult::Restored
    ));
    let report = request(&home, &base, identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.completed, 1);
    let report = request(&home, &base, identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(report.selected, 0, "repeating one-shot cleanup is harmless");

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "after-prune")),
    );
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(completion.exit_code, 0);
    wait_idle_pool_reuse_keys(&pool, &["after-prune"], Duration::from_secs(5)).await;
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn prune_idle_client_disconnect_keeps_cleanup_owned_and_reactor_progressing() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let home = config.paths.home.clone();
    let base = config.paths.base_dir.clone();
    let identity = config.runner.identity;
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(MockSandboxOverrides::new());
    let gate = MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(gate.clone());
    seed_idle_pool_with_overrides(
        &config.shared.idle_pool,
        &budget,
        &overrides,
        "slow-prune",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let client =
        tokio::spawn(async move { request(&home, &base, identity, std::process::id()).await });
    gate.wait_entered(1, Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        budget.allocated().2,
        1,
        "budget stays reserved through destruction"
    );
    client.abort();
    assert!(client.await.unwrap_err().is_cancelled());

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "during-prune")),
    );
    assert_eq!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(budget.allocated().2, 2);
    env.trigger_stopping().await;
    env.start_observer
        .wait_for(
            Duration::from_secs(5),
            "tracked destruction drain",
            |event| matches!(event, StartLoopEvent::DestroyTasksDrainEntered).then_some(()),
        )
        .await;
    assert!(
        !runner.is_finished(),
        "shutdown must await admitted pruning"
    );
    assert_eq!(budget.allocated().2, 1, "pruning still owns its budget");
    gate.release_one();
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated().2, 0);
}

#[tokio::test]
async fn prune_idle_reports_uncertain_destruction_without_stopping_runner() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let home = config.paths.home.clone();
    let base = config.paths.base_dir.clone();
    let identity = config.runner.identity;
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_destroy_panic("prune destroy failure");
    seed_idle_pool_with_overrides(
        &config.shared.idle_pool,
        &config.capacity.budget,
        &overrides,
        "uncertain-prune",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let report = request(&home, &base, identity, std::process::id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (report.selected, report.completed, report.uncertain),
        (1, 0, 1)
    );
    assert_eq!(env.lifecycle.current_mode(), RunnerMode::Running);
    shutdown(&env, runner).await;
}
