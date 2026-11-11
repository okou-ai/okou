use std::future::Future;
use std::process::Stdio;
use std::time::Duration;

use httpmock::prelude::*;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use crate::http::HttpClient;

use super::*;

#[test]
fn model_failure_reason_requires_valid_runtime_evidence() {
    let message = json!({
        "role": "assistant", "api": "openai-codex-responses", "stopReason": "error",
        "errorMessage": "private provider detail",
        "diagnostics": [{"type": "okou_model_request", "details": {
            "httpStatus": 429, "transportAttempts": 1, "failureReason": "provider_rate_limited"
        }}]
    });
    assert_eq!(
        PiAssistantTerminal::from_message(&message).failure_reason,
        Some(guest_contracts::diagnostics::FailureReason::ProviderRateLimited)
    );
    for (path, value) in [
        ("/api", json!("unrelated-api")),
        ("/stopReason", json!("stop")),
        ("/stopReason", json!("aborted")),
        ("/diagnostics/0/type", json!("provider_diagnostic")),
        ("/diagnostics/0/details/httpStatus", json!(999)),
        ("/diagnostics/0/details/transportAttempts", json!(-1)),
        (
            "/diagnostics/0/details/failureReason",
            json!("private-token"),
        ),
    ] {
        let mut invalid = message.clone();
        *invalid.pointer_mut(path).unwrap() = value;
        assert_eq!(
            PiAssistantTerminal::from_message(&invalid).failure_reason,
            None,
            "{path}"
        );
    }
}

#[test]
fn model_request_diagnostic_projects_chat_completions_messages() {
    for (status, attempts, reason) in [
        (
            503,
            2,
            guest_contracts::diagnostics::FailureReason::ProviderServerError,
        ),
        (
            404,
            1,
            guest_contracts::diagnostics::FailureReason::ProviderModelRestricted,
        ),
    ] {
        let message = json!({
            "role": "assistant", "api": "openai-completions", "stopReason": "error",
            "errorMessage": "private provider detail",
            "diagnostics": [{"type": "okou_model_request", "details": {
                "httpStatus": status, "transportAttempts": attempts, "failureReason": reason.as_str()
            }}]
        });
        let request = model_request_diagnostic(&message).expect("Chat Completions diagnostic");
        assert_eq!(request.http_status, Some(status));
        assert_eq!(request.transport_attempts, attempts);
        assert_eq!(
            PiAssistantTerminal::from_message(&message).failure_reason,
            Some(reason)
        );
    }
}

#[test]
fn model_request_evidence_tracks_completed_retries_and_clears_on_recovery() {
    let failed: Value = serde_json::from_str(include_str!(
        "../../../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-rate-limit.json"
    ))
    .expect("shared model boundary fixture");
    let failure = json!({"type": "message_end", "message": failed});
    let retry = json!({"type": "auto_retry_start", "attempt": 1, "maxAttempts": 2});
    let success = json!({"type": "message_end", "message": {
        "role": "assistant", "stopReason": "stop", "content": []
    }});
    for (records, expected) in [
        (
            vec![failure.clone()],
            json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0}),
        ),
        (
            vec![
                failure.clone(),
                retry.clone(),
                failure.clone(),
                json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                failure.clone(),
            ],
            json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 2, "retryLimit": 2}),
        ),
        // The SDK can drain a queued follow-up after exhausting the first
        // retry budget, without settling between the two request cycles.
        (
            vec![
                failure.clone(),
                retry.clone(),
                failure.clone(),
                json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                failure.clone(),
                json!({"type": "auto_retry_end", "success": false, "attempt": 2}),
                json!({"type": "message_end", "message": {"role": "user", "content": "next input"}}),
                failure.clone(),
                retry.clone(),
                failure.clone(),
                json!({"type": "auto_retry_start", "attempt": 2, "maxAttempts": 2}),
                failure.clone(),
                json!({"type": "auto_retry_end", "success": false, "attempt": 2}),
            ],
            json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 2, "retryLimit": 2}),
        ),
        // Scheduling a backoff that is then cancelled is not a completed retry.
        (
            vec![
                failure.clone(),
                retry.clone(),
                json!({"type": "auto_retry_end", "success": false, "attempt": 1, "finalError": "Retry cancelled"}),
            ],
            json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0, "retryLimit": 2}),
        ),
        (
            vec![
                failure.clone(),
                retry.clone(),
                success.clone(),
                failure.clone(),
            ],
            json!({"httpStatus": 429, "transportAttempts": 1, "retryAttempts": 0}),
        ),
        (vec![failure.clone(), retry, success], Value::Null),
    ] {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        for record in records {
            projection
                .project(record, &responses, 0)
                .expect("project native event");
        }
        let result = projection
            .project(json!({"type": "agent_settled"}), &responses, 0)
            .expect("settled result")
            .expect("terminal event");
        assert_eq!(result["modelRequest"], expected);
        assert_eq!(result["is_error"], !expected.is_null());
    }
}

