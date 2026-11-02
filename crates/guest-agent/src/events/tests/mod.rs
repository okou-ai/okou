use super::*;

#[test]
fn prepare_event_payload_adds_sequence_and_masks_object_event() {
    let event = serde_json::json!({
        "type": "test",
        "data": "contains secret-value"
    });
    let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

    let payload = prepare_event_payload_for_run_id(event, 7, &masker, "test-run");

    assert_eq!(payload["events"][0]["type"], "test");
    assert_eq!(payload["events"][0]["sequenceNumber"], 7);
    assert_eq!(payload["events"][0]["data"], "contains ***");
}

#[test]
fn prepare_event_payload_wraps_non_object_event_without_sequence_number() {
    let event = serde_json::json!("contains secret-value");
    let masker = SecretMasker::from_raw("c2VjcmV0LXZhbHVl");

    let payload = prepare_event_payload_for_run_id(event, 7, &masker, "test-run");

    assert_eq!(payload["events"][0], "contains ***");
}

#[test]
fn event_envelope_serializes_run_id_and_events() {
    let envelope = EventPayloadEnvelope::new("ordinary-run")
        .expect("ordinary event envelope must be constructible");
    let event = Bytes::from_static(br#"{"type":"assistant","sequenceNumber":0}"#);

    assert_eq!(
        envelope.payload(&[event]).as_ref(),
        br#"{"runId":"ordinary-run","events":[{"type":"assistant","sequenceNumber":0}]}"#
    );
}

#[test]
fn extract_tool_use() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}}]
        }
    });
    assert_eq!(
        extract_claude_tool_info(&event),
        vec![ClaudeToolEvent::Use {
            id: "t1",
            name: "WebFetch"
        }]
    );
}

#[test]
fn extract_tool_result() {
    let event = serde_json::json!({
        "type": "user",
        "message": {
            "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]
        }
    });
    assert_eq!(
        extract_claude_tool_info(&event),
        vec![ClaudeToolEvent::Result { tool_use_id: "t1" }]
    );
}

#[test]
fn extract_text_then_tool_use() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "Let me search..."},
                {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
            ]
        }
    });
    assert_eq!(
        extract_claude_tool_info(&event),
        vec![ClaudeToolEvent::Use {
            id: "t2",
            name: "WebSearch"
        }]
    );
}

#[test]
fn extract_parallel_tool_uses() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "tool_use", "id": "t1", "name": "WebFetch", "input": {}},
                {"type": "tool_use", "id": "t2", "name": "WebSearch", "input": {}}
            ]
        }
    });
    assert_eq!(
        extract_claude_tool_info(&event),
        vec![
            ClaudeToolEvent::Use {
                id: "t1",
                name: "WebFetch"
            },
            ClaudeToolEvent::Use {
                id: "t2",
                name: "WebSearch"
            },
        ]
    );
}

#[test]
fn extract_tool_use_missing_id_skipped() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "tool_use", "name": "WebFetch", "input": {}}]
        }
    });
    assert!(extract_claude_tool_info(&event).is_empty());
}

#[test]
fn extract_tool_result_missing_id_skipped() {
    let event = serde_json::json!({
        "type": "user",
        "message": {
            "content": [{"type": "tool_result", "content": "ok"}]
        }
    });
    assert!(extract_claude_tool_info(&event).is_empty());
}

#[test]
fn extract_text_event_returns_empty() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": "hello"}]
        }
    });
    assert!(extract_claude_tool_info(&event).is_empty());
}

#[test]
fn extract_non_network_tool_still_parsed() {
    // Non-network tools (Bash, Read, etc.) ARE parsed by extract_claude_tool_info.
    // Filtering by STUCK_TOOL_NAMES happens in the caller (cli.rs watchdog).
    let event = serde_json::json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 999"}}]
        }
    });
    assert_eq!(
        extract_claude_tool_info(&event),
        vec![ClaudeToolEvent::Use {
            id: "t1",
            name: "Bash"
        }]
    );
}

