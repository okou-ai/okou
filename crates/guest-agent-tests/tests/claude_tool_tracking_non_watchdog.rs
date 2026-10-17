//! Claude tool tracking must ignore tools that are not handled by the
//! stuck-tool watchdog, even when they are emitted in large numbers.

use guest_agent_tests as common;

use serde_json::json;
use std::time::Duration;

const NON_WATCHDOG_TOOL_COUNT: usize = 512;

#[tokio::test]
async fn non_watchdog_tool_events_do_not_fill_tracker() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines.extend((0..NON_WATCHDOG_TOOL_COUNT).map(|index| {
        json!({
            "type": "assistant",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": format!("ignored-tool-{index}"),
                    "name": "Bash",
                    "input": {}
                }]
            }
        })
        .to_string()
    }));
    prompt_lines.push(
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "done"
        })
        .to_string(),
    );

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt_lines.join("\n"), 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("non-watchdog events should not trigger tracker termination")?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());

    Ok(())
}
