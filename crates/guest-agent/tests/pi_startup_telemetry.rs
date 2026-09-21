//! Entry-point coverage for Pi sandbox startup telemetry.
//!
//! Mirrors `codex_startup_telemetry.rs`: the Pi run must produce exactly one
//! `pi_startup` operation on both the success and the failure path, and must
//! not produce a Codex one. It additionally covers the sandbox-side preparation
//! envelopes, because their only production writer is the CLI child's stderr
//! and only this path proves the guest converts them into sandbox operations.

mod common;

use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

const PI_STARTUP_ACTION: &str = "pi_startup";
const CODEX_STARTUP_ACTION: &str = "codex_startup";
const PI_LAUNCH_PAYLOAD_ACTION: &str = "pi_launch_payload_prepare";
const GUEST_AGENT_TIMEOUT: Duration = Duration::from_secs(20);
const PI_SESSION_ID: &str = "11111111-1111-4111-8111-111111111111";

type TestError = Box<dyn std::error::Error>;
type TestResult = Result<(), TestError>;

/// Phases `createPiAgentSession` reports from the sandbox, with their outcomes.
const OBSERVED_PHASES: [(&str, &str); 6] = [
    ("resources_prompt", "success"),
    ("model_runtime", "success"),
    ("session_services", "success"),
    ("resource_loader", "success"),
    ("session_create", "success"),
    ("session_finalize", "error"),
];

#[tokio::test]
async fn pi_records_startup_success_at_first_projected_record() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let npx = install_mock_npx(tmp.path(), &serving_pi_host_script())?;

    let output = run_pi_guest_agent(&runtime_dir, tmp.path(), &npx, "pi-startup-success").await?;

    assert_guest_success(&output);
    let operations = read_sandbox_operations(&runtime_dir)?;
    assert_one_startup(&operations, PI_STARTUP_ACTION, true)?;
    assert!(
        operations.iter().all(|operation| {
            operation.get("action_type").and_then(Value::as_str) != Some(CODEX_STARTUP_ACTION)
        }),
        "Pi must not emit Codex startup telemetry: {operations:?}"
    );

    Ok(())
}

#[tokio::test]
async fn pi_records_startup_failure_when_the_host_never_serves() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let npx = install_mock_npx(tmp.path(), "#!/bin/sh\nexit 3\n")?;

    let output = run_pi_guest_agent(&runtime_dir, tmp.path(), &npx, "pi-startup-failure").await?;

    assert!(
        !output.status.success(),
        "a Pi host that never serves must not report success"
    );
    let operations = read_sandbox_operations(&runtime_dir)?;
    assert_one_startup(&operations, PI_STARTUP_ACTION, false)?;

    Ok(())
}

#[tokio::test]
async fn pi_records_sandbox_preparation_phases_from_the_host_envelopes() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let npx = install_mock_npx(tmp.path(), &serving_pi_host_script())?;

    let output =
        run_pi_guest_agent(&runtime_dir, tmp.path(), &npx, "pi-preparation-phases").await?;

    assert_guest_success(&output);
    let operations = read_sandbox_operations(&runtime_dir)?;
    for (phase, outcome) in OBSERVED_PHASES {
        let action = format!("pi_prepare_{phase}");
        let recorded = operations_named(&operations, &action);
        assert_eq!(recorded.len(), 1, "expected one {action}: {operations:?}");
        let operation = recorded
            .first()
            .ok_or_else(|| std::io::Error::other(format!("missing {action} operation")))?;
        assert_eq!(
            operation.get("success").and_then(Value::as_bool),
            Some(outcome == "success"),
            "{action} success must follow its outcome: {operation}"
        );
        assert_eq!(
            operation.get("outcome").and_then(Value::as_str),
            Some(outcome),
            "{action} must carry its bounded outcome: {operation}"
        );
        assert!(
            operation
                .get("duration_ms")
                .and_then(Value::as_u64)
                .is_some(),
            "{action} must carry a numeric duration: {operation}"
        );
    }
    assert!(
        operations_named(&operations, "pi_prepare_invented_phase").is_empty(),
        "an unknown phase must not widen op_type cardinality: {operations:?}"
    );
    assert_eq!(
        operations_named(&operations, PI_LAUNCH_PAYLOAD_ACTION).len(),
        1,
        "the guest-owned launch payload write must be measured: {operations:?}"
    );

    Ok(())
}