#[test]
fn opaque_codex_bad_request_preserves_original_error_and_failed_outcome() {
    let error = r#"{"detail":"Bad Request"}"#;
    let failure = json!({"type": "message_end", "message": {
        "role": "assistant", "api": "openai-codex-responses", "stopReason": "error",
        "errorMessage": error,
        "diagnostics": [{"type": "okou_model_request", "details": {
            "httpStatus": 400, "transportAttempts": 1, "failureReason": "provider_bad_request"
        }}]
    }});
    let (responses, _rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    projection.project(failure, &responses, 0).unwrap();
    let result = projection
        .project(json!({"type": "agent_settled"}), &responses, 0)
        .unwrap()
        .expect("terminal failed result");

    assert_eq!(result["is_error"], true);
    assert_eq!(result["result"], error);
    assert_eq!(result["failureReason"], "provider_bad_request");
    assert_eq!(result["modelRequest"]["httpStatus"], 400);
    assert_eq!(result["modelRequest"]["transportAttempts"], 1);
    assert_eq!(result["modelRequest"]["retryAttempts"], 0);
}

#[test]
fn semantic_http_success_keeps_failed_reason_and_observed_retries() {
    let processing_failure: Value = serde_json::from_str(include_str!(
            "../../../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-request-processing-error.json"
        ))
        .expect("shared request-processing failure fixture");
    for (message, reason, retries) in [
        (
            processing_failure["errorMessage"]
                .as_str()
                .expect("request-processing failure text"),
            "provider_server_error",
            3,
        ),
        (
            "Codex error: Our servers are currently overloaded. Please try again later.",
            "provider_overloaded",
            3,
        ),
        (
            "Codex error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://example.invalid/policy",
            "safety_policy_refusal",
            0,
        ),
    ] {
        let failure = json!({"type": "message_end", "message": {
            "role": "assistant", "api": "openai-codex-responses", "stopReason": "error",
            "errorMessage": message,
            "diagnostics": [{"type": "okou_model_request", "details": {
                "httpStatus": 200, "transportAttempts": 1, "failureReason": reason
            }}]
        }});
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        projection.project(failure.clone(), &responses, 0).unwrap();
        for attempt in 1..=retries {
            projection
                .project(
                    json!({"type": "auto_retry_start", "attempt": attempt, "maxAttempts": 3}),
                    &responses,
                    0,
                )
                .unwrap();
            projection.project(failure.clone(), &responses, 0).unwrap();
        }
        let result = projection
            .project(json!({"type": "agent_settled"}), &responses, 0)
            .unwrap()
            .unwrap();
        assert_eq!(result["is_error"], true);
        assert_eq!(result["failureReason"], reason);
        assert_eq!(result["modelRequest"]["httpStatus"], 200);
        assert_eq!(result["modelRequest"]["transportAttempts"], 1);
        assert_eq!(result["modelRequest"]["retryAttempts"], retries);
        assert_eq!(
            result["modelRequest"]["retryLimit"],
            if retries == 0 { Value::Null } else { json!(3) }
        );
    }
}

#[test]
fn model_request_evidence_is_only_accepted_from_valid_failed_assistant_messages() {
    let failed: Value = serde_json::from_str(include_str!(
        "../../../../../../turbo/packages/pi-agent-runtime/src/test/fixtures/codex-rate-limit.json"
    ))
    .expect("shared model boundary fixture");
    let mut aborted = failed.clone();
    aborted["stopReason"] = json!("aborted");
    let mut wrong_api = failed.clone();
    wrong_api["api"] = json!("unrelated");
    let mut malformed = failed.clone();
    malformed["diagnostics"][0]["details"]["httpStatus"] = json!("429");
    let mut unknown = failed;
    unknown["diagnostics"][0]["type"] = json!("provider-authored-text");
    let tool = json!({
        "role": "toolResult", "toolCallId": "call", "isError": true,
        "content": [{"type": "text", "text": "{\"detail\":\"Rate limit exceeded\"}"}],
        "diagnostics": [{"type": "okou_model_request", "details": {"httpStatus": 429, "transportAttempts": 1}}],
    });
    for message in [aborted, wrong_api, malformed, unknown, tool] {
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new("run", "session");
        projection
            .project(
                json!({"type": "message_end", "message": message}),
                &responses,
                0,
            )
            .expect("project native message");
        let result = projection
            .project(json!({"type": "agent_settled"}), &responses, 0)
            .expect("settled result")
            .expect("terminal event");
        assert!(result.get("modelRequest").is_none());
    }
}

#[test]
fn projection_matches_shared_public_event_fixtures() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../fixtures/pi-public-events.json"
    ))
    .expect("shared public event fixture must parse");
    for case in fixture["cases"].as_array().expect("fixture cases") {
        let name = case["name"].as_str().expect("case name");
        let (responses, _rx) = response_channel();
        let mut projection = PiRpcProjection::new(
            fixture["runId"].as_str().expect("run id"),
            fixture["sessionId"].as_str().expect("session id"),
        );
        let projected = projection
            .project(
                json!({ "type": "message_end", "message": case["guestMessage"] }),
                &responses,
                0,
            )
            .expect("official assistant should project");
        let events: Vec<Value> = projected
            .into_iter()
            .flat_map(|event| {
                super::super::provider_event_normalization::normalize_for_sequencing(
                    crate::env::Framework::Pi,
                    event,
                )
            })
            .collect();
        let messages: Vec<&Value> = events.iter().map(|event| &event["message"]).collect();
        assert_eq!(json!(messages), case["expectedMessages"], "{name}");
        // Guest sequencing belongs to the startup boundary and ingestor. Projection does not invent the API's zero-based index.
        for event in events {
            assert_eq!(event["type"], "assistant", "{name}");
            assert!(event.get("sequenceNumber").is_none(), "{name}");
            assert!(event.get("duration_ms").is_none(), "{name}");
        }
        assert!(
            projection
                .project(json!({ "type": "agent_end" }), &responses, 0)
                .expect("agent_end is not terminal")
                .is_none(),
            "{name}"
        );
        let terminal = projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("agent_settled should project")
            .expect("only agent_settled owns the terminal result");
        assert_eq!(terminal["type"], "result", "{name}");
        assert_eq!(terminal["subtype"], "success", "{name}");
        assert_eq!(terminal["is_error"], false, "{name}");
        assert_eq!(terminal["result"], case["guestResult"], "{name}");
        assert_eq!(terminal["session_id"], fixture["sessionId"], "{name}");
        assert!(terminal["duration_ms"].as_u64().is_some(), "{name}");
    }
}

