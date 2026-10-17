//! Stale-turn output timing coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_stale_turn_output_timing()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-output-timing-stale-scope-test",
                prompt: "drive the app-server output timing stale-turn path",
                scenario: Some("unexpected-turn-output-item-started"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
            "1700000000000",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly");

    let error = result.expect_err("stale-turn output item should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("unexpected turn id"),
        "unexpected error: {message}"
    );

    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap_or_default();
    assert!(!sandbox_ops.contains("api_to_codex_output_item_started"));
    assert!(!sandbox_ops.contains("api_to_codex_agent_message_item_started"));

    Ok(())
}
