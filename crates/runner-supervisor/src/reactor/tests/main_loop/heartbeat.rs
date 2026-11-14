use super::super::super::*;
use super::super::support::{
    MockRunEnv, TEST_RUNNER_ID, assert_run_exits_within, minimal_context, mock_run_config,
    mock_run_config_with_delay, mock_run_config_with_overrides, push_job, shutdown, test_profiles,
    wait_budget_count, wait_budget_exhausted_reactor, wait_cancel_token, wait_cancel_token_removed,
    wait_discover_entered, wait_heartbeat_matching_after,
    wait_status_idle_reuse_keys_and_active_runs, wait_status_mode,
};
use crate::status::StatusPersistenceError;
use raw_http_test_support::clock::advance_timer_phase;
use runner_types::types::HeartbeatState;
use sandbox::SandboxId;
use std::sync::Arc;

async fn wait_for_blocked_routine_heartbeat(env: &MockRunEnv) {
    wait_discover_entered(env, Duration::from_secs(2)).await;
    env.handle.block_heartbeats();
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(5))
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

fn assert_final_basic_heartbeat(state: &HeartbeatState) {
    assert_eq!(state.runner_id, TEST_RUNNER_ID);
    assert_eq!(state.group, "test-group");
    // The 8-CPU host retains the existing host reservation before rounding.
    assert_eq!(state.total_vcpu, 7);
    assert_eq!(state.total_memory_mb, 32768);
    assert_eq!(state.max_concurrent, 4);
    assert_eq!(state.allocated_vcpu, 0);
    assert_eq!(state.allocated_memory_mb, 0);
    assert_eq!(state.running_count, 0);
    assert!(state.admittable_profiles.is_empty());
    assert!(state.held_sandbox_states.is_empty());
    assert!(state.held_home_states.is_empty());
    assert!(state.active_reuse_producers.is_empty());
}

#[tokio::test]
async fn status_retry_does_not_wait_for_routine_heartbeat() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 1);
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

    advance_timer_phase(maintenance::STATUS_RETRY_PERIOD).await;
    wait_status_idle_reuse_keys_and_active_runs(&status_path, &[], &[], Duration::from_secs(5))
        .await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 2: Discover survives heartbeat ticks (regression #8783)
//
// Provider-owned discovery must survive routine ticks even when its delay
// exceeds the reporting period. Otherwise each select tick resets the delay.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn discover_survives_heartbeat_ticks() {
    let (config, env) =
        mock_run_config_with_delay(test_profiles(), 8, 32768, 4, HEARTBEAT_PERIOD * 2);
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

    // Advance to the first heartbeat while the discovery delay is still
    // pending, then let the runner task observe the ready timer.
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    tokio::task::yield_now().await;
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(1))
            .await,
        "heartbeat should fire while discover poll delay is running"
    );

    // Pass the original delay, but not a delay restarted by the first tick.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;

    // A restarted discovery still cannot complete at this point.
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
async fn routine_delivery_failure_after_startup_keeps_job_acceptance_available() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    env.handle.fail_next_heartbeat();
    trigger_routine_heartbeat(&trigger, &env, RunnerMode::Running).await;
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(5))
            .await
    );
    assert!(
        env.handle
            .wait_heartbeat_in_flight(0, Duration::from_secs(5))
            .await
    );

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    assert!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "a later heartbeat failure must not turn healthy startup into an acceptance failure"
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn failed_report_retries_without_waiting_for_a_routine_tick() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 1);
    let (trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let cursor = env.start_observer.cursor();
    env.handle.fail_next_heartbeat();
    trigger_routine_heartbeat(&trigger, &env, RunnerMode::Running).await;
    env.start_observer
        .wait_after(
            cursor,
            Duration::from_secs(5),
            "heartbeat retry acceptance",
            &mut |event| matches!(event, StartLoopEvent::HeartbeatRetryScheduled).then_some(()),
        )
        .await;

    advance_timer_phase(crate::heartbeat::HEARTBEAT_RETRY_DELAY).await;
    assert!(
        env.handle
            .wait_heartbeat_past(2, Duration::from_secs(5))
            .await
    );
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
    {
        let states = env.handle.heartbeats.lock().unwrap();
        assert_eq!(states[2].snapshot_sequence, 3);
        assert_eq!(states[2].mode, "running");
    }
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn capacity_and_producer_changes_report_without_routine_ticks() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 1);
    let (_trigger, receiver) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(receiver);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(5))
            .await
    );
    {
        let states = env.handle.heartbeats.lock().unwrap();
        let state = states.last().unwrap();
        assert_eq!(
            (
                state.allocated_vcpu,
                state.allocated_memory_mb,
                state.running_count
            ),
            (2, 4096, 1)
        );
        assert!(state.admittable_profiles.is_empty());
    }

    let run_id = RunId::new_v4();
    let guard =
        env.active_runs
            .register(run_id, Some("thread:report".into()), "vm0/default".into());
    assert!(
        env.handle
            .wait_heartbeat_past(2, Duration::from_secs(5))
            .await
    );
    {
        let states = env.handle.heartbeats.lock().unwrap();
        assert_eq!(
            states.last().unwrap().active_reuse_producers[0].run_id,
            run_id
        );
    }
    assert!(guard.reuse_publisher().publish_no_exact_sandbox());
    assert!(
        env.handle
            .wait_heartbeat_past(3, Duration::from_secs(5))
            .await
    );
    assert!(
        env.handle
            .heartbeats
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .active_reuse_producers
            .is_empty()
    );

    drop(guard);
    drop(lease);
    assert!(
        env.handle
            .wait_heartbeat_past(4, Duration::from_secs(5))
            .await
    );
    {
        let states = env.handle.heartbeats.lock().unwrap();
        let state = states.last().unwrap();
        assert_eq!(
            (
                state.allocated_vcpu,
                state.allocated_memory_mb,
                state.running_count
            ),
            (0, 0, 0)
        );
        assert_eq!(state.admittable_profiles, ["vm0/default"]);
    }
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn heartbeat_triggers_coalesce_into_one_current_mode_follow_up() {
    assert_coalesced_heartbeat_follow_up(false).await;
}

