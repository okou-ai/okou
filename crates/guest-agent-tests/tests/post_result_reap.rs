//! End-to-end: CLI hangs after `type=result`, reap SIGTERMs it, default
//! SIGTERM handler exits with 143. Exercises Idle → SigtermPending →
//! Done via `child.wait()` after the signal.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::time::Duration;

#[tokio::test]
async fn post_result_reap_sigterm_kills_hung_cli() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // Fast SIGTERM convergence, with extra SIGKILL margin for slow
        // runners. A SIGTERM regression still escalates before the 15s
        // outer timeout can leave the long-lived mock behind.
        common::setup_env(&mock, tmp.path(), "@hang-after-result", 1, 5)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Budget: sigterm grace (1s) + sigkill margin (5s) +
    // stdout drain (5s) + slack = 15s.
    // Mock hangs 3600s, so any completion under this cap came from the
    // reap. Locally runs in ~1s.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s — reap likely broken");

    let result = result.expect("execute_cli returned Err");
    let exit_code = result.exit_code;

    assert_eq!(
        exit_code,
        common::SIGTERM_EXIT,
        "expected SIGTERM exit ({}) for the post-result reap path, got {exit_code}; SIGKILL escalation is covered by post_result_reap_sigkill",
        common::SIGTERM_EXIT
    );
    assert!(
        result.control_error.is_none(),
        "post-result reap should not set a controlled execution error"
    );
    let termination = result
        .cli_termination
        .expect("post-result reap should attach CLI termination diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));
    Ok(())
}
