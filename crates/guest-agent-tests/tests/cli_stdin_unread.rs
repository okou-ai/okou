//! A large Claude stdin prompt must not block stdout processing.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn unread_claude_stdin_does_not_block_result_reap() -> Result<(), Box<dyn std::error::Error>>
{
    let tmp = tempfile::tempdir()?;
    let mock = tmp.path().join("unread-stdin-claude");
    std::fs::write(
        &mock,
        r#"#!/bin/sh
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","num_turns":1}'
tail -f /dev/null
"#,
    )?;
    let mut permissions = std::fs::metadata(&mock)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&mock, permissions)?;

    let large_prompt = "x".repeat(2 * 1024 * 1024);
    unsafe {
        common::setup_env(&mock, tmp.path(), &large_prompt, 1, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should not block on unread stdin")?;

    assert_eq!(cli_result.exit_code, common::SIGTERM_EXIT);
    assert_eq!(
        cli_result.jsonl_result.and_then(|result| result.num_turns),
        Some(1)
    );
    Ok(())
}
