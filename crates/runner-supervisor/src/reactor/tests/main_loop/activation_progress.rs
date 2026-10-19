use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_overrides, push_job,
    seed_idle_pool_with_overrides, shutdown, test_profiles, wait_cancel_token_removed,
    wait_discover_entered,
};

#[derive(Clone, Copy)]
enum ActivationWait {
    ActiveStatus,
    ReservedUnpark,
    FailureCompletion,
}

async fn later_claim_while_activation_waits(wait: ActivationWait) {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let unpark = sandbox_mock::MockLifecycleGate::new();
    if matches!(wait, ActivationWait::ReservedUnpark) {
        overrides.set_unpark_lifecycle_gate(unpark.clone());
    }
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let pool = Arc::clone(&config.shared.idle_pool);
    let status_path = env._temp_dir.path().join("status.json");
    let write_started = Arc::new(tokio::sync::Notify::new());
    let write_release = Arc::new(tokio::sync::Semaphore::new(0));
    if matches!(wait, ActivationWait::ActiveStatus) {
        config.shared.status = Arc::new(StatusTracker::new_with_atomic_write_gate(
            status_path.clone(),
            3,
            Arc::clone(&write_started),
            Arc::clone(&write_release),
        ));
    }
    let (_heartbeat, heartbeat_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_rx);
    // Keep unrelated startup refill out of the controlled activation.
    let foreground = config
        .exec_config
        .pre_spawn_admission
        .acquire(2, &env.cancel)
        .await
        .unwrap();
    let first = RunId::new_v4();
    let later = RunId::new_v4();
    let reuse_key = RunId::new_v4().to_string();
    let reserved_id = if matches!(wait, ActivationWait::ReservedUnpark) {
        Some(
            seed_idle_pool_with_overrides(
                &pool,
                &budget,
                &overrides,
                &reuse_key,
                "vm0/default",
                2,
                4096,
            )
            .await,
        )
    } else {
        None
    };
    let mut context = if reserved_id.is_some() {
        context_with_session(first, &reuse_key)
    } else {
        minimal_context(first)
    };
    if matches!(wait, ActivationWait::FailureCompletion) {
        context.local_resume_session_id = Some("../invalid-session".into());
        env.handle.block_completions();
    }
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    push_job(&env, first, "vm0/default", Some(context));
    match wait {
        ActivationWait::ActiveStatus => {
            tokio::time::timeout(Duration::from_secs(2), write_started.notified())
                .await
                .expect("first activation must enter the actual atomic writer");
        }
        ActivationWait::ReservedUnpark => {
            unpark
                .wait_entered(1, Duration::from_secs(5))
                .await
                .unwrap();
            let persisted: serde_json::Value =
                serde_json::from_str(&tokio::fs::read_to_string(&status_path).await.unwrap())
                    .unwrap();
            assert_eq!(persisted["active_runs"][0]["run_id"], first.to_string());
            assert_eq!(persisted["active_runs"][0]["phase"], "preparing");
            assert_eq!(
                persisted["active_runs"][0]["sandbox_id"],
                reserved_id.unwrap().to_string()
            );
        }
        ActivationWait::FailureCompletion => {
            let failed = env
                .handle
                .wait_completion(first, Duration::from_secs(5))
                .await
                .expect("invalid session must reach provider failure completion");
            assert_ne!(failed.exit_code, 0);
            assert!(
                failed
                    .error
                    .as_deref()
                    .is_some_and(|e| e.contains("session_id"))
            );
            assert_eq!(env.handle.completion_in_flight(), 1);
            assert!(env.cancel_tokens.handle(first).await.is_some());
        }
    }

    env.handle.block_claim(later);
    push_job(&env, later, "vm0/default", Some(minimal_context(later)));
    let claimed_while_held = env
        .handle
        .wait_run_claim_in_flight(later, Duration::from_secs(2))
        .await;
    let registered_while_held = env.cancel_tokens.handle(later).await.is_some();

    // A valid old-runtime failure must still settle all accepted ownership.
    write_release.add_permits(1);
    unpark.release_many(usize::MAX);
    env.handle.unblock_completions();
    drop(foreground);
    env.handle.unblock_claim(later);
    for run_id in [first, later] {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .expect("both accepted jobs must complete after gate release");
        if run_id == first && matches!(wait, ActivationWait::FailureCompletion) {
            assert_ne!(completion.exit_code, 0);
            assert!(completion.sandbox_id.is_none());
        } else {
            assert_eq!(completion.exit_code, 0);
            assert!(completion.error.is_none());
        }
        if run_id == first
            && let Some(sandbox_id) = reserved_id
        {
            assert_eq!(completion.sandbox_id, Some(sandbox_id));
        }
        wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(10)).await;
        assert_eq!(
            env.handle
                .completions
                .lock()
                .unwrap()
                .iter()
                .filter(|completion| completion.run_id == run_id)
                .count(),
            1
        );
    }
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(pool.lock().await.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(status_path).await.unwrap()).unwrap();
    assert_eq!(persisted["mode"], "stopped");
    for field in ["idle_sandboxes", "blank_sandboxes", "active_runs"] {
        assert!(
            persisted
                .get(field)
                .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)),
            "shutdown retained stale {field}: {persisted}",
        );
    }
    assert!(
        claimed_while_held,
        "later claim waited for earlier activation"
    );
    assert!(registered_while_held);
}

#[tokio::test]
async fn ordinary_status_wait_allows_later_claim() {
    later_claim_while_activation_waits(ActivationWait::ActiveStatus).await;
}

#[tokio::test]
async fn reserved_unpark_wait_allows_later_claim() {
    later_claim_while_activation_waits(ActivationWait::ReservedUnpark).await;
}

#[tokio::test]
async fn failure_completion_wait_allows_later_claim() {
    later_claim_while_activation_waits(ActivationWait::FailureCompletion).await;
}
