//! Entry-point coverage for Codex startup telemetry.

mod common;

use serde_json::{Value, json};
use shell_quote::quote_shell_arg;
use std::path::Path;
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

const CODEX_STARTUP_ACTION: &str = "codex_startup";
const GUEST_AGENT_TIMEOUT: Duration = Duration::from_secs(20);

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn codex_records_startup_success_at_primary_turn_started() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let mock_codex = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_path = write_run_payload(&runtime_dir, "measure app-server startup")?;

    let output = run_guest_agent(GuestAgentInvocation {
        framework: TestFramework::Codex {
            binary: &mock_codex,
            app_server_scenario: Some("runtime-turn-complete-without-thread-started"),
        },
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-app-server-startup-success",
    })
    .await?;

    assert_guest_success(&output);
    let operations = read_sandbox_operations(&runtime_dir)?;
    assert_one_codex_startup(&operations, true)?;

    Ok(())
}

#[tokio::test]
async fn codex_secondary_turn_started_does_not_complete_startup() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let mock_codex = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_path = write_run_payload(&runtime_dir, "ignore secondary startup")?;

    let output = run_guest_agent(GuestAgentInvocation {
        framework: TestFramework::Codex {
            binary: &mock_codex,
            app_server_scenario: Some("secondary-thread-notifications"),
        },
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-app-server-secondary-startup",
    })
    .await?;

    assert_guest_success(&output);
    let operations = read_sandbox_operations(&runtime_dir)?;
    assert_one_codex_startup(&operations, false)?;

    Ok(())
}

#[tokio::test]
async fn claude_code_does_not_record_codex_startup() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let claude = tmp.path().join("claude");
    let runtime_dir = tmp.path().join("runtime");
    write_jsonl_executable(
        &claude,
        &[json!({
            "type": "result",
            "subtype": "success",
            "session_id": "claude-startup-control",
            "is_error": false,
            "duration_ms": 1,
            "num_turns": 1,
            "result": "done",
            "total_cost_usd": 0,
            "usage": {"input_tokens": 1, "output_tokens": 1}
        })],
        true,
    )?;
    let run_payload_path = write_run_payload(&runtime_dir, "run Claude Code")?;

    let output = run_guest_agent(GuestAgentInvocation {
        framework: TestFramework::ClaudeCode { binary: &claude },
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "claude-startup-control",
    })
    .await?;

    assert_guest_success(&output);
    let operations = read_sandbox_operations(&runtime_dir)?;
    assert!(
        operations.iter().all(|operation| {
            operation.get("action_type").and_then(Value::as_str) != Some(CODEX_STARTUP_ACTION)
        }),
        "Claude Code must not emit Codex startup telemetry: {operations:?}"
    );

    Ok(())
}

enum TestFramework<'a> {
    Codex {
        binary: &'a Path,
        app_server_scenario: Option<&'a str>,
    },
    ClaudeCode {
        binary: &'a Path,
    },
}

struct GuestAgentInvocation<'a> {
    framework: TestFramework<'a>,
    runtime_dir: &'a Path,
    run_payload_path: &'a Path,
    home: &'a Path,
    run_id: &'a str,
}

async fn run_guest_agent(args: GuestAgentInvocation<'_>) -> Result<Output, std::io::Error> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env(guest_contracts::env::RUN_ID_ENV, args.run_id)
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            args.run_payload_path,
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
        .env("OKOU_TEST_CODEX_HOME_DIR", args.home.join(".codex"))
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            args.runtime_dir,
        )
        .env("HOME", args.home);

    match args.framework {
        TestFramework::Codex {
            binary,
            app_server_scenario,
        } => {
            command
                .env("CLI_AGENT_TYPE", "codex")
                .env("USE_MOCK_CODEX", "true")
                .env(guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV, binary);
            if let Some(scenario) = app_server_scenario {
                command.env("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
            }
        }
        TestFramework::ClaudeCode { binary } => {
            command
                .env("CLI_AGENT_TYPE", "claude-code")
                .env("USE_MOCK_CLAUDE", "true")
                .env(guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV, binary);
        }
    }

    let timeout_context = format!(
        "codex_startup_telemetry guest-agent scenario '{}' exceeded its completion budget",
        args.run_id
    );
    common::command_output_with_timeout(&mut command, GUEST_AGENT_TIMEOUT, &timeout_context).await
}

fn write_run_payload(runtime_dir: &Path, prompt: &str) -> Result<std::path::PathBuf, String> {
    common::write_run_payload_file_for_test(
        runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )
}

fn write_jsonl_executable(path: &Path, events: &[Value], read_stdin: bool) -> TestResult {
    let mut script = "#!/bin/sh\n".to_string();
    if read_stdin {
        script.push_str("IFS= read -r _prompt || exit 1\n");
    }
    for event in events {
        let line = serde_json::to_string(event)?;
        script.push_str(&format!(
            "printf '%s\\n' {}\n",
            quote_shell_arg(line.as_str())
        ));
    }
    std::fs::write(path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn read_sandbox_operations(runtime_dir: &Path) -> Result<Vec<Value>, TestError> {
    let path = guest_contracts::runtime_paths::sandbox_ops_log_file(runtime_dir);
    let contents = std::fs::read_to_string(path)?;
    contents
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

fn assert_one_codex_startup(operations: &[Value], expected_success: bool) -> TestResult {
    let startup = operations
        .iter()
        .filter(|operation| {
            operation.get("action_type").and_then(Value::as_str) == Some(CODEX_STARTUP_ACTION)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        startup.len(),
        1,
        "unexpected startup operations: {startup:?}"
    );
    let operation = startup
        .first()
        .ok_or(std::io::Error::other("missing Codex startup operation"))?;
    assert_eq!(
        operation.get("success").and_then(Value::as_bool),
        Some(expected_success)
    );
    assert!(
        operation
            .get("duration_ms")
            .and_then(Value::as_u64)
            .is_some(),
        "startup operation must contain a numeric duration: {operation}"
    );
    assert!(
        operation.get("ts").and_then(Value::as_str).is_some(),
        "startup operation must contain a timestamp: {operation}"
    );
    assert!(
        operation.get("error").is_none(),
        "startup operation must remain content-free: {operation}"
    );
    assert_eq!(
        operation.as_object().map(serde_json::Map::len),
        Some(4),
        "startup operation must not add payload fields: {operation}"
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

type TestError = Box<dyn std::error::Error>;
