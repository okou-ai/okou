//! A definite steer rejection must retain the captured turn and earlier ACKs.

use guest_agent_tests as common;

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::http::HttpClient;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use httpmock::prelude::*;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

const RUN_ID: &str = "codex-inactive-turn-rejection";
const ACCEPTED_ID: &str = "97a21bf2-78a3-464c-a5ea-1d20abe4fabc";
const REJECTED_ID: &str = "e9698196-9d75-477a-9fe9-005d17e8f900";
const QUEUED_ID: &str = "c546fe6e-435d-42dc-b8f4-a975ba7d8347";

#[tokio::test]
async fn inactive_turn_rejection_preserves_terminal_status_and_prior_acknowledgements()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    common::ensure_canonical_workspace_for_test()?;
    for scenario in [
        "steer-rejected-after-completion",
        "steer-rejected-before-completion",
        "steer-rejected-failed-turn",
        "steer-rejected-interrupted-turn",
        "steer-rejected-wrong-turn",
        "steer-rejected-wrong-code",
        "steer-rejected-other-error",
        "steer-disconnected-after-completion",
    ] {
        assert_rejection_scenario(&mock, scenario).await?;
    }
    Ok(())
}

async fn assert_rejection_scenario(
    mock: &Path,
    scenario: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let paths = GuestPaths::from_home(home.path(), RUN_ID)?;
    let payload = common::write_run_payload_file_for_test(
        paths.runtime_dir(),
        &guest_contracts::env::RunPayload {
            prompt: "retain this original turn".to_string(),
            ..Default::default()
        },
    )?;
    let mut config = GuestConfig::from_raw(GuestConfigRaw {
        run_id: RUN_ID.to_string(),
        cli_agent_type: "codex".to_string(),
        use_mock_codex: "true".to_string(),
        mock_codex_path: Some(mock.to_string_lossy().into_owned()),
        home: Some(home.path().to_string_lossy().into_owned()),
        guest_runtime_dir: Some(paths.runtime_dir().to_path_buf()),
        run_payload_file: payload.to_string_lossy().into_owned(),
        ..Default::default()
    })?;
    config.codex_home_dir = home
        .path()
        .join("codex-home")
        .to_string_lossy()
        .into_owned();
    config.user_env.insert(
        "MOCK_CODEX_APP_SERVER_SCENARIO".to_string(),
        scenario.to_string(),
    );
    let runtime = GuestRuntime {
        http: HttpClient::for_config(&config)?,
        config,
        paths,
        workload_containment: None,
        process_control_endpoint: None,
    };
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let server = MockServer::start();
    let accepted = server.mock(|when, then| {
        when.method(POST).path(format!(
            "/api/runners/runs/{RUN_ID}/steerable-inputs/{ACCEPTED_ID}/steered"
        ));
        then.status(200).json_body(json!({ "outcome": "steered" }));
    });
    let not_submitted = server.mock(|when, then| {
        when.method(POST).path_matches(format!(
            "/api/runners/runs/{RUN_ID}/steerable-inputs/({REJECTED_ID}|{QUEUED_ID})/steered"
        ));
        then.status(200).json_body(json!({ "outcome": "steered" }));
    });
    let input = ActiveInputRuntime::new(
        RUN_ID,
        &runtime.config.prompt,
        HttpClient::with_api_config(server.base_url(), "test-token", RUN_ID, Duration::ZERO)?,
    );
    for (id, text) in [
        (ACCEPTED_ID, "accepted follow-up"),
        (REJECTED_ID, "rejected follow-up"),
        (QUEUED_ID, "queued follow-up"),
    ] {
        assert_eq!(
            input.controller().handle_control_payload(
                &guest_contracts::active_input::encode_active_input(id, text)?
            ),
            ActiveInputControlOutcome::Accepted
        );
    }
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
            input.into_writer(),
        ),
    )
    .await?;
    let status = match scenario {
        "steer-rejected-after-completion" | "steer-rejected-before-completion" => Some("completed"),
        "steer-rejected-failed-turn" => Some("failed"),
        "steer-rejected-interrupted-turn" => Some("interrupted"),
        _ => None,
    };
    if let Some(status) = status {
        let result = result?;
        assert_eq!(
            result.exit_code,
            if status == "completed" { 0 } else { 1 },
            "{scenario}"
        );
        let events = common::json_fixture::read_json_lines(runtime.paths.agent_log_file())?;
        let terminal = events
            .iter()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
            .ok_or("missing terminal result")?;
        assert_eq!(
            terminal.pointer("/turn/status").and_then(Value::as_str),
            Some(status)
        );
        assert_eq!(
            terminal.get("usage"),
            Some(&common::expected_codex_turn_usage())
        );
        let replies = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("item.completed")
                    && event.pointer("/item/type").and_then(Value::as_str) == Some("agent_message")
            })
            .filter_map(|event| event.pointer("/item/text").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            replies,
            ["codex-mock app-server response: retain this original turn accepted follow-up"]
        );
    } else {
        let error = result
            .err()
            .ok_or("uncorrelated or uncertain rejection must fail")?
            .to_string();
        let expected = match scenario {
            "steer-rejected-wrong-turn" => "turn id",
            "steer-rejected-wrong-code" => "code=-32603",
            "steer-rejected-other-error" => "steering disabled",
            "steer-disconnected-after-completion" => "turn/steer",
            _ => return Err(format!("unexpected scenario: {scenario}").into()),
        };
        assert!(error.contains(expected), "unexpected error: {error}");
    }
    accepted.assert_calls(1);
    not_submitted.assert_calls(0);
    let inputs = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    let [initial, accepted_input] = inputs.as_slice() else {
        return Err(format!(
            "{scenario}: expected exactly two submitted inputs, got {}",
            inputs.len()
        )
        .into());
    };
    assert_eq!(initial.get("kind").and_then(Value::as_str), Some("initial"));
    assert_eq!(
        accepted_input.get("text").and_then(Value::as_str),
        Some("accepted follow-up")
    );
    assert_eq!(
        accepted_input
            .get("turn_request_client_user_message_id")
            .and_then(Value::as_str),
        Some(ACCEPTED_ID)
    );
    Ok(())
}
