//! Deferred Pi auth failures remain the primary diagnostic and prevent the CLI
//! process from starting.
//!
//! The parent configures all environment-dependent inputs before spawning the
//! ignored child test, so the running test process never mutates global env.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const RUN_ID: &str = "00000000-0000-4000-8000-000000000401";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111401";
const SANDBOX_TOKEN: &str = "rejected-sandbox-control-token-34795";
const AGENT_TOKEN: &str = "ordinary-agent-token-34795";
const CHILD_COMPLETE: &str = "deferred handoff auth failure child passed";

#[tokio::test]
async fn handoff_unauthorized_failure_prevents_child_spawn_and_masks_credentials()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let rejected = server.mock(|when, then| {
        when.method(GET)
            .path(format!("/api/runners/jobs/{RUN_ID}/pi-handoff/0"))
            .header("Authorization", format!("Bearer {SANDBOX_TOKEN}"));
        then.status(401)
            .header("Content-Type", "application/json")
            .json_body(json!({ "error": { "message": "unauthorized" } }));
    });
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let child_started = tmp.path().join("child-started");
    let npx = bin_dir.join("npx");
    std::fs::write(&npx, "#!/bin/sh\ntouch \"$CHILD_STARTED_FILE\"\nexit 0\n")?;
    std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o700))?;

    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    let deadline_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .saturating_add(60_000);
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: "do not start without authenticated handoff".to_string(),
            pi_launch_config: json!({
                "schemaVersion": 2,
                "apiFirstTurn": {
                    "schemaVersion": 2,
                    "ownerEpoch": 7,
                    "generation": 3,
                    "deadlineAt": deadline_at,
                    "resourceSnapshotDigest": "a".repeat(64),
                    "baseSession": { "sessionId": SESSION_ID, "sha256": null },
                    "sandboxEventSequenceStart": 1,
                    "continuation": { "mode": "untouched-h0" },
                    "runId": RUN_ID,
                    "historyHash": "b".repeat(64),
                    "activeInput": false
                }
            })
            .to_string(),
            pi_model_config: "{}".to_string(),
            pi_session_id: SESSION_ID.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&user_env_dir)?;
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    std::fs::write(
        &user_env_path,
        serde_json::to_vec(&HashMap::from([
            ("OKOU_TOKEN".to_string(), AGENT_TOKEN.to_string()),
            (
                "CLI_PKG_URL".to_string(),
                "https://example.invalid/current-okou-cli.tgz".to_string(),
            ),
            (
                "CHILD_STARTED_FILE".to_string(),
                child_started.to_string_lossy().into_owned(),
            ),
        ]))?,
    )?;

    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--exact",
            "unauthorized_handoff_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi")
        .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, SANDBOX_TOKEN)
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
            &runtime_dir,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            payload_path,
        )
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            user_env_path,
        )
        .env("HOME", tmp.path())
        .env(
            "PATH",
            std::env::join_paths([bin_dir.as_path(), Path::new("/usr/bin"), Path::new("/bin")])?,
        )
        .current_dir(tmp.path());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "deferred handoff auth failure child did not finish",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "handoff auth failure child failed with {}; stdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains(CHILD_COMPLETE),
        "handoff auth failure child did not complete assertions; stdout:\n{stdout}\nstderr:\n{stderr}"
    );

    rejected.assert_hits(1);
    assert!(!child_started.exists());
    assert!(!guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir).exists());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned with an isolated Guest startup environment by the parent test"]
async fn unauthorized_handoff_child() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = common::guest_runtime_from_process_env()?;
    assert_eq!(runtime.config.api_token, SANDBOX_TOKEN);
    assert_eq!(
        runtime
            .config
            .user_env
            .get("OKOU_TOKEN")
            .map(String::as_str),
        Some(AGENT_TOKEN)
    );
    let error = common::execute_cli_for_runtime(
        &runtime,
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
    )
    .await
    .expect_err("HTTP 401 must stop before child spawn");
    let diagnostic = error.to_string();
    assert!(diagnostic.contains("Deferred Pi handoff read failed: HTTP 401"));
    assert!(!diagnostic.contains(SANDBOX_TOKEN));
    assert!(!diagnostic.contains(AGENT_TOKEN));
    println!("{CHILD_COMPLETE}");
    Ok(())
}
