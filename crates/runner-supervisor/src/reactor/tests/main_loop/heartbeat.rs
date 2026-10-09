use super::super::super::*;
use super::super::support::{
    MockRunEnv, assert_run_exits_within, minimal_context, mock_run_config,
    mock_run_config_with_delay, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_budget_count, wait_budget_exhausted_reactor, wait_cancel_token, wait_cancel_token_removed,
    wait_discover_entered, wait_status_idle_reuse_keys_and_active_runs, wait_status_mode,
};
use crate::status::StatusPersistenceError;
use sandbox::SandboxId;
use std::sync::Arc;

async fn wait_for_blocked_routine_heartbeat(env: &MockRunEnv) {
    wait_discover_entered(env, Duration::from_secs(2)).await;
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(5))
            .await,
        "first routine heartbeat should enter the provider",
    );
    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(5))
            .await,
        "first routine heartbeat should remain blocked",
    );
}

async fn trigger_routine_heartbeat(
    trigger: &tokio::sync::mpsc::UnboundedSender<()>,
    env: &MockRunEnv,
    expected_mode: RunnerMode,
) {
    let cursor = env.start_observer.cursor();
    trigger
        .send(())
        .expect("manual routine heartbeat receiver should remain open");
    env.start_observer
        .wait_routine_heartbeat_requested_after(cursor, expected_mode, Duration::from_secs(5))
        .await;
}

