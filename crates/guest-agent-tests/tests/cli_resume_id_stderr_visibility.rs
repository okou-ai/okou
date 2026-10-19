//! Resume session IDs stay visible even when the CLI fails before emitting JSONL.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use base64::Engine;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_preserves_resume_session_id_in_stderr()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let resume_id = "resume-session-id-123";
    let secret = "actual-stderr-secret-123";

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("@fail-no-newline:resume failed for {resume_id} with {secret}"),
            3,
            1,
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
            resume_id,
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let secret_values = base64::engine::general_purpose::STANDARD.encode(secret);
    let masker = SecretMasker::from_raw(&secret_values);
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 1);
    let stderr = cli_result.stderr_lines.join("\n");
    assert!(
        stderr.contains(&format!("resume failed for {resume_id} with ***")),
        "stderr should preserve resume session id and mask secret, got: {stderr}"
    );
    assert!(!stderr.contains(secret), "stderr leaked secret: {stderr}");

    Ok(())
}
