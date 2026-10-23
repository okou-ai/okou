//! Event delivery reports response observations independently of origin acceptance,
//! while distinguishing response-less failures without retaining raw error text.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{
    EventDeliveryDiagnostic, EventDeliveryResponseState, HttpAttemptFailureKind,
};
use serde_json::json;
use std::io;
use std::time::Duration;

#[tokio::test]
async fn failed_delivery_preserves_response_and_transport_evidence()
-> Result<(), Box<dyn std::error::Error>> {
    let connect_delivery = run_connect_failure().await?;
    assert_failed_attempts(
        &connect_delivery,
        HttpAttemptFailureKind::Connect,
        false,
        true,
    )?;

    let transport = run_response_failures([None; 3]).await?;
    let transport_attempts = assert_failed_attempts(
        &transport.delivery,
        HttpAttemptFailureKind::Transport,
        false,
        false,
    )?;
    assert_eq!(
        transport_attempts
            .iter()
            .map(|attempt| attempt.client_request_id.as_str())
            .collect::<Vec<_>>(),
        transport.request_ids
    );

    for (responses, response_state) in [
        ([Some(502); 3], EventDeliveryResponseState::AllHttpErrors),
        (
            [Some(502), None, Some(400)],
            EventDeliveryResponseState::Incomplete,
        ),
    ] {
        let observed = run_response_failures(responses).await?;
        assert!(!observed.accepted_sequences.is_empty());
        assert!(observed.delivery.last_acknowledged_sequence.is_none());
        let failed = observed
            .delivery
            .first_failed_batch
            .as_ref()
            .ok_or_else(|| io::Error::other("response failure omitted its batch"))?;
        assert_eq!(failed.response_state, response_state);
        assert_eq!(failed.first_sequence, observed.accepted_sequences[0]);
        assert_eq!(
            failed.event_count as usize,
            observed.accepted_sequences.len()
        );
        assert_eq!(failed.attempts.len(), responses.len());
        for ((attempt, status), request_id) in failed
            .attempts
            .iter()
            .zip(responses)
            .zip(&observed.request_ids)
        {
            assert_eq!(attempt.http_status, status);
            assert_eq!(attempt.client_request_id, *request_id);
            assert_eq!(
                attempt.failure_kind,
                if status.is_some() {
                    HttpAttemptFailureKind::HttpStatus
                } else {
                    HttpAttemptFailureKind::Transport
                }
            );
        }
    }

    let connect_timeout_delivery = run_connect_timeout_failure().await?;
    assert_failed_attempts(
        &connect_timeout_delivery,
        HttpAttemptFailureKind::Timeout,
        true,
        true,
    )?;

    Ok(())
}

async fn run_connect_failure() -> Result<EventDeliveryDiagnostic, Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let prompt = format!(
        "@ECHO@\n{}",
        json!({ "type": "result", "marker": "connect-failure" })
    );

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        "http://127.0.0.1:1",
        "test-token",
        "",
        run_id,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .map_err(|_| io::Error::other("connect-failure delivery exceeded its retry budget"))??;

    result
        .event_delivery
        .ok_or_else(|| io::Error::other("connect failure omitted delivery diagnostic").into())
}

struct ResponseFailureRun {
    delivery: EventDeliveryDiagnostic,
    request_ids: Vec<String>,
    accepted_sequences: Vec<u32>,
}

