//! Pi RPC response bursts must fail without blocking stdout or leaking the child.

mod common;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use guest_agent::cli::{CliExecutionControls, execute_cli_with_controls_for_config_started_at};
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const RESPONSE_PAYLOAD_MIB: usize = 9;
const PROMPT_BYTES: usize = 1024 * 1024;
const _: () = assert!(
    RESPONSE_PAYLOAD_MIB * 1024 * 1024
        < guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES
);

#[derive(Clone, Copy)]
struct OverloadCase {
    name: &'static str,
    run_id: &'static str,
    session_id: &'static str,
    expected_error: &'static str,
}

const COUNT_CASE: OverloadCase = OverloadCase {
    name: "count",
    run_id: "00000000-0000-4000-8000-000000000160",
    session_id: "11111111-1111-4111-8111-111111111160",
    expected_error: "Pi RPC response queue exceeded 2 pending responses",
};

const BYTE_CASE: OverloadCase = OverloadCase {
    name: "bytes",
    run_id: "00000000-0000-4000-8000-000000000161",
    session_id: "11111111-1111-4111-8111-111111111161",
    expected_error: "Pi RPC response byte buffer exhausted",
};

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn pi_response_buffer_overload_terminates_and_reaps_the_child()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;

    run_overload_case(tmp.path(), &server, COUNT_CASE).await?;
    run_overload_case(tmp.path(), &server, BYTE_CASE).await?;

    Ok(())
}

async fn run_overload_case(
    root: &Path,
    server: &common::RecordingServer,
    case: OverloadCase,
) -> Result<(), Box<dyn std::error::Error>> {
    let case_dir = root.join(case.name);
    let bin_dir = case_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let child_pid_path = case_dir.join("pi-child.pid");
    let prompt_started_path = case_dir.join("pi-prompt-started");
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$PI_CHILD_PID_PATH"
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"pending-tool-continuation"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"${PI_SESSION_ID}\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
dd bs=1 count=1 of=/dev/null 2>/dev/null
printf '%s\n' 'prompt-started' > "$PI_PROMPT_STARTED_PATH"
case "$PI_OVERLOAD_CASE" in
  count)
    index=0
    while [ "$index" -lt 3 ]; do
      printf '{"id":"overflow-%s","type":"response","command":"steer","success":true}\n' "$index"
      index=$((index + 1))
    done
    ;;
  bytes)
    index=0
    while [ "$index" -lt 2 ]; do
      printf '{"id":"overflow-%s","type":"response","command":"steer","success":true,"data":"' "$index"
      dd if=/dev/zero bs=1048576 count="$PI_RESPONSE_PAYLOAD_MIB" 2>/dev/null | tr '\000' x
      printf '"}\n'
      index=$((index + 1))
    done
    ;;
  *) exit 23 ;;
esac
while :; do
  sleep 60
done
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(&case_dir, case.run_id)?;
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "x".repeat(PROMPT_BYTES),
            pi_launch_config:
                r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#.to_string(),
            pi_model_config: "{}".to_string(),
            pi_session_id: case.session_id.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&HashMap::from([
            (
                "CLI_PKG_URL".to_string(),
                "https://example.invalid/current-okou-cli.tgz".to_string(),
            ),
            (
                "PI_CHILD_PID_PATH".to_string(),
                child_pid_path.to_string_lossy().into_owned(),
            ),
            (
                "PI_PROMPT_STARTED_PATH".to_string(),
                prompt_started_path.to_string_lossy().into_owned(),
            ),
            ("PI_OVERLOAD_CASE".to_string(), case.name.to_string()),
            (
                "PI_RESPONSE_PAYLOAD_MIB".to_string(),
                RESPONSE_PAYLOAD_MIB.to_string(),
            ),
            ("PI_SESSION_ID".to_string(), case.session_id.to_string()),
        ]))?,
    )?;
    common::ensure_canonical_workspace_for_test()?;

    // Configure startup inputs without mutating either running test process.
    // Clearing the environment also excludes inherited runner/bootstrap controls.
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "pi_response_buffer_overload_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi")
        .env(guest_contracts::env::RUN_ID_ENV, case.run_id)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token")
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        )
        .env("HOME", &case_dir)
        .env(
            "PATH",
            std::env::join_paths([bin_dir.as_path(), Path::new("/usr/bin"), Path::new("/bin")])?,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            payload_path,
        )
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            user_env_path,
        )
        .env("PI_OVERLOAD_CASE", case.name)
        .current_dir(&case_dir);
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    // The session owner also cleans CLI descendants in separate process groups
    // when the worker fails or times out, before the parent removes its files.
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(25),
        &format!("{} overload child test did not finish", case.name),
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "{} overload child test failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        case.name,
        output.status
    );
    assert!(
        stdout.contains(&format!("Pi {} overload assertions passed", case.name)),
        "{} overload child did not complete its assertions; stdout:\n{stdout}\nstderr:\n{stderr}",
        case.name
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned per case by the response-overload parent test"]
async fn pi_response_buffer_overload_child() -> Result<(), Box<dyn std::error::Error>> {
    let case = match std::env::var("PI_OVERLOAD_CASE")?.as_str() {
        "count" => COUNT_CASE,
        "bytes" => BYTE_CASE,
        other => return Err(format!("unknown Pi overload case: {other}").into()),
    };
    let case_dir = std::env::current_dir()?;
    let child_pid_path = case_dir.join("pi-child.pid");
    let prompt_started_path = case_dir.join("pi-prompt-started");

    let runtime = common::guest_runtime_from_process_env()?;
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let active_input = common::active_input_runtime(&runtime)?;

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        execute_cli_with_controls_for_config_started_at(
            &SecretMasker::from_raw(""),
            common::spawn_dummy_heartbeat(),
            runtime.http.clone(),
            CliExecutionControls::new(active_input.into_writer(), CancellationToken::new(), None),
            &runtime.config,
            &runtime.paths,
            Instant::now(),
        ),
    )
    .await??;

    assert_eq!(
        std::fs::read_to_string(&prompt_started_path)?.trim(),
        "prompt-started",
        "the response burst must start after the writer blocks on the initial prompt"
    );
    let child_pid = std::fs::read_to_string(&child_pid_path)?
        .trim()
        .parse::<u32>()?;
    let child_process_path = PathBuf::from(format!("/proc/{child_pid}"));
    let Some(error) = result.control_error.map(|error| error.to_string()) else {
        return Err("response overload should be a controlled execution error".into());
    };
    assert!(
        error.contains(case.expected_error),
        "unexpected {} overload error: {error}",
        case.name
    );
    if case.name == "bytes" {
        assert!(
            error.contains("16777216 bytes"),
            "byte overload should expose the configured budget: {error}"
        );
    }
    let Some(termination) = result.cli_termination else {
        return Err("response overload should record process-group termination".into());
    };
    assert_eq!(termination.reason, CliTerminationReason::StdoutIngestion);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigterm));
    assert!(!termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGTERM_EXIT));
    assert!(
        !child_process_path.exists(),
        "{} overload child must be reaped before execution returns",
        case.name
    );

    println!("Pi {} overload assertions passed", case.name);
    Ok(())
}
