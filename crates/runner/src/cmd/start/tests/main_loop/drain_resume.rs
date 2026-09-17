use super::super::super::signals::handle_resume_signal;
use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_overrides, push_job, seed_idle_pool_with_overrides, shutdown,
    test_profiles, wait_cancel_token, wait_cancel_token_removed, wait_discover_entered,
    wait_parking_state, wait_status_mode,
};
use crate::idle_pool::ParkingState;
use std::sync::Arc;

// -----------------------------------------------------------------------
// Draining / resume / hard-shutdown state machine
// -----------------------------------------------------------------------

/// SIGUSR1 → SIGUSR2 round-trip. While draining, the runner keeps the
/// in-flight job alive and, on resume, returns to claiming new jobs.
#[tokio::test]
async fn drain_then_resume_keeps_jobs_running() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a job and let it reach the gated wait.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining. The job keeps running; no cancellation is fired.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // Resume. Job is still alive in the executor.
    env.resume();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;

    // Release the gated job so it completes normally.
    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete after resume");
    let c = completion.unwrap();
    assert_eq!(c.exit_code, 0, "job ran to normal completion");
    assert!(c.error.is_none(), "no cancellation error");

    // Runner is back in Running — a second job is claimed (cancel_token
    // inserted). Don't wait for completion here; the shared wait_process_gate
    // would also block this job's exit.
    let run_id_2 = RunId::new_v4();
    push_job(
        &env,
        run_id_2,
        "vm0/default",
        Some(minimal_context(run_id_2)),
    );
    let _token_2 = wait_cancel_token(&env.cancel_tokens, run_id_2, Duration::from_secs(5)).await;

    // Tear down hard — the shared gate would otherwise block the
    // second job's natural completion during Draining.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "run should exit within 5s after hard shutdown",
    )
    .await;
}

/// Regression guard for the unified reactor's Draining-entry state.
///
/// The first SIGUSR1 drains the idle pool, then SIGUSR2 resumes Running.
/// A later job completion parks a sandbox, and the second SIGUSR1 must drain
/// that newly parked sandbox. If `draining_idle_pool_drained` is not reset on
/// Running, the second drain skips idle-pool cleanup and leaks budget.
#[tokio::test]
async fn drain_resume_then_second_drain_drains_idle_pool() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-second-drain")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);

    env.resume();
    wait_parking_state(&idle_pool, ParkingState::Open, Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Running);

    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete after resume");
    assert_eq!(idle_pool.lock().await.len(), 1, "job should park a sandbox");
    assert_eq!(
        budget.allocated().2,
        1,
        "parked sandbox should hold a budget slot"
    );

    env.drain();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "second drain should exit within 5s",
    )
    .await;

    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "second drain must clear the idle pool",
    );
    assert_eq!(
        budget.allocated().2,
        0,
        "second drain must release the parked sandbox budget",
    );
}

/// With no active jobs, SIGUSR1 transitions straight through Draining
/// and exits within a few hundred ms.
#[tokio::test]
async fn drain_without_active_jobs_exits_promptly() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.drain();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "drain with no active jobs should exit within 2s",
    )
    .await;
}

/// A repeat SIGUSR1 while already Draining is an idempotent no-op:
/// it must not downgrade to a hard stop or disturb the in-flight job.
#[tokio::test]
async fn repeated_drain_while_draining_keeps_active_job_running() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter the lifecycle gate");

    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert!(
        !run_handle.is_finished(),
        "soft drain must wait for the active job"
    );

    env.drain();
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    assert_eq!(env.parking_gate.state(), ParkingState::SoftDraining);
    assert!(
        !token.is_cancelled(),
        "repeat drain must not cancel the active job"
    );

    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete after the gate is released");
    assert_eq!(completion.exit_code, 0, "job ran to normal completion");
    assert!(completion.error.is_none(), "no cancellation error");
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "run should exit after repeated drain and natural job completion",
    )
    .await;
}

/// SIGUSR2 on an already-Running runner is a no-op: it does not disturb
/// normal discovery.
#[tokio::test(start_paused = true)]
async fn resume_on_running_is_noop() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // SIGUSR2 while already Running — state guard blocks the send,
    // leaving mode unchanged and discovery uninterrupted.
    env.resume();

    // Runner is still claiming jobs.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "resume on Running should not break discovery"
    );

    shutdown(&env, run_handle).await;
}

