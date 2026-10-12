//! Queued-terminal active-input coverage for Codex app-server execution.
//!
//! An isolated child keeps CLI ingestion blocked on real stdout backpressure
//! while its control-plane observer submits a fresh follow-up input.

mod common;

use guest_agent::active_input::ActiveInputControlOutcome;
use guest_agent::masker::SecretMasker;
use guest_contracts::active_input::ACTIVE_INPUT_CLOSED_DIAGNOSTIC;
use rustix::fs::{CWD, Mode, mkfifoat};
use serde_json::Value;
use std::io;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream, unix::pipe};
use tokio::process::Command;
use uuid::Uuid;

const RUN_ID: &str = "codex-app-server-backend-active-input-queued-terminal-test";
const INGESTION_MARKER: &str = "queued-terminal-ingestion-boundary:";
const CHECKPOINT_READ_BYTES: usize = 256;
const PROBE_SOCKET: &str = "queued-terminal-probe.sock";
const LATE_EVENT_ID: &str = "223f8797-a456-4eea-98f7-f7ab88c43c01";
const LATE_INPUT: &str = "late follow-up during queued terminal ingestion";
const CHILD_COMPLETE: &str = "Codex queued-terminal boundary assertions passed";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn codex_app_server_backend_closes_input_before_ingesting_queued_terminal()
-> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock_codex()?;
    let tmp = tempfile::tempdir()?;
    let stdout_path = tmp.path().join("stdout.fifo");
    mkfifoat(CWD, &stdout_path, Mode::RUSR | Mode::WUSR)?;
    // Keeping both ends open avoids premature EOF before the child opens stdout.
    let mut stdout = pipe::OpenOptions::new()
        .read_write(true)
        .open_receiver(&stdout_path)?;
    // SAFETY: stdout owns a live FIFO descriptor; F_GETPIPE_SZ only queries it.
    let pipe_capacity = unsafe { libc::fcntl(stdout.as_raw_fd(), libc::F_GETPIPE_SZ) };
    if pipe_capacity < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let pipe_capacity = usize::try_from(pipe_capacity)?;
    let padding_bytes = pipe_capacity * 4;
    assert!(padding_bytes > pipe_capacity + CHECKPOINT_READ_BYTES);
    let prompt = format!("@shell@\nprintf '{INGESTION_MARKER}%{padding_bytes}s' x\n@end-shell@");
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), RUN_ID)?;
    let payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt,
            ..Default::default()
        },
    )?;
    common::ensure_canonical_workspace_for_test()?;

    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "exec \"$@\" > \"$BOUNDARY_STDOUT\"",
            "queued-terminal-child",
        ])
        .arg(std::env::current_exe()?)
        .args([
            "--exact",
            "codex_app_server_backend_closes_input_before_ingesting_queued_terminal_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("BOUNDARY_STDOUT", &stdout_path)
        .env(guest_contracts::env::CLI_AGENT_TYPE_ENV, "codex")
        .env(guest_contracts::env::USE_MOCK_CODEX_ENV, "true")
        .env(guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV, mock)
        .env(
            "MOCK_CODEX_APP_SERVER_SCENARIO",
            "runtime-turn-complete-before-steer-response",
        )
        .env(guest_contracts::env::RUN_ID_ENV, RUN_ID)
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
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            payload_path,
        )
        .env("HOME", tmp.path())
        .env("OKOU_TEST_CODEX_HOME_DIR", tmp.path().join("codex-home"))
        .env("PATH", "/usr/bin:/bin")
        .current_dir(tmp.path());
    if let Some(llvm_profile_file) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", llvm_profile_file);
    }

    let execution = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "queued-terminal child test did not finish",
    );
    tokio::pin!(execution);
    let checkpoint = tokio::time::timeout(Duration::from_secs(5), async {
        let mut observed = Vec::new();
        let mut buffer = [0; CHECKPOINT_READ_BYTES];
        loop {
            let count = stdout.read(&mut buffer).await?;
            observed.extend_from_slice(&buffer[..count]);
            if observed
                .windows(INGESTION_MARKER.len())
                .any(|window| window == INGESTION_MARKER.as_bytes())
            {
                break;
            }
        }
        // The completed assistant item is queued before the terminal event.
        // Its print cannot finish with more padding than the FIFO can hold, so
        // neither terminal ingestion nor the later cleanup closes can run yet.
        let mut probe = UnixStream::connect(tmp.path().join(PROBE_SOCKET)).await?;
        probe.write_all(b"probe").await?;
        let acknowledgement = probe.read_u8().await?;
        if acknowledgement != b'C' {
            return Err(io::Error::other(
                "child did not confirm the closed-input assertion",
            ));
        }
        Ok::<(), io::Error>(())
    });
    let checkpoint_result = tokio::select! {
        output = &mut execution => {
            let output = output?;
            return Err(format!(
                "child exited before the ingestion checkpoint: {}; stderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stderr),
            ).into());
        }
        result = checkpoint => result,
    };

    // Release stdout on both success and failed assertions, then await the
    // shared helper's bounded session cleanup before reporting either failure.
    let mut buffer = [0; 8192];
    let mut drain_error = None;
    let output = loop {
        tokio::select! {
            output = &mut execution => break output?,
            read = stdout.read(&mut buffer), if drain_error.is_none() => {
                if let Err(error) = read {
                    drain_error = Some(error);
                }
            }
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "queued-terminal child failed with {}; checkpoint: {checkpoint_result:?}; stderr:\n{stderr}",
        output.status,
    );
    checkpoint_result??;
    if let Some(error) = drain_error {
        return Err(error.into());
    }
    assert!(
        stderr.contains(CHILD_COMPLETE),
        "child did not complete its assertions; stderr:\n{stderr}",
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "spawned with isolated startup inputs and stdout backpressure by the parent test"]
async fn codex_app_server_backend_closes_input_before_ingesting_queued_terminal_child()
-> Result<(), Box<dyn std::error::Error>> {
    let runtime = Arc::new(common::guest_runtime_from_process_env()?);
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let probe_listener =
        UnixListener::bind(std::path::Path::new(&runtime.config.home_dir).join(PROBE_SOCKET))?;

    let active_input = common::active_input_runtime(&runtime)?;
    let controller = active_input.controller();
    let payload = common::active_input_payload("follow-up before queued terminal")?;
    let (original_event_id, _) =
        guest_contracts::active_input::decode_active_input(&payload)?.into_parts();
    assert_ne!(
        original_event_id, LATE_EVENT_ID,
        "the probe must not test idempotency"
    );
    assert_eq!(
        controller.handle_control_payload(&payload),
        ActiveInputControlOutcome::Accepted
    );

    // Keep the controller on this main future, with a second runtime worker
    // available to drive socket I/O while execution is blocked printing stdout.
    let execution_runtime = Arc::clone(&runtime);
    let execution = tokio::spawn(async move {
        let masker = SecretMasker::from_raw("");
        common::execute_cli_with_active_input_for_runtime(
            &execution_runtime,
            &masker,
            common::spawn_dummy_heartbeat(),
            active_input.into_writer(),
        )
        .await
    });
    let (mut probe, _) = probe_listener.accept().await?;
    let mut request = [0; 5];
    probe.read_exact(&mut request).await?;
    assert_eq!(&request, b"probe");
    let late_payload =
        guest_contracts::active_input::encode_active_input(LATE_EVENT_ID, LATE_INPUT)?;
    assert_eq!(
        controller.handle_control_payload(&late_payload),
        ActiveInputControlOutcome::Rejected {
            diagnostic: ACTIVE_INPUT_CLOSED_DIAGNOSTIC,
        },
        "fresh input must be rejected while queued terminal ingestion is blocked",
    );
    // Only this acknowledgement allows the parent to release stdout ingestion.
    probe.write_all(b"C").await?;

    let cli_result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .expect("CLI execution should return promptly after stdout is released")??;
    assert_eq!(cli_result.exit_code, common::CLEAN_EXIT);

    let input_events = common::read_codex_session_history_events_for_runtime(&runtime)?
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("mock.app_server.input"))
        .collect::<Vec<_>>();
    assert_eq!(input_events.len(), 2);
    assert_eq!(input_events[0]["kind"], "initial");
    assert_eq!(input_events[1]["kind"], "steered");
    assert_eq!(input_events[1]["text"], "follow-up before queued terminal");
    assert!(input_events.iter().all(|event| event["text"] != LATE_INPUT));
    let client_user_message_id = input_events[1]["turn_request_client_user_message_id"]
        .as_str()
        .expect("steered input should carry an internal UUID");
    assert!(Uuid::parse_str(client_user_message_id).is_ok());
    eprintln!("{CHILD_COMPLETE}");
    Ok(())
}
