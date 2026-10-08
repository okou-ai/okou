//! Discarding an open oversized Pi record must not hide supervisor controls.

mod common;

use std::future::Future;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use guest_agent::cli::CliExecutionResult;
use guest_agent::env::{GuestConfig, GuestConfigRaw};
use guest_agent::error::AgentError;
use guest_agent::masker::SecretMasker;
use guest_agent::paths::GuestPaths;
use guest_agent::run_context::GuestRuntime;
use guest_contracts::diagnostics::{CliTerminationReason, CliTerminationSignal};
use guest_contracts::stdout_framing::ORDINARY_CLI_STDOUT_MAX_LINE_BYTES;
use rustix::process::{Pid, PidfdFlags, Signal};
use tokio_util::sync::CancellationToken;

type TestError = Box<dyn std::error::Error>;

struct OpenRecordFixture {
    runtime: GuestRuntime,
    ready_path: PathBuf,
    child_pid_path: PathBuf,
    holder_pid_path: PathBuf,
    holder_pidfd: std::sync::OnceLock<OwnedFd>,
    _tmp: tempfile::TempDir,
}

impl OpenRecordFixture {
    fn new(mode: &str) -> Result<Self, TestError> {
        let tmp = tempfile::tempdir()?;
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir_all(&bin_dir)?;
        let ready_path = tmp.path().join("record-written");
        let child_pid_path = tmp.path().join("child.pid");
        let holder_pid_path = tmp.path().join("stdout-holder.pid");
        let event_path = tmp.path().join("unterminated-agent-end");
        // The extra MiB exceeds pipe capacity, so finishing cat proves the
        // guest consumed bytes past the ordinary limit, into the discard path.
        std::fs::write(
            &event_path,
            format!(
                "{{\"type\":\"agent_end\",\"messages\":[\"{}",
                "x".repeat(ORDINARY_CLI_STDOUT_MAX_LINE_BYTES + 1024 * 1024),
            ),
        )?;
        let npx = bin_dir.join("npx");
        std::fs::write(
            &npx,
            r#"#!/bin/sh
set -eu
printf '%s\n' "$$" > "$PI_CHILD_PID_PATH"
trap '' TERM
IFS= read -r state_command
case "$state_command" in
  *'"type":"get_state"'*) ;;
  *) exit 21 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:get-state\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"11111111-1111-4111-8111-111111111147\",\"sessionFile\":\"/home/user/.pi/agent/sessions/--home-user-workspace--/session.jsonl\"}}"
IFS= read -r prompt_command
case "$prompt_command" in
  *'"type":"prompt"'*) ;;
  *) exit 22 ;;
esac
printf '%s\n' "{\"id\":\"${OKOU_RUN_ID}:pi:initial-prompt\",\"type\":\"response\",\"command\":\"prompt\",\"success\":true}"
cat "$PI_EVENT_PATH"
if [ "$PI_DRAIN_MODE" = exit ]; then
  sleep 60 </dev/null 2>/dev/null &
  printf '%s\n' "$!" > "$PI_HOLDER_PID_PATH"
fi
printf '%s\n' ready > "$PI_READY_PATH"
case "$PI_DRAIN_MODE" in
  cancel)
    IFS= read -r abort_command
    case "$abort_command" in
      *'"type":"abort"'*) exit 0 ;;
      *) exit 23 ;;
    esac
    ;;
  timeout) exec tail -f /dev/null ;;
  exit) exit 0 ;;
  *) exit 24 ;;