#[test]
fn streaming_uses_native_content_indices_and_reconciles_each_response() {
    let (output, mut output_rx) = super::super::pi_session_output::test_channel(32, "run-id");
    let (responses, _responses_rx) = response_channel();
    let masker = SecretMasker::from_raw("");
    let mut projection =
        PiRpcProjection::new("run-id", "thread-id").with_session_output(output, &masker);

    assert!(
        projection
            .project(
                json!({
                    "type": "message_start",
                    "message": { "role": "assistant", "content": [] }
                }),
                &responses,
                0,
            )
            .expect("message start")
            .is_none()
    );
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_start",
                    "contentIndex": 0
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("first text start");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "  Alpha"
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("first text delta should stream");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": " one"
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("next text delta should stream");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_start",
                    "contentIndex": 2
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("empty provider text start");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 2,
                    "delta": "Third"
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("second text block should stream");

    let first = projection
        .project(
            json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "  Alpha one" },
                        { "type": "toolCall", "id": "call-1", "name": "read", "arguments": {} },
                        { "type": "text", "text": "Third" }
                    ],
                    "model": "model",
                    "timestamp": 1,
                    "usage": {},
                    "stopReason": "toolUse"
                }
            }),
            &responses,
            0,
        )
        .expect("first response should project")
        .expect("first response event");
    let first_events = super::super::provider_event_normalization::normalize_for_sequencing(
        crate::env::Framework::Pi,
        first,
    );
    assert_eq!(first_events.len(), 3);
    let first_id = first_events[0]["runEventId"]
        .as_str()
        .expect("first text run event id");
    let third_id = first_events[2]["runEventId"]
        .as_str()
        .expect("third text run event id");
    assert!(first_id.ends_with(":0"));
    assert!(third_id.ends_with(":2"));
    assert_eq!(
        first_events[0]["message"]["content"][0]["text"],
        "Alpha one"
    );
    assert_eq!(first_events[2]["message"]["content"][0]["text"], "Third");
    assert!(first_events[1].get("runEventId").is_none());

    let mut first_chunks = Vec::new();
    while let Ok(chunk) = output_rx.try_recv() {
        first_chunks.push(chunk);
    }
    assert_eq!(first_chunks.len(), 3);
    assert_eq!(first_chunks[0].run_event_id, first_id);
    assert_eq!(first_chunks[0].delta, "Alpha");
    assert_eq!(first_chunks[1].run_event_id, first_id);
    assert_eq!(first_chunks[1].delta, " one");
    assert_eq!(first_chunks[2].run_event_id, third_id);
    assert_eq!(first_chunks[2].delta, "Third");

    projection
        .project(
            json!({
                "type": "message_start",
                "message": { "role": "assistant", "content": [] }
            }),
            &responses,
            0,
        )
        .expect("second response start");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": "Beta"
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("second response delta");
    let second = projection
        .project(
            json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Beta" }],
                    "model": "model",
                    "timestamp": 2,
                    "usage": {},
                    "stopReason": "stop"
                }
            }),
            &responses,
            0,
        )
        .expect("second response should project")
        .expect("second response event");
    let second_events = super::super::provider_event_normalization::normalize_for_sequencing(
        crate::env::Framework::Pi,
        second,
    );
    let second_id = second_events[0]["runEventId"]
        .as_str()
        .expect("second response run event id");
    assert!(second_id.ends_with(":0"));
    assert_ne!(second_id, first_id);
    let second_chunk = output_rx.try_recv().expect("second response chunk");
    assert_eq!(second_chunk.run_event_id, second_id);
    assert_eq!(second_chunk.delta, "Beta");
}

