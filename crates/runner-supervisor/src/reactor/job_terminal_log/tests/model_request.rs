use super::*;

#[test]
fn failed_model_logs_keep_request_shape_and_validated_upstream_correlation() {
    for (status, api, encoding, instructions, error) in [
        (
            400,
            "openai-codex-responses",
            "zstd",
            Some(12),
            r#"{"detail":"Bad Request"}"#,
        ),
        (
            200,
            "openai-completions",
            "identity",
            None,
            "Provider finish_reason: error",
        ),
    ] {
        let mut diagnostic = FailureDiagnostic::new(
            FailureClass::CliNonzero,
            AgentFramework::Pi,
            PromptMetadata::from_prompt("prompt"),
        )
        .with_failure_detail_source(FailureDetailSource::PiResult);
        let mut details = serde_json::json!({
            "httpStatus": status, "transportAttempts": 1,
            "request": {"api": api, "inputItems": 7, "tools": 0,
                "wireBodyBytes": 348, "contentEncoding": encoding, "reasoningEffort": "xhigh"},
            "response": {"requestId": "req_0123456789abcdef0123456789abcdef", "cfRay": "0123456789abcdef-SJC"}
        });
        if let Some(bytes) = instructions {
            details["request"]["instructionsBytes"] = serde_json::json!(bytes);
        }
        diagnostic.model_request = Some(serde_json::from_value(details).unwrap());
        let failure = executor::ExecutionFailure::new(1, error, Some(diagnostic));
        let event = capture_job_failure_log(&failure);
        assert_eq!(event.level, Level::ERROR);
        assert_field_eq(&event, "error", error);
        for (key, value) in [
            ("model_request_api", api),
            ("model_request_wire_body_bytes", "348"),
            ("model_request_content_encoding", encoding),
            ("model_request_input_items", "7"),
            ("model_request_tools", "0"),
            ("model_request_reasoning_effort", "xhigh"),
            (
                "model_response_request_id",
                "req_0123456789abcdef0123456789abcdef",
            ),
            ("model_response_cf_ray", "0123456789abcdef-SJC"),
        ] {
            assert_field_eq(&event, key, value);
        }
        if let Some(bytes) = instructions {
            assert_field_eq(
                &event,
                "model_request_instructions_bytes",
                &bytes.to_string(),
            );
        } else {
            assert!(
                !event
                    .fields
                    .contains_key("model_request_instructions_bytes")
            );
        }
    }
}