#[tokio::test]
async fn routine_heartbeat_retries_unpublished_status() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (heartbeat_trigger, heartbeat_trigger_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_trigger_rx);
    let status_parent = env._temp_dir.path().join("status-state");
    let unavailable_parent = env._temp_dir.path().join("status-state-unavailable");
    tokio::fs::create_dir(&status_parent).await.unwrap();
    let status_path = status_parent.join("status.json");
    let status = Arc::new(StatusTracker::new(status_path.clone(), 4, None, None));
    config.shared.status = Arc::clone(&status);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    status.add_run(run_id, sandbox_id).await.unwrap();
    wait_status_idle_reuse_keys_and_active_runs(
        &status_path,
        &[],
        &[run_id.to_string()],
        Duration::from_secs(5),
    )
    .await;

    tokio::fs::rename(&status_parent, &unavailable_parent)
        .await
        .unwrap();
    let error = status
        .remove_run_if_matching(run_id, sandbox_id)
        .await
        .unwrap_err();
    assert!(matches!(error, StatusPersistenceError::Write { .. }));
    tokio::fs::rename(&unavailable_parent, &status_parent)
        .await
        .unwrap();

    trigger_routine_heartbeat(&heartbeat_trigger, &env, RunnerMode::Running).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 2: Discover survives heartbeat ticks (regression #8783)
//
// ApiProvider's discover() has an internal poll timer (30s) that must
// survive heartbeat ticks (10s). Without pinning, `select!` cancels
// and recreates discover() each tick, restarting the timer from scratch.
//
// We use poll_delay=20s to simulate this: if the future is pinned, the
// delay completes at t=20s and the job is discovered. If not pinned,
// heartbeat at t=10s restarts the delay → it won't complete until t=30s.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn discover_survives_heartbeat_ticks() {
    let (config, env) = mock_run_config_with_delay(
        test_profiles(),
        8,
        32768,
        4,
        Duration::from_secs(20), // poll delay: 20s
    );
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_discover_poll_started(Duration::from_secs(5))
            .await,
        "discover poll delay should start before virtual time advances"
    );

    // Push job immediately — it's in the channel, waiting for
    // discover to finish its poll delay and read it.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Advance to the first heartbeat while the 20s discover delay is still
    // pending, then let the runner task observe the ready timer.
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    tokio::task::yield_now().await;
    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(1))
            .await,
        "heartbeat should fire while discover poll delay is running"
    );

    // Advance past the rest of the 20s poll delay. If discover was cancelled
    // and recreated at t=10s, the delay restarts and this is still too early.
    tokio::time::advance(Duration::from_secs(15)).await;

    // Job should have been discovered and completed.
    // If discover was cancelled and recreated at t=10s, the 20s delay
    // restarts → at t=25s only 15s of the second delay has elapsed →
    // job not discovered yet → this assertion fails.
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await;
    assert!(
        completion.is_some(),
        "job should complete — discover must survive heartbeat ticks (regression #8783)"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn blocked_heartbeat_does_not_block_job_discovery_or_reaping() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_heartbeats();
    let run_handle = tokio::spawn(run(config));
    wait_for_blocked_routine_heartbeat(&env).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    assert!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "job should complete while heartbeat I/O is blocked",
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    assert_eq!(env.handle.heartbeat_in_flight(), 1);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
    env.handle.unblock_heartbeats();
    assert!(
        env.handle
            .wait_heartbeat_in_flight(0, Duration::from_secs(5))
            .await,
        "blocked heartbeat should finish after release",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn heartbeat_triggers_coalesce_into_one_current_mode_follow_up() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let (heartbeat_trigger, heartbeat_trigger_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_trigger_rx);
    let status_path = env._temp_dir.path().join("status.json");
    env.handle.block_heartbeats();
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("job should finish pre-spawn before the first routine heartbeat");

    trigger_routine_heartbeat(&heartbeat_trigger, &env, RunnerMode::Running).await;
    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(5))
            .await,
        "first routine heartbeat should enter the provider",
    );
    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(5))
            .await,
        "first routine heartbeat should remain blocked",
    );

    // Change mode without notifying the reactor. The next routine tick must
    // both wake the reactor and coalesce a current-mode follow-up.
    env.mode_tx.send_if_modified(|mode| {
        *mode = RunnerMode::Draining;
        false
    });
    trigger_routine_heartbeat(&heartbeat_trigger, &env, RunnerMode::Draining).await;
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // A further tick while the first request is blocked must collapse into
    // the same dirty follow-up rather than overlap or queue another payload.
    trigger_routine_heartbeat(&heartbeat_trigger, &env, RunnerMode::Draining).await;
    assert_eq!(env.handle.heartbeat_count(), 1);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);

    // Flip again without notifying or adding another trigger. The follow-up
    // must sample mode when the active send completes, not retain the mode
    // observed by the trigger that marked it dirty.
    env.mode_tx.send_if_modified(|mode| {
        *mode = RunnerMode::Running;
        false
    });

    env.handle.unblock_heartbeats();
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(5))
            .await,
        "coalesced trigger should produce one follow-up",
    );
    assert!(
        env.handle
            .wait_heartbeat_in_flight(0, Duration::from_secs(5))
            .await,
        "follow-up heartbeat should finish",
    );

    {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(heartbeats.len(), 2);
        assert_eq!(heartbeats[0].mode, "running");
        assert_eq!(heartbeats[1].mode, "running");
        assert_eq!(heartbeats[1].running_count, 1);
        assert_eq!(heartbeats[0].snapshot_generation, 7);
        assert_eq!(heartbeats[1].snapshot_generation, 7);
        assert_eq!(heartbeats[0].snapshot_sequence, 1);
        assert_eq!(heartbeats[1].snapshot_sequence, 2);
    }
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);

    wait_gate.release_one();
    assert!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "gated job should complete after release",
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn hard_shutdown_drains_current_heartbeat_and_discards_pending_work() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    env.handle.block_heartbeats();
    let run_handle = tokio::spawn(run(config));
    wait_for_blocked_routine_heartbeat(&env).await;

    // Add an ordinary pending trigger, then enter Stopping. The reactor must
    // observe the mode while provider I/O is still blocked, but teardown must
    // wait for the current send rather than assuming drop cancels it remotely.
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    tokio::task::yield_now().await;
    env.mode_tx.send(RunnerMode::Stopping).unwrap();
    wait_status_mode(&status_path, "stopping", Duration::from_secs(5)).await;

    assert!(!run_handle.is_finished());
    assert_eq!(env.handle.heartbeat_count(), 1);
    assert_eq!(env.handle.heartbeat_in_flight(), 1);

    env.handle.unblock_heartbeats();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should finish after the current heartbeat is released",
    )
    .await;

    {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let modes: Vec<&str> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.mode.as_str())
            .collect();
        let sequences: Vec<u64> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.snapshot_sequence)
            .collect();
        assert_eq!(modes, ["running", "stopping"]);
        assert_eq!(sequences, [1, 2]);
        assert!(
            heartbeats
                .iter()
                .all(|heartbeat| heartbeat.snapshot_generation == 7)
        );
    }
    assert_eq!(env.handle.heartbeat_in_flight(), 0);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
}

#[tokio::test(start_paused = true)]
async fn natural_shutdown_flushes_stopping_after_current_heartbeat() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    env.handle.block_heartbeats();
    let run_handle = tokio::spawn(run(config));
    wait_for_blocked_routine_heartbeat(&env).await;

    let mut mode_rx = env.mode_tx.subscribe();
    env.drain();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if *mode_rx.borrow_and_update() == RunnerMode::Stopping {
                break;
            }
            mode_rx.changed().await.unwrap();
        }
    })
    .await
    .expect("natural drain should commit Stopping while heartbeat is blocked");

    assert!(!run_handle.is_finished());
    assert_eq!(env.handle.heartbeat_count(), 1);
    assert_eq!(env.handle.heartbeat_in_flight(), 1);

    env.handle.unblock_heartbeats();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "natural shutdown should finish after the current heartbeat is released",
    )
    .await;

    {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let modes: Vec<&str> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.mode.as_str())
            .collect();
        let sequences: Vec<u64> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.snapshot_sequence)
            .collect();
        assert_eq!(modes, ["running", "stopping", "stopping"]);
        assert_eq!(sequences, [1, 2, 3]);
        assert!(
            heartbeats
                .iter()
                .all(|heartbeat| heartbeat.snapshot_generation == 7)
        );
    }
    assert_eq!(env.handle.heartbeat_in_flight(), 0);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked in Draining mode. Silently dropping its `heartbeat_tick` branch
