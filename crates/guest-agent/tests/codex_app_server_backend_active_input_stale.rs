//! Stale-turn active-input coverage for Codex app-server execution.
//!
//! Configure a bounded child before spawn so the fixture never mutates the
//! environment or working directory of a running test process.

mod common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "codex-app-server-backend-active-input-stale-test";
const CHILD_COMPLETE: &str = "Codex stale-turn active-input assertions passed";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_fails_visible_on_stale_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "drive the app-server backend stale path".to_string(),
            ..Default::default()
        },
    )?;
    common::ensure_canonical_workspace_for_test()?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "codex_app_server_backend_fails_visible_on_stale_active_turn_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
        .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
        .env(guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV, mock)
        .env("MOCK_CODEX_APP_SERVER_SCENARIO", "stale-turn")
        .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "")
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            payload_path,
        )
        .env("HOME", tmp.path())
        .env("OKOU_TEST_CODEX_HOME_DIR", tmp.path().join("codex-home"))
        .env("PATH", "/usr/bin:/bin")
        .current_dir(tmp.path());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    // The child owns runtime-file and CLI-descendant cleanup. The process
    // session also terminates the whole child group on failure or timeout.
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "stale-turn child test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "stale-turn child failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains(CHILD_COMPLETE),
        "stale-turn child did not complete its assertions; stdout:\n{stdout}\nstderr:\n{stderr}"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned with isolated startup inputs by the stale-turn parent test"]
async fn codex_app_server_backend_fails_visible_on_stale_active_turn_child()
-> Result<(), Box<dyn std::error::Error>> {
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let active_input = common::active_input_runtime(&runtime)?;
    let payload = common::active_input_payload("stale follow-up prompt")?;
    assert_eq!(
        active_input.controller().handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        ),
    )
    .await
    .expect("execute_cli_with_active_input should return promptly");

    let error = result.expect_err("stale turn should fail the app-server backend");
    let message = error.to_string();
    assert!(
        message.contains("active input steer failed") && message.contains("stale expectedTurnId"),
        "unexpected error: {message}"
    );

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 1);
    assert_eq!(input_events[0]["kind"], "initial");
    println!("{CHILD_COMPLETE}");

    Ok(())
}
