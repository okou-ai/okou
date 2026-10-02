//! The Codex app-server backend must enforce the shared aggregate byte budget
//! across queued and in-flight downstream event delivery.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::os::unix::net::UnixStream;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-byte-overload-test";
const WARNING_EVENT_BODY_MARKER: &str = r#""type":"warning""#;

#[tokio::test]
async fn codex_app_server_event_delivery_byte_overload_terminates_promptly()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let server = MockServer::start();

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
            server.base_url(),
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
    }
    let mut runtime = common::guest_runtime_from_process_env()?;
    runtime.http = guest_agent::http::HttpClient::with_api_config(
        server.base_url(),
        "test-token",
        "",
        RUN_ID,
        Duration::ZERO,
    )?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

    let _lifecycle_events = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_excludes(WARNING_EVENT_BODY_MARKER);
        then.status(200);
    });
    let stalled_events = server.mock(|when, then| {
        when.method(POST)
            .path("/api/webhooks/agent/events")
            .body_includes(WARNING_EVENT_BODY_MARKER);
        then.status(200).delay(Duration::from_secs(30));
    });

    let masker = SecretMasker::from_raw("");
    let execution = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    );
    tokio::pin!(execution);

    let release_socket = tmp
        .path()
        .join(common::MOCK_CODEX_EVENT_DELIVERY_LARGE_RELEASE_SOCKET);
    tokio::select! {
        result = &mut execution => {
            return Err(format!("app-server execution ended before the release socket was ready: {result:?}").into());
        }
        ready = common::wait_for_path(&release_socket, Duration::from_secs(5)) => ready?,
    }
    tokio::select! {
        result = &mut execution => {
            return Err(format!("app-server execution ended before the first warning was in flight: {result:?}").into());
        }
        observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if stalled_events.calls_async().await > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }) => observed.expect("the first warning delivery should become in flight"),
    }
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
        stalled_events.calls(),
        1,
        "the byte limit must include the one stalled request in flight"
    );

    Ok(())
}
