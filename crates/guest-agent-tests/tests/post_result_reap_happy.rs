//! End-to-end: CLI cleanly exits on its own after `type=result`. The
//! agent either arms the reap deadline and then observes `child.wait()`,
//! or observes `child.wait()` first and keeps the FSM in Done so the
//! drained result event cannot re-arm it. Neither ordering sends SIGTERM
//! or SIGKILL.
//!
//! Guards against the regression "reap accidentally kills healthy CLIs"
//! by keeping the configured reap deadline beyond the test timeout and
//! asserting the mock result is observed and exits cleanly before that
//! deadline can fire.
//!
//! See: https://github.com/vm0-ai/vm0/issues/10879

use guest_agent_tests as common;

use std::time::Duration;

#[tokio::test]
async fn post_result_reap_stays_silent_on_clean_exit() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        // Keep post-result reap outside the 15s test timeout. If this
        // happy path returns successfully, it returned before the reap
        // deadline could fire. sigkill grace is unused on this path.
        common::setup_env(&mock, tmp.path(), "@exit-after-result", 60, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "2",
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let heartbeat = common::spawn_dummy_heartbeat();

    // Happy path completes before the configured 60s post-result reap
    // grace. The 15s cap is only a hang guard, not a performance
    // assertion on fork/exec or async scheduling.
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_cli_for_runtime(&runtime, &masker, heartbeat),
    )
    .await
    .expect("execute_cli did not return within 15s on the happy path");

    let result = result.expect("execute_cli returned Err");
    let exit_code = result.exit_code;

    // Prove this test really exercised the post-result path. A clean
    // exit without a parsed `type=result` event would not validate the
    // reap arming/drain race this test exists to cover.
    assert!(
        result.jsonl_result.is_some(),
        "expected the mock type=result event to be observed before clean exit"
    );

    // Clean exit(0) — if this is SIGTERM_EXIT / SIGKILL_EXIT, the
    // reap fired against a healthy CLI, which is a correctness bug.
    assert_eq!(
        exit_code,
        common::CLEAN_EXIT,
        "expected clean exit, got {exit_code} — reap may have killed a healthy CLI"
    );
    assert!(
        result.cli_termination.is_none(),
        "a CLI that exits before the execution deadline must keep its natural result"
    );
    Ok(())
}
