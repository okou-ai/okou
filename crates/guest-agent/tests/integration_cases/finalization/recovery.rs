use super::support::*;
use crate::support::*;
use httpmock::prelude::*;
use serde_json::json;

#[tokio::test]
async fn native_finalization_keeps_history_and_reports_completion() {
    for recovery in [false, true] {
        for accepted in [false, true] {
            let api = SharedApiMock::new().await;
            let _files = SessionFinalizationFilesGuard::new();
            let _telemetry = FinalizationTelemetryGuard::new(&api);
            crate::common::ensure_canonical_workspace_for_test().unwrap();
            let mut runtime = finalization_runtime().unwrap();
            let session_id = "native-completion-session";
            let history = b"{\"type\":\"assistant\",\"message\":\"retained context\"}\n";
            let dir = write_retained_session_history(&mut runtime, session_id, history).unwrap();
            let path = claude_history_path(dir.path(), session_id);
            let complete = api.server().mock(|when, then| {
                when.method(POST)
                    .path("/api/webhooks/run/complete")
                    .json_body_includes(
                        json!({
                            "exitCode": if recovery { 1 } else { 0 },
                            "completion": {
                                "cliAgentType": "claude-code",
                                "cliAgentSessionId": session_id,
                                "cliAgentSessionHistoryDisposition": "native_only"
                            }
                        })
                        .to_string(),
                    );
                if accepted {
                    then.status(200).json_body(
                        json!({"success":true,"status": if recovery {"failed"} else {"completed"}}),
                    );
                } else {
                    then.status(400)
                        .json_body(json!({"error":"rejected completion"}));
                }
            });
            let metadata = finalization_session_metadata(&runtime);
            let prepared = if recovery {
                guest_agent::finalization::prepare_recovery_finalization_for_runtime(
                    &runtime, &metadata,
                )
                .await
            } else {
                guest_agent::finalization::prepare_finalization_for_runtime(&runtime, &metadata)
                    .await
            }
            .unwrap();
            let result =
                report_prepared_finalization(&runtime, if recovery { 1 } else { 0 }, prepared)
                    .await;
            assert_eq!(result.is_ok(), accepted);
            complete.assert_calls_async(1).await;
            assert_eq!(std::fs::read(&path).unwrap(), history);
        }
    }
}

#[tokio::test]
async fn recovery_completion_accepts_missing_local_history() {
    let api = SharedApiMock::new().await;
    let _files = SessionFinalizationFilesGuard::new();
    let _telemetry = FinalizationTelemetryGuard::new(&api);
    let mut runtime = finalization_runtime().unwrap();
    let dir = write_retained_session_history(&mut runtime, "missing-history", b"{}").unwrap();
    std::fs::remove_file(claude_history_path(dir.path(), "missing-history")).unwrap();
    let complete = api.server().mock(|when, then| {
        when.method(POST).path("/api/webhooks/run/complete")
            .json_body_includes(r#"{"exitCode":1,"completion":{"cliAgentSessionHistoryDisposition":"native_only"}}"#);
        then.status(200).json_body(json!({"success":true,"status":"failed"}));
    });
    create_native_recovery_finalization(&runtime).await.unwrap();
    complete.assert_calls_async(1).await;
}
