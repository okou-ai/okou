use super::super::super::support::{
    mock_run_config_with_api_url, mock_run_config_with_overrides_and_api_url, wait_cancel_handle,
};
use super::*;

#[tokio::test]
async fn dropped_reactor_recovers_supplied_finalizing_result_without_dispatch() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides.clone());
    let budget = config.capacity.budget.clone();
    let occupied = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let binding = StartLoopTestGate::default();
    config.provider.provider = Arc::new(SuppliedProvider(
        config.provider.provider.clone(),
        Some(binding.clone()),
    ));
    let reuse_key = "thread:dropped-supplied-finalizing";
    let source = RunId::new_v4();
    let predecessor =
        env.active_runs
            .register(source, Some(reuse_key.into()), "vm0/default".into());
    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited during setup: {result:?}"),
        () = async {
            peer.wait_connected().await;
            peer.allow_health();
            wait_status_mode(&env._temp_dir.path().join("status.json"), "running", Duration::from_secs(5)).await;
        } => {}
    }
    let run_id = RunId::new_v4();
    let mut supplied = envelope(identity, run_id);
    supplied["executionContext"]["reuseKey"] = json!(reuse_key);
    supplied["executionContext"]["nativeContinuation"] = json!({
        "sessionId": RunId::new_v4(), "generationRunId": source, "recoveryPrompt": null
    });
    let body = supplied.to_string();
    env.handle.block_completions();
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before input binding: {result:?}"),
        () = async {
            let mut stream = tokio::net::UnixStream::connect(&socket).await.unwrap();
            stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", identity.runner_id(), body.len()).as_bytes()).await.unwrap();
            binding.wait_entered(Duration::from_secs(5), "supplied binding").await;
        } => {}
    }
    drop(reactor);
    binding.release();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .unwrap();
    assert_ne!(completion.exit_code, 0);
    assert!(completion.error.is_some());
    assert_eq!(completion.sandbox_id, None);
    assert!(env.cancel_tokens.handle(run_id).await.is_some());
    assert!(env.active_runs.contains(source));
    assert!(!env.active_runs.contains(run_id));
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.unpark_call_count(), 0);
    assert_eq!(overrides.destroy_call_count(), 0);
    env.handle.unblock_completions();
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    assert_eq!(env.handle.discover_started_count(), 0);
    drop(predecessor);
    drop(occupied);
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    peer.shutdown().await;
    env.shutdown_startup_api().await;
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

    let (mut config, env) =
        mock_run_config_with_api_url(test_profiles(), 2, 4096, 1, &server.base_url());
    let reuse_key = "thread:cancelled-finalizing-handoff-telemetry";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let run_handle = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;

    let run_id = RunId::new_v4();
    let mut supplied = envelope(identity, run_id);
    supplied["executionContext"]["reuseKey"] = json!(reuse_key);
    supplied["executionContext"]["nativeContinuation"] = json!({
        "sessionId": RunId::new_v4(), "generationRunId": predecessor_run_id,
        "recoveryPrompt": null
    });
    assert_eq!(
        client(&socket, identity, run_id, &supplied.to_string())
            .await
            .2["disposition"],
        "accepted"
    );
    env.start_observer
        .wait_finalizing_handoff_requested(predecessor_run_id, run_id, Duration::from_secs(5))
        .await;
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    cancellation.request_hard_cancellation().await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cancelled finalizing handoff should report completion");
    assert_eq!(completion.exit_code, 137);

    drop(predecessor_guard);
    assert_eq!(env.handle.discover_started_count(), 0);
    peer.shutdown().await;
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
    let (mut config, env) = mock_run_config_with_overrides_and_api_url(
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
        .with_source_run_id(predecessor_run_id)
        .with_rootfs_hash(test_profiles()["vm0/default"].rootfs_hash.clone())
        .with_native_generation_run_id(predecessor_run_id)
        .with_factory(factory)
        .with_sandbox(Box::new(sandbox_mock::MockSandbox::with_overrides(
            "finalizing-failure-completion",
            Arc::clone(&overrides),
        )))
        .build();
    env.handle.block_completions();
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let run_handle = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(
        &env._temp_dir.path().join("status.json"),
        "running",
        Duration::from_secs(5),
    )
    .await;

    let run_id = RunId::new_v4();
    let mut supplied = envelope(identity, run_id);
    supplied["executionContext"]["reuseKey"] = json!(reuse_key);
    supplied["executionContext"]["nativeContinuation"] = json!({
        "sessionId": RunId::new_v4(), "generationRunId": predecessor_run_id,
        "recoveryPrompt": null
    });
    assert_eq!(
        client(&socket, identity, run_id, &supplied.to_string())
            .await
            .2["disposition"],
        "accepted"
    );
    env.start_observer
        .wait_finalizing_handoff_requested(predecessor_run_id, run_id, Duration::from_secs(5))
        .await;
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
            publisher.deliver_exact_handoff(
                crate::idle_pool::IdleParkCandidate::Ordinary(candidate),
                predecessor_run_id,
            ),
            runner_lifecycle::active_runs::ActiveRunHandoffDeliveryResult::Delivered
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
    assert_eq!(env.handle.discover_started_count(), 0);
    peer.shutdown().await;
    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;
}
