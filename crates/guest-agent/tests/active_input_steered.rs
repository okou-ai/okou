//! Integration coverage for steered declarations of accepted active input.

use std::time::Duration;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::http::HttpClient;
use httpmock::prelude::*;
use serde_json::json;

const RUN_ID: &str = "active-input-steered-integration";
const EVENT_ID: &str = "60fca608-d174-4c1a-a1b2-57607b3adf46";
const PROMPT: &str = "continue with the follow-up input";

fn steer_http(base_url: &str) -> Result<HttpClient, guest_agent::error::AgentError> {
    HttpClient::with_api_config(base_url, "test-token", "", RUN_ID, Duration::ZERO)
}

fn payload(text: &str) -> Result<Vec<u8>, serde_json::Error> {
    guest_contracts::active_input::encode_active_input(EVENT_ID, text)
}

fn steered_path() -> String {
    format!("/api/runners/runs/{RUN_ID}/steerable-inputs/{EVENT_ID}/steered")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn explicit_null_event_id_is_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let runtime =
        ActiveInputRuntime::new_enabled(RUN_ID, "initial", steer_http(&server.base_url())?);
    let controller = runtime.controller();
    let _writer = runtime.into_writer();

    assert!(matches!(
        controller.handle_control_payload(
            br#"{"type":"active-input","eventId":null,"text":"hello"}"#
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input payload is invalid"
    ));

    controller.close_terminal();
    controller.finalize_steered_declarations().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn accepted_input_is_deduplicated_and_declared_steered_once()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let steered = server.mock(|when, then| {
        when.method(POST)
            .path(steered_path())
            .header("Authorization", "Bearer test-token")
            .header("Content-Type", "application/json")
            .json_body(json!({}));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let runtime =
        ActiveInputRuntime::new_enabled(RUN_ID, "initial", steer_http(&server.base_url())?);
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let accepted_payload = payload(PROMPT)?;

    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted
    );
    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted,
        "a duplicate must not enqueue a second sink operation"
    );
    assert!(matches!(
        controller.handle_control_payload(&payload("different text")?),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input event id was reused with different text"
    ));

    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    assert_eq!(frame.uuid, EVENT_ID);
    assert_eq!(frame.event_id(), EVENT_ID);
    assert_eq!(frame.text, PROMPT);
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;

    controller.close_terminal();
    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted,
        "a known accepted input remains idempotent after close"
    );
    assert!(matches!(
        controller.handle_control_payload(
            &guest_contracts::active_input::encode_active_input(
                "8736a7bd-8ddc-46b4-a159-af71d09f65e4",
                "new after close",
            )?
        ),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input is closed"
    ));

    controller.finalize_steered_declarations().await?;
    steered.assert_calls(1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn failed_input_is_not_declared_steered() -> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let steered = server.mock(|when, then| {
        when.method(POST).path(steered_path());
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({ "outcome": "steered" }));
    });
    let runtime =
        ActiveInputRuntime::new_enabled(RUN_ID, "initial", steer_http(&server.base_url())?);
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    let accepted_payload = payload(PROMPT)?;

    assert_eq!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("accepted input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_failed(&frame);
    assert!(matches!(
        controller.handle_control_payload(&accepted_payload),
        ActiveInputControlOutcome::Rejected { diagnostic }
            if diagnostic == "active input delivery previously failed"
    ));

    controller.close_terminal();
    controller.finalize_steered_declarations().await?;
    steered.assert_calls(0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn conflicting_and_failed_declarations_are_not_retried()
-> Result<(), Box<dyn std::error::Error>> {
    for status in [409, 500] {
        let server = MockServer::start();
        let steered = server.mock(|when, then| {
            when.method(POST).path(steered_path());
            then.status(status)
                .header("Content-Type", "application/json")
                .json_body(json!({
                    "error": { "code": "INPUT_ALREADY_CONSUMED", "message": "Input already consumed" }
                }));
        });
        let runtime =
            ActiveInputRuntime::new_enabled(RUN_ID, "initial", steer_http(&server.base_url())?);
        let controller = runtime.controller();
        let mut writer = runtime.into_writer();

        assert_eq!(
            controller.handle_control_payload(&payload(PROMPT)?),
            ActiveInputControlOutcome::Accepted
        );
        let frame = writer
            .next_frame()
            .await
            .expect("accepted input should reach the sink");
        writer.mark_writing(&frame.uuid);
        writer.mark_backend_accepted_without_replay(&frame)?;
        controller.close_terminal();

        controller.finalize_steered_declarations().await?;
        steered.assert_calls(1);
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn finalization_waits_for_a_declaration_during_api_cold_start()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start_async().await;
    let steered = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(steered_path())
                .header("authorization", "Bearer test-token");
            then.status(200)
                .delay(Duration::from_secs(6))
                .json_body(json!({ "outcome": "steered" }));
        })
        .await;
    let runtime =
        ActiveInputRuntime::new_enabled(RUN_ID, "initial", steer_http(&server.base_url())?);
    let controller = runtime.controller();
    let mut writer = runtime.into_writer();
    assert_eq!(
        controller.handle_control_payload(&payload(PROMPT)?),
        ActiveInputControlOutcome::Accepted
    );
    let frame = writer
        .next_frame()
        .await
        .expect("input should reach the sink");
    writer.mark_writing(&frame.uuid);
    writer.mark_backend_accepted_without_replay(&frame)?;

    controller.close_terminal();
    controller.finalize_steered_declarations().await?;
    steered.assert_calls_async(1).await;
    Ok(())
}