#[test]
fn extract_init_event_returns_empty() {
    let event = serde_json::json!({"type": "system", "subtype": "init"});
    assert!(extract_claude_tool_info(&event).is_empty());
}

#[test]
fn extract_empty_content_returns_empty() {
    let event = serde_json::json!({
        "type": "assistant",
        "message": {"content": []}
    });
    assert!(extract_claude_tool_info(&event).is_empty());
}

#[test]
fn codex_error_event_yields_failure_diagnostic() {
    let event = serde_json::json!({
        "type": "error",
        "message": "server rejected request",
        "error": {"message": "server rejected request"}
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "server rejected request".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_terminal_events_preserve_provider_codes_before_text_projection() {
    for (code, reason) in [
        (
            "context_length_exceeded",
            FailureReason::ContextWindowExceeded,
        ),
        ("rate_limit_exceeded", FailureReason::ProviderRateLimited),
        ("server_error", FailureReason::ProviderServerError),
        (
            "insufficient_quota",
            FailureReason::ProviderInsufficientCredits,
        ),
        ("model_not_found", FailureReason::UnsupportedModel),
    ] {
        let error = serde_json::json!({"code": code, "message": "provider request failed"});
        for event in [
            serde_json::json!({"type": "error", "message": "provider request failed", "error": error}),
            serde_json::json!({"type": "turn.completed", "turn": {"status": "failed", "error": error}}),
        ] {
            let diagnostic =
                masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).unwrap();
            assert_eq!(diagnostic.failure_reason, Some(reason));
            assert_eq!(diagnostic.message, "provider request failed");
        }
        let success = serde_json::json!({"type": "turn.completed", "turn": {"status": "completed", "error": error}});
        assert!(masked_codex_failure_diagnostic(&success, &SecretMasker::from_raw("")).is_none());
    }
}

#[test]
fn codex_terminal_events_classify_exact_access_program_rejection() {
    let error = serde_json::json!({
        "type": "invalid_request_error",
        "code": "unsupported_parameter",
        "message": "The access_programs parameter is not enabled for this organization.",
        "param": "access_programs.cyber"
    });
    for event in [
        serde_json::json!({
            "type": "error",
            "status": 400,
            "error": error.clone()
        }),
        serde_json::json!({
            "type": "turn.completed",
            "status": 400,
            "turn": {"status": "failed", "error": error.clone()}
        }),
    ] {
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("terminal Codex diagnostic");
        assert_eq!(
            diagnostic.failure_reason,
            Some(FailureReason::CodexAccessProgramUnavailable)
        );
    }
}

#[test]
fn codex_access_program_rejection_requires_exact_terminal_structure() {
    let message = "The access_programs parameter is not enabled for this organization.";
    let exact_error = serde_json::json!({
        "type": "invalid_request_error",
        "code": "unsupported_parameter",
        "message": message,
        "param": "access_programs.cyber"
    });
    let near_misses = [
        serde_json::json!({"type": "error", "status": 401, "error": exact_error.clone()}),
        serde_json::json!({"type": "error", "status": 400, "error": {
            "type": "server_error", "code": "unsupported_parameter", "message": message,
            "param": "access_programs.cyber"
        }}),
        serde_json::json!({"type": "error", "status": 400, "error": {
            "type": "invalid_request_error", "code": "invalid_parameter", "message": message,
            "param": "access_programs.cyber"
        }}),
        serde_json::json!({"type": "error", "status": 400, "error": {
            "type": "invalid_request_error", "code": "unsupported_parameter", "message": message,
            "param": "access_programs"
        }}),
        serde_json::json!({"type": "error", "status": 400, "error": {
            "type": "invalid_request_error", "code": "unsupported_parameter",
            "message": "The access_programs parameter is unavailable.",
            "param": "access_programs.cyber"
        }}),
        serde_json::json!({"type": "error", "status": 400, "error": {"message": message}}),
    ];
    for event in near_misses {
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("terminal Codex diagnostic");
        assert_eq!(diagnostic.failure_reason, None, "event: {event}");
    }

    for event in [
        serde_json::json!({"type": "warning", "status": 400, "message": message, "error": exact_error.clone()}),
        serde_json::json!({"type": "assistant", "message": message, "error": exact_error.clone()}),
        serde_json::json!({"type": "turn.completed", "status": 400, "turn": {
            "status": "completed", "error": exact_error
        }}),
    ] {
        assert!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).is_none(),
            "event: {event}"
        );
    }
}

