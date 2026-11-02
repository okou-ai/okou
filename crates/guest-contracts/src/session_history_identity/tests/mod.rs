use super::*;

#[test]
fn cli_framework_projects_to_session_history_wire_values() {
    for (framework, expected, wire_value) in [
        (
            crate::env::CliFramework::ClaudeCode,
            SessionHistoryFramework::ClaudeCode,
            "claude-code",
        ),
        (
            crate::env::CliFramework::Codex,
            SessionHistoryFramework::Codex,
            "codex",
        ),
        (
            crate::env::CliFramework::Pi,
            SessionHistoryFramework::Pi,
            "pi",
        ),
    ] {
        let projected = SessionHistoryFramework::from(framework);

        assert_eq!(projected, expected);
        assert_eq!(projected.as_str(), wire_value);
    }
}

fn valid_source() -> SessionHistorySourceRef {
    SessionHistorySourceRef::ClaudeCode {
        config_dir: "/home/user/.claude".to_string(),
        working_dir: "/home/user/workspace".to_string(),
        session_id: "session".to_string(),
    }
}

#[test]
fn session_history_identity_verify_exit_codes_are_stable() {
    assert_eq!(
        [
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_SUCCESS,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FAILURE,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_ARGS,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_METADATA_READ,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_INVALID_METADATA,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_FRAMEWORK_MISMATCH,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_EXPECTED_MISMATCH,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_READ,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_MISMATCH,
            SESSION_HISTORY_IDENTITY_VERIFY_EXIT_HISTORY_TOO_LARGE,
        ],
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
}

fn valid_identity() -> SessionHistoryIdentity {
    SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        12,
        valid_source(),
    )
    .unwrap()
}

#[test]
fn final_identity_round_trips_json() {
    let identity = valid_identity();
    let bytes = identity.to_json_vec().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(
        SessionHistoryIdentity::from_json_slice(&bytes).unwrap(),
        identity
    );
    assert_eq!(value["framework"], "claude-code");
    assert_eq!(value["historyRefKind"], "blob");
    assert!(value.get("version").is_none());
    assert!(value.get("historySource").is_some());
    assert!(value.get("historyMarkerPayload").is_none());
}

#[test]
fn final_identity_rejects_invalid_hashes() {
    let err = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "not-a-hash",
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        12,
        valid_source(),
    )
    .unwrap_err();
    assert_eq!(err, SessionHistoryIdentityError::InvalidSessionIdHash);

    let err = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "not-a-hash",
        12,
        valid_source(),
    )
    .unwrap_err();
    assert_eq!(err, SessionHistoryIdentityError::InvalidHistoryHash);
}

#[test]
fn final_identity_rejects_zero_history() {
    let err = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        0,
        valid_source(),
    )
    .unwrap_err();
    assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySize);
}

#[test]
fn final_identity_accepts_large_history_size() {
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        u64::MAX,
        valid_source(),
    )
    .unwrap();

    assert_eq!(identity.history_size_bytes, u64::MAX);
    assert_eq!(
        SessionHistoryIdentity::from_json_slice(&identity.to_json_vec().unwrap()).unwrap(),
        identity
    );
}

#[test]
fn final_identity_rejects_invalid_history_source() {
    let err = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        12,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: String::new(),
            working_dir: "/home/user/workspace".to_string(),
            session_id: "session".to_string(),
        },
    )
    .unwrap_err();
    assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySource);
}

#[test]
fn final_identity_rejects_history_source_from_another_framework() {
    let err = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        12,
        valid_source(),
    )
    .unwrap_err();

    assert_eq!(err, SessionHistoryIdentityError::InvalidHistorySource);
}

#[test]
fn final_identity_debug_redacts_sensitive_fields() {
    let identity = valid_identity();
    let debug = format!("{identity:?}");

    assert!(debug.contains("[redacted]"));
    assert!(!debug.contains(&identity.session_id_hash));
    assert!(!debug.contains(&identity.history_hash));
    assert!(!debug.contains("/home/user/.claude"));
    assert!(!debug.contains("/home/user/workspace"));
}

