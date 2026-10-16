//! A Claude Code result for a startup task notification is observable but
//! cannot terminate the actual user command or arm post-result cleanup.

use guest_agent_tests as common;

use guest_contracts::diagnostics::CliTerminationReason;
use serde_json::json;
use std::time::Duration;

const TRANSCRIPT_CHECKPOINT_PADDING_BYTES: usize = 16 * 1024;

#[tokio::test]
async fn task_notification_result_does_not_end_the_user_command()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let session_id = "mock-task-notification-result";
    let continued_activity = "actual user command is still running";
    let prompt = [
        "@ECHO-HANG@".to_string(),
        json!({
            "type": "system",
            "subtype": "task_notification",
            "session_id": session_id,
            "task_id": "background-workflow",
            "status": "stopped",
            "summary": "Previous background workflow had no completion record"
        })
        .to_string(),
        json!({
            "type": "command_lifecycle",
            "session_id": session_id,
            "command_uuid": "user-command",
            "state": "queued"
        })
        .to_string(),
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "cwd": "/home/user/workspace",
            "tools": ["Bash"],
            "model": "mock-claude"
        })
        .to_string(),
        json!({
            "type": "result",
            "subtype": "success",
            "session_id": session_id,
            "is_error": false,
            "num_turns": 0,
            "result": "",
            "origin": { "kind": "task-notification" }
        })
        .to_string(),
        json!({
            "type": "command_lifecycle",
            "session_id": session_id,
            "command_uuid": "user-command",
            "state": "started"
        })
        .to_string(),
        json!({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": continued_activity }]
            },
            // Keep this checkpoint larger than the transcript buffer. Its
            // persisted marker proves the earlier task result was consumed.
            "checkpoint_padding": "x".repeat(TRANSCRIPT_CHECKPOINT_PADDING_BYTES)
        })
        .to_string(),
    ]
    .join("\n");

    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "1",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "2",
        );
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let checkpoint = common::VirtualTimeCheckpoint::new(
        runtime.paths.agent_log_file(),
        continued_activity,
        runtime.config.post_result_total_cap,
    );

    let result = tokio::time::timeout(
        Duration::from_secs(8),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(
                &runtime,
                &guest_agent::masker::SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
            &[checkpoint],
        ),
    )
    .await
    .expect("execution timeout did not terminate the hanging mock")??;

    let error = result
        .control_error
        .as_ref()
        .expect("the independent execution timeout should remain authoritative");
    assert!(
        error
            .to_string()
            .contains("Agent execution timed out after 2 seconds"),
        "unexpected control error: {error}"
    );
    assert_eq!(
        result
            .cli_termination
            .expect("execution timeout should attach termination diagnostics")
            .reason,
        CliTerminationReason::ExecutionTimeout
    );
    assert!(result.jsonl_result.is_none());
    assert!(result.post_result_cleanup_jsonl_result.is_none());

    let agent_log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    assert!(agent_log.contains(r#""kind":"task-notification""#));
    assert!(agent_log.contains(continued_activity));

    Ok(())
}
