//! Byte pressure drops the oldest pending event while preserving recent output.

use guest_agent_tests as common;

use common::json_fixture::JsonFieldTemplate;
use guest_agent::masker::SecretMasker;
use serde_json::json;
use std::time::Duration;

const EVENT_BYTES: usize = 2 * 1024 * 1024;
const EVENT_COUNT: usize = 16;

#[tokio::test]
async fn claude_code_event_delivery_byte_overload_keeps_recent_events()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
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
    let mut prompt = b"@ECHO@".to_vec();
    for index in 0..EVENT_COUNT {
        prompt.push(b'\n');
        event.write(&mut prompt, &index)?;
    }
    prompt.push(b'\n');
    serde_json::to_writer(
        &mut prompt,
        &json!({"type":"result","marker":"byte-overload-finished"}),
    )?;
    let prompt = String::from_utf8(prompt)?;

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 1, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let runtime = common::guest_runtime_from_process_env()?;
    let agent_log_file = runtime.paths.agent_log_file().to_string();
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let execution = tokio::spawn(async move {
        tokio::time::timeout(
            Duration::from_secs(10),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await
    });
    let first = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        std::path::Path::new(&agent_log_file),
        "byte-overload-finished",
        Duration::from_secs(5),
    )
    .await?;
    let mut delivered = common::event_request_sequences(&first.request)?;
    first.respond(200)?;
    while delivered.last() != Some(&(EVENT_COUNT as u32)) {
        let request = server.next_request(Duration::from_secs(5)).await?;
        delivered.extend(common::event_request_sequences(&request.request)?);
        request.respond(200)?;
    }
    assert_eq!(
        delivered.len(),
        EVENT_COUNT,
        "exactly the oldest pending event should be evicted"
    );
    assert_eq!(
        delivered
            .iter()
            .copied()
            .filter(|sequence| *sequence >= 2)
            .collect::<Vec<_>>(),
        (2..=EVENT_COUNT as u32).collect::<Vec<_>>()
    );
    let result = tokio::time::timeout(Duration::from_secs(5), execution).await???;
    let result = result?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert_eq!(result.last_event_sequence, Some(EVENT_COUNT as u32));

    Ok(())
}
