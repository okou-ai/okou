use super::super::super::*;
use super::super::support::{
    context_with_session, minimal_context, mock_run_config_with_overrides, push_job,
    seed_idle_pool_with_overrides, shutdown, test_profiles, wait_cancel_token_removed,
    wait_discover_entered,
};

async fn claim_behind_retained_publication(reuse: bool, hard_stop: bool) {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let unpark = sandbox_mock::MockLifecycleGate::new();
    let execution = sandbox_mock::MockLifecycleGate::new();
    if reuse {
        overrides.set_unpark_lifecycle_gate(unpark.clone());
        overrides.set_wait_process_lifecycle_gate(execution.clone());
    }
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 16, 32_768, 8, overrides.clone());
    let budget = Arc::clone(&config.capacity.budget);
    let pool = Arc::clone(&config.shared.idle_pool);
    let path = env._temp_dir.path().join("status.json");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let status = Arc::new(StatusTracker::new_with_atomic_write_gate(
        path.clone(),
        3, // Initial and Running precede the deliberately retained writer.
        Arc::clone(&started),
        Arc::clone(&release),
    ));
    config.shared.status = Arc::clone(&status);
    let mut publication_waits = status.required_publication_waits_for_test();
    let (_heartbeat, heartbeat_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_rx);
    // Suppress startup refill and hold fresh execution after active publication.
    let foreground = config
        .exec_config
        .pre_spawn_admission
        .acquire(2, &env.cancel)
        .await
        .unwrap();
    let first = RunId::new_v4();
    let later = RunId::new_v4();
    let key = RunId::new_v4().to_string();
    let reserved = if reuse {
        Some(
            seed_idle_pool_with_overrides(&pool, &budget, &overrides, &key, "vm0/default", 2, 4096)
                .await,
        )
    } else {
        None
    };
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let writer_status = Arc::clone(&status);
    let writer = tokio::spawn(async move { writer_status.set_mode(RunnerMode::Running).await });
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());

    let context = if reuse {
        context_with_session(first, &key)
    } else {
        minimal_context(first)
    };
    push_job(&env, first, "vm0/default", Some(context));
    tokio::time::timeout(
        Duration::from_secs(2),
        publication_waits.wait_for(|count| *count > 0),
    )
    .await
    .expect("claimed ownership must wait for the retained writer")
    .unwrap();
    assert_eq!(overrides.unpark_call_count(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());

    if hard_stop {
        let cancel = env.cancel.clone();
        let cancel_tokens = env.cancel_tokens.clone();
        let lifecycle = env.lifecycle.clone();
        let stopping = tokio::spawn(async move {
            handle_stopping_signal("TEST", &cancel, &cancel_tokens, &lifecycle).await;
        });
        env.start_observer
            .wait_for(Duration::from_secs(2), "claim-task drain", |event| {
                matches!(event, StartLoopEvent::ClaimsDrainEntered).then_some(())
            })
            .await;
        release.add_permits(1);
        unpark.release_many(usize::MAX);
        execution.release_many(usize::MAX);
        drop(foreground);
        stopping.await.unwrap();
        let completion = env
            .handle
            .wait_completion(first, Duration::from_secs(5))
            .await
            .unwrap();
        assert_ne!(completion.exit_code, 0);
        wait_cancel_token_removed(&env.cancel_tokens, first, Duration::from_secs(5)).await;
        // Stopping is published inline while this writer is retained. Preserve
        // that pre-existing terminal error, rather than require a healthy exit.
        let error = tokio::time::timeout(Duration::from_secs(10), runner)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        env.shutdown_startup_api().await;
        let cause = format!(
            "runner status persistence for {} is unconfirmed (configured publication budget: 5s)",
            path.display()
        );
        assert!(matches!(error, RunnerError::Internal(ref message)
            if message == &format!("persist runner mode Stopping: {cause}")
                || message == &format!("persist stopping status before teardown: {cause}")));
        assert!(overrides.start_agent_process_calls().is_empty());
        assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
        assert_eq!(budget.allocated(), (0, 0, 0));
        assert!(pool.lock().await.is_empty());
        super::super::support::wait_status_mode(&path, "stopped", Duration::from_secs(5)).await;
        let persisted: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(persisted["mode"], "stopped");
        assert!(persisted["active_runs"].as_array().unwrap().is_empty());
        return;
    }

    env.handle.block_claim(later);
    push_job(&env, later, "vm0/default", Some(minimal_context(later)));
    let later_claimed = env
        .handle
        .wait_run_claim_in_flight(later, Duration::from_secs(2))
        .await;
    release.add_permits(1);
    if reuse {
        unpark
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        let persisted: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(persisted["active_runs"][0]["phase"], "preparing");
        assert_eq!(
            persisted["active_runs"][0]["sandbox_id"],
            reserved.unwrap().to_string()
        );
        unpark.release_many(usize::MAX);
    }
    env.start_observer
        .wait_for(Duration::from_secs(5), "confirmed claimed ownership", |event| {
            matches!(event, StartLoopEvent::ActiveRunStatusPublished { run_id } if *run_id == first)
                .then_some(())
        })
        .await;
    if reuse {
        execution
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
    }
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
    let owner = persisted["active_runs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|owner| owner["run_id"] == first.to_string())
        .unwrap();
    assert_eq!(owner["phase"], if reuse { "running" } else { "preparing" });
    if let Some(sandbox_id) = reserved {
        assert_eq!(owner["sandbox_id"], sandbox_id.to_string());
    }
    drop(foreground);
    execution.release_many(usize::MAX);
    env.handle.unblock_claim(later);
    for run_id in [first, later] {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(completion.exit_code, 0);
        assert!(completion.error.is_none());
        wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    }
    shutdown(&env, runner).await;
    assert!(
        later_claimed,
        "retained publication must not block unrelated claims"
    );
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert!(pool.lock().await.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
    assert_eq!(persisted["mode"], "stopped");
    assert!(persisted["active_runs"].as_array().unwrap().is_empty());
    for run_id in [first, later] {
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
}

#[tokio::test]
async fn fresh_claim_confirms_status_behind_retained_publication() {
    claim_behind_retained_publication(false, false).await;
}

#[tokio::test]
async fn reserved_claim_confirms_preparing_before_unpark_behind_retained_publication() {
    claim_behind_retained_publication(true, false).await;
}

#[tokio::test]
async fn hard_stop_recovers_fresh_claim_behind_retained_publication() {
    claim_behind_retained_publication(false, true).await;
}

#[tokio::test]
async fn hard_stop_recovers_reserved_claim_behind_retained_publication() {
    claim_behind_retained_publication(true, true).await;
}
