use super::super::super::*;
use super::super::support::{
    context_with_session, mock_run_config_with_overrides_and_api_url, push_job, shutdown,
    test_profiles, wait_budget_count, wait_cancel_handle,
};
use httpmock::prelude::*;
use sandbox::{
    ExecTermination, ProcessControlAck, ProcessControlFailureKind, ProcessControlGuestStatus,
    ProcessControlOutcome, ProcessControlWriteState, ProcessExit,
};
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

enum ForcedCancellation {
    Terminal(ExecTermination),
    Diagnostic,
    SendFailure,
    WaitFailure,
}

fn guest_status(status: ProcessControlGuestStatus) -> ProcessControlOutcome {
    ProcessControlOutcome::GuestStatus {
        status,
        diagnostic: "Broken pipe (os error 32)".into(),
    }
}

#[tokio::test]
async fn cooperative_failure_classification_preserves_completion_and_retirement() {
    let server = MockServer::start_async().await;
    let telemetry = server
        .mock_async(|when, then| {
            when.method(POST).path("/api/webhooks/agent/telemetry");
            then.status(200)
                .json_body(serde_json::json!({"success": true, "id": "ok"}));
        })
        .await;
    for (control, forced, expected_level) in [
        (
            guest_status(ProcessControlGuestStatus::SinkClosed),
            ForcedCancellation::Terminal(ExecTermination::Cancelled),
            Level::INFO,
        ),
        (
            guest_status(ProcessControlGuestStatus::Inactive),
            ForcedCancellation::Terminal(ExecTermination::Exited { exit_code: 0 }),
            Level::INFO,
        ),
        (
            ProcessControlOutcome::Failed {
                kind: ProcessControlFailureKind::Operation,
                write_state: ProcessControlWriteState::PossiblyWritten,
                error: std::io::Error::from_raw_os_error(libc::EPIPE),
            },
            ForcedCancellation::Terminal(ExecTermination::Cancelled),
            Level::INFO,
        ),
        (
            guest_status(ProcessControlGuestStatus::SinkError),
            ForcedCancellation::Terminal(ExecTermination::Cancelled),
            Level::WARN,
        ),
        (
            ProcessControlOutcome::Failed {
                kind: ProcessControlFailureKind::BackendCrashed,
                write_state: ProcessControlWriteState::PossiblyWritten,
                error: std::io::Error::from_raw_os_error(libc::EPIPE),
            },
            ForcedCancellation::Terminal(ExecTermination::Cancelled),
            Level::WARN,
        ),
        (
            guest_status(ProcessControlGuestStatus::SinkClosed),
            ForcedCancellation::SendFailure,
            Level::WARN,
        ),
        (
            guest_status(ProcessControlGuestStatus::SinkClosed),
            ForcedCancellation::WaitFailure,
            Level::WARN,
        ),
        (
            guest_status(ProcessControlGuestStatus::SinkClosed),
            ForcedCancellation::Terminal(ExecTermination::WaitFailed),
            Level::WARN,
        ),
        (
            guest_status(ProcessControlGuestStatus::SinkClosed),
            ForcedCancellation::Diagnostic,
            Level::WARN,
        ),
        (
            ProcessControlOutcome::Delivered(ProcessControlAck {
                message_id: "wrong-id".into(),
            }),
            ForcedCancellation::Terminal(ExecTermination::Cancelled),
            Level::WARN,
        ),
    ] {
        let wrong_ack = matches!(control, ProcessControlOutcome::Delivered(_));
        let captured = CapturedEvents::default();
        let _subscriber =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
        let wait_gate = MockLifecycleGate::new();
        let mut overrides = MockSandboxOverrides::new();
        overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
        overrides.push_process_control_outcome(control);
        match forced {
            ForcedCancellation::Terminal(termination) => {
                let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
                exit.termination = termination;
                overrides.push_wait_process_exit(exit);
            }
            ForcedCancellation::Diagnostic => {
                let mut exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
                exit.termination = ExecTermination::Cancelled;
                exit.diagnostic = "containment cleanup failed".into();
                overrides.push_wait_process_exit(exit);
            }
            ForcedCancellation::SendFailure => {
                overrides.push_process_cancel_error("cancel send failed")
            }
            ForcedCancellation::WaitFailure => {
                overrides.set_wait_process_error("terminal wait failed")
            }
        }
        let overrides = Arc::new(overrides);
        let (config, env) = mock_run_config_with_overrides_and_api_url(
            test_profiles(),
            4,
            8192,
            4,
            Arc::clone(&overrides),
            &server.base_url(),
        );
        let budget = Arc::clone(&config.capacity.budget);
        let run_handle = tokio::spawn(run(config));
        let run_id = RunId::new_v4();
        push_job(
            &env,
            run_id,
            "vm0/default",
            Some(context_with_session(run_id, "cancel-race")),
        );
        wait_gate
            .wait_entered(1, Duration::from_secs(5))
            .await
            .unwrap();
        let cancellation =
            wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
        cancellation.request_cooperative_user_cancellation().await;

        let completion = env
            .handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(completion.exit_code, 137);
        assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
        wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
        assert_eq!(overrides.stop_call_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert_eq!(env.idle_pool.lock().await.len(), 0);
        assert_eq!(overrides.process_cancel_calls().len(), 1);
        shutdown(&env, run_handle).await;
        let events = captured.entries();
        let message = if wrong_ack {
            "guest acknowledged the wrong user-cancellation message"
        } else {
            "failed to send cooperative user cancellation"
        };
        let classified: Vec<_> = events
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str) == Some(message)
                    && event.fields.get("run_id") == Some(&run_id.to_string())
            })
            .collect();
        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].level, expected_level);
        if expected_level == Level::INFO {
            assert_eq!(
                classified[0]
                    .fields
                    .get("recovered_after_cancellation")
                    .map(String::as_str),
                Some("true")
            );
        }
    }
    telemetry.assert_calls_async(10).await;
}