/// would leave a draining runner looking dead to the server until it exits.
///
/// Enter Draining before injecting a routine heartbeat so the observed tick
/// had to be handled by the Draining-mode heartbeat branch.
#[tokio::test]
async fn heartbeat_fires_while_draining() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let (heartbeat_trigger, heartbeat_trigger_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_trigger_rx);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a job and wait until it is blocked in `wait_process` so Draining
    // has an active job to wait on. Otherwise `jobs.is_empty()` auto-transitions
    // straight to Stopping before the Draining wait path is exercised.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("active job should enter wait_process before Draining heartbeat check");

    // Enter Draining before triggering the routine heartbeat. `status.json`
    // is updated only after the main loop observes the mode transition.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    let before = env.handle.heartbeat_count();

    // Trigger a routine heartbeat while Draining mode is active. A broken
    // Draining path that dropped its `heartbeat_tick.tick()` branch would
    // never acknowledge the trigger or advance the provider heartbeat count.
    trigger_routine_heartbeat(&heartbeat_trigger, &env, RunnerMode::Draining).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "Draining mode must handle heartbeat_tick (baseline={before})",
    );

    // Tear down hard — the gate would block natural completion.
    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit within 5s after Draining heartbeat check",
    )
    .await;
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked with budget exhausted. Dropping its `heartbeat_tick` branch would
/// make a runner that's at resource capacity look dead to the server until
/// budget frees.
///
/// A 1-slot budget + a gated job pins the runner in the budget-exhausted
/// state for the duration of the time advance.
#[tokio::test(start_paused = true)]
async fn heartbeat_fires_while_budget_exhausted() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    // Budget sized for exactly one `test_profiles()` slot (vcpu=2, mem=4096).
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    // Wait for the reservation — after this, the next loop iteration
    // enters the budget-exhausted wait state at the can_afford check.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    wait_budget_exhausted_reactor(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    // Advance past the first tick while the runner is budget-exhausted.
    // Removing the `heartbeat_tick.tick()` branch from the reactor `select!`
    // leaves the count unchanged; `wait_heartbeat_past` returns false
    // on timeout.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "budget-exhausted arm must handle heartbeat_tick (baseline={before})",
    );

    // Release the gate so the job completes, budget frees, and the
    // standard `shutdown()` helper (Draining → auto-Stop) terminates
    // the runner cleanly — same pattern as `budget_full_skips_then_resumes`.
    gate.notify_one();
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    shutdown(&env, run_handle).await;
}

/// Regression guard: heartbeat branches must read the live watch value at send
/// time. If a mode transition lands while the reactor is already parked in a
/// different select arm, using the loop-start `current_mode` sends one stale
/// heartbeat before the mode-change arm runs.
#[tokio::test(start_paused = true)]
async fn heartbeat_tick_uses_live_mode_after_silent_mode_flip() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    wait_budget_exhausted_reactor(&env, Duration::from_secs(5)).await;

    let before = env.handle.heartbeat_count();
    env.mode_tx.send_if_modified(|mode| {
        *mode = RunnerMode::Draining;
        false
    });

    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "heartbeat tick should fire after silent mode flip"
    );

    {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(
            heartbeats[before].mode, "draining",
            "heartbeat tick must use live mode, not stale loop-start mode"
        );
    }

    env.trigger_stopping().await;
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "hard shutdown should exit after live-mode heartbeat regression check",
    )
    .await;
}

/// Regression for #10146 / #10223: the main-loop `heartbeat_tick` interval
/// must defer its first tick past the configured period, so the tick branch
/// is not Ready on the first `select!` poll. Otherwise it pre-empts
/// `discover_fut` (which parks on
/// `rx.recv()` → Pending) and any silent `mode_tx` flip during the
/// tick body breaks the loop before the pending job is ever claimed.
///
/// The behavioral test `claim_after_stopping_sent_cancels_new_job`
/// only triggers the underlying race under `cargo llvm-cov`, so a
/// silent revert of `interval_at` → `interval` would not fail it on
/// the default CI path. This test pins the invariant directly: a
/// job pushed immediately at startup is processed without any tick
/// having fired, observable via `heartbeat_count == 0`.
#[tokio::test(start_paused = true)]
async fn heartbeat_tick_defers_past_first_select_poll() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // `minimal_context` → no reuse key → completion path does not trigger
    // `reuse_state_notify`, so any heartbeat observed here came from the
    // interval tick (the path we want to prove did NOT fire).
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job must complete");

    assert_eq!(
        env.handle.heartbeat_count(),
        0,
        "heartbeat tick fired before the startup job was processed — \
             is the main-loop interval `interval_at(now + period, period)` \
             instead of `interval(period)`?"
    );

    shutdown(&env, run_handle).await;
}
