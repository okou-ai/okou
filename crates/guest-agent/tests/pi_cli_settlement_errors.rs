//! Pi CLI terminal results preserve error-message and aborted fallback
//! semantics through the guest's public event projection.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{AgentFramework, FailureDetailSource, FailureReason};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

/// Expected public terminal text for a settled Pi run.
///
/// A replaced upstream document cannot be spelled out here because its byte
/// count and digest come from the discarded page, so that case asserts the
/// contract instead: the marker, no observed transport evidence, and no markup.
enum ExpectedTerminalResult<'a> {
    Exact(&'a str),
    UpstreamNonApiResponse,
}

async fn run_settlement_case(
    run_id: &str,
    assistant_messages: &[Value],
    expected_result: ExpectedTerminalResult<'_>,
    expected_failure_reason: Option<FailureReason>,
    expected_assistant_text: Option<&str>,
    base_path: &OsStr,
    original_directory: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let assistant_event_path = tmp.path().join("pi-assistant-event.jsonl");
    std::fs::write(
        &assistant_event_path,
        assistant_messages
            .iter()
            .map(|message| {
                format!(
                    "{}\n",
                    serde_json::json!({ "type": "message_end", "message": message })
                )
            })
            .collect::<String>(),
    )?;

    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"pending-tool-continuation"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111111\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
cat "$PI_ASSISTANT_EVENT_PATH"
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        );
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir];
        paths.extend(std::env::split_paths(base_path));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "verify Pi terminal result".to_string(),
                pi_launch_config:
                    r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#
                        .to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                (
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "PI_ASSISTANT_EVENT_PATH".to_string(),
                    assistant_event_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Pi CLI process timed out"))??;

    std::env::set_current_dir(original_directory)?;
    assert_eq!(result.exit_code, 1);
    assert_eq!(
        result.jsonl_result.map(|summary| summary.status),
        Some(guest_agent::cli::JsonlResultStatus::Error)
    );
    let terminal_failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
        &runtime.config,
        None,
        &result,
    );
    assert_eq!(terminal_failure.diagnostic.framework, AgentFramework::Pi);
    assert_eq!(
        terminal_failure.diagnostic.failure_detail_source,
        Some(FailureDetailSource::PiResult)
    );
    assert_eq!(terminal_failure.diagnostic.claude_num_turns, None);
    assert_eq!(
        terminal_failure.diagnostic.failure_reason,
        expected_failure_reason
    );
    if expected_failure_reason == Some(FailureReason::ProviderRateLimited) {
        assert_eq!(
            result
                .cli_observed_exit
                .as_ref()
                .and_then(|exit| exit.exit_code),
            Some(0)
        );
        assert_eq!(
            terminal_failure.diagnostic.model_request,
            Some(guest_contracts::diagnostics::ModelRequestDiagnostic {
                http_status: Some(429),
                transport_attempts: 1,
                retry_attempts: 0,
                retry_limit: None,
            })
        );
        let reason: api_contracts::generated::types::webhooks::agent::complete::RequestFailureReason =
            terminal_failure.diagnostic.failure_reason.ok_or_else(|| std::io::Error::other("missing completion reason"))?.into();
        assert_eq!(serde_json::to_value(reason)?, "provider_rate_limited");
    }

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert!(
        system_log.contains("Pi JSONL failure result"),
        "system log should attribute the result failure to Pi: {system_log}"
    );
    assert!(
        !system_log.contains("Claude JSONL failure result"),
        "system log should not attribute a Pi result failure to Claude: {system_log}"
    );

    let mut delivered_events = Vec::new();
    for request in server.requests()? {
        let body: Value = serde_json::from_str(&request.body)?;
        delivered_events.extend(
            body.get("events")
                .and_then(Value::as_array)
                .ok_or_else(|| std::io::Error::other("Pi event request omitted its events"))?
                .iter()
                .cloned(),
        );
    }
    let assistants: Vec<_> = delivered_events
        .iter()
        .filter(|event| event["type"] == "assistant")
        .collect();
    if let Some(text) = expected_assistant_text {
        assert_eq!(assistants.len(), 1);
        assert_eq!(
            assistants
                .first()
                .and_then(|assistant| assistant.pointer("/message/content/0/text")),
            Some(&Value::String(text.to_string()))
        );
    } else {
        assert!(assistants.is_empty());
    }
    assert_eq!(
        delivered_events
            .iter()
            .filter(|event| event["type"] == "result")
            .count(),
        1
    );
    let terminal = delivered_events
        .iter()
        .find(|event| event["type"] == "result")
        .ok_or_else(|| std::io::Error::other("terminal result was not delivered"))?;
    assert_eq!(terminal["subtype"], "error_during_execution");
    assert_eq!(terminal["is_error"], true);
    let result = terminal["result"]
        .as_str()
        .ok_or_else(|| std::io::Error::other("terminal result text was not a string"))?;
    match expected_result {
        ExpectedTerminalResult::Exact(expected) => assert_eq!(result, expected),
        ExpectedTerminalResult::UpstreamNonApiResponse => {
            assert!(
                result.starts_with("upstream_non_api_response "),
                "terminal result should carry the upstream marker: {result}"
            );
            assert!(
                result.contains("status=unknown") && result.contains("content_type=unknown"),
                "guest-side projection cannot claim transport evidence: {result}"
            );
            assert!(
                !result.contains('<'),
                "terminal result should not republish the upstream document: {result}"
            );
            assert!(
                result.len() < 128,
                "terminal result should stay bounded: {result}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn guest_preserves_pi_error_and_aborted_settlement_results()
-> Result<(), Box<dyn std::error::Error>> {
    let base_path = std::env::var_os("PATH").unwrap_or_default();
    let original_directory = std::env::current_dir()?;
    // Shared with the real TypeScript provider-boundary regression. No status
    // is inferred from the detail text by this guest entry point.
    let rate_limit: Value = serde_json::from_str(include_str!(
        "../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-rate-limit.json"
    ))?;
    run_settlement_case(
        "00000000-0000-4000-8000-000000000130",
        std::slice::from_ref(&rate_limit),
        ExpectedTerminalResult::Exact(r#"{"detail":"Rate limit exceeded"}"#),
        Some(FailureReason::ProviderRateLimited),
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    for (run_id, status) in [
        ("00000000-0000-4000-8000-000000000133", 200),
        ("00000000-0000-4000-8000-000000000134", 401),
    ] {
        let mut other_status = rate_limit.clone();
        other_status["diagnostics"][0]["details"]["httpStatus"] = Value::from(status);
        run_settlement_case(
            run_id,
            &[other_status],
            ExpectedTerminalResult::Exact(r#"{"detail":"Rate limit exceeded"}"#),
            None,
            None,
            &base_path,
            &original_directory,
        )
        .await?;
    }
    let mut explicit_usage = rate_limit.clone();
    explicit_usage["errorMessage"] =
        Value::from("You have hit your ChatGPT usage limit (plus plan).");
    run_settlement_case(
        "00000000-0000-4000-8000-000000000131",
        &[explicit_usage],
        ExpectedTerminalResult::Exact("You have hit your ChatGPT usage limit (plus plan)."),
        Some(FailureReason::UsageLimit),
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    let mut historical = rate_limit.clone();
    historical
        .as_object_mut()
        .ok_or_else(|| std::io::Error::other("expected assistant object"))?
        .remove("diagnostics");
    run_settlement_case(
        "00000000-0000-4000-8000-000000000132",
        &[historical],
        ExpectedTerminalResult::Exact(r#"{"detail":"Rate limit exceeded"}"#),
        None,
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    run_settlement_case(
        "00000000-0000-4000-8000-000000000124",
        &[serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "ignored assistant text" }],
            "model": "deepseek-v4-flash",
            "responseId": "response-error",
            "usage": {},
            "stopReason": "error",
            "errorMessage": "API Error: Overloaded",
            "timestamp": 1,
        })],
        ExpectedTerminalResult::Exact("API Error: Overloaded"),
        None,
        Some("ignored assistant text"),
        &base_path,
        &original_directory,
    )
    .await?;
    run_settlement_case(
        "00000000-0000-4000-8000-000000000125",
        &[serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "ignored assistant text" }],
            "model": "deepseek-v4-flash",
            "responseId": "response-aborted",
            "usage": {},
            "stopReason": "aborted",
            "errorMessage": "",
            "timestamp": 1,
        })],
        ExpectedTerminalResult::Exact("Pi model turn aborted"),
        None,
        Some("ignored assistant text"),
        &base_path,
        &original_directory,
    )
    .await?;
    // This fixture is also asserted against actual official RPC output by the
    // TypeScript pending-tool cancellation test (only its timestamp is normalized).
    let [assistant_end, settlement]: [Value; 2] = serde_json::from_str(include_str!(
        "../../../turbo/packages/pi-agent-runtime/src/test/fixtures/pending-tool-abort.json"
    ))?;
    assert_eq!(settlement["type"], "agent_settled");
    run_settlement_case(
        "00000000-0000-4000-8000-000000000126",
        std::slice::from_ref(&assistant_end["message"]),
        ExpectedTerminalResult::Exact("This operation was aborted"),
        None,
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    // An older sandbox CLI can still hand Guest a whole upstream page. Guest
    // must bound it without claiming transport evidence it never observed.
    run_settlement_case(
        "00000000-0000-4000-8000-000000000128",
        &[serde_json::json!({
            "role": "assistant",
            "content": [],
            "model": "deepseek-v4-flash",
            "responseId": "response-upstream-document",
            "usage": {},
            "stopReason": "error",
            "errorMessage": format!(
                "<html>\n  <head><style global>body{{color:#8e8ea0}}</style></head>\n  <body>{}</body>\n</html>",
                "<svg viewBox=\"0 0 41 41\"><path d=\"M37.5324 16.8707\" /></svg>".repeat(200)
            ),
            "timestamp": 1,
        })],
        ExpectedTerminalResult::UpstreamNonApiResponse,
        None,
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    // A current CLI already replaced the page at its provider boundary, so the
    // observed status classifies the failure as an upstream server error.
    run_settlement_case(
        "00000000-0000-4000-8000-000000000129",
        &[serde_json::json!({
            "role": "assistant",
            "content": [],
            "model": "deepseek-v4-flash",
            "responseId": "response-upstream-marker",
            "usage": {},
            "stopReason": "error",
            "errorMessage":
                "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d",
            "timestamp": 1,
        })],
        ExpectedTerminalResult::Exact(
            "upstream_non_api_response status=502 content_type=html bytes=4711 digest=1a2b3c4d",
        ),
        Some(FailureReason::ProviderServerError),
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    // A normal stop already reached Guest when cancellation wins during
    // settlement preparation. Guest must replace its cached terminal outcome.
    let [success, aborted, settlement]: [Value; 3] = serde_json::from_str(include_str!(
        "../../../turbo/packages/pi-agent-runtime/src/test/fixtures/pending-tool-settlement-abort.json"
    ))?;
    assert_eq!(settlement["type"], "agent_settled");
    run_settlement_case(
        "00000000-0000-4000-8000-000000000127",
        &[success["message"].clone(), aborted["message"].clone()],
        ExpectedTerminalResult::Exact("This operation was aborted"),
        None,
        None,
        &base_path,
        &original_directory,
    )
    .await?;
    Ok(())
}
