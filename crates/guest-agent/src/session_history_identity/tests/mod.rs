use super::*;

const LARGE_SESSION_HISTORY_SIZE_BYTES: usize = 1024 * 1024 + 1;
const PREVIOUS_GUEST_VERIFY_CAP_BYTES: u64 = 32 * 1024 * 1024;
const CLAUDE_SESSION_ID: &str = "session-identity-test";

fn write_metadata(
    dir: &tempfile::TempDir,
    identity: &SessionHistoryIdentity,
) -> std::path::PathBuf {
    let path = dir.path().join("identity.json");
    crate::paths::write_private(&path, identity.to_json_vec().unwrap()).unwrap();
    path
}

fn session_hash(session_id: &str) -> String {
    hex::encode(Sha256::digest(session_id.as_bytes()))
}

fn claude_history_source(dir: &tempfile::TempDir) -> (std::path::PathBuf, SessionHistorySourceRef) {
    let config_dir = dir.path().join("claude-config");
    let history_path = config_dir
        .join("projects")
        .join("-home-user-workspace")
        .join(format!("{CLAUDE_SESSION_ID}.jsonl"));
    std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
    (
        history_path,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: config_dir.to_string_lossy().into_owned(),
            working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: CLAUDE_SESSION_ID.to_string(),
        },
    )
}

fn claude_identity(
    source: SessionHistorySourceRef,
    history_hash: impl Into<String>,
    history_size: u64,
) -> SessionHistoryIdentity {
    SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        session_hash(CLAUDE_SESSION_ID),
        SessionHistoryRefKind::Blob,
        history_hash,
        history_size,
        source,
    )
    .unwrap()
}

#[test]
fn verifies_claude_literal_history() {
    let dir = tempfile::tempdir().unwrap();
    let history = br#"{"type":"system"}"#;
    let (history_path, source) = claude_history_source(&dir);
    std::fs::write(&history_path, history).unwrap();
    let identity = claude_identity(
        source,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
    );
    let metadata_path = write_metadata(&dir, &identity);

    verify_final_session_history_identity_file(metadata_path, None).unwrap();
}

#[test]
fn builds_pi_jsonl_history_identity() {
    let session_id = "00000000-0000-4000-8000-000000000001";
    let history = br#"{"type":"session","id":"00000000-0000-4000-8000-000000000001"}"#;
    let history_path = format!(
        "{}/restored-{session_id}.jsonl",
        api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
    );
    let history_source = SessionHistorySourceRef::Pi {
        session_path: history_path,
        session_id: session_id.to_string(),
    };
    let identity = build_final_session_history_identity(
        env::Framework::Pi,
        session_id,
        &hex::encode(Sha256::digest(history)),
        history.len() as u64,
        &history_source,
    )
    .unwrap();

    assert_eq!(identity.framework, SessionHistoryFramework::Pi);
    assert_eq!(identity.history_source, history_source);
    assert_eq!(
        identity.session_id_hash,
        hex::encode(Sha256::digest(session_id.as_bytes()))
    );
}

#[test]
fn verifies_codex_history_source() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let history_dir = sessions_dir.join("2026").join("06").join("29");
    std::fs::create_dir_all(&history_dir).unwrap();
    let thread_id = "00000000-0000-4000-8000-000000000001";
    let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
    std::fs::write(
        history_dir.join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl"),
        history,
    )
    .unwrap();
    let source = SessionHistorySourceRef::Codex {
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        thread_id: thread_id.to_string(),
    };
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        session_hash(thread_id),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        source,
    )
    .unwrap();
    let metadata_path = write_metadata(&dir, &identity);

    verify_final_session_history_identity_file(metadata_path, None).unwrap();
}

#[test]
fn verifies_codex_zstd_history_source() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let history_dir = sessions_dir.join("2026").join("06").join("29");
    std::fs::create_dir_all(&history_dir).unwrap();
    let thread_id = "00000000-0000-4000-8000-000000000001";
    let history = br#"{"type":"session_meta","timestamp":"2026-06-29T10:00:00Z"}"#;
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    std::fs::write(
        history_dir.join("rollout-2026-06-29T10-00-00-00000000000040008000000000000001.jsonl.zst"),
        compressed,
    )
    .unwrap();
    let source = SessionHistorySourceRef::Codex {
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        thread_id: thread_id.to_string(),
    };
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        session_hash(thread_id),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        source,
    )
    .unwrap();
    let metadata_path = write_metadata(&dir, &identity);

    verify_final_session_history_identity_file(metadata_path, None).unwrap();
}

