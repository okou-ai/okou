//! The Codex app-server backend must enforce the shared aggregate byte budget
//! across queued and in-flight downstream event delivery.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-byte-overload-test";

#[tokio::test]
async fn codex_app_server_retries_recover_or_make_room_for_recent_events()
-> Result<(), Box<dyn std::error::Error>> {
    for recover_before_eviction in [true, false] {
        run_retry_case(recover_before_eviction).await?;
    }
    Ok(())
}

async fn run_retry_case(recover_before_eviction: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;

    unsafe {
        common::setup_codex_app_server_env(
            &mock,
            tmp.path(),
            common::CodexAppServerEnvConfig {
                run_id: RUN_ID,
                prompt: "drive app-server event delivery byte overload",
                scenario: Some("runtime-large-event-flood"),
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
    let system_log_file = tmp.path().join("system.log");
    let _system_log = common::SystemLogOverrideGuard::set(&system_log_file);

    let mut execution = tokio::spawn(async move {
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

    let release_socket = tmp
        .path()
        .join(common::MOCK_CODEX_EVENT_DELIVERY_LARGE_RELEASE_SOCKET);
    let mut accepted_sequences = Vec::new();
    let stalled_warning = loop {
        let request = tokio::select! {
            result = &mut execution => {
                return Err(format!("app-server execution ended before the first warning was in flight: {result:?}").into());
            }
            request = server.next_request(Duration::from_secs(5)) => request?,
        };
        assert_eq!(request.request.path, "/api/webhooks/agent/events");
        let payload: Value = serde_json::from_str(&request.request.body)?;
        let events = payload
            .get("events")
            .and_then(Value::as_array)
            .ok_or("missing delivered events")?;
        if events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("warning"))
        {
            break request;
        }
        accepted_sequences.extend(common::event_request_sequences(&request.request)?);
        request.respond(200)?;
    };
    let stalled_body = stalled_warning.request.body.clone();
    stalled_warning.respond(500)?;
    for _ in 1..6 {
        let retry = server.next_request(Duration::from_secs(5)).await?;
        assert_eq!(retry.request.body, stalled_body);
        retry.respond(500)?;
    }
    // The mock is still blocked on its release socket, proving that a transient
    // failure survives more than the old three-attempt budget during execution.
    let retry = server.next_request(Duration::from_secs(5)).await?;
    assert_eq!(retry.request.body, stalled_body);
    if recover_before_eviction {
        accepted_sequences.extend(common::event_request_sequences(&retry.request)?);
        retry.respond(200)?;
        UnixStream::connect(&release_socket)?;
    } else {
        // Keep the HTTP response in flight while the producer fills the byte budget.
        UnixStream::connect(&release_socket)?;
        common::wait_for_file_contains(
            &system_log_file,
            "Event delivery drain started:",
            Duration::from_secs(10),
        )
        .await?;
        retry.respond(500)?;
    }
    let mut delivered_warnings = Vec::new();
    let result = loop {
        tokio::select! {
            result = &mut execution => break result???,
            request = server.next_request(Duration::from_secs(5)) => {
                let request = request?;
                accepted_sequences.extend(common::event_request_sequences(&request.request)?);
                let payload: Value = serde_json::from_str(&request.request.body)?;
                for event in payload.get("events").and_then(Value::as_array).ok_or("missing events")? {
                    if event.get("type").and_then(Value::as_str) == Some("warning") {
                        let (index, _) = event.get("message").and_then(Value::as_str).ok_or("missing warning text")?.split_once(':').ok_or("missing warning index")?;
                        delivered_warnings.push(index.parse::<usize>()?);
                    }
                }
                request.respond(200)?;
            }
        }
    };
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    if recover_before_eviction {
        assert_eq!(delivered_warnings, (1..16).collect::<Vec<_>>());
        let last = accepted_sequences
            .last()
            .copied()
            .ok_or("no events acknowledged")?;
        assert_eq!(accepted_sequences, (0..=last).collect::<Vec<_>>());
        assert_eq!(result.last_event_sequence, Some(last));
        assert!(result.event_delivery.is_none());
        return Ok(());
    }
    assert_eq!(delivered_warnings, (2..16).collect::<Vec<_>>());
    let delivery = result
        .event_delivery
        .ok_or("discarded retry omitted diagnostic")?;
    let failed = delivery
        .first_failed_batch
        .ok_or("discarded retry omitted batch")?;
    assert_eq!(
        failed
            .attempts
            .iter()
            .map(|attempt| attempt.attempt)
            .collect::<Vec<_>>(),
        vec![5, 6, 7]
    );

    Ok(())
}