#[test]
fn streaming_overflow_preserves_the_authoritative_message_and_result() {
    let (output, _output_rx) = super::super::pi_session_output::test_channel(1, "run-id");
    let (responses, _responses_rx) = response_channel();
    let masker = SecretMasker::from_raw("");
    let mut projection =
        PiRpcProjection::new("run-id", "thread-id").with_session_output(output, &masker);

    projection
        .project(
            json!({
                "type": "message_start",
                "message": { "role": "assistant", "content": [] }
            }),
            &responses,
            0,
        )
        .expect("message start");
    for delta in ["first", " second"] {
        projection
            .project(
                json!({
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "text_delta",
                        "contentIndex": 0,
                        "delta": delta
                    },
                    "usage": {}
                }),
                &responses,
                0,
            )
            .expect("queue pressure must not fail projection");
    }
    let assistant = projection
        .project(
            json!({
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "first second" }],
                    "model": "model",
                    "timestamp": 1,
                    "usage": {},
                    "stopReason": "stop"
                }
            }),
            &responses,
            0,
        )
        .expect("authoritative message must project")
        .expect("authoritative message event");
    assert_eq!(assistant["message"]["content"][0]["text"], "first second");
    assert!(assistant["message"]["content"][0]["runEventId"].is_string());

    let result = projection
        .project(json!({ "type": "agent_settled" }), &responses, 0)
        .expect("settlement must project")
        .expect("settlement event");
    assert_eq!(result["subtype"], "success");
    assert_eq!(result["result"], "first second");
}

#[test]
fn streaming_splits_utf8_deltas_at_the_request_byte_bound() {
    let (output, mut output_rx) = super::super::pi_session_output::test_channel(8, "run-id");
    let (responses, _responses_rx) = response_channel();
    let masker = SecretMasker::from_raw("");
    let mut projection =
        PiRpcProjection::new("run-id", "thread-id").with_session_output(output, &masker);
    let text = "é".repeat(3000);

    projection
        .project(
            json!({
                "type": "message_start",
                "message": { "role": "assistant", "content": [] }
            }),
            &responses,
            0,
        )
        .expect("message start");
    projection
        .project(
            json!({
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": 0,
                    "delta": text
                },
                "usage": {}
            }),
            &responses,
            0,
        )
        .expect("large delta");

    let first = output_rx.try_recv().expect("first bounded chunk");
    let second = output_rx.try_recv().expect("second bounded chunk");
    assert!(first.delta.len() <= SESSION_OUTPUT_DELTA_MAX_BYTES);
    assert!(second.delta.len() <= SESSION_OUTPUT_DELTA_MAX_BYTES);
    assert_eq!(format!("{}{}", first.delta, second.delta), "é".repeat(3000));
}

#[test]
fn streaming_extension_failure_does_not_flush_a_pending_secret_tail() {
    use base64::Engine;

    let secret = "audit-secret-12345";
    let masker = SecretMasker::from_raw(&base64::engine::general_purpose::STANDARD.encode(secret));
    let (output, mut output_rx) = super::super::pi_session_output::test_channel(8, "run-id");
    let (responses, _responses_rx) = response_channel();
    let mut projection =
        PiRpcProjection::new("run-id", "thread-id").with_session_output(output, &masker);
    projection
        .project(
            json!({"type":"message_start","message":{"role":"assistant"}}),
            &responses,
            0,
        )
        .expect("message start");
    projection
        .project(
            json!({"type":"message_update","assistantMessageEvent":{
                "type":"text_delta","contentIndex":0,
                "delta":format!("{} audit-sec", "ordinary ".repeat(10))
            }}),
            &responses,
            0,
        )
        .expect("partial secret update");
    let published = output_rx.try_recv().expect("ordinary text should stream");
    assert!(!published.delta.contains("audit"));
    assert!(
        projection
            .project(
                json!({"type":"extension_error","error":"synthetic failure"}),
                &responses,
                0
            )
            .is_err()
    );
    assert!(
        projection
            .project(
                json!({"type":"message_end","message":{
                    "role":"assistant","content":[{"type":"text","text":secret}]
                }}),
                &responses,
                0,
            )
            .expect("discard post-failure completion")
            .is_none()
    );
    drop(projection);
    assert!(output_rx.try_recv().is_err());
}

