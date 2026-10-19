//! Agent-log setup is best-effort and must not block CLI execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use std::time::Duration;

const AGENT_LOG_WARNING: &str = "Agent log open failed; continuing without local transcript";

#[tokio::test]
async fn agent_log_open_failure_warns_and_keeps_cli_run_successful()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let run_id = format!("cli-log-parent-file-{}", std::process::id());
    let runtime_dir = tmp.path().join("guest-runtime");
    let log_parent = runtime_dir.join("logs");
    std::fs::create_dir_all(&runtime_dir)?;
    std::fs::write(&log_parent, b"not a directory")?;

    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, &run_id);
        std::env::set_var(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir.as_os_str(),
        );
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "@exit-after-result".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "");
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV, &mock);
        std::env::set_var("HOME", tmp.path());
    }
    common::ensure_canonical_workspace_for_test()?;

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let system_log_path = tmp.path().join("system.log");
    let _system_log = common::SystemLogOverrideGuard::set(&system_log_path);
    let masker = guest_agent::masker::SecretMasker::from_raw("");

    let execution = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("CLI run should complete promptly without its local agent log")?;

    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert!(execution.cli_termination.is_none());
    assert!(execution.jsonl_result.is_some());
    let system_log = std::fs::read_to_string(system_log_path)?;
    assert_eq!(system_log.matches(AGENT_LOG_WARNING).count(), 1);

    Ok(())
}
