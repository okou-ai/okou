//! Claude terminal result failures should be visible as bounded CLI diagnostics.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use common::SystemLogOverrideGuard;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{FailureDetailSource, FailureReason};
use std::time::Duration;

#[tokio::test]
async fn claude_error_result_is_written_to_system_log() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let system_log_path = tmp.path().join("system.log");
    unsafe {
        common::setup_env(&mock, tmp.path(), "", 3, 1)?;
    }

    let mut runtime = common::guest_runtime_from_process_env()?;

    let _system_log = SystemLogOverrideGuard::set(&system_log_path);
    let masker = SecretMasker::from_raw("");
    for (failure_message, expected_reason) in [
        (
            "Credit balance is too low",
            Some(FailureReason::ProviderInsufficientCredits),
        ),
        (
            "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
            Some(FailureReason::ReconnectRequired),
        ),
        (
            "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
            Some(FailureReason::ReconnectRequired),
        ),
        (
            "Failed to authenticate. API Error: 4010 OAuth access token is invalid.",
            None,
        ),
        (
            "Failed to authenticate. API Error: 401 OAuth access token is invalidated.",
            None,
        ),
        (
            "Failed to authenticate. API Error: 401 OAuth access token validation is invalid.",
            None,
        ),
    ] {
        runtime.config.prompt = format!("printf '{failure_message}'; exit 2");
        let cli_result = tokio::time::timeout(
            Duration::from_secs(5),
            common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
        )
        .await
        .expect("execute_cli should return promptly")?;

        assert_eq!(cli_result.exit_code, 2);
        assert!(cli_result.stderr_lines.is_empty());
        assert_eq!(
            cli_result
                .failure_diagnostic
                .as_ref()
                .map(|diagnostic| diagnostic.message.as_str()),
            Some(failure_message)
        );
        assert_eq!(
            cli_result
                .failure_diagnostic
                .as_ref()
                .map(|diagnostic| diagnostic.source),
            Some(FailureDetailSource::ClaudeResult)
        );
        let terminal_failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
            &runtime.config,
            None,
            &cli_result,
        );
        assert_eq!(terminal_failure.message, failure_message);
        assert_eq!(
            terminal_failure.diagnostic.failure_reason, expected_reason,
            "unexpected classification for {failure_message}"
        );

        let system_log = std::fs::read_to_string(&system_log_path)?;
        assert!(
            system_log.contains(&format!(
                "Claude JSONL failure result seq=4 subtype=error: {failure_message}"
            )),
            "system log should include Claude JSONL failure reason: {system_log}"
        );
    }

    runtime.config.prompt = "printf 'Credit balance is too low'".to_string();
    let successful = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await??;
    assert_eq!(successful.exit_code, 0);
    assert!(successful.failure_diagnostic.is_none());

    Ok(())
}