async fn next_command(
    writer: &mut (impl Future<Output = Result<(), AgentError>> + Unpin),
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Value {
    let mut line = String::new();
    tokio::select! {
        biased;
        result = writer => panic!("writer ended before the next command: {result:?}"),
        result = reader.read_line(&mut line) => {
            assert!(result.expect("mock Pi stdout should be readable") > 0);
        }
    }
    serde_json::from_str(&line).expect("Pi command should be JSON")
}

#[test]
fn first_official_record_starts_the_run_and_is_projected() {
    let mut boundary = PiRpcStartupBoundary::default();
    assert!(boundary.requires_boundary());

    assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Start));
    assert!(!boundary.requires_boundary());
    assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Project));

    boundary.discard_remaining();
    assert!(matches!(boundary.admit(), PiRpcRecordAdmission::Discard));
}

#[test]
fn only_records_the_projection_ignores_are_discardable_when_oversized() {
    assert!(oversized_record_is_discardable("agent_end"));
    assert!(oversized_record_is_discardable("turn_end"));

    // Every record that owns public output, drives the startup boundary or
    // reports a failure must stay fatal when oversized: discarding one
    // would silently drop a structured record instead of failing loudly.
    for owned in [
        "message_end",
        "message_start",
        "message_update",
        "agent_settled",
        "response",
        "extension_error",
        "auto_retry_start",
        "auto_retry_end",
        "unknown",
        "other",
        "tool_execution_end",
        "",
    ] {
        assert!(
            !oversized_record_is_discardable(owned),
            "{owned} must not be discardable"
        );
    }
}

#[test]
fn projection_uses_agent_settled_as_the_terminal_event() {
    let (responses, _rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    assert!(
        projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "done" }],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "stop",
                    }
                }),
                &responses,
                0,
            )
            .expect("message should project")
            .is_some()
    );
    assert!(
        projection
            .project(
                json!({ "type": "agent_end", "messages": [] }),
                &responses,
                0,
            )
            .expect("agent_end should be ignored")
            .is_none()
    );
    assert!(
        projection
            .project(
                json!({ "type": "turn_end", "message": {}, "toolResults": [] }),
                &responses,
                0,
            )
            .expect("turn_end should be ignored")
            .is_none()
    );
    let result = projection
        .project(json!({ "type": "agent_settled" }), &responses, 0)
        .expect("agent_settled should project")
        .expect("agent_settled should emit result");
    assert_eq!(result["type"], "result");
    assert_eq!(result["result"], "done");
}

#[test]
fn projection_moves_large_tool_payload_allocations() {
    const LARGE_PAYLOAD_BYTES: usize = 1024 * 1024;

    let (responses, _rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    let tool_call = json!({
        "type": "message_end",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "toolCall",
                "id": "tool-1",
                "name": "large_tool",
                "arguments": {
                    "payload": "a".repeat(LARGE_PAYLOAD_BYTES),
                },
            }],
            "model": "model",
            "timestamp": 1,
            "usage": {},
            "stopReason": "toolUse",
        },
    });
    let argument = tool_call
        .pointer("/message/content/0/arguments/payload")
        .and_then(Value::as_str)
        .expect("tool-call argument should be a string");
    let argument_ptr = argument.as_ptr();

    let tool_call = projection
        .project(tool_call, &responses, 0)
        .expect("tool call should project")
        .expect("tool call should emit an event");
    let projected_argument = tool_call
        .pointer("/message/content/0/input/payload")
        .and_then(Value::as_str)
        .expect("projected tool-call argument should be a string");
    assert_eq!(projected_argument.len(), LARGE_PAYLOAD_BYTES);
    assert!(std::ptr::eq(projected_argument.as_ptr(), argument_ptr));

    let tool_result = json!({
        "type": "message_end",
        "message": {
            "role": "toolResult",
            "toolCallId": "tool-1",
            "content": [
                {
                    "type": "text",
                    "text": "t".repeat(LARGE_PAYLOAD_BYTES),
                },
                {
                    "type": "image",
                    "mimeType": "image/png",
                    "data": "i".repeat(LARGE_PAYLOAD_BYTES),
                },
            ],
            "isError": false,
        },
    });
    let text = tool_result
        .pointer("/message/content/0/text")
        .and_then(Value::as_str)
        .expect("tool-result text should be a string");
    let text_ptr = text.as_ptr();
    let image_data = tool_result
        .pointer("/message/content/1/data")
        .and_then(Value::as_str)
        .expect("tool-result image data should be a string");
    let image_data_ptr = image_data.as_ptr();

    let tool_result = projection
        .project(tool_result, &responses, 0)
        .expect("tool result should project")
        .expect("tool result should emit an event");
    let projected_text = tool_result
        .pointer("/message/content/0/content/0/text")
        .and_then(Value::as_str)
        .expect("projected tool-result text should be a string");
    assert_eq!(projected_text.len(), LARGE_PAYLOAD_BYTES);
    assert!(std::ptr::eq(projected_text.as_ptr(), text_ptr));
    let projected_image_data = tool_result
        .pointer("/message/content/0/content/1/source/data")
        .and_then(Value::as_str)
        .expect("projected tool-result image data should be a string");
    assert_eq!(projected_image_data.len(), LARGE_PAYLOAD_BYTES);
    assert!(std::ptr::eq(projected_image_data.as_ptr(), image_data_ptr));
}

