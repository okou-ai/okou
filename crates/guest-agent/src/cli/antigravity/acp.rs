//! Antigravity ACP (`agy acp`) stdio JSON-RPC 2.0 client.
//!
//! Unlike the single-request Codex app-server client, Antigravity ACP steers
//! an active turn by sending a concurrent `session/prompt` request while the
//! previous `session/prompt` is still in flight. This client therefore tracks
//! multiple concurrent in-flight request IDs and yields both notifications and
//! correlated responses through [`AntigravityAcpClient::next_incoming`].

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use guest_telemetry::log_warn;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::cli::{
    LOG_TAG, child_env,
    child_exit_notifier::{
        ChildExitNotifier, child_exited_without_reaping, wait_for_child_exit_without_reaping,
    },
    exec_boundary,
    process_group::ChildProcessGroup,
};
use crate::error::AgentError;

const METHOD_NOT_FOUND: i64 = -32601;
const SHUTDOWN_EOF_GRACE: Duration = Duration::from_secs(2);
const SHUTDOWN_SIGKILL_GRACE: Duration = Duration::from_secs(2);
const EOF_EXIT_OBSERVATION_GRACE: Duration = Duration::from_secs(1);
const MAX_METHOD_CHARS: usize = 120;
const MAX_ERROR_MESSAGE_CHARS: usize = 240;