#[test]
fn rejects_history_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let (history_path, source) = claude_history_source(&dir);
    std::fs::write(&history_path, b"changed").unwrap();
    let identity = claude_identity(source, "b".repeat(64), 7);
    let metadata_path = write_metadata(&dir, &identity);

    let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
    assert!(matches!(
        err,
        SessionHistoryIdentityVerifyError::HistoryMismatch
    ));
}

#[test]
fn rejects_oversized_metadata_file() {
    let dir = tempfile::tempdir().unwrap();
    let metadata_path = dir.path().join("identity.json");
    crate::paths::write_private(
        &metadata_path,
        vec![b'x'; FINAL_SESSION_HISTORY_IDENTITY_MAX_BYTES as usize + 1],
    )
    .unwrap();

    let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
    assert!(matches!(
        err,
        SessionHistoryIdentityVerifyError::InvalidMetadata(
            SessionHistoryIdentityError::MetadataTooLarge
        )
    ));
}

#[test]
fn build_allows_large_history_metadata() {
    let identity = claude_identity(
        SessionHistorySourceRef::ClaudeCode {
            config_dir: "/claude-config".to_string(),
            working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: CLAUDE_SESSION_ID.to_string(),
        },
        "b".repeat(64),
        LARGE_SESSION_HISTORY_SIZE_BYTES as u64,
    );

    assert_eq!(
        identity.history_size_bytes,
        LARGE_SESSION_HISTORY_SIZE_BYTES as u64
    );
}

#[test]
fn verifies_large_claude_literal_history() {
    let dir = tempfile::tempdir().unwrap();
    let (history_path, source) = claude_history_source(&dir);
    let history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    std::fs::write(&history_path, &history).unwrap();
    let identity = claude_identity(
        source,
        hex::encode(Sha256::digest(&history)),
        history.len() as u64,
    );
    let metadata_path = write_metadata(&dir, &identity);

    verify_final_session_history_identity_file(metadata_path, None).unwrap();
}

#[test]
fn verifies_history_above_previous_guest_verify_cap() {
    let history_size = PREVIOUS_GUEST_VERIFY_CAP_BYTES + 1;
    assert!(history_size < RESUME_SESSION_HISTORY_MAX_BYTES);

    let dir = tempfile::tempdir().unwrap();
    let (history_path, source) = claude_history_source(&dir);
    std::fs::File::create(&history_path)
        .unwrap()
        .set_len(history_size)
        .unwrap();
    // head -c 33554433 /dev/zero | sha256sum
    let identity = claude_identity(
        source,
        "bdf7fbb54387c24608fd757a1b31c32cabcd7b6bee8ff3345c897139fffc072a",
        history_size,
    );
    let metadata_path = write_metadata(&dir, &identity);

    verify_final_session_history_identity_file(metadata_path, None).unwrap();
}

#[test]
fn rejects_current_history_larger_than_identity_size() {
    let dir = tempfile::tempdir().unwrap();
    let (history_path, source) = claude_history_source(&dir);
    let expected_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES - 1];
    let oversized_history = vec![b'a'; LARGE_SESSION_HISTORY_SIZE_BYTES];
    std::fs::write(&history_path, oversized_history).unwrap();
    let identity = claude_identity(
        source,
        hex::encode(Sha256::digest(&expected_history)),
        expected_history.len() as u64,
    );
    let metadata_path = write_metadata(&dir, &identity);

    let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
    assert!(matches!(
        err,
        SessionHistoryIdentityVerifyError::HistoryMismatch
    ));
}

#[test]
fn rejects_history_above_resume_cap() {
    let dir = tempfile::tempdir().unwrap();
    let (history_path, source) = claude_history_source(&dir);
    std::fs::write(&history_path, b"small").unwrap();
    let identity = claude_identity(source, "b".repeat(64), RESUME_SESSION_HISTORY_MAX_BYTES + 1);
    let metadata_path = write_metadata(&dir, &identity);

    let err = verify_final_session_history_identity_file(metadata_path, None).unwrap_err();
    assert!(matches!(
        err,
        SessionHistoryIdentityVerifyError::HistoryTooLarge
    ));
}

#[test]
fn rejects_expected_identity_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let history = br#"{"type":"system"}"#;
    let (history_path, source) = claude_history_source(&dir);
    std::fs::write(&history_path, history).unwrap();
    let identity = claude_identity(
        source,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
    );
    let expected = SessionHistoryIdentityExpectation::new(
        SessionHistoryFramework::ClaudeCode,
        session_hash(CLAUDE_SESSION_ID),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        history.len() as u64,
    )
    .unwrap();
    let metadata_path = write_metadata(&dir, &identity);

    let err =
        verify_final_session_history_identity_file(metadata_path, Some(&expected)).unwrap_err();
    assert!(matches!(
        err,
        SessionHistoryIdentityVerifyError::ExpectedIdentityMismatch
    ));
}
