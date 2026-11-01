use guest_contracts::diagnostics::FailureReason;
use serde_json::{Value, json};

use crate::events;
use crate::masker::SecretMasker;

use super::*;

fn notification(method: &str, params: Value) -> ServerNotification {
    ServerNotification {
        method: method.to_string(),
        params: Some(params),
    }
}

fn mapped_event(method: &str, params: Value) -> Value {
    notification_to_codex_event(&notification(method, params))
        .expect("notification should map")
        .expect("notification should produce an event")
}

fn completed_reasoning_params(item: Value) -> Value {
    json!({
        "threadId": "thread-1",
        "turnId": "turn-1",
        "completedAtMs": 42,
        "item": item
    })
}

fn completed_command_item() -> Value {
    json!({
        "type": "commandExecution",
        "id": "cmd-1",
        "command": "ls -la",
        "cwd": "/workspace",
        "processId": "proc-1",
        "source": "shell",
        "status": "completed",
        "commandActions": [],
        "aggregatedOutput": "README.md\n",
        "exitCode": 0,
        "durationMs": 123
    })
}

#[test]
fn thread_started_maps_to_top_level_thread_id() {
    let event = mapped_event(
        "thread/started",
        json!({"thread": {"id": "thread-1", "name": "demo"}}),
    );

    assert_eq!(
        event,
        json!({
            "type": "thread.started",
            "thread_id": "thread-1"
        })
    );
}

#[test]
fn turn_started_normalizes_in_progress_status() {
    let event = mapped_event(
        "turn/started",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "inProgress",
                "error": null,
                "startedAt": 10,
                "completedAt": null,
                "durationMs": null
            }
        }),
    );

    assert_eq!(event["type"], "turn.started");
    assert_eq!(event["thread_id"], "thread-1");
    assert_eq!(event["turn"]["id"], "turn-1");
    assert_eq!(event["turn"]["status"], "in_progress");
    assert_eq!(event["turn"]["started_at"], 10);
}

#[test]
fn turn_completed_does_not_read_non_contract_usage() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "error": null,
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            },
            "usage": {"input_tokens": 1}
        }),
    );

    assert_eq!(
        event,
        json!({
            "type": "turn.completed",
            "thread_id": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "error": null,
                "started_at": 10,
                "completed_at": 20,
                "duration_ms": 1000
            }
        })
    );
}

#[test]
fn token_usage_update_rejects_negative_count() {
    let error = codex_token_usage_update(&notification(
        "thread/tokenUsage/updated",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "tokenUsage": {
                "total": {
                    "inputTokens": -1,
                    "cachedInputTokens": 0,
                    "cacheWriteInputTokens": 0,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 0
                },
                "last": {
                    "inputTokens": 0,
                    "cachedInputTokens": 0,
                    "cacheWriteInputTokens": 0,
                    "outputTokens": 0,
                    "reasoningOutputTokens": 0,
                    "totalTokens": 0
                },
                "modelContextWindow": 258400
            }
        }),
    ))
    .expect_err("negative token usage should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "thread/tokenUsage/updated".to_string(),
            field: "tokenUsage.total"
        }
    );
}

#[test]
fn failed_turn_preserves_queue_expiry_over_generic_server_variants() {
    let queue_message = "We were unable to start processing your request within the 900-second timeout limit. Please try again later.";
    for (info, expected) in [
        (
            json!("serverOverloaded"),
            FailureReason::ProviderQueueTimeout,
        ),
        (
            json!("internalServerError"),
            FailureReason::ProviderQueueTimeout,
        ),
        (
            json!({"responseTooManyFailedAttempts": {"httpStatusCode": 503}}),
            FailureReason::ProviderQueueTimeout,
        ),
        (json!("unauthorized"), FailureReason::InvalidCredentials),
        (json!("usageLimitExceeded"), FailureReason::UsageLimit),
        (
            json!("rateLimitExceeded"),
            FailureReason::ProviderRateLimited,
        ),
        (
            json!("contextWindowExceeded"),
            FailureReason::ContextWindowExceeded,
        ),
        (json!("cyberPolicy"), FailureReason::SafetyPolicyRefusal),
    ] {
        let event = mapped_event(
            "turn/completed",
            json!({
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "status": "failed", "error": {
                    "message": queue_message, "codexErrorInfo": info
                }}
            }),
        );
        let diagnostic =
            events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("failed turn diagnostic");
        assert_eq!(diagnostic.failure_reason, Some(expected), "{info}");
    }
}

