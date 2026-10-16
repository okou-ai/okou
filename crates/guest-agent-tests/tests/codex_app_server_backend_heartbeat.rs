//! Heartbeat race coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use std::path::PathBuf;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_heartbeat_interrupts_hung_turn_start()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-heartbeat-test",
                prompt: "drive the app-server backend heartbeat path",
                scenario: Some("hang-on-turn-start"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let session_id_path = PathBuf::from(runtime.paths.session_id_file());
    if let Some(parent) = session_id_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let heartbeat = common::spawn_heartbeat_monitor(async move {
        common::wait_for_path(&session_id_path, Duration::from_secs(5))
            .await
            .map_err(|error| {
                AgentError::Execution(format!("wait for app-server thread start: {error}"))
            })?;
        Err(AgentError::Execution(
            "heartbeat failed during app-server turn/start".to_string(),
        ))
    });

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_millis(1500),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli should return promptly");

    let result = result.expect("heartbeat failure should return a controlled result");
    assert_eq!(result.exit_code, 1);
    let error = result
        .control_error
        .as_ref()
        .expect("heartbeat failure should retain the control error");
    let message = error.to_string();
    assert!(
        message.contains("heartbeat failed during app-server turn/start"),
        "unexpected error: {message}"
    );
    assert_eq!(
        result
            .cli_termination
            .expect("heartbeat failure should attach termination details")
            .reason,
        CliTerminationReason::HeartbeatError
    );
    assert_eq!(
        result
            .heartbeat
            .expect("heartbeat failure should retain HTTP evidence"),
        common::test_heartbeat_failure_diagnostic()
    );

    Ok(())
}
