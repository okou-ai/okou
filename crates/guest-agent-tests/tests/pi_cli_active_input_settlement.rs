//! A settled Pi steer closes stdin and preserves post-result cleanup when the
//! execution deadline reaps a child that remains alive after stdin EOF.

use guest_agent_tests as common;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};

use guest_agent::active_input::{ActiveInputControlOutcome, ActiveInputRuntime};
use guest_agent::cli::{
    CliExecutionControls, JsonlResultStatus, execute_cli_with_controls_for_config_started_at,
};
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use tokio_util::sync::CancellationToken;

const RUN_ID: &str = "00000000-0000-4000-8000-000000000146";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111146";
const EVENT_ID: &str = "22222222-2222-4222-8222-222222222146";

#[tokio::test]
async fn pi_settled_steer_preserves_cleanup_at_execution_deadline()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let child_pid_path = tmp.path().join("pi-child.pid");
    let eof_path = tmp.path().join("pi-stdin-eof");
    let okou = tmp.path().join("okou");
    std::fs::write(
        &okou,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$PI_CHILD_PID_PATH"
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111146\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
IFS= read -r steer_command
case "$steer_command" in
  *'"id":"22222222-2222-4222-8222-222222222146"'*'"type":"steer"'*) ;;
  *) exit 23 ;;
esac
printf '%s\n' '{"id":"22222222-2222-4222-8222-222222222146","type":"response","command":"steer","success":true}' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"completed steer"}],"stopReason":"stop","usage":{}}}' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 24
fi
printf '%s\n' 'stdin-eof' > "$PI_STDIN_EOF_PATH"
exec sleep 60
"#,
    )?;
    std::fs::set_permissions(&okou, std::fs::Permissions::from_mode(0o700))?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, RUN_ID);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var("HOME", tmp.path());
        std::env::set_var("OKOU_TEST_PI_CLI_PATH", &okou);
        std::env::set_var(
            guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
            "5",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "60",
        );
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "complete a steered Pi turn".to_string(),
                pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: SESSION_ID.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                (
                    "PI_CHILD_PID_PATH".to_string(),
                    child_pid_path.to_string_lossy().into_owned(),
                ),
                (
                    "PI_STDIN_EOF_PATH".to_string(),
                    eof_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let active_input = ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        runtime.http.clone(),
    );
    let controller = active_input.controller();
    let payload = guest_contracts::active_input::encode_active_input(EVENT_ID, "finish this turn")?;
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), CancellationToken::new(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    // Observed stdin EOF proves result-time closure before advancing to the
    // execution deadline. The child's real process is then reaped by cleanup.
    let checkpoints = [common::VirtualTimeCheckpoint::new(
        eof_path.to_str().ok_or("non-UTF-8 EOF path")?,
        "stdin-eof",
        runtime
            .config
            .agent_execution_timeout
            .ok_or("missing execution deadline")?,
    )];
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_with_virtual_time_checkpoints(execution, &checkpoints),
    )
    .await
    .expect("settled Pi child should be reaped within its cleanup bound")??;

    assert!(
        result.control_error.is_none(),
        "completed execution must retain its result: {:?}",
        result.control_error
    );
    assert_eq!(
        result.jsonl_result.as_ref().map(|result| result.status),
        Some(JsonlResultStatus::Success)
    );
    assert_eq!(
        result
            .post_result_cleanup_jsonl_result
            .as_ref()
            .map(|result| result.status),
        Some(JsonlResultStatus::Success)
    );
    let termination = result
        .cli_termination
        .ok_or("missing post-result termination")?;
    assert_eq!(termination.reason, CliTerminationReason::PostResultReap);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    let child_pid = std::fs::read_to_string(&child_pid_path)?
        .trim()
        .parse::<u32>()?;
    assert!(
        !std::path::Path::new(&format!("/proc/{child_pid}")).exists(),
        "the Pi child must be reaped before execution returns"
    );
    let declaration_path =
        format!("/api/runners/runs/{RUN_ID}/steerable-inputs/{EVENT_ID}/steered");
    assert_eq!(
        server
            .requests()?
            .iter()
            .filter(|request| request.path == declaration_path)
            .count(),
        1
    );
    Ok(())
}
