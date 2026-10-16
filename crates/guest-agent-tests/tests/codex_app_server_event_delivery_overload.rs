//! The Codex app-server backend must use the same bounded downstream event
//! delivery queue as the Claude Code subprocess path.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-overload-test";

#[tokio::test]
async fn codex_app_server_event_delivery_count_overload_terminates_promptly()
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
                prompt: "drive app-server event delivery overload",
                scenario: Some("runtime-event-flood"),
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

    let stalled_events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200).delay(Duration::from_secs(30));
    });

    let masker = SecretMasker::from_raw("");
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("app-server delivery overload should not wait for the stalled request")
    .expect_err("delivery queue overload should fail the app-server run");

    let error = error.to_string();
    assert!(
        error.contains("event delivery queue exceeded 512 pending events"),
        "unexpected overload error: {error}"
    );
    assert!(
        !error.contains("server notification queue exceeded"),
        "the test must exercise the downstream delivery queue: {error}"
    );
    assert!(
        stalled_events.calls() <= 1,
        "the serial sender should have at most one stalled request in flight"
    );

    Ok(())
}