#[test]
fn codex_output_limit_preserves_structured_causes_and_native_text() {
    let message = "Incomplete response returned, reason: max_output_tokens";
    for (fields, reason) in [
        (json!({}), FailureReason::OutputTokenLimit),
        (
            json!({"codex_error_info": "other"}),
            FailureReason::OutputTokenLimit,
        ),
        (
            json!({"codex_error_info": "contextWindowExceeded"}),
            FailureReason::ContextWindowExceeded,
        ),
        (
            json!({"codex_error_info": "internalServerError"}),
            FailureReason::ProviderServerError,
        ),
        (
            json!({"codex_error_info": "unauthorized"}),
            FailureReason::InvalidCredentials,
        ),
        (
            json!({"codex_error_info": "usageLimitExceeded"}),
            FailureReason::UsageLimit,
        ),
        (
            json!({"codex_error_info": "cyberPolicy"}),
            FailureReason::SafetyPolicyRefusal,
        ),
        (
            json!({"codex_error_info": {"responseStreamDisconnected": {"httpStatusCode": null}}}),
            FailureReason::ResponseConnectionLost,
        ),
        (
            json!({"codex_error_info": {"responseTooManyFailedAttempts": {"httpStatusCode": 503}}}),
            FailureReason::ProviderServerError,
        ),
        (
            json!({"code": "server_error"}),
            FailureReason::ProviderServerError,
        ),
    ] {
        let mut error = fields;
        error["message"] = json!(message);
        for event in [
            json!({"type": "error", "message": message, "error": error}),
            json!({"type": "turn.completed", "turn": {"status": "failed", "error": error}}),
        ] {
            let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("terminal failure diagnostic");
            assert_eq!(diagnostic.failure_reason, Some(reason), "event: {event}");
            assert_eq!(diagnostic.message, message);
        }
    }
}

#[test]
fn codex_upstream_stream_failures_preserve_native_text_and_structured_causes() {
    const MESSAGE: &str = "stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_test in your message.";
    for prefix in ["", "Error running remote compact task: "] {
        let message = format!("{prefix}{MESSAGE}");
        for (fields, expected) in [
            (json!({}), FailureReason::ProviderServerError),
            (
                json!({"codex_error_info": "other"}),
                FailureReason::ProviderServerError,
            ),
            (
                json!({"codex_error_info": "unauthorized"}),
                FailureReason::InvalidCredentials,
            ),
            (
                json!({"code": "invalid_api_key"}),
                FailureReason::InvalidApiKey,
            ),
            (
                json!({"codex_error_info": "usageLimitExceeded"}),
                FailureReason::UsageLimit,
            ),
            (
                json!({"codex_error_info": "contextWindowExceeded"}),
                FailureReason::ContextWindowExceeded,
            ),
            (
                json!({"codex_error_info": "cyberPolicy"}),
                FailureReason::SafetyPolicyRefusal,
            ),
            (
                json!({"codex_error_info": {"responseStreamDisconnected": {"httpStatusCode": null}}}),
                FailureReason::ResponseConnectionLost,
            ),
        ] {
            let mut error = fields;
            error["message"] = json!(message);
            for event in [
                json!({"type": "error", "message": message, "error": error}),
                json!({"type": "turn.completed", "turn": {"status": "failed", "error": error}}),
            ] {
                let diagnostic =
                    masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                        .expect("terminal failure diagnostic");
                assert_eq!(diagnostic.failure_reason, Some(expected), "event: {event}");
                assert_eq!(diagnostic.message, message);
            }
        }
    }
}