#[test]
fn failed_tools_and_independent_quota_failure_reach_a_terminal_error() {
    let (responses, _rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    let tool = projection
        .project(
            json!({
                "type": "message_end", "message": {
                    "role": "toolResult", "timestamp": 20, "toolCallId": "tool-1",
                    "content": [{"type": "text", "text": "tool killed"}], "isError": true
                }
            }),
            &responses,
            0,
        )
        .unwrap()
        .unwrap();
    assert_eq!(tool["message"]["content"][0]["is_error"], true);
    assert!(
        projection
            .project(
                json!({
                    "type": "message_end", "message": {"role": "toolResult", "timestamp": 30}
                }),
                &responses,
                0
            )
            .is_err()
    );
    projection
        .project(
            json!({
                "type": "message_end", "message": {
                    "role": "assistant", "timestamp": 40, "content": [],
                    "stopReason": "error", "errorMessage": "ChatGPT Pro quota exhausted"
                }
            }),
            &responses,
            0,
        )
        .unwrap();
    let terminal = projection
        .project(json!({"type": "agent_settled"}), &responses, 0)
        .unwrap()
        .unwrap();
    assert_eq!(terminal["is_error"], true);
    assert_eq!(terminal["subtype"], "error_during_execution");
}

#[test]
fn projection_validates_get_state_session_identity() {
    let (responses, mut rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    let event = projection
            .project(
                json!({
                    "id": "state",
                    "type": "response",
                    "command": "get_state",
                    "success": true,
                    "data": {
                        "sessionId": "session",
                        "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                    },
                }),
                &responses,
                1,
            )
            .expect("state should project")
            .expect("state should emit init");
    assert_eq!(event["session_id"], "session");
    assert_eq!(
        event["session_file"],
        "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl"
    );
    assert_eq!(
        rx.try_recv().expect("response should be routed").value["id"],
        "state"
    );
}

#[test]
fn projection_discards_buffered_records_after_extension_failure() {
    let (responses, _rx) = response_channel();
    let mut projection = PiRpcProjection::new("run", "session");
    let error = projection
        .project(
            json!({
                "type": "extension_error",
                "event": "message_end",
                "error": "forced extension failure",
            }),
            &responses,
            0,
        )
        .expect_err("native history validation failure should terminate projection");
    assert!(error.to_string().contains("forced extension failure"));

    assert!(
        projection
            .project(
                json!({
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "must not project" }],
                        "model": "model",
                        "timestamp": 1,
                        "usage": {},
                        "stopReason": "stop",
                    }
                }),
                &responses,
                0,
            )
            .expect("buffered message should be discarded")
            .is_none()
    );
    assert!(
        projection
            .project(json!({ "type": "agent_settled" }), &responses, 0)
            .expect("buffered terminal event should be discarded")
            .is_none()
    );
}

#[tokio::test]
async fn writer_requires_startup_boundary_before_prompt() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut child = tokio::process::Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("cat should spawn");
        let stdin = child.stdin.take().expect("cat stdin should exist");
        let mut stdout = BufReader::new(child.stdout.take().expect("cat stdout should exist"));
        let (response_tx, response_rx) = response_channel();
        let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
        let writer = write_commands(
            stdin,
            "run",
            "initial prompt",
            ActiveInputRuntime::new_disabled("run", "initial prompt").into_writer(),
            response_rx,
            startup_rx,
            CancellationToken::new(),
        );
        tokio::pin!(writer);
        let state = next_command(&mut writer, &mut stdout).await;
        assert_eq!(state["type"], "get_state");
        response_tx
            .try_send(
                json!({
                    "id": state["id"],
                    "type": "response",
                    "command": "get_state",
                    "success": true,
                }),
                1,
            )
            .expect("state response should route");
        drop(startup_tx);
        let error = writer
            .await
            .expect_err("a missing startup boundary must fail");
        assert!(
            error
                .to_string()
                .contains("startup boundary closed before it was installed")
        );
        let mut unexpected = String::new();
        assert_eq!(
            stdout.read_line(&mut unexpected).await.expect("cat stdout"),
            0,
            "no prompt may be written without the startup boundary: {unexpected}"
        );
        assert!(child.wait().await.expect("cat should exit").success());
    })
    .await
    .expect("missing startup boundary should fail promptly");
}

