//! Deferred Pi auth failures remain the primary diagnostic and prevent the CLI
//! process from starting.

mod common;

use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::{SystemTime, UNIX_EPOCH};

const RUN_ID: &str = "00000000-0000-4000-8000-000000000401";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111401";
const SANDBOX_TOKEN: &str = "rejected-sandbox-control-token-34795";
const AGENT_TOKEN: &str = "ordinary-agent-token-34795";

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
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, RUN_ID);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            server.base_url(),
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, SANDBOX_TOKEN);
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
        common::set_user_env_file_env_for_test(
            &runtime_dir,
            &HashMap::from([
                ("OKOU_TOKEN".to_string(), AGENT_TOKEN.to_string()),
                (
                    "CLI_PKG_URL".to_string(),
                    "https://example.invalid/current-okou-cli.tgz".to_string(),
                ),
                (
                    "CHILD_STARTED_FILE".to_string(),
                    child_started.to_string_lossy().into_owned(),
                ),
            ]),
        )?;
    }
    std::env::set_current_dir(tmp.path())?;
    let runtime = common::guest_runtime_from_process_env()?;
    let error = common::execute_cli_for_runtime(
        &runtime,
        &SecretMasker::from_raw(""),
        common::spawn_dummy_heartbeat(),
    )
    .await
    .expect_err("HTTP 401 must stop before child spawn");
    let diagnostic = error.to_string();

    rejected.assert_hits(1);
    assert!(!child_started.exists());
    assert!(diagnostic.contains("Deferred Pi handoff read failed: HTTP 401"));
    assert!(!diagnostic.contains(SANDBOX_TOKEN));
    assert!(!diagnostic.contains(AGENT_TOKEN));
    assert!(!guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir).exists());
    Ok(())
}