esac
"#,
        )?;
        let mut permissions = std::fs::metadata(&npx)?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&npx, permissions)?;

        let run_id = format!("pi-oversized-drain-{mode}");
        let paths = GuestPaths::from_home(tmp.path(), &run_id)?;
        let payload_path = common::write_run_payload_file_for_test(
            paths.runtime_dir(),
            &guest_contracts::env::RunPayload {
                prompt: "interrupt an open oversized Pi record".to_string(),
                pi_launch_config: r#"{"schemaVersion":2}"#.to_string(),
                pi_model_config: "{}".to_string(),
                pi_session_id: "11111111-1111-4111-8111-111111111147".to_string(),
                ..Default::default()
            },
        )?;
        let mut config = GuestConfig::from_raw(GuestConfigRaw {
            run_id,
            cli_agent_type: "pi".into(),
            home: Some(tmp.path().to_string_lossy().into_owned()),
            run_payload_file: payload_path.to_string_lossy().into_owned(),
            guest_runtime_dir: Some(paths.runtime_dir().into()),
            agent_execution_timeout_secs: if mode == "timeout" {
                "3600".into()
            } else {
                String::new()
            },
            post_result_sigkill_grace_secs: "1".into(),
            ..Default::default()
        })?;
        config.user_env.extend([
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", bin_dir.display()),
            ),
            (
                "CLI_PKG_URL".into(),
                "https://example.invalid/current-okou-cli.tgz".into(),
            ),
            ("PI_DRAIN_MODE".into(), mode.into()),
            (
                "PI_EVENT_PATH".into(),
                event_path.to_string_lossy().into_owned(),
            ),
            (
                "PI_READY_PATH".into(),
                ready_path.to_string_lossy().into_owned(),
            ),
            (
                "PI_CHILD_PID_PATH".into(),
                child_pid_path.to_string_lossy().into_owned(),
            ),
            (
                "PI_HOLDER_PID_PATH".into(),
                holder_pid_path.to_string_lossy().into_owned(),
            ),
        ]);
        common::ensure_canonical_workspace_for_test()?;
        Ok(Self {
            runtime: GuestRuntime {
                http: guest_agent::http::HttpClient::for_config(&config)?,
                config,
                paths,
                workload_containment: None,
                process_control_endpoint: None,
            },
            ready_path,
            child_pid_path,
            holder_pid_path,
            holder_pidfd: std::sync::OnceLock::new(),
            _tmp: tmp,
        })
    }

    async fn wait_until_discarding<F>(&self, execution: Pin<&mut F>) -> Result<(), TestError>
    where
        F: Future<Output = Result<CliExecutionResult, AgentError>>,
    {
        let ready = tokio::select! {
            result = execution => Err(format!("execution ended before the open record was written: {result:?}").into()),
            ready = common::wait_for_file_contains(&self.ready_path, "ready", Duration::from_secs(5)) => {
                ready.map_err(TestError::from)
            }
        };
        if self.holder_pid_path.try_exists()? {
            let raw_pid = std::fs::read_to_string(&self.holder_pid_path)?
                .trim()
                .parse::<i32>()?;
            let pid = Pid::from_raw(raw_pid)
                .ok_or_else(|| std::io::Error::other("invalid holder PID"))?;
            let pidfd = rustix::process::pidfd_open(pid, PidfdFlags::empty())?;
            self.holder_pidfd
                .set(pidfd)
                .map_err(|_| std::io::Error::other("holder PID already captured"))?;
        }
        ready
    }

    fn child_process_path(&self) -> Result<PathBuf, TestError> {
        let pid = std::fs::read_to_string(&self.child_pid_path)?
            .trim()
            .parse::<u32>()?;
        Ok(PathBuf::from(format!("/proc/{pid}")))
    }
}

impl Drop for OpenRecordFixture {
    fn drop(&mut self) {
        // Capture the long-lived holder at readiness and retain its identity
        // through failure cleanup, rather than signalling a later reused PID.
        if let Some(pidfd) = self.holder_pidfd.get() {
            let _ = rustix::process::pidfd_send_signal(pidfd, Signal::KILL);
        }
    }
}

