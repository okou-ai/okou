//! Resume response validation for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_backend_rejects_mismatched_resume_thread_id()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let resume_thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-resume-mismatch-test",
                prompt: "drive the app-server backend resume mismatch path",
                scenario: Some("resume-different-thread-id"),
                resume_session_id: Some(resume_thread_id),
            },
        )?;
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

    let error = result.expect_err("mismatched resume response should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("thread/resume returned a different thread id"),
        "unexpected error: {message}"
    );
    let session_id_path = runtime.paths.session_id_file();
    assert!(
        !std::path::Path::new(session_id_path).exists(),
        "mismatched resume response should not write a session id"
    );

    Ok(())
}
