//! Explicit user cancellation must stop the inner CLI while leaving
//! guest-agent alive long enough to finish recovery and report completion.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use guest_contracts::diagnostics::{CliTerminationReason, FailureDiagnostic};
use httpmock::prelude::*;
use process_control_ipc::{
    ControlRequest, ControlResponseStatus, accept_with_timeout, bind_abstract_listener,
    endpoint_name, read_hello, read_response, write_request,
};
use serde_json::json;
use tokio::process::Command;
use tokio::sync::oneshot;

const SUCCESS_RUN_ID: &str = "user-cancellation-recovery-success";
const SUCCESS_THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c61";
const FAILURE_RUN_ID: &str = "user-cancellation-recovery-failure";
const FAILURE_THREAD_ID: &str = "019fac13-2355-74d3-8414-b467fbb80c62";

struct Scenario {
    run_id: &'static str,
    thread_id: &'static str,
    endpoint_nonce: &'static [u8; 16],
    combined_completion_status: u16,
    combined_completion_attempts: usize,
    fallback_completion_attempts: usize,
    expected_request_order: &'static [&'static str],
    recovery_log: &'static str,
}

#[tokio::test]
async fn user_cancellation_reports_finalization_with_completion()
-> Result<(), Box<dyn std::error::Error>> {
    run_scenario(Scenario {
        run_id: SUCCESS_RUN_ID,
        thread_id: SUCCESS_THREAD_ID,
        endpoint_nonce: b"cancel-success01",
        combined_completion_status: 200,
        combined_completion_attempts: 1,
        fallback_completion_attempts: 0,
        expected_request_order: &["combined_complete"],
        recovery_log: "Recovery finalization created",
    })
    .await
}

#[tokio::test]
async fn user_cancellation_falls_back_after_combined_completion_failure()
-> Result<(), Box<dyn std::error::Error>> {
    run_scenario(Scenario {
        run_id: FAILURE_RUN_ID,
        thread_id: FAILURE_THREAD_ID,
        endpoint_nonce: b"cancel-failure01",
        combined_completion_status: 500,
        combined_completion_attempts: 3,
        fallback_completion_attempts: 1,
        expected_request_order: &[
            "combined_complete",
            "combined_complete",
            "combined_complete",
            "fallback_complete",
        ],
        recovery_log: "Recovery finalization skipped:",
    })
    .await
}

