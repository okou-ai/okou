fn local_reuse_candidate(run_id: RunId, reuse_key: &str) -> runner_provider::JobCandidate {
    runner_provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(reuse_key.to_owned()))
}

use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_overrides, push_job, seed_home_cache_state, seed_idle_pool,
    seed_idle_pool_with_history_generation, seed_idle_pool_with_overrides, shutdown,
    status_idle_reuse_keys_and_active_runs, test_profiles, two_profiles, wait_budget_count,
    wait_cancel_token, wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_len,
    wait_status_idle_reuse_keys_and_active_runs, wait_status_mode,
};
use sandbox::SandboxId;
use std::sync::Arc;

use crate::home_image_cache::HomeImageCache;
use runner_host::paths::RunnerPaths;

mod local_home;

fn context_with_reuse_key(run_id: RunId, reuse_key: &str) -> runner_types::types::ExecutionContext {
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
    env.provider.set_claim_result(run_id_1, None);
    env.handle
        .discover_tx
        .send(runner_provider::JobCandidate::new(
            run_id_1,
            "vm0/default".into(),
        ))
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
async fn idle_reservation_is_restored_after_claim_conflict() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-conflict-restore";
    let reserved_generation_run_id = RunId::new_v4();
    let reused_sandbox_id = seed_idle_pool_with_history_generation(
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
        .send(local_reuse_candidate(conflict_run_id, session_id))
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
    env.provider.set_claim_result(
        followup_run_id,
        Some(context_with_session(followup_run_id, session_id)),
    );
    env.handle
        .discover_tx
        .send(local_reuse_candidate(followup_run_id, session_id))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await
        .expect("restored idle reservation should serve the next claim");
    assert_eq!(completion.sandbox_id, Some(reused_sandbox_id));
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn reusable_claim_without_generation_target_reuses_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&env.idle_pool);
    let session_id = "sess-missing-generation-target";
    let reused_sandbox_id = seed_idle_pool_with_history_generation(
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
        .send(local_reuse_candidate(run_id, session_id))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("missing-target reusable candidate should be claimed");
    assert_eq!(completion.sandbox_id, Some(reused_sandbox_id));
    let claim_candidates = env.handle.claim_candidates();
    let candidate = claim_candidates
        .iter()
        .find(|candidate| candidate.run_id() == run_id)
        .expect("missing-target reusable candidate should reach claim");
    assert_eq!(candidate.reuse_key(), Some(session_id));

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
        .send(local_reuse_candidate(run_id, reuse_key))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claim without a reuse key should fall back to a fresh sandbox");
    assert_eq!(completion.exit_code, 0);
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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
        completion.error.as_deref().is_some_and(
            |error| error.contains("is unconfirmed (configured publication budget: 5s)")
        )
    );
    assert_eq!(completion.sandbox_id, None);
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test]
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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
    // Stopping can be visible from the mode-change write before teardown's
    // second publication completes. Join both real writes before advancing
    // the deliberately stalled activation's deadline.
    wait_status_mode(&status_path, "stopping", Duration::from_secs(5)).await;
    env.start_observer
        .wait_for(Duration::from_secs(5), "claim-task drain", |event| {
            matches!(event, StartLoopEvent::ClaimsDrainEntered).then_some(())
        })
        .await;
    assert!(
        !stopping.is_finished(),
        "hard shutdown should wait for the claimed activation transfer"
    );
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(5)).await;
    tokio::time::resume();
    stopping.await.unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("hard shutdown should recover the stalled provider claim");
    assert!(
        completion.error.as_deref().is_some_and(
            |error| error.contains("is unconfirmed (configured publication budget: 5s)")
        )
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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
async fn fresh_activation_status_failure_retains_lease_until_completion() {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("fresh-activation-status.json");
    let status = Arc::new(StatusTracker::new(status_path.clone(), 1, None, None));
    config.shared.status = Arc::clone(&status);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Replacing the status file with a directory makes atomic publication fail.
    tokio::fs::remove_file(&status_path).await.unwrap();
    tokio::fs::create_dir(&status_path).await.unwrap();
    env.handle.block_completions();
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("status failure should complete the fresh claim without an executor");
    assert!(completion.error.as_deref().is_some_and(|error| {
        error.starts_with("persist active runner ownership: write runner status")
    }));
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(env.handle.completion_in_flight(), 1);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(env.active_runs.contains(run_id));
    assert!(env.cancel_tokens.handle(run_id).await.is_some());
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.destroy_call_count(), 0);

    tokio::fs::remove_dir(&status_path).await.unwrap();
    status.set_mode(RunnerMode::Running).await.unwrap();
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(active_runs, vec![run_id.to_string()]);

    env.handle.unblock_completions();
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert!(!env.active_runs.contains(run_id));
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;
    assert_eq!(overrides.destroy_call_count(), 0);
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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

#[tokio::test]
async fn reserved_reuse_activation_outlives_reactor_abort_and_recovers_claim_and_sandbox() {
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
    let write_release = Arc::new(tokio::sync::Semaphore::new(0));
    config.shared.status = Arc::new(StatusTracker::new_with_write_gate(
        status_path.clone(),
        4,
        Arc::clone(&write_started),
        Arc::clone(&write_release),
    ));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_session(run_id, &reuse_key)));
    let running_write_started = write_started.notified();
    env.handle
        .discover_tx
        .send(local_reuse_candidate(run_id, &reuse_key))
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
    assert!(env.handle.completions.lock().unwrap().is_empty());
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(env.active_runs.contains(run_id));
    assert!(env.cancel_tokens.handle(run_id).await.is_some());
    // Reactor observation is gone, but the accepted activation stays alive.
    // Its eventual guarded result must recover when nobody can consume it.
    write_release.add_permits(1);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("the unconsumed activation result should complete the provider claim");
    assert!(
        completion
            .error
            .as_deref()
            .is_some_and(|error| error.contains("task dropped"))
    );
    assert_eq!(completion.sandbox_id, None);
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
        .send(local_reuse_candidate(run_id, &reuse_key))
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
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert!(active_runs.is_empty());
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

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    super::super::support::wait_budget_exhausted_reactor(&env, Duration::from_secs(2)).await;
    assert!(
        env.handle
            .claim_candidates()
            .iter()
            .all(|candidate| candidate.run_id() != run_id),
        "ordinary work must still reserve local capacity before provider claim"
    );

    drop(occupied);
    drop(active_guard);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("queued local work must run when ordinary capacity returns");
    assert_eq!(completion.exit_code, 0);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn saturated_home_claim_reclaims_only_the_needed_parked_sandbox() {
    for blank_count in 0..=2 {
        assert_saturated_claim_reclaims_parked_sandbox(blank_count, true).await;
    }
}

