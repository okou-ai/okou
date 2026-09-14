//! A non-retryable event rejection records exactly its single on-wire attempt
//! while later logical batches continue.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{EventDeliveryAcceptanceOutcome, HttpAttemptFailureKind};
use serde_json::json;
use std::io;
use std::time::Duration;

const EVENT_BATCH_SIZE: usize = 32;
const TOTAL_EVENTS: usize = EVENT_BATCH_SIZE * 3;

#[tokio::test]
async fn nonretryable_client_rejection_records_one_attempt()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines.extend(
        (0..TOTAL_EVENTS - 1)
            .map(|index| json!({ "type": "assistant", "index": index }).to_string()),
    );
    prompt_lines
        .push(json!({ "type": "result", "marker": "nonretryable-rejection-sentinel" }).to_string());
    let prompt = prompt_lines.join("\n");

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 3, 1)?;
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
        run_id,
        Duration::ZERO,
    )?;
    let agent_log_file = runtime.paths.agent_log_file().to_string();
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });

    let first_request = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        std::path::Path::new(&agent_log_file),
        "nonretryable-rejection-sentinel",
        Duration::from_secs(5),
    )
    .await?;
    let first_sequences = common::event_request_sequences(&first_request.request)?;
    let expected_watermark = first_sequences
        .last()
        .copied()
        .ok_or_else(|| io::Error::other("first request contained no events"))?;
    first_request.respond(200)?;

    let rejected_request = server.next_request(Duration::from_secs(5)).await?;
    let rejected_sequences = common::event_request_sequences(&rejected_request.request)?;
    assert_eq!(rejected_sequences.len(), EVENT_BATCH_SIZE);
    let rejected_request_id = rejected_request
        .request
        .client_request_id
        .clone()
        .ok_or_else(|| io::Error::other("rejected request omitted x-client-request-id"))?;
    rejected_request.respond(400)?;

    let later_request = server.next_request(Duration::from_secs(5)).await?;
    let later_sequences = common::event_request_sequences(&later_request.request)?;
    assert_eq!(later_sequences.len(), EVENT_BATCH_SIZE);
    assert_ne!(
        later_sequences, rejected_sequences,
        "a non-retryable 4xx response must not retry the rejected batch"
    );
    later_request.respond(200)?;

    let mut logical_sequences = first_sequences;
    logical_sequences.extend(rejected_sequences.iter().copied());
    logical_sequences.extend(later_sequences);
    while logical_sequences.len() < TOTAL_EVENTS {
        let request = server.next_request(Duration::from_secs(5)).await?;
        let sequences = common::event_request_sequences(&request.request)?;
        assert_ne!(
            sequences, rejected_sequences,
            "a non-retryable 4xx response must not retry the rejected batch"
        );
        logical_sequences.extend(sequences);
        request.respond(200)?;
    }

    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("CLI should finish after later batches are acknowledged")??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some(expected_watermark));
    let delivery = result
        .event_delivery
        .ok_or_else(|| io::Error::other("rejected delivery omitted structured diagnostic"))?;
    assert_eq!(delivery.failed_batches, 1);
    assert_eq!(
        delivery.last_acknowledged_sequence,
        Some(expected_watermark)
    );
    let failed_batch = delivery
        .first_failed_batch
        .ok_or_else(|| io::Error::other("rejected delivery omitted first failed batch"))?;
    assert_eq!(failed_batch.attempts.len(), 1);
    assert_eq!(
        failed_batch.attempts[0].client_request_id,
        rejected_request_id
    );
    assert_eq!(
        failed_batch.attempts[0].failure_kind,
        HttpAttemptFailureKind::HttpStatus
    );
    assert_eq!(failed_batch.attempts[0].http_status, Some(400));
    assert_eq!(failed_batch.attempts[0].timeout_observed, None);
    assert_eq!(failed_batch.attempts[0].connect_observed, None);
    assert_eq!(
        failed_batch.outcome,
        EventDeliveryAcceptanceOutcome::ConfirmedRejection
    );
    assert_eq!(
        logical_sequences,
        (0..TOTAL_EVENTS as u32).collect::<Vec<_>>(),
        "logical batches should remain FIFO after the rejected batch"
    );

    Ok(())
}
