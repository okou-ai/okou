//! A CLI event with no backlog must be sent immediately as a singleton batch.

mod common;

use guest_agent::masker::SecretMasker;
use serde_json::json;
use shell_quote::quote_shell_arg;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

const EVENT_MESSAGE: &str = "quoted \"message\" with slash \\\\ and newline\n你好 🚀";
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(5);

async fn request_without_clock_advance(
    server: &mut common::ControlledHttpServer,
) -> Result<common::ControlledRequest, String> {
    let started_at = std::time::Instant::now();
    while server.request_count() == 0 {
        if started_at.elapsed() >= LIVENESS_TIMEOUT {
            return Err(
                "singleton request did not arrive with time frozen and the producer held open"
                    .to_string(),
            );
        }
        // Stay runnable so paused Tokio time cannot auto-advance while the
        // real child process and HTTP socket become ready. Wall time only
        // bounds a stuck test; zero virtual elapsed time is the contract.
        tokio::task::yield_now().await;
    }
    server.next_request(LIVENESS_TIMEOUT).await
}

#[tokio::test]
async fn claude_code_sends_a_no_backlog_event_without_collection_delay()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let exit_gate_dir = tmp.path().join("exit-gate");
    std::fs::create_dir(&exit_gate_dir)?;
    let (mut exit_gate, exit_mock) =
        common::PostOpenMockGate::create(&exit_gate_dir, Path::new("/bin/true"))?;
    let live_mock = tmp.path().join("live-singleton-mock.sh");
    // The wrapper retains stdout after the mock emits its one event, so an
    // EOF-triggered drain cannot satisfy the live-dispatch assertion.
    std::fs::write(
        &live_mock,
        format!(
            "#!/bin/sh\n{} \"$@\" || exit \"$?\"\nexec {}\n",
            quote_shell_arg(&mock_cli.to_string_lossy()),
            quote_shell_arg(&exit_mock.to_string_lossy()),
        ),
    )?;
    std::fs::set_permissions(&live_mock, std::fs::Permissions::from_mode(0o700))?;
    let (mut start_gate, gated_mock) = common::PostOpenMockGate::create(tmp.path(), &live_mock)?;
    let mut server = common::ControlledHttpServer::start().await?;
    let prompt = [
        "@ECHO@".to_string(),
        json!({ "type": "assistant", "message": EVENT_MESSAGE }).to_string(),
    ]
    .join("\n");

    unsafe {
        common::setup_env(&gated_mock, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        &run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let masker = SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);
    tokio::select! {
        outcome = &mut execution => {
            return Err(format!("CLI completed before singleton output was released: {outcome:?}").into());
        }
        ready = start_gate.wait_until_ready(LIVENESS_TIMEOUT) => ready?,
    }

    tokio::time::pause();
    let frozen_at = tokio::time::Instant::now();
    let request = async {
        start_gate.release().map_err(|error| error.to_string())?;
        tokio::select! {
            outcome = &mut execution => {
                Err(format!("CLI completed before the live singleton request: {outcome:?}"))
            }
            request = request_without_clock_advance(&mut server) => request,
        }
    }
    .await;
    let observed_at = tokio::time::Instant::now();
    tokio::time::resume();
    let producer_ready = if request.is_ok() {
        // Confirm the producer reached its held-open exit gate before release.
        exit_gate.wait_until_ready(LIVENESS_TIMEOUT).await
    } else {
        Ok(())
    };
    // Restore time and unblock the producer even when observation failed.
    // The pinned execution owns its child and is dropped on any error.
    exit_gate.release()?;
    let request = request?;
    producer_ready?;
    assert_eq!(
        observed_at, frozen_at,
        "the singleton request must arrive without elapsing a collection timer"
    );
    assert_eq!(
        request.request.content_type.as_deref(),
        Some("application/json")
    );
    let body: serde_json::Value = serde_json::from_str(&request.request.body)?;
    assert_eq!(
        body.get("runId").and_then(serde_json::Value::as_str),
        Some(run_id.as_str())
    );
    let events = body
        .get("events")
        .and_then(serde_json::Value::as_array)
        .expect("event request should contain an events array");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]
            .get("sequenceNumber")
            .and_then(serde_json::Value::as_u64),
        Some(0)
    );
    assert_eq!(
        events[0].get("message").and_then(serde_json::Value::as_str),
        Some(EVENT_MESSAGE)
    );
    request.respond(200)?;

    let result = tokio::time::timeout(LIVENESS_TIMEOUT, execution)
        .await
        .expect("CLI should finish after the singleton response")?;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some(0));
    assert_eq!(server.request_count(), 1);

    Ok(())
}
