//! Deferred Pi handoff uses the Guest's Sandbox control credential while the
//! CLI child keeps its ordinary agent token and receives only private bytes.

mod common;

use base64::Engine as _;
use guest_agent::masker::SecretMasker;
use httpmock::prelude::*;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RUN_ID: &str = "00000000-0000-4000-8000-000000000321";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111321";
const SANDBOX_TOKEN: &str = "sandbox-control-token-34795";
const AGENT_TOKEN: &str = "ordinary-agent-token-34795";

#[tokio::test]
async fn guest_authenticates_handoff_without_exposing_its_control_token()
-> Result<(), Box<dyn std::error::Error>> {
    common::ensure_canonical_workspace_for_test()?;
    let server = MockServer::start();
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let child_started = tmp.path().join("child-started");
    let expected_handoff = tmp.path().join("expected-handoff.json");
    let handoff_bytes = serde_json::to_vec(&json!({
        "sessionHistory": "h".repeat(1024 * 1024),
        "resourceSnapshot": { "schemaVersion": 1, "agentsFiles": [], "skills": [] }
    }))?;
    std::fs::write(&expected_handoff, &handoff_bytes)?;
    let (first, final_chunk) = handoff_bytes.split_at(1024 * 1024);

    let first_handoff = server.mock(|when, then| {
        when.method(GET)
            .path(format!("/api/runners/jobs/{RUN_ID}/pi-handoff/0"))
            .header("Authorization", format!("Bearer {SANDBOX_TOKEN}"));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "chunk": base64::engine::general_purpose::STANDARD.encode(first),
                "nextOffset": 1024 * 1024
            }));
    });
    let final_handoff = server.mock(|when, then| {
        when.method(GET)
            .path(format!(
                "/api/runners/jobs/{RUN_ID}/pi-handoff/{}",
                1024 * 1024
            ))
            .header("Authorization", format!("Bearer {SANDBOX_TOKEN}"));
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({
                "chunk": base64::engine::general_purpose::STANDARD.encode(final_chunk),
                "nextOffset": null
            }));
    });
    let _events = server.mock(|when, then| {
        when.method(POST).path("/api/webhooks/agent/events");
        then.status(200)
            .header("Content-Type", "application/json")
            .json_body(json!({}));
    });

    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
test "$*" = "--yes --no-audit --package=https://example.invalid/current-okou-cli.tgz okou __agent-loop"
test "${OKOU_TOKEN:-}" = "ordinary-agent-token-34795"
test -z "${OKOU_API_TOKEN:-}"
test -n "${OKOU_PI_DEFERRED_HANDOFF_FILE:-}"
cmp "$OKOU_PI_DEFERRED_HANDOFF_FILE" "$EXPECTED_HANDOFF_FILE"
touch "$CHILD_STARTED_FILE"
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"sandbox-first"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000321:pi:get-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"11111111-1111-4111-8111-111111111321","sessionFile":"/home/user/.pi/agent/sessions/deferred.jsonl"}}'
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' '{"id":"00000000-0000-4000-8000-000000000321:pi:initial-prompt","type":"response","command":"prompt","success":true}'
printf '%s\n' '{"type":"agent_settled"}'
if IFS= read -r unexpected; then
  exit 23
fi
"#,
    )?;
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
                prompt: "continue from authenticated H0".to_string(),
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
                        "activeInput": true
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
                    "EXPECTED_HANDOFF_FILE".to_string(),
                    expected_handoff.to_string_lossy().into_owned(),
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
    let secrets = format!(
        "{},{}",
        base64::engine::general_purpose::STANDARD.encode(SANDBOX_TOKEN),
        base64::engine::general_purpose::STANDARD.encode(AGENT_TOKEN)
    );
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        common::execute_cli_for_runtime(
            &runtime,
            &SecretMasker::from_raw(&secrets),
            common::spawn_dummy_heartbeat(),
        ),
    )
    .await
    .expect("authenticated deferred Pi CLI should finish")?;

    assert_eq!(result.exit_code, common::CLEAN_EXIT);
    assert!(child_started.is_file());
    first_handoff.assert_hits(1);
    final_handoff.assert_hits(1);
    let actual_handoff = guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir);
    assert_eq!(std::fs::read(&actual_handoff)?, handoff_bytes);
    assert_eq!(
        std::fs::metadata(actual_handoff)?.permissions().mode() & 0o777,
        0o600
    );
    Ok(())
}
