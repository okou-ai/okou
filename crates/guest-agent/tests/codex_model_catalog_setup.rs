//! Codex model-catalog setup must finish before the configured CLI starts.

mod common;

use serde_json::{Value, json};
use shell_quote::quote_shell_arg;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const GUEST_AGENT_TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn codex_setup_writes_model_catalog_before_cli_start() -> TestResult {
    common::ensure_canonical_workspace_for_test()?;

    let mock_codex = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let recording_codex = tmp.path().join("recording-codex");
    let observed_argv = tmp.path().join("observed-argv");
    let observed_catalog = tmp.path().join("observed-models.json");
    let runtime_dir = tmp.path().join("runtime");
    let codex_home = tmp.path().join("codex-home");
    write_recording_codex(
        &recording_codex,
        &mock_codex,
        &observed_argv,
        &observed_catalog,
    )?;

    let model_catalog = json!({
        "models": [{
            "slug": "deepseek-v4-flash",
            "display_name": "DeepSeek V4 Flash",
            "context_window": 131_072,
            "unknown_model_field": { "preserve": true },
        }],
        "unknown_catalog_field": "preserve",
    });
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "verify Codex model catalog setup".to_string(),
            codex_runtime_config: json!({
                "providerId": "openrouter-codex",
                "name": "OpenRouter (Codex)",
                "baseUrl": "https://openrouter.ai/api/v1",
                "envKey": "OPENAI_API_KEY",
                "wireApi": "responses",
                "supportsWebsockets": false,
                "modelCatalog": model_catalog,
            })
            .to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;

    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env("CLI_AGENT_TYPE", "codex")
        .env("USE_MOCK_CODEX", "true")
        .env(
            guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
            &recording_codex,
        )
        .env(
            guest_contracts::env::RUN_ID_ENV,
            "codex-model-catalog-setup",
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &run_payload_path,
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
        .env("OKOU_TEST_CODEX_HOME_DIR", &codex_home)
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            &runtime_dir,
        )
        .env("HOME", tmp.path());
    let output = common::command_output_with_timeout(
        &mut command,
        GUEST_AGENT_TIMEOUT,
        "guest-agent model catalog setup timed out",
    )
    .await?;

    assert!(
        output.status.success(),
        "guest-agent failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let catalog_observed_at_start: Value =
        serde_json::from_slice(&std::fs::read(&observed_catalog)?)?;
    assert_eq!(catalog_observed_at_start, model_catalog);

    let argv = std::fs::read_to_string(&observed_argv)?;
    let argv = argv.lines().collect::<Vec<_>>();
    let catalog_path = codex_home.join("models.json");
    let expected_override = format!("model_catalog_json=\"{}\"", catalog_path.to_string_lossy());
    assert!(
        argv.windows(2)
            .any(|window| window[0] == "-c" && window[1] == expected_override),
        "Codex argv must reference the catalog observed at startup: {argv:?}"
    );

    Ok(())
}

fn write_recording_codex(
    path: &Path,
    mock_codex: &Path,
    observed_argv: &Path,
    observed_catalog: &Path,
) -> TestResult {
    let mock_codex = mock_codex.to_string_lossy();
    let observed_argv = observed_argv.to_string_lossy();
    let observed_catalog = observed_catalog.to_string_lossy();
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\nset -eu\n/bin/cp \"$CODEX_HOME/models.json\" {}\n: > {}\nfor arg in \"$@\"; do\n  printf '%s\\n' \"$arg\" >> {}\ndone\nexec {} \"$@\"\n",
            quote_shell_arg(&observed_catalog),
            quote_shell_arg(&observed_argv),
            quote_shell_arg(&observed_argv),
            quote_shell_arg(&mock_codex),
        ),
    )?;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}
