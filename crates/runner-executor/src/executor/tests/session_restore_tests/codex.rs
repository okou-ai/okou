use super::super::support::sandbox_write_file_error;
use super::*;
use sandbox::{ExecResult, ExecTermination};

#[test]
fn restore_session_writes_codex_session() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    ctx.resume_session = Some(resume_ref_for_history(CODEX_SESSION_ID, history.as_bytes()));
    let session = materialized_text_session(CODEX_SESSION_ID, history.clone());
    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.ends_with(CODEX_CANONICAL_ROLLOUT_SUFFIX),
        "codex resume history must be restored as a canonical rollout jsonl, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, session.history_bytes());
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_skips_codex_cleanup_in_fresh_sandbox() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    let session = materialized_text_session(CODEX_SESSION_ID, history.clone());

    let diagnostics =
        run_restore_session(restore_session_in_fresh_sandbox(&sandbox, &ctx, &session)).unwrap();

    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.codex_session_cleanup_calls().is_empty());
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, CODEX_CANONICAL_ROLLOUT_PATH);
    assert_eq!(writes[0].content, history.as_bytes());
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_keeps_agent_environment_out_of_codex_cleanup() {
    let sandbox = MockSandbox::new("test");
    let mut ctx = codex_context();
    ctx.environment = Some(std::collections::HashMap::from([
        (
            "OKOU_CODEX_RESTORE_SESSION_ID".to_string(),
            "user-session-id".to_string(),
        ),
        (
            "OKOU_CODEX_RESTORE_SESSION_FILENAME_KEY".to_string(),
            "user-filename-key".to_string(),
        ),
        (
            "OKOU_CODEX_RESTORE_SESSION_PATH".to_string(),
            "/tmp/user-restore-path".to_string(),
        ),
        (
            "OKOU_CODEX_SESSION_CLEANUP_SCAN_BUDGET".to_string(),
            "1".to_string(),
        ),
        ("USER_ENV_MARKER".to_string(), "user-value".to_string()),
    ]));
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);
}

#[test]
fn restore_session_writes_codex_session_at_existing_logical_path() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        format!("{CODEX_EXISTING_ROLLOUT_PATH}\n").into_bytes(),
        Vec::new(),
    )));
    let ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    let session = materialized_text_session(CODEX_SESSION_ID, history);

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, CODEX_EXISTING_ROLLOUT_PATH);
    assert_eq!(writes[0].content, session.history_bytes());
}

#[test]
fn restore_session_writes_codex_zstd_session() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    let compressed = zstd::encode_all(history.as_bytes(), 0).unwrap();
    let timestamp = chrono::DateTime::parse_from_rfc3339("2026-06-04T07:18:08.000Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let session = materialized_codex_zstd_session(CODEX_SESSION_ID, &compressed, timestamp);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0]
            .path
            .ends_with(&format!("{CODEX_CANONICAL_ROLLOUT_SUFFIX}.zst")),
        "codex zstd resume history must be restored as canonical rollout jsonl.zst, got {}",
        writes[0].path
    );
    assert_eq!(writes[0].content, compressed);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
}

#[test]
fn restore_session_writes_codex_zstd_session_at_existing_logical_path() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult::new(
        0,
        format!("{CODEX_EXISTING_ROLLOUT_PATH}\n").into_bytes(),
        Vec::new(),
    )));
    let ctx = codex_context();
    let history = codex_session_meta_history(CODEX_SESSION_ID);
    let compressed = zstd::encode_all(history.as_bytes(), 0).unwrap();
    let timestamp = chrono::DateTime::parse_from_rfc3339("2026-06-04T07:18:08.000Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let session = materialized_codex_zstd_session(CODEX_SESSION_ID, &compressed, timestamp);

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);
    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, format!("{CODEX_EXISTING_ROLLOUT_PATH}.zst"));
    assert_eq!(writes[0].content, compressed);
}