#[test]
fn failed_turn_completed_preserves_nested_error_for_diagnostics() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {
                    "message": "selected model is at capacity. please try a different model.",
                    "additionalDetails": "retry later",
                    "codexErrorInfo": "serverOverloaded"
                },
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(event["type"], "turn.completed");
    assert_eq!(event["turn"]["status"], "failed");
    assert_eq!(event["turn"]["error"]["additional_details"], "retry later");
    assert_eq!(
        event["turn"]["error"]["codex_error_info"],
        "serverOverloaded"
    );
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "selected model is at capacity. please try a different model. (retry later)"
                .to_string(),
            failure_reason: Some(FailureReason::ProviderOverloaded),
            evidence: None,
        })
    );
}

#[test]
fn failed_turn_completed_classifies_rate_limit_for_diagnostics() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {
                    "message": "Rate limit exceeded.",
                    "codexErrorInfo": "rateLimitExceeded"
                }
            }
        }),
    );

    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "Rate limit exceeded.".to_string(),
            failure_reason: Some(FailureReason::ProviderRateLimited),
            evidence: None,
        })
    );
}

#[test]
fn failed_turn_completed_preserves_cyber_policy_reason_for_diagnostics() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {
                    "message": "This request has been flagged for possible cybersecurity risk.",
                    "codexErrorInfo": "cyberPolicy"
                },
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(event["turn"]["error"]["codex_error_info"], "cyberPolicy");
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "This request has been flagged for possible cybersecurity risk.".to_string(),
            failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            evidence: None,
        })
    );
}

#[test]
fn failed_turn_completed_classifies_upstream_content_policy_rejection() {
    const ENVELOPE: &str = r#"{"error":{"message":"Content Exists Risk","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {"message": ENVELOPE},
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: ENVELOPE.to_string(),
            failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            evidence: None,
        })
    );
}

#[test]
fn failed_turn_completed_keeps_request_format_errors_unclassified() {
    const ENVELOPE: &str = r#"{"error":{"message":"Invalid Format","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}"#;
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {"message": ENVELOPE},
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: ENVELOPE.to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn failed_turn_completed_classifies_misalignment_policy_violation() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "failed",
                "error": {
                    "message": "This request violates the provider's alignment policy.",
                    "codexErrorInfo": "misalignmentPolicyViolation",
                    "misalignment": {
                        "errorType": "policy_violation",
                        "detailedExplanation": "Try a safer direction.",
                        "steer": {"message": "Continue with a safe alternative."}
                    }
                },
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(
        event["turn"]["error"]["codex_error_info"],
        "misalignmentPolicyViolation"
    );
    assert_eq!(
        event["turn"]["error"]["misalignment"],
        json!({
            "error_type": "policy_violation",
            "detailed_explanation": "Try a safer direction.",
            "steer": {"message": "Continue with a safe alternative."}
        })
    );
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "This request violates the provider's alignment policy.".to_string(),
            failure_reason: Some(FailureReason::SafetyPolicyRefusal),
            evidence: None,
        })
    );
}

#[test]
fn interrupted_turn_completed_stays_turn_completed() {
    let event = mapped_event(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "interrupted",
                "error": {"message": "turn interrupted"},
                "startedAt": 10,
                "completedAt": 20,
                "durationMs": 1000
            }
        }),
    );

    assert_eq!(event["type"], "turn.completed");
    assert_eq!(event["turn"]["status"], "interrupted");
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .map(|diagnostic| diagnostic.message),
        Some("turn interrupted".to_string())
    );
}

#[test]
fn turn_plan_updated_maps_steps() {
    let event = mapped_event(
        "turn/plan/updated",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "explanation": "working",
            "plan": [
                {"step": "read", "status": "completed"},
                {"step": "write", "status": "inProgress"},
                {"step": "test", "status": "pending"}
            ]
        }),
    );

    assert_eq!(
        event,
        json!({
            "type": "turn.plan.updated",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "explanation": "working",
            "plan": [
                {"step": "read", "status": "completed"},
                {"step": "write", "status": "in_progress"},
                {"step": "test", "status": "pending"}
            ]
        })
    );
}

