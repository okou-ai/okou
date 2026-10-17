//! CLI stderr diagnostics must preserve an exact-limit final line without `\n`.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use guest_contracts::cli_stderr_diagnostics::CLI_STDERR_RESULT_MAX_LINE_BYTES;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_keeps_exact_limit_stderr_without_newline()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let exact_limit_line = "x".repeat(CLI_STDERR_RESULT_MAX_LINE_BYTES);

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("@fail-no-newline:{exact_limit_line}"),
            3,
            1,
        )?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 1);
    assert_eq!(cli_result.stderr_lines, vec![exact_limit_line]);

    Ok(())
}
