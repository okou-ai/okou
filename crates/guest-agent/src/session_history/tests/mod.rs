use super::*;

const TEST_CLAUDE_SESSION_ID: &str = "session-history-source-test";

fn claude_source(config_dir: &Path) -> SessionHistorySourceRef {
    SessionHistorySourceRef::ClaudeCode {
        config_dir: config_dir.to_string_lossy().into_owned(),
        working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
        session_id: TEST_CLAUDE_SESSION_ID.to_string(),
    }
}

fn claude_history_path(config_dir: &Path) -> PathBuf {
    config_dir
        .join("projects/-home-user-workspace")
        .join(format!("{TEST_CLAUDE_SESSION_ID}.jsonl"))
}

fn codex_source(sessions_dir: &Path, thread_id: &str) -> SessionHistorySourceRef {
    SessionHistorySourceRef::Codex {
        sessions_dir: sessions_dir.to_string_lossy().into_owned(),
        thread_id: thread_id.to_string(),
    }
}

fn resolve_test_payload(payload: &str) -> Result<ResolvedSessionHistory, AgentError> {
    let path = Path::new(payload);
    let parent_path = path.parent().ok_or_else(|| {
        AgentError::Finalization("test session history has no parent".to_string())
    })?;
    let leaf_name = path.file_name().ok_or_else(|| {
        AgentError::Finalization("test session history has no file name".to_string())
    })?;
    #[cfg(target_os = "linux")]
    {
        let parent = Dir::open_absolute(parent_path)
            .map_err(|error| read_history_error(parent_path, error))?;
        let file = parent
            .open_child_file(leaf_name)
            .map_err(|error| read_history_error(path, error))?;
        let is_zstd = is_zstd_session_history(path);
        Ok(ResolvedSessionHistory {
            location: SessionHistoryLocation {
                parent,
                parent_path: parent_path.to_path_buf(),
                leaf_name: leaf_name.to_os_string(),
            },
            path: path.to_path_buf(),
            file,
            is_zstd,
        })
    }
    #[cfg(not(target_os = "linux"))]
    Err(AgentError::Finalization(
        "Safe session history resolution is unsupported on this platform".to_string(),
    ))
}

fn read_session_history_from_payload_bounded(
    payload: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, AgentError> {
    match resolve_test_payload(payload)?.into_content_bounded(max_bytes)? {
        SessionHistoryContent::Decoded(bytes) => Ok(bytes),
        SessionHistoryContent::CodexZstd { encoded } => {
            let decoder = zstd::stream::read::Decoder::new(encoded.as_slice())
                .map_err(zstd_session_history_error)?;
            read_history_reader(decoder, Some(max_bytes), zstd_session_history_error)
        }
    }
}

fn read_session_history_from_source_for_test_bounded(
    source: &SessionHistorySourceRef,
    max_bytes: u64,
) -> Result<Vec<u8>, AgentError> {
    match resolve_session_history_from_source(source)?.into_content_bounded(max_bytes)? {
        SessionHistoryContent::Decoded(bytes) => Ok(bytes),
        SessionHistoryContent::CodexZstd { encoded } => {
            let decoder = zstd::stream::read::Decoder::new(encoded.as_slice())
                .map_err(zstd_session_history_error)?;
            read_history_reader(decoder, Some(max_bytes), zstd_session_history_error)
        }
    }
}

fn write_history_file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn assert_over_limit(error: AgentError, max_bytes: u64) {
    match error {
        AgentError::SessionHistoryTooLarge {
            max_bytes: actual_max_bytes,
        } => assert_eq!(actual_max_bytes, max_bytes),
        other => panic!("expected typed over-limit error, got: {other}"),
    }
}

#[test]
fn resolves_claude_history_from_custom_config_root() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("custom-claude");
    let history_path = claude_history_path(&config_dir);
    std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
    std::fs::write(&history_path, b"custom history").unwrap();

    let source = resolve_session_history_from_source(&claude_source(&config_dir)).unwrap();
    let bytes = match source.into_content_bounded(32).unwrap() {
        SessionHistoryContent::Decoded(bytes) => bytes,
        SessionHistoryContent::CodexZstd { .. } => {
            panic!("Claude history must use decoded bytes")
        }
    };

    assert_eq!(bytes, b"custom history");
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_claude_history_through_intermediate_symlink() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("claude-config");
    let outside_projects = dir.path().join("outside-projects");
    let outside_history = outside_projects
        .join("-home-user-workspace")
        .join(format!("{TEST_CLAUDE_SESSION_ID}.jsonl"));
    std::fs::create_dir_all(outside_history.parent().unwrap()).unwrap();
    std::fs::write(&outside_history, b"parent-only sentinel").unwrap();
    std::fs::create_dir(&config_dir).unwrap();
    symlink(&outside_projects, config_dir.join("projects")).unwrap();

    let error = resolve_session_history_from_source(&claude_source(&config_dir))
        .err()
        .expect("intermediate symlink must be rejected");

    assert!(error.to_string().contains("Failed to read session history"));
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_claude_history_final_symlink() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("claude-config");
    let history_path = claude_history_path(&config_dir);
    let outside_history = dir.path().join("outside-history.jsonl");
    std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
    std::fs::write(&outside_history, b"parent-only sentinel").unwrap();
    symlink(&outside_history, &history_path).unwrap();

    let error = resolve_session_history_from_source(&claude_source(&config_dir))
        .err()
        .expect("final symlink must be rejected");

    assert!(error.to_string().contains("Failed to read session history"));
}