#[test]
fn item_completed_agent_message_maps_to_existing_output_shape() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "agentMessage",
                "id": "item-1",
                "text": "hello",
                "phase": null
            }
        }),
    );

    assert_eq!(
        event,
        json!({
            "type": "item.completed",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "completed_at_ms": 42,
            "item": {
                "id": "item-1",
                "type": "agent_message",
                "text": "hello"
            }
        })
    );
}

#[test]
fn blank_agent_message_text_preserves_shape() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "agentMessage",
                "id": "item-1",
                "text": ""
            }
        }),
    );

    assert_eq!(event["item"]["type"], "agent_message");
    assert_eq!(event["item"]["text"], "");
}

#[test]
fn plan_item_completed_maps_text() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "plan",
                "id": "plan-1",
                "text": "1. inspect\n2. implement"
            }
        }),
    );

    assert_eq!(
        event["item"],
        json!({
            "id": "plan-1",
            "type": "plan",
            "text": "1. inspect\n2. implement"
        })
    );
}

#[test]
fn reasoning_joins_summary_and_content() {
    let event = mapped_event(
        "item/completed",
        completed_reasoning_params(json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": ["summary"],
                "content": ["detail one", "detail two"]
        })),
    );

    assert_eq!(event["item"]["type"], "reasoning");
    assert_eq!(event["item"]["text"], "summary\ndetail one\ndetail two");
}

#[test]
fn reasoning_omits_text_without_parts() {
    for item in [
        json!({
            "type": "reasoning",
            "id": "reason-1"
        }),
        json!({
            "type": "reasoning",
            "id": "reason-1",
            "summary": null,
            "content": null
        }),
        json!({
            "type": "reasoning",
            "id": "reason-1",
            "summary": [],
            "content": []
        }),
    ] {
        let event = mapped_event("item/completed", completed_reasoning_params(item));
        let item = event["item"]
            .as_object()
            .expect("mapped item should be an object");
        assert!(!item.contains_key("text"));
    }
}

#[test]
fn reasoning_preserves_empty_string_text_part() {
    let event = mapped_event(
        "item/completed",
        completed_reasoning_params(json!({
            "type": "reasoning",
            "id": "reason-1",
            "summary": [""]
        })),
    );

    let item = event["item"]
        .as_object()
        .expect("mapped item should be an object");
    assert_eq!(item.get("text").and_then(Value::as_str), Some(""));
}

#[test]
fn reasoning_preserves_newline_placement_for_empty_parts() {
    let event = mapped_event(
        "item/completed",
        completed_reasoning_params(json!({
            "type": "reasoning",
            "id": "reason-1",
            "summary": ["", "summary"],
            "content": [""]
        })),
    );

    assert_eq!(event["item"]["text"], "\nsummary\n");
}

#[test]
fn invalid_reasoning_text_fields_return_invalid_field() {
    for (item, field) in [
        (
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": "summary"
            }),
            "item.summary",
        ),
        (
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "content": "content"
            }),
            "item.content",
        ),
        (
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "summary": [1]
            }),
            "item.summary",
        ),
        (
            json!({
                "type": "reasoning",
                "id": "reason-1",
                "content": [1]
            }),
            "item.content",
        ),
    ] {
        let error = notification_to_codex_event(&notification(
            "item/completed",
            completed_reasoning_params(item),
        ))
        .expect_err("invalid reasoning text field should fail");

        assert_eq!(
            error,
            CodexAppServerEventError::InvalidField {
                method: "item/completed".to_string(),
                field,
            }
        );
    }
}

#[test]
fn command_execution_completed_maps_output_and_status() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": completed_command_item()
        }),
    );

    assert_eq!(
        event["item"],
        json!({
            "id": "cmd-1",
            "type": "command_execution",
            "command": "ls -la",
            "status": "completed",
            "cwd": "/workspace",
            "aggregated_output": "README.md\n",
            "exit_code": 0,
            "duration_ms": 123
        })
    );
}

