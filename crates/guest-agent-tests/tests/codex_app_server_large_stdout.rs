//! A supported Codex notification above the former stdout cap must complete
//! execution and retain full local output while bounding its webhook copy.

use guest_agent::masker::SecretMasker;
use guest_agent_tests as common;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_delivers_notification_above_former_stdout_limit()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let run_id = "codex-large-stdout-test";
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id,
                prompt: "complete a turn containing a large command result",
                scenario: Some("runtime-large-stdout"),
                resume_session_id: None,
            },
        )?;
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("large notification must allow turn completion")?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.event_delivery.is_none());

    let log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    let mut saw_command = false;
    let mut saw_completion = false;
    for line in log.lines() {
        let event: Value = serde_json::from_str(line)?;
        if event.pointer("/item/id").and_then(Value::as_str) == Some("large-command") {
            let output = event
                .pointer("/item/aggregated_output")
                .and_then(Value::as_str)
                .ok_or("local command output missing")?;
            assert_eq!(output.len(), 65 * 1024 * 1024 + 22);
            assert!(output.starts_with("large-head-"));
            assert!(output.ends_with("-large-tail"));
            assert!(
                output[11..output.len() - 11]
                    .bytes()
                    .all(|byte| byte == b'x')
            );
            saw_command = true;
        }
        saw_completion |= event["type"] == "turn.completed";
    }
    assert!(saw_command && saw_completion);
    drop(log);

    let requests = server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(5))
        .await?;
    let mut delivered_command = false;
    let mut delivered_completion = false;
    for request in requests {
        let common::RecordedHttpEvent::Request(request) = request else {
            continue;
        };
        if request.path != "/api/webhooks/agent/events" {
            continue;
        }
        assert!(request.body.len() <= 4 * 1024 * 1024);
        let payload: Value = serde_json::from_str(&request.body)?;
        for event in payload["events"]
            .as_array()
            .ok_or("missing delivered events")?
        {
            if event.pointer("/item/id").and_then(Value::as_str) == Some("large-command") {
                let output = event
                    .pointer("/item/aggregated_output")
                    .and_then(Value::as_str)
                    .ok_or("delivered command output missing")?;
                assert!(output.starts_with("large-head-"));
                assert!(output.ends_with("-large-tail"));
                assert!(output.contains("bytes truncated for delivery"));
                delivered_command = true;
            }
            delivered_completion |= event["type"] == "turn.completed";
        }
    }
    assert!(delivered_command && delivered_completion);
    Ok(())
}
