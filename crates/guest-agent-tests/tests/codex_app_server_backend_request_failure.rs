//! Direct Codex native failure evidence through the real app-server backend.

use guest_agent::masker::SecretMasker;
use guest_agent_tests as common;
use guest_contracts::codex_failure::{
    CodexFailureEvidence, CodexFailureStage as Stage, CodexNativeFailureKind as Kind,
};
use guest_contracts::diagnostics::{FailureClass, FailureDetailSource, FailureReason};
use serde_json::Value;
use std::time::Duration;

const SEND_ERROR: &str = "stream disconnected before completion: error sending request";

#[tokio::test]
async fn native_request_failure_retains_evidence_and_progress_without_claiming_recovery()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let original_directory = std::env::current_dir()?;
    let cases = [
        (
            "runtime-turn-failed-request-send",
            None,
            Some(Stage::RequestSend),
            Some(Kind::Other),
            None,
        ),
        (
            "runtime-request-send-error",
            None,
            Some(Stage::RequestSend),
            Some(Kind::Other),
            None,
        ),
        (
            "runtime-turn-failed-remote-compaction-request-send",
            None,
            Some(Stage::RemoteCompaction),
            Some(Kind::Other),
            None,
        ),
        (
            "runtime-turn-failed-http-connection",
            None,
            Some(Stage::HttpConnection),
            Some(Kind::HttpConnectionFailed),
            Some(503),
        ),
        (
            "runtime-turn-failed-http-connection-stderr",
            None,
            Some(Stage::HttpConnection),
            Some(Kind::HttpConnectionFailed),
            Some(503),
        ),
        (
            "runtime-turn-failed-malformed-http-status",
            None,
            Some(Stage::HttpConnection),
            Some(Kind::HttpConnectionFailed),
            None,
        ),
        (
            "runtime-turn-failed-response-stream-connection-failed",
            Some(FailureReason::ResponseConnectionLost),
            Some(Stage::ResponseConnection),
            Some(Kind::ResponseStreamConnectionFailed),
            Some(502),
        ),
        (
            "runtime-turn-failed-response-stream-disconnected",
            Some(FailureReason::ResponseConnectionLost),
            Some(Stage::ResponseStream),
            Some(Kind::ResponseStreamDisconnected),
            Some(502),
        ),
        (
            "runtime-turn-failed-response-too-many-failed-attempts",
            None,
            None,
            Some(Kind::ResponseTooManyFailedAttempts),
            Some(401),
        ),
        (
            "runtime-turn-failed-request-send-unauthorized",
            Some(FailureReason::InvalidCredentials),
            None,
            None,
            None,
        ),
        ("runtime-turn-failed-unknown", None, None, None, None),
    ];

    // The fixture owns process-global environment/current-directory setup.
    for (index, (scenario, reason, stage, kind, status)) in cases.into_iter().enumerate() {
        let tmp = tempfile::tempdir()?;
        let run_id = format!("codex-request-failure-{index}");
        unsafe {
            common::setup_codex_app_server_env(
                &mock,
                tmp.path(),
                common::CodexAppServerEnvConfig {
                    run_id: &run_id,
                    prompt: "retain native failure evidence",
                    scenario: Some(scenario),
                    resume_session_id: None,
                },
            )?;
        }
        let runtime = common::guest_runtime_from_process_env()?;
        let run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await??;
        assert_eq!(result.exit_code, 1, "{scenario}");
        assert!(result.control_error.is_none(), "{scenario}");
        let failure = guest_agent::failure_diagnostics::cli_nonzero_failure_for_config(
            &runtime.config,
            None,
            &result,
        );
        assert_eq!(failure.diagnostic.failure_class, FailureClass::CliNonzero);
        assert_eq!(
            failure.diagnostic.failure_detail_source,
            Some(
                if scenario == "runtime-turn-failed-http-connection-stderr" {
                    assert_eq!(failure.message, "native mock detail for failed request");
                    FailureDetailSource::Stderr
                } else {
                    FailureDetailSource::CodexJsonl
                }
            )
        );
        assert_eq!(failure.diagnostic.cli_exit_code, Some(1));
        assert_eq!(failure.diagnostic.failure_reason, reason, "{scenario}");
        assert_eq!(
            failure.diagnostic.model_request, None,
            "no fabricated attempt counts"
        );
        let expected = (stage.is_some() || kind.is_some()).then_some(CodexFailureEvidence {
            reported_stage: stage,
            native_kind: kind,
            http_status: status,
        });
        assert_eq!(failure.diagnostic.codex_failure, expected, "{scenario}");
        assert_eq!(
            result
                .failure_diagnostic
                .as_ref()
                .and_then(|d| d.codex_failure),
            expected
        );
        let diagnostic_path = tmp.path().join("native-failure.json");
        guest_agent::failure_diagnostics::write_guest_failure_diagnostic(
            diagnostic_path.to_str().ok_or("invalid fixture path")?,
            &failure.diagnostic,
        );
        let restored: guest_contracts::diagnostics::FailureDiagnostic =
            serde_json::from_slice(&std::fs::read(&diagnostic_path)?)?;
        assert_eq!(restored, failure.diagnostic);

        if matches!(
            scenario,
            "runtime-turn-failed-request-send" | "runtime-request-send-error"
        ) {
            assert_eq!(failure.message, SEND_ERROR);
            let log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
            let events = log
                .lines()
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event["type"] == "turn.started")
                    .count(),
                1
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.pointer("/item/text").and_then(Value::as_str)
                        == Some("Partial answer before request sending failure"))
                    .count(),
                1
            );
            if scenario == "runtime-request-send-error" {
                assert!(events.iter().any(|event| event["type"] == "error"));
            } else {
                let completed = events
                    .iter()
                    .find(|event| event["type"] == "turn.completed")
                    .ok_or("missing failed turn")?;
                assert_eq!(completed["turn"]["status"], "failed");
                assert_eq!(completed["usage"], common::expected_codex_turn_usage());
            }
        }
        drop(run_files);
        std::env::set_current_dir(&original_directory)?;
    }
    Ok(())
}
