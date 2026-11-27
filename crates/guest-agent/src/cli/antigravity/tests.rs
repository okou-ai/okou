use super::acp::{AcpNotification, JsonRpcError};
use super::events::{EventProjector, UsageTotals};
use super::*;
use guest_contracts::diagnostics::FailureReason;
use serde_json::json;

const SESSION_ID: &str = "59bba40e-6fa2-4ddf-8340-24f38f4e9a12";
const MODEL: &str = "gemini-4-neon-medium";

fn session_update(update: serde_json::Value) -> AcpNotification {
    AcpNotification {
        method: "session/update".into(),
        params: Some(json!({
            "sessionId": SESSION_ID,
            "update": update,
        })),
    }
}

#[test]
fn official_model_families_have_distinct_effort_limits() {
    for family in ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen"] {
        let default_spec = model_spec(Some(family), None).unwrap();
        assert_eq!(default_spec.family, family);
        assert_eq!(default_spec.effort, "medium");
        assert_eq!(default_spec.slug, format!("{family}-medium"));
        for effort in ["low", "medium", "high", "xhigh"] {
            assert_eq!(
                model_spec(Some(family), Some(effort)).is_ok(),
                (family, effort) != ("gemini-4-carbon", "xhigh")
            );
        }
    }
    assert!(model_spec(None, None).is_err());
    assert!(model_spec(Some("gemini-4-neon"), Some("")).is_err());
    assert!(model_spec(Some("gemini-4-neon-custom"), None).is_err());
}

#[test]
fn runs_commands_without_the_terminal_sandbox_or_permission_prompts() {
    let settings = super::settings();
    assert_eq!(settings["enableTerminalSandbox"], false);
    assert_eq!(settings["toolPermission"], "always-proceed");
    assert_eq!(settings["allowNonWorkspaceAccess"], true);
    assert_eq!(settings["artifactReviewPolicy"], "always-proceed");
}

#[test]
fn live_preview_masks_across_chunks_and_reconciles_to_one_durable_block() {
    let masker = crate::masker::SecretMasker::from_raw("Y29uZmlndXJlZC1zZWNyZXQ=");
    let (output, mut chunks) = crate::cli::session_output::test_channel(16, "test");
    let mut projector = EventProjector::new(MODEL, Some(output), &masker);
    let init = projector.begin_session(SESSION_ID.into());
    assert_eq!(init["type"], "system");
    assert_eq!(init["subtype"], "init");
    assert_eq!(init["session_id"], SESSION_ID);
    assert_eq!(init["model"], MODEL);

    let prefix = "This public response starts before the native step finishes. ";
    assert!(
        projector
            .project_notification(&session_update(json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": format!("{prefix}configured-")},
            })))
            .unwrap()
            .is_empty()
    );
    let first = chunks
        .try_recv()
        .expect("first preview while streaming chunks");
    let mut preview = first.delta;
    assert!(!preview.is_empty());

    assert!(
        projector
            .project_notification(&session_update(json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "secret"},
            })))
            .unwrap()
            .is_empty()
    );

    let flushed = projector.record_prompt_response(&json!({
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "thoughtTokens": 2,
            "cachedReadTokens": 4,
            "totalTokens": 17,
        }
    }));
    assert_eq!(flushed.len(), 1);
    let mut durable = flushed.into_iter().next().unwrap();
    masker.mask_value(&mut durable);

    while let Ok(chunk) = chunks.try_recv() {
        assert_eq!(chunk.run_event_id, first.run_event_id);
        preview.push_str(&chunk.delta);
    }
    assert!(preview.starts_with(prefix));
    assert!(!preview.contains("configured-secret"));
    assert_eq!(durable["runEventId"], first.run_event_id);
    assert_eq!(durable["message"]["content"][0]["text"], preview);
}

