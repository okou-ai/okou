//! Post-open Claude agent-log failures must not fail an otherwise healthy run.

use guest_agent_tests as common;

use guest_agent::cli::JsonlResultStatus;
use std::time::Duration;

const AGENT_LOG_WARNING: &str = "Agent log flush failed; continuing without local transcript";
const FILE_SIZE_LIMIT: usize = 4 * 1024;
const RESULT_RECORD: &str = r#"{"type":"result","subtype":"success","session_id":"00000000-0000-4000-8000-000000000001","is_error":false,"duration_ms":1,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#;

#[tokio::test]
async fn agent_log_flush_failure_keeps_claude_run_successful()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let (mut gate, gated_mock) = common::PostOpenMockGate::create(tmp.path(), &mock)?;
    let record = format!(
        "{RESULT_RECORD}{}",
        " ".repeat(FILE_SIZE_LIMIT - RESULT_RECORD.len())
    );
    // The padded record reaches the file while the delimiter crosses the
    // process file-size limit during the final buffer flush.
    let prompt = format!("@ECHO@\n{record}");
    unsafe {
        common::setup_env(&gated_mock, tmp.path(), &prompt, 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = guest_agent::masker::SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);

    tokio::select! {
        outcome = &mut execution => {
            return Err(format!("CLI execution completed before the mock gate opened: {outcome:?}").into());
        }
        ready = gate.wait_until_ready(Duration::from_secs(5)) => ready?,
    }

    let system_log_path = tmp.path().join("system.log");
    let _system_log = common::SystemLogOverrideGuard::set(&system_log_path);
    let limit = u64::try_from(FILE_SIZE_LIMIT)?;
    let limit_guard = common::set_soft_file_size_limit(limit)?;
    gate.release()?;
    let outcome = match tokio::time::timeout(Duration::from_secs(5), &mut execution).await {
        Ok(outcome) => outcome,
        Err(_) => {
            let log = std::fs::read(runtime.paths.agent_log_file())?;
            return Err(format!(
                "Claude run did not complete promptly after agent-log failure; log_len={} log={:?}",
                log.len(),
                String::from_utf8_lossy(&log)
            )
            .into());
        }
    };
    limit_guard.restore()?;
    let execution = outcome?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());
    assert_eq!(
        execution.jsonl_result.map(|result| result.status),
        Some(JsonlResultStatus::Success)
    );
    assert_eq!(execution.last_event_sequence, None);
    assert_eq!(
        std::fs::read(runtime.paths.agent_log_file())?,
        record.as_bytes()
    );
    let system_log = std::fs::read_to_string(system_log_path)?;
    assert_eq!(system_log.matches(AGENT_LOG_WARNING).count(), 1);

    Ok(())
}
