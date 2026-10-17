//! CLI stderr diagnostics must not treat a lone final `\r` as CRLF.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use guest_contracts::cli_stderr_diagnostics::{
    CLI_STDERR_OMITTED_LONG_LINE, CLI_STDERR_RESULT_MAX_LINE_BYTES,
};
use std::time::Duration;

#[tokio::test]
async fn cli_failure_omits_overlong_stderr_ending_in_lone_cr()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let overlong_line = format!("{}\r", "x".repeat(CLI_STDERR_RESULT_MAX_LINE_BYTES));

    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            &format!("@fail-no-newline:{overlong_line}"),
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
    assert_eq!(cli_result.stderr_lines, vec![CLI_STDERR_OMITTED_LONG_LINE]);

    Ok(())
}
