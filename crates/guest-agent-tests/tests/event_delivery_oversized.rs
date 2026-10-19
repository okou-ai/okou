//! An event that cannot fit below the webhook request boundary must fail before
//! any network delivery attempt.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

#[tokio::test]
async fn oversized_single_event_fails_before_network_delivery()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    let prompt = [
        "@ECHO-HANG@".to_string(),
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
    .expect("oversized event should fail promptly")?;
    let error = execution
        .control_error
        .expect("oversized event should enter controlled delivery termination")
        .to_string();
    assert!(
        error.contains("exceeding the 4194304-byte request limit"),
        "unexpected oversized event error: {error}"
    );
    assert_eq!(
        execution
            .cli_termination
            .expect("oversized event should record process-group termination")
            .reason,
        guest_contracts::diagnostics::CliTerminationReason::EventDelivery
    );
    events.assert_calls_async(0).await;

    Ok(())
}
