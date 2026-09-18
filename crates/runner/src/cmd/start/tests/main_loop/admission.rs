use super::super::super::*;
use super::super::support::{
    SpeculativeIdleSeedSpec, TEST_HEARTBEAT_GENERATION, TEST_RUNNER_ID, assert_run_exits_within,
    context_with_session, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, seed_idle_pool, seed_idle_pool_with_history_generation,
    seed_idle_pool_with_overrides, seed_idle_pool_with_speculative_timezone,
    seed_workspace_cache_state, shutdown, status_idle_reuse_keys_and_active_runs, test_profiles,
    two_profiles, wait_budget_count, wait_cancel_handle, wait_cancel_token,
    wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_len,
    wait_status_idle_reuse_keys_and_active_runs,
};
use std::sync::Arc;

use crate::paths::RunnerPaths;
use crate::provider::{
    ActiveRunnerPreference, RunnerPreference, RunnerPreferenceClaimState, RunnerPreferenceTier,
};
use crate::runner_process_identity::RunnerProcessIdentity;
use crate::types::SandboxReuseResult;
use crate::types::WorkspaceReuseResult;
use crate::workspace_image_cache::{WorkspaceImageCache, WorkspaceImagePrepareLockTestGate};

const NON_SELECTED_RUNNER_ID: u128 = 1;
const FINALIZING_TEST_PREFERENCE_LIFETIME: Duration = Duration::from_secs(30);

fn ranked_candidate(
    run_id: RunId,
    reuse_key: Option<&str>,
    tier: RunnerPreferenceTier,
    runner_id: &str,
    heartbeat_generation: u64,
) -> crate::provider::JobCandidate {
    ranked_candidate_until(
        run_id,
        reuse_key,
        tier,
        runner_id,
        heartbeat_generation,
        std::time::Instant::now() + Duration::from_secs(30),
    )
}

fn ranked_candidate_until(
    run_id: RunId,
    reuse_key: Option<&str>,
    tier: RunnerPreferenceTier,
    runner_id: &str,
    heartbeat_generation: u64,
    deadline: std::time::Instant,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(reuse_key.map(str::to_owned))
        .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
            RunnerProcessIdentity::new(runner_id.parse().unwrap(), heartbeat_generation).unwrap(),
            tier,
            deadline,
        ))
}

fn matching_preference_candidate(run_id: RunId, session_id: &str) -> crate::provider::JobCandidate {
    ranked_candidate(
        run_id,
        Some(session_id),
        RunnerPreferenceTier::ReusableSandbox,
        TEST_RUNNER_ID,
        TEST_HEARTBEAT_GENERATION,
    )
}

fn exact_generation_preference_candidate(
    run_id: RunId,
    session_id: &str,
    target_generation_run_id: RunId,
) -> crate::provider::JobCandidate {
    ranked_candidate(
        run_id,
        Some(session_id),
        RunnerPreferenceTier::ExactSandbox,
        TEST_RUNNER_ID,
        TEST_HEARTBEAT_GENERATION,
    )
    .with_history_generation_run_id(Some(target_generation_run_id))
}

fn finalizing_candidate(
    run_id: RunId,
    reuse_key: &str,
    history_generation_run_id: RunId,
    runner_id: &str,
    heartbeat_generation: u64,
) -> crate::provider::JobCandidate {
    finalizing_candidate_until(
        run_id,
        reuse_key,
        history_generation_run_id,
        runner_id,
        heartbeat_generation,
        std::time::Instant::now() + Duration::from_secs(30),
    )
}

fn finalizing_candidate_until(
    run_id: RunId,
    reuse_key: &str,
    history_generation_run_id: RunId,
    runner_id: &str,
    heartbeat_generation: u64,
    deadline: std::time::Instant,
) -> crate::provider::JobCandidate {
    crate::provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(reuse_key.to_owned()))
        .with_history_generation_run_id(Some(history_generation_run_id))
        .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
            RunnerProcessIdentity::new(runner_id.parse().unwrap(), heartbeat_generation).unwrap(),
            RunnerPreferenceTier::FinalizingPredecessor,
            deadline,
        ))
}

fn context_with_reuse_key(run_id: RunId, reuse_key: &str) -> crate::types::ExecutionContext {
    let mut context = minimal_context(run_id);
    context.reuse_key = Some(reuse_key.to_owned());
    context
}

/// TOCTOU regression: soft drain can arrive after the main loop has selected
/// a discovered candidate but before claim. The candidate is still unowned at
/// that point, so Draining must roll back local admission and skip claim.
#[tokio::test]
async fn claim_after_draining_sent_skips_unclaimed_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    assert!(env.parking_gate.soft_drain());
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Draining;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "draining should skip the discovered unclaimed job and exit",
    )
    .await;

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "draining should not claim or complete a newly discovered job"
    );
}

/// Ordering regression: hard shutdown publishes `Stopping` before entering
/// the cancellation registry's hard-stop barrier. A discovery that registers
/// in that window must observe Stopping and cancel before provider claim. The
/// registry independently covers registrations after the barrier begins; this
/// test isolates the discovery-side mode recheck.
///
/// To reproduce deterministically, we use `send_if_modified` to flip
/// the watch value to `Stopping` **without** waking `mode_rx.changed()`
/// or entering the registry barrier. This is what the pre-barrier window
/// looks like to the main loop: its outer select! is still polling
/// discover_fut, unaware that the value has changed. When discover yields a
/// job, the main loop takes the claim path, registers cancellation, then reads
/// `mode_rx.borrow()` and catches the Stopping value that was silently written.
#[tokio::test]
async fn claim_after_stopping_sent_cancels_new_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Deterministic barrier: wait for run()'s main loop to have polled
    // `discover_fut` into its await state. Only then is the Running-mode
    // reactor `select!` provably in place, which is the precondition for the
    // silent `send_if_modified` below to land without waking the loop.
    // A wall-clock sleep here flakes under coverage CI — see #10146.
    // The 2s timeout gives a clear diagnostic if the "loop parks on
    // discover" invariant ever regresses, rather than hanging until
    // the outer test harness kills us.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Flip the watch value to Stopping without firing changed().
    env.parking_gate.close();
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Stopping;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // `wait_completion` is event-driven (fires on `provider.complete`), so
    // this duration is a diagnostic cap for genuine hangs — not a budget
    // for the run. A large cap absorbs coverage-CI slowdown of the full
    // dispatch→executor→complete chain without flaking (see #10146).
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await;
    assert!(
        c.is_some(),
        "job must report cancellation even when the handler missed the token"
    );
    assert_eq!(c.unwrap().error.as_deref(), Some("cancelled by user"));

    // Let run() exit — fire changed() now so the main loop observes
    // Stopping at loop top and breaks to teardown.
    env.parking_gate.close();
    env.mode_tx.send_modify(|v| {
        *v = RunnerMode::Stopping;
    });
    env.cancel.cancel();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "run should exit within 5s after Stopping notification",
    )
    .await;
}

