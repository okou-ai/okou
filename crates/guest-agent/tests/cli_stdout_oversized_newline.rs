//! An oversized LF-terminated Claude Code stdout record must fail before it
//! is retained or logged and must trigger bounded cleanup of a live child.

mod common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use std::time::Duration;

#[tokio::test]
async fn oversized_newline_terminated_stdout_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@stdout-over-limit-newline", 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("oversized LF stdout should terminate promptly")?;

    let error = execution
        .control_error
        .expect("stdout framing failure should be a controlled execution error")
        .to_string();
    let expected_error = format!(
        "CLI stdout line exceeded {} bytes: event_type=assistant item_type=text size_bucket=",
        ORDINARY_CLI_STDOUT_MAX_LINE_BYTES
    );
    assert!(
        error.contains(&expected_error),
        "unexpected stdout limit error: {error}"
    );
    // Where the retained prefix stops depends on stdout chunking, so only the
    // two buckets that span the limit are possible.
    assert!(
        ["size_bucket=8-16MiB", "size_bucket=>=16MiB"]
            .iter()
            .any(|bucket| error.contains(bucket)),
        "unexpected oversized record bucket: {error}"
    );
    assert!(
        !error.contains("xxxx") && error.len() < 256,
        "record content must not reach the failure: {error}"
    );
    assert_eq!(execution.last_event_sequence, None);
    let termination = execution
        .cli_termination
        .expect("stdout framing failure should record process-group termination");
    assert_eq!(termination.reason, CliTerminationReason::StdoutIngestion);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));
    assert_eq!(std::fs::metadata(runtime.paths.agent_log_file())?.len(), 0);

    Ok(())
}
