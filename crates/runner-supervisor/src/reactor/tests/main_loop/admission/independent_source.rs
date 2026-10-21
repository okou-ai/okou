use super::terminal_reuse::generic_finalizing_candidate;
use super::*;

#[tokio::test(start_paused = true)]
async fn independent_source_requires_matching_local_process_key_and_profile() {
    for case in ["missing", "key", "profile", "process", "self"] {
        let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
        let successor = RunId::new_v4();
        let source = if case == "self" {
            successor
        } else {
            RunId::new_v4()
        };
        let reuse_key = "thread:independent-proof";
        let guard = (case != "missing").then(|| {
            env.active_runs.register(
                source,
                Some(
                    if case == "key" {
                        "thread:other"
                    } else {
                        reuse_key
                    }
                    .into(),
                ),
                if case == "profile" {
                    "vm0/large"
                } else {
                    "vm0/default"
                }
                .into(),
            )
        });
        let run_handle = tokio::spawn(run(config));
        wait_discover_entered(&env, Duration::from_secs(2)).await;
        let deadline = std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME;
        let mut candidate = generic_finalizing_candidate(successor, reuse_key, source, deadline);
        if case == "process" {
            candidate = candidate.with_runner_preference(ActiveRunnerPreference::new(
                RunnerProcessIdentity::new(
                    TEST_RUNNER_ID.parse().unwrap(),
                    TEST_HEARTBEAT_GENERATION + 1,
                )
                .unwrap(),
                runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(source),
                deadline,
            ));
        }
        env.handle.discover_tx.send(candidate).unwrap();
        assert!(
            env.handle
                .wait_deferred_poll_count(1, Duration::from_secs(5))
                .await,
            "{case}"
        );
        assert!(env.handle.claim_candidates().is_empty(), "{case}");
        drop(guard);
        shutdown(&env, run_handle).await;
    }
}

#[tokio::test(start_paused = true)]
async fn duplicate_generic_source_keeps_original_deadline_during_physical_wait() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let reuse_key = "thread:generic-deadline";
    let source = RunId::new_v4();
    let guard = env
        .active_runs
        .register(source, Some(reuse_key.into()), "vm0/default".into());
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let successor = RunId::new_v4();
    env.provider.set_claim_result(
        successor,
        Some(context_with_reuse_key(successor, reuse_key)),
    );
    let deadline = std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME;
    env.handle
        .discover_tx
        .send(generic_finalizing_candidate(
            successor, reuse_key, source, deadline,
        ))
        .unwrap();
    wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.handle
        .discover_tx
        .send(generic_finalizing_candidate(
            successor,
            reuse_key,
            RunId::new_v4(),
            deadline + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let candidates = env.handle.claim_candidates();
    let claimed: Vec<_> = candidates
        .iter()
        .filter(|candidate| candidate.run_id() == successor)
        .collect();
    assert_eq!(claimed.len(), 1);
    let preference = claimed[0].runner_preference().unwrap();
    assert_eq!(
        preference.target(),
        runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(source)
    );
    assert_eq!(preference.deadline(), deadline);
    let finalization_started = tokio::time::Instant::now().into_std();
    assert!(
        guard
            .reuse_publisher()
            .mark_finalizing(finalization_started)
    );
    let grace = crate::finalizing_admission::FINALIZING_HANDOFF_ACCEPTANCE_GRACE;
    tokio::time::advance(grace + Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert!(
        env.handle
            .wait_completion(successor, Duration::ZERO)
            .await
            .is_none()
    );
    let remaining = tokio::time::Instant::from_std(deadline)
        .saturating_duration_since(tokio::time::Instant::now());
    tokio::time::advance(remaining + Duration::from_millis(1)).await;
    let completion = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .expect("generic physical waiting must expire at its original discovery deadline");
    assert!(completion.sandbox_id.is_some());
    assert_eq!(completion.exit_code, 0);
    drop(guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn resolved_generic_source_without_resources_uses_normal_capacity() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:generic-no-resource";
    let source = RunId::new_v4();
    let guard = env
        .active_runs
        .register(source, Some(reuse_key.into()), "vm0/default".into());
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let successor = RunId::new_v4();
    env.provider.set_claim_result(
        successor,
        Some(context_with_reuse_key(successor, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(generic_finalizing_candidate(
            successor,
            reuse_key,
            source,
            std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
    assert!(guard.reuse_publisher().publish_no_exact_sandbox());
    let completion = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .expect("source without a resource must allow ordinary fresh capacity");
    assert_eq!(completion.exit_code, 0);
    assert!(completion.sandbox_id.is_some());
    drop(guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn hard_stop_cancels_generic_wait_without_consuming_source_capacity() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let occupied = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let source = RunId::new_v4();
    let reuse_key = "thread:generic-cancel";
    let guard = env
        .active_runs
        .register(source, Some(reuse_key.into()), "vm0/default".into());
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let successor = RunId::new_v4();
    env.provider.set_claim_result(
        successor,
        Some(context_with_reuse_key(successor, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(generic_finalizing_candidate(
            successor,
            reuse_key,
            source,
            std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_cancel_handle(&env.cancel_tokens, successor, Duration::from_secs(5)).await;
    env.trigger_stopping().await;
    let completion = env
        .handle
        .wait_completion(successor, Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(completion.exit_code, 137);
    assert!(completion.sandbox_id.is_none());
    assert_eq!(budget.allocated(), (2, 4096, 1));
    drop(guard);
    drop(occupied);
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "generic wait must join on hard stop",
    )
    .await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