#[test]
fn command_execution_started_maps_in_progress_tool_use_shape() {
    let mut item = completed_command_item();
    item["status"] = json!("inProgress");
    item["aggregatedOutput"] = Value::Null;
    item["exitCode"] = Value::Null;
    item["durationMs"] = Value::Null;

    let event = mapped_event(
        "item/started",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "startedAtMs": 42,
            "item": item
        }),
    );

    assert_eq!(event["type"], "item.started");
    assert_eq!(event["item"]["type"], "command_execution");
    assert_eq!(event["item"]["status"], "in_progress");
}

#[test]
fn file_change_completed_maps_changes() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "fileChange",
                "id": "file-1",
                "status": "completed",
                "changes": [
                    {
                        "path": "src/lib.rs",
                        "kind": {"type": "update", "move_path": null},
                        "diff": "@@"
                    },
                    {
                        "path": "src/new.rs",
                        "kind": {"type": "add"},
                        "diff": "+new"
                    }
                ]
            }
        }),
    );

    assert_eq!(
        event["item"],
        json!({
            "id": "file-1",
            "type": "file_change",
            "status": "completed",
            "changes": [
                {"path": "src/lib.rs", "kind": "modify", "diff": "@@"},
                {"path": "src/new.rs", "kind": "add", "diff": "+new"}
            ]
        })
    );
}

#[test]
fn unsupported_completed_item_maps_to_generic_item() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "mcpToolCall",
                "id": "mcp-1",
                "status": "completed",
                "server": "github",
                "tool": "listIssues",
                "durationMs": 50,
                "arguments": {"owner": "okou-ai", "nested": {"ignored": true}},
                "large": [1, 2, 3]
            }
        }),
    );

    assert_eq!(event["type"], "item.completed");
    assert_eq!(event["item"]["id"], "mcp-1");
    assert_eq!(event["item"]["type"], "mcp_tool_call");
    assert_eq!(event["item"]["status"], "completed");
    assert_eq!(event["item"]["duration_ms"], 50);
    assert_eq!(event["item"]["arguments"], json!({"owner": "okou-ai"}));
    assert_eq!(event["item"]["large"], json!([1, 2, 3]));
}

#[test]
fn function_call_output_preserves_structured_output() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "functionCallOutput",
                "id": "function-output-1",
                "name": "lookup",
                "namespace": "tools",
                "output": [
                    {"type": "input_text", "text": "result"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
                ]
            }
        }),
    );

    assert_eq!(
        event["item"],
        json!({
            "type": "function_call_output",
            "id": "function-output-1",
            "name": "lookup",
            "namespace": "tools",
            "output": [
                {"type": "input_text", "text": "result"},
                {"type": "input_image", "image_url": "data:image/png;base64,AA=="}
            ]
        })
    );
}

#[test]
fn generic_completed_item_keeps_only_bounded_shallow_values() {
    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {
                "type": "dynamicToolCall",
                "id": "tool-1",
                "status": "completed",
                "contentItems": [
                    "kept",
                    {"nested": "dropped"},
                    ["also", "dropped"],
                    7
                ],
                "arguments": {
                    "query": "kept",
                    "nested": {"ignored": true},
                    "items": ["ignored"]
                },
                "tooManyItems": [
                    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                    11, 12, 13, 14, 15, 16, 17
                ],
                "tooManyFields": {
                    "a": 1, "b": 2, "c": 3, "d": 4, "e": 5,
                    "f": 6, "g": 7, "h": 8, "i": 9, "j": 10,
                    "k": 11, "l": 12, "m": 13, "n": 14, "o": 15,
                    "p": 16, "q": 17, "r": 18, "s": 19, "t": 20,
                    "u": 21, "v": 22, "w": 23, "x": 24, "y": 25
                }
            }
        }),
    );

    assert_eq!(event["item"]["type"], "dynamic_tool_call");
    assert_eq!(event["item"]["content_items"], json!(["kept", 7]));
    assert_eq!(event["item"]["arguments"], json!({"query": "kept"}));
    assert!(event["item"].get("too_many_items").is_none());
    assert!(event["item"].get("too_many_fields").is_none());
}

