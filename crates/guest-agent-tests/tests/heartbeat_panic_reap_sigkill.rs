//! End-to-end: heartbeat task panic must still reap a SIGTERM-deaf CLI
//! with SIGKILL before returning the panic error.
//!
//! See: https://github.com/vm0-ai/vm0/issues/11667

use guest_agent_tests as common;

use guest_agent::error::AgentError;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn heartbeat_panic_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stuck-tool-deaf", 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let sigterm_ignored_marker = tmp.path().join(".claude-mock-sigterm-ignored");
    let heartbeat = common::spawn_heartbeat_monitor(async move {
        common::wait_for_path(&sigterm_ignored_marker, Duration::from_secs(5))
            .await
            .map_err(|_| AgentError::Execution("mock did not ignore SIGTERM".to_string()))?;
        panic!("heartbeat panic for reap test")
    });

    let checkpoints = [common::VirtualTimeCheckpoint::new(
        runtime.paths.system_log_file(),
        "Heartbeat task panicked, SIGTERM",
        runtime.config.post_result_sigkill_grace,
    )];

    // The transition log and SIGKILL deadline are committed in one poll.
    // Keep the outer timeout as a real subprocess/reaping regression bound.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
            &checkpoints,
        ),
    )
    .await
    .expect("execute_cli did not return within 15s - heartbeat panic reap likely broken")?;

    let result = result.expect("execute_cli returned Err before collecting controlled termination");
    let err = result
        .control_error
        .as_ref()
        .expect("heartbeat panic should preserve a controlled execution error");
    assert!(
        err.to_string().contains("heartbeat task panicked"),
        "expected heartbeat panic error, got {err}"
    );
    let termination = result
        .cli_termination
        .expect("heartbeat panic should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::HeartbeatPanic);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));
    Ok(())
}
