//! Claude Code event delivery must reject an aggregate of individually valid
//! payloads that exceeds the queued-plus-in-flight byte budget.

mod common;

use common::json_fixture::JsonFieldTemplate;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::time::Duration;

const EVENT_BYTES: usize = 2 * 1024 * 1024;
const EVENT_COUNT: usize = 16;

#[tokio::test]
async fn claude_code_event_delivery_byte_overload_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();
    // One in-flight payload plus fifteen queued payloads crosses the byte budget;
    // fifteen queued payloads alone do not. This distinguishes queued-plus-in-flight
    // accounting from a queue-only implementation.
    let event = JsonFieldTemplate::new(
        &json!({
            "type": "assistant",
            "index": 0,
            "content": "x".repeat(EVENT_BYTES),
        }),
        "index",
    )?;
    let mut prompt = b"@ECHO-HANG@".to_vec();
    for index in 0..EVENT_COUNT {
        prompt.push(b'\n');
        event.write(&mut prompt, &index)?;
    }
    let prompt = String::from_utf8(prompt)?;

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
        then.status(200).delay(Duration::from_secs(30));
    });

    let masker = SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("aggregate byte overload should terminate promptly");

    let result = execution.expect("the live CLI should use controlled delivery termination");
    let error = result
        .control_error
        .expect("byte overload should be exposed as a control error")
        .to_string();
    assert!(
        error.contains("event delivery byte buffer exhausted") && error.contains("33554432 bytes"),
        "unexpected byte-overload error: {error}"
    );
    assert_eq!(result.last_event_sequence, None);
    assert_eq!(
        result
            .cli_termination
            .expect("delivery overload should record process-group termination")
            .reason,
        guest_contracts::diagnostics::CliTerminationReason::EventDelivery
    );
    assert_eq!(
        events.calls(),
        1,
        "the byte limit must include the one stalled request in flight"
    );

    Ok(())
}
