use super::*;
use crate::restored_session_identity::RestoredSessionIdentity;
use guest_contracts::session_history_identity::{SessionHistoryFramework, SessionHistoryRefKind};

#[test]
fn restored_session_identity_requires_valid_hash_ref() {
    let mut ctx = minimal_context();
    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-a", 12)));

    assert!(
        crate::executor::session_restore::restored_session_identity_from_context(&ctx).is_some()
    );

    ctx.resume_session = Some(ResumeSession::inline(
        "sess-identity-123".into(),
        "{}".into(),
    ));
    assert!(
        crate::executor::session_restore::restored_session_identity_from_context(&ctx).is_none()
    );

    ctx.resume_session = Some(resume_ref("../../etc/passwd", history_ref("hash-a", 12)));
    assert!(
        crate::executor::session_restore::restored_session_identity_from_context(&ctx).is_none()
    );
}

#[test]
fn restored_session_identity_maps_request_boundary_types() {
    let cases = [
        (
            claude_context(),
            "sess-identity-claude",
            SessionHistoryFramework::ClaudeCode,
        ),
        (
            codex_context(),
            CODEX_SESSION_ID,
            SessionHistoryFramework::Codex,
        ),
        (
            pi_context(),
            "sess-identity-pi",
            SessionHistoryFramework::Pi,
        ),
    ];

    for (mut ctx, session_id, framework) in cases {
        ctx.resume_session = Some(resume_ref(session_id, history_ref("hash-a", 12)));

        let actual = crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("request identity");
        let expected = RestoredSessionIdentity::new(
            framework,
            session_id,
            SessionHistoryRefKind::Blob,
            "hash-a",
            Some(12),
        );

        assert_eq!(actual, expected);
    }
}

#[test]
fn restored_session_identity_changes_with_framework_session_and_history_hash() {
    let mut ctx = claude_context();
    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-a", 12)));
    let claude_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("claude identity");

    ctx.resume_session = Some(resume_ref("sess-identity-123", history_ref("hash-b", 12)));
    let different_hash_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("different hash identity");
    assert_ne!(claude_identity, different_hash_identity);

    ctx.resume_session = Some(resume_ref("sess-identity-other", history_ref("hash-a", 12)));
    let different_session_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("different session identity");
    assert_ne!(claude_identity, different_session_identity);

    ctx = codex_context();
    ctx.resume_session = Some(resume_ref(CODEX_SESSION_ID, history_ref("hash-a", 12)));
    let codex_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("codex identity");
    assert_ne!(claude_identity, codex_identity);

    ctx.resume_session = Some(resume_ref(
        CODEX_SESSION_ID_COMPACT_UPPERCASE,
        history_ref("hash-a", 12),
    ));
    let codex_compact_uppercase_identity =
        crate::executor::session_restore::restored_session_identity_from_context(&ctx)
            .expect("codex compact uppercase identity");
    assert_eq!(codex_identity, codex_compact_uppercase_identity);
}
