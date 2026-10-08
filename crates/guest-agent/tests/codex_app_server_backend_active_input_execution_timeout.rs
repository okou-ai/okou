//! An execution deadline must terminate a Codex steer whose response never arrives.
//!
//! This test lives in its own binary to isolate process environment and current
//! directory changes required by the mock Codex integration harness.

mod common;

use std::time::{Duration, Instant};

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{AGENT_EXECUTION_TIMEOUT_EXIT_CODE, CliTerminationReason};
use httpmock::prelude::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const RUN_ID: &str = "codex-app-server-backend-active-input-execution-timeout-test";
const EVENT_ID: &str = "2532261d-b0e1-471e-b93d-1acae383d003";

#[test]
fn execution_timeout_terminates_a_stuck_active_input_steer()
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
                prompt: "drive the active-input execution timeout path",
                scenario: Some("wait-on-turn-steer-response"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "1",
        );
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
    let receipt_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()?;
    let steer_http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", RUN_ID, Duration::ZERO)?;
    let active_input = receipt_runtime.block_on(async {
        ActiveInputRuntime::new_enabled(RUN_ID, &runtime.config.prompt, steer_http)
    });
    let test_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    test_runtime.block_on(assert_execution_timeout(&tmp, &runtime, active_input))?;

    steered.assert_calls(0);

    Ok(())
}

async fn assert_execution_timeout(
    tmp: &tempfile::TempDir,
    runtime: &guest_agent::run_context::GuestRuntime,
    active_input: ActiveInputRuntime,
) -> Result<(), Box<dyn std::error::Error>> {
    let active_input_controller = active_input.controller();
    assert_eq!(
        active_input_controller.handle_control_payload(
            &guest_contracts::active_input::encode_active_input(
                EVENT_ID,
                "save a resumable handoff before timeout",
            )?,
        ),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), CancellationToken::new(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    let ready_file = tmp.path().join(common::MOCK_CODEX_TURN_STEER_READY_FILE);
    let ready_file = ready_file
        .to_str()
        .ok_or_else(|| std::io::Error::other("mock readiness path is not valid UTF-8"))?;
    let execution_timeout = runtime
        .config
        .agent_execution_timeout
        .ok_or_else(|| std::io::Error::other("test config should set an execution timeout"))?;
    let checkpoints = [
        common::VirtualTimeCheckpoint::new(
            ready_file,
            common::MOCK_CODEX_TURN_STEER_READY_EVENT,
            execution_timeout,
        ),
        common::VirtualTimeCheckpoint::new(
            ready_file,
            common::MOCK_CODEX_TURN_STEER_READY_EVENT,
            Duration::from_secs(10),
        ),
    ];

    // The first jump selects the execution timeout and starts the bounded sink
    // settle timer. The second jump exhausts that timer while the mock keeps
    // the turn/steer response pending.
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        common::execute_with_virtual_time_checkpoints(execution, &checkpoints),
    )
    .await
    .map_err(|_| {
        std::io::Error::other("execution deadline should terminate the stuck steer")
    })???;

    assert_eq!(result.exit_code, AGENT_EXECUTION_TIMEOUT_EXIT_CODE);
    let error = result.control_error.as_ref().ok_or_else(|| {
        std::io::Error::other("execution timeout should preserve a controlled error")
    })?;
    assert!(
        error
            .to_string()
            .contains("Agent execution timed out after 1 seconds"),
        "unexpected timeout error: {error}"
    );
    let termination = result.cli_termination.ok_or_else(|| {
        std::io::Error::other("execution timeout should attach termination diagnostics")
    })?;
    assert_eq!(termination.reason, CliTerminationReason::ExecutionTimeout);

    Ok(())
}
