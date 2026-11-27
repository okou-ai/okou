//! Active-input ordering coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-backend-active-input-before-buffered-completion-test";
const EVENT_ID: &str = "cb69425e-2325-4a5e-bcfb-48c385f39b10";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_preserves_completion_when_queued_input_is_rejected()
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
                prompt: "drive the app-server backend buffered completion path",
                scenario: Some("runtime-turn-complete"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let steered = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/steerable-inputs/{EVENT_ID}/steered"
        ));
        then.status(200).json_body(json!({ "outcome": "steered" }));
    });
    let active_input = ActiveInputRuntime::new(
        &runtime.config.run_id,
        &runtime.config.prompt,
        HttpClient::with_api_config(server.base_url(), "test-token", RUN_ID, Duration::ZERO)?,
    );
    let payload = guest_contracts::active_input::encode_active_input(
        EVENT_ID,
        "follow-up before buffered completion",
    )?;
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
    steered.assert_calls(0);

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 1);
    assert_eq!(input_events[0]["kind"], "initial");
    assert_eq!(
        input_events[0]["text"],
        "drive the app-server backend buffered completion path"
    );

    Ok(())
}
