use guest_contracts::diagnostics::FailureReason;
use sandbox::{
    GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter, ProcessControlAck,
    ProcessControlOutcome,
};
use serde_json::json;

use super::*;
use crate::executor::ExecutionFailure;

fn reconnect_entry() -> serde_json::Value {
    json!({
        "type": "http",
        "method": "GET",
        "url": "https://chatgpt.com/backend-api/wham/accounts/check?workspace=default",
        "status": 502,
        "firewall_name": "model-provider:codex-oauth-token",
        "firewall_error": "codex_oauth_reconnect_required",
    })
}

fn jsonl(entry: &serde_json::Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(entry).unwrap();
    bytes.push(b'\n');
    bytes
}

async fn run_discovery_failure(
    network_log: Option<&[u8]>,
    framework: AgentFramework,
    reason: Option<FailureReason>,
    error: &str,
) -> ExecutionFailure {
    let dir = tempfile::tempdir().unwrap();
    let config = test_executor_config(dir.path()).await;
    let context = codex_oauth_context();
    if let Some(bytes) = network_log {
        tokio::fs::write(config.log_paths.network_log(context.run_id), bytes)
            .await
            .unwrap();
    }
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    drop(sender);
    // Codex also starts a catalog prefetch process. Bind the failed exit to
    // the Agent handle so concurrent helper waits cannot consume its result.
    overrides.push_start_agent_process_handle(GuestProcessHandle::new(
        42,
        Some(receiver),
        Some(GuestProcessControlHandle::new_with_outcome(
            |message_id, _, _| {
                Box::pin(async move {
                    ProcessControlOutcome::Delivered(ProcessControlAck { message_id })
                })
            },
        )),
        GuestProcessWaiter::new(|_| {
            Box::pin(async { Ok(ProcessExit::new(42, 1, Vec::new(), Vec::new())) })
        }),
    ));
    let mut diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        framework,
        PromptMetadata::from_prompt("continue"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::CodexJsonl);
    diagnostic.failure_reason = reason;
    overrides.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));
    overrides.push_read_file_result(Ok(Some(error.as_bytes().to_vec())));
    let factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);

    let outcome = run_new_sandbox_outcome(&factory, &context, &config, &default_params())
        .await
        .unwrap();

    let failure = outcome
        .failure
        .expect("discovery failure remains a failed Run");
    assert_eq!(failure.kind, ExecutionFailureKind::Generic);
    assert_eq!(failure.exit_code, 1);
    assert_eq!(failure.error, error);
    failure
}

#[tokio::test]
async fn codex_reconnect_preserves_failed_run_and_restores_failure_reason() {
    let failure = run_discovery_failure(
        Some(&jsonl(&reconnect_entry())),
        AgentFramework::Codex,
        None,
        "workspace routing discovery failed",
    )
    .await;

    let diagnostic = failure.diagnostic.unwrap();
    assert_eq!(
        diagnostic.failure_reason,
        Some(FailureReason::ReconnectRequired)
    );
    assert_eq!(diagnostic.failure_class, FailureClass::CliNonzero);
    assert_eq!(diagnostic.framework, AgentFramework::Codex);
    assert_eq!(diagnostic.cli_exit_code, Some(1));
    assert_eq!(diagnostic.failure_detail_source, None);
}

#[tokio::test]
async fn codex_reconnect_requires_managed_auth_evidence_for_the_discovery_request() {
    let original = reconnect_entry();
    let mut cases = Vec::new();
    for (field, value) in [
        ("type", json!("tcp")),
        ("method", json!("POST")),
        ("status", json!(401)),
        ("firewall_name", json!("connector:other")),
        ("firewall_error", json!("TOKEN_REFRESH_FAILED")),
        (
            "url",
            json!("https://example.com/backend-api/wham/accounts/check"),
        ),
        (
            "url",
            json!("https://chatgpt.com/backend-api/codex/responses"),
        ),
        (
            "url",
            json!("http://chatgpt.com/backend-api/wham/accounts/check"),
        ),
        (
            "url",
            json!("https://chatgpt.com:8443/backend-api/wham/accounts/check"),
        ),
    ] {
        let mut entry = original.clone();
        entry[field] = value;
        cases.push(jsonl(&entry));
    }
    cases.push(jsonl(&json!({"response_body": original})));
    cases.push(serde_json::to_vec(&reconnect_entry()).unwrap());
    cases.push(b"malformed JSON\n".to_vec());
    let mut unfinished = jsonl(&reconnect_entry());
    unfinished.extend_from_slice(b"{\"type\":");
    cases.push(unfinished);

    for bytes in &cases {
        let failure = run_discovery_failure(
            Some(bytes),
            AgentFramework::Codex,
            None,
            "workspace routing discovery failed",
        )
        .await;
        assert_eq!(failure.diagnostic.unwrap().failure_reason, None);
    }
    let failure = run_discovery_failure(
        None,
        AgentFramework::Codex,
        None,
        "workspace routing discovery failed",
    )
    .await;
    assert_eq!(failure.diagnostic.unwrap().failure_reason, None);
}

