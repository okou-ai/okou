//! A runner-owned execution deadline must reap the Claude Code process group
//! through the existing bounded termination state machine.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn execution_timeout_reaps_a_sigterm_deaf_cli() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stuck-tool-deaf", 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "1",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let masker = SecretMasker::from_raw("");
    let execution_timeout = runtime
        .config
        .agent_execution_timeout
        .expect("test config should set an execution timeout");
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_TERMINATION_READY_EVENT,
            execution_timeout,
        ),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.system_log_file(),
            "Agent execution timed out after",
            runtime.config.post_result_sigkill_grace,
        ),
    ];

    // The mock fence proves SIGTERM immunity before the execution-deadline
    // jump. The transition log proves SIGTERM armed the SIGKILL deadline.
    // Keep the outer timeout as a real subprocess/reaping regression bound.
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
            &checkpoints,
        ),
    )
    .await
    .expect("execution deadline did not reap the CLI process group")??;

    let error = result
        .control_error
        .as_ref()
        .expect("execution timeout should preserve a controlled error");
    assert!(
        error
            .to_string()
            .contains("Agent execution timed out after 1 seconds"),
        "unexpected timeout error: {error}"
    );
    let termination = result
        .cli_termination
        .expect("execution timeout should attach termination diagnostics");
    assert_eq!(termination.reason, CliTerminationReason::ExecutionTimeout);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));

    Ok(())
}
