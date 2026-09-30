//! Pi user cancellation must interrupt a steer blocked on child stdin.

mod common;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use tokio_util::sync::CancellationToken;

const RUN_ID: &str = "00000000-0000-4000-8000-000000000145";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111145";
const EVENT_ID: &str = "22222222-2222-4222-8222-222222222145";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn pi_cancellation_reaps_child_with_stalled_steer_write()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let child_pid_path = tmp.path().join("pi-child.pid");
    let steer_started_path = tmp.path().join("pi-steer-started");
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$PI_CHILD_PID_PATH"
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111145\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
dd bs=1 count=1 of=/dev/null 2>/dev/null
printf '%s\n' 'steer-started' > "$PI_STEER_STARTED_PATH"
while :; do
  sleep 60
done
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, RUN_ID);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        );
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "cancel Pi while steer is blocked on stdin".to_string(),
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
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "PI_CHILD_PID_PATH".to_string(),
                    child_pid_path.to_string_lossy().into_owned(),
                ),
                (
                    "PI_STEER_STARTED_PATH".to_string(),
                    steer_started_path.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let active_input = common::active_input_runtime(&runtime)?;
    let controller = active_input.controller();
    let payload_limit =
        api_contracts::generated::constants::runners::ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
            as usize;
    let payload = guest_contracts::active_input::encode_active_input(
        EVENT_ID,
        &"x".repeat(payload_limit - 256),
    )?;
    assert!(payload.len() <= payload_limit);
    assert!(payload.len() > payload_limit - 512);
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    let cancellation = CancellationToken::new();
    let masker = SecretMasker::from_raw("");
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        common::spawn_dummy_heartbeat(),
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), cancellation.clone(), None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    );
    tokio::pin!(execution);
    tokio::select! {
        result = &mut execution => {
            return Err(format!("Pi execution ended before steer stalled: {result:?}").into());
        }
        ready = common::wait_for_file_contains(
            &steer_started_path,
            "steer-started",
            Duration::from_secs(5),
        ) => ready?,
    }

    let child_pid = std::fs::read_to_string(&child_pid_path)?
        .trim()
        .parse::<u32>()?;
    let child_process_path = PathBuf::from(format!("/proc/{child_pid}"));
    assert!(
        child_process_path.exists(),
        "stalled Pi child must be live before cancellation"
    );

    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(10), execution)
        .await
        .expect("Pi cancellation should terminate the stalled child")?;

    let control_error = result
        .control_error
        .as_ref()
        .ok_or_else(|| std::io::Error::other("Pi cancellation omitted its controlled error"))?;
    assert!(
        control_error.to_string().contains("Run cancelled by user"),
        "unexpected cancellation error: {control_error}"
    );
    assert_eq!(
        result
            .cli_termination
            .ok_or_else(|| std::io::Error::other("Pi cancellation omitted termination details"))?
            .reason,
        CliTerminationReason::UserCancellation
    );
    assert!(
        !child_process_path.exists(),
        "stalled Pi child must be reaped before execution returns"
    );

    Ok(())
}
