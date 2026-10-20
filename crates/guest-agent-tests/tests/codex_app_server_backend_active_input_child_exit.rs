//! Active-input child-exit coverage for Codex app-server execution.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_fails_visible_when_child_exits_during_steer()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    for sigkill in [false, true] {
        let tmp = tempfile::tempdir()?;
        let wrapper = tmp.path().join("codex-fixture");
        let binary = if sigkill {
            std::os::unix::fs::symlink(&mock, tmp.path().join("codex-fixture.real"))?;
            std::fs::write(
                &wrapper,
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$HOME/codex-pid\"\nexec \"$0.real\" \"$@\"\n",
            )?;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700))?;
            &wrapper
        } else {
            &mock
        };

        unsafe {
            common::setup_codex_app_server_env(
                binary,
                tmp.path(),
                common::CodexAppServerEnvConfig {
                    run_id: "codex-app-server-backend-active-input-child-exit-test",
                    prompt: "drive the app-server backend child exit during steer path",
                    scenario: Some(if sigkill {
                        "wait-on-turn-steer-response"
                    } else {
                        "exit-on-turn-steer"
                    }),
                    resume_session_id: None,
                },
            )?;
        }
        let runtime = common::guest_runtime_from_process_env()?;
        let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);

        let active_input = common::active_input_runtime(&runtime)?;
        let payload = common::active_input_payload("child-exit follow-up prompt")?;
        assert_eq!(
            active_input.controller().handle_control_payload(&payload),
            ActiveInputControlOutcome::Accepted
        );

        let masker = SecretMasker::from_raw("");
        let execution = common::execute_cli_with_active_input_for_runtime(
            &runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        );
        tokio::pin!(execution);
        if sigkill {
            let ready_file = tmp.path().join(common::MOCK_CODEX_TURN_STEER_READY_FILE);
            tokio::select! {
                result = &mut execution => panic!("steer ended before child kill: {result:?}"),
                ready = common::wait_for_file_contains(
                    &ready_file,
                    common::MOCK_CODEX_TURN_STEER_READY_EVENT,
                    Duration::from_secs(5),
                ) => ready?,
            }
            let pid: i32 = std::fs::read_to_string(tmp.path().join("codex-pid"))?
                .trim()
                .parse()?;
            let pid = rustix::process::Pid::from_raw(pid).ok_or("invalid native PID")?;
            rustix::process::kill_process(pid, rustix::process::Signal::KILL)?;
            // Observe without reaping before polling the backend again, so the
            // recorded signal belongs to the natural exit, never its cleanup.
            let observed = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::task::spawn_blocking(move || {
                    rustix::process::waitid(
                        rustix::process::WaitId::Pid(pid),
                        rustix::process::WaitIdOptions::EXITED
                            | rustix::process::WaitIdOptions::NOWAIT,
                    )
                    .map(|status| status.is_some())
                }),
            )
            .await???;
            assert!(observed, "native child must exit before backend cleanup");
        }
        let result = tokio::time::timeout(Duration::from_secs(5), execution)
            .await
            .expect("execute_cli_with_active_input should return promptly");

        let error = result.expect_err("child exit should fail the app-server backend");
        if sigkill {
            assert!(matches!(error, AgentError::CliProcessExited { .. }));
            let diagnostic = guest_agent::failure_diagnostics::cli_execution_error_for_config(
                &runtime.config,
                &error,
            );
            assert!(diagnostic.is_codex_app_server_sigkill());
        }
        let message = error.to_string();
        assert!(
            message.contains("active input steer failed")
                && (message.contains("waiting for turn/steer")
                    || message.contains("disconnected while waiting for turn/steer")),
            "unexpected error: {message}"
        );
    }

    Ok(())
}
