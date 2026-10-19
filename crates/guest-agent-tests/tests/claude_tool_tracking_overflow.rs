//! Claude tool tracking must reject an over-capacity call while preserving
//! watchdog coverage for a later call admitted into a freed slot.

use guest_agent_tests as common;

use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use serde_json::json;
use std::time::Duration;

// Match MAX_TRACKED_STUCK_TOOLS in cli::claude.rs. If production capacity grows
// above this fixture, the overflow WebFetch is retained and the WebSearch
// assertion below fails instead of silently weakening the boundary coverage.
const TRACKED_TOOL_CAPACITY: usize = 256;

// Keep the fence larger than the 8 KiB agent-log buffer. Observing the marker
// on disk then proves all preceding events completed the sequential read loop.
const AGENT_LOG_FENCE_PADDING_BYTES: usize = 16 * 1024;

#[tokio::test]
async fn claude_tool_tracking_overflow_preserves_later_watchdog_coverage()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut prompt_lines = vec!["@ECHO-HANG@".to_string()];
    prompt_lines.extend((0..TRACKED_TOOL_CAPACITY).map(|index| {
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": format!("tracking-admitted-{index}"),
                    "name": "WebFetch",
                    "input": {}
                }]
            }
        })
        .to_string()
    }));
    prompt_lines.push(
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tracking-overflow",
                    "name": "WebFetch",
                    "input": {}
                }]
            }
        })
        .to_string(),
    );
    prompt_lines.extend((0..TRACKED_TOOL_CAPACITY).map(|index| {
        json!({
            "type": "user",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": format!("tracking-admitted-{index}"),
                    "content": "done"
                }]
            }
        })
        .to_string()
    }));
    prompt_lines.push(
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tracking-later-probe",
                    "name": "WebSearch",
                    "input": {}
                }]
            }
        })
        .to_string(),
    );
    prompt_lines.push(
        json!({
            "type": "stream_event",
            "event": {
                "type": common::MOCK_TERMINATION_READY_EVENT,
                "padding": "x".repeat(AGENT_LOG_FENCE_PADDING_BYTES)
            }
        })
        .to_string(),
    );

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt_lines.join("\n"), 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
            "1",
        );
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let checkpoints = [common::VirtualTimeCheckpoint::new(
        runtime.paths.agent_log_file(),
        common::MOCK_TERMINATION_READY_EVENT,
        Duration::from_secs(5),
    )];
    let execution = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
            &checkpoints,
        ),
    )
    .await
    .expect("tool tracking overflow should reach the watchdog within 15s")??;

    assert_eq!(execution.exit_code, common::SIGTERM_EXIT);
    let error = execution
        .control_error
        .as_ref()
        .expect("the later WebSearch should trigger the stuck-tool watchdog");
    assert!(
        error
            .to_string()
            .contains("Tool timeout: WebSearch exceeded 1s"),
        "expected the later WebSearch to remain tracked, got {error}"
    );
    let termination = execution
        .cli_termination
        .expect("stuck-tool timeout should attach CLI termination diagnostics");
    assert_eq!(termination.reason, CliTerminationReason::StuckToolWatchdog);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));

    Ok(())
}
