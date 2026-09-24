use super::*;

#[tokio::test]
async fn restore_session_rejects_invalid_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let raw_session_id = "../../etc/passwd";
    let session = materialized_text_session(raw_session_id, "data");
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    let message = err.to_string();
    assert!(message.contains("invalid session_id"));
    assert!(
        !message.contains(raw_session_id),
        "invalid-session error must not echo raw session id: {message}"
    );
}

#[tokio::test]
async fn restore_session_rejects_invalid_codex_session_id() {
    // Path-traversal validation runs before framework dispatch, so codex
    // shares the same allow-list as claude-code.
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session("../../etc/passwd", "{}");
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("invalid session_id"));
}
