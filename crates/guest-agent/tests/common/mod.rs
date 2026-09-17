//! Shared setup for CLI integration tests.
//!
//! # Why separate test binaries instead of cases in one
//!
//! Many CLI tests mutate process env, current directory, and guest runtime path
//! overrides as setup input. Consolidating scenarios with different prompts or
//! grace windows into one `#[tokio::test]` binary would make those process-wide
//! side effects race. Splitting into separate binaries gives each scenario a
//! fresh process, paid for by a small cargo build-cache hit (idempotent).
//!
//! # Error handling
//!
//! Fallible helpers return `Result<_, String>` and let the test's
//! `#[tokio::test]` body propagate with `?` — clippy's
//! `allow-expect-in-tests` applies to test bodies but not to helpers
//! defined in `tests/common/mod.rs`.

#![allow(dead_code)] // consumed across multiple test binaries

pub(crate) mod delivery_image;
pub(crate) mod process_session;
mod system_log;

use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use serde_json::{Value, json};
use shell_quote::quote_shell_arg;
use std::collections::HashMap;
use std::ffi::{CString, OsStr};
use std::future::Future;
use std::io;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use process_session::CommandSession;

pub type SystemLogOverrideGuard = system_log::SystemLogOverrideGuard;

static UNIQUE_TEMP_PATH_COUNTER: AtomicU64 = AtomicU64::new(0);

const COMMAND_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

/// 128 + SIGTERM(15). Rust / glibc's default signal handler maps a
/// SIGTERM-terminated process to this exit code.
pub const SIGTERM_EXIT: i32 = 143;

/// 128 + SIGKILL(9). Un-catchable; the only way out for a process
/// that ignores SIGTERM.
pub const SIGKILL_EXIT: i32 = 137;

/// Normal clean exit. Reap should never fire on this path.
pub const CLEAN_EXIT: i32 = 0;

pub const MOCK_TERMINATION_READY_EVENT: &str = "claude_mock_termination_ready";
pub const MOCK_CODEX_TURN_START_READY_FILE: &str = ".codex-mock-turn-start-ready";
pub const MOCK_CODEX_TURN_START_READY_EVENT: &str = "codex_mock_turn_start_ready";
pub const MOCK_CODEX_TURN_COMPLETE_BEFORE_HEARTBEAT_READY_FILE: &str =
    ".codex-mock-turn-complete-before-heartbeat-ready";
pub const MOCK_CODEX_SESSION_HISTORY_READY_FILE: &str = ".codex-mock-session-history-ready";
pub const MOCK_CODEX_SESSION_HISTORY_READY_EVENT: &str = "codex_mock_session_history_ready";
pub const MOCK_CODEX_TURN_STEER_READY_FILE: &str = ".codex-mock-turn-steer-ready";
pub const MOCK_CODEX_TURN_STEER_READY_EVENT: &str = "codex_mock_turn_steer_ready";
pub const MOCK_CODEX_TURN_STEER_RELEASE_SOCKET: &str = ".codex-mock-turn-steer-release.sock";
pub const MOCK_CODEX_EVENT_DELIVERY_LARGE_RELEASE_SOCKET: &str =
    ".codex-mock-event-delivery-large-release.sock";
pub const MOCK_CODEX_ACTIVE_TURN_READY_FILE: &str = ".codex-mock-active-turn-ready";
pub const MOCK_CODEX_ACTIVE_TURN_READY_EVENT: &str = "codex_mock_active_turn_ready";
pub const MOCK_CODEX_TURN_INTERRUPT_READY_FILE: &str = ".codex-mock-turn-interrupt-ready";
pub const MOCK_CODEX_TURN_INTERRUPT_READY_EVENT: &str = "codex_mock_turn_interrupt_ready";
pub const MOCK_POST_RESULT_READY_EVENT: &str = "claude_mock_post_result_ready";
pub const MOCK_POST_RESULT_ACTIVITY_ONE_EVENT: &str = "claude_mock_post_result_activity_1_ready";
pub const MOCK_POST_RESULT_ACTIVITY_TWO_EVENT: &str = "claude_mock_post_result_activity_2_ready";
pub const MOCK_POST_RESULT_LIVENESS_EVENT: &str = "claude_mock_post_result_stale_deadline_survived";
pub const MOCK_POST_RESULT_RELEASE_ONE_SOCKET: &str = ".vm0-post-result-release-1.sock";
pub const MOCK_POST_RESULT_RELEASE_TWO_SOCKET: &str = ".vm0-post-result-release-2.sock";

pub fn unique_temp_path(prefix: &str) -> PathBuf {
    let timestamp_nanos = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos(),
        Err(error) => error.duration().as_nanos(),
    };
    let counter = UNIQUE_TEMP_PATH_COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{timestamp_nanos}-{counter}",
        std::process::id()
    ))
}

pub async fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    command_output_with_optional_stdin_timeout(command, None, timeout, timeout_context).await
}

pub async fn command_output_with_stdin_timeout(
    command: &mut Command,
    stdin: &[u8],
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    command_output_with_optional_stdin_timeout(command, Some(stdin), timeout, timeout_context).await
}

