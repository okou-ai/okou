use crate::support::*;
use base64::Engine;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;

fn session_id_file() -> String {
    shared_guest_paths().session_id_file().to_string()
}

async fn send_shared_event(
    event: serde_json::Value,
    seq: u32,
    masker: &SecretMasker,
) -> Result<(), guest_agent::error::AgentError> {
    let config = shared_guest_config().map_err(guest_agent::error::AgentError::Execution)?;
    let paths = shared_guest_paths();
    guest_agent::events::send_event_for_config(&http_client!(), event, seq, masker, &config, &paths)
        .await
}

// =========================================================================
// Events
// =========================================================================

#[tokio::test]
async fn send_event_correct_payload() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .json_body_includes(r#"{"runId": "test-run-001"}"#)
            .body_includes(r#""sequenceNumber":42"#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "test", "data": "hello"});
    let result = send_shared_event(event, 42, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn send_event_masks_secrets() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""tool_input":{"***":"contains *** here"}"#)
            .body_excludes("super-secret-value");
        then.status(200);
    });

    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode("super-secret-value");
    let masker = SecretMasker::from_raw(&encoded_secret);

    let event = json!({
        "type": "test",
        "tool_input": {"super-secret-value": "contains super-secret-value here"}
    });
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
}

#[test]
fn prepare_event_keeps_system_sequence_field_when_name_is_secret() {
    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode("sequenceNumber");
    let masker = SecretMasker::from_raw(&encoded_secret);
    let event = json!({
        "type": "test",
        "nested": {"sequenceNumber": "event-controlled"}
    });

    let payload =
        guest_agent::events::prepare_event_payload_for_run_id(event, 7, &masker, TEST_RUN_ID);

    assert_eq!(payload["runId"], TEST_RUN_ID);
    assert_eq!(payload["events"][0]["type"], "test");
    assert_eq!(payload["events"][0]["sequenceNumber"], 7);
    assert_eq!(payload["events"][0]["nested"]["***"], "event-controlled");
    assert!(payload["events"][0]["nested"]["sequenceNumber"].is_null());
}

#[tokio::test]
async fn send_event_masks_lowercase_percent_encoded_secret() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""data":"contains *** here""#);
        then.status(200);
    });

    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode("token/a");
    let masker = SecretMasker::from_raw(&encoded_secret);

    let event = json!({"type": "test", "data": "contains token%2fa here"});
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
}

#[tokio::test]
async fn send_event_captures_session_metadata_before_masking() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();
    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let sid_file = session_id_file();
    let session_id = "ses-session-id-123";

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""session_id":"***""#)
            .body_excludes(session_id);
        then.status(200);
    });

    // Mask the session ID so capturing after masking cannot preserve the metadata.
    let encoded_secret = base64::engine::general_purpose::STANDARD.encode(session_id);
    let masker = SecretMasker::from_raw(&encoded_secret);
    assert_eq!(masker.mask_string(session_id), "***");
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id
    });

    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    let stored = std::fs::read_to_string(&sid_file).unwrap();
    assert_eq!(
        stored, session_id,
        "checkpoint metadata should capture the unmasked session id"
    );
    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        system_log.contains(&format!("Session ID written to {sid_file}")),
        "system log should confirm session ID file creation, got: {system_log}"
    );
    assert!(
        !system_log.contains(session_id),
        "system log must not contain the raw session id, got: {system_log}"
    );
}

#[tokio::test]
async fn prepare_event_does_not_capture_session_metadata() {
    let _api = SharedApiMock::new().await;
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-prepare-only"
    });
    let payload =
        guest_agent::events::prepare_event_payload_for_run_id(event, 1, &masker, TEST_RUN_ID);

    assert_eq!(payload["runId"], "test-run-001");
    assert_eq!(payload["events"][0]["sequenceNumber"], 1);
    assert!(
        !std::path::Path::new(&sid_file).exists(),
        "prepare_event must not write the session ID file"
    );
}

