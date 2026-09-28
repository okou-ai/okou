//! The Pi startup boundary must be installed privately before any official
//! RPC record enters the public event pipeline.

mod common;

use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

struct BoundaryCase {
    name: &'static str,
    script: &'static str,
    expected_code: &'static str,
}

#[tokio::test]
async fn guest_fails_closed_for_invalid_missing_conflicting_and_late_pi_boundaries()
-> Result<(), Box<dyn std::error::Error>> {
    let cases = [
        BoundaryCase {
            name: "missing",
            script: r#"printf '%s\n' '{"type":"response"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_MISSING",
        },
        BoundaryCase {
            name: "legacy-schema",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":1,"sandboxEventSequenceStart":4}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "zero",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":0,"ownershipTransferMode":"sandbox-first"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "overflowing",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":2147483648,"ownershipTransferMode":"sandbox-first"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "v2-missing-mode",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "v2-unknown-mode",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4,"ownershipTransferMode":"future-mode"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "retired-api-first-mode",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4,"ownershipTransferMode":"pending-tool-continuation"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "future-schema",
            script: r#"printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":3,"sandboxEventSequenceStart":4,"ownershipTransferMode":"sandbox-first"}'"#,
            expected_code: "PI_HANDOFF_BOUNDARY_INVALID",
        },
        BoundaryCase {
            name: "conflicting",
            script: r#"
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4,"ownershipTransferMode":"sandbox-first"}'
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":5,"ownershipTransferMode":"sandbox-first"}'
"#,
            expected_code: "PI_HANDOFF_BOUNDARY_CONFLICT",
        },
        BoundaryCase {
            name: "late",
            script: r#"
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4,"ownershipTransferMode":"sandbox-first"}'
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111111\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
printf '%s\n' '{"type":"vm0_pi_api_first_turn_boundary","schemaVersion":2,"sandboxEventSequenceStart":4,"ownershipTransferMode":"sandbox-first"}'
"#,
            expected_code: "PI_HANDOFF_BOUNDARY_LATE",
        },
    ];
    let original_directory = std::env::current_dir()?;
    let base_path = std::env::var_os("PATH").unwrap_or_default();

    for (index, case) in cases.iter().enumerate() {
        let tmp = tempfile::tempdir()?;
        let server = common::RecordingServer::start(200, Duration::ZERO).await?;
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir)?;
        let npx = bin_dir.join("npx");
        std::fs::write(
            &npx,
            format!(
                "#!/bin/sh\nset -eu\n{}\nwhile :; do sleep 1; done\n",
                case.script
            ),
        )?;
        let mut permissions = std::fs::metadata(&npx)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&npx, permissions)?;

        let run_id = format!("00000000-0000-4000-8000-{:012}", index + 200);
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
        unsafe {
            common::clear_guest_agent_bootstrap_env_for_test();
            std::env::set_var(guest_contracts::env::CLI_AGENT_TYPE_ENV, "pi");
            std::env::set_var(guest_contracts::env::RUN_ID_ENV, &run_id);
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
            paths.extend(std::env::split_paths(&base_path));
            std::env::set_var("PATH", std::env::join_paths(paths)?);
            common::set_run_payload_file_env_for_test(
                &runtime_dir,
                &guest_contracts::env::RunPayload {
                    prompt: format!("reject {} Pi handoff boundary", case.name),
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

        let runtime = common::guest_runtime_from_process_env()?;
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            common::execute_cli_for_runtime(
                &runtime,
                &SecretMasker::from_raw(""),
                common::spawn_dummy_heartbeat(),
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("{} boundary case timed out", case.name))?;
        std::env::set_current_dir(&original_directory)?;

        let control_error = result
            .control_error
            .unwrap_or_else(|| panic!("{} boundary case must fail", case.name))
            .to_string();
        assert!(
            control_error.contains(case.expected_code),
            "{} boundary case produced unexpected error: {control_error}",
            case.name
        );
        assert!(!control_error.contains("2147483648"));
        assert_eq!(
            result.cli_termination.map(|termination| termination.reason),
            Some(CliTerminationReason::StdoutIngestion)
        );

        let agent_log =
            std::fs::read_to_string(guest_contracts::runtime_paths::agent_log_file(&runtime_dir))?;
        assert!(!agent_log.contains("vm0_pi_api_first_turn_boundary"));
        assert!(!agent_log.contains("sandboxEventSequenceStart"));
        for request in server.requests()? {
            assert!(!request.body.contains("vm0_pi_api_first_turn_boundary"));
            assert!(!request.body.contains("sandboxEventSequenceStart"));
        }
    }

    Ok(())
}