#[test]
fn rejects_missing_and_duplicate_codex_matches() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    std::fs::create_dir_all(&sessions_dir).unwrap();
    let source = codex_source(&sessions_dir, thread_id);

    let missing = resolve_session_history_from_source(&source)
        .err()
        .expect("missing Codex source must be unavailable");
    assert!(missing.to_string().contains("not found"));

    for day in ["02", "03"] {
        let day_dir = sessions_dir.join("2026/07").join(day);
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(
            day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl"),
            b"history",
        )
        .unwrap();
    }

    let duplicate = resolve_session_history_from_source(&source)
        .err()
        .expect("duplicate Codex source must be unavailable");
    assert!(
        duplicate
            .to_string()
            .contains("Multiple Codex session files")
    );
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_proc_magic_link_source() {
    let source = SessionHistorySourceRef::ClaudeCode {
        config_dir: "/proc/self".to_string(),
        working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
        session_id: TEST_CLAUDE_SESSION_ID.to_string(),
    };

    assert!(resolve_session_history_from_source(&source).is_err());
}

#[test]
fn bounded_read_allows_literal_history_at_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_history_file(&dir, "history.jsonl", b"abcd");

    let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 4).unwrap();

    assert_eq!(bytes, b"abcd");
}

#[test]
fn bounded_read_allows_empty_literal_history_with_zero_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_history_file(&dir, "history.jsonl", b"");

    let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0).unwrap();

    assert_eq!(bytes, b"");
}

#[test]
fn bounded_read_rejects_nonempty_literal_history_with_zero_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_history_file(&dir, "history.jsonl", b"a");

    let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
        .expect_err("bounded literal read must reject nonempty history when cap is zero");

    assert_over_limit(err, 0);
}

#[test]
fn bounded_read_rejects_nonempty_zstd_history_with_zero_limit() {
    let dir = tempfile::tempdir().unwrap();
    let compressed = zstd::encode_all(b"a".as_slice(), 0).unwrap();
    let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

    let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
        .expect_err("bounded zstd read must reject nonempty history when cap is zero");

    assert_over_limit(err, 0);
}

#[test]
fn bounded_read_rejects_literal_history_over_limit_before_reading() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_history_file(&dir, "history.jsonl", b"abcde");
    let resolved = resolve_test_payload(path.to_str().unwrap()).unwrap();
    let mut observed_file = resolved.file.try_clone().unwrap();

    let err = resolved
        .into_content_bounded(4)
        .err()
        .expect("bounded literal read must reject over-limit history");

    assert_over_limit(err, 4);
    assert_eq!(observed_file.stream_position().unwrap(), 0);
}