#[tokio::test]
async fn writer_declares_active_input_only_after_successful_steer_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::Accepted),
    )
    .await
    .expect("successful steer should finish promptly");
}

#[tokio::test]
async fn writer_rejects_active_input_after_failed_steer_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::Rejected),
    )
    .await
    .expect("rejected steer should finish promptly");
}

#[tokio::test]
async fn settlement_closes_stdin_before_writer_consumes_steer_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::SettledBeforeWriter),
    )
    .await
    .expect("settlement should close stdin without waiting for writer scheduling");
}

#[tokio::test]
async fn settlement_closes_stdin_after_writer_consumes_steer_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::SettledAfterWriter),
    )
    .await
    .expect("settlement should close stdin after writer consumption");
}

#[tokio::test]
async fn settlement_preserves_queued_input_after_observed_steer_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::QueuedFollowUp),
    )
    .await
    .expect("queued follow-up should reach its own settlement");
}

#[tokio::test]
async fn old_settlement_does_not_close_input_accepted_before_late_ack() {
    tokio::time::timeout(
        Duration::from_secs(5),
        assert_steer_ack_outcome(SteerAckCase::InputAfterSettlement),
    )
    .await
    .expect("a later input must outlive the old settlement");
}

#[derive(Clone, Copy)]
enum SteerAckCase {
    Accepted,
    Rejected,
    SettledBeforeWriter,
    SettledAfterWriter,
    QueuedFollowUp,
    InputAfterSettlement,
}

fn project_settlement(projection: &mut PiRpcProjection<'_>, responses: &PiRpcResponseSender) {
    let result = projection
        .project(json!({"type": "agent_settled"}), responses, 0)
        .expect("settlement should project")
        .expect("settlement should emit a terminal result");
    assert_eq!(result["type"], "result");
    assert_eq!(result["subtype"], "success");
}

