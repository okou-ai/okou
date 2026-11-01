use super::*;
use std::collections::HashSet;

#[test]
fn session_history_path_structure() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("claude-config");
    let config_dir = config_dir.to_str().unwrap();

    let result = build_session_history_path("test-session-123", config_dir);

    let expected = format!("{config_dir}/projects/-home-user-workspace/test-session-123.jsonl");
    assert_eq!(result, Some(expected));
}

#[test]
fn session_history_creates_directory() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("claude-config");
    let config_dir_str = config_dir.to_str().unwrap();

    let _ = build_session_history_path("test-session", config_dir_str);

    let expected_dir = config_dir.join("projects/-home-user-workspace");
    assert!(expected_dir.exists());
}

#[test]
fn session_history_path_rejects_non_contract_session_ids() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().join("claude-config");
    let config_dir_str = config_dir.to_str().unwrap();

    for session_id in [
        "",
        ".",
        "..",
        "../escape",
        "..\\escape",
        "/absolute",
        "nested/path",
        "nested\\path",
        "line\nbreak",
        "session.with.dot",
        "é",
    ] {
        assert_eq!(build_session_history_path(session_id, config_dir_str), None);
    }
    let overlong_id = "a".repeat(129);
    assert_eq!(
        build_session_history_path(&overlong_id, config_dir_str),
        None
    );
    assert!(!config_dir.exists());
}

#[test]
fn session_id_has_mock_prefix() {
    let id = generate_session_id();
    assert!(id.starts_with("mock-"));
}

#[test]
fn session_id_has_canonical_uuid_suffix() {
    let id = generate_session_id();
    let suffix = id.strip_prefix("mock-").expect("mock prefix");
    let parsed = Uuid::parse_str(suffix).expect("uuid suffix");

    assert_eq!(parsed.to_string(), suffix);
}

#[test]
fn session_id_unique_without_sleep() {
    let mut ids = HashSet::new();

    for _ in 0..1024 {
        let id = generate_session_id();
        assert!(ids.insert(id), "generated duplicate session id");
    }
}

#[test]
fn session_id_unique_across_threads() {
    let handles = (0..16)
        .map(|_| std::thread::spawn(|| (0..64).map(|_| generate_session_id()).collect::<Vec<_>>()))
        .collect::<Vec<_>>();
    let mut ids = HashSet::new();

    for handle in handles {
        for id in handle.join().expect("session id worker should not panic") {
            assert!(ids.insert(id), "generated duplicate session id");
        }
    }
}