#[tokio::test]
async fn cancellation_interrupts_an_open_discarded_record() -> Result<(), TestError> {
    let fixture = OpenRecordFixture::new("cancel")?;
    let cancellation = CancellationToken::new();
    let masker = SecretMasker::from_raw("");
    let execution = common::execute_cli_with_cancellation_for_runtime(
        &fixture.runtime,
        &masker,
        common::spawn_dummy_heartbeat(),
        cancellation.clone(),
    );
    tokio::pin!(execution);
    fixture.wait_until_discarding(execution.as_mut()).await?;
    let child_path = fixture.child_process_path()?;
    assert!(child_path.exists());

    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .map_err(|_| {
            std::io::Error::other("cancellation did not interrupt the discarded record")
        })??;
    assert_eq!(
        result.exit_code, 0,
        "the child must receive the Pi abort command"
    );
    assert!(
        result
            .control_error
            .expect("cancellation error")
            .to_string()
            .contains("Run cancelled by user")
    );
    assert_eq!(
        result
            .cli_termination
            .expect("cancellation diagnostic")
            .reason,
        CliTerminationReason::UserCancellation,
    );
    assert!(!child_path.exists(), "cancelled child must be reaped");
    Ok(())
}

#[tokio::test]
async fn execution_timeout_escalates_while_discarding_an_open_record() -> Result<(), TestError> {
    let fixture = OpenRecordFixture::new("timeout")?;
    let masker = SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&fixture.runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);
    fixture.wait_until_discarding(execution.as_mut()).await?;
    let child_path = fixture.child_process_path()?;
    assert!(child_path.exists());

    // Advance only the already-armed execution timer after real pipe readiness;
    // process exit and signal delivery are still awaited under a real deadline.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3600)).await;
    tokio::time::resume();
    let result = tokio::time::timeout(Duration::from_secs(5), execution)
        .await
        .map_err(|_| {
            std::io::Error::other("execution timeout did not interrupt the discarded record")
        })??;
    assert_eq!(result.exit_code, common::SIGKILL_EXIT);
    assert!(
        result
            .control_error
            .expect("execution timeout error")
            .to_string()
            .contains("Agent execution timed out")
    );
    let termination = result
        .cli_termination
        .expect("execution timeout diagnostic");
    assert_eq!(termination.reason, CliTerminationReason::ExecutionTimeout);
    assert_eq!(termination.signal_sent, Some(CliTerminationSignal::Sigkill));
    assert!(termination.escalated);
    assert!(!child_path.exists(), "timed-out child must be reaped");
    Ok(())
}

#[tokio::test]
async fn child_exit_bounds_discarding_when_a_descendant_holds_stdout() -> Result<(), TestError> {
    let fixture = OpenRecordFixture::new("exit")?;
    let masker = SecretMasker::from_raw("");
    let execution =
        common::execute_cli_for_runtime(&fixture.runtime, &masker, common::spawn_dummy_heartbeat());
    tokio::pin!(execution);
    fixture.wait_until_discarding(execution.as_mut()).await?;
    let holder_pid = std::fs::read_to_string(&fixture.holder_pid_path)?
        .trim()
        .parse::<i32>()?;
    let holder_pid =
        Pid::from_raw(holder_pid).ok_or_else(|| std::io::Error::other("invalid holder PID"))?;
    let holder_pidfd = fixture
        .holder_pidfd
        .get()
        .ok_or_else(|| std::io::Error::other("holder PID was not captured"))?;

    let result = tokio::time::timeout(Duration::from_secs(8), execution)
        .await
        .map_err(|_| {
            std::io::Error::other("child exit did not bound the discarded-record drain")
        })??;
    assert_eq!(result.exit_code, 0);
    assert!(result.control_error.is_none());
    assert!(
        !fixture.child_process_path()?.exists(),
        "exited leader must be reaped",
    );
    assert!(
        PathBuf::from(format!("/proc/{holder_pid}")).exists(),
        "stdout must still be held open when the supervisor returns",
    );
    rustix::process::pidfd_send_signal(holder_pidfd, Signal::KILL)?;
    let holder_pidfd = tokio::io::unix::AsyncFd::new(holder_pidfd.try_clone()?)?;
    tokio::time::timeout(Duration::from_secs(5), holder_pidfd.readable())
        .await?
        .map(drop)?;
    Ok(())
}
