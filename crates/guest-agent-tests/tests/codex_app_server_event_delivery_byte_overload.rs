//! The Codex app-server backend must enforce the shared aggregate byte budget
//! across queued and in-flight downstream event delivery.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-byte-overload-test";

#[tokio::test]
async fn codex_app_server_event_delivery_byte_overload_terminates_promptly()
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

    let masker = SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    );
    tokio::pin!(execution);

    let release_socket = tmp
        .path()
        .join(common::MOCK_CODEX_EVENT_DELIVERY_LARGE_RELEASE_SOCKET);
    let mut acknowledged_requests = 0;
    let stalled_warning = loop {
        let request = tokio::select! {
            result = &mut execution => {
                return Err(format!("app-server execution ended before the first warning was in flight: {result:?}").into());
            }
            request = server.next_request(Duration::from_secs(5)) => request?,
        };
        assert_eq!(request.request.path, "/api/webhooks/agent/events");
        let payload: Value = serde_json::from_str(&request.request.body)?;
        let events = payload["events"]
            .as_array()
            .ok_or("missing delivered events")?;
        if events.iter().any(|event| event["type"] == "warning") {
            break request;
        }
        request.respond(200)?;
        acknowledged_requests += 1;
    };
    // The mock binds this socket before emitting the first warning. Keep its
    // HTTP response in flight while the released producer fills the byte budget.
    UnixStream::connect(&release_socket)?;

    let error = execution
        .await
        .expect("app-server byte overload should not wait for the stalled request")
        .expect_err("delivery byte overload should fail the app-server run");

    let error = error.to_string();
    assert!(
        error.contains("event delivery byte buffer exhausted") && error.contains("33554432 bytes"),
        "unexpected byte-overload error: {error}"
    );
    assert!(
        !error.contains("server notification byte buffer exhausted"),
        "the test must exercise the downstream delivery byte budget: {error}"
    );
    assert_eq!(
        server.request_count(),
        acknowledged_requests + 1,
        "the byte limit must include the one stalled request in flight"
    );
    drop(stalled_warning);

    Ok(())
}
