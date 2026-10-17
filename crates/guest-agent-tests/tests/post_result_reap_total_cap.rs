//! End-to-end: periodic meaningful JSONL events after `type=result` refresh the
//! quiet deadline but cannot refresh the absolute post-result total cap.

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_total_cap_bounds_periodic_meaningful_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_env(
            &mock,
            tmp.path(),
            "@hang-after-result-periodic-events",
            2,
            1,
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "3",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();
    let event_interval = Duration::from_secs(1);
    let total_cap_after_events = runtime
        .config
        .post_result_total_cap
        .checked_sub(event_interval)
        .and_then(|remaining| remaining.checked_sub(event_interval))
        .expect("the total cap should follow both meaningful events");
    let release_one = tmp.path().join(common::MOCK_POST_RESULT_RELEASE_ONE_SOCKET);
    let release_two = tmp.path().join(common::MOCK_POST_RESULT_RELEASE_TWO_SOCKET);
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_READY_EVENT,
            event_interval,
        )
        .release_after_advance(&release_one),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_ACTIVITY_ONE_EVENT,
            event_interval,
        )
        .release_after_advance(&release_two),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_POST_RESULT_ACTIVITY_TWO_EVENT,
            total_cap_after_events,
        ),
    ];

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
            &checkpoints,
        ),
    )
    .await
    .expect("execute_cli did not return within 8s")??;
    assert_eq!(result.exit_code, common::SIGTERM_EXIT);
    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));

    let ops = std::fs::read_to_string(runtime.paths.sandbox_ops_file())?;
    let cleanup_line = ops
        .lines()
        .find(|line| line.contains("post_result_cleanup_terminated"))
        .expect("post-result cleanup telemetry should be recorded");
    assert!(cleanup_line.contains("trigger=total_cap"), "{ops}");
    assert!(cleanup_line.contains("meaningful_events=2"), "{ops}");
    Ok(())
}
