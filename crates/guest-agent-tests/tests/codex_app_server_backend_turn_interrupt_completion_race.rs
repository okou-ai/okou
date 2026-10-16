//! Cancellation must retain a natural terminal turn that races interruption.

use guest_agent_tests as common;

use std::time::Duration;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn cancellation_ingests_completion_that_races_the_interrupt_error()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-turn-interrupt-completion-race-test",
                prompt: "complete while this turn is interrupted",
                scenario: Some("complete-before-turn-interrupt"),
                resume_session_id: None,
            },
        )?;
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let masker = SecretMasker::from_raw("");
    let cancellation = CancellationToken::new();
    let execution = common::execute_cli_with_cancellation_for_runtime(
        &runtime,
        &masker,
        common::spawn_dummy_heartbeat(),
        cancellation.clone(),
    );
    tokio::pin!(execution);
    let ready_file = tmp.path().join(common::MOCK_CODEX_ACTIVE_TURN_READY_FILE);
    tokio::select! {
        result = &mut execution => {
            return Err(format!("Codex execution ended before the completion race: {result:?}").into());
        }
        ready = common::wait_for_file_contains(
            &ready_file,
            common::MOCK_CODEX_ACTIVE_TURN_READY_EVENT,
            Duration::from_secs(5),
        ) => ready?,
    }

    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(10), execution)
        .await
        .map_err(|_| std::io::Error::other("completion race did not finish"))??;

    assert_eq!(result.exit_code, 1);
    assert_eq!(
        result
            .cli_termination
            .ok_or_else(|| {
                std::io::Error::other("user cancellation omitted its termination diagnostic")
            })?
            .reason,
        CliTerminationReason::UserCancellation
    );
    common::wait_for_file_contains(
        &tmp.path()
            .join(common::MOCK_CODEX_TURN_INTERRUPT_READY_FILE),
        common::MOCK_CODEX_TURN_INTERRUPT_READY_EVENT,
        Duration::from_secs(1),
    )
    .await?;

    let log = std::fs::read_to_string(runtime.paths.agent_log_file())?;
    let completed = log
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .ok_or("missing raced turn.completed event")?;
    assert_eq!(
        completed.pointer("/turn/status").and_then(Value::as_str),
        Some("completed")
    );

    Ok(())
}