async fn command_output_with_optional_stdin_timeout(
    command: &mut Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
    timeout_context: &str,
) -> io::Result<Output> {
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    CommandSession::configure(command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let session = CommandSession::from_child(&child)?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return match terminate_command(&mut child, &session).await {
            Ok(_) => Err(io::Error::other(
                "captured child omitted its stdout or stderr pipe",
            )),
            Err(error) => Err(io::Error::other(format!(
                "captured child omitted its stdout or stderr pipe; cleanup failed: {error}"
            ))),
        };
    };
    let stdin = if let Some(stdin_bytes) = stdin {
        let Some(child_stdin) = child.stdin.take() else {
            return match terminate_command(&mut child, &session).await {
                Ok(_) => Err(io::Error::other(
                    "captured child omitted its configured stdin pipe",
                )),
                Err(error) => Err(io::Error::other(format!(
                    "captured child omitted its configured stdin pipe; cleanup failed: {error}"
                ))),
            };
        };
        Some((child_stdin, stdin_bytes))
    } else {
        None
    };
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();

    let output = {
        let wait_with_output = async {
            let write_stdin = async move {
                if let Some((mut child_stdin, stdin_bytes)) = stdin {
                    child_stdin.write_all(stdin_bytes).await?;
                }
                Ok::<(), io::Error>(())
            };
            let (stdin_result, stdout_result, stderr_result) = tokio::join!(
                write_stdin,
                stdout.read_to_end(&mut stdout_bytes),
                stderr.read_to_end(&mut stderr_bytes),
            );
            session.wait_for_exit().await?;
            stdin_result?;
            stdout_result?;
            stderr_result?;
            Ok::<(), io::Error>(())
        };
        tokio::time::timeout(timeout, wait_with_output).await
    };

    let result = match output {
        Ok(result) => result,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            timeout_context.to_string(),
        )),
    };
    // EOF can leave quiet descendants alive. Finalize every result while the
    // unreaped leader still reserves its SID; never scan that SID after reaping.
    let cleanup = terminate_command(&mut child, &session).await;
    match (result, cleanup) {
        (Ok(()), Ok(status)) => Ok(Output {
            status,
            stdout: stdout_bytes,
            stderr: stderr_bytes,
        }),
        (Err(error), Ok(_)) => Err(error),
        (Ok(()), Err(error)) => Err(io::Error::other(format!(
            "completed command cleanup failed: {error}"
        ))),
        (Err(error), Err(cleanup_error)) => Err(io::Error::other(format!(
            "{error}; command cleanup failed: {cleanup_error}"
        ))),
    }
}

async fn terminate_command(
    child: &mut tokio::process::Child,
    session: &CommandSession,
) -> Result<std::process::ExitStatus, String> {
    let direct_kill_error = child.start_kill().err();
    let deadline = tokio::time::Instant::now() + COMMAND_CLEANUP_TIMEOUT;
    let session_error = session
        .kill_members(deadline, COMMAND_CLEANUP_TIMEOUT)
        .await
        .err();
    let wait_result = wait_for_child_until(child, deadline).await;

    match (session_error, wait_result) {
        (None, Ok(status)) => Ok(status),
        (Some(session_error), Ok(status)) => Err(command_cleanup_error(
            direct_kill_error,
            Some(session_error),
            format!("killed child status: {status}"),
        )),
        (session_error, Err(wait_error)) => Err(command_cleanup_error(
            direct_kill_error,
            session_error,
            wait_error,
        )),
    }
}

async fn wait_for_child_until(
    child: &mut tokio::process::Child,
    deadline: tokio::time::Instant,
) -> Result<std::process::ExitStatus, String> {
    match child.try_wait() {
        Ok(Some(status)) => return Ok(status),
        Ok(None) => {}
        Err(error) => return Err(format!("wait after kill failed: {error}")),
    }

    match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(Ok(status)) => Ok(status),
        Ok(Err(error)) => Err(format!("wait after kill failed: {error}")),
        Err(_) => Err(format!(
            "wait after kill timed out after {}ms",
            COMMAND_CLEANUP_TIMEOUT.as_millis()
        )),
    }
}

