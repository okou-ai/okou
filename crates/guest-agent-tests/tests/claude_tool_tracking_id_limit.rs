//! Claude tool tracking must keep the run alive when a supported tool-use ID
//! is too large to retain in the watchdog state.

use guest_agent_tests as common;

use serde_json::json;
use std::time::Duration;

const OVERSIZED_TOOL_ID_BYTES: usize = 1025;

#[tokio::test]
async fn oversized_watchdog_tool_id_does_not_terminate_run()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let prompt = [
        "@ECHO@".to_string(),
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "x".repeat(OVERSIZED_TOOL_ID_BYTES),
                    "name": "WebFetch",
                    "input": {}
                }]
            }
        })
        .to_string(),
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done"
        })
        .to_string(),
    ]
    .join("\n");

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("oversized tool-use ID should not stall the run")?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());

    Ok(())
}