#[test]
fn generic_completed_item_limits_top_level_fields_deterministically() {
    let mut item = Map::new();
    item.insert("id".to_string(), json!("tool-1"));
    item.insert("type".to_string(), json!("dynamicToolCall"));
    item.insert("status".to_string(), json!("completed"));
    item.insert("Id".to_string(), json!("shadow-id"));
    item.insert("Type".to_string(), json!("shadowType"));
    item.insert("Status".to_string(), json!("failed"));

    let unsupported_fields = (0..=MAX_GENERIC_OBJECT_FIELDS)
        .map(|index| (format!("nested{index:02}"), json!(index)))
        .collect();
    item.insert(
        "aaaUnsupported".to_string(),
        Value::Object(unsupported_fields),
    );
    for index in 0..MAX_GENERIC_OPTIONAL_FIELDS + 2 {
        item.insert(format!("field{index:02}"), json!(index));
    }

    let event = mapped_event(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": item
        }),
    );
    let normalized = event["item"]
        .as_object()
        .expect("mapped item should be an object");

    assert_eq!(normalized.len(), MAX_GENERIC_OPTIONAL_FIELDS + 3);
    assert_eq!(normalized["id"], "tool-1");
    assert_eq!(normalized["type"], "dynamic_tool_call");
    assert_eq!(normalized["status"], "completed");
    for index in 0..MAX_GENERIC_OPTIONAL_FIELDS {
        assert_eq!(normalized[&format!("field{index:02}")], index);
    }
    for index in MAX_GENERIC_OPTIONAL_FIELDS..MAX_GENERIC_OPTIONAL_FIELDS + 2 {
        assert!(!normalized.contains_key(&format!("field{index:02}")));
    }
    assert!(!normalized.contains_key("aaa_unsupported"));
}

#[test]
fn unsupported_started_item_is_ignored() {
    let result = notification_to_codex_event(&notification(
        "item/started",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "startedAtMs": 42,
            "item": {"type": "mcpToolCall", "id": "mcp-1"}
        }),
    ))
    .expect("unsupported started item should not error");

    assert_eq!(result, None);
}

#[test]
fn non_retryable_error_maps_to_diagnostic_compatible_error() {
    let event = mapped_event(
        "error",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "willRetry": false,
            "error": {
                "message": "usage limit exceeded",
                "additionalDetails": "upgrade required",
                "codexErrorInfo": "usageLimitExceeded"
            }
        }),
    );

    assert_eq!(event["type"], "error");
    assert_eq!(event["error"]["additional_details"], "upgrade required");
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(events::CodexFailureDiagnostic {
            event_type: "error",
            message: "usage limit exceeded (upgrade required)".to_string(),
            failure_reason: Some(FailureReason::UsageLimit),
            evidence: None,
        })
    );
}

#[test]
fn output_token_limit_is_classified_only_after_native_terminal_error() {
    for message in [
        "Incomplete response returned, reason: max_output_tokens",
        "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens",
    ] {
        for will_retry in [true, false] {
            let event = mapped_event(
                "error",
                json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "willRetry": will_retry,
                    "error": {
                        "message": message,
                        "codexErrorInfo": "other",
                        "additionalDetails": null
                    }
                }),
            );
            let diagnostic =
                events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""));
            if will_retry {
                assert_eq!(event["type"], "warning");
                assert_eq!(diagnostic, None);
            } else {
                assert_eq!(event["type"], "error");
                let diagnostic = diagnostic.expect("terminal error diagnostic");
                assert_eq!(diagnostic.message, message);
                assert_eq!(
                    diagnostic.failure_reason,
                    Some(FailureReason::OutputTokenLimit)
                );
            }
        }
    }
}

#[test]
fn retryable_error_maps_to_warning() {
    let event = mapped_event(
        "error",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "willRetry": true,
            "error": {"message": "temporarily unavailable"}
        }),
    );

    assert_eq!(event["type"], "warning");
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        None
    );
}

#[test]
fn warning_maps_to_non_failure_event() {
    let event = mapped_event(
        "warning",
        json!({
            "threadId": null,
            "message": "configuration warning"
        }),
    );

    assert_eq!(
        event,
        json!({
            "type": "warning",
            "message": "configuration warning"
        })
    );
    assert_eq!(
        events::masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        None
    );
}

