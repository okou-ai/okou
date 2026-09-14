use guest_contracts::diagnostics::{
    AgentFramework, EventDeliveryAcceptanceOutcome, EventDeliveryDiagnostic,
    EventDeliveryFailedBatchDiagnostic, FailureClass, FailureDetailSource, FailureDiagnostic,
    FailureReason, HttpAttemptFailureKind, HttpCompletedAttemptDiagnostic, PromptMetadata,
    SessionHistoryStatus,
};
use sandbox_mock::MockSandbox;

use super::super::super::diagnostics::{
    read_guest_cli_agent_session_id, read_guest_error_file, read_guest_failure_diagnostic_file,
};
use super::super::super::{SMALL_GUEST_FILE_MAX_BYTES, guest_runtime_path};
use super::super::support::sandbox_read_file_error;
use crate::ids::RunId;

#[tokio::test]
async fn read_guest_error_file_returns_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"checkpoint error: disk full".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert_eq!(msg.as_deref(), Some("checkpoint error: disk full"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(
            RunId::nil(),
            guest_contracts::runtime_paths::checkpoint_error_file
        )
        .unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"   \n  ".to_vec())));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_error_file_returns_none_on_read_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_read_file_error("guest read failed")));
    let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
    assert!(msg.is_none());
}

#[tokio::test]
async fn read_guest_cli_agent_session_id_returns_trimmed_content_from_runtime_path() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" session-abc \n".to_vec())));

    let session_id = read_guest_cli_agent_session_id(&sandbox, RunId::nil()).await;

    assert_eq!(session_id.as_deref(), Some("session-abc"));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(
            RunId::nil(),
            guest_contracts::runtime_paths::session_id_file
        )
        .unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_cli_agent_session_id_returns_none_on_missing_or_empty_file() {
    let missing = MockSandbox::new("test");
    missing.push_read_file_result(Ok(None));
    assert!(
        read_guest_cli_agent_session_id(&missing, RunId::nil())
            .await
            .is_none()
    );

    let empty = MockSandbox::new("test");
    empty.push_read_file_result(Ok(Some(b" \n ".to_vec())));
    assert!(
        read_guest_cli_agent_session_id(&empty, RunId::nil())
            .await
            .is_none()
    );
}

#[tokio::test]
async fn read_guest_cli_agent_session_id_rejects_invalid_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" ../session \n".to_vec())));

    let session_id = read_guest_cli_agent_session_id(&sandbox, RunId::nil()).await;

    assert!(session_id.is_none());
}

#[tokio::test]
async fn read_guest_cli_agent_session_id_rejects_overlong_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some("a".repeat(129).into_bytes())));

    let session_id = read_guest_cli_agent_session_id(&sandbox, RunId::nil()).await;

    assert!(session_id.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_valid_diagnostic() {
    let sandbox = MockSandbox::new("test");
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(1)
    .with_failure_detail_source(FailureDetailSource::ClaudeResult)
    .with_failure_reason(FailureReason::ProviderOverloaded)
    .with_session_history_status(SessionHistoryStatus::Present);
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&diagnostic).unwrap())));

    let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert_eq!(read, Some(diagnostic));
    let calls = sandbox.read_file_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].path,
        guest_runtime_path(
            RunId::nil(),
            guest_contracts::runtime_paths::failure_diagnostic_file
        )
        .unwrap()
    );
    assert_eq!(calls[0].max_bytes, SMALL_GUEST_FILE_MAX_BYTES);
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_accepts_unknown_schema_field() {
    let sandbox = MockSandbox::new("test");
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    );
    let mut json = serde_json::to_value(&diagnostic).unwrap();
    json["schemaVersion"] = serde_json::json!(999);
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&json).unwrap())));

    let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert_eq!(read, Some(diagnostic));
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_accepts_unknown_event_attempt_field() {
    let sandbox = MockSandbox::new("test");
    let diagnostic = FailureDiagnostic::new(
        FailureClass::EventUploadFailed,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("continue"),
    )
    .with_event_delivery(EventDeliveryDiagnostic {
        total_events: 1,
        total_batches: 1,
        failed_batches: 1,
        last_acknowledged_sequence: None,
        first_failed_batch: Some(EventDeliveryFailedBatchDiagnostic {
            first_sequence: 0,
            last_sequence: 0,
            event_count: 1,
            conservative_bytes: 128,
            outcome: EventDeliveryAcceptanceOutcome::OutcomeUnknown,
            attempts: vec![HttpCompletedAttemptDiagnostic {
                attempt: 1,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 10_000,
                failure_kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: None,
                connect_observed: None,
            }],
        }),
        drain_timeout: None,
    });
    let mut json = serde_json::to_value(&diagnostic).unwrap();
    json["eventDelivery"]["firstFailedBatch"]["attempts"][0]["futureTransportObservation"] =
        serde_json::json!(true);
    sandbox.push_read_file_result(Ok(Some(serde_json::to_vec(&json).unwrap())));

    let read = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert_eq!(read, Some(diagnostic));
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_missing_file() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(None));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_empty_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b" \n\t".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_malformed_json() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(b"{not-json".to_vec())));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_read_error() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Err(sandbox_read_file_error("guest read failed")));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}

#[tokio::test]
async fn read_guest_failure_diagnostic_file_returns_none_on_oversized_content() {
    let sandbox = MockSandbox::new("test");
    sandbox.push_read_file_result(Ok(Some(vec![
        b' ';
        SMALL_GUEST_FILE_MAX_BYTES as usize + 1
    ])));

    let diagnostic = read_guest_failure_diagnostic_file(&sandbox, RunId::nil()).await;

    assert!(diagnostic.is_none());
}