async fn run_response_failures(
    responses: [Option<u16>; 3],
) -> Result<ResponseFailureRun, Box<dyn std::error::Error>> {
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let mut server = common::ControlledHttpServer::start().await?;
    let prompt = format!(
        "@ECHO@\n{}",
        json!({ "type": "result", "marker": "response-failure" })
    );

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

    let mut request_ids = Vec::new();
    let mut request_body = None;
    let accepted_path = tmp.path().join("accepted-events.json");
    let mut accepted_sequences = Vec::new();
    for status in responses {
        let request = server.next_request(Duration::from_secs(5)).await?;
        if request_body.is_none() {
            common::wait_for_file_contains(
                &system_log_file,
                "Event delivery drain started:",
                Duration::from_secs(5),
            )
            .await?;
        }
        if let Some(request_body) = &request_body {
            assert_eq!(&request.request.body, request_body);
        } else {
            // Model origin acceptance before an error response or lost acknowledgement.
            // A client observing a proxy 502 cannot infer that this write did not happen.
            accepted_sequences = common::event_request_sequences(&request.request)?;
            std::fs::write(&accepted_path, &request.request.body)?;
            request_body = Some(request.request.body.clone());
        }
        request_ids.push(
            request
                .request
                .client_request_id
                .clone()
                .ok_or_else(|| io::Error::other("response-failure request omitted request ID"))?,
        );
        if let Some(status) = status {
            request.respond(status)?;
        } else {
            drop(request);
        }
    }

    let joined = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .map_err(|_| io::Error::other("response-failure delivery exceeded its retry budget"))?;
    let result = joined??;
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    let delivery = result
        .event_delivery
        .ok_or_else(|| io::Error::other("response failure omitted delivery diagnostic"))?;
    assert_eq!(
        std::fs::read_to_string(accepted_path)?,
        request_body
            .ok_or_else(|| io::Error::other("response-failure run received no request body"))?
    );
    assert_eq!(server.request_count(), responses.len());
    Ok(ResponseFailureRun {
        delivery,
        request_ids,
        accepted_sequences,
    })
}

async fn run_connect_timeout_failure() -> Result<EventDeliveryDiagnostic, Box<dyn std::error::Error>>
{
    let mock_cli = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("https://{}", listener.local_addr()?);
    let (accepted_tx, mut accepted_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let mut connections = Vec::new();
        while let Ok((connection, _)) = listener.accept().await {
            connections.push(connection);
            if accepted_tx.send(()).is_err() {
                break;
            }
        }
    });
    let prompt = format!(
        "@ECHO@\n{}",
        json!({ "type": "result", "marker": "connect-timeout" })
    );

    unsafe {
        common::setup_env(&mock_cli, tmp.path(), &prompt, 3, 1)?;
        std::env::set_var(guest_contracts::env::CANONICAL_API_URL_ENV, &base_url);
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    let run_id = runtime.config.run_id.clone();
    runtime.http = guest_agent::http::HttpClient::with_api_config_and_connect_timeout(
        &base_url,
        "test-token",
        "",
        run_id,
        Duration::ZERO,
        Duration::from_millis(250),
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let mut execution = tokio::spawn(async move {
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
        )
        .await
    });

    let bounded_execution = tokio::time::timeout(Duration::from_secs(5), async {
        for attempt in 1..=3 {
            accepted_rx.recv().await.ok_or_else(|| {
                io::Error::other(format!(
                    "connect-timeout server stopped before accepting attempt {attempt}"
                ))
            })?;
        }
        Ok::<_, io::Error>((&mut execution).await)
    })
    .await;
    execution.abort();
    server.abort();
    let joined = bounded_execution
        .map_err(|_| io::Error::other("connect-timeout delivery exceeded its retry budget"))??;
    assert!(
        accepted_rx.try_recv().is_err(),
        "connect-timeout delivery should make exactly three attempts"
    );
    let result = joined??;

    result
        .event_delivery
        .ok_or_else(|| io::Error::other("connect timeout omitted delivery diagnostic").into())
}

fn assert_failed_attempts(
    delivery: &EventDeliveryDiagnostic,
    expected_kind: HttpAttemptFailureKind,
    timeout_observed: bool,
    connect_observed: bool,
) -> Result<
    &[guest_contracts::diagnostics::HttpCompletedAttemptDiagnostic],
    Box<dyn std::error::Error>,
> {
    let failed_batch = delivery
        .first_failed_batch
        .as_ref()
        .ok_or_else(|| io::Error::other("delivery diagnostic omitted first failed batch"))?;
    assert_eq!(failed_batch.attempts.len(), 3);
    assert!(failed_batch.attempts.iter().all(|attempt| {
        attempt.failure_kind == expected_kind
            && attempt.http_status.is_none()
            && attempt.timeout_observed == Some(timeout_observed)
            && attempt.connect_observed == Some(connect_observed)
    }));
    assert_eq!(
        failed_batch.response_state,
        EventDeliveryResponseState::Incomplete
    );
    let mut unique_request_ids = failed_batch
        .attempts
        .iter()
        .map(|attempt| attempt.client_request_id.as_str())
        .collect::<Vec<_>>();
    unique_request_ids.sort_unstable();
    unique_request_ids.dedup();
    assert_eq!(unique_request_ids.len(), 3);
    Ok(&failed_batch.attempts)
}
