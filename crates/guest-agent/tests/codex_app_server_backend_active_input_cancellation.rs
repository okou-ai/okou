//! Cancellation must let an in-flight Codex steer settle before completion.
//!
//! This test lives in its own binary to isolate process environment and current
//! directory changes required by the mock Codex integration harness.

mod common;

use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use httpmock::prelude::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const RUN_ID: &str = "codex-app-server-backend-active-input-cancellation-test";
const EVENT_ID: &str = "2532261d-b0e1-471e-b93d-1acae383d001";
const LATE_EVENT_ID: &str = "2532261d-b0e1-471e-b93d-1acae383d002";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn cancellation_preserves_a_steer_response_already_in_flight()
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
                prompt: "drive cancellation during an active-input steer",
                scenario: Some("wait-on-turn-steer-response"),
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
        RUN_ID,
        &runtime.config.prompt,
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?,
    );
    let active_input_controller = active_input.controller();
    assert_eq!(
        active_input_controller.handle_control_payload(
            &guest_contracts::active_input::encode_active_input(
                EVENT_ID,
                "settle this steer before stopping",
            )?,
        ),
        ActiveInputControlOutcome::Accepted
    );

    let cancellation = CancellationToken::new();
    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), cancellation.clone(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    tokio::pin!(execution);
    let ready_file = tmp.path().join(common::MOCK_CODEX_TURN_STEER_READY_FILE);
    tokio::select! {
        result = &mut execution => {
            return Err(format!("Codex execution ended before steer cancellation: {result:?}").into());
        }
        ready = common::wait_for_file_contains(
            &ready_file,
            common::MOCK_CODEX_TURN_STEER_READY_EVENT,
            Duration::from_secs(5),
        ) => ready?,
    }

    cancellation.cancel();
    tokio::select! {
        biased;
        result = &mut execution => {
            return Err(format!("Codex execution ended before steer release: {result:?}").into());
        }
        () = std::future::ready(()) => {}
    }
    assert_eq!(
        active_input_controller.handle_control_payload(
            &guest_contracts::active_input::encode_active_input(
                LATE_EVENT_ID,
                "do not admit this after cancellation",
            )?,
        ),
        ActiveInputControlOutcome::Rejected {
            diagnostic: "active input is closed",
        }
    );
    UnixStream::connect(
        tmp.path()
            .join(common::MOCK_CODEX_TURN_STEER_RELEASE_SOCKET),
    )?;
    let result = tokio::time::timeout(Duration::from_secs(10), execution)
        .await
        .expect("Codex cancellation should quiesce")?;

    assert_eq!(
        result
            .cli_termination
            .expect("cancellation should retain termination attribution")
            .reason,
        CliTerminationReason::UserCancellation
    );
    steered.assert_calls(1);

    Ok(())
}
