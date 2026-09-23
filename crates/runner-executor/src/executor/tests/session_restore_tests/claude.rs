use super::super::support::sandbox_write_file_error;
use super::*;
use sandbox::{SandboxError, SandboxInvalidStateContext, SandboxOperation};

#[test]
fn restore_session_writes_history() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = claude_context();
    let history = r#"{"type":"init"}"#;
    ctx.resume_session = Some(resume_ref_for_history("sess-abc-123", history.as_bytes()));
    let session = materialized_text_session("sess-abc-123", history);
    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_logs_claude_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let raw_session_id = "sess-sensitive-restore-17975";
    let session = materialized_text_session(raw_session_id, r#"{"type":"init"}"#);

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session));

    let diagnostics = result.unwrap();
    assert_eq!(diagnostics.framework, "claude-code");
    assert_eq!(diagnostics.session_id, raw_session_id);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
    let event = captured_event(&events, "restored session history");
    assert_eq!(
        event.fields.get("framework").map(String::as_str),
        Some("claude-code")
    );
    assert_eq!(
        event.fields.get("session_id").map(String::as_str),
        Some(raw_session_id)
    );
    assert!(
        !event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {event:#?}"
    );
}

#[test]
fn restore_session_unknown_framework_uses_claude_fallback() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = "custom-agent".into();
    let session = materialized_text_session("sess-1", "data");

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-1.jsonl"
    );
    assert_eq!(writes[0].content, b"data");
}

#[test]
fn restore_session_allows_empty_agent_type() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = minimal_context();
    ctx.cli_agent_type = String::new(); // empty defaults to claude-code
    let session = materialized_text_session("sess-1", "{}");
    // Should proceed (empty agent type treated as claude-code).
    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();
}

#[test]
fn restore_session_writes_invalid_utf8_claude_history_bytes() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let history = b"{\"type\":\"init\"}\n\xff\n";
    let session = materialized_bytes_session("sess-non-utf8-123", history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        "/home/user/.claude/projects/-home-user-workspace/sess-non-utf8-123.jsonl"
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[tokio::test]
async fn restore_session_preserves_claude_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let session_id = "sess-sensitive-write-17975";
    let session_path =
        "/home/user/.claude/projects/-home-user-workspace/sess-sensitive-write-17975.jsonl";
    let session = materialized_text_session(session_id, r#"{"type":"init"}"#);
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_write_file_invalid_state() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let session_id = "sess-invalid-state-17975";
    let session_path =
        "/home/user/.claude/projects/-home-user-workspace/sess-invalid-state-17975.jsonl";
    let session = materialized_text_session(session_id, r#"{"type":"init"}"#);
    sandbox.push_write_file_result(Err(SandboxError::InvalidState {
        context: SandboxInvalidStateContext::Operation(SandboxOperation::WriteFile),
        state: format!("blocked for {session_path}"),
        message: format!("cannot write session {session_id}"),
    }));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(session_id), "got: {message}");
    assert!(message.contains(session_path), "got: {message}");
}

#[tokio::test]
async fn restore_session_preserves_session_path_and_id_words() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let session_id = "session";
    let session_path = "/home/user/.claude/projects/-home-user-workspace/session.jsonl";
    let session = materialized_text_session(session_id, r#"{"type":"init"}"#);
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&format!("failed to write {session_path} for {session_id}")),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_short_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = claude_context();
    let session_id = "a";
    let session_path = "/home/user/.claude/projects/-home-user-workspace/a.jsonl";
    let session = materialized_text_session(session_id, r#"{"type":"init"}"#);
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write {session_path} for {session_id}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(&format!("failed to write {session_path} for {session_id}")),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_fails_on_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = minimal_context();
    let session = materialized_text_session("sess-abc", r#"{"type":"init"}"#);
    sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
    assert!(err.to_string().contains("disk full"), "got: {err}");
}