#[test]
fn bounded_read_rejects_codex_history_over_limit() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let day_dir = sessions_dir.join("2026").join("07").join("02");
    std::fs::create_dir_all(&day_dir).unwrap();
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl");
    std::fs::write(path, b"abcde").unwrap();
    let source = codex_source(&sessions_dir, thread_id);

    let err = read_session_history_from_source_for_test_bounded(&source, 4)
        .expect_err("bounded Codex read must reject over-limit history");

    assert_over_limit(err, 4);
}

#[test]
fn codex_zstd_read_and_digest_are_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let day_dir = sessions_dir.join("2026").join("07").join("02");
    std::fs::create_dir_all(&day_dir).unwrap();
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = br#"{"type":"session_meta","timestamp":"2026-07-02T10:00:00Z"}"#;
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
    std::fs::write(path, &compressed).unwrap();
    let source = codex_source(&sessions_dir, thread_id);

    let bytes =
        read_session_history_from_source_for_test_bounded(&source, history.len() as u64).unwrap();
    let digest = digest_session_history_from_source_bounded(&source, history.len() as u64).unwrap();

    assert_eq!(bytes, history);
    assert_eq!(digest.size_bytes, history.len() as u64);
    assert_eq!(digest.sha256_hex, hex::encode(Sha256::digest(history)));
}

#[test]
fn codex_zstd_finalization_source_falls_back_to_decoded_when_encoded_exceeds_cap() {
    let dir = tempfile::tempdir().unwrap();
    let sessions_dir = dir.path().join("sessions");
    let day_dir = sessions_dir.join("2026").join("07").join("02");
    std::fs::create_dir_all(&day_dir).unwrap();
    let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
    let history = b"a";
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    assert!(
        compressed.len() > history.len(),
        "fixture must be larger when encoded"
    );
    let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
    std::fs::write(path, compressed).unwrap();
    let source = codex_source(&sessions_dir, thread_id);

    let source = resolve_session_history_from_source(&source)
        .unwrap()
        .into_content_bounded(history.len() as u64)
        .unwrap();

    match source {
        SessionHistoryContent::Decoded(bytes) => assert_eq!(bytes, history),
        SessionHistoryContent::CodexZstd { .. } => {
            panic!("oversized encoded body should fall back to decoded history")
        }
    }
}

#[test]
fn bounded_read_allows_literal_history_with_u64_max_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_history_file(&dir, "history.jsonl", b"abcde");

    let bytes =
        read_session_history_from_payload_bounded(path.to_str().unwrap(), u64::MAX).unwrap();

    assert_eq!(bytes, b"abcde");
}

#[test]
fn bounded_read_allows_zstd_history_at_decoded_limit() {
    let dir = tempfile::tempdir().unwrap();
    let max_bytes = 1024;
    let history = vec![b'a'; max_bytes as usize];
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

    let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
        .expect("bounded zstd read must allow history exactly at the decoded cap");

    assert_eq!(bytes, history);
}

#[test]
fn bounded_read_rejects_truncated_zstd_history_at_decoded_limit() {
    let dir = tempfile::tempdir().unwrap();
    let max_bytes = 1024;
    let history = vec![b'a'; max_bytes as usize];
    let mut compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    compressed.pop().expect("encoded fixture must not be empty");
    let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

    let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
        .expect_err("bounded zstd read must reject truncated history at the decoded cap");

    let message = err.to_string();
    assert!(
        message.contains("Failed to decompress zstd session history"),
        "expected decompression error for truncated zstd history, got: {message}"
    );
}

#[test]
fn bounded_read_rejects_zstd_history_over_decoded_limit() {
    let dir = tempfile::tempdir().unwrap();
    let max_bytes = 1024;
    let history = vec![b'a'; max_bytes as usize + 1];
    let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
    assert!(
        compressed.len() <= max_bytes as usize,
        "test fixture should be smaller than the decoded cap"
    );
    let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

    let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
        .expect_err("bounded zstd read must reject over-limit decoded history");

    assert_over_limit(err, max_bytes);
}
