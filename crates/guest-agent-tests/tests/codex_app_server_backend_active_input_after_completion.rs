//! Late active-input coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::masker::SecretMasker;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_rejects_active_input_after_turn_completion()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-active-input-after-completion-test",
                prompt: "drive the app-server backend completion path",
                scenario: Some("runtime-turn-complete"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let active_input = common::active_input_runtime(&runtime)?;
    let controller = active_input.controller();

    let masker = SecretMasker::from_raw("");
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);

    let payload = common::active_input_payload("late follow-up prompt")?;
    assert!(matches!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input is closed"
    ));

    Ok(())
}
