//! CLI stderr diagnostics must tolerate invalid UTF-8 bytes.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test]
async fn cli_failure_decodes_invalid_stderr_lossily() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_env(&mock, tmp.path(), "@fail-invalid-utf8", 3, 1)?;
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
    assert_eq!(cli_result.stderr_lines, vec!["invalid-\u{fffd}-stderr"]);

    Ok(())
}
