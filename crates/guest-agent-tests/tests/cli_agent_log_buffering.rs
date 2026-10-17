//! Buffered Claude agent-log writes preserve exact JSONL bytes at completion.

use guest_agent_tests as common;

use guest_agent::cli::JsonlResultStatus;
use std::time::Duration;

const INIT_RECORD: &str = r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"00000000-0000-4000-8000-000000000001","tools":["Bash"],"model":"mock-claude"}"#;
const ASSISTANT_RECORD: &str = r#"{"type":"assistant","session_id":"00000000-0000-4000-8000-000000000001","message":{"role":"assistant","content":[{"type":"text","text":"buffered response"}]}}"#;
const RESULT_RECORD: &str = r#"{"type":"result","subtype":"success","session_id":"00000000-0000-4000-8000-000000000001","is_error":false,"duration_ms":1,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#;

#[tokio::test]
async fn agent_log_flushes_exact_buffered_records_before_claude_run_returns()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let payload = [INIT_RECORD, ASSISTANT_RECORD, RESULT_RECORD].join("\n");
    let prompt = format!("@ECHO@\n{payload}");
    unsafe {
        common::setup_env(&mock, tmp.path(), &prompt, 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("buffered Claude run should complete promptly")?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        execution.jsonl_result.map(|result| result.status),
        Some(JsonlResultStatus::Success)
    );
    let expected = format!("{payload}\n");
    assert_eq!(
        std::fs::read(runtime.paths.agent_log_file())?,
        expected.as_bytes()
    );

    Ok(())
}
