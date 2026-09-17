//! API-enabled `execute_cli` should capture session metadata from stdout events
//! while still delivering webhook events.
//!
//! Configure a bounded child before spawn so the fixture never mutates the
//! environment or working directory of a running test process.

mod common;

use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

const RUN_ID: &str = "execute-cli-api-mode-test";
const STALE_RUN_ID: &str = "stale-ambient-run-id";
const SESSION_ID: &str = "preview-filtered-user";
const CHILD_COMPLETE: &str = "API-mode child assertions passed";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn api_mode_execute_cli_captures_session_metadata_and_sends_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let prompt = [
        "@ECHO@",
        r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"preview-filtered-user","tools":["Bash"],"model":"mock-claude"}"#,
        r#"{"type":"user","session_id":"preview-filtered-user","uuid":"unknown-user-replay","message":{"role":"user","content":"should-not-upload"},"parent_tool_use_id":null}"#,
        r#"{"type":"result","subtype":"success","session_id":"preview-filtered-user","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
        "",
    ]
    .join("\n");

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt,
            ..Default::default()
        },
    )?;
    common::ensure_canonical_workspace_for_test()?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "api_mode_execute_cli_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "claude-code")
        .env(guest_contracts::env::USE_MOCK_CLAUDE_ENV, "true")
        .env(
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_cli,
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "3",
        )
        .env(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        )
        .env(guest_contracts::env::RUN_ID_ENV, STALE_RUN_ID)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
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
        .env("PATH", "/usr/bin:/bin")
        .current_dir(tmp.path());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    // The session owner cleans up CLI descendants on success, failure or timeout
    // before this parent releases the server and temporary runtime files.
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "API-mode child test did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "API-mode child failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains(CHILD_COMPLETE),
        "API-mode child did not complete its assertions; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    let requests = server.requests()?;
    assert!(
        (1..=2).contains(&requests.len()),
        "init and result should use one batch or two singleton requests, got {}",
        requests.len()
    );
    let mut delivered_events = Vec::new();
    for request in requests {
        assert_eq!(request.path, "/api/webhooks/agent/events");
        assert_eq!(request.authorization.as_deref(), Some("Bearer test-token"));
        assert_eq!(request.content_type.as_deref(), Some("application/json"));
        let body: Value = serde_json::from_str(&request.body)?;
        assert_eq!(body.get("runId").and_then(Value::as_str), Some(RUN_ID));
        delivered_events.extend(
            body.get("events")
                .and_then(Value::as_array)
                .expect("event request should contain an events array")
                .iter()
                .cloned(),
        );
    }
    assert_eq!(delivered_events.len(), 2);
    assert_eq!(
        delivered_events[0].get("subtype").and_then(Value::as_str),
        Some("init")
    );
    assert_eq!(
        delivered_events[0]
            .get("session_id")
            .and_then(Value::as_str),
        Some(SESSION_ID)
    );
    assert_eq!(
        delivered_events[1].get("type").and_then(Value::as_str),
        Some("result")
    );
    assert!(
        delivered_events
            .iter()
            .all(|event| !event.to_string().contains("should-not-upload")),
        "replayed user event should not be delivered"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned with isolated startup inputs by the API-mode parent test"]
async fn api_mode_execute_cli_child() -> Result<(), Box<dyn std::error::Error>> {
    let mut raw = GuestConfigRaw::from_process_env()?;
    assert_eq!(raw.run_id, STALE_RUN_ID);
    // Supply the captured run identity as owned input while leaving the ambient
    // value stale. Event delivery must use this config rather than reread env.
    raw.run_id = RUN_ID.to_string();
    let runtime_dir =
        guest_contracts::runtime_paths::run_dir_for_home(std::env::current_dir()?, RUN_ID)?;
    let paths = GuestPaths::from_runtime_dir(runtime_dir);
    let _run_files = common::RunFilesGuard::new_for_paths(&paths);
    guest_telemetry::log::set_system_log_file(paths.system_log_file());
    guest_telemetry::telemetry::set_sandbox_ops_log_file(paths.sandbox_ops_file());
    let config = GuestConfig::from_raw(raw)?;
    let http = HttpClient::for_config(&config)?;
    let runtime = GuestRuntime {
        config,
        paths,
        http,
        workload_containment: None,
        process_control_endpoint: None,
    };
    assert_ne!(
        runtime.config.run_id,
        std::env::var(guest_contracts::env::RUN_ID_ENV)?
    );

    let masker = SecretMasker::from_raw("");
    let active_input = common::active_input_runtime(&runtime)?;
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        guest_agent::cli::execute_cli_with_active_input_for_config(
            &masker,
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            active_input.into_writer(),
            &runtime.config,
            &runtime.paths,
        ),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(
        cli_result.last_event_sequence,
        Some(1),
        "API mode should acknowledge the init and result events"
    );
    let captured_session_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    assert_eq!(captured_session_id, SESSION_ID);
    println!("{CHILD_COMPLETE}");

    Ok(())
}
