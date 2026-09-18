//! Deferred Pi handoff preparation remains under the Guest execution owner.
//!
//! Each public test spawns one ignored child test so process environment and
//! current-directory mutation stay isolated. The child uses the production
//! process-control listener/token seam, a real loopback HTTP response body,
//! and the real Guest HTTP collector. Explicit barriers, rather than sleeps,
//! establish request/body readiness before each control outcome is delivered.

mod common;

use base64::Engine as _;
use guest_agent::cli::{
    CliExecutionControls, HeartbeatStatus, execute_cli_with_controls_for_config_started_at,
};
use guest_agent::control::ControlHandle;
use guest_agent::heartbeat::HeartbeatFailure;
use guest_agent::masker::SecretMasker;
use guest_contracts::diagnostics::CliTerminationReason;
use process_control_ipc::{
    ControlRequest, ControlResponseStatus, accept_with_timeout, bind_abstract_listener,
    endpoint_name, read_hello, read_response, write_request,
};
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

const CHILD_TEST: &str = "deferred_preparation_control_child";
const RUN_ID: &str = "00000000-0000-4000-8000-000000000866";
const SESSION_ID: &str = "11111111-1111-4111-8111-111111111866";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    AlreadyCancelled,
    ExpiredExecutionDeadline,
    HeldBodyCancellation,
    ExecutionDeadline,
    HeartbeatFailure,
    CancellationReadinessRace,
    CancellationErrorReadinessRace,
    LaterChunkCancellation,
}

impl Scenario {
    fn label(self) -> &'static str {
        match self {
            Self::AlreadyCancelled => "already-cancelled",
            Self::ExpiredExecutionDeadline => "expired-execution-deadline",
            Self::HeldBodyCancellation => "held-body-cancellation",
            Self::ExecutionDeadline => "execution-deadline",
            Self::HeartbeatFailure => "heartbeat-failure",
            Self::CancellationReadinessRace => "cancellation-readiness-race",
            Self::CancellationErrorReadinessRace => "cancellation-error-readiness-race",
            Self::LaterChunkCancellation => "later-chunk-cancellation",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        [
            Self::AlreadyCancelled,
            Self::ExpiredExecutionDeadline,
            Self::HeldBodyCancellation,
            Self::ExecutionDeadline,
            Self::HeartbeatFailure,
            Self::CancellationReadinessRace,
            Self::CancellationErrorReadinessRace,
            Self::LaterChunkCancellation,
        ]
        .into_iter()
        .find(|scenario| scenario.label() == value)
    }

    fn expected_requests(self) -> usize {
        if matches!(
            self,
            Self::AlreadyCancelled | Self::ExpiredExecutionDeadline
        ) {
            0
        } else if self == Self::LaterChunkCancellation {
            2
        } else {
            1
        }
    }
}

#[tokio::test]
async fn already_cancelled_entry_admits_no_handoff_request_or_child()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::AlreadyCancelled).await
}

#[tokio::test]
async fn expired_execution_deadline_admits_no_handoff_request_or_child()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::ExpiredExecutionDeadline).await
}

#[tokio::test]
async fn accepted_control_cancels_a_held_response_body_before_publication()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::HeldBodyCancellation).await
}

#[tokio::test]
async fn original_execution_deadline_cancels_held_preparation()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::ExecutionDeadline).await
}

#[tokio::test]
async fn heartbeat_loss_cancels_held_preparation() -> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::HeartbeatFailure).await
}

#[tokio::test]
async fn cancellation_that_wins_response_readiness_cannot_resurrect_startup()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::CancellationReadinessRace).await
}

#[tokio::test]
async fn cancellation_that_wins_response_error_readiness_stays_cancellation()
-> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::CancellationErrorReadinessRace).await
}

#[tokio::test]
async fn accepted_control_cancels_a_later_chunk_body() -> Result<(), Box<dyn std::error::Error>> {
    run_isolated(Scenario::LaterChunkCancellation).await
}

async fn run_isolated(scenario: Scenario) -> Result<(), Box<dyn std::error::Error>> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
        .env("OKOU_DEFERRED_CONTROL_SCENARIO", scenario.label());
    if let Some(profile) = std::env::var_os("LLVM_PROFILE_FILE") {
        command.env("LLVM_PROFILE_FILE", profile);
    }
    let output = common::command_output_with_timeout(
        &mut command,
        Duration::from_secs(15),
        "isolated deferred preparation control test did not finish",
    )
    .await?;
    assert!(
        output.status.success(),
        "scenario {} failed with {}; stdout:\n{}\nstderr:\n{}",
        scenario.label(),
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    Ok(())
}