async fn run_scenario(scenario: Scenario) -> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let home = tmp.path().join("home");
    let codex_home = home.join(".codex");
    let runtime_dir = tmp.path().join("runtime");
    std::fs::create_dir_all(&codex_home)?;
    let mock_codex = common::build_and_locate_mock_codex()?;
    let run_payload_file = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "keep working until the user cancels".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let request_order = Arc::new(Mutex::new(Vec::new()));

    let _heartbeat = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/heartbeat")
            .json_body_includes(format!(r#"{{"runId":"{}"}}"#, scenario.run_id));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let _events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let _telemetry = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/telemetry");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });
    let prepare = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/session-history/prepare")
            .json_body_includes(format!(r#"{{"runId":"{}"}}"#, scenario.run_id));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "presignedUrl": server.url("/test/user-cancellation-history"),
                "existing": false
            }));
    });
    let upload = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/user-cancellation-history")
            .header("Content-Type", "application/octet-stream");
        then.status(200);
    });
    let combined_complete_order = Arc::clone(&request_order);
    let combined_complete = server.mock(move |when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token")
            .json_body_includes(format!(
                r#"{{"runId":"{}","exitCode":1,"completion":{{"cliAgentSessionId":"{}"}}}}"#,
                scenario.run_id, scenario.thread_id
            ));
        then.respond_with(move |_| {
            combined_complete_order
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push("combined_complete");
            HttpMockResponse::builder()
                .status(scenario.combined_completion_status)
                .header("Content-Type", "application/json")
                .body(r#"{"success":true,"status":"failed"}"#)
                .build()
        });
    });
    let fallback_complete_order = Arc::clone(&request_order);
    let fallback_complete = server.mock(move |when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/complete")
            .header("Authorization", "Bearer test-token")
            .is_true(move |request| {
                let Ok(body) = serde_json::from_slice::<serde_json::Value>(request.body_ref())
                else {
                    return false;
                };
                body.get("runId").and_then(serde_json::Value::as_str) == Some(scenario.run_id)
                    && body.get("exitCode").and_then(serde_json::Value::as_i64) == Some(1)
                    && body.get("completion").is_none()
            });
        then.respond_with(move |_| {
            fallback_complete_order
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push("fallback_complete");
            HttpMockResponse::builder()
                .status(200)
                .header("Content-Type", "application/json")
                .body(r#"{"success":true,"status":"failed"}"#)
                .build()
        });
    });

    let endpoint = endpoint_name(std::process::id(), scenario.endpoint_nonce);
    let listener = bind_abstract_listener(&endpoint)?;
    let control_paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir.clone());
    let session_id_file = PathBuf::from(control_paths.session_id_file());
    let session_history_ready_file = codex_home.join(common::MOCK_CODEX_SESSION_HISTORY_READY_FILE);
    let (cancel_tx, cancel_rx) = oneshot::channel();
    let control = tokio::task::spawn_blocking(move || {
        let mut stream = accept_with_timeout(&listener, Duration::from_secs(5))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        read_hello(&mut stream)?;
        cancel_rx.blocking_recv().map_err(|_| {
            std::io::Error::other("cancellation readiness task ended before signaling control")
        })?;
        write_request(
            &mut stream,
            &ControlRequest {
                message_id: "cancel-running-cli".to_string(),
                payload: br#"{"type":"user-cancellation"}"#.to_vec(),
            },
        )?;
        read_response(&mut stream)
    });

    let mut guest_agent_command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    let guest_agent = common::command_output_with_timeout(
        guest_agent_command
            .env_clear()
            .env(
                "PATH",
                std::env::var("PATH")
                    .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string()),
            )
            .env("SHELL", "/bin/sh")
            .env("HOME", &home)
            .env(
                guest_contracts::env::CANONICAL_API_URL_ENV,
                server.base_url(),
            )
            .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
            .env(guest_contracts::env::RUN_ID_ENV, scenario.run_id)
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
                "00000000-0000-4000-8000-000000000abc",
            )
            .env(
                guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
                "reused",
            )
            .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
            .env("OKOU_TEST_CODEX_HOME_DIR", &codex_home)
            .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
            .env(
                guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
                &mock_codex,
            )
            .env(
                guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
                scenario.thread_id,
            )
            .env(
                "MOCK_CODEX_APP_SERVER_SCENARIO",
                "runtime-turn-started-before-steer",
            )
            .env(
                guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
                "1",
            )
            .env(
                guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
                "1",
            )
            .env(
                guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
                &run_payload_file,
            )
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &runtime_dir,
            )
            .env(process_control_ipc::CANONICAL_BOOTSTRAP_ENV, &endpoint)
            .env("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true"),
        Duration::from_secs(20),
        "guest-agent did not finish within its finalization budget",
    );
    let cancellation_ready = async {
        tokio::try_join!(
            common::wait_for_file_contains(
                &session_id_file,
                scenario.thread_id,
                Duration::from_secs(5),
            ),
            common::wait_for_file_contains(
                &session_history_ready_file,
                common::MOCK_CODEX_SESSION_HISTORY_READY_EVENT,
                Duration::from_secs(5),
            ),
        )?;
        cancel_tx
            .send(())
            .map_err(|()| std::io::Error::other("process control task ended before cancellation"))
    };
    let (output, cancellation_ready) = tokio::join!(guest_agent, cancellation_ready);
    cancellation_ready?;
    let output = output?;
    let response = control.await??;

    assert_eq!(response.message_id, "cancel-running-cli");
    assert_eq!(response.status, ControlResponseStatus::Accepted);
    assert_eq!(
        output.status.code(),
        Some(1),
        "guest-agent output:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    prepare.assert_calls_async(1).await;
    upload.assert_calls_async(1).await;
    combined_complete
        .assert_calls_async(scenario.combined_completion_attempts)
        .await;
    fallback_complete
        .assert_calls_async(scenario.fallback_completion_attempts)
        .await;
    assert_eq!(
        request_order
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_slice(),
        scenario.expected_request_order,
        "finalization-less cancellation completion may only follow failed combined attempts"
    );

    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr
        .find(scenario.recovery_log)
        .ok_or_else(|| std::io::Error::other(format!("missing recovery log:\n{stderr}")))?;
    stderr
        .find("Complete webhook acknowledged")
        .ok_or_else(|| std::io::Error::other(format!("missing completion log:\n{stderr}")))?;

    let paths = guest_agent::paths::GuestPaths::from_runtime_dir(runtime_dir);
    let diagnostic: FailureDiagnostic =
        serde_json::from_slice(&std::fs::read(paths.failure_diagnostic_file())?)?;
    let cli_termination = diagnostic
        .cli_termination
        .ok_or_else(|| std::io::Error::other("cancellation diagnostic omitted CLI termination"))?;
    assert_eq!(
        cli_termination.reason,
        CliTerminationReason::UserCancellation
    );
    assert_eq!(
        std::fs::read_to_string(paths.session_id_file())?.trim(),
        scenario.thread_id
    );
    Ok(())
}
