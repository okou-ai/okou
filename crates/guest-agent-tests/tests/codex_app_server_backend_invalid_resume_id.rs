//! Resume id validation for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_invalid_resume_id_before_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let missing_mock = tmp.path().join("missing-mock-codex");
    let invalid_resume_id = "not-a-valid-codex-thread-id";

    unsafe {
        common::setup_codex_app_server_env(
            &missing_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-invalid-resume-id-test",
                prompt: "drive the app-server backend invalid resume id path",
                scenario: None,
                resume_session_id: Some(invalid_resume_id),
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            invalid_resume_id,
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

    let error = result.expect_err("invalid resume id should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("resume session id is not a valid Codex thread id"),
        "unexpected error: {message}"
    );
    assert!(
        !message.contains(invalid_resume_id),
        "invalid resume id diagnostic echoed the value: {message}"
    );
    assert!(
        !message.contains("failed to spawn codex app-server"),
        "invalid resume id should fail before app-server spawn: {message}"
    );
    let session_id_path = runtime.paths.session_id_file();
    assert!(
        !std::path::Path::new(session_id_path).exists(),
        "invalid resume id should not write a session id"
    );

    Ok(())
}
