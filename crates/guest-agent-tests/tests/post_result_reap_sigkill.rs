//! End-to-end: CLI hangs after `type=result` AND ignores SIGTERM, so
//! the reap FSM must escalate to SIGKILL. Exercises Idle → SigtermPending
//! → SigkillPending → Done, which the main `post_result_reap` test
//! never reaches (default SIGTERM handler terminates its mock).
//!
//! This specifically covers execution-deadline acceleration before SIGTERM;
//! the adjacent execution-deadline boundary test covers the later
//! SigkillPending window.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_escalates_to_sigkill_when_sigterm_ignored()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // The 1s execution deadline expires after the terminal result but
        // before the 60s post-result SIGTERM. It must advance the existing
        // reaper without reclassifying semantic completion as an execution
        // timeout. SIGTERM is ignored, then the 1s SIGKILL grace completes
        // within the outer test bound.
        common::setup_env(&mock, tmp.path(), "@hang-after-result-deaf", 60, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "1",
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();
    let execution_timeout = runtime
        .config
        .agent_execution_timeout
        .expect("test config should set an execution timeout");
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            runtime.paths.agent_log_file(),
            common::MOCK_TERMINATION_READY_EVENT,
            execution_timeout,
        ),
        common::VirtualTimeCheckpoint::new(
            runtime.paths.system_log_file(),
            "Agent execution deadline reached during post-result cleanup",
            runtime.config.post_result_sigkill_grace,
        ),
    ];

    // The mock fence proves result ingestion armed cleanup before the
    // execution-deadline jump. The transition log proves that deadline
    // advanced cleanup and armed SIGKILL. Without that acceleration, the
    // configured 60s post-result grace would exceed this real bound.
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
            &checkpoints,
        ),
    )
    .await
    .expect("execute_cli did not return within 10s — deadline acceleration likely broken")?;

    let result = result.expect("execute_cli returned Err");
    let exit_code = result.exit_code;

    // SIGKILL (9) → 128 + 9 = 137. SIGTERM is SIG_IGN'd in the mock,
    // so 143 here would mean our SIGTERM somehow won a race it can't
    // — or the mock isn't actually ignoring it (harness regression).
    assert_eq!(
        exit_code,
        common::SIGKILL_EXIT,
        "expected SIGKILL exit ({}), got {exit_code} — SigkillPending escalation path is not firing",
        common::SIGKILL_EXIT
    );
    assert!(
        result.control_error.is_none(),
        "post-result reap should not set a controlled execution error"
    );
    let termination = result
        .cli_termination
        .expect("post-result SIGKILL escalation should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));
    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert!(
        system_log.contains("meaningful events 0"),
        "the skipped mock fence must not refresh post-result activity: {system_log}"
    );
    Ok(())
}
