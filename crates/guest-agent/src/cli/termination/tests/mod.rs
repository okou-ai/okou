use super::*;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};

fn test_policy() -> PostResultCleanupPolicy {
    PostResultCleanupPolicy::new(
        Duration::from_secs(3),
        Duration::from_secs(60),
        Duration::from_secs(1),
    )
}

#[test]
fn termination_state_is_pending_only_between_arming_and_done() {
    assert!(!TerminationState::Idle.is_pending());
    assert!(
        TerminationState::SigtermPending {
            reason: TerminationReason::PostResult,
        }
        .is_pending()
    );
    assert!(
        TerminationState::SigkillPending {
            reason: TerminationReason::StuckTool,
        }
        .is_pending()
    );
    assert!(!TerminationState::Done.is_pending());
}

/// The arming guard must fire exactly once per run, on the first
/// `type=result` event, and only when the CLI is still alive. Any
/// later state -- or a CLI that already exited -- must be ignored
/// (Done is sticky; SigtermPending/SigkillPending already armed).
///
/// Calls `TerminationState::should_arm_post_result` directly so
/// the test shares a single source of truth with the production
/// `select!` branch.
#[test]
fn termination_state_should_arm_post_result_matches_invariant() {
    // Fire only from Idle with CLI still alive.
    assert!(TerminationState::Idle.should_arm_post_result(false));

    // CLI already exited -> no arm, even from Idle.
    assert!(!TerminationState::Idle.should_arm_post_result(true));

    // Already armed -> no re-arm.
    assert!(
        !TerminationState::SigtermPending {
            reason: TerminationReason::PostResult,
        }
        .should_arm_post_result(false)
    );
    assert!(
        !TerminationState::SigkillPending {
            reason: TerminationReason::HeartbeatError,
        }
        .should_arm_post_result(false)
    );

    // Done is sticky.
    assert!(!TerminationState::Done.should_arm_post_result(false));
}