async fn assert_steer_ack_outcome(case: SteerAckCase) {
    let success = !matches!(case, SteerAckCase::Rejected);
    let has_follow_up = matches!(
        case,
        SteerAckCase::QueuedFollowUp | SteerAckCase::InputAfterSettlement
    );
    let server = MockServer::start();
    let event_id = "11111111-1111-4111-8111-111111111111";
    let follow_up_id = "22222222-2222-4222-8222-222222222222";
    let steered = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/run/steerable-inputs/{event_id}/steered"
            ))
            .header("Authorization", "Bearer test-token")
            .header("Content-Type", "application/json")
            .json_body(json!({}));
        then.status(200).json_body(json!({"outcome": "steered"}));
    });
    let follow_up_steered = server.mock(|when, then| {
        when.method(POST)
            .path(format!(
                "/api/runners/runs/run/steerable-inputs/{follow_up_id}/steered"
            ))
            .json_body(json!({}));
        then.status(200).json_body(json!({"outcome": "steered"}));
    });
    let mut child = tokio::process::Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("cat should spawn");
    let stdin = child.stdin.take().expect("cat stdin should exist");
    let stdout = child.stdout.take().expect("cat stdout should exist");
    let mut stdout = BufReader::new(stdout);
    let http =
        HttpClient::with_api_config(server.base_url(), "test-token", "", "run", Duration::ZERO)
            .expect("declaration HTTP client should build");
    let active_input = ActiveInputRuntime::new_enabled("run", "initial prompt", http);
    let controller = active_input.controller();
    let mut projection =
        PiRpcProjection::new("run", "session").with_active_input(controller.clone());
    let payload = guest_contracts::active_input::encode_active_input(event_id, "steer this turn")
        .expect("active input should encode");
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );
    let (response_tx, response_rx) = response_channel();
    let (startup_tx, startup_rx) = tokio::sync::oneshot::channel();
    let writer = write_commands(
        stdin,
        "run",
        "initial prompt",
        active_input.into_writer(),
        response_rx,
        startup_rx,
        CancellationToken::new(),
    );
    tokio::pin!(writer);

    let state = next_command(&mut writer, &mut stdout).await;
    assert_eq!(state["type"], "get_state");
    response_tx
            .try_send(json!({
                "id": state["id"],
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "session",
                    "sessionFile": "/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl",
                },
            }), 1)
            .expect("state response should route");
    assert!(
        futures_util::poll!(&mut writer).is_pending(),
        "initial prompt must wait for boundary installation"
    );
    startup_tx
        .send(())
        .expect("startup installation should route");

    let initial = next_command(&mut writer, &mut stdout).await;
    assert_eq!(initial["type"], "prompt");
    assert_eq!(initial["message"], "initial prompt");
    assert!(initial.get("streamingBehavior").is_none());
    response_tx
        .try_send(
            json!({
                "id": initial["id"],
                "type": "response",
                "command": "prompt",
                "success": true,
            }),
            1,
        )
        .expect("initial prompt response should route");

    let steer = next_command(&mut writer, &mut stdout).await;
    assert_eq!(steer["id"], event_id);
    assert_eq!(steer["type"], "steer");
    assert_eq!(steer["message"], "steer this turn");
    assert!(steer.get("streamingBehavior").is_none());

    if matches!(case, SteerAckCase::Accepted) {
        // Closing future input makes a writer that bypasses the ACK
        // finish on its next poll.
        controller.close_terminal();
    } else if matches!(case, SteerAckCase::InputAfterSettlement) {
        project_settlement(&mut projection, &response_tx);
        assert!(
            !controller.close_for_result_if_idle(),
            "an unread ACK cannot resolve the pending steer"
        );
    }
    assert!(
        futures_util::poll!(&mut writer).is_pending(),
        "a completed steer write must still wait for its ACK"
    );
    steered.assert_calls(0);

    let follow_up_payload =
        guest_contracts::active_input::encode_active_input(follow_up_id, "next turn")
            .expect("follow-up should encode");
    if has_follow_up {
        assert_eq!(
            controller.handle_control_payload(&follow_up_payload),
            ActiveInputControlOutcome::Accepted
        );
    }

    let rejection = "Agent is settling after cancellation";
    projection
        .project(
            json!({
                "id": event_id,
                "type": "response",
                "command": "steer",
                "success": success,
                "error": if success { Value::Null } else { json!(rejection) },
            }),
            &response_tx,
            1,
        )
        .expect("steer response should route");

    if matches!(case, SteerAckCase::Rejected) {
        project_settlement(&mut projection, &response_tx);
        assert!(
            !controller.close_for_result_if_idle(),
            "a failed ACK must not authorize post-result cleanup"
        );
    }
    if matches!(case, SteerAckCase::SettledAfterWriter) {
        assert!(
            futures_util::poll!(&mut writer).is_pending(),
            "the writer must stay open before settlement"
        );
    } else {
        steered.assert_calls(0);
    }
    if has_follow_up {
        if matches!(case, SteerAckCase::QueuedFollowUp) {
            project_settlement(&mut projection, &response_tx);
            assert!(
                !controller.close_for_result_if_idle(),
                "a queued follow-up must block the previous settlement"
            );
        }
        let follow_up = next_command(&mut writer, &mut stdout).await;
        assert_eq!(follow_up["id"], follow_up_id);
        assert_eq!(follow_up["type"], "steer");
        assert_eq!(follow_up["message"], "next turn");
        projection
            .project(
                json!({
                    "id": follow_up_id, "type": "response", "command": "steer", "success": true,
                }),
                &response_tx,
                1,
            )
            .expect("follow-up ACK should route");
        assert!(
            futures_util::poll!(&mut writer).is_pending(),
            "an old result must not close the later input after ACK consumption"
        );
    }
    if !matches!(case, SteerAckCase::Accepted | SteerAckCase::Rejected) {
        project_settlement(&mut projection, &response_tx);
        assert!(
            controller.close_for_result_if_idle(),
            "settlement must close input regardless of ACK consumption order"
        );
    }

    let result = writer.await;
    if success {
        result.expect("writer should succeed after the matching steer ACK");
    } else {
        let error = result.expect_err("a rejected steer must fail the writer");
        assert_eq!(
            error.to_string(),
            format!("execution: Pi RPC steer failed: {rejection}")
        );
    }
    controller
        .finalize_steered_declarations()
        .await
        .expect("steered declarations should finalize");
    steered.assert_calls(usize::from(success));
    follow_up_steered.assert_calls(usize::from(has_follow_up));
    if success {
        assert_eq!(
            controller.handle_control_payload(&payload),
            ActiveInputControlOutcome::Accepted,
            "an accepted delivery should remain idempotent after close"
        );
    } else {
        assert!(matches!(
            controller.handle_control_payload(&payload),
            ActiveInputControlOutcome::Rejected { diagnostic }
                if diagnostic == "active input delivery previously failed"
        ));
    }
    let mut trailing = String::new();
    assert_eq!(
        stdout.read_line(&mut trailing).await.expect("cat EOF"),
        0,
        "writer completion must close stdin: {trailing}"
    );
    assert!(child.wait().await.expect("cat should exit").success());
}