// -----------------------------------------------------------------------
// Test 4: An unavailable claim rolls back budget
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn claim_failure_rolls_back_budget() {
    // Budget for exactly 1 job (2 vcpu, 4096 MB matches the test profile).
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // First job: claim returns None (unavailable).
    let run_id_1 = RunId::new_v4();
    let target_generation_run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id_1, None);
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id_1, "vm0/default".into())
                .with_history_generation_run_id(Some(target_generation_run_id)),
        )
        .unwrap();

    // Returning to discovery proves the failed claim was processed.
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id_1, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);
    // Second job: claim succeeds — budget should have been freed.
    let run_id_2 = RunId::new_v4();
    push_job(
        &env,
        run_id_2,
        "vm0/default",
        Some(minimal_context(run_id_2)),
    );

    let completion = env
        .handle
        .wait_completion(run_id_2, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "second job should complete (budget freed after unavailable claim)"
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn claim_run_id_mismatch_rolls_back_local_state() {
    // Budget for exactly 1 job, so a leaked lease would block the follow-up job.
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let candidate_run_id = RunId::new_v4();
    let context_run_id = RunId::new_v4();
    push_job(
        &env,
        candidate_run_id,
        "vm0/default",
        Some(minimal_context(context_run_id)),
    );

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, candidate_run_id, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);
    {
        let completions = env.handle.completions.lock().unwrap();
        assert!(
            !completions
                .iter()
                .any(|completion| completion.run_id == candidate_run_id
                    || completion.run_id == context_run_id),
            "mismatched claim should not produce a completion for either run id"
        );
    }

    let followup_run_id = RunId::new_v4();
    push_job(
        &env,
        followup_run_id,
        "vm0/default",
        Some(minimal_context(followup_run_id)),
    );

    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "follow-up job should complete after mismatched claim is rejected"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn exact_idle_reservation_is_restored_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-conflict-restore";
    let reserved_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        reserved_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let conflict_run_id = RunId::new_v4();
    env.provider.set_claim_result(conflict_run_id, None);
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                conflict_run_id,
                Some(session_id),
                RunnerPreferenceTier::ExactSandbox,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            )
            .with_history_generation_run_id(Some(reserved_generation_run_id)),
        )
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, conflict_run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "claim conflict should restore the exact idle reservation"
    );
    assert_eq!(
        budget.allocated(),
        (2, 4096, 1),
        "restored reservation should retain its original budget lease"
    );
    let followup_run_id = RunId::new_v4();
    let followup_target_generation_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        followup_run_id,
        Some(context_with_session(followup_run_id, session_id)),
    );
    env.handle
        .discover_tx
        .send(
            matching_preference_candidate(followup_run_id, session_id)
                .with_history_generation_run_id(Some(followup_target_generation_run_id)),
        )
        .unwrap();
    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await
        .expect("restored idle reservation should serve the next claim");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_reservation_is_restored_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-generic-conflict-restore";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "lost claim should restore the generic reusable reservation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    let ordinary_run_id = RunId::new_v4();
    env.provider.set_claim_result(ordinary_run_id, None);
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(ordinary_run_id, "vm0/default".into())
                .with_reuse_key(Some(session_id.to_owned())),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, ordinary_run_id, Duration::from_secs(5)).await;

    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "ordinary lost claim should also restore the reusable reservation"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unselected_reusable_sandbox_preempts_workspace_preference() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:reusable-preempts-workspace";
    seed_idle_pool(&env.idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("strictly better reusable sandbox should preempt workspace preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn equal_unselected_reusable_sandbox_defers() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:equal-reusable-defers";
    seed_idle_pool(&env.idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::ReusableSandbox,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);
    assert_eq!(
        env.idle_pool.lock().await.held_reuse_keys(),
        vec![reuse_key.to_string()],
        "equal-tier unselected admission must not reserve the sandbox"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reusable_claim_without_generation_target_reuses_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-missing-generation-target";
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        RunId::new_v4(),
    )
    .await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("missing-target reusable candidate should be claimed");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    let claim_candidates = env.handle.claim_candidates();
    let candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("missing-target reusable candidate should reach claim");
    assert_eq!(
        candidate
            .runner_preference()
            .map(ActiveRunnerPreference::tier),
        Some(RunnerPreferenceTier::ReusableSandbox)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reserved_reuse_claim_without_reuse_key_preserves_no_reuse_attribution() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let reuse_key = "candidate-only-reuse-key";
    let reserved_sandbox_id =
        seed_idle_pool(&idle_pool, &budget, reuse_key, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, reuse_key))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claim without a reuse key should fall back to a fresh sandbox");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::NoReuseKey)
    );
    assert_ne!(completion.sandbox_id, Some(reserved_sandbox_id));
    assert_eq!(idle_pool.lock().await.len(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reserved_reuse_persists_preparing_before_unpark_without_post_unpark_pool_wait() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
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
    let preparing_gate = env.start_observer.gate_reserved_preparing_commit();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();

    tokio::select! {
        () = preparing_gate.entered.notified() => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before reserved preparing gate: {completion:?}");
        }
    }
    let status_path = env._temp_dir.path().join("status.json");
    let raw = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(
        status
            .get("idle_sandboxes")
            .and_then(serde_json::Value::as_array)
            .is_none_or(Vec::is_empty)
    );
    let active = status["active_runs"].as_array().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["run_id"], run_id.to_string());
    assert_eq!(active[0]["sandbox_id"], sandbox_id.to_string());
    assert_eq!(active[0]["phase"], "preparing");
    assert_eq!(overrides.unpark_call_count(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());

    let pool_guard = env.idle_pool.lock().await;
    preparing_gate.release();
    env.start_observer
        .wait_for(
            Duration::from_secs(5),
            "running status while idle pool is held",
            |event| match event {
                StartLoopEvent::ActiveRunStatusPublished {
                    run_id: observed_run_id,
                } if *observed_run_id == run_id => Some(()),
                _ => None,
            },
        )
        .await;
    assert_eq!(overrides.unpark_call_count(), 1);
    let raw = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(status["active_runs"][0]["phase"], "running");
    drop(pool_guard);

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("reserved reuse should complete after running publication");
    assert_eq!(completion.sandbox_id, Some(sandbox_id));
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reserved_reuse_running_status_timeout_recovers_claim_and_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let write_started = Arc::new(tokio::sync::Notify::new());
    config.shared.status = Arc::new(StatusTracker::new_with_write_gate(
        status_path.clone(),
        4,
        Arc::clone(&write_started),
        Arc::new(tokio::sync::Semaphore::new(0)),
    ));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    let running_write_started = write_started.notified();
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();
    tokio::select! {
        () = running_write_started => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before running status write gate: {completion:?}");
        }
    }

    let raw = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(status["active_runs"][0]["run_id"], run_id.to_string());
    assert_eq!(status["active_runs"][0]["phase"], "preparing");
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());

    tokio::time::advance(Duration::from_secs(5)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("status timeout should complete the provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("timed out"))
    );
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn hard_shutdown_during_reserved_reuse_running_status_stall_converges() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let write_started = Arc::new(tokio::sync::Notify::new());
    config.shared.status = Arc::new(StatusTracker::new_with_write_gate(
        status_path.clone(),
        4,
        Arc::clone(&write_started),
        Arc::new(tokio::sync::Semaphore::new(0)),
    ));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    let running_write_started = write_started.notified();
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();
    tokio::select! {
        () = running_write_started => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before running status write gate: {completion:?}");
        }
    }
    assert_eq!(overrides.unpark_call_count(), 1);

    let cancel = env.cancel.clone();
    let cancel_tokens = env.cancel_tokens.clone();
    let lifecycle = env.lifecycle.clone();
    let stopping = tokio::spawn(async move {
        handle_stopping_signal("TEST", &cancel, &cancel_tokens, &lifecycle).await;
    });
    tokio::task::yield_now().await;
    assert!(
        !stopping.is_finished(),
        "hard shutdown should wait for the claimed activation transfer"
    );
    tokio::time::advance(Duration::from_secs(5)).await;
    stopping.await.unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("hard shutdown should recover the stalled provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("timed out"))
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should finish after the bounded status failure",
    )
    .await;
    let raw = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(status["mode"], "stopped");
    assert!(status["active_runs"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn reserved_reuse_running_status_write_error_recovers_claim_and_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_dir = env._temp_dir.path().join("status-write-error");
    tokio::fs::create_dir(&status_dir).await.unwrap();
    let status_path = status_dir.join("status.json");
    let status = Arc::new(StatusTracker::new(status_path.clone(), 1, None, None));
    config.shared.status = Arc::clone(&status);
    let preparing_gate = env.start_observer.gate_reserved_preparing_commit();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();
    tokio::select! {
        () = preparing_gate.entered.notified() => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before reserved preparing gate: {completion:?}");
        }
    }
    tokio::fs::remove_file(&status_path).await.unwrap();
    tokio::fs::remove_dir(&status_dir).await.unwrap();
    preparing_gate.release();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("status write error should complete the provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("write runner status"))
    );
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());

    tokio::fs::create_dir(&status_dir).await.unwrap();
    status.set_mode(RunnerMode::Running).await.unwrap();
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn uncertain_activation_destroy_keeps_active_status_for_orphan_reconciliation() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    overrides.push_destroy_panic("simulated activation recovery destroy panic");
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
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
    let status_dir = env._temp_dir.path().join("uncertain-destroy-status");
    tokio::fs::create_dir(&status_dir).await.unwrap();
    let status_path = status_dir.join("status.json");
    let status = Arc::new(StatusTracker::new(status_path.clone(), 1, None, None));
    config.shared.status = Arc::clone(&status);
    let preparing_gate = env.start_observer.gate_reserved_preparing_commit();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();
    tokio::select! {
        () = preparing_gate.entered.notified() => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before reserved preparing gate: {completion:?}");
        }
    }
    tokio::fs::remove_file(&status_path).await.unwrap();
    tokio::fs::remove_dir(&status_dir).await.unwrap();
    preparing_gate.release();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("uncertain recovery should still complete the provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("write runner status"))
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());

    tokio::fs::create_dir(&status_dir).await.unwrap();
    status.set_mode(RunnerMode::Running).await.unwrap();
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(active_runs, vec![run_id.to_string()]);
    let raw = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status_json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        status_json["active_runs"][0]["sandbox_id"],
        sandbox_id.to_string()
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reserved_reuse_activation_task_abort_recovers_claim_and_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let write_started = Arc::new(tokio::sync::Notify::new());
    config.shared.status = Arc::new(StatusTracker::new_with_write_gate(
        status_path.clone(),
        4,
        Arc::clone(&write_started),
        Arc::new(tokio::sync::Semaphore::new(0)),
    ));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    let running_write_started = write_started.notified();
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();
    tokio::select! {
        () = running_write_started => {}
        completion = env.handle.wait_completion(run_id, Duration::from_secs(5)) => {
            panic!("run completed before running status write gate: {completion:?}");
        }
    }
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());

    run_handle.abort();
    assert!(run_handle.await.unwrap_err().is_cancelled());
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("dropping the activation task should complete the provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("task dropped"))
    );
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());
}