fn command_cleanup_error(
    direct_kill_error: Option<io::Error>,
    session_error: Option<String>,
    wait_result: String,
) -> String {
    let mut errors = Vec::new();
    if let Some(direct_kill_error) = direct_kill_error {
        errors.push(format!("start kill failed: {direct_kill_error}"));
    }
    if let Some(session_error) = session_error {
        errors.push(format!("session cleanup failed: {session_error}"));
    }
    errors.push(wait_result);
    errors.join("; ")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedRequest {
    pub path: String,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
    pub client_request_id: Option<String>,
    pub body: String,
}

pub fn event_request_sequences(request: &RecordedRequest) -> Result<Vec<u32>, String> {
    let body: Value = serde_json::from_str(&request.body)
        .map_err(|error| format!("parse event request body: {error}"))?;
    body.get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "event request omitted events array".to_string())?
        .iter()
        .map(|event| {
            event
                .get("sequenceNumber")
                .and_then(Value::as_u64)
                .and_then(|sequence| u32::try_from(sequence).ok())
                .ok_or_else(|| "event omitted a u32 sequenceNumber".to_string())
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordedHttpEvent {
    Request(RecordedRequest),
    Response { path: String, status: u16 },
}

pub struct RecordingServer {
    pub base_url: String,
    events: Arc<Mutex<Vec<RecordedHttpEvent>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl RecordingServer {
    pub async fn start(ably_status: u16, ably_response_delay: Duration) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind recording server: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("recording server local_addr: {e}"))?;
        let events = Arc::new(Mutex::new(Vec::new()));
        let task_events = Arc::clone(&events);
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_events = Arc::clone(&task_events);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    let status = if request.path.starts_with("/channels/") {
                        ably_status
                    } else {
                        200
                    };
                    push_recorded_event(
                        &connection_events,
                        RecordedHttpEvent::Request(request.clone()),
                    );
                    if request.path.starts_with("/channels/") && !ably_response_delay.is_zero() {
                        tokio::time::sleep(ably_response_delay).await;
                    }
                    let _ = write_http_response(&mut socket, status).await;
                    push_recorded_event(
                        &connection_events,
                        RecordedHttpEvent::Response {
                            path: request.path,
                            status,
                        },
                    );
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            events,
            handle,
        })
    }

    pub fn events(&self) -> Result<Vec<RecordedHttpEvent>, String> {
        self.events
            .lock()
            .map(|events| events.clone())
            .map_err(|_| "recording server event mutex poisoned".to_string())
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        Ok(self
            .events()?
            .into_iter()
            .filter_map(|event| match event {
                RecordedHttpEvent::Request(request) => Some(request),
                RecordedHttpEvent::Response { .. } => None,
            })
            .collect())
    }

    pub async fn wait_for_quiet(
        &self,
        quiet_for: Duration,
        timeout: Duration,
    ) -> Result<Vec<RecordedHttpEvent>, String> {
        let started_at = Instant::now();
        let mut last_len = self.events()?.len();
        let mut quiet_started_at = Instant::now();

        loop {
            let events = self.events()?;
            if events.len() != last_len {
                last_len = events.len();
                quiet_started_at = Instant::now();
            } else if quiet_started_at.elapsed() >= quiet_for {
                return Ok(events);
            }

            if started_at.elapsed() >= timeout {
                return Err(format!(
                    "recording server did not become quiet within {timeout:?}; observed {last_len} events"
                ));
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for RecordingServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub struct ControlledRequest {
    pub request: RecordedRequest,
    response: oneshot::Sender<u16>,
}

impl ControlledRequest {
    pub fn respond(self, status: u16) -> Result<(), String> {
        self.response
            .send(status)
            .map_err(|_| "controlled HTTP request closed before response".to_string())
    }
}

pub struct ControlledHttpServer {
    pub base_url: String,
    requests: Arc<AtomicUsize>,
    completed_responses: Arc<AtomicUsize>,
    recorded_requests: Arc<Mutex<Vec<RecordedRequest>>>,
    request_rx: mpsc::UnboundedReceiver<ControlledRequest>,
    handle: tokio::task::JoinHandle<()>,
}

impl ControlledHttpServer {
    pub async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| format!("bind controlled HTTP server: {error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("controlled HTTP server local_addr: {error}"))?;
        let requests = Arc::new(AtomicUsize::new(0));
        let task_requests = Arc::clone(&requests);
        let completed_responses = Arc::new(AtomicUsize::new(0));
        let task_completed_responses = Arc::clone(&completed_responses);
        let recorded_requests = Arc::new(Mutex::new(Vec::new()));
        let task_recorded_requests = Arc::clone(&recorded_requests);
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _peer)) = listener.accept().await {
                let connection_tx = request_tx.clone();
                let connection_requests = Arc::clone(&task_requests);
                let connection_completed_responses = Arc::clone(&task_completed_responses);
                let connection_recorded_requests = Arc::clone(&task_recorded_requests);
                tokio::spawn(async move {
                    let Ok(request) = read_http_request(&mut socket).await else {
                        let _ = write_http_response(&mut socket, 400).await;
                        return;
                    };
                    connection_requests.fetch_add(1, Ordering::SeqCst);
                    if let Ok(mut requests) = connection_recorded_requests.lock() {
                        requests.push(request.clone());
                    }
                    let (response, response_rx) = oneshot::channel();
                    if connection_tx
                        .send(ControlledRequest { request, response })
                        .is_err()
                    {
                        return;
                    }
                    let Ok(status) = response_rx.await else {
                        return;
                    };
                    let _ = write_http_response(&mut socket, status).await;
                    connection_completed_responses.fetch_add(1, Ordering::SeqCst);
                });
            }
        });

        Ok(Self {
            base_url: format!("http://{addr}"),
            requests,
            completed_responses,
            recorded_requests,
            request_rx,
            handle,
        })
    }

    pub async fn next_request(&mut self, timeout: Duration) -> Result<ControlledRequest, String> {
        tokio::time::timeout(timeout, self.request_rx.recv())
            .await
            .map_err(|_| format!("controlled HTTP server received no request within {timeout:?}"))?
            .ok_or_else(|| "controlled HTTP server stopped accepting requests".to_string())
    }

    pub fn request_count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn completed_response_count(&self) -> usize {
        self.completed_responses.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Result<Vec<RecordedRequest>, String> {
        self.recorded_requests
            .lock()
            .map(|requests| requests.clone())
            .map_err(|_| "controlled HTTP request mutex poisoned".to_string())
    }
}

impl Drop for ControlledHttpServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Debug)]
pub struct RunFilesGuard {
    paths: guest_agent::paths::GuestPaths,
}

impl RunFilesGuard {
    pub fn new_for_paths(paths: &guest_agent::paths::GuestPaths) -> Self {
        cleanup_run_files_for_paths(paths);
        Self {
            paths: paths.clone(),
        }
    }

    pub fn sandbox_ops_file(&self) -> &str {
        self.paths.sandbox_ops_file()
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files_for_paths(&self.paths);
    }
}