#[test]
fn codex_upstream_stream_failures_require_complete_terminal_signature() {
    const MESSAGE: &str = "stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_test in your message.";
    for event in [
        json!({"type": "warning", "message": MESSAGE}),
        json!({"type": "turn.completed", "turn": {"status": "completed", "error": {"message": MESSAGE}}}),
        json!({"type": "item.completed", "item": {"type": "agent_message", "text": MESSAGE}}),
        json!({"type": "item.completed", "item": {"type": "command_execution", "aggregated_output": MESSAGE, "exit_code": 1}}),
    ] {
        assert!(masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).is_none());
    }
    for message in [
        "stream disconnected before completion".to_string(),
        "stream disconnected before completion: connection reset by peer".to_string(),
        format!("Tool output: {MESSAGE}"),
        format!("{MESSAGE} additional diagnostics"),
        MESSAGE.replace("help.openai.com", "example.invalid"),
        MESSAGE.replace("req_test", ""),
        MESSAGE.replace("req_test", "request id with spaces"),
        MESSAGE.replace("req_test", "req\ncontinued"),
        MESSAGE.replace("req_test", "req\0continued"),
        "Error running remote compact task: stream disconnected before completion".to_string(),
    ] {
        let event = json!({"type": "turn.completed", "turn": {
            "status": "failed", "error": {"message": message, "codex_error_info": "other"}
        }});
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("terminal failure diagnostic");
        assert_eq!(diagnostic.failure_reason, None, "message: {message}");
    }
}

#[test]
fn codex_output_limit_does_not_classify_normal_output_or_similar_errors() {
    let message = "Incomplete response returned, reason: max_output_tokens";
    for event in [
        json!({"type": "warning", "message": message}),
        json!({"type": "turn.completed", "turn": {"status": "completed", "error": {"message": message}}}),
        json!({"type": "item.completed", "item": {"type": "agent_message", "text": message}}),
        json!({"type": "item.completed", "item": {"type": "command_execution", "aggregated_output": message, "exit_code": 1}}),
    ] {
        assert!(masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).is_none());
    }
    for message in [
        "stream disconnected before completion",
        "Incomplete response returned, reason: unknown",
        "Incomplete response returned, reason: content_filter",
        "Incomplete response returned, reason: max_output_tokens_extra",
        "Incomplete response returned, reason: max_output_tokens (server error)",
        "Tool output: Incomplete response returned, reason: max_output_tokens",
        "stream disconnected before completion: Incomplete response returned, reason: unknown",
        "stream disconnected before completion: Incomplete response returned, reason: content_filter",
        "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens_extra",
        "stream disconnected before completion: Incomplete response returned, reason: max_output_tokens (server error)",
        "Set max_output_tokens to configure the output budget",
        "Tool output: stream disconnected before completion: Incomplete response returned, reason: max_output_tokens",
    ] {
        let event = json!({"type": "turn.completed", "turn": {
            "status": "failed", "error": {"message": message, "codex_error_info": "other"}
        }});
        let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
            .expect("terminal failure diagnostic");
        assert_eq!(diagnostic.failure_reason, None, "message: {message}");
    }
}

#[test]
fn codex_retry_exhaustion_uses_only_its_structured_http_status() {
    for (status, reason) in [
        (429, Some(FailureReason::ProviderRateLimited)),
        (503, Some(FailureReason::ProviderServerError)),
        (529, Some(FailureReason::ProviderOverloaded)),
        (401, None),
        (999, None),
    ] {
        let event = serde_json::json!({"type": "turn.completed", "turn": {
            "status": "failed", "error": {"message": "request failed", "codex_error_info": {
                "responseTooManyFailedAttempts": {"httpStatusCode": status}
            }}
        }});
        assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .unwrap()
                .failure_reason,
            reason
        );
    }
}

