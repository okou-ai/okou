//! Scope validation coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_unexpected_thread_event_scope()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-scope-test",
                prompt: "drive the app-server backend scope failure path",
                scenario: Some("unexpected-thread-output-item-started"),
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

    let error = result.expect_err("unexpected thread event should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("unexpected thread id"),
        "unexpected error: {message}"
    );

    let events = read_agent_log_events(&runtime.paths)?;
    assert!(
        events.iter().all(|event| {
            event.get("thread_id").and_then(Value::as_str) != Some("unexpected-thread-id")
        }),
        "unexpected-thread-id event should not be written to the agent log: {events:?}"
    );
    let sandbox_ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file()).unwrap_or_default();
    assert!(!sandbox_ops.contains("api_to_codex_output_item_started"));
    assert!(!sandbox_ops.contains("api_to_codex_agent_message_item_started"));

    Ok(())
}

fn read_agent_log_events(
    paths: &guest_agent::paths::GuestPaths,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(paths.agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
