//! Pi initial-prompt stdin failures keep neutral diagnostics and bounded reaping.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn pi_initial_prompt_stdin_failure_reap_escalates_to_sigkill()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let npx = bin_dir.join("npx");
    std::fs::write(
        &npx,
        r#"#!/bin/sh
set -eu
trap '' TERM
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":1,"ownershipTransferMode":"sandbox-first"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111146\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
exec 0<&-
exec tail -f /dev/null
"#,
    )?;
    let mut permissions = std::fs::metadata(&npx)?.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&npx, permissions)?;

    let run_id = "00000000-0000-4000-8000-000000000146";
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), run_id)?;
    let large_prompt = "x".repeat(2 * 1024 * 1024);
    unsafe {
        common::clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, run_id);
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
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "3",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "60",
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
                prompt: large_prompt,
                pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111146".to_string(),
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

    let runtime = common::guest_runtime_from_process_env()?;
    let checkpoints = [common::VirtualTimeCheckpoint::new(
        runtime.paths.system_log_file(),
        "CLI stdin writer failed, SIGTERM",
        runtime.config.post_result_sigkill_grace,
    )];

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        common::execute_with_virtual_time_checkpoints(
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
            &checkpoints,
        ),
    )
    .await
    .expect("Pi execute_cli did not return within 15s - stdin failure reap likely broken")?;

    let result = result.expect("Pi execute_cli returned Err before controlled termination");
    let control_error = result
        .control_error
        .as_ref()
        .expect("Pi stdin writer failure should preserve a controlled execution error");
    assert!(
        control_error.to_string().contains("Broken pipe"),
        "expected broken pipe stdin error, got {control_error}"
    );
    assert!(
        !control_error.to_string().contains("Claude"),
        "Pi control error should not attribute the writer to Claude: {control_error}"
    );
    let termination = result
        .cli_termination
        .expect("Pi stdin writer failure should attach CLI termination diagnostics");
    assert_eq!(termination.reason, CliTerminationReason::InitialPromptStdin);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert_eq!(termination.observed_exit_code, Some(common::SIGKILL_EXIT));

    let system_log = std::fs::read_to_string(runtime.paths.system_log_file())?;
    assert!(
        system_log.contains("CLI stdin writer failed, SIGTERM"),
        "Pi stdin failure should use neutral CLI ownership: {system_log}"
    );
    assert!(
        !system_log.contains("Claude stdin writer"),
        "Pi stdin failure should not be attributed to Claude: {system_log}"
    );

    Ok(())
}