fn cleanup_run_files_for_paths(paths: &guest_agent::paths::GuestPaths) {
    let _ = std::fs::remove_file(paths.agent_log_file());
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Result<RecordedRequest, String> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            break index;
        }
        let mut chunk = [0u8; 1024];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request: {e}"))?;
        if read == 0 {
            return Err("connection closed before request headers".to_string());
        }
        buffer.extend_from_slice(
            chunk
                .get(..read)
                .ok_or_else(|| "read chunk length out of bounds".to_string())?,
        );
    };

    let header_bytes = buffer
        .get(..header_end)
        .ok_or_else(|| "request header range out of bounds".to_string())?;
    let headers = std::str::from_utf8(header_bytes)
        .map_err(|e| format!("request headers are not UTF-8: {e}"))?;
    let (request_line, header_lines) = headers
        .split_once("\r\n")
        .map_or((headers, ""), |(line, rest)| (line, rest));
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("invalid request line: {request_line:?}"))?
        .to_string();

    let mut authorization = None;
    let mut content_type = None;
    let mut client_request_id = None;
    let mut content_length = 0usize;
    for line in header_lines.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let trimmed_name = name.trim();
        let trimmed_value = value.trim();
        if trimmed_name.eq_ignore_ascii_case("authorization") {
            authorization = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("content-type") {
            content_type = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("x-client-request-id") {
            client_request_id = Some(trimmed_value.to_string());
        }
        if trimmed_name.eq_ignore_ascii_case("content-length") {
            content_length = trimmed_value
                .parse()
                .map_err(|e| format!("invalid content-length {trimmed_value:?}: {e}"))?;
        }
    }

    let body_start = header_end
        .checked_add(4)
        .ok_or_else(|| "request header length overflow".to_string())?;
    let body_end = body_start
        .checked_add(content_length)
        .ok_or_else(|| "request body length overflow".to_string())?;
    while buffer.len() < body_end {
        let mut chunk = [0u8; 1024];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request body: {e}"))?;
        if read == 0 {
            return Err("connection closed before request body".to_string());
        }
        buffer.extend_from_slice(
            chunk
                .get(..read)
                .ok_or_else(|| "body chunk length out of bounds".to_string())?,
        );
    }

    let body_bytes = buffer
        .get(body_start..body_end)
        .ok_or_else(|| "request body range out of bounds".to_string())?;
    let body = String::from_utf8_lossy(body_bytes).into_owned();

    Ok(RecordedRequest {
        path,
        authorization,
        content_type,
        client_request_id,
        body,
    })
}

async fn write_http_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let response =
        format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    socket
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write response: {e}"))
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn push_recorded_event(events: &Arc<Mutex<Vec<RecordedHttpEvent>>>, event: RecordedHttpEvent) {
    if let Ok(mut events) = events.lock() {
        events.push(event);
    }
}

/// Integration tests call `execute_cli` directly, bypassing the runner-side
/// workspace-drive mount. Create the canonical mountpoint once at the host-test
/// boundary so tests exercise the same cwd contract as production.
pub fn ensure_canonical_workspace_for_test() -> Result<(), String> {
    let path = Path::new(guest_agent::paths::CANONICAL_WORKING_DIR);
    if path.is_dir() {
        return Ok(());
    }

    match std::fs::create_dir_all(path) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(e) => {
            return Err(format!(
                "create canonical workspace {}: {e}",
                path.display()
            ));
        }
    }

    let status = std::process::Command::new("sudo")
        .args(["-n", "mkdir", "-p"])
        .arg(path)
        .status()
        .map_err(|e| format!("invoke sudo mkdir for {}: {e}", path.display()))?;
    if !status.success() {
        return Err(format!(
            "sudo mkdir failed for canonical workspace {} with status {status}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "canonical workspace was not created as a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Build the mock binary once per verified Cargo test invocation and resolve
/// its filesystem path.
///
/// The subprocess `cargo build` must land the artifact in the same
/// `target/` directory + profile that the enclosing `cargo test` uses,
/// otherwise the mock goes to a different spot than where we look for
/// it — which happens under `cargo llvm-cov` (custom `--target-dir`)
/// and under `cargo test --release`. We infer both from the currently-
/// running test binary's path and forward them to the subprocess.
pub fn build_and_locate_mock() -> Result<PathBuf, String> {
    build_and_locate_mock_package("claude-mock", "claude-mock")
}

/// Build the mock Codex binary and resolve its filesystem path beside the
/// current test profile.
pub fn build_and_locate_mock_codex() -> Result<PathBuf, String> {
    build_and_locate_mock_package("codex-mock", "codex-mock")
}

pub struct PostOpenMockGate {
    writer: std::fs::File,
    ready_file: PathBuf,
}

impl PostOpenMockGate {
    pub fn create(dir: &Path, mock: &Path) -> Result<(Self, PathBuf), String> {
        let fifo = dir.join("agent-log-mock-start.fifo");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes())
            .map_err(|error| format!("encode mock gate path: {error}"))?;
        // SAFETY: fifo_c is a valid NUL-terminated path and the mode is a
        // normal POSIX permission mask for this test-only FIFO.
        if unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) } != 0 {
            return Err(format!(
                "create mock gate {}: {}",
                fifo.display(),
                io::Error::last_os_error()
            ));
        }

        // Keep both FIFO ends open so release can happen immediately after
        // readiness even if the wrapper has not entered its read yet.
        // SAFETY: fifo_c remains valid for the call and ownership of the
        // returned descriptor transfers to File below.
        let fd = unsafe {
            libc::open(
                fifo_c.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(format!(
                "open mock gate {}: {}",
                fifo.display(),
                io::Error::last_os_error()
            ));
        }
        // SAFETY: fd is a fresh descriptor owned by this function.
        let writer = unsafe { std::fs::File::from_raw_fd(fd) };

        let ready_file = dir.join("agent-log-mock-ready");
        let wrapper = dir.join("gated-agent-log-mock.sh");
        let script = format!(
            "#!/bin/sh\nprintf 'ready\\n' > {}\nIFS= read -r _ < {}\nexec {} \"$@\"\n",
            quote_shell_arg(&ready_file.to_string_lossy()),
            quote_shell_arg(&fifo.to_string_lossy()),
            quote_shell_arg(&mock.to_string_lossy()),
        );
        std::fs::write(&wrapper, script)
            .map_err(|error| format!("write mock gate wrapper: {error}"))?;
        let mut permissions = std::fs::metadata(&wrapper)
            .map_err(|error| format!("read mock gate wrapper metadata: {error}"))?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&wrapper, permissions)
            .map_err(|error| format!("set mock gate wrapper permissions: {error}"))?;

        Ok((Self { writer, ready_file }, wrapper))
    }

    pub async fn wait_until_ready(&self, timeout: Duration) -> io::Result<()> {
        wait_for_file_contains(&self.ready_file, "ready\n", timeout).await
    }

    pub fn release(&mut self) -> io::Result<()> {
        std::io::Write::write_all(&mut self.writer, b"start\n")
    }
}