#[tokio::test]
async fn send_event_preserves_rejected_claude_session_ids_without_checkpoint_metadata() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    for (sequence_number, session_id) in [(1, "session.with.dot".to_string()), (2, "a".repeat(129))]
    {
        let event = json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id
        });
        let result = send_shared_event(event, sequence_number, &masker).await;

        assert!(result.is_ok());
        assert_eq!(masker.mask_string(&session_id), session_id);
        assert!(
            !std::path::Path::new(&sid_file).exists(),
            "rejected session id must not be persisted"
        );
    }
    mock.assert_calls_async(2).await;
}

#[tokio::test]
async fn send_event_keeps_existing_session_id_file() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();
    guest_agent::paths::write_private(&sid_file, "first-session").unwrap();

    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(r#""session_id":"second-session""#);
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "second-session"
    });
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
    assert_eq!(
        std::fs::read_to_string(&sid_file).unwrap(),
        "first-session",
        "later id-bearing events must not replace checkpoint session metadata"
    );
    assert_eq!(masker.mask_string("first-session"), "first-session");
    assert_eq!(masker.mask_string("second-session"), "second-session");
}

#[tokio::test]
async fn send_event_keeps_existing_claude_session_id_for_ordinary_events() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();
    let session_id = "session-repair";

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    guest_agent::paths::write_private(&sid_file, session_id).unwrap();

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "assistant", "data": "later"});
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    assert_eq!(
        std::fs::read_to_string(&sid_file).unwrap(),
        session_id,
        "later events must keep the existing session id"
    );
    assert_eq!(masker.mask_string(session_id), session_id);
    mock.assert_calls_async(1).await;
}

// =========================================================================
// Session ID extraction
// =========================================================================

#[tokio::test]
async fn send_event_extracts_claude_session_id() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    // CLI_AGENT_TYPE defaults to "claude-code", so the Claude path is taken:
    // type == "system" && subtype == "init" → reads session_id field.
    let event = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "ses-abc-123"
    });
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    // Session ID persisted
    let stored = std::fs::read_to_string(&sid_file).unwrap();
    assert_eq!(stored, "ses-abc-123");
}

#[tokio::test]
async fn send_event_rejects_unsafe_claude_session_id() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();
    let invalid_session_ids = ["../escape", "nested/id", "nested\\id", ".", "..", "bad\nid"];

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    for session_id in invalid_session_ids {
        let _ = std::fs::remove_file(&sid_file);

        let masker = SecretMasker::from_raw("");
        let event = json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id
        });
        let result = send_shared_event(event, 1, &masker).await;

        assert!(result.is_ok());
        assert!(
            !std::path::Path::new(&sid_file).exists(),
            "unsafe session_id must not be persisted: {session_id:?}"
        );
    }

    mock.assert_calls_async(invalid_session_ids.len()).await;
}

#[tokio::test]
async fn send_event_skips_session_id_for_non_init() {
    let api = SharedApiMock::new().await;
    let server = api.server();
    let _session_files = SessionCheckpointFilesGuard::new();

    let sid_file = session_id_file();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let masker = SecretMasker::from_raw("");
    let event = json!({"type": "assistant", "data": "hello"});
    let result = send_shared_event(event, 1, &masker).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;

    assert!(
        !std::path::Path::new(&sid_file).exists(),
        "session ID file should NOT be written for non-init events"
    );
}

// =========================================================================
// Edge cases
// =========================================================================

#[tokio::test]
async fn send_event_failure_returns_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let _mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(500);
    });

    let payload = json!({
        "runId": "test-run-001",
        "events": [{"type": "test", "sequenceNumber": 1}]
    });
    let result = guest_agent::events::post_event(&http_client!(), &payload).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn send_event_accepts_success_without_parsing_response_body() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(204).body("not valid JSON");
    });

    let payload = json!({
        "runId": "test-run-001",
        "events": [{"type": "test", "sequenceNumber": 1}]
    });
    let result = guest_agent::events::post_event(&http_client!(), &payload).await;

    assert!(result.is_ok());
    mock.assert_calls_async(1).await;
}