/// SIGUSR2 received while Stopping is committed is ignored — the
/// runner cannot resume out of Stopping.
#[tokio::test]
async fn resume_after_stopping_is_ignored() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Wait for the main loop to park on `discover_fut` so the subsequent
    // `trigger_stopping` lands on a steady-state loop rather than racing
    // against startup. This test does not depend on the silent-flip
    // semantics of `claim_after_stopping_sent_cancels_new_job` (it uses
    // `trigger_stopping`, which fires `changed()`), but the same barrier
    // is still the right "main loop is idle" signal — and deterministic
    // under coverage CI, unlike the 50 ms sleep this replaces.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Enter Stopping first.
    env.trigger_stopping().await;

    // handle_resume_signal refuses any transition except from Draining.
    handle_resume_signal(&env.lifecycle);
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "mode must remain Stopping after ignored SIGUSR2"
    );

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "hard shutdown should exit within 2s",
    )
    .await;
}

/// Draining auto-transitions to Stopping when jobs drain naturally.
/// Verifies the internal lifecycle transition from Draining to Stopping.
#[tokio::test]
async fn drain_with_jobs_transitions_to_stopping_when_empty() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Let a quick job complete, then drain.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;

    // Wait for the main loop to reap the completed job, then drain.
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    env.drain();

    // Draining mode should observe jobs.is_empty() and self-send
    // Stopping, leading to teardown and run() exit.
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "Draining natural drain should exit within 3s",
    )
    .await;

    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "mode_tx must reflect Stopping after natural drain transition"
    );
    assert_eq!(env.parking_gate.state(), ParkingState::Closed);

    // Observability pin: the Draining → Stopping auto-transition must
    // emit a one-shot heartbeat with mode="stopping" before teardown,
    // in addition to the terminal heartbeat during teardown. Two or
    // more "stopping" heartbeats prove both sites fire (the one-shot
    // at the transition and the terminal one). A single hit would mean
    // one of the two was removed.
    let stopping_count = env
        .handle
        .heartbeats
        .lock()
        .unwrap()
        .iter()
        .filter(|h| h.mode == "stopping")
        .count();
    assert!(
        stopping_count >= 2,
        "expected at least 2 stopping heartbeats (one-shot + terminal), got {stopping_count}",
    );
}

/// Race regression: the Draining → Stopping auto-transition must be
/// guarded on `mode == Draining`, so a concurrent SIGUSR2 that flips
/// mode back to Running is preserved rather than silently overwritten.
///
/// Hold idle sandbox destruction after the reactor has captured Draining,
/// with no active jobs. Resume through the real signal handler, then release
/// destruction so the same Draining branch attempts the stale natural stop.
/// The next iteration must publish Running and process subsequent work.
#[tokio::test]
async fn draining_auto_stop_preserves_concurrent_resume() {
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    let idle_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    idle_overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");

    // Only this idle sandbox uses the destroy gate; subsequent work and
    // teardown use the regular mock runtime and cannot block on it.
    seed_idle_pool_with_overrides(
        &config.shared.idle_pool,
        &config.capacity.budget,
        &idle_overrides,
        "sess-concurrent-resume",
        "vm0/default",
        2,
        4096,
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    env.drain();
    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("Draining should wait for idle sandbox destruction");
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    assert_eq!(env.parking_gate.state(), ParkingState::SoftDraining);

    env.resume();
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Running);
    assert_eq!(env.parking_gate.state(), ParkingState::Open);

    // The reactor is still inside Draining with an empty job set. Once
    // destruction returns, it must reject the stale natural-stop attempt
    // before the next iteration can persist Running.
    destroy_gate.release_one();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Running,
        "SIGUSR2 must win the race against the Draining auto-Stop",
    );
    assert_eq!(env.parking_gate.state(), ParkingState::Open);

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("runner should claim and complete subsequent work after resume");
    assert_eq!(completion.exit_code, 0, "job ran to normal completion");
    assert!(completion.error.is_none(), "no cancellation error");
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Tear down cleanly.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s after concurrent resume race",
    )
    .await;
}