#[derive(Debug, Clone)]
pub(super) struct AntigravityAcpConfig {
    pub(super) binary: PathBuf,
    pub(super) args: Vec<String>,
    pub(super) child_env_values: Vec<(String, String)>,
    pub(super) current_dir: PathBuf,
    pub(super) workload_containment: Option<crate::workload_containment::WorkloadContainment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum JsonRpcId {
    Number(i64),
    String(String),
    Null,
}

impl JsonRpcId {
    fn to_json(&self) -> Value {
        match self {
            Self::Number(n) => json!(n),
            Self::String(s) => json!(s),
            Self::Null => Value::Null,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct JsonRpcError {
    pub(super) code: i64,
    pub(super) message: String,
    pub(super) data: Option<Value>,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "code={} message={}",
            self.code,
            bounded_text(&self.message, MAX_ERROR_MESSAGE_CHARS)
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct AcpNotification {
    pub(super) method: String,
    pub(super) params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
struct AcpServerRequest {
    id: JsonRpcId,
    method: String,
}

#[derive(Debug)]
pub(super) enum AcpIncoming {
    Notification(AcpNotification),
    Response {
        id: i64,
        method: String,
        outcome: Result<Value, JsonRpcError>,
    },
}

#[derive(Debug, thiserror::Error)]
pub(super) enum AntigravityAcpError {
    #[error("failed to spawn antigravity acp: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("antigravity acp io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("antigravity acp JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("antigravity acp RPC error for {method}: {error}")]
    Rpc {
        method: String,
        error: Box<JsonRpcError>,
    },
    #[error("antigravity acp protocol error: {0}")]
    Protocol(String),
    #[error("antigravity acp disconnected while waiting for {label}: stdout EOF")]
    Disconnected { label: String },
    #[error("antigravity acp child exited while waiting for {label}: {status}")]
    ChildExited { label: String, status: ExitStatus },
    #[error("antigravity acp did not exit after shutdown")]
    ShutdownTimeout,
}

impl From<AntigravityAcpError> for AgentError {
    fn from(value: AntigravityAcpError) -> Self {
        let message = value.to_string();
        match value {
            AntigravityAcpError::ChildExited { status, .. } => {
                AgentError::CliProcessExited { message, status }
            }
            _ => AgentError::Execution(message),
        }
    }
}

enum RawIncoming {
    Success { id: JsonRpcId, result: Value },
    Error { id: JsonRpcId, error: JsonRpcError },
    Notification(AcpNotification),
    Request(AcpServerRequest),
}

pub(super) struct AntigravityAcpClient {
    stdin: Option<ChildStdin>,
    stdout_reader: Option<BufReader<ChildStdout>>,
    stdout_partial_line: Vec<u8>,
    child: Option<Child>,
    exit_notifier: Option<ChildExitNotifier>,
    stderr_handle: Option<JoinHandle<()>>,
    next_request_id: i64,
    in_flight_requests: HashMap<i64, String>,
    outbound_write_in_progress: bool,
    stream_unusable_reason: Option<String>,
    notifications: VecDeque<AcpNotification>,
    closed: bool,
}

impl AntigravityAcpClient {
    pub(super) fn spawn(config: AntigravityAcpConfig) -> Result<Self, AntigravityAcpError> {
        let runtime = Handle::try_current().map_err(|_| {
            AntigravityAcpError::Protocol(
                "antigravity acp client requires a Tokio runtime".to_string(),
            )
        })?;

        let binary = config.binary.to_string_lossy();
        exec_boundary::validate_process_argv_env(
            "antigravity acp argv/env too large",
            &binary,
            config.args.iter().map(String::as_str),
            &config.child_env_values,
        )
        .map_err(AntigravityAcpError::Protocol)?;

        let mut cmd = tokio::process::Command::new(&config.binary);
        child_env::apply_values_to_tokio_command(&mut cmd, &config.child_env_values);
        cmd.args(&config.args)
            .current_dir(&config.current_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(containment) = config.workload_containment.as_ref() {
            containment
                .configure_command(&mut cmd)
                .map_err(AntigravityAcpError::Spawn)?;
        }

        let mut child = cmd.spawn().map_err(AntigravityAcpError::Spawn)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            AntigravityAcpError::Protocol("antigravity acp stdin was not piped".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AntigravityAcpError::Protocol("antigravity acp stdout was not piped".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AntigravityAcpError::Protocol("antigravity acp stderr was not piped".to_string())
        })?;

        // Drain stderr into sink: an OAuth challenge on stderr can include a live URL.
        let stderr_handle = runtime.spawn(async move {
            let _ = tokio::io::copy(&mut BufReader::new(stderr), &mut tokio::io::sink()).await;
        });

        let exit_notifier = match ChildExitNotifier::open(&child) {
            Ok(notifier) => Some(notifier),
            Err(error) => {
                log_warn!(
                    LOG_TAG,
                    "Antigravity ACP pidfd exit notification unavailable: {error}"
                );
                None
            }
        };

        Ok(Self {
            stdin: Some(stdin),
            stdout_reader: Some(BufReader::new(stdout)),
            stdout_partial_line: Vec::new(),
            child: Some(child),
            exit_notifier,
            stderr_handle: Some(stderr_handle),
            next_request_id: 1,
            in_flight_requests: HashMap::new(),
            outbound_write_in_progress: false,
            stream_unusable_reason: None,
            notifications: VecDeque::new(),
            closed: false,
        })
    }

    pub(super) fn pop_notification(&mut self) -> Option<AcpNotification> {
        self.notifications.pop_front()
    }

    /// Send a JSON-RPC 2.0 request without blocking for its response.
    /// Returns the assigned numeric request ID.
    pub(super) async fn send_request(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<i64, AntigravityAcpError> {
        self.ensure_stream_usable()?;
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).ok_or_else(|| {
            AntigravityAcpError::Protocol("antigravity acp request id overflow".to_string())
        })?;
        self.in_flight_requests.insert(id, method.to_string());
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_message(&message).await {
            self.in_flight_requests.remove(&id);
            return Err(error);
        }
        Ok(id)
    }

    /// Send a sequential JSON-RPC 2.0 request and wait for its matching response,
    /// buffering any notifications that arrive in between.
    pub(super) async fn request_value(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, AntigravityAcpError> {
        let id = self.send_request(method, params).await?;
        loop {
            match self.read_next_incoming(method).await? {
                AcpIncoming::Notification(notification) => {
                    self.notifications.push_back(notification);
                }
                AcpIncoming::Response {
                    id: response_id,
                    method: response_method,
                    outcome,
                } if response_id == id => {
                    return outcome.map_err(|error| AntigravityAcpError::Rpc {
                        method: response_method,
                        error: Box::new(error),
                    });
                }
                AcpIncoming::Response { id: other_id, .. } => {
                    return Err(self.poison_stream(format!(
                        "received unexpected response id {other_id} while waiting for {method}"
                    )));
                }
            }
        }
    }

    /// Send a JSON-RPC 2.0 notification.
    pub(super) async fn notify(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<(), AntigravityAcpError> {
        self.ensure_outbound_stream_usable()?;
        let message = if params.is_null() {
            json!({
                "jsonrpc": "2.0",
                "method": method,
            })
        } else {
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            })
        };
        self.write_message(&message).await
    }

    /// Read the next buffered notification or incoming stdout message (notification or response).
    pub(super) async fn next_incoming(
        &mut self,
        pending_label: &str,
    ) -> Result<AcpIncoming, AntigravityAcpError> {
        self.ensure_stream_usable()?;
        if let Some(notification) = self.notifications.pop_front() {
            return Ok(AcpIncoming::Notification(notification));
        }
        self.read_next_incoming(pending_label).await
    }

    async fn read_next_incoming(
        &mut self,
        pending_label: &str,
    ) -> Result<AcpIncoming, AntigravityAcpError> {
        loop {
            match self.read_raw_message(pending_label).await? {
                RawIncoming::Notification(notification) => {
                    return Ok(AcpIncoming::Notification(notification));
                }
                RawIncoming::Request(request) => {
                    self.handle_server_request(&request).await?;
                }
                RawIncoming::Success { id, result } => {
                    let (numeric_id, method) = self.take_in_flight_request(&id, pending_label)?;
                    return Ok(AcpIncoming::Response {
                        id: numeric_id,
                        method,
                        outcome: Ok(result),
                    });
                }
                RawIncoming::Error { id, error } => {
                    let (numeric_id, method) = self.take_in_flight_request(&id, pending_label)?;
                    return Ok(AcpIncoming::Response {
                        id: numeric_id,
                        method,
                        outcome: Err(error),
                    });
                }
            }
        }
    }

    fn take_in_flight_request(
        &mut self,
        id: &JsonRpcId,
        pending_label: &str,
    ) -> Result<(i64, String), AntigravityAcpError> {
        if let JsonRpcId::Number(numeric_id) = id
            && let Some(method) = self.in_flight_requests.remove(numeric_id)
        {
            return Ok((*numeric_id, method));
        }
        Err(self.poison_stream(format!(
            "received response for unknown id while waiting for {pending_label}"
        )))
    }

    async fn handle_server_request(
        &mut self,
        request: &AcpServerRequest,
    ) -> Result<(), AntigravityAcpError> {
        let reply = if request.method == "session/request_permission" {
            // Headless runs cannot prompt a user; reply with ACP's cancelled outcome.
            json!({
                "jsonrpc": "2.0",
                "id": request.id.to_json(),
                "result": {
                    "outcome": {
                        "outcome": "cancelled"
                    }
                }
            })
        } else {
            let method = bounded_text(&request.method, MAX_METHOD_CHARS);
            json!({
                "jsonrpc": "2.0",
                "id": request.id.to_json(),
                "error": {
                    "code": METHOD_NOT_FOUND,
                    "message": format!("unsupported server request method {method}")
                }
            })
        };
        self.write_message(&reply).await
    }

    pub(super) async fn shutdown(&mut self) -> Result<(), AntigravityAcpError> {
        if self.closed {
            return Ok(());
        }
        let had_stdin = self.stdin.is_some();
        self.close_io_handles();
        if had_stdin && self.child.is_some() {
            // Allow `agy acp` to observe stdin EOF, cleanly checkpoint its
            // SQLite conversation database, and exit before forcing teardown.
            let _ = self.wait_for_child(SHUTDOWN_EOF_GRACE).await?;
        }
        self.finish_close().await
    }

    pub(super) async fn terminate(&mut self) -> Result<(), AntigravityAcpError> {
        if self.closed {
            return Ok(());
        }
        self.close_io_handles();
        self.finish_close().await
    }

    async fn finish_close(&mut self) -> Result<(), AntigravityAcpError> {
        if self.child.is_some() {
            self.sigterm_process_group();
            self.sigkill_process_group();
            if !self.wait_for_child(SHUTDOWN_SIGKILL_GRACE).await? {
                return Err(AntigravityAcpError::ShutdownTimeout);
            }
        }
        if let Some(handle) = self.stderr_handle.take() {
            handle.abort();
            let _ = handle.await;
        }
        self.closed = true;
        Ok(())
    }

    async fn wait_for_child(&mut self, timeout: Duration) -> Result<bool, AntigravityAcpError> {
        let Some(child) = self.child.as_mut() else {
            return Ok(true);
        };
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(result) => {
                self.finish_child_wait(result)?;
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    fn finish_child_wait(
        &mut self,
        result: std::io::Result<ExitStatus>,
    ) -> Result<ExitStatus, AntigravityAcpError> {
        match result {
            Ok(status) => {
                self.exit_notifier = None;
                self.child = None;
                Ok(status)
            }
            Err(error) => {
                self.sigkill_process_group();
                self.exit_notifier = None;
                self.child = None;
                Err(AntigravityAcpError::Io(error))
            }
        }
    }

    async fn read_raw_message(
        &mut self,
        pending_label: &str,
    ) -> Result<RawIncoming, AntigravityAcpError> {
        loop {
            let has_exit_notifier = self.exit_notifier.is_some();
            let child_id = self.child.as_ref().and_then(Child::id);
            tokio::select! {
                biased;
                line = {
                    let Some(stdout_reader) = self.stdout_reader.as_mut() else {
                        return Err(self.poison_stream("antigravity acp stdout is closed"));
                    };
                    read_stdout_line(stdout_reader, &mut self.stdout_partial_line)
                } => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => {
                            return Err(self.finish_stdout_eof(pending_label).await);
                        }
                        Err(error) => return Err(self.poison_error(error)),
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    return parse_raw_incoming(&line).map_err(|error| self.poison_error(error));
                }
                exit = async {
                    match self.exit_notifier.as_ref() {
                        Some(notifier) => Some(notifier.wait_for_exit().await),
                        None => None,
                    }
                }, if has_exit_notifier && self.child.is_some() => {
                    let Some(exit) = exit else {
                        return Err(self.poison_stream("antigravity acp exit notifier disappeared"));
                    };
                    if let Err(error) = exit {
                        log_warn!(
                            LOG_TAG,
                            "Antigravity ACP pidfd exit notification failed: {error}"
                        );
                        self.exit_notifier = None;
                        continue;
                    }
                    return Err(self.finish_observed_child_exit(pending_label).await);
                }
                exit = async {
                    match child_id {
                        Some(child_id) => Some(wait_for_child_exit_without_reaping(child_id).await),
                        None => None,
                    }
                }, if !has_exit_notifier && self.child.is_some() => {
                    let Some(exit) = exit else {
                        return Err(self.poison_stream("antigravity acp child PID disappeared"));
                    };
                    if let Err(error) = exit {
                        return Err(self.poison_error(AntigravityAcpError::Io(error)));
                    }
                    return Err(self.finish_observed_child_exit(pending_label).await);
                }
            }
        }
    }

    async fn finish_stdout_eof(&mut self, pending_label: &str) -> AntigravityAcpError {
        // Stdout EOF can arrive before the exiting child finishes kernel teardown
        // (or after a runtime closes stdout during exit). Wait briefly for the
        // child to enter the exited state so we preserve its real exit status
        // instead of racing ahead with SIGKILL and reporting Disconnected.
        if let Some(child_id) = self.child.as_ref().and_then(Child::id) {
            match child_exited_without_reaping(child_id) {
                Ok(true) => return self.finish_observed_child_exit(pending_label).await,
                Ok(false) => {}
                Err(error) => return self.poison_error(AntigravityAcpError::Io(error)),
            }

            let exited = if let Some(notifier) = self.exit_notifier.as_ref() {
                match tokio::time::timeout(EOF_EXIT_OBSERVATION_GRACE, notifier.wait_for_exit())
                    .await
                {
                    Ok(Ok(())) => true,
                    Ok(Err(error)) => {
                        log_warn!(
                            LOG_TAG,
                            "Antigravity ACP pidfd exit notification failed after stdout EOF: {error}"
                        );
                        self.exit_notifier = None;
                        match tokio::time::timeout(
                            EOF_EXIT_OBSERVATION_GRACE,
                            wait_for_child_exit_without_reaping(child_id),
                        )
                        .await
                        {
                            Ok(Ok(())) => true,
                            Ok(Err(error)) => {
                                return self.poison_error(AntigravityAcpError::Io(error));
                            }
                            Err(_) => false,
                        }
                    }
                    Err(_) => false,
                }
            } else {
                match tokio::time::timeout(
                    EOF_EXIT_OBSERVATION_GRACE,
                    wait_for_child_exit_without_reaping(child_id),
                )
                .await
                {
                    Ok(Ok(())) => true,
                    Ok(Err(error)) => return self.poison_error(AntigravityAcpError::Io(error)),
                    Err(_) => false,
                }
            };

            if exited {
                return self.finish_observed_child_exit(pending_label).await;
            }
        }

        self.poison_error(AntigravityAcpError::Disconnected {
            label: pending_label.to_string(),
        })
    }

    async fn finish_observed_child_exit(&mut self, pending_label: &str) -> AntigravityAcpError {
        self.sigkill_process_group();
        let Some(child) = self.child.as_mut() else {
            return self.poison_stream("antigravity acp child disappeared");
        };
        let result = child.wait().await;
        let status = match self.finish_child_wait(result) {
            Ok(status) => status,
            Err(error) => return self.poison_error(error),
        };
        self.poison_error(AntigravityAcpError::ChildExited {
            label: pending_label.to_string(),
            status,
        })
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), AntigravityAcpError> {
        self.ensure_outbound_stream_usable()?;
        let mut bytes = serde_json::to_vec(message)?;
        bytes.push(b'\n');
        self.outbound_write_in_progress = true;
        let result = async {
            let stdin = self.stdin.as_mut().ok_or_else(|| {
                AntigravityAcpError::Protocol("antigravity acp stdin is closed".to_string())
            })?;
            stdin.write_all(&bytes).await?;
            stdin.flush().await?;
            Ok(())
        }
        .await;
        self.outbound_write_in_progress = false;
        result.map_err(|error| self.poison_error(error))
    }

    fn ensure_stream_usable(&mut self) -> Result<(), AntigravityAcpError> {
        self.ensure_outbound_stream_usable()?;
        if self.stdin.is_none() {
            return Err(self.poison_stream("antigravity acp stdin is closed"));
        }
        if self.stdout_reader.is_none() {
            return Err(self.poison_stream("antigravity acp stdout is closed"));
        }
        Ok(())
    }

    fn ensure_outbound_stream_usable(&mut self) -> Result<(), AntigravityAcpError> {
        if let Some(message) = self.stream_unusable_reason.clone() {
            self.sigkill_process_group();
            return Err(AntigravityAcpError::Protocol(message));
        }
        if self.outbound_write_in_progress {
            return Err(self.poison_stream("previous antigravity acp write did not complete"));
        }
        Ok(())
    }

    fn poison_error(&mut self, error: AntigravityAcpError) -> AntigravityAcpError {
        let message = match &error {
            AntigravityAcpError::Protocol(message) => message.clone(),
            _ => error.to_string(),
        };
        if self.stream_unusable_reason.is_none() {
            self.stream_unusable_reason = Some(message);
        }
        self.close_io_handles();
        self.sigkill_process_group();
        error
    }

    fn poison_stream(&mut self, message: impl Into<String>) -> AntigravityAcpError {
        self.poison_error(AntigravityAcpError::Protocol(message.into()))
    }

    fn sigterm_process_group(&self) {
        if let Some(group) = self.child_process_group() {
            group.sigterm();
        }
    }

    fn sigkill_process_group(&self) {
        if let Some(group) = self.child_process_group() {
            group.sigkill();
        }
    }

    fn child_process_group(&self) -> Option<ChildProcessGroup> {
        self.child
            .as_ref()
            .and_then(ChildProcessGroup::from_group_leader_child)
    }

    fn close_io_handles(&mut self) {
        self.stdin.take();
        self.stdout_reader.take();
    }
}

impl Drop for AntigravityAcpClient {
    fn drop(&mut self) {
        if !self.closed {
            self.close_io_handles();
            self.sigkill_process_group();
        }
        if let Some(handle) = self.stderr_handle.take() {
            handle.abort();
        }
    }
}

async fn read_stdout_line<R>(
    stdout_reader: &mut R,
    partial_line: &mut Vec<u8>,
) -> Result<Option<String>, AntigravityAcpError>
where
    R: AsyncBufRead + Unpin,
{
    let read = stdout_reader.read_until(b'\n', partial_line).await?;
    if read == 0 && partial_line.is_empty() {
        return Ok(None);
    }
    if partial_line.last() == Some(&b'\n') {
        partial_line.pop();
        if partial_line.last() == Some(&b'\r') {
            partial_line.pop();
        }
    }
    let line_bytes = partial_line.len();
    String::from_utf8(std::mem::take(partial_line))
        .map(Some)
        .map_err(|error| {
            AntigravityAcpError::Protocol(format!(
                "antigravity acp stdout line is not UTF-8: {}; line_bytes={line_bytes}",
                error.utf8_error(),
            ))
        })
}

fn parse_raw_incoming(line: &str) -> Result<RawIncoming, AntigravityAcpError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        AntigravityAcpError::Protocol(format!(
            "Invalid Antigravity JSON record: {error}; line_bytes={}",
            line.len()
        ))
    })?;
    let Value::Object(mut fields) = value else {
        return Err(AntigravityAcpError::Protocol(
            "Invalid Antigravity JSON record: expected object".to_string(),
        ));
    };

    if fields.contains_key("method") {
        if fields.contains_key("result") || fields.contains_key("error") {
            return Err(AntigravityAcpError::Protocol(
                "request or notification contains response fields".to_string(),
            ));
        }
        let Some(Value::String(method)) = fields.remove("method") else {
            return Err(AntigravityAcpError::Protocol(
                "method must be a string".to_string(),
            ));
        };
        let params = fields.remove("params");
        if let Some(id_value) = fields.remove("id") {
            return Ok(RawIncoming::Request(AcpServerRequest {
                id: parse_id(id_value)?,
                method,
            }));
        }
        return Ok(RawIncoming::Notification(AcpNotification {
            method,
            params,
        }));
    }

    let Some(id_value) = fields.remove("id") else {
        return Err(AntigravityAcpError::Protocol(
            "message has neither id nor method".to_string(),
        ));
    };
    let id = parse_id(id_value)?;
    match (fields.remove("result"), fields.remove("error")) {
        (Some(result), None) => Ok(RawIncoming::Success { id, result }),
        (None, Some(error)) => Ok(RawIncoming::Error {
            id,
            error: parse_error_object(error)?,
        }),
        (Some(_), Some(_)) => Err(AntigravityAcpError::Protocol(
            "response contains both result and error".to_string(),
        )),
        (None, None) => Err(AntigravityAcpError::Protocol(
            "response contains neither result nor error".to_string(),
        )),
    }
}

fn parse_id(value: Value) -> Result<JsonRpcId, AntigravityAcpError> {
    match value {
        Value::Number(number) => number.as_i64().map(JsonRpcId::Number).ok_or_else(|| {
            AntigravityAcpError::Protocol("message id must be an integer, string, or null".into())
        }),
        Value::String(s) => Ok(JsonRpcId::String(s)),
        Value::Null => Ok(JsonRpcId::Null),
        _ => Err(AntigravityAcpError::Protocol(
            "message id must be an integer, string, or null".into(),
        )),
    }
}

fn parse_error_object(value: Value) -> Result<JsonRpcError, AntigravityAcpError> {
    let Value::Object(mut fields) = value else {
        return Err(AntigravityAcpError::Protocol(
            "error response must be an object".into(),
        ));
    };
    let code = fields
        .remove("code")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            AntigravityAcpError::Protocol("error response must contain an integer code".into())
        })?;
    let Some(Value::String(message)) = fields.remove("message") else {
        return Err(AntigravityAcpError::Protocol(
            "error response must contain a string message".into(),
        ));
    };
    Ok(JsonRpcError {
        code,
        message,
        data: fields.remove("data"),
    })
}

fn bounded_text(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let bounded = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}