#[tokio::test(start_paused = true)]
async fn reserved_reuse_activation_panic_recovers_claim_and_sandbox() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher(&overrides);
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ClaimedActivation);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        &reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, &reuse_key))
        .unwrap();

    assert!(run_handle.await.unwrap_err().is_panic());
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("activation panic should complete the provider claim");
    assert_eq!(
        completion.error.as_deref(),
        Some("claimed activation setup panicked")
    );
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());
}

#[tokio::test(start_paused = true)]
async fn generation_protected_different_idle_sandbox_defers_before_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-different-generation";
    let held_generation_run_id = RunId::new_v4();
    let target_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &idle_pool,
        &budget,
        session_id,
        "vm0/default",
        2,
        4096,
        held_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(exact_generation_preference_candidate(
            run_id,
            session_id,
            target_generation_run_id,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a different reusable generation must not reach claim during exact protection"
    );
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);
    let pool = idle_pool.lock().await;
    assert_eq!(pool.held_reuse_keys(), vec![session_id.to_string()]);
    assert_eq!(
        pool.held_sandbox_states()[0]
            .reusable_sandbox
            .history_generation_run_id,
        Some(held_generation_run_id),
        "the different generation must remain available for fallback after expiry"
    );
    drop(pool);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_without_local_resource_defers_before_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(context_with_session(run_id, "sess-owned-elsewhere")),
    );
    env.handle
        .discover_tx
        .send(matching_preference_candidate(
            run_id,
            "sess-owned-elsewhere",
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    assert!(
        env.handle.claim_candidates().is_empty(),
        "runner must not claim a protected same-reuse-key candidate without local reusable state"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "runner should schedule a follow-up poll after the preference expires"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reusable_active_run_discovery_does_not_bypass_ordinary_capacity_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let occupied = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let active_guard = env.active_runs.register(
        RunId::new_v4(),
        Some("thread:active-capacity-gate".into()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .all(|candidate| candidate.run_id() != run_id),
        "ordinary work must still reserve local capacity before provider claim"
    );

    drop(occupied);
    drop(active_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn selected_finalizing_candidate_claims_while_predecessor_is_running() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let reuse_key = "thread:pending-finalization";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let pending_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        pending_run_id,
        Some(context_with_reuse_key(pending_run_id, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            pending_run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == pending_run_id),
        "selected finalizing candidate should be claimed while the predecessor is active"
    );

    let unrelated_run_id = RunId::new_v4();
    push_job(
        &env,
        unrelated_run_id,
        "vm0/default",
        Some(minimal_context(unrelated_run_id)),
    );
    assert!(
        env.handle
            .wait_completion(unrelated_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "unrelated work should continue while a finalizing candidate is pending"
    );

    drop(predecessor_guard);
    assert!(
        env.handle
            .wait_completion(pending_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "active-key release without a reusable resource should wake ordinary admission"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == pending_run_id)
        .expect("finalizing candidate should already be claimed");
    let preference_telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("finalizing observation should be recorded at claim");
    assert!(matches!(
        preference_telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(
        preference_telemetry.state,
        Some(RunnerPreferenceClaimState::Active)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn finalizing_fallback_starts_fresh_sandbox_before_idle_destroy_finishes() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    fresh_overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, fresh_overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:finalizing-pressure-overlap";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &idle_overrides,
        "thread:unrelated-idle-capacity",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id),
        "finalizing successor should be claimed before fallback"
    );

    drop(predecessor_guard);
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should retire unrelated idle capacity");
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should activate fresh sandbox before destroy completes");
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(env.idle_pool.lock().await.len(), 0);

    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should complete while old destroy remains blocked");
    assert_eq!(completion.exit_code, 0);
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(destroy_gate.entered_count(), 1);

    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn finalizing_capacity_wait_rechecks_when_an_active_sandbox_parks_idle() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let capacity_source_run_id = RunId::new_v4();
    let capacity_source_reuse_key = "thread:capacity-source";
    push_job(
        &env,
        capacity_source_run_id,
        "vm0/default",
        Some(context_with_reuse_key(
            capacity_source_run_id,
            capacity_source_reuse_key,
        )),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("capacity source should hold the full budget while running");
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(env.idle_pool.lock().await.len(), 0);

    let finalizing_reuse_key = "thread:waiting-finalizing-capacity";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(finalizing_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let finalizing_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        finalizing_run_id,
        Some(context_with_reuse_key(
            finalizing_run_id,
            finalizing_reuse_key,
        )),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            finalizing_run_id,
            finalizing_reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == finalizing_run_id),
        "finalizing successor should be claimed before waiting for capacity"
    );

    drop(predecessor_guard);
    env.start_observer
        .wait_finalizing_capacity_wait_entered(finalizing_run_id, Duration::from_secs(5))
        .await;

    wait_gate.release_one();
    let parked_reuse_key = env
        .start_observer
        .wait_sandbox_parked_for_reuse(capacity_source_run_id, Duration::from_secs(5))
        .await;
    assert_eq!(parked_reuse_key, capacity_source_reuse_key);
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("newly idle capacity should be retired without waiting for lease release");
    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should start after the active sandbox becomes idle");
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(env.idle_pool.lock().await.len(), 0);

    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(finalizing_run_id, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should complete while retired cleanup is blocked");
    assert_eq!(completion.exit_code, 0);

    destroy_gate.release_many(2);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn finalizing_immediate_handoff_reuses_matching_sandbox_past_preference_deadline() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_final_exec_park_handoff_point(
        sandbox::SandboxFinalExecParkHandoffPoint::BeforeBalloon,
    );
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reuse_key = "thread:matching-after-finalizing-deadline";
    let predecessor_run_id = RunId::new_v4();
    push_job(
        &env,
        predecessor_run_id,
        "vm0/default",
        Some(context_with_reuse_key(predecessor_run_id, reuse_key)),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should hold the full budget while running");
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let successor_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        successor_run_id,
        Some(context_with_reuse_key(successor_run_id, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            successor_run_id,
            reuse_key,
            predecessor_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            std::time::Instant::now() + Duration::from_millis(100),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == successor_run_id),
        "finalizing successor should be claimed before its preference deadline"
    );

    tokio::time::advance(Duration::from_millis(101)).await;
    wait_gate.release_one();
    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("direct handoff should activate the successor");
    assert_eq!(destroy_gate.entered_count(), 0);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(env.idle_pool.lock().await.len(), 0);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(
        overrides.park_call_count(),
        0,
        "the immediate successor takes over the running sandbox before physical park"
    );
    assert_eq!(
        overrides.completed_final_exec_park_handoff_points(),
        vec![sandbox::SandboxFinalExecParkHandoffPoint::BeforeBalloon],
        "runner integration must exercise the typed immediate-handoff path"
    );

    wait_gate.release_one();
    let predecessor_completion = env
        .handle
        .wait_completion(predecessor_run_id, Duration::from_secs(5))
        .await
        .expect("predecessor should complete after publishing its sandbox");
    let successor_completion = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete with the matching sandbox");
    assert_eq!(
        successor_completion.reuse_result,
        Some(SandboxReuseResult::Reused)
    );
    assert_eq!(
        successor_completion.sandbox_id, predecessor_completion.sandbox_id,
        "successor should reuse the predecessor sandbox without idle publication"
    );

    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn late_finalizing_successor_can_take_over_the_running_predecessor() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let exec_gate = sandbox_mock::MockLifecycleGate::new();
    let park_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.set_park_lifecycle_gate(park_gate.clone());
    overrides.push_final_exec_park_handoff_point(
        sandbox::SandboxFinalExecParkHandoffPoint::DuringDeflation,
    );
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reuse_key = "thread:late-finalizing-handoff";
    let predecessor_run_id = RunId::new_v4();
    push_job(
        &env,
        predecessor_run_id,
        "vm0/default",
        Some(context_with_reuse_key(predecessor_run_id, reuse_key)),
    );
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should consume the only sandbox capacity");

    // Hold the Guest's final reuse-preparation response through the real Runner
    // finalization path. No successor exists yet and physical park remains gated.
    overrides.set_exec_lifecycle_gate(exec_gate.clone());
    wait_gate.release_one();
    exec_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should enter final reuse preparation");
    assert!(
        overrides
            .exec_calls()
            .last()
            .is_some_and(|call| call.cmd.contains("prepare-for-reuse"))
    );
    tokio::time::advance(Duration::from_secs(2)).await;

    let successor_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        successor_run_id,
        Some(context_with_reuse_key(successor_run_id, reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            successor_run_id,
            reuse_key,
            predecessor_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    // Give the newly claimed request time to observe its acceptance deadline
    // while the producer cannot accept it. Its own grace must still be open.
    tokio::time::advance(Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    exec_gate.release_one();

    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("late successor should start without releasing physical park");
    wait_gate.release_one();
    exec_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("successor should finish and enter reuse preparation");
    exec_gate.release_one();
    park_gate.release_one();

    let predecessor_completion = env
        .handle
        .wait_completion(predecessor_run_id, Duration::from_secs(5))
        .await
        .expect("predecessor should complete after its running handoff");
    let successor_completion = env
        .handle
        .wait_completion(successor_run_id, Duration::from_secs(5))
        .await
        .expect("successor should complete with the transferred sandbox");
    assert_eq!(successor_completion.exit_code, 0);
    assert_eq!(
        successor_completion.reuse_result,
        Some(SandboxReuseResult::Reused)
    );
    assert_eq!(
        successor_completion.sandbox_id, predecessor_completion.sandbox_id,
        "late demand must reuse the predecessor instead of waiting for fresh capacity"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn pre_finalization_wait_ends_at_preference_deadline() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 2, overrides);
    let reuse_key = "thread:pre-finalization-preference-deadline";
    let predecessor_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            predecessor_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            std::time::Instant::now() + Duration::from_millis(100),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id)
    );

    tokio::time::advance(Duration::from_millis(99)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        wait_gate.entered_count(),
        0,
        "fresh fallback must not start before the API preference deadline"
    );

    tokio::time::advance(Duration::from_millis(2)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("fresh fallback should start when pre-finalization outlives the preference");
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fallback run should complete after the preference deadline");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn finalizing_handoff_grace_starts_when_predecessor_enters_finalization() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 4, 8192, 2, overrides);
    let reuse_key = "thread:producer-relative-handoff-grace";
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
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            predecessor_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            std::time::Instant::now() + Duration::from_secs(5),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id)
    );

    // The request already exists when finalization begins. Its acceptance grace
    // starts at that transition, independently of the earlier wait start.
    tokio::time::advance(Duration::from_millis(500)).await;
    let finalization_started = tokio::time::Instant::now().into_std();
    assert!(predecessor_reuse.mark_finalizing(finalization_started));
    let finalization_deadline = finalization_started
        + super::super::super::finalizing_claim::FINALIZING_HANDOFF_ACCEPTANCE_GRACE;
    let remaining =
        finalization_deadline.saturating_duration_since(tokio::time::Instant::now().into_std());
    tokio::time::advance(remaining - Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        wait_gate.entered_count(),
        0,
        "fresh fallback must not start inside the producer-relative finalization grace"
    );

    tokio::time::advance(Duration::from_millis(2)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("fresh fallback should start after the finalization grace expires");
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("fallback run should complete after the finalization grace");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn ordinary_and_finalizing_pressure_admission_do_not_double_spend_idle_capacity() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    fresh_overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 2, fresh_overrides);
    let budget = Arc::clone(&config.capacity.budget);
    for reuse_key in ["thread:pressure-idle-first", "thread:pressure-idle-second"] {
        seed_idle_pool_with_overrides(
            &env.idle_pool,
            &budget,
            &idle_overrides,
            reuse_key,
            "vm0/default",
            2,
            4096,
        )
        .await;
    }

    let finalizing_reuse_key = "thread:concurrent-finalizing-pressure";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(finalizing_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let finalizing_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        finalizing_run_id,
        Some(context_with_reuse_key(
            finalizing_run_id,
            finalizing_reuse_key,
        )),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            finalizing_run_id,
            finalizing_reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == finalizing_run_id)
    );

    let ordinary_run_id = RunId::new_v4();
    drop(predecessor_guard);
    push_job(
        &env,
        ordinary_run_id,
        "vm0/default",
        Some(minimal_context(ordinary_run_id)),
    );

    destroy_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("ordinary and finalizing admission should each retire one idle sandbox");
    wait_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("both fresh runs should activate while old destroys remain blocked");
    assert_eq!(budget.allocated(), (4, 8192, 2));
    assert_eq!(env.idle_pool.lock().await.len(), 0);

    wait_gate.release_one();
    wait_gate.release_one();
    for run_id in [ordinary_run_id, finalizing_run_id] {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .expect("both admitted runs should complete before old idle teardown");
        assert_eq!(completion.exit_code, 0);
    }
    assert_eq!(destroy_gate.entered_count(), 2);

    destroy_gate.release_one();
    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancelled_finalizing_capacity_wait_releases_retiring_leases_but_keeps_cleanup_owned() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (config, env) = mock_run_config_with_overrides(two_profiles(), 5, 8192, 2, fresh_overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let occupied = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
        .expect("active work should reserve half the budget");
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &idle_overrides,
        "thread:retiring-idle-capacity",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let reuse_key = "thread:cancelled-finalizing-capacity";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/large".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/large".into())
                .with_reuse_key(Some(reuse_key.to_owned()))
                .with_history_generation_run_id(Some(history_generation_run_id))
                .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
                    RunnerProcessIdentity::new(
                        TEST_RUNNER_ID.parse().unwrap(),
                        TEST_HEARTBEAT_GENERATION,
                    )
                    .unwrap(),
                    RunnerPreferenceTier::FinalizingPredecessor,
                    std::time::Instant::now() + Duration::from_secs(30),
                )),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    drop(predecessor_guard);
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("finalizing fallback should retire idle capacity before waiting");
    assert_eq!(budget.allocated(), (4, 8192, 2));
    cancellation.request_hard_cancellation().await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cancelled finalizing fallback should report completion");
    assert_eq!(completion.exit_code, 137);
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert_eq!(destroy_gate.entered_count(), 1);

    destroy_gate.release_one();
    drop(occupied);
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_ranked_finalizing_candidate_falls_back_at_deadline() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:ranked-finalizing-retained";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    let deadline = std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME;
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                deadline,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("selected finalizing candidate should be claimed before its deadline");
    let preference = claimed
        .runner_preference()
        .expect("claimed finalizing candidate should retain its preference");
    assert_eq!(
        preference.tier(),
        RunnerPreferenceTier::FinalizingPredecessor
    );
    assert_eq!(preference.deadline(), deadline);

    tokio::time::advance(FINALIZING_TEST_PREFERENCE_LIFETIME + Duration::from_millis(1)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("expired finalizing preference should enter ordinary admission");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn pending_finalizing_fallback_skips_workspace_cache_lock_retry() {
    let reuse_key = "thread:pending-finalizing-workspace-lock";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 2, 4096, 1);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let prepare_lock_gate = WorkspaceImagePrepareLockTestGate::default();
    let workspace_cache =
        WorkspaceImageCache::shared(runner_paths, &config.paths.home, &config.runner.group)
            .with_prepare_lock_test_gate(prepare_lock_gate);
    let cache_key = crate::paths::scoped_workspace_image_cache_key(
        &config.runner.group,
        "vm0/default",
        reuse_key,
        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
        image_size_bytes,
    );
    let held_lock = crate::lock::acquire(crate::paths::workspace_image_cache_lock_path(
        &config.paths.home.locks_dir(),
        &cache_key,
    ))
    .await
    .unwrap();
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);

    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id),
        "finalizing successor should be claimed before its deadline"
    );

    tokio::time::advance(FINALIZING_TEST_PREFERENCE_LIFETIME + Duration::from_millis(1)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("known long-lived workspace lock should not enter bounded retry");
    assert_eq!(
        completion.workspace_reuse_result,
        Some(WorkspaceReuseResult::LockBusy),
    );

    drop(held_lock);
    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn finalizing_handoff_starts_before_existing_idle_cleanup() {
    let predecessor_gate = sandbox_mock::MockLifecycleGate::new();
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(predecessor_gate.clone());
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 5, 8192, 2, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:pending-exact-resource";
    let history_generation_run_id = RunId::new_v4();
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    push_job(
        &env,
        history_generation_run_id,
        "vm0/default",
        Some(context_with_reuse_key(history_generation_run_id, reuse_key)),
    );
    let _predecessor_cancel = wait_cancel_token(
        &env.cancel_tokens,
        history_generation_run_id,
        Duration::from_secs(5),
    )
    .await;
    predecessor_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("predecessor should still be running when its successor is discovered");
    seed_idle_pool_with_overrides(
        &env.idle_pool,
        &budget,
        &overrides,
        reuse_key,
        "vm0/default",
        2,
        4096,
    )
    .await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[history_generation_run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    predecessor_gate.release_one();
    predecessor_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .expect("direct handoff should activate the successor without idle cleanup");
    assert_eq!(
        destroy_gate.entered_count(),
        0,
        "predecessor handoff should not replace the existing idle sandbox"
    );
    env.handle
        .wait_completion(history_generation_run_id, Duration::from_secs(5))
        .await
        .expect("predecessor should report completion after direct handoff");
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[reuse_key],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;
    assert!(
        env.handle
            .wait_completion(run_id, Duration::ZERO)
            .await
            .is_none(),
        "predecessor cleanup must not remove or cancel the active successor"
    );

    predecessor_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("sandbox publication should wake the claimed successor");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("successor parking should replace the older idle sandbox");
    destroy_gate.release_one();
    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn published_exact_remains_reusable_past_preference_deadline() {
    let successor_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(successor_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:published-past-preference-deadline";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
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
            history_generation_run_id,
            guest_timezone_intent: crate::guest_timezone::GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await;
    assert!(predecessor_reuse.publish_exact_sandbox());
    successor_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("published exact sandbox should start before predecessor release");

    tokio::time::advance(FINALIZING_TEST_PREFERENCE_LIFETIME + Duration::from_millis(1)).await;
    successor_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("published exact sandbox should remain reusable past the preference deadline");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "exact activation should retain the original claim"
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn no_exact_resolution_falls_back_before_predecessor_release() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:no-exact-before-release";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    assert!(predecessor_reuse.publish_no_exact_sandbox());
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("no-exact outcome should start fallback before predecessor release");
    assert_ne!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "fallback should retain the original claim"
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn cancelled_finalizing_activation_restores_exact_over_refilled_blank() {
    let (mut config, env) = mock_run_config(test_profiles(), 16, 32_768, 8);
    config.capacity.max_idle = 1;
    *env.idle_pool.lock().await =
        IdlePool::new_with_parking_gate(IdlePoolConfig { max_idle: 1 }, env.parking_gate.clone());
    let budget = Arc::clone(&config.capacity.budget);
    // Keep ordinary refill below its headroom requirement until exact activation
    // has reserved the predecessor's sandbox.
    let occupied = ResourceBudget::try_reserve_lease(&budget, 12, 24_576).unwrap();
    let reuse_key = "thread:cancelled-exact-blank-refill";
    let predecessor_run_id = RunId::new_v4();
    let predecessor = env.active_runs.register(
        predecessor_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            predecessor_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    let transfer_guard = cancellation.transfer_guard().await;
    let cancel_request = cancellation.request_hard_cancellation();
    tokio::pin!(cancel_request);
    // Queue cancellation before activation at the real ownership-transfer gate.
    assert!(futures_util::poll!(&mut cancel_request).is_pending());

    let exact_id = seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        predecessor_run_id,
    )
    .await;
    assert!(predecessor_reuse.publish_exact_sandbox());
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;

    drop(occupied);
    wait_idle_pool_len(&env.idle_pool, 1, Duration::from_secs(5)).await;
    assert_eq!(env.idle_pool.lock().await.blank_len(), 1);
    assert_eq!(budget.allocated().2, 2);

    drop(transfer_guard);
    assert!(cancel_request.await);
    env.handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("cancelled finalizing activation should complete");
    {
        let pool = env.idle_pool.lock().await;
        assert!(
            pool.has_reusable(reuse_key, "vm0/default", &None),
            "rollback must preserve the exact sandbox when a blank filled its idle slot"
        );
        assert_eq!(pool.blank_len(), 0);
        assert_eq!(
            pool.status_snapshot().idle_sandboxes[0].sandbox_id,
            exact_id
        );
    }
    assert_eq!(budget.allocated().2, 1);

    let followup_run_id = RunId::new_v4();
    push_job(
        &env,
        followup_run_id,
        "vm0/default",
        Some(context_with_reuse_key(followup_run_id, reuse_key)),
    );
    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await
        .expect("restored exact sandbox should serve the next run");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(completion.sandbox_id, Some(exact_id));

    drop(predecessor);
    shutdown(&env, run_handle).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}

#[tokio::test]
async fn competing_finalizing_successors_reserve_exact_generation_once() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:competing-finalizing-successors";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let predecessor_reuse = predecessor_guard.reuse_publisher();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let first_run_id = RunId::new_v4();
    let second_run_id = RunId::new_v4();
    for run_id in [first_run_id, second_run_id] {
        env.provider
            .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
        env.handle
            .discover_tx
            .send(finalizing_candidate(
                run_id,
                reuse_key,
                history_generation_run_id,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            ))
            .unwrap();
        wait_discover_entered(&env, Duration::from_secs(5)).await;
    }

    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    assert!(predecessor_reuse.publish_exact_sandbox());

    let first = env
        .handle
        .wait_completion(first_run_id, Duration::from_secs(5))
        .await
        .expect("first finalizing successor should complete");
    let second = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second finalizing successor should complete");
    assert_eq!(
        [first.reuse_result, second.reuse_result]
            .into_iter()
            .filter(|result| *result == Some(SandboxReuseResult::Reused))
            .count(),
        1,
        "an exact history generation must be reserved by at most one successor"
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn hard_stop_cancels_claimed_finalizing_candidate_without_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:hard-stop-finalizing";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    env.trigger_stopping().await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("hard-stopped finalizing successor should complete");
    assert_eq!(completion.exit_code, 137);
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    drop(predecessor_guard);
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard stop should drain a claimed finalizing successor",
    )
    .await;
    assert_eq!(
        env.handle
            .completions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|record| record.run_id == run_id)
            .count(),
        1
    );
}

#[tokio::test]
async fn pre_sandbox_panic_completes_finalizing_claim_once_without_status() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ClaimedWithoutSandbox);
    let status_path = env._temp_dir.path().join("status.json");
    let reuse_key = "thread:panic-before-sandbox";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("pre-sandbox panic should complete the claimed run");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(
        completion.error.as_deref(),
        Some("runner panicked while preparing a claimed finalizing successor")
    );
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_eq!(
        env.handle
            .completions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|record| record.run_id == run_id)
            .count(),
        1
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unselected_exact_sandbox_preempts_finalizing_preference() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:exact-preempts-finalizing";
    let history_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(
            ranked_candidate(
                run_id,
                Some(reuse_key),
                RunnerPreferenceTier::FinalizingPredecessor,
                &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
                1,
            )
            .with_history_generation_run_id(Some(history_generation_run_id)),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("strictly better exact sandbox should preempt finalizing preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_finalizing_candidate_restores_exact_resource_after_claim_loss() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = "thread:finalizing-claim-loss";
    let history_generation_run_id = RunId::new_v4();
    seed_idle_pool_with_history_generation(
        &env.idle_pool,
        &budget,
        reuse_key,
        "vm0/default",
        2,
        4096,
        history_generation_run_id,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert_eq!(
        env.idle_pool.lock().await.held_reuse_keys(),
        vec![reuse_key.to_string()],
        "lost claim should restore the exact reusable resource"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn non_selected_finalizing_candidate_is_not_retained() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:non-selected-finalization";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            &uuid::Uuid::from_u128(NON_SELECTED_RUNNER_ID).to_string(),
            1,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    drop(predecessor_guard);
    tokio::task::yield_now().await;
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn same_run_duplicate_does_not_renew_claimed_finalizing_deadline() {
    let (config, env) = mock_run_config(test_profiles(), 4, 8192, 2);
    let reuse_key = "thread:pending-duplicate";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    let original_deadline = std::time::Instant::now() + FINALIZING_TEST_PREFERENCE_LIFETIME;
    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            original_deadline,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "the first discovery should claim the finalizing successor"
    );

    env.handle
        .discover_tx
        .send(finalizing_candidate_until(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
            original_deadline + FINALIZING_TEST_PREFERENCE_LIFETIME,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert_eq!(
        env.handle
            .claim_candidates()
            .iter()
            .filter(|candidate| candidate.run_id() == run_id)
            .count(),
        1,
        "a duplicate discovery must not claim the same run again"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("claimed finalizing candidate should retain the first decision");
    let preference = claimed
        .runner_preference()
        .expect("claimed finalizing candidate should retain its preference");
    assert_eq!(
        preference.tier(),
        RunnerPreferenceTier::FinalizingPredecessor
    );
    assert_eq!(
        preference.deadline(),
        original_deadline,
        "a duplicate discovery must not renew the claimed finalizing deadline"
    );

    tokio::time::advance(FINALIZING_TEST_PREFERENCE_LIFETIME + Duration::from_millis(1)).await;
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "the original deadline should start fallback despite a later duplicate"
    );

    drop(predecessor_guard);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn multiple_finalizing_candidates_can_be_claimed_concurrently() {
    let (config, env) = mock_run_config(test_profiles(), 6, 12288, 3);
    let first_reuse_key = "thread:pending-slot-first";
    let second_reuse_key = "thread:pending-slot-second";
    let first_history_generation_run_id = RunId::new_v4();
    let second_history_generation_run_id = RunId::new_v4();
    let first_guard = env.active_runs.register(
        first_history_generation_run_id,
        Some(first_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let second_guard = env.active_runs.register(
        second_history_generation_run_id,
        Some(second_reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let first_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        first_run_id,
        Some(context_with_reuse_key(first_run_id, first_reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            first_run_id,
            first_reuse_key,
            first_history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let second_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        second_run_id,
        Some(context_with_reuse_key(second_run_id, second_reuse_key)),
    );
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            second_run_id,
            second_reuse_key,
            second_history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == first_run_id),
        "the first finalizing successor should be claimed"
    );
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == second_run_id),
        "a second finalizing successor should not be blocked by a process-local pending slot"
    );

    drop(first_guard);
    drop(second_guard);
    assert!(
        env.handle
            .wait_completion(first_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "the first claimed successor should fall back after predecessor release"
    );
    assert!(
        env.handle
            .wait_completion(second_run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "the second claimed successor should fall back independently"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn drain_waits_for_claimed_finalizing_candidate() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let reuse_key = "thread:pending-drain";
    let history_generation_run_id = RunId::new_v4();
    let predecessor_guard = env.active_runs.register(
        history_generation_run_id,
        Some(reuse_key.to_owned()),
        "vm0/default".into(),
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, reuse_key)));
    env.handle
        .discover_tx
        .send(finalizing_candidate(
            run_id,
            reuse_key,
            history_generation_run_id,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == run_id),
        "the finalizing successor should be claimed before drain"
    );

    env.drain();
    drop(predecessor_guard);
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "drain should finish the already claimed finalizing successor and exit",
    )
    .await;
    assert!(
        env.handle
            .wait_completion(run_id, Duration::ZERO)
            .await
            .is_some()
    );
}

#[tokio::test(start_paused = true)]
async fn preference_without_reuse_key_uses_ordinary_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            None,
            RunnerPreferenceTier::ReusableSandbox,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "incomplete preference metadata is advisory"
    );
    assert!(env.handle.deferred_poll_deadlines().is_empty());
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn selected_finalizing_candidate_without_reuse_key_uses_ordinary_admission() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(minimal_context(run_id)));
    env.handle
        .discover_tx
        .send(
            crate::provider::JobCandidate::new(run_id, "vm0/default".into())
                .with_history_generation_run_id(Some(RunId::new_v4()))
                .with_runner_preference_for_test(ActiveRunnerPreference::ranked_for_test(
                    RunnerProcessIdentity::new(
                        TEST_RUNNER_ID.parse().unwrap(),
                        TEST_HEARTBEAT_GENERATION,
                    )
                    .unwrap(),
                    RunnerPreferenceTier::FinalizingPredecessor,
                    std::time::Instant::now() + Duration::from_secs(30),
                )),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "missing reuse metadata should preserve ordinary admission"
    );
    let claimed = env
        .handle
        .claim_candidates()
        .into_iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("candidate with incomplete reuse metadata should reach provider claim");
    assert!(
        claimed.runner_preference().is_none(),
        "ordinary admission should clear the incomplete advisory preference"
    );
    let preference_telemetry = claimed
        .runner_preference_claim_telemetry()
        .expect("incomplete finalizing metadata should preserve its observation");
    assert!(matches!(
        preference_telemetry.runner_preference,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::FinalizingPredecessor,
            ..
        }
    ));
    assert_eq!(
        preference_telemetry.state,
        Some(RunnerPreferenceClaimState::Cleared)
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn matching_preference_uses_actual_local_sandbox_without_resource_class() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-local-without-resource";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, session_id)));
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("actual compatible sandbox should satisfy matching preference");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert!(env.handle.deferred_poll_deadlines().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_continues_after_preference_defer() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let trigger_run_id = RunId::new_v4();
    let protected_run_id = RunId::new_v4();
    let followup_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        protected_run_id,
        Some(context_with_session(
            protected_run_id,
            "sess-owned-elsewhere",
        )),
    );
    env.provider
        .set_claim_result(followup_run_id, Some(minimal_context(followup_run_id)));
    env.handle
        .push_ready_candidate(matching_preference_candidate(
            protected_run_id,
            "sess-owned-elsewhere",
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            followup_run_id,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(minimal_context(trigger_run_id)),
    );

    let trigger_completion = env
        .handle
        .wait_completion(trigger_run_id, Duration::from_secs(5))
        .await;
    assert!(
        trigger_completion.is_some(),
        "trigger job should complete before ready-candidate drain assertions"
    );
    let followup_completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        followup_completion.is_some(),
        "ready drain should continue to a later candidate after deferring a protected one"
    );
    wait_cancel_token_removed(&env.cancel_tokens, protected_run_id, Duration::from_secs(5)).await;

    let claim_candidates = env.handle.claim_candidates();
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == trigger_run_id),
        "trigger candidate should be claimed"
    );
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == followup_run_id),
        "follow-up ready candidate should be claimed"
    );
    assert!(
        !claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == protected_run_id),
        "protected ready candidate should be deferred before claim"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "protected ready candidate should schedule one follow-up poll"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_continues_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let trigger_run_id = RunId::new_v4();
    let conflict_run_id = RunId::new_v4();
    let followup_run_id = RunId::new_v4();
    env.provider.set_claim_result(conflict_run_id, None);
    env.provider
        .set_claim_result(followup_run_id, Some(minimal_context(followup_run_id)));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            conflict_run_id,
            "vm0/default".into(),
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            followup_run_id,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(minimal_context(trigger_run_id)),
    );

    let trigger_completion = env
        .handle
        .wait_completion(trigger_run_id, Duration::from_secs(5))
        .await;
    assert!(trigger_completion.is_some(), "trigger job should complete");
    let followup_completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        followup_completion.is_some(),
        "ready drain should continue to a later candidate after a claim conflict"
    );
    wait_cancel_token_removed(&env.cancel_tokens, conflict_run_id, Duration::from_secs(5)).await;

    let claim_candidates = env.handle.claim_candidates();
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == conflict_run_id),
        "claim conflict candidate should reach claim"
    );
    assert!(
        claim_candidates
            .iter()
            .any(|candidate| candidate.run_id() == followup_run_id),
        "follow-up ready candidate should still be claimed"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn expired_generation_protection_preserves_local_session_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-held-local",
        "vm0/default",
        2,
        4096,
    )
    .await;
    assert!(
        !budget.can_afford(2, 4096),
        "the parked sandbox should exhaust all fresh admission capacity"
    );

    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(context_with_session(run_id, "sess-held-local")),
    );
    env.handle
        .discover_tx
        .send(
            ranked_candidate_until(
                run_id,
                Some("sess-held-local"),
                RunnerPreferenceTier::ExactSandbox,
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
                std::time::Instant::now() - Duration::from_secs(1),
            )
            .with_history_generation_run_id(Some(RunId::new_v4())),
        )
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("runner holding the protected session should claim and execute the job");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    let claim_candidates = env.handle.claim_candidates();
    let claimed_candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("claim should record the protected candidate");
    assert!(
        claimed_candidate
            .main_loop_to_local_admission_elapsed()
            .is_some()
    );
    assert!(
        env.handle.deferred_poll_deadlines().is_empty(),
        "runner holding the protected session should not defer the claim"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn selected_reusable_defers_for_cache_then_selected_workspace_claims_it() {
    let reuse_key = "thread:cache-local";
    let provider_session_id = "provider-session-cache-local";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        image_size_bytes,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let reusable_run_id = RunId::new_v4();
    let mut reusable_context = context_with_session(reusable_run_id, provider_session_id);
    reusable_context.reuse_key = Some(reuse_key.into());
    env.provider
        .set_claim_result(reusable_run_id, Some(reusable_context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            reusable_run_id,
            Some(reuse_key),
            RunnerPreferenceTier::ReusableSandbox,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "workspace-cache state must not satisfy a selected reusable preference"
    );
    assert_eq!(env.handle.deferred_poll_deadlines().len(), 1);

    let run_id = RunId::new_v4();
    let mut workspace_context = context_with_session(run_id, provider_session_id);
    workspace_context.reuse_key = Some(reuse_key.into());
    env.provider
        .set_claim_result(run_id, Some(workspace_context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "runner should claim from the startup workspace-cache snapshot even if a later scan would miss"
    );

    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "the workspace-selected candidate should not add another deferral"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn saturated_cache_only_holder_defers_before_reclaiming_unrelated_idle() {
    let reuse_key = "thread:cache-saturated";
    let provider_session_id = "provider-session-cache-saturated";
    let image_size_bytes = 1024 * 1024;
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 2, 4096, 1);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        image_size_bytes,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);

    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    seed_idle_pool(
        &idle_pool,
        &budget,
        "sess-unrelated-idle",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, provider_session_id);
    context.reuse_key = Some(reuse_key.into());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(ranked_candidate(
            run_id,
            Some(reuse_key),
            RunnerPreferenceTier::WorkspaceCache,
            TEST_RUNNER_ID,
            TEST_HEARTBEAT_GENERATION,
        ))
        .unwrap();

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert!(
        env.handle.claim_candidates().is_empty(),
        "a cache-only preference must not bypass exhausted fresh admission"
    );
    assert_eq!(
        env.handle.deferred_poll_deadlines().len(),
        1,
        "workspace-selected work should defer when fresh budget is unavailable"
    );
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec!["sess-unrelated-idle".to_string()],
        "preference deferral must happen before candidate-aware reclamation"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn ready_direct_drain_batches_reuse_state_heartbeat() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 12, 49152, 6, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let trigger_session = "sess-batch-trigger";
    let ready_session_1 = "sess-batch-ready-1";
    let ready_session_2 = "sess-batch-ready-2";
    for session_id in [trigger_session, ready_session_1, ready_session_2] {
        seed_idle_pool_with_overrides(
            &env.idle_pool,
            &budget,
            &overrides,
            session_id,
            "vm0/default",
            2,
            4096,
        )
        .await;
    }
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let heartbeat_count = env.handle.heartbeat_count();

    let trigger_run_id = RunId::new_v4();
    let ready_run_id_1 = RunId::new_v4();
    let ready_run_id_2 = RunId::new_v4();
    env.provider.set_claim_result(
        trigger_run_id,
        Some(context_with_session(trigger_run_id, trigger_session)),
    );
    env.provider.set_claim_result(
        ready_run_id_1,
        Some(context_with_session(ready_run_id_1, ready_session_1)),
    );
    env.provider.set_claim_result(
        ready_run_id_2,
        Some(context_with_session(ready_run_id_2, ready_session_2)),
    );
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            ready_run_id_1,
            "vm0/default".into(),
        ));
    env.handle
        .push_ready_candidate(crate::provider::JobCandidate::new(
            ready_run_id_2,
            "vm0/default".into(),
        ));

    push_job(
        &env,
        trigger_run_id,
        "vm0/default",
        Some(context_with_session(trigger_run_id, trigger_session)),
    );

    wait_gate
        .wait_entered(3, Duration::from_secs(5))
        .await
        .expect("all reused jobs should block in wait_process");
    assert!(
        env.handle
            .wait_heartbeat_past(heartbeat_count, Duration::from_secs(5))
            .await,
        "reusing direct-candidate sessions should trigger a prompt heartbeat"
    );
    assert_eq!(
        env.handle.heartbeat_count(),
        heartbeat_count + 1,
        "direct-candidate drain should batch reuse-state refresh into one heartbeat"
    );

    let claimed_run_ids: std::collections::HashSet<RunId> = env
        .handle
        .claim_candidates()
        .into_iter()
        .map(|candidate| candidate.run_id())
        .collect();
    assert_eq!(
        claimed_run_ids,
        std::collections::HashSet::from([trigger_run_id, ready_run_id_1, ready_run_id_2])
    );

    wait_gate.release_many(3);
    for run_id in [trigger_run_id, ready_run_id_1, ready_run_id_2] {
        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await;
        assert!(completion.is_some(), "run {run_id} should complete");
    }

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 6: Unknown profile is skipped without affecting subsequent jobs
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn unknown_profile_skipped() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Push a job with a profile that doesn't exist in the profiles map.
    // The main loop should log a warning and continue without claiming.
    let bad_id = RunId::new_v4();
    push_job(
        &env,
        bad_id,
        "vm0/nonexistent",
        Some(minimal_context(bad_id)),
    );

    // The next discover wait proves the bad job was consumed and skipped.
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push a valid job — it should succeed despite the earlier bad one.
    let good_id = RunId::new_v4();
    push_job(&env, good_id, "vm0/default", Some(minimal_context(good_id)));

    let completion = env
        .handle
        .wait_completion(good_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "valid job should complete after unknown profile is skipped"
    );

    // The bad job should never have been claimed (no completion recorded).
    {
        let comps = env.handle.completions.lock().unwrap();
        assert!(
            !comps.iter().any(|c| c.run_id == bad_id),
            "unknown-profile job should not produce a completion"
        );
    }

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 7: Duplicate discovery (same run_id) is deduplicated
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn duplicate_discovery_deduplicated() {
    // Budget for the running job plus one reusable idle sandbox.
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-duplicate-reservation";
    seed_idle_pool(&idle_pool, &budget, session_id, "vm0/default", 2, 4096).await;
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for the original job to be claimed and blocked at the sandbox gate.
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push the same run_id again with a matching-reuse preference. The duplicate first
    // owns the idle reservation, then must restore it when the cancellation
    // registry reports that the original run already owns local admission.
    env.handle
        .discover_tx
        .send(matching_preference_candidate(run_id, session_id))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    assert_eq!(
        idle_pool.lock().await.held_reuse_keys(),
        vec![session_id.to_string()],
        "duplicate rejection should restore the reusable reservation"
    );

    // Wait for the original job to complete.
    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "original job should complete");

    // Only one completion should exist for this run_id.
    {
        let comps = env.handle.completions.lock().unwrap();
        let count = comps.iter().filter(|c| c.run_id == run_id).count();
        assert_eq!(
            count, 1,
            "duplicate discovery should not produce a second completion"
        );
    }
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
}
