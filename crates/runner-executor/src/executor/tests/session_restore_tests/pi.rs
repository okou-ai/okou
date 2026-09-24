use super::*;

#[test]
fn restore_session_writes_pi_jsonl_to_canonical_directory() {
    let sandbox = MockSandbox::new("test");
    let session_id = "00000000-0000-4000-8000-000000000001";
    let history = br#"{"type":"session","id":"00000000-0000-4000-8000-000000000001"}"#;
    let mut ctx = pi_context();
    ctx.pi_session_id = Some(session_id.to_string());
    ctx.resume_session = Some(resume_ref_for_history(session_id, history));
    let session = materialized_bytes_session(session_id, history);

    let diagnostics = run_restore_session(restore_session(&sandbox, &ctx, &session)).unwrap();

    let writes = sandbox.write_file_calls();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].path,
        format!(
            "{}/restored-{session_id}.jsonl",
            api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
        )
    );
    assert_eq!(writes[0].content, history);
    assert_eq!(diagnostics.framework, "pi");
    assert_eq!(diagnostics.session_id, session_id);
    assert_eq!(diagnostics.bytes_in, history.len());
}
