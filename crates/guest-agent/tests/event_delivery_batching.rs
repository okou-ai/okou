//! Healthy CLI backlog above 16 MiB should drain in ordered count- and byte-bounded batches.

mod common;

use guest_agent::masker::SecretMasker;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io;
use std::time::Duration;

const SMALL_EVENT_COUNT: usize = 70;
const LARGE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const LARGE_EVENT_COUNT: usize = 10;
const MAX_BATCH_EVENTS: usize = 32;
const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;

struct CapturedBatch {
    sequences: Vec<u32>,
    conservative_bytes: usize,
    body_bytes: usize,
}

fn capture_batch(
    request: &common::RecordedRequest,
    run_id: &str,
) -> Result<CapturedBatch, Box<dyn std::error::Error>> {
    if request.path != "/api/webhooks/agent/events" {
        return Err(io::Error::other(format!("unexpected request path: {}", request.path)).into());
    }
    if request.authorization.as_deref() != Some("Bearer test-token") {
        return Err(io::Error::other("event request omitted bearer authorization").into());
    }
    let body: Value = serde_json::from_str(&request.body)?;
    if body.get("runId").and_then(Value::as_str) != Some(run_id) {
        return Err(io::Error::other("event request used the wrong run ID").into());
    }
    let events = body
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::other("event request omitted events array"))?;
    let sequences = events
        .iter()
        .map(|event| {
            event
                .get("sequenceNumber")
                .and_then(Value::as_u64)
                .and_then(|sequence| u32::try_from(sequence).ok())
                .ok_or_else(|| io::Error::other("event omitted a u32 sequenceNumber"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let conservative_bytes = events.iter().try_fold(0usize, |total, event| {
        let singleton = json!({ "runId": run_id, "events": [event] });
        let bytes = serde_json::to_vec(&singleton)?.len();
        Ok::<usize, serde_json::Error>(total + bytes)
    })?;

    Ok(CapturedBatch {
        sequences,
        conservative_bytes,
        body_bytes: request.body.len(),
    })
}

#[tokio::test]
async fn claude_code_drains_healthy_backlog_in_bounded_fifo_batches()
-> Result<(), Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let mut prompt_lines = vec!["@ECHO@".to_string()];
    prompt_lines.extend((0..SMALL_EVENT_COUNT).map(|index| {
        json!({ "type": "assistant", "index": index, "content": "small" }).to_string()
    }));
    // Hold more than 16 MiB, but less than 32 MiB, behind the first HTTP response.
    prompt_lines.extend((0..LARGE_EVENT_COUNT).map(|index| {
        json!({
            "type": "assistant",
            "marker": format!("large-{index}"),
            "content": "x".repeat(LARGE_EVENT_BYTES),
        })
        .to_string()
    }));
    prompt_lines.push(json!({ "type": "result", "marker": "batching-sentinel" }).to_string());
    let prompt = prompt_lines.join("\n");
    let total_events = SMALL_EVENT_COUNT + LARGE_EVENT_COUNT + 1;

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
        &run_id,
        Duration::ZERO,
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

    let first_request = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        std::path::Path::new(&agent_log_file),
        "batching-sentinel",
        Duration::from_secs(5),
    )
    .await?;
    let mut batches = vec![capture_batch(&first_request.request, &run_id)?];
    let mut delivered_events = batches[0].sequences.len();
    first_request.respond(200)?;

    while delivered_events < total_events {
        let request = server.next_request(Duration::from_secs(5)).await?;
        let batch = capture_batch(&request.request, &run_id)?;
        delivered_events += batch.sequences.len();
        batches.push(batch);
        request.respond(200)?;
    }

    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("CLI should finish after all batches are acknowledged")??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert_eq!(result.last_event_sequence, Some((total_events - 1) as u32));

    let sequences = batches
        .iter()
        .flat_map(|batch| batch.sequences.iter().copied())
        .collect::<Vec<_>>();
    assert_eq!(sequences, (0..total_events as u32).collect::<Vec<_>>());
    assert_eq!(
        sequences.iter().copied().collect::<BTreeSet<_>>().len(),
        total_events,
        "every event should be delivered exactly once"
    );
    assert!(
        batches
            .iter()
            .any(|batch| batch.sequences.len() == MAX_BATCH_EVENTS),
        "the queued small-event burst should exercise the count boundary"
    );
    for batch in &batches {
        assert!(batch.sequences.len() <= MAX_BATCH_EVENTS);
        assert!(batch.conservative_bytes <= MAX_BATCH_BYTES);
        assert!(batch.body_bytes <= MAX_BATCH_BYTES);
    }
    let large_event_batches = (0..LARGE_EVENT_COUNT)
        .map(|index| {
            batches
                .iter()
                .position(|batch| {
                    batch
                        .sequences
                        .contains(&((SMALL_EVENT_COUNT + index) as u32))
                })
                .expect("every large event should be delivered")
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        large_event_batches.len(),
        LARGE_EVENT_COUNT,
        "individually valid large events should split at the 4 MiB conservative boundary"
    );
    assert!(batches.len() < total_events);

    let system_log = std::fs::read_to_string(system_log_file)?;
    assert!(system_log.contains("Event delivery request:"));
    assert!(system_log.contains("Event delivery complete:"));
    assert!(system_log.contains(&format!("events={total_events}")));
    assert!(system_log.contains("failed_requests=0"));
    assert!(system_log.contains("max_batch_events=32"));
    assert!(system_log.contains("max_pending_events="));
    assert!(system_log.contains("max_buffered_bytes="));

    Ok(())
}

#[tokio::test]
async fn batching_readiness_observes_large_raw_log_after_creation() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    let log_path = temp.path().join("agent.jsonl");
    let mut contents = vec![b'x'; LARGE_EVENT_COUNT * LARGE_EVENT_BYTES];
    // Readiness searches raw bytes, including a non-UTF-8 prefix and an
    // incomplete marker before the complete sentinel at the end of the log.
    contents.push(0xff);
    contents.extend_from_slice(b"batching-senti\nbatching-sentinel\n");

    let readiness =
        common::wait_for_file_contains(&log_path, "batching-sentinel", Duration::from_secs(5));
    let writer = tokio::fs::write(&log_path, &contents);
    let (ready, written) = tokio::join!(readiness, writer);
    written?;
    ready
}

#[tokio::test]
async fn batching_readiness_rejects_empty_marker() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    let error = common::wait_for_file_contains(
        &temp.path().join("agent.jsonl"),
        "",
        Duration::from_secs(5),
    )
    .await
    .expect_err("empty marker must not report readiness");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    Ok(())
}
