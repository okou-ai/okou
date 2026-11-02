use super::*;

#[test]
fn claude_source_uses_effective_config_dir_and_first_valid_id() {
    let temp = tempfile::tempdir().unwrap();
    let session_id_file = temp.path().join("session-id");
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::ClaudeCode {
            config_dir: Some("/home/user/custom-claude".to_string()),
            working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
        },
        store.clone(),
        session_id_file.to_str().unwrap(),
    );

    capture.capture_session_id("session-first");
    capture.capture_session_id("session-second");

    assert_eq!(
        store.captured(),
        Some(&CapturedSessionMetadata {
            cli_agent_session_id: "session-first".to_string(),
            history_source: Some(SessionHistorySourceRef::ClaudeCode {
                config_dir: "/home/user/custom-claude".to_string(),
                working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
                session_id: "session-first".to_string(),
            }),
        })
    );
    assert_eq!(
        std::fs::read_to_string(session_id_file).unwrap(),
        "session-first"
    );
}

#[test]
fn relative_claude_config_dir_is_resolved_against_child_cwd() {
    assert_eq!(
        normalized_absolute_launch_path("../state", paths::CANONICAL_WORKING_DIR).as_deref(),
        Some("/home/user/state")
    );
}

#[test]
fn codex_source_preserves_launch_path_and_canonical_thread_id() {
    let temp = tempfile::tempdir().unwrap();
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::Codex {
            sessions_dir: Some("/home/user/.codex/sessions".to_string()),
        },
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_session_id("0193ABCD-EF01-7234-89AB-CDEF01234567");

    assert_eq!(
        store
            .captured()
            .and_then(CapturedSessionMetadata::history_source),
        Some(&SessionHistorySourceRef::Codex {
            sessions_dir: "/home/user/.codex/sessions".to_string(),
            thread_id: "0193abcd-ef01-7234-89ab-cdef01234567".to_string(),
        })
    );
}

#[test]
fn pi_source_uses_official_init_session_file() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = "00000000-0000-4000-8000-000000000001";
    let session_path = format!(
        "{}/2026-08-14T00-00-00_{session_id}.jsonl",
        api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
    );
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::Pi,
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_pi_session_id(session_id, Some(&session_path));

    assert_eq!(
        store
            .captured()
            .and_then(CapturedSessionMetadata::history_source),
        Some(&SessionHistorySourceRef::Pi {
            session_path,
            session_id: session_id.to_string(),
        })
    );
}

#[test]
fn pi_invalid_history_path_keeps_identity_without_source() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = "00000000-0000-4000-8000-000000000001";
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::Pi,
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_pi_session_id(session_id, Some("/tmp/untrusted.jsonl"));

    assert_eq!(
        store.captured(),
        Some(&CapturedSessionMetadata {
            cli_agent_session_id: session_id.to_string(),
            history_source: None,
        })
    );
}

#[test]
fn pi_nonterminal_session_id_keeps_identity_without_source() {
    let temp = tempfile::tempdir().unwrap();
    let session_id = "00000000-0000-4000-8000-000000000001";
    let session_path = format!(
        "{}/{session_id}-backup.jsonl",
        api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
    );
    let store = SessionMetadataStore::default();
    let capture = SessionMetadataCapture::new(
        SessionHistoryLaunchSource::Pi,
        store.clone(),
        temp.path().join("session-id").to_str().unwrap(),
    );

    capture.capture_pi_session_id(session_id, Some(&session_path));

    assert_eq!(
        store.captured(),
        Some(&CapturedSessionMetadata {
            cli_agent_session_id: session_id.to_string(),
            history_source: None,
        })
    );
}
