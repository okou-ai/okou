//! End-to-end: a meaningful JSONL event after `type=result` refreshes the
//! post-result quiet deadline before the hung CLI is reaped.

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_refreshes_quiet_deadline_on_meaningful_event()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(&mock, tmp.path(), "@hang-after-result-then-event", 2, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "10",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();
    let event_offset = Duration::from_secs(1);
    let stale_deadline_after_event = runtime
        .config
        .post_result_sigterm_grace
        .checked_sub(event_offset)
        .expect("the meaningful event should precede the original quiet deadline");
    let refreshed_deadline_after_stale = runtime
        .config
        .post_result_sigterm_grace
        .checked_sub(stale_deadline_after_event)
        .expect("the refreshed quiet deadline should follow the original deadline");
    let release_one = tmp.path().join(common::MOCK_POST_RESULT_RELEASE_ONE_SOCKET);
    let release_two = tmp.path().join(common::MOCK_POST_RESULT_RELEASE_TWO_SOCKET);
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_READY_EVENT,
            event_offset,
        )
        .release_after_advance(&release_one),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_ACTIVITY_ONE_EVENT,
            stale_deadline_after_event,
        )
        .release_after_advance(&release_two),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_LIVENESS_EVENT,
            refreshed_deadline_after_stale,
        ),
    ];

    // Poll at the original quiet deadline before releasing the liveness
    // fence, so a missing live deadline reset terminates the mock early.
    let result = tokio::time::timeout(
        Duration::from_secs(12),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
            &checkpoints,
        ),
    )
    .await
    .expect("execute_cli did not return within 12s")??;
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));

    let ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file())?;
    assert!(ops.contains("trigger=quiet_timeout"), "{ops}");
    assert!(ops.contains("meaningful_events=1"), "{ops}");
    Ok(())
}