#[test]
fn delta_and_progress_notifications_are_ignored() {
    for method in [
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/commandExecution/outputDelta",
        "item/fileChange/patchUpdated",
        "item/reasoning/textDelta",
        "item/mcpToolCall/progress",
    ] {
        let result = notification_to_codex_event(&notification(
            method,
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "partial"
            }),
        ))
        .expect("ignored notification should not error");
        assert_eq!(result, None, "method {method}");
    }
}

#[test]
fn output_item_start_selects_reasoning_and_agent_message_only() {
    for (item_type, expected_kind) in [
        ("reasoning", Some(CodexOutputItemKind::Reasoning)),
        ("agentMessage", Some(CodexOutputItemKind::AgentMessage)),
        ("commandExecution", None),
    ] {
        let start = codex_output_item_start(&notification(
            "item/started",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 1_700_000_000_123_u64,
                "item": {
                    "type": item_type
                }
            }),
        ))
        .expect("valid item start should parse");

        assert_eq!(start.map(|start| start.kind), expected_kind);
    }
}

#[test]
fn output_item_start_rejects_non_epoch_timestamp() {
    let error = codex_output_item_start(&notification(
        "item/started",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "startedAtMs": 42,
            "item": {
                "id": "item-1",
                "type": "agentMessage",
                "text": ""
            }
        }),
    ))
    .expect_err("non-epoch item start should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "item/started".to_string(),
            field: "startedAtMs",
        }
    );
}

#[test]
fn unknown_method_is_ignored() {
    let result = notification_to_codex_event(&notification(
        "thread/status/changed",
        json!({"threadId": "thread-1", "status": "running"}),
    ))
    .expect("unknown method should not error");

    assert_eq!(result, None);
}

#[test]
fn supported_method_without_params_returns_missing_params() {
    let error = notification_to_codex_event(&ServerNotification {
        method: "thread/started".to_string(),
        params: None,
    })
    .expect_err("missing params should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::MissingParams {
            method: "thread/started".to_string()
        }
    );
}

#[test]
fn missing_required_field_returns_missing_field() {
    let error = notification_to_codex_event(&notification("thread/started", json!({})))
        .expect_err("missing thread should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::MissingField {
            method: "thread/started".to_string(),
            field: "thread",
        }
    );
}

#[test]
fn invalid_required_field_type_returns_invalid_field() {
    let error = notification_to_codex_event(&notification(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": "later",
            "item": {"type": "agentMessage", "id": "item-1", "text": "hello"}
        }),
    ))
    .expect_err("wrong timestamp type should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "item/completed".to_string(),
            field: "completedAtMs",
        }
    );
}

#[test]
fn empty_required_id_returns_invalid_field() {
    let error = notification_to_codex_event(&notification(
        "item/completed",
        json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "completedAtMs": 42,
            "item": {"type": "agentMessage", "id": " ", "text": "hello"}
        }),
    ))
    .expect_err("empty item id should fail");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "item/completed".to_string(),
            field: "item.id",
        }
    );
}

#[test]
fn started_turn_rejects_terminal_status() {
    let error = notification_to_codex_event(&notification(
        "turn/started",
        json!({
            "threadId": "thread-1",
            "turn": {"id": "turn-1", "status": "completed", "error": null}
        }),
    ))
    .expect_err("started turn should reject terminal status");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "turn/started".to_string(),
            field: "turn.status",
        }
    );
}

#[test]
fn completed_turn_rejects_in_progress_status() {
    let error = notification_to_codex_event(&notification(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {"id": "turn-1", "status": "inProgress", "error": null}
        }),
    ))
    .expect_err("completed turn should reject in-progress status");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "turn/completed".to_string(),
            field: "turn.status",
        }
    );
}

#[test]
fn successful_turn_completed_rejects_non_null_error() {
    let error = notification_to_codex_event(&notification(
        "turn/completed",
        json!({
            "threadId": "thread-1",
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "error": {"message": "should not exist on success"}
            }
        }),
    ))
    .expect_err("successful completed turn should not carry an error");

    assert_eq!(
        error,
        CodexAppServerEventError::InvalidField {
            method: "turn/completed".to_string(),
            field: "turn.error",
        }
    );
}
