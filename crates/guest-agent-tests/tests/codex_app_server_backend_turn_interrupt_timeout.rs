//! An unresponsive active-turn interruption must retain the execution timeout bound.

use guest_agent_tests as common;

use std::time::Duration;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason};

#[test]
fn execution_timeout_terminates_an_unresponsive_turn_interrupt()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-turn-interrupt-timeout-test",
                prompt: "hang while interrupting this active turn",
                scenario: Some("hang-on-turn-interrupt"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "1",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let active_turn_ready = tmp.path().join(common::MOCK_CODEX_ACTIVE_TURN_READY_FILE);
    let active_turn_ready = active_turn_ready
        .to_str()
        .ok_or_else(|| std::io::Error::other("active-turn readiness path is not UTF-8"))?;
    let interrupt_ready = tmp
        .path()
        .join(common::MOCK_CODEX_TURN_INTERRUPT_READY_FILE);
    let interrupt_ready = interrupt_ready
        .to_str()
        .ok_or_else(|| std::io::Error::other("interrupt readiness path is not UTF-8"))?;
    let execution_timeout = runtime
        .config
        .agent_execution_timeout
        .ok_or_else(|| std::io::Error::other("test config should set an execution timeout"))?;
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            active_turn_ready,
            common::MOCK_CODEX_ACTIVE_TURN_READY_EVENT,
            execution_timeout,
        ),
        common::VirtualTimeCheckpoint::new(
            interrupt_ready,
            common::MOCK_CODEX_TURN_INTERRUPT_READY_EVENT,
            Duration::from_secs(10),
        ),
    ];
    let test_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = test_runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(15),
            common::execute_with_virtual_time_checkpoints(
                common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
                &checkpoints,
            ),
        )
        .await
        .map_err(|_| "unresponsive turn interruption did not terminate".to_string())?
    })??;

    assert_eq!(result.exit_code, AGENT_EXECUTION_TIMEOUT_EXIT_CODE);
    let error = result
        .control_error
        .as_ref()
        .ok_or_else(|| std::io::Error::other("execution timeout omitted its controlled error"))?;
    assert!(
        error
            .to_string()
            .contains("Agent execution timed out after 1 seconds"),
        "unexpected timeout error: {error}"
    );
    assert_eq!(
        result
            .cli_termination
            .ok_or_else(|| {
                std::io::Error::other("execution timeout omitted its termination diagnostic")
            })?
            .reason,
        CliTerminationReason::ExecutionTimeout
    );

    Ok(())
}
