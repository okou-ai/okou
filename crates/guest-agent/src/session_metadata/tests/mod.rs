use super::*;

#[test]
fn claude_capture_keeps_first_valid_id() {
    let temp = tempfile::tempdir().unwrap();
    let session_id_file = temp.path().join("session-id");
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        Framework::ClaudeCode,
        store.clone(),
        session_id_file.to_str().unwrap(),
    );

    capture.capture_session_id("session-first");
    capture.capture_session_id("session-second");

    assert_eq!(
        store.captured(),
        Some(&CapturedSessionMetadata {
            cli_agent_session_id: "session-first".to_string(),
        })
    );
    assert_eq!(
        std::fs::read_to_string(session_id_file).unwrap(),
        "session-first"
    );
}

#[test]
fn codex_capture_normalizes_canonical_thread_id() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        Framework::Codex,
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_session_id("0193ABCD-EF01-7234-89AB-CDEF01234567");

    assert_eq!(
        store
            .captured()
            .map(CapturedSessionMetadata::cli_agent_session_id),
        Some("0193abcd-ef01-7234-89ab-cdef01234567")
    );
}

#[test]
fn pi_capture_records_dynamic_session_id() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = "00000000-0000-4000-8000-000000000001";
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        Framework::Pi,
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_session_id(session_id);

    assert_eq!(
        store.captured(),
        Some(&CapturedSessionMetadata {
            cli_agent_session_id: session_id.to_string(),
        })
    );
}