#[test]
fn verify_request_round_trips_and_rejects_unknown_fields() {
    let request = SessionHistoryIdentityVerifyRequest {
        metadata_path: "/runtime/final.json".to_string(),
        runtime_dir: "/runtime".to_string(),
        expectation: SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
        )
        .unwrap(),
    };
    request.validate().unwrap();
    let json = serde_json::to_string(&request).unwrap();
    assert_eq!(
        serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&json).unwrap(),
        request
    );

    let json = json.strip_suffix('}').unwrap().to_string() + ",\"command\":\"sh\"}";
    assert!(serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&json).is_err());

    let nested_json = serde_json::to_string(&request).unwrap().replace(
        "\"historySizeBytes\":12",
        "\"historySizeBytes\":12,\"command\":\"sh\"",
    );
    assert!(serde_json::from_str::<SessionHistoryIdentityVerifyRequest>(&nested_json).is_err());
}

#[test]
fn verify_request_validation_rejects_non_absolute_paths() {
    let request = SessionHistoryIdentityVerifyRequest {
        metadata_path: String::new(),
        runtime_dir: "/runtime".to_string(),
        expectation: SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
        )
        .unwrap(),
    };

    assert_eq!(
        request.validate(),
        Err(SessionHistoryIdentityVerifyRequestError::InvalidPath)
    );

    let request = SessionHistoryIdentityVerifyRequest {
        metadata_path: "runtime/final.json".to_string(),
        runtime_dir: "/runtime".to_string(),
        expectation: SessionHistoryIdentityExpectation::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            12,
        )
        .unwrap(),
    };
    assert_eq!(
        request.validate(),
        Err(SessionHistoryIdentityVerifyRequestError::InvalidPath)
    );
}

#[test]
fn final_identity_expectation_parses_cli_args_and_matches_identity() {
    let identity = valid_identity();
    assert_eq!(identity.framework.as_str(), "claude-code");
    assert_eq!(identity.history_ref_kind.as_str(), "blob");
    let expectation = SessionHistoryIdentityExpectation::from_cli_args([
        identity.framework.as_str(),
        &identity.session_id_hash,
        identity.history_ref_kind.as_str(),
        &identity.history_hash,
        &identity.history_size_bytes.to_string(),
    ])
    .unwrap();

    assert!(expectation.matches_identity(&identity));
}

#[test]
fn final_identity_expectation_accepts_large_history_size() {
    let expectation = SessionHistoryIdentityExpectation::new(
        SessionHistoryFramework::ClaudeCode,
        "a".repeat(64),
        SessionHistoryRefKind::Blob,
        "b".repeat(64),
        u64::MAX,
    )
    .unwrap();

    assert_eq!(expectation.history_size_bytes, u64::MAX);
}

#[test]
fn final_identity_expectation_detects_mismatch() {
    let identity = valid_identity();
    let expectation = SessionHistoryIdentityExpectation::new(
        identity.framework,
        identity.session_id_hash.clone(),
        identity.history_ref_kind,
        "c".repeat(64),
        identity.history_size_bytes,
    )
    .unwrap();

    assert!(!expectation.matches_identity(&identity));
}

#[test]
fn final_identity_expectation_debug_redacts_sensitive_fields() {
    let identity = valid_identity();
    let expectation = SessionHistoryIdentityExpectation::new(
        identity.framework,
        identity.session_id_hash.clone(),
        identity.history_ref_kind,
        identity.history_hash.clone(),
        identity.history_size_bytes,
    )
    .unwrap();
    let debug = format!("{expectation:?}");

    assert!(debug.contains("[redacted]"));
    assert!(!debug.contains(&identity.session_id_hash));
    assert!(!debug.contains(&identity.history_hash));
}
