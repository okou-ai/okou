use super::*;

#[test]
fn accepts_contract_ids() {
    for id in [
        "abc-123",
        "sess_456",
        "550e8400-e29b-41d4-a716-446655440000",
        "mock-019c279d-ff8e-7000-8000-000000000001",
    ] {
        assert!(
            is_valid_cli_agent_session_id(id),
            "expected acceptance for {id:?}"
        );
    }

    assert!(is_valid_cli_agent_session_id(
        &"a".repeat(MAX_CLI_AGENT_SESSION_ID_BYTES)
    ));
}

#[test]
fn rejects_non_contract_ids() {
    for id in [
        "",
        ".",
        "..",
        "../escape",
        "..\\escape",
        "/absolute",
        "nested/path",
        "nested\\path",
        "session with space",
        "line\nbreak",
        "session.with.dot",
        "session:semicolon",
        "é",
    ] {
        assert!(
            !is_valid_cli_agent_session_id(id),
            "expected rejection for {id:?}"
        );
    }

    assert!(!is_valid_cli_agent_session_id(
        &"a".repeat(MAX_CLI_AGENT_SESSION_ID_BYTES + 1)
    ));
}
