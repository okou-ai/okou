//! Integration coverage for the guest-agent process-control channel.
//!
//! Lower-level protocol status mapping, nonce validation, queue limits, and
//! concurrent routing live in guest-control-client/guest-control-server tests. This test keeps the
//! guest-agent layer focused on the real bootstrap path: host vsock -> spawned
//! guest-agent process -> ControlHandle IPC -> host ack.

mod common;

use std::fs::File;
use std::io::{self, Write};
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use guest_control_client::{ExecOwnedCapturedOutput, SupervisedExecControl, SupervisedExecRequest};
use guest_control_proto::{
    ExecOutputPolicy, ExecOutputStream, ExecTermination, ExecTimeoutPolicy, VSOCK_PORT,
};
use shell_quote::quote_shell_arg;

const PRE_READY_CONTROL_MESSAGE_ID: &str = "process-control-before-cli-ready";
const READY_CONTROL_MESSAGE_ID: &str = "process-control-after-cli-ready";

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

struct MockStartGate {
    writer: File,
}

struct ConnectionHarness {
    host: Option<guest_control_client::GuestControlClient>,
    guest: Option<thread::JoinHandle<io::Result<()>>>,
}

impl MockStartGate {
    fn create(dir: &Path, mock: &Path) -> TestResult<(Self, PathBuf)> {
        let fifo = dir.join("mock-start.fifo");
        let c_fifo = std::ffi::CString::new(fifo.as_os_str().as_bytes())?;
        // SAFETY: c_fifo is a valid NUL-terminated path and the mode is a
        // normal POSIX permission mask for a test-only FIFO.
        if unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) } != 0 {
            return Err(io::Error::last_os_error().into());
        }

        // Keep both FIFO ends open so the wrapper can block on its read even
        // when the test releases it before the wrapper reaches that read.
        // SAFETY: c_fifo remains valid for the call and ownership of the
        // returned descriptor transfers to File below.
        let fd = unsafe {
            libc::open(
                c_fifo.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: fd is a freshly opened descriptor owned by this function.
        let writer = unsafe { File::from_raw_fd(fd) };

        let wrapper = dir.join("gated-mock-claude.sh");
        let script = format!(
            "#!/bin/sh\nIFS= read -r _ < {}\nexec {} \"$@\"\n",
            quote_shell_arg(&fifo.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        );
        std::fs::write(&wrapper, script)?;
        let mut permissions = std::fs::metadata(&wrapper)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&wrapper, permissions)?;

        Ok((Self { writer }, wrapper))
    }

    fn release(&mut self) -> io::Result<()> {
        self.writer.write_all(b"start\n")
    }
}

impl ConnectionHarness {
    fn new(
        host: guest_control_client::GuestControlClient,
        guest: thread::JoinHandle<io::Result<()>>,
    ) -> Self {
        Self {
            host: Some(host),
            guest: Some(guest),
        }
    }

    #[allow(clippy::expect_used)]
    fn host(&self) -> &guest_control_client::GuestControlClient {
        self.host
            .as_ref()
            .expect("connection harness host should be present")
    }

    fn finish(mut self) -> TestResult<()> {
        drop(self.host.take());
        if let Some(guest) = self.guest.take() {
            join_guest(guest)?;
        }
        Ok(())
    }
}

impl Drop for ConnectionHarness {
    fn drop(&mut self) {
        drop(self.host.take());
        if let Some(guest) = self.guest.take() {
            let _ = join_guest(guest);
        }
    }
}

