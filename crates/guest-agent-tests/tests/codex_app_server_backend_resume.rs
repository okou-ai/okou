//! Resume-path integration coverage for Codex app-server execution.
//!
//! This is separate from `codex_app_server_backend.rs` because `guest_agent::env`
//! uses resume-session process env setup that must stay isolated.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_resumes_existing_thread_id()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193ABCDEF01723489ABCDEF01234567";
    let canonical_resume_thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-resume-test",
                prompt: "drive the app-server resume backend",
                scenario: Some("runtime-turn-usage-resume-replay"),
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
    assert_eq!(
        events[0].get("type").and_then(Value::as_str),
        Some("thread.started")
    );
    assert_eq!(
        events[0].get("thread_id").and_then(Value::as_str),
        Some(canonical_resume_thread_id)
    );
    let completed = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .ok_or("missing turn.completed event")?;
    assert_eq!(completed["usage"], common::expected_codex_turn_usage());

    let stored_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert_eq!(stored_id, canonical_resume_thread_id);

    let session_events = common::read_codex_session_history_events_for_runtime(&runtime)?;
    let input_event = session_events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .ok_or("missing mock app-server input event")?;
    assert_eq!(
        input_event
            .get("thread_request_excludes_turns")
            .and_then(Value::as_bool),
        Some(true)
    );

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