#[tokio::test]
async fn saturated_fresh_claim_reclaims_nonmatching_parked_profiles() {
    for blank_count in 0..=2 {
        assert_saturated_claim_reclaims_parked_sandbox(blank_count, false).await;
    }
}

#[tokio::test]
async fn rejected_pressure_claim_releases_capacity_while_status_state_is_blocked() {
    let (config, env) = mock_run_config(two_profiles(), 9, 16384, 2);
    let budget = Arc::clone(&config.capacity.budget);
    let status = Arc::clone(&config.shared.status);
    let status_path = env._temp_dir.path().join("status.json");
    for reuse_key in ["unrelated-pressure-first", "unrelated-pressure-second"] {
        seed_idle_pool(&env.idle_pool, &budget, reuse_key, "vm0/large", 4, 8192).await;
    }
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let holder = status.hold_state_for_test().await;
    let mut status_waits = status.idle_snapshot_waits_for_test();
    let run_id = RunId::new_v4();
    env.handle.block_claim(run_id);
    push_job(&env, run_id, "vm0/default", None);
    assert!(
        env.handle
            .wait_run_claim_in_flight(run_id, Duration::from_secs(2))
            .await,
        "status-state contention must not delay a fitting claim"
    );
    tokio::time::timeout(
        Duration::from_secs(2),
        status_waits.wait_for(|waits| *waits > 0),
    )
    .await
    .expect("accepted publication should wait independently for status state")
    .unwrap();
    assert_eq!(budget.allocated(), (6, 12288, 2));

    env.handle.unblock_claim(run_id);
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(2)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(2)).await;
    assert_eq!(budget.allocated(), (4, 8192, 1));
    assert_eq!(env.handle.claim_candidates().len(), 1);
    assert!(env.handle.completions.lock().unwrap().is_empty());
    assert_eq!(env.idle_pool.lock().await.len(), 1);

    drop(holder);
    shutdown(&env, run_handle).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
    let persisted: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(status_path).await.unwrap()).unwrap();
    assert_eq!(persisted["mode"], "stopped");
    assert!(persisted.get("idle_sandboxes").is_none());
}

