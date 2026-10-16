//! Post-open Codex agent-log failures must not fail an otherwise healthy run.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use std::time::Duration;

const AGENT_LOG_WARNING: &str = "Agent log write failed; continuing without local transcript";
const FILE_SIZE_LIMIT: usize = 4 * 1024;

#[tokio::test]
async fn buffered_agent_log_write_failure_keeps_codex_run_successful()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let (mut gate, gated_mock) = common::PostOpenMockGate::create(tmp.path(), &mock)?;
    unsafe {
        common::setup_codex_app_server_env(
            &gated_mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-agent-log-persistence-failure-test",
                prompt: "fail the first local event write",
                scenario: Some("runtime-event-flood"),
                resume_session_id: None,
            },
        )?;
    }

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);

    tokio::select! {
        outcome = &mut execution => {
            return Err(format!("Codex execution completed before the mock gate opened: {outcome:?}").into());
        }
        ready = gate.wait_until_ready(Duration::from_secs(5)) => ready?,
    }

    let system_log_path = tmp.path().join("system.log");
    let _system_log = common::SystemLogOverrideGuard::set(&system_log_path);
    let limit_guard = common::set_soft_file_size_limit(u64::try_from(FILE_SIZE_LIMIT)?)?;
    gate.release()?;
    let outcome = tokio::time::timeout(Duration::from_secs(5), &mut execution)
        .await
        .expect("Codex run should complete promptly after agent-log failure");
    limit_guard.restore()?;
    let execution = outcome?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());
    assert_eq!(
        std::fs::metadata(runtime.paths.agent_log_file())?.len(),
        u64::try_from(FILE_SIZE_LIMIT)?
    );
    let system_log = std::fs::read_to_string(system_log_path)?;
    assert_eq!(system_log.matches(AGENT_LOG_WARNING).count(), 1);

    Ok(())
}