#[test]
fn codex_error_event_nested_invalid_api_key_code_yields_failure_reason() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Incorrect API key provided",
        "error": {
            "code": "invalid_api_key",
            "message": "Incorrect API key provided"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Incorrect API key provided".to_string(),
            failure_reason: Some(FailureReason::InvalidApiKey),
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_model_capacity_yields_failure_reason() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Selected model is at capacity. Please try a different model.",
        "error": {
            "message": "Selected model is at capacity. Please try a different model."
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Selected model is at capacity. Please try a different model.".to_string(),
            failure_reason: Some(FailureReason::ProviderOverloaded),
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_context_window_exceeded_yields_failure_reason() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
        "error": {
            "message": "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
        }
    });

    assert_eq!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
            Some(CodexFailureDiagnostic {
                event_type: "error",
                message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.".to_string(),
                failure_reason: Some(FailureReason::ContextWindowExceeded),
                evidence: None,
            })
        );
}

#[test]
fn codex_error_event_unsupported_model_yields_failure_reason() {
    let message =
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
    let event = serde_json::json!({
        "type": "error",
        "message": message,
        "error": {"message": message}
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: message.to_string(),
            failure_reason: Some(FailureReason::UnsupportedModel),
            evidence: None,
        })
    );
}

#[test]
fn codex_terminal_unsupported_model_envelope_retains_reason_and_native_precedence() {
    let message = r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}"#;
    for (info, expected_reason) in [
        (serde_json::Value::Null, FailureReason::UnsupportedModel),
        (serde_json::json!("other"), FailureReason::UnsupportedModel),
        (
            serde_json::json!("unauthorized"),
            FailureReason::InvalidCredentials,
        ),
    ] {
        let error = serde_json::json!({"message": message, "codex_error_info": info});
        for event in [
            serde_json::json!({"type": "error", "message": message, "error": error}),
            serde_json::json!({
                "type": "turn.completed",
                "turn": {"status": "failed", "error": error}
            }),
        ] {
            let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("native terminal error must retain a diagnostic");
            assert_eq!(diagnostic.message, message);
            assert_eq!(diagnostic.failure_reason, Some(expected_reason), "{event}");
        }
    }
}

#[test]
fn codex_unsupported_model_envelope_requires_a_terminal_failure() {
    let message = r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}"#;
    let error = serde_json::json!({"message": message, "codex_error_info": "other"});
    for event in [
        serde_json::json!({"type": "error", "will_retry": true, "message": message, "error": error}),
        serde_json::json!({"type": "turn.completed", "turn": {"status": "completed", "error": error}}),
        serde_json::json!({"type": "item.completed", "item": {"type": "agent_message", "text": message}}),
        serde_json::json!({"type": "item.completed", "item": {
            "type": "command_execution", "aggregated_output": message, "exit_code": 0
        }}),
    ] {
        assert!(
            masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")).is_none(),
            "{event}"
        );
    }
}

