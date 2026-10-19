//! User cancellation must interrupt an established Codex turn before shutdown.

use guest_agent_tests as common;

use std::time::Duration;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn user_cancellation_interrupts_the_active_codex_turn()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: "codex-app-server-active-turn-cancellation-test",
                prompt: "interrupt this active turn",
                scenario: Some("wait-for-turn-interrupt"),
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
            return Err(format!("Codex execution ended before active-turn cancellation: {result:?}").into());
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
        .map_err(|_| std::io::Error::other("active-turn cancellation did not finish"))??;

    assert_eq!(result.exit_code, 1);
    let error = result
        .control_error
        .as_ref()
        .ok_or_else(|| std::io::Error::other("user cancellation omitted its controlled error"))?;
    assert!(
        error.to_string().contains("Run cancelled by user"),
        "unexpected cancellation error: {error}"
    );
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

    let events = read_agent_log_events(&runtime.paths)?;
    let completed = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .ok_or("missing interrupted turn.completed event")?;
    assert_eq!(
        completed.pointer("/turn/status").and_then(Value::as_str),
        Some("interrupted")
    );

    Ok(())
}

fn read_agent_log_events(
    paths: &guest_agent::paths::GuestPaths,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let log = std::fs::read_to_string(paths.agent_log_file())?;
    log.lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}
