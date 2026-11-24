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