struct HeldHandoffServer {
    base_url: String,
    entered: Option<oneshot::Receiver<()>>,
    completed: Option<oneshot::Receiver<()>>,
    release: Arc<Notify>,
    requests: Arc<AtomicUsize>,
    shutdown: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl HeldHandoffServer {
    async fn start(scenario: Scenario) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (entered_tx, entered_rx) = oneshot::channel();
        let entered_tx = Arc::new(std::sync::Mutex::new(Some(entered_tx)));
        let (completed_tx, completed_rx) = oneshot::channel();
        let completed_tx = Arc::new(std::sync::Mutex::new(Some(completed_tx)));
        let release = Arc::new(Notify::new());
        let requests = Arc::new(AtomicUsize::new(0));
        let shutdown = CancellationToken::new();
        let task_release = Arc::clone(&release);
        let task_requests = Arc::clone(&requests);
        let task_shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    () = task_shutdown.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _)) = accepted else {
                    break;
                };
                let request_index = task_requests.fetch_add(1, Ordering::SeqCst);
                let connection_release = Arc::clone(&task_release);
                let connection_entered = Arc::clone(&entered_tx);
                let connection_completed = Arc::clone(&completed_tx);
                tokio::spawn(async move {
                    serve_handoff_connection(
                        stream,
                        scenario,
                        request_index,
                        connection_entered,
                        connection_completed,
                        connection_release,
                    )
                    .await;
                });
            }
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            entered: Some(entered_rx),
            completed: Some(completed_rx),
            release,
            requests,
            shutdown,
            task,
        })
    }

    async fn wait_until_body_is_held(&mut self) -> std::io::Result<()> {
        self.entered
            .take()
            .ok_or_else(|| std::io::Error::other("body barrier receiver already consumed"))?
            .await
            .map_err(|_| std::io::Error::other("handoff server dropped body barrier"))
    }

    async fn wait_until_body_is_complete(&mut self) -> std::io::Result<()> {
        self.completed
            .take()
            .ok_or_else(|| std::io::Error::other("body completion receiver already consumed"))?
            .await
            .map_err(|_| std::io::Error::other("handoff server dropped body completion barrier"))
    }

    async fn finish(self) {
        self.release.notify_one();
        self.shutdown.cancel();
        let _ = self.task.await;
    }
}

async fn serve_handoff_connection(
    mut stream: TcpStream,
    scenario: Scenario,
    request_index: usize,
    entered: Arc<std::sync::Mutex<Option<oneshot::Sender<()>>>>,
    completed: Arc<std::sync::Mutex<Option<oneshot::Sender<()>>>>,
    release: Arc<Notify>,
) {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        if read == 0 || request.len() > 64 * 1024 {
            return;
        }
        let Some(chunk) = buffer.get(..read) else {
            return;
        };
        request.extend_from_slice(chunk);
    }

    let (decoded, next_offset, should_hold) =
        if scenario == Scenario::LaterChunkCancellation && request_index == 0 {
            (vec![b'x'; 1024 * 1024], Some(1024 * 1024_u64), false)
        } else {
            let Ok(wire) = serde_json::to_vec(&json!({
                "sessionHistory": "synthetic history",
                "resourceSnapshot": { "schemaVersion": 1, "agentsFiles": [], "skills": [] }
            })) else {
                return;
            };
            (wire, None, true)
        };
    let Ok(body) = serde_json::to_vec(&json!({
        "chunk": base64::engine::general_purpose::STANDARD.encode(decoded),
        "nextOffset": next_offset,
    })) else {
        return;
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    if !should_hold {
        let _ = stream.write_all(&body).await;
        let _ = stream.shutdown().await;
        return;
    }

    let split = body.len().saturating_sub(1).max(1);
    let (Some(first), Some(last)) = (body.get(..split), body.get(split..)) else {
        return;
    };
    if stream.write_all(first).await.is_err() {
        return;
    }
    {
        let Ok(mut entered) = entered.lock() else {
            return;
        };
        if let Some(sender) = entered.take() {
            let _ = sender.send(());
        }
    }
    release.notified().await;
    if scenario != Scenario::CancellationErrorReadinessRace {
        let _ = stream.write_all(last).await;
    }
    let _ = stream.shutdown().await;
    if let Ok(mut completed) = completed.lock()
        && let Some(sender) = completed.take()
    {
        let _ = sender.send(());
    }
}

