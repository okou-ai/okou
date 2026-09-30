//! A parity miss or legacy context uses the task's captured package through
//! `npx`. The local mock records invocation and performs no network access.

mod common;

use guest_agent::masker::SecretMasker;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn pi_parity_miss_and_legacy_context_use_captured_package()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let server = common::RecordingServer::start(200, Duration::ZERO).await?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/npx-args\"\nexit 23\n",
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let original_directory = std::env::current_dir()?;
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let run_id = "00000000-0000-4000-8000-000000000200";
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            &server.base_url,
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "test-token");
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
        paths.extend(std::env::split_paths(&original_path));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "launch the captured CLI for a legacy Pi context".to_string(),
                pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111111".to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([(
                "CLI_PKG_URL".to_string(),
                "https://example.invalid/current-okou-cli.tgz".to_string(),
            )]),
        )?;
    }
    common::ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(tmp.path())?;

    let mut runtime = common::guest_runtime_from_process_env()?;
    for requirement in [
        "",
        // The feature-backed installed fixture has digest dddd..., so this
        // requirement exercises a genuine digest mismatch in coverage CI.
        r#"{"requiredPiAgentRuntimeVersion":"1.36.0","minCliVersion":"9.353.0","requiredPiSessionConstructionDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}"#,
    ] {
        runtime.config.pi_installed_cli_requirement = requirement.to_string();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await
        .expect("local npx mock must finish within the test budget")
        .expect("the local fallback process must be launched");
        assert_ne!(
            result.exit_code, 0,
            "the mock intentionally fails before RPC startup"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("npx-args"))?,
            "--yes\n--no-audit\n--package=https://example.invalid/current-okou-cli.tgz\nokou\n__agent-loop\n"
        );
        std::fs::remove_file(tmp.path().join("npx-args"))?;
    }
    std::env::set_current_dir(&original_directory)?;
    Ok(())
}