#[test]
fn cli_termination_signal_records_initial_prompt_stdin_and_escalation() {
    let mut diagnostic = None;

    record_cli_termination_signal(
        &mut diagnostic,
        TerminationReason::InitialPromptStdin,
        CliTerminationSignal::Sigterm,
        Some(42),
        Duration::from_secs(1),
    );

    let first = diagnostic.expect("diagnostic after SIGTERM");
    assert_eq!(first.reason, CliTerminationReason::InitialPromptStdin);
    assert_eq!(first.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert_eq!(first.signal_pgid, Some(42));
    assert_eq!(first.signal_grace_ms, Some(1_000));
    assert!(!first.escalated);

    let mut diagnostic = Some(first);
    record_cli_termination_signal(
        &mut diagnostic,
        TerminationReason::InitialPromptStdin,
        CliTerminationSignal::Sigkill,
        Some(42),
        Duration::from_secs(2),
    );

    let escalated = diagnostic.expect("diagnostic after SIGKILL");
    assert_eq!(escalated.reason, CliTerminationReason::InitialPromptStdin);
    assert_eq!(escalated.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert_eq!(escalated.signal_pgid, Some(42));
    assert_eq!(escalated.signal_grace_ms, Some(2_000));
    assert!(escalated.escalated);
}

#[tokio::test]
async fn control_failure_overrides_post_result_cleanup() {
    let deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(deadline);
    let mut runtime = CliTerminationRuntime::new(None, test_policy());

    assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
    assert!(runtime.has_post_result_cleanup());

    assert!(runtime.begin_control_failure(
        TerminationReason::HeartbeatError,
        AgentError::Execution("heartbeat failed".to_string()),
        ControlTerminationLog::HeartbeatFailed,
        deadline.as_mut(),
    ));

    let control_error = runtime
        .control_error
        .as_ref()
        .expect("control error should be stored");
    assert!(control_error.to_string().contains("heartbeat failed"));
    assert!(!runtime.has_post_result_cleanup());
    assert_eq!(
        runtime.state,
        TerminationState::SigkillPending {
            reason: TerminationReason::HeartbeatError
        }
    );
    let diagnostic = runtime.diagnostic.expect("diagnostic should be recorded");
    assert_eq!(diagnostic.reason, CliTerminationReason::HeartbeatError);
    assert_eq!(diagnostic.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert_eq!(diagnostic.signal_pgid, None);
    assert!(diagnostic.signal_grace_ms.is_some());
    assert!(!diagnostic.escalated);
}

#[tokio::test]
async fn second_control_failure_does_not_overwrite_first() {
    let deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(deadline);
    let mut runtime = CliTerminationRuntime::new(None, test_policy());

    assert!(runtime.begin_control_failure(
        TerminationReason::HeartbeatError,
        AgentError::Execution("first heartbeat failure".to_string()),
        ControlTerminationLog::HeartbeatFailed,
        deadline.as_mut(),
    ));
    assert!(!runtime.begin_control_failure(
        TerminationReason::StuckTool,
        AgentError::Execution("second tool failure".to_string()),
        ControlTerminationLog::StuckTool {
            name: "WebFetch".to_string(),
            elapsed: 30,
        },
        deadline.as_mut(),
    ));

    let control_error = runtime
        .control_error
        .as_ref()
        .expect("first control error should remain");
    assert!(
        control_error
            .to_string()
            .contains("first heartbeat failure")
    );
    assert_eq!(
        runtime.state,
        TerminationState::SigkillPending {
            reason: TerminationReason::HeartbeatError
        }
    );
    assert_eq!(
        runtime.diagnostic.expect("diagnostic").reason,
        CliTerminationReason::HeartbeatError
    );
}

#[tokio::test]
async fn stdin_control_failure_is_only_eligible_while_idle() {
    let deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(deadline);
    let mut runtime = CliTerminationRuntime::new(None, test_policy());

    assert!(runtime.can_begin_initial_prompt_stdin_control_failure(false));
    assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(true));

    assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
    assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(false));

    runtime.mark_child_exited();
    assert!(!runtime.can_begin_initial_prompt_stdin_control_failure(false));
}

#[tokio::test]
async fn child_exit_parks_termination_and_prevents_late_post_result_arm() {
    let deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(deadline);
    let mut runtime = CliTerminationRuntime::new(None, test_policy());

    assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
    runtime.mark_child_exited();

    assert!(!runtime.has_pending_deadline());
    assert!(!runtime.has_post_result_cleanup());
    assert!(!runtime.arm_post_result_cleanup(false, deadline.as_mut()));
    assert!(!runtime.begin_control_failure(
        TerminationReason::HeartbeatError,
        AgentError::Execution("late heartbeat failure".to_string()),
        ControlTerminationLog::HeartbeatFailed,
        deadline.as_mut(),
    ));
    assert!(runtime.control_error.is_none());
    assert!(runtime.diagnostic.is_none());
    assert_eq!(runtime.state, TerminationState::Done);
}

#[tokio::test]
async fn post_result_activity_refreshes_only_for_previously_armed_cleanup() {
    let deadline = tokio::time::sleep(Duration::MAX);
    tokio::pin!(deadline);
    let mut runtime = CliTerminationRuntime::new(None, test_policy());

    runtime.record_post_result_activity(false, deadline.as_mut());
    assert!(runtime.post_result_cleanup.is_none());

    assert!(runtime.arm_post_result_cleanup(false, deadline.as_mut()));
    runtime.record_post_result_activity(false, deadline.as_mut());
    assert_eq!(
        runtime
            .post_result_cleanup
            .expect("cleanup")
            .meaningful_event_count(),
        0
    );

    runtime.record_post_result_activity(true, deadline.as_mut());
    assert_eq!(
        runtime
            .post_result_cleanup
            .expect("cleanup")
            .meaningful_event_count(),
        1
    );
}

#[test]
fn post_result_cleanup_arm_uses_earliest_deadline() {
    let now = Instant::now();
    let cleanup = PostResultCleanupState::arm(now, Duration::from_secs(10), Duration::from_secs(3));

    assert_eq!(cleanup.next_deadline(), Some(now + Duration::from_secs(3)));
}

#[test]
fn post_result_cleanup_arm_uses_immediate_deadline_on_overflow() {
    let now = Instant::now();
    let cleanup = PostResultCleanupState::arm(now, Duration::MAX, Duration::MAX);

    assert_eq!(cleanup.next_deadline(), Some(now));
}

#[test]
fn post_result_cleanup_meaningful_event_refreshes_quiet_deadline_only() {
    let now = Instant::now();
    let mut cleanup =
        PostResultCleanupState::arm(now, Duration::from_secs(2), Duration::from_secs(10));
    let event_at = now + Duration::from_secs(1);

    assert_eq!(
        cleanup.record_meaningful_event(event_at, Duration::from_secs(2)),
        Some(now + Duration::from_secs(3))
    );
    assert_eq!(cleanup.meaningful_event_count, 1);
    assert_eq!(
        cleanup.timeout_due(now + Duration::from_secs(2)),
        None,
        "old quiet deadline must not fire after a meaningful event"
    );
    assert_eq!(
        cleanup.timeout_due(now + Duration::from_secs(3)),
        Some(PostResultCleanupTimeout {
            trigger: PostResultCleanupTrigger::Quiet,
            elapsed: Duration::from_secs(3),
            quiet_for: Duration::from_secs(2),
            meaningful_event_count: 1,
        })
    );
}

#[test]
fn post_result_cleanup_meaningful_event_uses_immediate_deadline_on_overflow() {
    let now = Instant::now();
    let mut cleanup =
        PostResultCleanupState::arm(now, Duration::from_secs(10), Duration::from_secs(20));
    let event_at = now + Duration::from_secs(1);

    assert_eq!(
        cleanup.record_meaningful_event(event_at, Duration::MAX),
        Some(event_at)
    );
}

#[test]
fn post_result_cleanup_total_cap_is_not_refreshed_by_events() {
    let now = Instant::now();
    let mut cleanup =
        PostResultCleanupState::arm(now, Duration::from_secs(2), Duration::from_secs(3));
    let event_at = now + Duration::from_secs(2);

    assert_eq!(
        cleanup.record_meaningful_event(event_at, Duration::from_secs(2)),
        Some(now + Duration::from_secs(3))
    );
    assert_eq!(
        cleanup.timeout_due(now + Duration::from_secs(3)),
        Some(PostResultCleanupTimeout {
            trigger: PostResultCleanupTrigger::TotalCap,
            elapsed: Duration::from_secs(3),
            quiet_for: Duration::from_secs(1),
            meaningful_event_count: 1,
        })
    );
}

#[test]
fn post_result_cleanup_does_not_refresh_after_signal() {
    let now = Instant::now();
    let mut cleanup =
        PostResultCleanupState::arm(now, Duration::from_secs(1), Duration::from_secs(5));

    assert_eq!(
        cleanup.mark_signal_sent(now + Duration::from_secs(1)),
        Some(PostResultCleanupTimeout {
            trigger: PostResultCleanupTrigger::Quiet,
            elapsed: Duration::from_secs(1),
            quiet_for: Duration::from_secs(1),
            meaningful_event_count: 0,
        })
    );
    assert_eq!(
        cleanup.record_meaningful_event(now + Duration::from_secs(2), Duration::from_secs(1)),
        None
    );
    assert_eq!(cleanup.next_deadline(), None);
}

#[test]
fn child_exit_or_stronger_termination_parks_cleanup_driver_state() {
    let mut state = TerminationState::SigtermPending {
        reason: TerminationReason::PostResult,
    };
    assert!(state.is_pending());
    state = TerminationState::Done;
    assert!(!state.is_pending());

    let mut state = TerminationState::SigtermPending {
        reason: TerminationReason::PostResult,
    };
    assert!(state.is_pending());
    state = TerminationState::SigkillPending {
        reason: TerminationReason::HeartbeatError,
    };
    assert_eq!(
        state,
        TerminationState::SigkillPending {
            reason: TerminationReason::HeartbeatError
        }
    );
}