struct CancellationControl {
    trigger: Option<oneshot::Sender<()>>,
    response: tokio::task::JoinHandle<std::io::Result<process_control_ipc::ControlResponse>>,
    handle: ControlHandle,
}

impl CancellationControl {
    fn start(
        active_input: guest_agent::active_input::ActiveInputController,
        cli_cancellation: CancellationToken,
    ) -> std::io::Result<Self> {
        let nonce = *b"pi-defer-34866!!";
        let endpoint = endpoint_name(std::process::id(), &nonce);
        let listener = bind_abstract_listener(&endpoint)?;
        let (trigger_tx, trigger_rx) = oneshot::channel();
        let response = tokio::task::spawn_blocking(move || {
            let mut stream = accept_with_timeout(&listener, Duration::from_secs(5))?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            read_hello(&mut stream)?;
            trigger_rx
                .blocking_recv()
                .map_err(|_| std::io::Error::other("cancellation trigger dropped"))?;
            write_request(
                &mut stream,
                &ControlRequest {
                    message_id: "cancel-deferred-preparation".to_string(),
                    payload: br#"{"type":"user-cancellation"}"#.to_vec(),
                },
            )?;
            read_response(&mut stream)
        });
        let shutdown = CancellationToken::new();
        let handle =
            ControlHandle::spawn(Some(&endpoint), shutdown, active_input, cli_cancellation)
                .ok_or_else(|| std::io::Error::other("production control task was not started"))?;
        Ok(Self {
            trigger: Some(trigger_tx),
            response,
            handle,
        })
    }

    async fn cancel(&mut self) -> std::io::Result<()> {
        self.trigger
            .take()
            .ok_or_else(|| std::io::Error::other("cancellation already triggered"))?
            .send(())
            .map_err(|_| std::io::Error::other("control host stopped before cancellation"))?;
        let response = tokio::time::timeout(Duration::from_secs(2), &mut self.response)
            .await
            .map_err(|_| std::io::Error::other("Guest cancellation acknowledgement timed out"))?
            .map_err(std::io::Error::other)??;
        assert_eq!(response.status, ControlResponseStatus::Accepted);
        Ok(())
    }

