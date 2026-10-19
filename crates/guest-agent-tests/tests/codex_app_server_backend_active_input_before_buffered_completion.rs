//! Active-input ordering coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_steers_accepted_input_before_buffered_completion()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-backend-active-input-before-buffered-completion-test",
                prompt: "drive the app-server backend buffered completion path",
                scenario: Some("runtime-turn-complete"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let active_input = common::active_input_runtime(&runtime)?;
    let payload = common::active_input_payload("follow-up before buffered completion")?;
    assert_eq!(
        active_input.controller().handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

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

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 2);
    assert_eq!(input_events[0]["kind"], "initial");
    assert_eq!(input_events[1]["kind"], "steered");
    assert_eq!(
        input_events[1]["text"],
        "follow-up before buffered completion"
    );
    let client_user_message_id = input_events[1]["turn_request_client_user_message_id"]
        .as_str()
        .expect("steered input should carry an internal UUID");
    assert!(Uuid::parse_str(client_user_message_id).is_ok());

    Ok(())
}