async fn assert_saturated_claim_reclaims_parked_sandbox(blank_count: usize, home_preferred: bool) {
    let reuse_key = "thread:cache-saturated";
    let provider_session_id = "provider-session-cache-saturated";
    let mut profiles = two_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let fresh_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 9, 16384, 2, Arc::clone(&fresh_overrides));
    let status_path = env._temp_dir.path().join("status.json");
    let status_write_started = Arc::new(tokio::sync::Notify::new());
    let release_status_write = Arc::new(tokio::sync::Semaphore::new(0));
    config.shared.status = Arc::new(StatusTracker::new_with_atomic_write_gate(
        status_path.clone(),
        3, // Initial and Running snapshots precede reclaimed-pool publication.
        Arc::clone(&status_write_started),
        Arc::clone(&release_status_write),
    ));
    if home_preferred {
        let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
        let home_cache = HomeImageCache::shared(
            runner_paths.clone(),
            &config.paths.home,
            &config.runner.group,
        );
        seed_home_cache_state(
            &home_cache,
            &runner_paths,
            reuse_key,
            "vm0/default",
            1024 * 1024,
        )
        .await;
        Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(home_cache);
    }

    let budget = Arc::clone(&config.capacity.budget);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let parked_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    parked_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let parked_factory: Arc<Box<dyn sandbox::SandboxFactory>> = Arc::new(Box::new(
        sandbox_mock::MockSandboxFactory::with_overrides(Arc::clone(&parked_overrides)),
    ));
    let mut parked_ids = Vec::new();
    for index in 0..2 {
        let sandbox_id = SandboxId::new_v4();
        let sandbox = Box::new(sandbox_mock::MockSandbox::with_overrides(
            sandbox_id.to_string(),
            Arc::clone(&parked_overrides),
        ));
        let lease = ResourceBudget::try_reserve_lease(&budget, 4, 8192).unwrap();
        let candidate = if index < blank_count {
            runner_lifecycle::idle_pool::ParkedIdleCandidate::blank(
                sandbox,
                Arc::clone(&parked_factory),
                lease,
                sandbox_id,
                "vm0/large".into(),
                "hash2".into(),
                None,
            )
        } else {
            runner_lifecycle::idle_pool::test_support::ParkedIdleCandidateBuilder::new(
                format!("unrelated-idle-{index}"),
                lease,
            )
            .with_sandbox(sandbox)
            .with_factory(Arc::clone(&parked_factory))
            .with_sandbox_id(sandbox_id)
            .with_profile_name("vm0/large")
            .with_rootfs_hash("hash2")
            .build()
        };
        assert!(matches!(
            idle_pool.lock().await.park_at_for_test(
                candidate,
                std::time::Instant::now() - Duration::from_secs(2 - index as u64),
            ),
            runner_lifecycle::idle_pool::ParkResult::Parked
        ));
        parked_ids.push(sandbox_id);
    }
    assert!(!budget.can_afford(2, 4096));
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, provider_session_id);
    context.reuse_key = Some(reuse_key.into());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle.block_claim(run_id);
    let candidate = local_reuse_candidate(run_id, reuse_key);
    env.handle.discover_tx.send(candidate).unwrap();

    assert!(
        env.handle
            .wait_run_claim_in_flight(run_id, Duration::from_secs(2))
            .await,
        "fitting capacity must reach claim before reclaimed-pool status is persisted"
    );
    tokio::time::timeout(Duration::from_secs(2), status_write_started.notified())
        .await
        .expect("reclaimed-pool publication should remain independently owned");
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("the selected parked sandbox should enter tracked cleanup");
    assert_eq!(budget.allocated(), (6, 12288, 2));
    release_status_write.add_permits(1);
    env.handle.unblock_claim(run_id);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("the claim should complete while old post-exit cleanup is blocked");
    assert_eq!(completion.exit_code, 0);
    assert!(!parked_ids.contains(&completion.sandbox_id.unwrap()));
    assert_eq!(destroy_gate.entered_count(), 1);
    assert_eq!(
        fresh_overrides.create_configs()[0]
            .home_drive
            .as_ref()
            .unwrap()
            .seed_image
            .is_some(),
        home_preferred,
        "home-preferred replacement must create from the retained home"
    );

    let snapshot = idle_pool.lock().await.status_snapshot();
    let remaining = snapshot
        .idle_sandboxes
        .iter()
        .map(|sandbox| sandbox.sandbox_id)
        .chain(
            snapshot
                .blank_sandboxes
                .iter()
                .map(|sandbox| sandbox.sandbox_id),
        )
        .collect::<Vec<_>>();
    assert!(!remaining.contains(&parked_ids[0]));
    assert!(remaining.contains(&parked_ids[1]));
    assert!(budget.allocated().2 <= 2);

    destroy_gate.release_one();
    destroy_gate.release_one();
    shutdown(&env, run_handle).await;
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(status_path).await.unwrap()).unwrap();
    assert_eq!(status["mode"], "stopped");
    assert!(status.get("idle_sandboxes").is_none());
    assert!(status.get("blank_sandboxes").is_none());
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
        .send(local_reuse_candidate(run_id, session_id))
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
