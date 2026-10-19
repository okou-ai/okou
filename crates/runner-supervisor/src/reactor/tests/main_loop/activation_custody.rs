use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_overrides, push_job,
    seed_idle_pool_with_overrides, shutdown, test_profiles, wait_cancel_token_removed,
    wait_discover_entered,
};
use crate::reactor::claim_tasks::MAX_IN_FLIGHT_CLAIMS;

#[tokio::test]
async fn four_blocked_activations_retain_the_original_claim_bound() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_unpark_lifecycle_gate(gate.clone());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 32, 65_536, 16, overrides.clone());
    config.capacity.max_idle = MAX_IN_FLIGHT_CLAIMS;
    let budget = Arc::clone(&config.capacity.budget);
    let pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    let foreground = config
        .exec_config
        .pre_spawn_admission
        .acquire(2, &env.cancel)
        .await
        .unwrap();
    let mut runs = Vec::new();
    for _ in 0..MAX_IN_FLIGHT_CLAIMS {
        let run_id = RunId::new_v4();
        let key = RunId::new_v4().to_string();
        let sandbox_id =
            seed_idle_pool_with_overrides(&pool, &budget, &overrides, &key, "vm0/default", 2, 4096)
                .await;
        runs.push((run_id, key, sandbox_id));
    }
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    for (run_id, key, _) in &runs {
        push_job(
            &env,
            *run_id,
            "vm0/default",
            Some(context_with_session(*run_id, key)),
        );
    }
    let later = RunId::new_v4();
    push_job(&env, later, "vm0/default", Some(minimal_context(later)));
    gate.wait_entered(MAX_IN_FLIGHT_CLAIMS as u64, Duration::from_secs(5))
        .await
        .unwrap();
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    let active = status["active_runs"].as_array().unwrap();
    assert_eq!(active.len(), MAX_IN_FLIGHT_CLAIMS);
    for (run_id, _, sandbox_id) in &runs {
        let owner = active
            .iter()
            .find(|owner| owner["run_id"] == run_id.to_string())
            .unwrap();
        assert_eq!(owner["sandbox_id"], sandbox_id.to_string());
        assert_eq!(owner["phase"], "preparing");
        assert!(env.cancel_tokens.handle(*run_id).await.is_some());
    }
    assert_eq!(budget.allocated().2, MAX_IN_FLIGHT_CLAIMS);
    assert_eq!(env.handle.claim_candidates().len(), MAX_IN_FLIGHT_CLAIMS);
    assert!(env.cancel_tokens.handle(later).await.is_none());
    gate.release_many(usize::MAX);
    drop(foreground);
    for (run_id, _, sandbox_id) in &runs {
        let done = env
            .handle
            .wait_completion(*run_id, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(done.exit_code, 0);
        assert_eq!(done.sandbox_id, Some(*sandbox_id));
    }
    assert_eq!(
        env.handle
            .wait_completion(later, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(
        env.handle.claim_candidates().len(),
        MAX_IN_FLIGHT_CLAIMS + 1
    );
    assert_eq!(
        env.handle.completions.lock().unwrap().len(),
        MAX_IN_FLIGHT_CLAIMS + 1
    );
    assert!(env.handle.max_claim_in_flight() <= MAX_IN_FLIGHT_CLAIMS);
    for run_id in runs.into_iter().map(|r| r.0).chain([later]) {
        wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    }
}

async fn unpolled_ready_activation(hard_stop: bool) {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 8, 32_768, 4, overrides.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let (_heartbeat, heartbeat_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_rx);
    let foreground = config
        .exec_config
        .pre_spawn_admission
        .acquire(2, &env.cancel)
        .await
        .unwrap();
    let run_id = RunId::new_v4();
    let reuse_key = RunId::new_v4().to_string();
    let sandbox_id = seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    env.handle.block_claim(run_id);
    let mut reactor = Box::pin(run(config));
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, &reuse_key)),
    );
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before claim entry: {result:?}"),
        entered = env.handle.wait_run_claim_in_flight(run_id, Duration::from_secs(5)) => assert!(entered),
    }
    env.handle.unblock_claim(run_id);
    // No more Reactor polling: activation must publish its guarded result itself.
    env.start_observer
        .wait_for(
            Duration::from_secs(5),
            "independently published reserved activation",
            |event| match event {
                StartLoopEvent::ActiveRunStatusPublished { run_id: observed }
                    if *observed == run_id =>
                {
                    Some(())
                }
                _ => None,
            },
        )
        .await;
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert_eq!(status["active_runs"][0]["phase"], "running");
    assert_eq!(
        status["active_runs"][0]["sandbox_id"],
        sandbox_id.to_string()
    );
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    if hard_stop {
        tokio::time::timeout(Duration::from_secs(5), env.trigger_stopping())
            .await
            .expect("hard cancellation must not need Reactor to consume a transfer lock");
        drop(foreground);
        shutdown(&env, tokio::spawn(reactor)).await;
    } else {
        drop(reactor);
        drop(foreground);
    }
    let done = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_ne!(done.exit_code, 0);
    assert!(done.error.is_some());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(!env.active_runs.contains(run_id));
    assert_eq!(overrides.destroy_call_count(), 1);
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap()).unwrap();
    assert!(status["active_runs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn ready_activation_progresses_and_recovers_when_reactor_observation_is_dropped() {
    unpolled_ready_activation(false).await;
}

#[tokio::test]
async fn hard_stop_does_not_need_reactor_to_release_a_ready_activation_transfer_lock() {
    unpolled_ready_activation(true).await;
}