pub struct SoftFileSizeLimitGuard {
    original_limit: Option<libc::rlimit>,
    original_sigxfsz: libc::sighandler_t,
}

impl SoftFileSizeLimitGuard {
    pub fn restore(mut self) -> Result<(), String> {
        self.restore_inner()
    }

    fn restore_inner(&mut self) -> Result<(), String> {
        let Some(original_limit) = self.original_limit else {
            return Ok(());
        };
        // SAFETY: original_limit was returned by getrlimit for this process.
        if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &original_limit) } != 0 {
            return Err(format!(
                "restore RLIMIT_FSIZE: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: original_sigxfsz was returned by signal for SIGXFSZ.
        if unsafe { libc::signal(libc::SIGXFSZ, self.original_sigxfsz) } == libc::SIG_ERR {
            return Err(format!(
                "restore SIGXFSZ disposition: {}",
                io::Error::last_os_error()
            ));
        }
        self.original_limit = None;
        Ok(())
    }
}

impl Drop for SoftFileSizeLimitGuard {
    fn drop(&mut self) {
        if let Err(error) = self.restore_inner() {
            eprintln!("{error}");
        }
    }
}

pub fn set_soft_file_size_limit(limit: u64) -> Result<SoftFileSizeLimitGuard, String> {
    let mut current = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: current points to writable storage for one rlimit value.
    if unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, current.as_mut_ptr()) } != 0 {
        return Err(format!("read RLIMIT_FSIZE: {}", io::Error::last_os_error()));
    }
    // SAFETY: successful getrlimit initialized current.
    let current = unsafe { current.assume_init() };
    let target: libc::rlim_t = limit;
    if target > current.rlim_max {
        return Err(format!(
            "requested RLIMIT_FSIZE {target} exceeds hard limit {}",
            current.rlim_max
        ));
    }

    // SAFETY: installing SIG_IGN for SIGXFSZ is process-local and restored by
    // SoftFileSizeLimitGuard after the isolated integration execution.
    let original_sigxfsz = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    if original_sigxfsz == libc::SIG_ERR {
        return Err(format!("ignore SIGXFSZ: {}", io::Error::last_os_error()));
    }

    let next = libc::rlimit {
        rlim_cur: target,
        rlim_max: current.rlim_max,
    };
    // SAFETY: next preserves the current hard limit and uses a checked soft limit.
    if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &next) } != 0 {
        let limit_error = io::Error::last_os_error();
        // SAFETY: original_sigxfsz came from the successful signal call above.
        let restore_result = unsafe { libc::signal(libc::SIGXFSZ, original_sigxfsz) };
        if restore_result == libc::SIG_ERR {
            return Err(format!(
                "set RLIMIT_FSIZE: {limit_error}; restore SIGXFSZ disposition: {}",
                io::Error::last_os_error()
            ));
        }
        return Err(format!("set RLIMIT_FSIZE: {limit_error}"));
    }

    Ok(SoftFileSizeLimitGuard {
        original_limit: Some(current),
        original_sigxfsz,
    })
}

fn build_and_locate_mock_package(package: &str, binary: &str) -> Result<PathBuf, String> {
    // Test binary:   <target_dir>/<profile>/deps/<name>-<hash>
    //   parent():    <target_dir>/<profile>/deps
    //   parent().parent():  <target_dir>/<profile>   ← target_profile_dir
    //   parent().parent().parent():  <target_dir>
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let target_profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "target/<profile> dir".to_string())?;
    let workspace_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "guest-agent workspace directory".to_string())?;

    let build_session = cargo_build_session_id();
    build_and_locate_mock_package_in_workspace(
        workspace_dir,
        target_profile_dir,
        package,
        binary,
        build_session.as_deref(),
    )
}

/// Build a mock package in an explicit workspace and cache it for one Cargo build session.
pub fn build_and_locate_mock_package_in_workspace(
    workspace_dir: &Path,
    target_profile_dir: &Path,
    package: &str,
    binary: &str,
    build_session: Option<&str>,
) -> Result<PathBuf, String> {
    let target_dir = target_profile_dir
        .parent()
        .ok_or_else(|| "target dir".to_string())?;
    let profile_dir_name = target_profile_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "profile dir name".to_string())?;
    let mock = target_profile_dir.join(binary);
    let marker = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.build-session"));
    let lock = target_dir.join(format!(".vm0-{package}-{profile_dir_name}.lock"));
    let _lock = acquire_mock_build_lock(&lock)?;

    if mock.exists()
        && build_session.is_some()
        && std::fs::read_to_string(&marker).ok().as_deref() == build_session
    {
        return Ok(mock);
    }

    match std::fs::remove_file(&marker) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "remove mock build session {}: {error}",
                marker.display()
            ));
        }
    }

    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "-p", package, "--quiet"])
        .arg("--target-dir")
        .arg(target_dir)
        .current_dir(workspace_dir);
    // Cargo profile → output dir mapping:
    //   --release            → target_dir/release
    //   --profile <name>     → target_dir/<name>
    //   (default / dev)      → target_dir/debug
    // So pick the flag that lands the artifact beside our test binary.
    match profile_dir_name {
        "debug" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }

    let status = cmd
        .status()
        .map_err(|e| format!("invoke cargo build: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build -p {package} failed"));
    }
    if !mock.exists() {
        return Err(format!("mock binary not found at {}", mock.display()));
    }
    if let Some(build_session) = build_session {
        std::fs::write(&marker, build_session)
            .map_err(|e| format!("write mock build session: {e}"))?;
    }
    Ok(mock)
}

