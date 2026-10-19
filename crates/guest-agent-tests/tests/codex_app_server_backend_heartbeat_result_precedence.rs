//! Codex terminal-result precedence when heartbeat becomes ready afterward.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_terminal_result_written_before_heartbeat_remains_authoritative()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-heartbeat-result-precedence-test",
                prompt: "complete before heartbeat becomes ready",
                scenario: Some("runtime-turn-complete-before-heartbeat"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let ready_path = tmp
        .path()
        .join(common::MOCK_CODEX_TURN_COMPLETE_BEFORE_HEARTBEAT_READY_FILE);
    let heartbeat = common::spawn_heartbeat_monitor(async move {
        common::wait_for_path(&ready_path, Duration::from_secs(5))
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "wait for terminal-result heartbeat boundary: {error}"
                ))
            })?;
        Err(AgentError::Execution(
            "heartbeat failed after terminal result was written".to_string(),
        ))
    });

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.cli_termination.is_none());
    assert!(result.heartbeat.is_none());

    Ok(())
}