/// Mock Pi host: installs the handoff boundary, answers the official RPC
/// commands, and reports its preparation phases on stderr the way the real
/// sandbox CLI does.
fn serving_pi_host_script() -> String {
    let mut script = String::from("#!/bin/sh\nset -eu\n");
    for (phase, outcome) in OBSERVED_PHASES {
        script.push_str(&format!(
            "printf '%s\\n' '{{\"type\":\"pi_preparation_timing\",\"runId\":\"run\",\"phase\":\"{phase}\",\"durationMs\":7.5,\"outcome\":\"{outcome}\"}}' >&2\n"
        ));
    }
    script.push_str(
        "printf '%s\\n' '{\"type\":\"pi_preparation_timing\",\"runId\":\"run\",\"phase\":\"invented_phase\",\"durationMs\":1,\"outcome\":\"success\"}' >&2\n",
    );
    script.push_str(
        r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"sandbox-first"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
"#,
    );
    script.push_str(&format!(
        "printf '%s\\n' '{{\"id\":\"{run}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{{\"sessionId\":\"{session}\",\"sessionFile\":\"/home/user/.pi/agent/sessions/x/session.jsonl\"}}}}'\n",
        run = guest_run_id(),
        session = PI_SESSION_ID,
    ));
    script.push_str(
        r#"IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
"#,
    );
    script.push_str(&format!(
        "printf '%s\\n' '{{\"id\":\"{run}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}}'\n",
        run = guest_run_id(),
    ));
    script.push_str(
        r#"printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ready"}],"model":"deepseek-v4-flash","responseId":"response-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"stopReason":"stop","timestamp":1}}'
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    );
    script
}

/// The mock host answers with command IDs scoped to this run id.
fn guest_run_id() -> &'static str {
    "00000000-0000-4000-8000-000000000123"
}

fn install_mock_npx(home: &Path, script: &str) -> Result<PathBuf, TestError> {
    let bin_dir = home.join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let npx = bin_dir.join("npx");
    std::fs::write(&npx, script)?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;
    Ok(npx)
}

async fn run_pi_guest_agent(
    runtime_dir: &Path,
    home: &Path,
    npx: &Path,
    scenario: &str,
) -> Result<Output, TestError> {
    let run_payload_path = common::write_run_payload_file_for_test(
        runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "measure Pi sandbox startup".to_string(),
            pi_launch_config:
                r#"{"schemaVersion":2,"apiFirstTurn":{"sandboxEventSequenceStart":1}}"#.to_string(),
            pi_model_config: "{}".to_string(),
            pi_session_id: PI_SESSION_ID.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let user_env_path = write_user_env_file(runtime_dir)?;
    let bin_dir = npx.parent().ok_or("mock npx must live in a directory")?;
    let path_value = std::env::join_paths([bin_dir, Path::new("/usr/bin"), Path::new("/bin")])?;

    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env(guest_contracts::env::RUN_ID_ENV, guest_run_id())
        .env("CLI_AGENT_TYPE", "pi")
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &run_payload_path,
        )
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &user_env_path,
        )
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "")
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        )
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        )
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        )
        .env("PATH", path_value)
        .env("HOME", home);

    let timeout_context =
        format!("pi_startup_telemetry guest-agent scenario '{scenario}' exceeded its budget");
    common::command_output_with_timeout(&mut command, GUEST_AGENT_TIMEOUT, &timeout_context)
        .await
        .map_err(Into::into)
}

fn write_user_env_file(runtime_dir: &Path) -> Result<PathBuf, TestError> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let user_env = HashMap::from([(
        "CLI_PKG_URL".to_string(),
        "https://example.invalid/current-okou-cli.tgz".to_string(),
    )]);
    std::fs::write(&path, serde_json::to_vec(&user_env)?)?;
    Ok(path)
}

fn read_sandbox_operations(runtime_dir: &Path) -> Result<Vec<Value>, TestError> {
    let path = guest_contracts::runtime_paths::sandbox_ops_log_file(runtime_dir);
    let contents = std::fs::read_to_string(path)?;
    contents
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn operations_named<'a>(operations: &'a [Value], action: &str) -> Vec<&'a Value> {
    operations
        .iter()
        .filter(|operation| operation.get("action_type").and_then(Value::as_str) == Some(action))
        .collect()
}

fn assert_one_startup(
    operations: &[Value],
    action: &str,
    expected_success: bool,
) -> Result<(), TestError> {
    let startup = operations_named(operations, action);
    assert_eq!(
        startup.len(),
        1,
        "unexpected {action} operations: {startup:?}"
    );
    let operation = startup
        .first()
        .ok_or_else(|| std::io::Error::other(format!("missing {action} operation")))?;
    assert_eq!(
        operation.get("success").and_then(Value::as_bool),
        Some(expected_success)
    );
    assert!(
        operation
            .get("duration_ms")
            .and_then(Value::as_u64)
            .is_some(),
        "{action} must contain a numeric duration: {operation}"
    );
    assert!(
        operation.get("ts").and_then(Value::as_str).is_some(),
        "{action} must contain a timestamp: {operation}"
    );
    assert!(
        operation.get("error").is_none(),
        "{action} must remain content-free: {operation}"
    );
    assert_eq!(
        operation.as_object().map(serde_json::Map::len),
        Some(4),
        "{action} must not add payload fields: {operation}"
    );

    Ok(())
}

fn assert_guest_success(output: &Output) {
    assert!(
        output.status.success(),
        "guest-agent failed with status {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
