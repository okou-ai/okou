use super::*;

#[test]
fn official_model_families_have_distinct_effort_limits() {
    for family in ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen"] {
        assert_eq!(
            model_slug(Some(family), None).unwrap(),
            format!("{family}-medium")
        );
        for effort in ["low", "medium", "high", "xhigh"] {
            assert_eq!(
                model_slug(Some(family), Some(effort)).is_ok(),
                (family, effort) != ("gemini-4-carbon", "xhigh")
            );
        }
    }
    assert!(model_slug(None, None).is_err());
    assert!(model_slug(Some("gemini-4-neon"), Some("")).is_err());
    assert!(model_slug(Some("gemini-4-neon-custom"), None).is_err());
}

const ID: &str = "59bba40e-6fa2-4ddf-8340-24f38f4e9a12";
const MODEL: &str = "gemini-4-neon-medium";

fn init() -> String {
    json!({"event":"init","conversation_id":ID,"init":{"model":MODEL}}).to_string()
}

fn text_step(state: &str, delta: &str) -> String {
    json!({"event":"step_update","step_update":{"conversation_id":ID,"step_index":3,
        "step_type":"agent_response","state":state,"text_delta":delta}})
    .to_string()
}

#[test]
fn live_preview_masks_across_frames_and_reconciles_to_one_durable_block() {
    let masker = crate::masker::SecretMasker::from_raw("Y29uZmlndXJlZC1zZWNyZXQ=");
    let (output, mut chunks) = crate::cli::session_output::test_channel(16, "test");
    let mut projection = Projection::new(MODEL, Some(output), &masker);
    projection.project_line(&init()).unwrap();
    let prefix = "This public response starts before the native step finishes. ";
    assert_eq!(
        projection
            .project_line(&text_step("ACTIVE", &format!("{prefix}configured-")))
            .unwrap(),
        None
    );
    let first = chunks
        .try_recv()
        .expect("first preview while the step is active");
    let mut preview = first.delta;
    assert!(!preview.is_empty());
    let record = projection
        .project_line(&text_step("DONE", "secret"))
        .unwrap();
    let mut durable = record.unwrap();
    masker.mask_value(&mut durable);
    while let Ok(chunk) = chunks.try_recv() {
        assert_eq!(chunk.run_event_id, first.run_event_id);
        preview.push_str(&chunk.delta);
    }
    assert!(preview.starts_with(prefix));
    assert!(!preview.contains("configured-secret"));
    assert_eq!(durable["runEventId"], first.run_event_id);
    assert_eq!(durable["message"]["content"][0]["text"], preview);
    assert!(
        projection
            .project_line(&text_step("DONE", "secret"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn bad_model_session_and_result_order_cannot_claim_success() {
    let masker = crate::masker::SecretMasker::from_raw("");
    let mut projection = Projection::new(MODEL, None, &masker);
    assert!(
        projection
            .project_line(&init().replace("neon", "carbon"))
            .is_err()
    );
    assert!(projection.project_line(&text_step("DONE", "text")).is_err());
    projection.project_line(&init()).unwrap();
    assert!(
        projection
            .project_line(&text_step("DONE", "text").replace(ID, "other"))
            .is_err()
    );
    let result = json!({"event":"result","result":{"conversation_id":ID,"status":"SUCCESS","response":"answer"}});
    assert!(
        projection
            .project_line(&result.to_string().replace("SUCCESS", "UNKNOWN"))
            .is_err()
    );
    let fallback = projection
        .project_line(&result.to_string())
        .unwrap()
        .unwrap();
    assert_eq!(fallback["message"]["content"][0]["text"], "answer");
    let terminal = projection.take_pending().unwrap();
    assert_eq!(terminal["type"], "result");
    assert!(projection.project_line(&result.to_string()).is_err());
}

#[test]
fn runs_commands_without_the_terminal_sandbox_or_permission_prompts() {
    let settings = super::settings();
    assert_eq!(settings["enableTerminalSandbox"], false);
    assert_eq!(settings["toolPermission"], "always-proceed");
    assert_eq!(settings["allowNonWorkspaceAccess"], true);
    assert_eq!(settings["artifactReviewPolicy"], "always-proceed");
}

fn tool_step(index: u64, state: &str, name: &str, extra: serde_json::Value) -> String {
    let mut tool_info = json!({"name": name, "parameters": {"path": "/tmp/a"}});
    if let (Some(dst), Some(src)) = (tool_info.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    json!({
        "event": "step_update",
        "step_update": {
            "conversation_id": ID,
            "step_index": index,
            "step_type": "tool",
            "state": state,
            "tool_info": tool_info,
        }
    })
    .to_string()
}

#[test]
fn unfinished_steps_error_reports_diagnostic_details() {
    let masker = crate::masker::SecretMasker::from_raw("");
    let mut projection = Projection::new(MODEL, None, &masker);
    projection.project_line(&init()).unwrap();

    assert_eq!(
        projection
            .project_line(&text_step("ACTIVE", "hello"))
            .unwrap(),
        None
    );
    assert_eq!(
        projection.project_line(&text_step("WAITING", "")).unwrap(),
        None
    );
    let call = projection
        .project_line(&tool_step(5, "ACTIVE", "run_command", json!({})))
        .unwrap()
        .expect("active tool emits tool_use");
    assert_eq!(call["message"]["content"][0]["type"], "tool_use");

    let result = json!({"event":"result","result":{"conversation_id":ID,"status":"SUCCESS","response":"done"}});
    let err = projection.project_line(&result.to_string()).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("Antigravity completed with unfinished steps"),
        "{msg}"
    );
    assert!(
        msg.contains("3(bytes=5,updates=1,last_other_state=WAITING)"),
        "{msg}"
    );
    assert!(msg.contains("5(name=run_command,updates=1)"), "{msg}");
    assert!(msg.contains("completed=0"), "{msg}");
}

#[test]
fn terminal_non_done_states_close_active_steps_and_allow_completion() {
    let masker = crate::masker::SecretMasker::from_raw("");
    let mut projection = Projection::new(MODEL, None, &masker);
    projection.project_line(&init()).unwrap();

    // Active text step cancelled before completion
    assert_eq!(
        projection
            .project_line(&text_step("ACTIVE", "partial"))
            .unwrap(),
        None
    );
    assert_eq!(
        projection
            .project_line(&text_step("CANCELLED", ""))
            .unwrap(),
        None
    );

    // Active tool step ends in ERROR -> emits error tool_result
    let call = projection
        .project_line(&tool_step(5, "ACTIVE", "run_command", json!({})))
        .unwrap()
        .expect("active tool emits tool_use");
    let tool_use_id = call["message"]["content"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tool_res = projection
        .project_line(&tool_step(
            5,
            "ERROR",
            "run_command",
            json!({"error": {"message": "command aborted"}}),
        ))
        .unwrap()
        .expect("errored active tool emits error tool_result");
    assert_eq!(tool_res["message"]["content"][0]["type"], "tool_result");
    assert_eq!(
        tool_res["message"]["content"][0]["tool_use_id"],
        tool_use_id
    );
    assert_eq!(tool_res["message"]["content"][0]["is_error"], true);
    assert_eq!(
        tool_res["message"]["content"][0]["content"],
        "command aborted"
    );

    // Inactive tool step cancelled -> ignored without emitting events
    assert_eq!(
        projection
            .project_line(&tool_step(6, "CANCELLED", "read_file", json!({})))
            .unwrap(),
        None
    );

    let result = json!({"event":"result","result":{"conversation_id":ID,"status":"SUCCESS","response":"final answer"}});
    let fallback = projection
        .project_line(&result.to_string())
        .unwrap()
        .expect("fallback assistant message");
    assert_eq!(fallback["message"]["content"][0]["text"], "final answer");
    let terminal = projection.take_pending().expect("terminal result event");
    assert_eq!(terminal["type"], "result");
    assert_eq!(terminal["subtype"], "success");
}