#[test]
fn restore_session_logs_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");

    let (result, events) = capture_restore_events(restore_session(&sandbox, &ctx, &session));

    let diagnostics = result.unwrap();
    assert_eq!(diagnostics.framework, "codex");
    assert_eq!(diagnostics.session_id, CODEX_SESSION_ID);
    assert_eq!(diagnostics.bytes_in, session.history_bytes().len());
    let restore_event = captured_event(&events, "restored session history");
    assert_eq!(
        restore_event.fields.get("framework").map(String::as_str),
        Some("codex")
    );
    assert_eq!(
        restore_event.fields.get("session_id").map(String::as_str),
        Some(CODEX_SESSION_ID)
    );
    assert!(
        !restore_event.fields.contains_key("path"),
        "restore diagnostic must not include a path embedding the session id: {restore_event:#?}"
    );
}

#[test]
fn restore_session_writes_codex_session_with_canonical_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        "{\"type\":\"thread.started\"}\n{not-json}\n",
    );

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = writes[0]
        .path
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, session.history_bytes());
}

#[test]
fn restore_session_writes_invalid_utf8_codex_history_with_fallback_filename() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let history =
        b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-06-04T07:18:08.000Z\"}}\n\xff\n";
    let session = materialized_bytes_session(CODEX_SESSION_ID, history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0].path.starts_with("/home/user/.codex/sessions/"),
        "codex resume history must be restored under codex sessions, got {}",
        writes[0].path
    );
    let filename = writes[0]
        .path
        .rsplit('/')
        .next()
        .expect("restored codex path should have a filename");
    assert!(
        filename.starts_with("rollout-"),
        "codex resume history filename must use rollout prefix, got {filename}"
    );
    assert!(
        filename.ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex resume history filename must include the thread id, got {filename}"
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.bytes_in, history.len());
}

#[test]
fn restore_session_canonicalizes_codex_session_id() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID_COMPACT_UPPERCASE, "{}\n");

    run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    assert_codex_cleanup_call(&sandbox);

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert!(
        writes[0]
            .path
            .ends_with(CODEX_CANONICAL_ROLLOUT_FILENAME_SUFFIX),
        "codex restore path must use canonical thread id, got {}",
        writes[0].path
    );
}

#[tokio::test]
async fn restore_session_rejects_short_codex_session_id_without_cleanup() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session("abc", "{}");

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("invalid codex session_id"), "got: {err}");
    assert!(
        !message.contains("abc"),
        "invalid codex error must not echo raw session id: {message}"
    );
    assert!(sandbox.exec_calls().is_empty());
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_rejects_decorated_codex_session_id_without_cleanup() {
    for raw_session_id in [
        "{019e9154-c304-70f0-adde-36efb1be1701}",
        "urn:uuid:019e9154-c304-70f0-adde-36efb1be1701",
    ] {
        let sandbox = MockSandbox::new("test");
        let ctx = codex_context();
        let session = materialized_text_session(raw_session_id, "{}");

        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

        let message = err.to_string();
        assert!(message.contains("invalid session_id"), "got: {err}");
        assert!(
            !message.contains(raw_session_id),
            "invalid codex error must not echo raw session id: {message}"
        );
        assert!(sandbox.exec_calls().is_empty());
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[tokio::test]
async fn restore_session_fails_when_codex_cleanup_fails() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        b"cleanup stdout".to_vec(),
        b"cleanup failed".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains("codex session cleanup failed"),
        "got: {message}"
    );
    assert!(message.contains("cleanup failed"), "got: {message}");
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_fails_when_codex_cleanup_exceeds_scan_budget() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        Vec::new(),
        b"codex session cleanup exceeded scan budget".to_vec(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed"));
    assert!(message.contains("codex session cleanup exceeded scan budget"));
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_rejects_malformed_codex_cleanup_success_output_without_path_leak() {
    for stdout in [
        CODEX_EXISTING_ROLLOUT_PATH.to_string(),
        format!("{CODEX_EXISTING_ROLLOUT_PATH}\nextra\n"),
        format!("{CODEX_EXISTING_ROLLOUT_PATH}.zst\n"),
        format!(
            "/home/user/.codex/sessions/2026/02/31/rollout-2026-02-31T04-01-04-{CODEX_SESSION_ID}.jsonl\n"
        ),
        "/home/user/.codex/sessions/2026/07/23/rollout-2026-07-23T04-01-04-019e9154-c304-70f0-adde-36efb1be1702.jsonl\n"
            .to_string(),
    ] {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            stdout.clone().into_bytes(),
            Vec::new(),
        )));
        let ctx = codex_context();
        let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");

        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

        let message = err.to_string();
        assert!(
            message.contains("invalid codex session cleanup output"),
            "got: {message}"
        );
        assert!(
            !message.contains(stdout.trim()),
            "invalid output must not disclose the candidate: {message}"
        );
        assert!(sandbox.write_file_calls().is_empty());
    }
}