#[test]
fn codex_error_event_unsupported_model_near_miss_remains_unclassified() {
    let message =
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account";
    let event = serde_json::json!({
        "type": "error",
        "message": message,
        "error": {"message": message}
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: message.to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_error_string_invalid_api_key_remains_unclassified() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Provider reported invalid_api_key in an error field",
        "error": {
            "error": "invalid_api_key",
            "message": "Provider reported invalid_api_key in an error field"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Provider reported invalid_api_key in an error field".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_nested_reconnect_required_yields_failure_reason() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Access token expired and refresh failed for: codex-oauth-token.",
        "error": {
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "reconnect_required"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Access token expired and refresh failed for: codex-oauth-token.".to_string(),
            failure_reason: Some(FailureReason::ReconnectRequired),
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_nested_error_string_reconnect_required_yields_failure_reason() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Access token expired and refresh failed for: codex-oauth-token.",
        "error": {
            "error": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "reconnect_required"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Access token expired and refresh failed for: codex-oauth-token.".to_string(),
            failure_reason: Some(FailureReason::ReconnectRequired),
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_upstream_provider_refresh_remains_unclassified() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Access token refresh failed for: codex-oauth-token.",
        "error": {
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token refresh failed for: codex-oauth-token.",
            "connectors": ["codex-oauth-token"],
            "failureReason": "upstream_provider"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Access token refresh failed for: codex-oauth-token.".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_multi_connector_reconnect_remains_unclassified() {
    let event = serde_json::json!({
        "type": "error",
        "message": "Access token expired and refresh failed for: notion, codex-oauth-token.",
        "error": {
            "code": "TOKEN_REFRESH_FAILED",
            "message": "Access token expired and refresh failed for: notion, codex-oauth-token.",
            "connectors": ["notion", "codex-oauth-token"],
            "failureReason": "reconnect_required"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "Access token expired and refresh failed for: notion, codex-oauth-token."
                .to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_error_event_accepts_nested_error_shape() {
    let event = serde_json::json!({
        "type": "error",
        "message": "server rejected request (policy denied)",
        "error": {
            "message": "server rejected request",
            "additional_details": "policy denied"
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "server rejected request (policy denied)".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_failed_turn_completed_event_yields_failure_diagnostic() {
    let event = serde_json::json!({
        "type": "turn.completed",
        "turn": {
            "status": "failed",
            "error": {"message": "failed TurnCompleted reason"}
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "failed TurnCompleted reason".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_failed_turn_completed_without_error_message_uses_status() {
    let event = serde_json::json!({
        "type": "turn.completed",
        "turn": {
            "status": "failed",
            "error": {}
        }
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "turn.completed",
            message: "turn failed".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_failure_diagnostic_masks_secrets() {
    let event = serde_json::json!({
        "type": "error",
        "message": "request failed with token supersecret"
    });
    let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &masker),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "request failed with token ***".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_failure_diagnostic_escapes_line_breaks() {
    let event = serde_json::json!({
        "type": "error",
        "message": "first line\nsecond line\rthird line"
    });

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(CodexFailureDiagnostic {
            event_type: "error",
            message: "first line\\nsecond line\\rthird line".to_string(),
            failure_reason: None,
            evidence: None,
        })
    );
}

#[test]
fn codex_failure_diagnostic_masks_before_truncating() {
    let prefix = "x".repeat(
        FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len() - "super".len(),
    );
    let event = serde_json::json!({
        "type": "error",
        "message": format!("{prefix}supersecret after-boundary")
    });
    let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");
    let diagnostic = masked_codex_failure_diagnostic(&event, &masker)
        .expect("error event should produce a diagnostic");

    assert!(
        diagnostic.message.contains("***"),
        "diagnostic should keep the masked token marker: {diagnostic:?}"
    );
    assert!(
        !diagnostic.message.contains("super"),
        "diagnostic should not leak a partial secret near the truncation boundary: {diagnostic:?}"
    );
}

#[test]
fn codex_failure_diagnostic_truncates_to_max_bytes() {
    let event = serde_json::json!({
        "type": "error",
        "message": "x".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES + 100)
    });
    let diagnostic = masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw(""))
        .expect("error event should produce a diagnostic");

    assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
    assert!(
        diagnostic
            .message
            .ends_with(FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX),
        "diagnostic should end with truncation marker: {diagnostic:?}"
    );
}

#[test]
fn jsonl_error_result_yields_failure_diagnostic() {
    let event = serde_json::json!({
        "type": "result",
        "subtype": "error",
        "is_error": true,
        "result": "permission denied while running command"
    });

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(JsonlResultFailureDiagnostic {
            subtype: Some("error"),
            message: "permission denied while running command".to_string(),
        })
    );
}

#[test]
fn jsonl_error_subtype_without_is_error_yields_failure_diagnostic() {
    let event = serde_json::json!({
        "type": "result",
        "subtype": "error",
        "result": "terminal result failed"
    });

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(JsonlResultFailureDiagnostic {
            subtype: Some("error"),
            message: "terminal result failed".to_string(),
        })
    );
}

#[test]
fn jsonl_result_failure_diagnostic_drops_unrecognized_subtype() {
    let event = serde_json::json!({
        "type": "result",
        "subtype": "secret\nsubtype",
        "is_error": true,
        "result": "terminal result failed"
    });

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        Some(JsonlResultFailureDiagnostic {
            subtype: None,
            message: "terminal result failed".to_string(),
        })
    );
}

#[test]
fn jsonl_success_result_has_no_failure_diagnostic() {
    let event = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": "Done."
    });

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        None
    );
}

#[test]
fn jsonl_error_result_requires_nonempty_result_message() {
    let event = serde_json::json!({
        "type": "result",
        "subtype": "error",
        "is_error": true,
        "result": " \n\t "
    });

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        None
    );
}

#[test]
fn jsonl_result_failure_diagnostic_masks_and_escapes_line_breaks() {
    let event = serde_json::json!({
        "type": "result",
        "is_error": true,
        "result": "first line with supersecret\nsecond\rthird"
    });
    let masker = SecretMasker::from_raw("c3VwZXJzZWNyZXQ=");

    assert_eq!(
        masked_jsonl_result_failure_diagnostic(&event, &masker),
        Some(JsonlResultFailureDiagnostic {
            subtype: None,
            message: "first line with ***\\nsecond\\rthird".to_string(),
        })
    );
}

#[test]
fn jsonl_result_failure_diagnostic_truncates_to_max_bytes() {
    let retained_bytes = FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len();
    let event = serde_json::json!({
        "type": "result",
        "is_error": true,
        "result": "é".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES)
    });
    let diagnostic = masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw(""))
        .expect("JSONL error result should produce a diagnostic");

    assert_eq!(diagnostic.message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
    assert_eq!(
        diagnostic.message,
        format!(
            "{}{}",
            "é".repeat(retained_bytes / "é".len()),
            FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX
        )
    );
}

#[test]
fn jsonl_result_failure_diagnostic_preserves_exact_limit_message() {
    let message = "é".repeat(FAILURE_DIAGNOSTIC_MAX_BYTES / "é".len());
    assert_eq!(message.len(), FAILURE_DIAGNOSTIC_MAX_BYTES);
    let event = serde_json::json!({
        "type": "result",
        "is_error": true,
        "result": message
    });
    let diagnostic = masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw(""))
        .expect("JSONL error result should produce a diagnostic");

    assert_eq!(diagnostic.message, message);
}

#[test]
fn jsonl_result_failure_diagnostic_retreats_to_utf8_boundary() {
    let retained_bytes = FAILURE_DIAGNOSTIC_MAX_BYTES - FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX.len();
    for character in ["界", "🦀"] {
        let message = character.repeat(FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(message.len() > FAILURE_DIAGNOSTIC_MAX_BYTES);
        assert!(!message.is_char_boundary(retained_bytes));
        let event = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": message
        });
        let diagnostic =
            masked_jsonl_result_failure_diagnostic(&event, &SecretMasker::from_raw(""))
                .expect("JSONL error result should produce a diagnostic");

        assert_eq!(
            diagnostic.message,
            format!(
                "{}{}",
                character.repeat(retained_bytes / character.len()),
                FAILURE_DIAGNOSTIC_TRUNCATED_SUFFIX
            ),
            "diagnostic should retain only complete characters for {character}"
        );
        assert!(diagnostic.message.len() <= FAILURE_DIAGNOSTIC_MAX_BYTES);
    }
}

#[test]
fn non_failure_codex_event_has_no_failure_diagnostic() {
    let event = serde_json::json!({"type": "turn.completed", "usage": {}});

    assert_eq!(
        masked_codex_failure_diagnostic(&event, &SecretMasker::from_raw("")),
        None
    );
}

// Note: end-to-end coverage of session metadata capture (including both
// the Claude `system/init` branch and the codex `thread.started`
// branch) lives in the integration test suites:
//   - `tests/integration_cases/events.rs::send_event_extracts_claude_session_id`
//   - `tests/codex_client_cases/codex_session_resume.rs` (codex variant)
// The Claude/Codex helpers are private; their contracts are
// exercised transitively through `send_event`.