pub fn acquire_mock_build_lock(lock: &Path) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)
        .map_err(|e| format!("open mock build lock {}: {e}", lock.display()))?;
    file.lock()
        .map_err(|e| format!("lock mock build file {}: {e}", lock.display()))?;
    Ok(file)
}

/// Resolve a reusable session only for tests launched directly by Cargo on Linux.
fn cargo_build_session_id() -> Option<String> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let parent_pid = status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))?
        .trim()
        .parse::<u32>()
        .ok()?;
    let parent_exe = std::fs::read_link(format!("/proc/{parent_pid}/exe")).ok()?;
    if parent_exe.file_name()? != OsStr::new("cargo") {
        return None;
    }

    let parent_stat = std::fs::read_to_string(format!("/proc/{parent_pid}/stat")).ok()?;
    let fields_after_command = parent_stat.get(parent_stat.rfind(')')? + 1..)?;
    // `starttime` is field 22, or field 20 after the PID and parenthesized command.
    let parent_start_time = fields_after_command
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()?;
    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty() {
        return None;
    }

    Some(format!("{boot_id}:{parent_pid}:{parent_start_time}"))
}

/// Test-specific values for Codex app-server execution env.
pub struct CodexAppServerEnvConfig<'a> {
    pub run_id: &'a str,
    pub prompt: &'a str,
    pub scenario: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
}

/// Clear runner/bootstrap environment that could be inherited from a parent
/// runner process. Test setup helpers then write the exact env snapshot they
/// want `GuestRuntime::from_process_env` to capture.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn clear_guest_agent_bootstrap_env_for_test() {
    for key in [
        guest_contracts::env::CANONICAL_API_URL_ENV,
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
        guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        guest_contracts::env::CANONICAL_SANDBOX_REUSE_RESULT_ENV,
        guest_contracts::env::CANONICAL_WORKSPACE_REUSE_RESULT_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
        guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
        guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        "OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL",
        "OKOU_TEST_CLAUDE_CONFIG_DIR",
        "OKOU_TEST_CODEX_HOME_DIR",
        "MOCK_CODEX_APP_SERVER_SCENARIO",
    ] {
        unsafe {
            std::env::remove_var(key);
        }
    }
}

pub fn write_run_payload_file_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<std::path::PathBuf, String> {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create run payload dir: {error}"))?;
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let bytes =
        serde_json::to_vec(payload).map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write run payload: {error}"))?;
    Ok(path)
}

/// Write the runner-owned run payload file and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_run_payload_file_env_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<(), String> {
    let path = write_run_payload_file_for_test(runtime_dir, payload)?;
    unsafe {
        std::env::set_var(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV, path);
    }
    Ok(())
}

/// Write model-provider/user environment and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_user_env_file_env_for_test(
    runtime_dir: &Path,
    user_env: &HashMap<String, String>,
) -> Result<(), String> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create user env dir: {error}"))?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let bytes =
        serde_json::to_vec(user_env).map_err(|error| format!("serialize user env: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write user env: {error}"))?;
    unsafe {
        std::env::set_var(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV, path);
    }
    Ok(())
}

/// Configure one test binary for Codex app-server execution.
///
/// Must be called before building a `GuestRuntime` because runtime bootstrap
/// captures the process env snapshot.
///
/// # Safety
/// Callers must use this from a single-test integration binary before any other
/// thread reads the process environment.
pub unsafe fn setup_codex_app_server_env(
    mock_path: &Path,
    home: &Path,
    config: CodexAppServerEnvConfig<'_>,
) -> Result<(), String> {
    unsafe {
        clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var(
            guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
            mock_path,
        );
        std::env::set_var("USE_MOCK_CODEX", "true");
        if let Some(scenario) = config.scenario {
            std::env::set_var("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
        } else {
            std::env::remove_var("MOCK_CODEX_APP_SERVER_SCENARIO");
        }
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, config.run_id);
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
        std::env::set_var("HOME", home);
        std::env::set_var("OKOU_TEST_CODEX_HOME_DIR", home.join("codex-home"));
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(home, config.run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: config.prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        if let Some(resume_session_id) = config.resume_session_id {
            std::env::set_var(
                guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
                resume_session_id,
            );
        } else {
            std::env::remove_var(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV);
        }
    }
    std::fs::create_dir_all(home).map_err(|error| format!("create home: {error}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(home).map_err(|error| format!("set_current_dir: {error}"))?;
    Ok(())
}

pub fn active_input_payload(text: &str) -> Result<Vec<u8>, serde_json::Error> {
    guest_contracts::active_input::encode_active_input("223f8797-a456-4eea-98f7-f7ab88c43c00", text)
}

pub fn active_input_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<guest_agent::active_input::ActiveInputRuntime, guest_agent::error::AgentError> {
    let journal_path = guest_contracts::runtime_paths::active_input_receipt_journal_file(
        runtime.paths.runtime_dir(),
    );
    guest_agent::active_input::ActiveInputRuntime::new_with_receipts(
        &runtime.config.run_id,
        &runtime.config.prompt,
        journal_path,
        guest_agent::http::HttpClient::new()?,
    )
    .map_err(guest_agent::error::AgentError::Io)
}

pub fn read_codex_session_history_events_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let thread_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let filename_key =
        guest_contracts::codex_thread_id::codex_thread_id_filename_key(thread_id.trim())
            .ok_or("invalid captured Codex thread ID")?;
    let sessions_dir = Path::new(&runtime.config.codex_home_dir).join("sessions");
    let mut matches = Vec::new();
    let mut pending = vec![sessions_dir];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.replace('-', "").contains(&filename_key))
            {
                matches.push(path);
            }
        }
    }
    let [history_path] = matches.as_slice() else {
        return Err(format!(
            "expected one Codex session history for captured thread, found {}",
            matches.len()
        )
        .into());
    };
    let history = std::fs::read_to_string(history_path)?;
    history
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