#[tokio::test]
async fn process_control_channel_reaches_guest_agent() -> TestResult<()> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let (mut mock_start_gate, gated_mock) = MockStartGate::create(tmp.path(), &mock)?;
    let run_id = format!(
        "process-control-channel-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let prompt = "@active-input-smoke:2";
    let workdir = tmp.path().to_string_lossy().into_owned();
    let mock_path = gated_mock.to_string_lossy().into_owned();
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let run_payload_path = run_payload_path.to_string_lossy().into_owned();
    let env = [
        ("CLI_AGENT_TYPE", "claude-code"),
        (
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path.as_str(),
        ),
        ("USE_MOCK_CLAUDE", "true"),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "1",
        ),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        ),
        (guest_contracts::env::RUN_ID_ENV, run_id.as_str()),
        (
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            run_payload_path.as_str(),
        ),
        (
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        ),
        (guest_contracts::env::CANONICAL_API_TOKEN_ENV, ""),
        (
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        ),
        (
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        ),
        ("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true"),
        ("HOME", workdir.as_str()),
    ];

    common::ensure_canonical_workspace_for_test()?;
    let connection = start_host_and_guest(tmp.path(), PathBuf::from(guest_agent)).await?;
    let mut handle = connection
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            timeout_is_expected: false,
            role: guest_control_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 30_000 },
            command: "",
            env: &env,
            sudo: false,
            label: "guest-agent-process-control-channel",
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024 * 1024,
                chunk_limit_bytes: 8192,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Enabled { sink: true },
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(10),
        })
        .await?;
    let mut stdout_rx = handle
        .take_stream_receiver()
        .ok_or("supervised exec should expose stdout stream")?;

    let pre_ready_payload = guest_contracts::active_input::encode_active_input(
        "1e208848-53bc-440a-85d8-adcd048e167c",
        "before-ready",
    )?;
    let pre_ready_ack = handle
        .control(
            PRE_READY_CONTROL_MESSAGE_ID,
            &pre_ready_payload,
            Duration::from_secs(10),
        )
        .await?;

    mock_start_gate.release()?;
    let mut stdout = collect_stdout_until(
        &mut stdout_rx,
        b"READY_FOR_ACTIVE_INPUT",
        Duration::from_secs(10),
    )
    .await?;

    let ready_payload = guest_contracts::active_input::encode_active_input(
        "e6c121e3-9a6f-4835-87c0-a31b042f3008",
        "after-ready",
    )?;
    let ack = handle
        .control(
            READY_CONTROL_MESSAGE_ID,
            &ready_payload,
            Duration::from_secs(10),
        )
        .await?;

    let exit = handle.wait(Duration::from_secs(20)).await?;
    stdout.extend(collect_stdout(&mut stdout_rx, Duration::from_secs(5)).await?);

    connection.finish()?;

    assert_eq!(pre_ready_ack.message_id, PRE_READY_CONTROL_MESSAGE_ID);
    assert_eq!(ack.message_id, READY_CONTROL_MESSAGE_ID);
    assert!(
        matches!(exit.termination, ExecTermination::Exited { exit_code: 0 }),
        "guest-agent failed: termination={:?} diagnostic={} stderr={}",
        exit.termination,
        exit.diagnostic,
        captured_output_lossy(&exit.stderr)
    );
    assert!(
        String::from_utf8_lossy(&stdout).contains("RESULT=before-ready+after-ready"),
        "guest-agent stdout did not include active-input result: {}",
        String::from_utf8_lossy(&stdout)
    );

    Ok(())
}

#[tokio::test]
async fn process_control_enabled_plain_run_does_not_wait_for_stdin_eof() -> TestResult<()> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let run_id = format!(
        "process-control-plain-run-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );

    let guest_agent = env!("CARGO_BIN_EXE_guest-agent");
    let prompt = "printf no-active-input";
    let workdir = tmp.path().to_string_lossy().into_owned();
    let mock_path = mock.to_string_lossy().into_owned();
    let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(tmp.path(), &run_id)?;
    let run_payload_path = common::write_run_payload_file_for_test(
        &runtime_dir,
        &guest_contracts::env::RunPayload {
            prompt: prompt.to_string(),
            ..guest_contracts::env::RunPayload::default()
        },
    )?;
    let run_payload_path = run_payload_path.to_string_lossy().into_owned();
    let env = [
        ("CLI_AGENT_TYPE", "claude-code"),
        (
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path.as_str(),
        ),
        ("USE_MOCK_CLAUDE", "true"),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            "1",
        ),
        (
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            "1",
        ),
        (guest_contracts::env::RUN_ID_ENV, run_id.as_str()),
        (
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            run_payload_path.as_str(),
        ),
        (
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        ),
        (guest_contracts::env::CANONICAL_API_TOKEN_ENV, ""),
        (
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        ),
        (
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        ),
        ("OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL", "true"),
        ("HOME", workdir.as_str()),
    ];

    common::ensure_canonical_workspace_for_test()?;
    let connection = start_host_and_guest(tmp.path(), PathBuf::from(guest_agent)).await?;
    let handle = connection
        .host()
        .start_supervised_exec(SupervisedExecRequest {
            timeout_is_expected: false,
            role: guest_control_proto::ExecProcessRole::Agent,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 30_000 },
            command: "",
            env: &env,
            sudo: false,
            label: "guest-agent-process-control-plain-run",
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: 1024 * 1024,
            },
            expected_exit_codes: &[],
            stdin_bytes: None,
            control: SupervisedExecControl::Enabled { sink: true },
            stream_queue_capacity: None,
            start_timeout: Duration::from_secs(10),
        })
        .await?;

    let exit = handle.wait(Duration::from_secs(20)).await?;

    connection.finish()?;

    let stdout = captured_output_lossy(&exit.stdout);
    assert!(
        matches!(exit.termination, ExecTermination::Exited { exit_code: 0 }),
        "guest-agent failed: termination={:?} diagnostic={} stdout={} stderr={}",
        exit.termination,
        exit.diagnostic,
        stdout,
        captured_output_lossy(&exit.stderr)
    );
    assert!(
        stdout.contains("no-active-input"),
        "guest-agent stdout did not include plain run result: {stdout}"
    );

    Ok(())
}

