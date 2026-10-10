//! Codex setup failures should stop before launching the CLI.
//!
//! This test uses the real guest-agent binary because the fail-closed boundary
//! lives in `main.rs`, not in the public `cli::setup_codex` helper.

mod common;

use guest_contracts::diagnostics::{FailureClass, FailureDiagnostic};
use serde_json::Value;
use shell_quote::quote_shell_arg;
use std::path::Path;
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;

const GUEST_AGENT_TIMEOUT: Duration = Duration::from_secs(20);

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn codex_setup_failure_exits_before_cli_spawn() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let fake_codex = tmp.path().join("codex");
    let invoked_marker = tmp.path().join("codex-invoked");
    let runtime_dir = tmp.path().join("runtime");
    let codex_home_path = tmp.path().join(".codex");
    std::fs::write(&codex_home_path, b"not a directory")?;
    write_fake_codex(&fake_codex, &invoked_marker)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "should not reach codex".to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let output = run_guest_agent(GuestAgentInvocation {
        fake_codex: &fake_codex,
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-auth-setup-fail-closed",
    })
    .await?;

    assert!(
        !output.status.success(),
        "guest-agent should fail when Codex setup cannot reconcile"
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !invoked_marker.exists(),
        "guest-agent must not launch Codex after setup fails"
    );

    let error_path = guest_contracts::runtime_paths::finalization_error_file(&runtime_dir);
    let error = std::fs::read_to_string(error_path)?;
    assert!(
        error.contains("Codex setup failed"),
        "guest error should describe Codex setup failure: {error}"
    );

    let diagnostic_path = guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir);
    let diagnostic: FailureDiagnostic = serde_json::from_slice(&std::fs::read(diagnostic_path)?)?;
    assert_eq!(diagnostic.failure_class, FailureClass::CliExecutionError);

    let sandbox_ops_path = guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir);
    let sandbox_ops = std::fs::read_to_string(sandbox_ops_path)?;
    let startup = sandbox_ops
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|operation| {
            operation.get("action_type").and_then(Value::as_str) == Some("codex_startup")
        })
        .collect::<Vec<_>>();
    assert_eq!(startup.len(), 1);
    let startup = startup
        .first()
        .ok_or(std::io::Error::other("missing Codex startup operation"))?;
    assert_eq!(startup.get("success").and_then(Value::as_bool), Some(false));
    assert!(startup.get("duration_ms").and_then(Value::as_u64).is_some());
    assert!(startup.get("error").is_none());

    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn codex_setup_rejects_symlinked_home_before_model_catalog_write() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let tmp = tempfile::tempdir()?;
    let fake_codex = tmp.path().join("codex");
    let invoked_marker = tmp.path().join("codex-invoked");
    let runtime_dir = tmp.path().join("runtime");
    let target_codex_home = tmp.path().join("target-codex-home");
    std::fs::create_dir_all(&target_codex_home)?;
    std::os::unix::fs::symlink(&target_codex_home, tmp.path().join(".codex"))?;
    write_fake_codex(&fake_codex, &invoked_marker)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "should not reach codex".to_string(),
            codex_runtime_config: serde_json::json!({
                "providerId": "openrouter-codex",
                "name": "OpenRouter (Codex)",
                "baseUrl": "https://openrouter.ai/api/v1",
                "envKey": "OPENAI_API_KEY",
                "wireApi": "responses",
                "supportsWebsockets": false,
                "modelCatalog": {
                    "models": [{ "slug": "deepseek-v4-flash" }],
                },
            })
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let output = run_guest_agent(GuestAgentInvocation {
        fake_codex: &fake_codex,
        runtime_dir: &runtime_dir,
        run_payload_path: &run_payload_path,
        home: tmp.path(),
        run_id: "codex-auth-setup-symlink-fail-closed",
    })
    .await?;

    assert!(
        !output.status.success(),
        "guest-agent should fail when Codex setup rejects symlinked CODEX_HOME"
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !invoked_marker.exists(),
        "guest-agent must not launch Codex after setup fails"
    );
    assert!(
        !target_codex_home.join("models.json").exists(),
        "Codex setup must not write model catalog through symlinked CODEX_HOME"
    );

    let error_path = guest_contracts::runtime_paths::finalization_error_file(&runtime_dir);
    let error = std::fs::read_to_string(error_path)?;
    assert!(
        error.contains("Codex setup failed"),
        "guest error should describe Codex setup failure: {error}"
    );

    Ok(())
}

struct GuestAgentInvocation<'a> {
    fake_codex: &'a Path,
    runtime_dir: &'a Path,
    run_payload_path: &'a Path,
    home: &'a Path,
    run_id: &'a str,
}

async fn run_guest_agent(args: GuestAgentInvocation<'_>) -> Result<Output, std::io::Error> {
    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let mut command = Command::new(guest_agent);
    command
        .env_clear()
        .env("CLI_AGENT_TYPE", "codex")
        .env("USE_MOCK_CODEX", "true")
        .env(
            guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
            args.fake_codex,
        )
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
        .env(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        )
        .env("OKOU_TEST_CODEX_HOME_DIR", args.home.join(".codex"))
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            args.runtime_dir,
        )
        .env("HOME", args.home);
    let timeout_context = format!(
        "codex_setup_fail_closed guest-agent scenario '{}' exceeded its completion budget",
        args.run_id
    );
    common::command_output_with_timeout(&mut command, GUEST_AGENT_TIMEOUT, &timeout_context).await
}

fn write_fake_codex(path: &Path, marker: &Path) -> TestResult {
    let marker_path = marker.to_string_lossy();
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf invoked > {}\nexit 0\n",
            quote_shell_arg(&marker_path)
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}