    fn finish(self) {
        self.handle.join();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "spawned with an isolated Guest startup environment by the parent tests"]
async fn deferred_preparation_control_child() -> Result<(), Box<dyn std::error::Error>> {
    let scenario = Scenario::parse(&std::env::var("OKOU_DEFERRED_CONTROL_SCENARIO")?)
        .ok_or("unknown control scenario")?;
    common::ensure_canonical_workspace_for_test()?;
    let mut server = HeldHandoffServer::start(scenario).await?;
    let tmp = tempfile::tempdir()?;
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let child_started = tmp.path().join("pi-child-started");
    let npx = bin_dir.join("npx");
    std::fs::write(&npx, "#!/bin/sh\ntouch \"$CHILD_STARTED_FILE\"\nexit 97\n")?;
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
            &server.base_url,
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_TOKEN_ENV,
            "sandbox-control-token",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
            "reused",
        );
        std::env::set_var("HOME", tmp.path());
        let mut paths = vec![bin_dir.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        std::env::set_var("PATH", std::env::join_paths(paths)?);
        match scenario {
            Scenario::ExecutionDeadline => std::env::set_var(
                guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
                "7",
            ),
            Scenario::ExpiredExecutionDeadline => std::env::set_var(
                guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
                "1",
            ),
            _ => {}
        }
        common::set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: "pre-spawn controls must win".to_string(),
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
    let _run_files = common::RunFilesGuard::new_for_paths(&runtime.paths);
    let active_input = common::active_input_runtime(&runtime)?;
    let controller = active_input.controller();
    let cancellation = CancellationToken::new();
    let mut cancellation_control = matches!(
        scenario,
        Scenario::AlreadyCancelled
            | Scenario::HeldBodyCancellation
            | Scenario::CancellationReadinessRace
            | Scenario::CancellationErrorReadinessRace
            | Scenario::LaterChunkCancellation
    )
    .then(|| CancellationControl::start(controller, cancellation.clone()))
    .transpose()?;
    if scenario == Scenario::AlreadyCancelled {
        cancellation_control
            .as_mut()
            .ok_or_else(|| std::io::Error::other("cancellation control is unavailable"))?
            .cancel()
            .await?;
    }

    let (heartbeat_tx, heartbeat_rx) = oneshot::channel();
    let heartbeat = if scenario == Scenario::HeartbeatFailure {
        Some(heartbeat_rx)
    } else {
        None
    };
    let masker = SecretMasker::from_raw("");
    let now = Instant::now();
    let execution_started_at = match scenario {
        Scenario::ExecutionDeadline => now
            .checked_sub(Duration::from_secs(5))
            .ok_or("monotonic clock cannot represent the aged execution origin")?,
        Scenario::ExpiredExecutionDeadline => now
            .checked_sub(Duration::from_secs(2))
            .ok_or("monotonic clock cannot represent the expired execution origin")?,
        _ => now,
    };
    let execution = execute_cli_with_controls_for_config_started_at(
        &masker,
        heartbeat,
        runtime.http.clone(),
        CliExecutionControls::new(active_input.into_writer(), cancellation, None),
        &runtime.config,
        &runtime.paths,
        execution_started_at,
    );
    tokio::pin!(execution);

    if !matches!(
        scenario,
        Scenario::AlreadyCancelled | Scenario::ExpiredExecutionDeadline
    ) {
        tokio::select! {
            result = &mut execution => {
                return Err(format!("execution ended before the HTTP body barrier: {result:?}").into());
            }
            barrier = server.wait_until_body_is_held() => barrier?,
        }
        match scenario {
            Scenario::HeldBodyCancellation | Scenario::LaterChunkCancellation => {
                cancellation_control
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("cancellation control is unavailable"))?
                    .cancel()
                    .await?;
            }
            Scenario::CancellationReadinessRace | Scenario::CancellationErrorReadinessRace => {
                cancellation_control
                    .as_mut()
                    .ok_or_else(|| std::io::Error::other("cancellation control is unavailable"))?
                    .cancel()
                    .await?;
                // Execution remains unpolled until the accepted control and a
                // complete success/error response are both observably ready.
                // notify_one stores a permit if the server has announced the
                // barrier but has not created its waiter yet. Its biased owner
                // must retain cancellation in either case.
                server.release.notify_one();
                server.wait_until_body_is_complete().await?;
            }
            Scenario::HeartbeatFailure => {
                heartbeat_tx
                    .send(HeartbeatStatus::Failed(HeartbeatFailure {
                        error: guest_agent::error::AgentError::Execution(
                            "synthetic heartbeat loss".to_string(),
                        ),
                        diagnostic: common::test_heartbeat_failure_diagnostic(),
                    }))
                    .map_err(|_| "heartbeat receiver ended before failure")?;
            }
            Scenario::ExecutionDeadline
            | Scenario::ExpiredExecutionDeadline
            | Scenario::AlreadyCancelled => {}
        }
    }

    let result = tokio::time::timeout(Duration::from_secs(3), &mut execution)
        .await
        .map_err(|_| "pre-spawn control did not terminate held preparation promptly")??;
    match scenario {
        Scenario::ExecutionDeadline | Scenario::ExpiredExecutionDeadline => {
            let timeout_secs = if scenario == Scenario::ExecutionDeadline {
                7
            } else {
                1
            };
            assert!(result.control_error.as_ref().is_some_and(|error| {
                error
                    .to_string()
                    .contains(&format!("timed out after {timeout_secs} seconds"))
            }));
            assert_eq!(
                result.cli_termination.map(|value| value.reason),
                Some(CliTerminationReason::ExecutionTimeout)
            );
        }
        Scenario::HeartbeatFailure => {
            assert!(
                result
                    .control_error
                    .as_ref()
                    .is_some_and(|error| error.to_string().contains("synthetic heartbeat loss"))
            );
            assert!(result.heartbeat.is_some());
            assert_eq!(
                result.cli_termination.map(|value| value.reason),
                Some(CliTerminationReason::HeartbeatError)
            );
        }
        _ => {
            assert!(
                result
                    .control_error
                    .as_ref()
                    .is_some_and(|error| error.to_string().contains("Run cancelled by user"))
            );
            assert_eq!(
                result.cli_termination.map(|value| value.reason),
                Some(CliTerminationReason::UserCancellation)
            );
        }
    }
    assert_eq!(
        server.requests.load(Ordering::SeqCst),
        scenario.expected_requests()
    );
    assert!(!child_started.exists());
    assert!(!guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir).exists());
    assert!(!Path::new(runtime.paths.pi_launch_payload_file()).exists());

    if let Some(control) = cancellation_control {
        control.finish();
    }
    server.finish().await;
    Ok(())
}