#[tokio::test]
async fn heartbeat_follow_up_uses_live_mode_after_silent_mode_flip() {
    assert_coalesced_heartbeat_follow_up(true).await;
}

async fn assert_coalesced_heartbeat_follow_up(resume_before_delivery: bool) {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let (heartbeat_trigger, heartbeat_trigger_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_trigger_rx);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.handle.block_heartbeats();
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
            .wait_heartbeat_past(1, Duration::from_secs(5))
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
    assert_eq!(env.handle.heartbeat_count(), 2);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);

    if resume_before_delivery {
        // The follow-up must sample mode when the active send completes,
        // not retain the mode of the trigger that marked it dirty. Observing
        // this later transition also requests its own lifecycle report, so
        // this case checks the first follow-up, not the final report count.
        env.mode_tx.send_if_modified(|mode| {
            *mode = RunnerMode::Running;
            false
        });
    }

    env.handle.unblock_heartbeats();
    assert!(
        env.handle
            .wait_heartbeat_past(2, Duration::from_secs(5))
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
        let heartbeats = &heartbeats[1..]; // Required startup delivery precedes routine sends.
        if !resume_before_delivery {
            assert_eq!(heartbeats.len(), 2, "reported snapshots: {heartbeats:#?}");
        }
        assert_eq!(heartbeats[0].mode, "running");
        assert_eq!(
            heartbeats[1].mode,
            if resume_before_delivery {
                "running"
            } else {
                "draining"
            }
        );
        assert_eq!(heartbeats[1].running_count, 1);
        assert_eq!(heartbeats[0].snapshot_generation, 7);
        assert_eq!(heartbeats[1].snapshot_generation, 7);
        assert_eq!(heartbeats[0].snapshot_sequence, 2);
        assert_eq!(heartbeats[1].snapshot_sequence, 3);
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
    assert_eq!(env.handle.heartbeat_count(), 2);
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
        let heartbeats = &heartbeats[1..];
        let modes: Vec<&str> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.mode.as_str())
            .collect();
        let sequences: Vec<u64> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.snapshot_sequence)
            .collect();
        assert_eq!(modes, ["running", "stopping"]);
        assert_eq!(sequences, [2, 3]);
        assert!(
            heartbeats
                .iter()
                .all(|heartbeat| heartbeat.snapshot_generation == 7)
        );
        assert_final_basic_heartbeat(heartbeats.last().unwrap());
    }
    assert_eq!(env.handle.heartbeat_in_flight(), 0);
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
}

#[tokio::test(start_paused = true)]
async fn natural_shutdown_flushes_stopping_after_current_heartbeat() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
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
    assert_eq!(env.handle.heartbeat_count(), 2);
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
        let heartbeats = &heartbeats[1..];
        let modes: Vec<&str> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.mode.as_str())
            .collect();
        let sequences: Vec<u64> = heartbeats
            .iter()
            .map(|heartbeat| heartbeat.snapshot_sequence)
            .collect();
        assert_eq!(modes, ["running", "stopping", "stopping"]);
        assert_eq!(sequences, [2, 3, 4]);
        assert!(
            heartbeats
                .iter()
                .all(|heartbeat| heartbeat.snapshot_generation == 7)
        );
        assert_final_basic_heartbeat(heartbeats.last().unwrap());
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

    // Enter Draining without a routine tick. `status.json`
    // is updated only after the main loop observes the mode transition.
    let changed_before = env.handle.heartbeat_count();
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            changed_before,
            Duration::from_secs(5),
            |state| { state.mode == "draining" }
        )
        .await
    );
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

// Stable reporting also retains the deferred first tick (#10146 / #10223).
#[tokio::test(start_paused = true)]
async fn stable_state_reports_once_per_minute_after_startup() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 1);
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;
    let started = tokio::time::Instant::now();
    assert!(
        env.handle
            .wait_heartbeat_past(1, Duration::from_secs(65))
            .await
    );
    assert!(started.elapsed() >= Duration::from_secs(60));
    assert_eq!(
        env.handle.heartbeat_count(),
        2,
        "only startup and one routine report are due"
    );
    let states = env.handle.heartbeats.lock().unwrap().clone();
    assert_eq!(states[0].snapshot_sequence, 1);
    assert_eq!(states[1].snapshot_sequence, 2);
    assert_eq!(states[1].running_count, 0);
    shutdown(&env, run_handle).await;
}