#[tokio::test]
async fn restore_session_rejects_truncated_codex_cleanup_success_output() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::Exited { exit_code: 0 },
        guest_duration_ms: None,
        stdout: format!("{CODEX_EXISTING_ROLLOUT_PATH}\n").into_bytes(),
        stderr: Vec::new(),
        diagnostic: String::new(),
        stdout_truncated: true,
        stderr_truncated: false,
    }));
    let ctx = codex_context();
    let session = materialized_text_session(CODEX_SESSION_ID, "{}\n");

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    assert!(
        err.to_string()
            .contains("invalid codex session cleanup output")
    );
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_exec_result(Ok(ExecResult::new(
        1,
        format!("stdout includes {CODEX_SESSION_ID_NO_DASHES}").into_bytes(),
        format!("find: {CODEX_CANONICAL_ROLLOUT_PATH}: Permission denied").into_bytes(),
    )));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed"));
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_non_exited_codex_cleanup_failure_output() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_exec_result(Ok(ExecResult {
        termination: ExecTermination::WaitFailed,
        guest_duration_ms: None,
        stdout: format!("stdout includes {CODEX_SESSION_ID_NO_DASHES}").into_bytes(),
        stderr: format!("find: {CODEX_CANONICAL_ROLLOUT_PATH}: Permission denied").into_bytes(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains("codex session cleanup failed (wait failed)"));
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
    assert!(sandbox.write_file_calls().is_empty());
}

#[tokio::test]
async fn restore_session_preserves_codex_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to rename temp file to {CODEX_CANONICAL_ROLLOUT_PATH}: thread {CODEX_SESSION_ID_NO_DASHES}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_SESSION_ID_NO_DASHES),
        "got: {message}"
    );
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_codex_original_no_dash_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID_COMPACT_UPPERCASE,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {CODEX_SESSION_ID_COMPACT_UPPERCASE} at {CODEX_CANONICAL_ROLLOUT_PATH}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(CODEX_SESSION_ID_COMPACT_UPPERCASE),
        "got: {message}"
    );
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
    assert!(
        message.contains(CODEX_CANONICAL_ROLLOUT_PATH),
        "got: {message}"
    );
}

#[tokio::test]
async fn restore_session_preserves_codex_mixed_case_original_write_file_error() {
    let sandbox = MockSandbox::new("test");
    let ctx = codex_context();
    let session = materialized_text_session(
        CODEX_SESSION_ID_MIXED_CASE,
        codex_minimal_session_meta_history(CODEX_SESSION_ID),
    );
    sandbox.push_write_file_result(Err(sandbox_write_file_error(format!(
        "failed to write original thread {CODEX_SESSION_ID_MIXED_CASE} with canonical {CODEX_SESSION_ID}"
    ))));

    let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();

    let message = err.to_string();
    assert!(
        message.contains(CODEX_SESSION_ID_MIXED_CASE),
        "got: {message}"
    );
    assert!(message.contains(CODEX_SESSION_ID), "got: {message}");
}
