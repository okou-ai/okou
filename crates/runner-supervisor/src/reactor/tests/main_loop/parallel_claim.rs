use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, minimal_context, mock_run_config, push_job, shutdown, test_profiles,
    wait_budget_count, wait_cancel_token_removed, wait_status_mode,
};
use crate::reactor::claim_tasks::MAX_IN_FLIGHT_CLAIMS;

#[tokio::test]
async fn fast_claim_executes_while_earlier_claim_is_blocked_and_duplicate_is_skipped() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let budget = Arc::clone(&config.capacity.budget);
    let slow = RunId::new_v4();
    let fast = RunId::new_v4();
    env.handle.block_claim(slow);
    let runner = tokio::spawn(run(config));
    push_job(&env, slow, "vm0/default", Some(minimal_context(slow)));
    assert!(
        env.handle
            .wait_run_claim_in_flight(slow, Duration::from_secs(10))
            .await
    );

    // A duplicate must not occupy another reservation or provider claim.
    push_job(&env, slow, "vm0/default", Some(minimal_context(slow)));
    push_job(&env, fast, "vm0/default", Some(minimal_context(fast)));
    let completion = env
        .handle
        .wait_completion(fast, Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());
    assert!(
        env.handle
            .wait_run_claim_in_flight(slow, Duration::from_secs(10))
            .await
    );
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == slow)
            .count(),
        1
    );
    assert_eq!(env.handle.max_claim_in_flight(), 2);

    env.handle.unblock_claim(slow);
    assert_eq!(
        env.handle
            .wait_completion(slow, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    wait_cancel_token_removed(&env.cancel_tokens, slow, Duration::from_secs(10)).await;
    wait_cancel_token_removed(&env.cancel_tokens, fast, Duration::from_secs(10)).await;
    assert_eq!(env.handle.completions.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn concurrent_claims_have_finite_backpressure_and_all_queued_jobs_complete() {
    let (config, env) = mock_run_config(test_profiles(), 128, 262144, 32);
    env.handle.block_claims();
    let runner = tokio::spawn(run(config));
    let runs: Vec<_> = (0..MAX_IN_FLIGHT_CLAIMS + 2)
        .map(|_| RunId::new_v4())
        .collect();
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    assert!(
        env.handle
            .wait_claim_in_flight(MAX_IN_FLIGHT_CLAIMS, Duration::from_secs(10))
            .await
    );
    assert_eq!(env.handle.claim_candidates().len(), MAX_IN_FLIGHT_CLAIMS);
    env.handle.unblock_claims();
    for &run_id in &runs {
        assert_eq!(
            env.handle
                .wait_completion(run_id, Duration::from_secs(10))
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    shutdown(&env, runner).await;
    assert_eq!(env.handle.max_claim_in_flight(), MAX_IN_FLIGHT_CLAIMS);
    assert_eq!(env.handle.claim_candidates().len(), runs.len());
    assert_eq!(env.handle.completions.lock().unwrap().len(), runs.len());
    assert!(!env.handle.shutdown_with_claim_in_flight());
}

#[tokio::test]
async fn ready_direct_candidates_claim_in_parallel() {
    let (config, env) = mock_run_config(test_profiles(), 32, 65536, 16);
    env.handle.block_claims();
    let runs: Vec<_> = (0..MAX_IN_FLIGHT_CLAIMS).map(|_| RunId::new_v4()).collect();
    for &run_id in &runs[1..] {
        env.provider
            .set_claim_result(run_id, Some(minimal_context(run_id)));
        env.handle
            .push_ready_candidate(runner_provider::JobCandidate::new(
                run_id,
                "vm0/default".to_owned(),
            ));
    }
    let runner = tokio::spawn(run(config));
    push_job(&env, runs[0], "vm0/default", Some(minimal_context(runs[0])));
    assert!(
        env.handle
            .wait_claim_in_flight(MAX_IN_FLIGHT_CLAIMS, Duration::from_secs(10))
            .await
    );
    env.handle.unblock_claims();
    for &run_id in &runs {
        assert_eq!(
            env.handle
                .wait_completion(run_id, Duration::from_secs(10))
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    shutdown(&env, runner).await;
    assert_eq!(env.handle.max_claim_in_flight(), MAX_IN_FLIGHT_CLAIMS);
}

#[tokio::test]
async fn capacity_is_stricter_than_the_parallel_claim_limit() {
    // Five host CPUs fund two 2-vCPU profiles after fractional host headroom.
    let (mut config, env) = mock_run_config(test_profiles(), 5, 32768, 2);
    // Isolate claim capacity from the background blank-preparation reservation.
    config.capacity.max_idle = 0;
    let budget = Arc::clone(&config.capacity.budget);
    env.handle.block_claims();
    let runner = tokio::spawn(run(config));
    let runs = [RunId::new_v4(), RunId::new_v4(), RunId::new_v4()];
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    assert!(
        env.handle
            .wait_claim_in_flight(2, Duration::from_secs(10))
            .await
    );
    assert_eq!(env.handle.claim_candidates().len(), 2);
    env.handle.unblock_claims();
    for &run_id in &runs {
        assert_eq!(
            env.handle
                .wait_completion(run_id, Duration::from_secs(10))
                .await
                .expect("capacity-gated candidate must remain queued until capacity frees")
                .exit_code,
            0
        );
    }
    shutdown(&env, runner).await;
    assert_eq!(env.handle.max_claim_in_flight(), 2);
    assert_eq!(env.handle.claim_candidates().len(), runs.len());
    assert_eq!(env.handle.completions.lock().unwrap().len(), runs.len());
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
}

#[tokio::test]
async fn rejected_parallel_claim_releases_capacity_without_completing_an_unowned_run() {
    let (mut config, env) = mock_run_config(test_profiles(), 5, 32768, 2);
    config.capacity.max_idle = 0;
    let budget = Arc::clone(&config.capacity.budget);
    let rejected = RunId::new_v4();
    let fast = RunId::new_v4();
    let later = RunId::new_v4();
    env.handle.block_claim(rejected);
    let runner = tokio::spawn(run(config));
    push_job(&env, rejected, "vm0/default", None);
    assert!(
        env.handle
            .wait_run_claim_in_flight(rejected, Duration::from_secs(10))
            .await
    );
    push_job(&env, fast, "vm0/default", Some(minimal_context(fast)));
    assert_eq!(
        env.handle
            .wait_completion(fast, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    env.handle.unblock_claim(rejected);
    wait_cancel_token_removed(&env.cancel_tokens, rejected, Duration::from_secs(10)).await;
    push_job(&env, later, "vm0/default", Some(minimal_context(later)));
    assert_eq!(
        env.handle
            .wait_completion(later, Duration::from_secs(10))
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    assert!(
        !env.handle
            .completions
            .lock()
            .unwrap()
            .iter()
            .any(|completion| completion.run_id == rejected)
    );
}

#[tokio::test]
async fn soft_drain_settles_parallel_claims_and_does_not_admit_later_work() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let budget = Arc::clone(&config.capacity.budget);
    let runs = [RunId::new_v4(), RunId::new_v4()];
    env.handle.block_claims();
    let runner = tokio::spawn(run(config));
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    assert!(
        env.handle
            .wait_claim_in_flight(2, Duration::from_secs(10))
            .await
    );
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(10)).await;
    let later = RunId::new_v4();
    push_job(&env, later, "vm0/default", Some(minimal_context(later)));
    assert!(!env.handle.shutdown_with_claim_in_flight());
    env.handle.unblock_claims();
    for &run_id in &runs {
        assert_eq!(
            env.handle
                .wait_completion(run_id, Duration::from_secs(10))
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    assert_run_exits_within(
        runner,
        Duration::from_secs(10),
        "soft drain must settle both admitted claims",
    )
    .await;
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    assert_eq!(env.handle.claim_candidates().len(), 2);
    assert_eq!(env.handle.completions.lock().unwrap().len(), 2);
    assert!(!env.handle.shutdown_with_claim_in_flight());
}

#[tokio::test]
async fn hard_stop_joins_parallel_claims_before_provider_shutdown_and_completes_each() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let budget = Arc::clone(&config.capacity.budget);
    let runs = [RunId::new_v4(), RunId::new_v4()];
    env.handle.block_claims();
    let runner = tokio::spawn(run(config));
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    assert!(
        env.handle
            .wait_claim_in_flight(2, Duration::from_secs(10))
            .await
    );
    env.trigger_stopping().await;
    wait_status_mode(&status_path, "stopping", Duration::from_secs(10)).await;
    assert!(!env.handle.shutdown_with_claim_in_flight());
    env.handle.unblock_claims();
    for &run_id in &runs {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap();
        assert_ne!(completion.exit_code, 0);
        assert!(completion.error.is_some());
    }
    assert_run_exits_within(
        runner,
        Duration::from_secs(10),
        "hard stop must not abandon successful claims",
    )
    .await;
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    for &run_id in &runs {
        wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(10)).await;
    }
    assert_eq!(env.handle.completions.lock().unwrap().len(), 2);
    assert!(!env.handle.shutdown_with_claim_in_flight());
}

#[tokio::test]
async fn completed_claims_progress_without_reactor_polling_and_recover_on_result_drop() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    config.capacity.max_idle = 0;
    let budget = Arc::clone(&config.capacity.budget);
    let runs = [RunId::new_v4(), RunId::new_v4()];
    env.handle.block_claims();
    for &run_id in &runs {
        push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    }
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before claims entered: {result:?}"),
        entered = env.handle.wait_claim_in_flight(2, Duration::from_secs(10)) => assert!(entered),
    }
    // Deliberately do not poll Reactor again. Both independently scheduled
    // claims finish, but no result can transfer to activation.
    env.handle.unblock_claims();
    assert!(
        env.handle
            .wait_claim_in_flight(0, Duration::from_secs(10))
            .await
    );
    drop(reactor);
    for &run_id in &runs {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(10))
            .await
            .unwrap();
        assert_ne!(completion.exit_code, 0);
        assert!(completion.sandbox_id.is_none());
        wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(10)).await;
    }
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    assert_eq!(env.handle.completions.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn dropped_reactor_keeps_claim_alive_and_recovers_its_unconsumed_success() {
    let (mut config, env) = mock_run_config(test_profiles(), 4, 32768, 2);
    config.capacity.max_idle = 0;
    let budget = Arc::clone(&config.capacity.budget);
    let run_id = RunId::new_v4();
    env.handle.block_claim(run_id);
    let runner = tokio::spawn(run(config));
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    assert!(
        env.handle
            .wait_run_claim_in_flight(run_id, Duration::from_secs(10))
            .await
    );
    runner.abort();
    assert!(runner.await.unwrap_err().is_cancelled());
    env.handle.unblock_claim(run_id);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await
        .unwrap();
    assert_ne!(completion.exit_code, 0);
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(10)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(10)).await;
    assert_eq!(env.handle.claim_candidates().len(), 1);
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
}
