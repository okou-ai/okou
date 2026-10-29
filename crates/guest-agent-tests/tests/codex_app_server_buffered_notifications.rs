//! Notifications before an RPC response must preserve output and allow the
//! response and turn to finish without exhausting a local protocol queue.

use guest_agent::masker::SecretMasker;
use guest_agent_tests as common;
use serde_json::Value;
use std::time::Duration;

#[tokio::test]
async fn codex_app_server_delivers_buffered_notifications_before_turn_start_response()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let run_id = "codex-buffered-notifications-test";
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id,
                prompt: "complete a turn with notifications preceding its start response",
                scenario: Some("runtime-buffered-notifications"),
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
    .expect("buffered notifications must allow response and turn completion")?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.event_delivery.is_none());

    let mut expected_order = vec!["thread.started", "turn.started"];
    expected_order.extend(std::iter::repeat_n("warning", 129));
    expected_order.extend(["item.completed", "turn.completed"]);

    let log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    let mut local_order = Vec::new();
    let mut warnings = 0;
    for line in log.lines() {
        let event: Value = serde_json::from_str(line)?;
        local_order.push(
            event["type"]
                .as_str()
                .ok_or("local event type missing")?
                .to_owned(),
        );
        if event["type"] == "warning" {
            assert_eq!(event["message"], format!("codex-mock warning {warnings}"));
            warnings += 1;
        }
        if event["type"] == "item.completed" {
            assert_eq!(event["item"]["id"], "large-command");
            let output = event
                .pointer("/item/aggregated_output")
                .and_then(Value::as_str)
                .ok_or("local command output missing")?;
            assert_eq!(output.len(), 65 * 1024 * 1024 + 22);
            assert!(output.starts_with("large-head-"));
            assert!(output.ends_with("-large-tail"));
            const EXPECTED_CHUNK: [u8; 8192] = [b'x'; 8192];
            assert!(
                output.as_bytes()[11..output.len() - 11]
                    .chunks(EXPECTED_CHUNK.len())
                    .all(|chunk| chunk == &EXPECTED_CHUNK[..chunk.len()])
            );
        }
    }
    assert_eq!(warnings, 129);
    assert_eq!(local_order, expected_order);
    drop(log);

    let requests = server
        .wait_for_quiet(Duration::from_millis(50), Duration::from_secs(5))
        .await?;
    let mut delivered_order = Vec::new();
    let mut delivered_warnings = 0;
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
            .ok_or("delivered events missing")?
        {
            delivered_order.push(
                event["type"]
                    .as_str()
                    .ok_or("delivered event type missing")?
                    .to_owned(),
            );
            if event["type"] == "warning" {
                assert_eq!(
                    event["message"],
                    format!("codex-mock warning {delivered_warnings}")
                );
                delivered_warnings += 1;
            }
            if event["type"] == "item.completed" {
                assert_eq!(event["item"]["id"], "large-command");
                let output = event
                    .pointer("/item/aggregated_output")
                    .and_then(Value::as_str)
                    .ok_or("delivered command output missing")?;
                assert!(output.starts_with("large-head-"));
                assert!(output.ends_with("-large-tail"));
                assert!(output.contains("bytes truncated for delivery"));
            }
        }
    }
    assert_eq!(delivered_warnings, 129);
    assert_eq!(delivered_order, expected_order);
    Ok(())
}