pub fn expected_codex_turn_usage() -> Value {
    json!({
        "input_tokens": 12,
        "cached_input_tokens": 3,
        "cache_write_input_tokens": 3,
        "output_tokens": 24,
        "reasoning_output_tokens": 7,
        "total_tokens": 36
    })
}

/// Configure the process environment for one mock-Claude CLI integration-test
/// binary. Must be called before building a `GuestRuntime` because runtime
/// bootstrap captures the process env snapshot.
///
/// `prompt` is interpreted by `claude-mock`. See the module documentation
/// in `crates/claude-mock/src/main.rs` for the complete special-prefix
/// catalog and `SCENARIO_RULES` in
/// `crates/claude-mock/src/scenario.rs` for authoritative matching
/// behavior. Prompts that match no special rule use ordinary shell behavior.
///
/// `sigterm_grace_secs` / `sigkill_grace_secs` control how long the
/// FSM waits before each signal escalation. Signal-exit tests want
/// them small (~1s) for fast convergence; the happy-path test can use
/// a sigterm grace larger than its outer timeout so post-result reap
/// cannot mask the natural clean-exit assertion.
///
/// # Side effects
///
/// - Mutates the process-wide environment (`set_var`).
/// - Mutates the process-wide working directory (`set_current_dir`).
///
/// Call AT MOST ONCE per process, and only when that process executes no other
/// test concurrently. Supported callers use either a one-test integration
/// binary or one exact-filtered isolated child-test process.
///
/// SAFETY: no other thread can read the process environment while this setup
/// mutates environment and CWD state.
pub unsafe fn setup_env(
    mock_path: &Path,
    workdir: &Path,
    prompt: &str,
    sigterm_grace_secs: u64,
    sigkill_grace_secs: u64,
) -> Result<(), String> {
    unsafe {
        clear_guest_agent_bootstrap_env_for_test();
        // Route the CLI binary resolution to the cargo-built mock.
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var(
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path,
        );
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            sigterm_grace_secs.to_string(),
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            sigkill_grace_secs.to_string(),
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "60",
        );
        // Derive run_id from the test binary's filename (which cargo
        // hashes per target) so concurrently running integration-test
        // binaries don't collide on the run-scoped files that paths.rs
        // creates.
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "post-result-reap-test".to_string());
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, &run_id);
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(workdir, &run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        // Empty API token → has_api() false → no network calls.
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
        // Redirect HOME so the mock's session-history write
        // (`$CLAUDE_CONFIG_DIR/projects/.../<session>.jsonl`) stays inside
        // the tempdir and gets cleaned up with it, instead of
        // accumulating in the dev's real ~/.claude on every run.
        std::env::set_var("HOME", workdir);
        std::env::set_var("OKOU_TEST_CLAUDE_CONFIG_DIR", workdir.join(".claude"));
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

pub fn claude_history_path_for_home(home: &Path, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join("-home-user-workspace")
        .join(format!("{session_id}.jsonl"))
}

pub fn spawn_heartbeat_monitor<F>(future: F) -> guest_agent::cli::HeartbeatMonitor
where
    F: std::future::Future<Output = Result<(), guest_agent::error::AgentError>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let task = tokio::spawn(future);
        let status = match task.await {
            Ok(Ok(())) => guest_agent::cli::HeartbeatStatus::Stopped,
            Ok(Err(error)) => guest_agent::cli::HeartbeatStatus::Failed(
                guest_agent::heartbeat::HeartbeatFailure {
                    error,
                    diagnostic: test_heartbeat_failure_diagnostic(),
                },
            ),
            Err(error) => guest_agent::cli::HeartbeatStatus::TaskFailed(error.to_string()),
        };
        let _ = tx.send(status);
    });
    Some(rx)
}

pub fn test_heartbeat_failure_diagnostic()
-> guest_contracts::diagnostics::HeartbeatFailureDiagnostic {
    use guest_contracts::diagnostics::{
        HeartbeatFailedCycleDiagnostic, HeartbeatFailureDiagnostic, HttpAttemptFailureKind,
        HttpCompletedAttemptDiagnostic,
    };

    HeartbeatFailureDiagnostic {
        failed_cycles: vec![HeartbeatFailedCycleDiagnostic {
            scheduled_lag_ms: 17,
            attempts: vec![HttpCompletedAttemptDiagnostic {
                attempt: 3,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 30_001,
                failure_kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: Some(true),
                connect_observed: Some(false),
            }],
        }],
    }
}

