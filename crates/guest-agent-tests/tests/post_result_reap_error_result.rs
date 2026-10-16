//! End-to-end: a Claude error `type=result` followed by cleanup termination
//! remains a semantic failure source instead of falling back to exit 143.

use guest_agent_tests as common;

use guest_agent::cli::JsonlResultStatus;
use guest_contracts::diagnostics::{
    CliTerminationReason, CliTerminationSignal, FailureDetailSource,
};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_preserves_error_diagnostic() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@hang-after-error-result", 1, 1)?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 8s");

    let result = result.expect("execute_cli returned Err");
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    assert_eq!(
        result.jsonl_result.map(|summary| summary.status),
        Some(JsonlResultStatus::Error)
    );
    assert_eq!(
        result
            .post_result_cleanup_jsonl_result
            .map(|summary| summary.status),
        Some(JsonlResultStatus::Error)
    );

    let diagnostic = result
        .failure_diagnostic
        .expect("error result should attach CLI failure diagnostic");
    assert_eq!(diagnostic.message, "Mock Claude error.");
    assert_eq!(diagnostic.source, FailureDetailSource::ClaudeResult);

    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    Ok(())
}
