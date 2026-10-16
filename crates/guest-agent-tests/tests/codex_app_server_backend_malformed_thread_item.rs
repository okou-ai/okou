//! Public-boundary validation coverage for supported Codex thread items.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_malformed_supported_thread_item()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-malformed-thread-item-test",
                prompt: "reject malformed supported Codex thread items",
                scenario: Some("runtime-malformed-thread-item"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_START_TIME_ENV,
            "1699999999000",
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

    let error = result.expect_err("malformed supported item should fail the backend");
    assert_eq!(
        error.to_string(),
        "execution: codex app-server notification item/completed has invalid field item.reasoningEffort"
    );

    let events = read_jsonl(runtime.paths.agent_log_file())?;
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        ["thread.started", "turn.started"]
    );
    assert!(events.iter().all(|event| {
        event.pointer("/item/id").and_then(Value::as_str) != Some("mock-malformed-collab-item")
    }));

    Ok(())
}

fn read_jsonl(path: &str) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    std::fs::read_to_string(path)?
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
