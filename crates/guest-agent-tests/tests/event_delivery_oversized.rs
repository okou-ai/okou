//! Dropping the only irreducible event preserves successful CLI completion.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

#[tokio::test]
async fn irreducible_single_event_is_skipped_while_cli_completes()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    let prompt = [
        "@ECHO@".to_string(),
        json!({
            "type": "assistant",
            "content": "x".repeat(MAX_REQUEST_BYTES),
        })
        .to_string(),
    ]
    .join("\n");

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let system_log = tmp.path().join("system.log");
    let _log = common::SystemLogOverrideGuard::set(&system_log);
    let events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200);
    });

    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .expect("dropping an oversized event must not block CLI completion")?;
    assert_eq!(execution.exit_code, common::CLEAN_EXIT);
    assert!(execution.control_error.is_none());
    assert_eq!(execution.last_event_sequence, None);
    let log = std::fs::read_to_string(system_log)?;
    assert!(
        log.contains(
            "[WARN] [sandbox:guest-agent] Discarding oversized Claude Code event at sequence 0"
        ),
        "oversized event omitted its warning: {log}"
    );
    let source_event = prompt.split_once('\n').ok_or("missing source event")?.1;
    assert!(
        std::fs::read_to_string(runtime.paths.agent_log_file())?
            .lines()
            .any(|line| line == source_event)
    );
    events.assert_calls_async(0).await;

    Ok(())
}
