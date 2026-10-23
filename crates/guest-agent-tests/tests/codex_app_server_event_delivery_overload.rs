//! The Codex app-server backend must use the same bounded downstream event
//! delivery queue as the Claude Code subprocess path.

use guest_agent_tests as common;

use guest_agent::masker::SecretMasker;
use serde_json::Value;
use std::time::Duration;

const RUN_ID: &str = "codex-app-server-event-delivery-overload-test";

#[tokio::test]
async fn codex_app_server_event_delivery_count_overload_keeps_recent_events()
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
                prompt: "drive app-server event delivery overload",
                scenario: Some("runtime-event-flood"),
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
            Duration::from_secs(5),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await
    });
    let first = server.next_request(Duration::from_secs(5)).await?;
    common::wait_for_file_contains(
        &system_log_file,
        "Event delivery drain started:",
        Duration::from_secs(5),
    )
    .await?;
    let mut warnings = Vec::new();
    let mut sequences = Vec::new();
    let mut request = first;
    let result = loop {
        sequences.extend(common::event_request_sequences(&request.request)?);
        let payload: Value = serde_json::from_str(&request.request.body)?;
        for event in payload["events"].as_array().ok_or("missing events")? {
            if let Some(index) = event["message"]
                .as_str()
                .and_then(|text| text.strip_prefix("codex-mock warning "))
            {
                warnings.push(index.parse::<usize>()?);
            }
        }
        request.respond(200)?;
        tokio::select! {
            result = &mut execution => break result???,
            next = server.next_request(Duration::from_secs(5)) => request = next?,
        }
    };
    for index in 129..640 {
        assert!(
            warnings.contains(&index),
            "recent warning {index} was evicted"
        );
    }
    assert!(warnings.len() < 640);
    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(result.control_error.is_none());
    assert_eq!(result.last_event_sequence, sequences.last().copied());

    Ok(())
}
