use super::*;
use crate::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};

fn proof() -> HomeCacheHistoryProof {
    HomeCacheHistoryProof {
        format_version: 1,
        generation: "74b68da0-6e0a-4adc-a68e-65a04c4885c4".into(),
        identity: SessionHistoryIdentity::new(
            SessionHistoryFramework::ClaudeCode,
            "a".repeat(64),
            SessionHistoryRefKind::Blob,
            "b".repeat(64),
            10,
            SessionHistorySourceRef::ClaudeCode {
                config_dir: "/home/user/.claude".into(),
                working_dir: "/home/user/workspace".into(),
                session_id: "session-1".into(),
            },
        )
        .unwrap(),
    }
}

#[test]
fn bounded_current_proof_round_trips() {
    let p = proof();
    assert_eq!(
        HomeCacheHistoryProof::from_json_slice(&p.to_json_vec().unwrap()).unwrap(),
        p
    );
    assert!(
        HomeCacheHistoryProof::from_json_slice(&vec![b' '; HOME_CACHE_HISTORY_PROOF_MAX_BYTES + 1])
            .is_err()
    );
    for generation in ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
        let mut bad = p.clone();
        bad.generation = generation.into();
        assert!(bad.validate().is_err());
    }
}

#[test]
fn current_source_and_request_are_required() {
    let p = proof();
    let expected = SessionHistoryIdentityExpectation::new(
        p.identity.framework,
        p.identity.session_id_hash.clone(),
        p.identity.history_ref_kind,
        p.identity.history_hash.clone(),
        p.identity.history_size_bytes,
    )
    .unwrap();
    let mut request = HomeCacheHistoryVerifyRequest {
        source: p.identity.history_source.clone(),
        expected,
        binding: HomeCacheHistoryProofBinding {
            proof: p,
            sha256: "c".repeat(64),
        },
    };
    assert!(request.validate().is_ok());
    request.expected.history_hash = "d".repeat(64);
    assert!(request.validate().is_err());
    request.expected.history_hash = "b".repeat(64);
    if let SessionHistorySourceRef::ClaudeCode { config_dir, .. } = &mut request.source {
        *config_dir = "/home/user/other".into();
    }
    assert!(request.validate().is_err());
}

#[test]
fn membership_rejects_escape_and_out_of_home_sources() {
    for config_dir in [
        "/home/user/../other",
        "/home/user/.claude/./state",
        "/home/user2/.claude",
        "/tmp/.claude",
    ] {
        let source = SessionHistorySourceRef::ClaudeCode {
            config_dir: config_dir.into(),
            working_dir: "/home/user/workspace".into(),
            session_id: "session-1".into(),
        };
        assert!(validate_home_source(&source).is_err());
    }
}
