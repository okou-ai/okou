//! Codex terminal-result precedence when heartbeat becomes ready afterward.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::ActiveInputRuntime;
use guest_agent::cli::test_support::CodexTurnStartGate;
use guest_agent::cli::{CliExecutionControls, HeartbeatStatus};
use guest_agent::error::AgentError;
use guest_agent::heartbeat::HeartbeatFailure;
use guest_agent::masker::SecretMasker;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn codex_terminal_result_written_before_heartbeat_remains_authoritative()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-heartbeat-result-precedence-test",
                prompt: "complete before heartbeat becomes ready",
                scenario: Some("runtime-turn-complete-before-heartbeat"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let (heartbeat_tx, heartbeat_rx) = oneshot::channel();
    let (terminal_buffered_tx, terminal_buffered_rx) = oneshot::channel();
    let (heartbeat_delivered_tx, heartbeat_delivered_rx) = oneshot::channel();
    let (heartbeat_ready_tx, heartbeat_ready_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();
    let active_input =
        ActiveInputRuntime::new_disabled(&runtime.config.run_id, &runtime.config.prompt);
    let controls =
        CliExecutionControls::new(active_input.into_writer(), CancellationToken::new(), None)
            .with_codex_turn_start_gate(CodexTurnStartGate {
                terminal_buffered: terminal_buffered_tx,
                heartbeat_delivered: heartbeat_delivered_rx,
                heartbeat_ready: heartbeat_ready_tx,
                resume: resume_rx,
            });

    let driver = async move {
        assert!(
            terminal_buffered_rx.await.expect("reach event arbitration"),
            "terminal completion must be buffered before heartbeat delivery"
        );
        // Execution is paused before arbitration, so successful send proves
        // delivery to the same receiver the backend will poll after release.
        assert!(
            heartbeat_tx
                .send(HeartbeatStatus::Failed(HeartbeatFailure {
                    error: AgentError::Execution(
                        "heartbeat failed after terminal result was buffered".to_string(),
                    ),
                    diagnostic: common::test_heartbeat_failure_diagnostic(),
                }))
                .is_ok(),
            "deliver heartbeat failure before arbitration"
        );
        heartbeat_delivered_tx
            .send(())
            .expect("acknowledge heartbeat delivery");
        assert!(
            heartbeat_ready_rx
                .await
                .expect("observe heartbeat readiness"),
            "heartbeat failure must be ready before arbitration resumes"
        );
        resume_tx.send(()).expect("resume event arbitration");
    };

    let masker = SecretMasker::from_raw("");
    let execution = guest_agent::cli::execute_cli_with_controls_for_config_started_at(
        &masker,
        Some(heartbeat_rx),
        runtime.http.clone(),
        controls,
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(execution, driver)
    })
    .await
    .expect("gated execution should return promptly");
    let result = result?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert!(result.cli_termination.is_none());
    assert!(result.heartbeat.is_none());

    Ok(())
}
