//! Event-delivery integration coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{EventDeliveryAcceptanceOutcome, HttpAttemptFailureKind};
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-test";
const TOTAL_EVENTS: usize = 4;

#[tokio::test]
async fn codex_app_server_event_delivery_stops_watermark_at_failed_sequence()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive app-server event delivery",
                scenario: Some("runtime-turn-complete-without-thread-started"),
                resume_session_id: None,
            },
        )?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        &server.base_url,
        "test-token",
        "",
        RUN_ID,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });

    let mut logical_sequences = Vec::new();
    let mut failed_sequences = None;
    let mut failed_attempts = 0usize;
    let mut failed_request_ids = Vec::new();
    while logical_sequences.len() < TOTAL_EVENTS || failed_attempts < 3 {
        let request = server.next_request(Duration::from_secs(5)).await?;
        let sequences = common::event_request_sequences(&request.request)?;
        if sequences.contains(&1) {
            if let Some(expected) = &failed_sequences {
                assert_eq!(
                    &sequences, expected,
                    "every retry should preserve the batch"
                );
            } else {
                logical_sequences.extend(sequences.iter().copied());
                failed_sequences = Some(sequences.clone());
            }
            failed_attempts += 1;
            failed_request_ids.push(
                request
                    .request
                    .client_request_id
                    .clone()
                    .ok_or("failed request omitted x-client-request-id")?,
            );
            request.respond(500)?;
        } else {
            logical_sequences.extend(sequences);
            request.respond(200)?;
        }
    }

    let failed_sequences = failed_sequences.expect("sequence 1 should belong to a failed batch");
    let expected_watermark = failed_sequences
        .first()
        .copied()
        .and_then(|sequence| sequence.checked_sub(1));
    let cli_result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("execute_cli should return promptly")??;

    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);
    assert_eq!(cli_result.last_event_sequence, expected_watermark);
    let delivery = cli_result
        .event_delivery
        .ok_or("failed delivery omitted structured diagnostic")?;
    assert_eq!(delivery.total_events, TOTAL_EVENTS as u64);
    assert_eq!(delivery.failed_batches, 1);
    assert_eq!(delivery.last_acknowledged_sequence, expected_watermark);
    let failed_batch = delivery
        .first_failed_batch
        .ok_or("failed delivery omitted first failed batch")?;
    assert_eq!(
        failed_batch.outcome,
        EventDeliveryAcceptanceOutcome::ConfirmedRejection
    );
    assert_eq!(failed_batch.attempts.len(), 3);
    assert_eq!(
        failed_batch
            .attempts
            .iter()
            .map(|attempt| attempt.client_request_id.clone())
            .collect::<Vec<_>>(),
        failed_request_ids
    );
    assert!(failed_batch.attempts.iter().all(|attempt| {
        attempt.failure_kind == HttpAttemptFailureKind::HttpStatus
            && attempt.http_status == Some(500)
    }));
    assert_eq!(failed_attempts, 3);
    assert_eq!(
        logical_sequences,
        (0..TOTAL_EVENTS as u32).collect::<Vec<_>>(),
        "logical batches should cover the translated Codex events in FIFO order"
    );

    Ok(())
}
