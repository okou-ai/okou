//! End-to-end: when the execution deadline lands after post-result SIGTERM but
//! before SIGKILL escalation, it must preserve the accepted terminal result
//! instead of reclassifying the run as an execution timeout.

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn execution_deadline_preserves_post_result_sigkill_pending()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // The mock emits its result immediately and ignores SIGTERM. The
        // post-result reaper sends SIGTERM after 1s, the execution deadline
        // lands at 5s, and the 8s SIGKILL grace then completes the reaper.
        common::setup_env(&mock, tmp.path(), "@hang-after-result-deaf", 1, 8)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "5",
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution_timeout = runtime
        .config
        .agent_execution_timeout
        .expect("test config should set an execution timeout");
    let execution_deadline_after_sigterm = execution_timeout
        .checked_sub(runtime.config.post_result_sigterm_grace)
        .expect("execution deadline should follow post-result SIGTERM");
    let sigkill_deadline_after_execution = runtime
        .config
        .post_result_sigkill_grace
        .checked_sub(execution_deadline_after_sigterm)
        .expect("SIGKILL deadline should follow the execution deadline");
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_TERMINATION_READY_EVENT,
            runtime.config.post_result_sigterm_grace,
        ),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.system_log_file(),
            "Post-result cleanup quiet_timeout reached",
            execution_deadline_after_sigterm,
        ),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.system_log_file(),
            "Agent execution deadline reached during post-result SIGKILL grace",
            sigkill_deadline_after_execution,
        ),
    ];

    // Each checkpoint proves the preceding state transition before virtual
    // time reaches the next deadline. Keep the outer timeout as a real
    // subprocess/reaping regression bound.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
            &checkpoints,
        ),
    )
    .await
    .expect("post-result reaper did not finish within its bounded grace")??;

    assert_eq!(result.exit_code, common::SIGKILL_EXIT);
    assert!(
        result.control_error.is_none(),
        "an accepted terminal result must not become an execution timeout"
    );
    let termination = result
        .cli_termination
        .expect("post-result reaper should attach termination diagnostics");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));

    Ok(())
}
