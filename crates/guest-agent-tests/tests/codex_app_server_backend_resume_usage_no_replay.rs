//! Legacy-style resume coverage when Codex does not replay historical usage.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_derives_resume_usage_without_replay()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193abcdef01723489abcdef01234567";

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-resume-usage-no-replay-test",
                prompt: "derive resumed turn usage without replay",
                scenario: Some("runtime-turn-usage-resume-no-replay"),
                resume_session_id: Some(resume_thread_id),
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            resume_thread_id,
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");

    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert!(cli_result.failure_diagnostic.is_none());
    let events = read_agent_log_events(&runtime.paths)?;
    let completed = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .ok_or("missing turn.completed event")?;
    assert_eq!(completed["usage"], common::expected_codex_turn_usage());

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
