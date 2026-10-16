//! End-to-end: stdout EOF before process exit must not bypass stuck-tool
//! forced termination.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn stuck_tool_reap_survives_stdout_eof_before_child_exit()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stuck-tool-closed-stdout-deaf", 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "1",
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_TERMINATION_READY_EVENT,
            Duration::from_secs(5),
        ),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.system_log_file(),
            "Tool timeout: WebFetch stuck for",
            runtime.config.post_result_sigkill_grace,
        ),
    ];

    // The mock fence proves WebFetch is tracked before stdout closes and the
    // watchdog jumps. The timeout log proves SIGTERM armed the SIGKILL
    // deadline. Keep the outer timeout as a real subprocess/reaping bound.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
            &checkpoints,
        ),
    )
    .await
    .expect("execute_cli did not return within 15s - stdout EOF forced reap likely broken")?;

    assert!(
        tmp.path().join(".claude-mock-sigterm-ignored").exists(),
        "mock did not install SIGTERM ignore marker"
    );

    let result = result.expect("execute_cli returned Err before collecting controlled termination");
    let err = result
        .control_error
        .as_ref()
        .expect("stuck tool timeout should preserve a controlled execution error");
    assert!(
        err.to_string().contains("Tool timeout: WebFetch"),
        "expected stuck tool timeout error, got {err}"
    );
    let termination = result
        .cli_termination
        .expect("stuck tool timeout should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::StuckToolWatchdog);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));
    Ok(())
}
