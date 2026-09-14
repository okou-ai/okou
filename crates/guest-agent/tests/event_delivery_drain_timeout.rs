//! The production 120-second event-delivery drain deadline is exercised with
//! paused Tokio time through the real CLI entry point.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{EventDeliveryAcceptanceOutcome, HttpAttemptFailureKind};
use serde_json::json;
use std::io;
use std::time::Duration;

const EVENT_COUNT: usize = 33;

#[tokio::test]
async fn event_delivery_aborts_after_the_global_drain_deadline()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines.extend(
        (0..EVENT_COUNT - 1)
            .map(|index| json!({ "type": "assistant", "index": index }).to_string()),
    );
    prompt_lines.push(json!({ "type": "result", "marker": "drain-timeout-sentinel" }).to_string());
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
        Duration::from_secs(1),
    )?;
    let agent_log_file = runtime.paths.agent_log_file().to_string();
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let system_log_file = tmp.path().join("system.log");
    let _system_log = common::SystemLogOverrideGuard::set(&system_log_file);

    let execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });
    let stalled_request = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        std::path::Path::new(&agent_log_file),
        "drain-timeout-sentinel",
        Duration::from_secs(5),
    )
    .await?;
    common::wait_for_file_contains(
        &system_log_file,
        "Event delivery drain started:",
        Duration::from_secs(5),
    )
    .await?;

    tokio::time::pause();
    for _ in 0..125 {
        if execution.is_finished() {
            break;
        }
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
    }
    assert!(
        execution.is_finished(),
        "event delivery should stop at the unchanged 120-second global deadline"
    );
    let result = execution.await??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let delivery = result
        .event_delivery
        .ok_or_else(|| io::Error::other("drain timeout omitted structured diagnostic"))?;
    assert_eq!(
        result.last_event_sequence,
        delivery.last_acknowledged_sequence
    );
    let failed_batch = delivery
        .first_failed_batch
        .as_ref()
        .ok_or_else(|| io::Error::other("drain scenario omitted first exhausted batch"))?;
    assert_eq!(failed_batch.attempts.len(), 3);
    assert_eq!(
        failed_batch.outcome,
        EventDeliveryAcceptanceOutcome::OutcomeUnknown
    );
    assert!(failed_batch.attempts.iter().all(|attempt| {
        attempt.failure_kind == HttpAttemptFailureKind::Timeout
            && attempt.http_status.is_none()
            && attempt.timeout_observed == Some(true)
            && attempt.connect_observed == Some(false)
    }));
    let drain = delivery
        .drain_timeout
        .as_ref()
        .ok_or_else(|| io::Error::other("drain scenario omitted deadline snapshot"))?;
    let active_batch = drain
        .active_batch
        .as_ref()
        .ok_or_else(|| io::Error::other("drain scenario omitted active batch"))?;
    assert_eq!(drain.queued_events, 0);
    assert_eq!(drain.queued_bytes, 0);
    assert_eq!(drain.carried_events, 0);
    assert_eq!(drain.carried_bytes, 0);
    assert_eq!(
        usize::try_from(failed_batch.event_count)?
            + usize::try_from(drain.queued_events)?
            + usize::try_from(drain.carried_events)?
            + usize::try_from(active_batch.event_count)?,
        EVENT_COUNT,
        "the exhausted batch and drain snapshot must account for every event"
    );
    assert_eq!(drain.queued_events > 0, drain.queued_bytes > 0);
    assert_eq!(drain.carried_events > 0, drain.carried_bytes > 0);
    assert!(active_batch.conservative_bytes > 0);
    assert_eq!(
        active_batch.outcome,
        EventDeliveryAcceptanceOutcome::OutcomeUnknown
    );
    let active_attempt = active_batch
        .active_attempt
        .as_ref()
        .ok_or_else(|| io::Error::other("drain scenario omitted active attempt"))?;
    assert!(active_attempt.elapsed_ms > 0);

    tokio::task::yield_now().await;
    let requests_after_abort = server.request_count();
    assert!(
        requests_after_abort >= 4,
        "virtual time should exercise one exhausted batch and a later batch before the global abort"
    );
    tokio::time::advance(Duration::from_secs(60)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        server.request_count(),
        requests_after_abort,
        "aborting the delivery worker should prevent later requests"
    );
    let recorded_requests = server.requests()?;
    let recorded_active = recorded_requests
        .last()
        .ok_or_else(|| io::Error::other("controlled server recorded no requests"))?;
    assert_eq!(
        recorded_active.client_request_id.as_deref(),
        Some(active_attempt.client_request_id.as_str())
    );
    assert_eq!(
        common::event_request_sequences(recorded_active)?,
        (active_batch.first_sequence..=active_batch.last_sequence).collect::<Vec<_>>()
    );

    tokio::time::resume();
    let mut pending_requests = Vec::new();
    for _ in 1..requests_after_abort {
        pending_requests.push(server.next_request(Duration::from_secs(1)).await?);
    }
    let active_request = pending_requests
        .pop()
        .ok_or_else(|| io::Error::other("active controlled request was not retained"))?;
    assert_eq!(
        active_request.request.client_request_id.as_deref(),
        Some(active_attempt.client_request_id.as_str())
    );
    let completed_before = server.completed_response_count();
    active_request.respond(200)?;
    tokio::time::timeout(Duration::from_secs(1), async {
        while server.completed_response_count() == completed_before {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server should finish the response after the guest abandons it");
    drop(pending_requests);
    drop(stalled_request);

    Ok(())
}