#[tokio::test]
async fn codex_reconnect_keeps_existing_failure_reasons_and_other_failures() {
    let bytes = jsonl(&reconnect_entry());
    for (framework, reason, error) in [
        (
            AgentFramework::Codex,
            Some(FailureReason::ProviderServerError),
            "workspace routing discovery failed",
        ),
        (AgentFramework::Codex, None, "unrelated discovery failure"),
        (
            AgentFramework::ClaudeCode,
            None,
            "workspace routing discovery failed",
        ),
    ] {
        let failure = run_discovery_failure(Some(&bytes), framework, reason, error).await;
        let diagnostic = failure.diagnostic.unwrap();
        assert_eq!(diagnostic.failure_reason, reason);
        assert_eq!(
            diagnostic.failure_detail_source,
            Some(FailureDetailSource::CodexJsonl)
        );
    }
}

#[tokio::test]
async fn codex_reconnect_does_not_reuse_evidence_superseded_by_later_discovery() {
    for latest in [
        json!({
            "type": "http",
            "method": "GET",
            "url": "https://chatgpt.com/backend-api/wham/accounts/check",
            "status": 200,
        }),
        json!({
            "type": "http",
            "method": "GET",
            "url": "https://chatgpt.com/backend-api/wham/accounts/check",
            "status": 502,
            "firewall_name": "model-provider:codex-oauth-token",
            "firewall_error": "TOKEN_REFRESH_FAILED",
        }),
    ] {
        let mut bytes = jsonl(&reconnect_entry());
        bytes.extend_from_slice(&jsonl(&latest));
        let failure = run_discovery_failure(
            Some(&bytes),
            AgentFramework::Codex,
            None,
            "workspace routing discovery failed",
        )
        .await;
        assert_eq!(failure.diagnostic.unwrap().failure_reason, None);
    }
}

#[tokio::test]
async fn codex_reconnect_discards_evidence_before_an_unreadable_later_row() {
    // An append failure can leave a partial row. The proxy writer terminates
    // that row before its next batch, so a newline alone does not prove JSON.
    let mut wrong_status = reconnect_entry();
    wrong_status["status"] = json!("unreadable");
    let mut unreadable_url = reconnect_entry();
    unreadable_url["url"] = json!("[truncated]");
    for later_row in [
        b"{\"type\":\"http\",\"status\":200\n".to_vec(),
        jsonl(&wrong_status),
        jsonl(&unreadable_url),
    ] {
        let mut bytes = jsonl(&reconnect_entry());
        bytes.extend_from_slice(&later_row);
        let failure = run_discovery_failure(
            Some(&bytes),
            AgentFramework::Codex,
            None,
            "workspace routing discovery failed",
        )
        .await;
        assert_eq!(failure.diagnostic.unwrap().failure_reason, None);
    }
}

#[tokio::test]
async fn codex_reconnect_accepts_new_evidence_after_a_log_gap_and_unrelated_rows() {
    let mut bytes = b"{\"type\":\"http\",\"status\":200\n".to_vec();
    bytes.extend_from_slice(&jsonl(&reconnect_entry()));
    bytes.extend_from_slice(&jsonl(&json!({
        "type": "dns",
        "host": "example.com",
        "answers": [],
    })));
    bytes.extend_from_slice(&jsonl(&json!({
        "type": "http",
        "method": "GET",
        "url": "https://example.com/",
        "status": 200,
    })));
    let failure = run_discovery_failure(
        Some(&bytes),
        AgentFramework::Codex,
        None,
        "workspace routing discovery failed",
    )
    .await;
    assert_eq!(
        failure.diagnostic.unwrap().failure_reason,
        Some(FailureReason::ReconnectRequired)
    );
}

#[tokio::test]
async fn codex_reconnect_only_uses_complete_rows_in_a_bounded_log_suffix() {
    let row = jsonl(&reconnect_entry());
    let mut bytes = vec![b'x'; 128 * 1024];
    bytes.push(b'\n');
    bytes.extend_from_slice(&row);
    let failure = run_discovery_failure(
        Some(&bytes),
        AgentFramework::Codex,
        None,
        "workspace routing discovery failed",
    )
    .await;
    assert_eq!(
        failure.diagnostic.unwrap().failure_reason,
        Some(FailureReason::ReconnectRequired)
    );

    let mut bytes = row;
    bytes.extend_from_slice(&vec![b'x'; 128 * 1024]);
    let failure = run_discovery_failure(
        Some(&bytes),
        AgentFramework::Codex,
        None,
        "workspace routing discovery failed",
    )
    .await;
    assert_eq!(failure.diagnostic.unwrap().failure_reason, None);
}