#[test]
fn tool_call_and_update_project_to_tool_use_and_tool_result() {
    let masker = crate::masker::SecretMasker::from_raw("");
    let mut projector = EventProjector::new(MODEL, None, &masker);
    projector.begin_session(SESSION_ID.into());

    let call_events = projector
        .project_notification(&session_update(json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-1",
            "name": "run_command",
            "rawInput": {"CommandLine": "exit 2"},
            "status": "in_progress",
        })))
        .unwrap();
    assert_eq!(call_events.len(), 1);
    assert_eq!(call_events[0]["type"], "assistant");
    assert_eq!(call_events[0]["message"]["content"][0]["type"], "tool_use");
    assert_eq!(call_events[0]["message"]["content"][0]["id"], "tc-1");
    assert_eq!(
        call_events[0]["message"]["content"][0]["name"],
        "run_command"
    );

    let result_events = projector
        .project_notification(&session_update(json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-1",
            "name": "run_command",
            "status": "completed",
            "rawOutput": {"output": "failed output", "exit_code": 2},
        })))
        .unwrap();
    assert_eq!(result_events.len(), 1);
    assert_eq!(result_events[0]["type"], "user");
    let block = &result_events[0]["message"]["content"][0];
    assert_eq!(block["type"], "tool_result");
    assert_eq!(block["tool_use_id"], "tc-1");
    assert_eq!(block["content"], "failed output");
    assert_eq!(block["is_error"], true);
}

#[test]
fn usage_accumulates_across_steered_prompt_responses() {
    let mut totals = UsageTotals::default();
    totals.accumulate(&json!({
        "inputTokens": 100,
        "outputTokens": 20,
        "thoughtTokens": 5,
        "cachedReadTokens": 50,
        "totalTokens": 125,
    }));
    totals.accumulate(&json!({
        "inputTokens": 200,
        "outputTokens": 30,
        "thoughtTokens": 10,
        "cachedReadTokens": 60,
        "totalTokens": 240,
    }));
    let usage = totals.to_json().unwrap();
    assert_eq!(usage["input_tokens"], 300);
    assert_eq!(usage["output_tokens"], 50);
    assert_eq!(usage["thinking_tokens"], 15);
    assert_eq!(usage["cache_read_tokens"], 110);
    assert_eq!(usage["total_tokens"], 365);
}

#[test]
fn rpc_error_classification_maps_auth_and_rate_limit() {
    let masker = crate::masker::SecretMasker::from_raw("");
    let mut projector = EventProjector::new(MODEL, None, &masker);
    let (events, diag) = projector.finish_rpc_error(&JsonRpcError {
        code: -32000,
        message: "Authentication required".into(),
        data: None,
    });
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "result");
    assert_eq!(events[0]["subtype"], "error");
    assert_eq!(diag.failure_reason, Some(FailureReason::InvalidCredentials));

    let (_events, rate_diag) = projector.finish_rpc_error(&JsonRpcError {
        code: -32000,
        message: "RESOURCE_EXHAUSTED: quota".into(),
        data: None,
    });
    assert_eq!(
        rate_diag.failure_reason,
        Some(FailureReason::ProviderRateLimited)
    );
}

#[tokio::test]
async fn stdout_eof_before_process_exit_preserves_nonzero_exit_code() {
    let mut client = super::acp::AntigravityAcpClient::spawn(super::acp::AntigravityAcpConfig {
        binary: std::path::PathBuf::from("/bin/sh"),
        args: vec![
            "-c".into(),
            // Close stdout before exiting to deterministically reproduce the
            // EOF-before-zombie race on Linux.
            "exec 1>&-; sleep 0.05; exit 23".into(),
        ],
        child_env_values: Vec::new(),
        current_dir: std::env::temp_dir(),
        workload_containment: None,
    })
    .expect("spawn sh child");

    let err = client
        .next_incoming("nonzero exit test")
        .await
        .expect_err("expected child exit error");
    match err {
        super::acp::AntigravityAcpError::ChildExited { status, .. } => {
            assert_eq!(status.code(), Some(23));
        }
        other => panic!("expected ChildExited(23), got {other:?}"),
    }
    client.terminate().await.expect("terminate after exit");
}
