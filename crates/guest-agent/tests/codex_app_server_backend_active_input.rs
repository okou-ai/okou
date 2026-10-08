//! Active-input success coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-backend-active-input-test";
const EVENT_ID: &str = "6bd71939-58df-48f2-81d4-468da3c788a5";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_steers_active_input_into_active_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive the app-server backend with active input",
                scenario: Some("runtime-turn-started-before-steer"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let steered = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/{RUN_ID}/steerable-inputs/{EVENT_ID}/steered"
            ))
            .header("Authorization", "Bearer test-token")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let active_input = ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?,
    );
    let controller = active_input.controller();
    let payload = guest_contracts::active_input::encode_active_input(EVENT_ID, "follow-up prompt")?;
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted,
        "the same delivery must not create a second steer"
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
    assert!(cli_result.failure_diagnostic.is_none());
    steered.assert_calls(1);

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 2);
    assert_eq!(input_events[0]["kind"], "initial");
    assert_eq!(
        input_events[0]["text"],
        "drive the app-server backend with active input"
    );
    assert_eq!(input_events[1]["kind"], "steered");
    assert_eq!(input_events[1]["text"], "follow-up prompt");
    let client_user_message_id = input_events[1]["turn_request_client_user_message_id"]
        .as_str()
        .expect("steered input should carry an internal UUID");
    assert_eq!(client_user_message_id, EVENT_ID);

    Ok(())
}