#[tokio::test]
async fn host_listener_startup_failure_is_preserved() -> TestResult<()> {
    let tmp = tempfile::tempdir()?;
    let overlong_listener_dir = tmp.path().join("x".repeat(108));
    std::fs::create_dir(&overlong_listener_dir)?;

    let error = match start_host_and_guest(&overlong_listener_dir, PathBuf::new()).await {
        Ok(_) => return Err("overlong host listener path unexpectedly started".into()),
        Err(error) => error,
    };
    let listener_error = error.downcast_ref::<io::Error>().ok_or_else(|| {
        io::Error::other(format!("expected host listener io::Error, got {error}"))
    })?;

    assert_eq!(listener_error.kind(), io::ErrorKind::InvalidInput);

    Ok(())
}

async fn collect_stdout_until(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<guest_control_client::ExecOutputEvent>,
    needle: &[u8],
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stdout = Vec::new();
        while let Some(event) = stdout_rx.recv().await {
            if event.stream == ExecOutputStream::Stdout && !event.truncated {
                stdout.extend_from_slice(&event.chunk);
                if stdout.windows(needle.len()).any(|window| window == needle) {
                    return Ok(stdout);
                }
            }
        }
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "stdout closed before expected marker",
        ))
    })
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "timed out waiting for stdout marker",
        )
    })?
}

async fn start_host_and_guest(dir: &Path, guest_agent: PathBuf) -> TestResult<ConnectionHarness> {
    let base_path = dir.join("vsock").to_string_lossy().to_string();
    let listener_path = format!("{base_path}_{VSOCK_PORT}");
    let listener = PathBuf::from(&listener_path);
    let host_base_path = base_path.clone();
    let mut host_task = tokio::spawn(async move {
        guest_control_client::GuestControlClient::wait_for_connection(
            &host_base_path,
            Duration::from_secs(5),
        )
        .await
    });

    tokio::select! {
        ready = common::wait_for_path(&listener, Duration::from_secs(5)) => {
            if let Err(error) = ready {
                host_task.abort();
                let _ = host_task.await;
                return Err(error.into());
            }
        }
        completed = &mut host_task => {
            return match completed {
                Ok(Ok(host)) => {
                    drop(host);
                    Err(io::Error::other("host accepted a guest before the test started one"))
                }
                Ok(Err(error)) => Err(error),
                Err(error) => Err(io::Error::other(format!("host listener task failed: {error}"))),
            }
            .map_err(Into::into);
        }
    }

    let guest = thread::spawn(move || {
        let stream = guest_control_server::connect_unix(&listener_path)?;
        guest_control_server::handle_connection_with_test_guest_agent_program(stream, guest_agent)
    });

    let host = match host_task.await? {
        Ok(host) => host,
        Err(error) => {
            let _ = join_guest(guest);
            return Err(error.into());
        }
    };
    Ok(ConnectionHarness::new(host, guest))
}

async fn collect_stdout(
    stdout_rx: &mut tokio::sync::mpsc::Receiver<guest_control_client::ExecOutputEvent>,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
        let mut stdout = Vec::new();
        while let Some(event) = stdout_rx.recv().await {
            if event.stream == ExecOutputStream::Stdout && !event.truncated {
                stdout.extend_from_slice(&event.chunk);
            }
        }
        stdout
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out draining stdout"))
}

fn captured_output_lossy(output: &ExecOwnedCapturedOutput) -> String {
    match output {
        ExecOwnedCapturedOutput::Discarded => String::new(),
        ExecOwnedCapturedOutput::Captured { bytes, .. } => String::from_utf8_lossy(bytes).into(),
    }
}

fn join_guest(guest: thread::JoinHandle<io::Result<()>>) -> TestResult<()> {
    guest
        .join()
        .map_err(|_| io::Error::other("guest thread panicked"))??;
    Ok(())
}