/// Dummy heartbeat that never completes. The CLI-wait / reap-deadline
/// branches of `execute_cli`'s select! loop are the intended exit paths
/// for these tests; a heartbeat failure would go through a different
/// code path entirely.
pub fn spawn_dummy_heartbeat() -> guest_agent::cli::HeartbeatMonitor {
    None
}

pub fn guest_runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

pub async fn execute_cli_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    execute_cli_with_active_input_for_runtime(
        runtime,
        masker,
        heartbeat,
        active_input.into_writer(),
    )
    .await
}

pub async fn execute_cli_with_active_input_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    active_input: guest_agent::active_input::ActiveInputWriter,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    guest_agent::cli::execute_cli_with_active_input_for_config(
        masker,
        heartbeat,
        runtime.http.clone(),
        active_input,
        &runtime.config,
        &runtime.paths,
    )
    .await
}

pub async fn execute_cli_with_cancellation_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    guest_agent::cli::execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat,
        runtime.http.clone(),
        guest_agent::cli::CliExecutionControls::new(active_input.into_writer(), cancellation, None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    )
    .await
}

pub struct VirtualTimeCheckpoint<'a> {
    file: &'a str,
    needle: &'a str,
    advance: Duration,
    release_socket: Option<&'a Path>,
}

impl<'a> VirtualTimeCheckpoint<'a> {
    pub fn new(file: &'a str, needle: &'a str, advance: Duration) -> Self {
        Self {
            file,
            needle,
            advance,
            release_socket: None,
        }
    }

    pub fn release_after_advance(mut self, release_socket: &'a Path) -> Self {
        self.release_socket = Some(release_socket);
        self
    }
}

pub async fn execute_with_virtual_time_checkpoints<F>(
    future: F,
    checkpoints: &[VirtualTimeCheckpoint<'_>],
) -> Result<F::Output, String>
where
    F: Future,
{
    for checkpoint in checkpoints {
        guest_agent::paths::ensure_parent_dir(checkpoint.file).map_err(|error| {
            format!(
                "prepare parent directory for virtual-time checkpoint {}: {error}",
                checkpoint.file
            )
        })?;
    }

    tokio::pin!(future);
    for (index, checkpoint) in checkpoints.iter().enumerate() {
        tokio::select! {
            _ = &mut future => {
                return Err(format!(
                    "CLI execution completed before {:?} appeared in {}",
                    checkpoint.needle, checkpoint.file
                ));
            }
            ready = wait_for_file_contains(
                Path::new(checkpoint.file),
                checkpoint.needle,
                Duration::from_secs(5),
            ) => {
                ready.map_err(|error| {
                    format!(
                        "wait for {:?} in {} before advancing time: {error}",
                        checkpoint.needle, checkpoint.file
                    )
                })?;
            }
        }

        tokio::time::pause();
        tokio::time::advance(checkpoint.advance).await;

        let execution_poll =
            std::future::poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await;
        let release_result = if matches!(&execution_poll, Poll::Pending)
            && let Some(release_socket) = checkpoint.release_socket
        {
            UnixStream::connect(release_socket)
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "release virtual-time checkpoint through {}: {error}",
                        release_socket.display()
                    )
                })
        } else {
            Ok(())
        };
        tokio::time::resume();
        release_result?;

        if let Poll::Ready(output) = execution_poll {
            if index + 1 == checkpoints.len() && checkpoint.release_socket.is_none() {
                return Ok(output);
            }
            return Err(format!(
                "CLI execution completed after advancing time for {:?} before all checkpoint stages finished",
                checkpoint.needle
            ));
        }
    }

    Ok(future.await)
}

pub async fn wait_for_path(path: &Path, timeout: Duration) -> io::Result<()> {
    tokio::time::timeout(timeout, wait_for_path_event(path))
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out waiting for {}", path.display()),
            )
        })?
}

pub async fn wait_for_file_contains(
    path: &Path,
    needle: &str,
    timeout: Duration,
) -> io::Result<()> {
    tokio::time::timeout(
        timeout,
        wait_for_file_contains_event(path, needle.as_bytes()),
    )
    .await
    .map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "timed out waiting for {} to contain {needle:?}",
                path.display()
            ),
        )
    })?
}

async fn wait_for_file_contains_event(path: &Path, needle: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(
            dir,
            AddWatchFlags::IN_CREATE
                | AddWatchFlags::IN_MODIFY
                | AddWatchFlags::IN_MOVED_TO
                | AddWatchFlags::IN_CLOSE_WRITE,
        )
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;
    let async_fd = async_inotify_fd(inotify)?;

    loop {
        match tokio::fs::read(path).await {
            Ok(contents) if find_subsequence(&contents, needle).is_some() => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();
    }
}

async fn wait_for_path_event(path: &Path) -> io::Result<()> {
    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no parent directory: {}", path.display()),
        )
    })?;
    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|error| io::Error::other(format!("inotify init: {error}")))?;
    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|error| io::Error::other(format!("inotify watch: {error}")))?;

    if tokio::fs::try_exists(path).await? {
        return Ok(());
    }

    let async_fd = async_inotify_fd(inotify)?;
    loop {
        let mut guard = async_fd.readable().await?;
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        if tokio::fs::try_exists(path).await? {
            return Ok(());
        }
    }
}

fn async_inotify_fd(inotify: Inotify) -> io::Result<AsyncFd<OwnedFd>> {
    let fd: OwnedFd = inotify.into();
    AsyncFd::new(fd).map_err(|error| io::Error::other(format!("AsyncFd: {error}")))
}

fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: fd is a valid non-blocking inotify descriptor borrowed from
        // AsyncFd. The stack buffer is valid for the requested byte length.
        let result = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if result <= 0 {
            break;
        }
    }
}
