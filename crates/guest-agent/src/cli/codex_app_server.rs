//! Codex app-server stdio JSON-RPC client.
//!
//! This module owns the guest-agent internal process and protocol boundary for
//! `codex app-server --listen stdio://`. It remains reachable from the public
//! crate facade so integration tests can exercise the child-process boundary,
//! but it is not a stable external SDK surface.
//!
//! The client intentionally stays below thread and turn policy. It sends raw
//! JSON-RPC requests, buffers raw app-server notifications, rejects unsupported
//! server requests, and owns child-process cleanup. Higher-level Codex runtime
//! code is responsible for interpreting thread, turn, and active-input
//! semantics.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use guest_contracts::stdout_framing::CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES;
use guest_telemetry::log_warn;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::error::AgentError;

use super::{
    LOG_TAG, child_env,
    child_exit_notifier::{
        ChildExitNotifier, child_exited_without_reaping, wait_for_child_exit_without_reaping,
    },
    diagnostics, exec_boundary, line_reader,
    process_group::ChildProcessGroup,
};

const METHOD_NOT_FOUND: i64 = -32601;
const NOTIFICATION_QUEUE_CAPACITY: usize = 128;
const NOTIFICATION_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;
const SHUTDOWN_SIGKILL_GRACE: Duration = Duration::from_secs(2);
const STDERR_DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Configuration for one spawned Codex app-server process.
///
/// The config is consumed by [`CodexAppServerClient::spawn`]. Callers must set
/// the child environment with [`Self::with_child_env`] before spawning; this
/// keeps the runtime snapshot explicit and avoids reading process-global
/// guest-agent state inside the client.
#[derive(Debug, Clone)]
pub struct CodexAppServerConfig {
    binary: PathBuf,
    codex_home: PathBuf,
    child_env: Option<CodexAppServerChildEnv>,
    extra_env: Vec<(String, String)>,
    config_overrides: Vec<String>,
    current_dir: Option<PathBuf>,
    opt_out_notification_methods: Vec<String>,
    pidfd_exit_notification: bool,
    workload_containment: Option<crate::workload_containment::WorkloadContainment>,
}

#[derive(Debug, Clone)]
struct CodexAppServerChildEnv {
    home_dir: String,
    user_env: HashMap<String, String>,
    api_url: String,
}

impl CodexAppServerConfig {
    /// Build a config for a Codex binary and explicit `CODEX_HOME`.
    ///
    /// `binary` is executed with `app-server --listen stdio://`. `codex_home`
    /// is created before spawn and is always passed to the child as
    /// `CODEX_HOME`, even if extra env values contain another `CODEX_HOME`.
    pub fn new(binary: impl Into<PathBuf>, codex_home: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            codex_home: codex_home.into(),
            child_env: None,
            extra_env: Vec::new(),
            config_overrides: Vec::new(),
            current_dir: None,
            opt_out_notification_methods: Vec::new(),
            pidfd_exit_notification: true,
            workload_containment: None,
        }
    }

    /// Provide the guest-agent child environment snapshot required by spawn.
    ///
    /// The values are normalized through the same curated child-env path used
    /// by other CLI children. `user_env` is cloned when this builder is called,
    /// so later caller-side mutations are not observed by the app-server
    /// process.
    pub fn with_child_env(
        mut self,
        home_dir: impl Into<String>,
        user_env: &HashMap<String, String>,
        api_url: impl Into<String>,
    ) -> Self {
        self.child_env = Some(CodexAppServerChildEnv {
            home_dir: home_dir.into(),
            user_env: user_env.clone(),
            api_url: api_url.into(),
        });
        self
    }

    /// Add an extra child environment value.
    ///
    /// Extra values are applied before the final `CODEX_HOME` value, so callers
    /// cannot override the configured Codex home through this method.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }

    /// Set the child process working directory.
    ///
    /// If unset, the spawned Codex process inherits the current process working
    /// directory from Tokio's command builder.
    pub fn with_current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    /// Supply the production cgroup placement capability for this child.
    #[must_use]
    pub fn with_workload_containment(
        mut self,
        containment: Option<crate::workload_containment::WorkloadContainment>,
    ) -> Self {
        self.workload_containment = containment;
        self
    }

    /// Add Codex root `-c key=value` startup configuration overrides.
    pub fn with_config_overrides<I, S>(mut self, overrides: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.config_overrides = overrides.into_iter().map(Into::into).collect();
        self
    }

    /// Configure app-server notification methods to opt out of during initialize.
    ///
    /// These values are sent in the `initialize` capabilities as
    /// `optOutNotificationMethods`. They are protocol method names, not
    /// guest-agent event names.
    pub fn with_opt_out_notification_methods<I, S>(mut self, methods: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.opt_out_notification_methods = methods.into_iter().map(Into::into).collect();
        self
    }

    /// Disable the preferred pidfd exit observer for this client.
    ///
    /// This is an integration-test seam for exercising the non-reaping
    /// fallback observer. Production callers should retain the default.
    #[doc(hidden)]
    pub fn without_pidfd_exit_notification(mut self) -> Self {
        self.pidfd_exit_notification = false;
        self
    }
}

/// JSON-RPC message identifier accepted from, and sent to, Codex app-server.
///
/// Request ids generated by the client are numeric. Incoming app-server ids are
/// kept in their raw JSON-RPC shape so protocol errors and server requests can
/// be handled without imposing higher-level runtime policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    /// Integer JSON-RPC id.
    Number(i64),
    /// String JSON-RPC id.
    String(String),
    /// Null JSON-RPC id.
    Null,
}

/// Raw JSON-RPC error object returned by Codex app-server.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonRpcError {
    /// App-server JSON-RPC error code.
    pub code: i64,
    /// App-server JSON-RPC error message.
    pub message: String,
    /// Optional app-server error data.
    pub data: Option<Value>,
}

/// Raw app-server notification.
///
/// Notifications are buffered by [`CodexAppServerClient`] until the higher-level
/// backend consumes and maps them into guest-agent events.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerNotification {
    /// App-server notification method.
    pub method: String,
    /// Optional notification params exactly as read from the wire.
    pub params: Option<Value>,
}

/// Raw app-server request sent to the guest-agent client.
///
/// The current client does not implement server-request methods. It rejects
/// them with JSON-RPC `METHOD_NOT_FOUND` while preserving the incoming id.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerRequest {
    /// Incoming JSON-RPC request id.
    pub id: JsonRpcId,
    /// Incoming request method.
    pub method: String,
    /// Optional request params exactly as read from the wire.
    pub params: Option<Value>,
}

/// Successful response payload for the app-server `initialize` request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    /// App-server reported user-agent string.
    pub user_agent: String,
    /// App-server reported `CODEX_HOME`.
    pub codex_home: String,
    /// App-server reported platform family.
    pub platform_family: String,
    /// App-server reported platform OS.
    pub platform_os: String,
}

/// Errors surfaced by the Codex app-server process/protocol boundary.
///
/// Protocol errors usually poison the stream: the client closes stdio, may kill
/// the process group, and later calls return the original unusable-stream
/// reason rather than attempting to resume a desynchronized JSON-RPC stream.
#[derive(Debug, thiserror::Error)]
pub enum CodexAppServerError {
    /// The Codex child process could not be spawned.
    #[error("failed to spawn codex app-server: {0}")]
    Spawn(#[source] std::io::Error),
    /// Stdio or child wait I/O failed.
    #[error("codex app-server io error: {0}")]
    Io(#[from] std::io::Error),
    /// JSON serialization or deserialization failed before a protocol-specific
    /// error could be reported.
    #[error("codex app-server JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// The app-server returned a JSON-RPC error for a correlated request.
    #[error("codex app-server RPC error for {method}: {error}")]
    Rpc {
        /// Request method that received the error response.
        method: String,
        /// Correlated response id.
        id: JsonRpcId,
        /// Structured app-server error object.
        error: Box<JsonRpcError>,
    },
    /// The app-server stream or local client state violated the expected
    /// JSON-RPC protocol contract.
    #[error("codex app-server protocol error: {0}")]
    Protocol(String),
    /// App-server stdout ended without an observed child exit before cleanup.
    #[error(
        "codex app-server disconnected while waiting for {method}: stdout EOF; child exit not observed before cleanup"
    )]
    Disconnected {
        /// Pending method or operation label.
        method: String,
    },
    /// The child process exited before the pending operation completed.
    #[error("codex app-server child exited while waiting for {method}: {status}")]
    ChildExited {
        /// Pending method or operation label.
        method: String,
        /// Child exit status formatted for diagnostics.
        status: String,
    },
    /// The child did not exit within the forced shutdown grace period.
    #[error("codex app-server did not exit after shutdown")]
    ShutdownTimeout,
}

impl std::fmt::Display for JsonRpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "code={} message={}",
            self.code,
            bounded_error_message(&self.message)
        )
    }
}

impl From<CodexAppServerError> for AgentError {
    fn from(value: CodexAppServerError) -> Self {
        AgentError::Execution(value.to_string())
    }
}

/// Client for a single spawned Codex app-server process.
///
/// The client owns stdin/stdout/stderr handles, the child process, pre-reap
/// process-group cleanup, and JSON-RPC request correlation. It is single-consumer:
/// callers must not start another request, notification wait, or notification
/// write while a previous operation on the same client is still in progress.
///
/// Protocol failures poison the client. After poisoning, the stream is closed
/// and subsequent calls surface the saved protocol reason instead of attempting
/// to reuse a potentially desynchronized app-server process.
///
/// Cancellation is operation-specific. Dropping a started request or write can
/// leave request correlation or the outbound stream uncertain; later protocol
/// use then poisons the client, closes stdio, and terminates the owned child.
/// Cancelling [`Self::next_notification`] while it is only waiting for stdout
/// preserves partial input, but cancelling its server-request rejection write
/// follows the unsafe write rule. A cancelled close operation may be retried to
/// finish cleanup, but JSON-RPC operations must not resume after closing starts.
///
/// Dropping a client that was not closed through [`Self::shutdown`] or
/// [`Self::terminate`] performs best-effort cleanup: stdio handles are closed,
/// the owned child process group is killed before the child handle is dropped,
/// and the stderr collection task is aborted.
pub struct CodexAppServerClient {
    stdin: Option<ChildStdin>,
    stdout_reader: Option<BufReader<ChildStdout>>,
    stdout_partial_line: Vec<u8>,
    child: Option<Child>,
    exit_notifier: Option<ChildExitNotifier>,
    stderr_handle: Option<JoinHandle<Vec<String>>>,
    stderr_tail: Vec<String>,
    next_request_id: i64,
    in_flight_request_id: Option<JsonRpcId>,
    outbound_write_in_progress: bool,
    stream_unusable_reason: Option<String>,
    notifications: VecDeque<QueuedNotification>,
    notification_queue_bytes: usize,
    opt_out_notification_methods: Vec<String>,
    closed: bool,
}

impl CodexAppServerClient {
    /// Spawn `codex app-server --listen stdio://` and return a connected client.
    ///
    /// This must be called inside a Tokio runtime because stderr collection uses
    /// a background task on the current runtime. The client retains direct child
    /// ownership. The config must include
    /// [`CodexAppServerConfig::with_child_env`], and spawn validates the final
    /// argv/env size before creating the child process.
    pub fn spawn(config: CodexAppServerConfig) -> Result<Self, CodexAppServerError> {
        let runtime = Handle::try_current().map_err(|_error| {
            CodexAppServerError::Protocol(
                "codex app-server client requires a Tokio runtime".to_string(),
            )
        })?;
        std::fs::create_dir_all(&config.codex_home)?;

        let mut cmd = tokio::process::Command::new(&config.binary);
        let child_env_config = config.child_env.as_ref().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server child env config is required".to_string())
        })?;
        let mut child_env_values = child_env::values_with_inputs(
            &child_env_config.home_dir,
            &child_env_config.user_env,
            &child_env_config.api_url,
        );
        child_env_values.extend(config.extra_env.iter().cloned());
        child_env_values.push((
            "CODEX_HOME".to_string(),
            config.codex_home.to_string_lossy().into_owned(),
        ));
        if let Some(containment) = config.workload_containment.as_ref() {
            let (key, value) = containment.tool_placement_env();
            child_env_values.push((key.to_string(), value));
        }
        let child_env_values = child_env::normalize_values(child_env_values);
        let args = app_server_args(&config.config_overrides);
        let binary = config.binary.to_string_lossy();
        exec_boundary::validate_process_argv_env(
            "codex app-server argv/env too large",
            &binary,
            args.iter().map(String::as_str),
            &child_env_values,
        )
        .map_err(CodexAppServerError::Protocol)?;
        child_env::apply_values_to_tokio_command(&mut cmd, &child_env_values);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        if let Some(current_dir) = config.current_dir {
            cmd.current_dir(current_dir);
        }
        if let Some(containment) = config.workload_containment.as_ref() {
            containment
                .configure_command(&mut cmd)
                .map_err(CodexAppServerError::Spawn)?;
        }
        let mut child = cmd.spawn().map_err(CodexAppServerError::Spawn)?;
        let stdin = child.stdin.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stdin was not piped".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stdout was not piped".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            CodexAppServerError::Protocol("app-server stderr was not piped".to_string())
        })?;
        let stderr_handle =
            runtime.spawn(async move { diagnostics::collect_stderr_result_tail(stderr).await });
        let exit_notifier = if config.pidfd_exit_notification {
            match ChildExitNotifier::open(&child) {
                Ok(exit_notifier) => Some(exit_notifier),
                Err(error) => {
                    log_warn!(
                        LOG_TAG,
                        "Codex app-server pidfd exit notification unavailable; natural exit cleanup will use non-reaping wait fallback: {error}"
                    );
                    None
                }
            }
        } else {
            None
        };

        Ok(Self {
            stdin: Some(stdin),
            stdout_reader: Some(BufReader::new(stdout)),
            stdout_partial_line: Vec::new(),
            child: Some(child),
            exit_notifier,
            stderr_handle: Some(stderr_handle),
            stderr_tail: Vec::new(),
            next_request_id: 1,
            in_flight_request_id: None,
            outbound_write_in_progress: false,
            stream_unusable_reason: None,
            notifications: VecDeque::with_capacity(NOTIFICATION_QUEUE_CAPACITY),
            notification_queue_bytes: 0,
            opt_out_notification_methods: config.opt_out_notification_methods,
            closed: false,
        })
    }

    /// Return the OS process id while the app-server child is still tracked.
    ///
    /// The id becomes `None` after the child wait completes and the process
    /// handles have been cleared.
    pub fn process_id(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }

    /// Pop the oldest buffered notification, if any.
    ///
    /// Notifications are buffered only when they arrive while a request is
    /// waiting for its response. Removing a notification also releases the
    /// queued byte count tracked for the notification buffer.
    pub fn pop_notification(&mut self) -> Option<ServerNotification> {
        let queued = self.notifications.pop_front()?;
        self.notification_queue_bytes = self.notification_queue_bytes.saturating_sub(queued.bytes);
        Some(queued.notification)
    }

    /// Return the bounded stderr tail collected during shutdown or termination.
    ///
    /// The slice is usually empty while the child is still running. Close paths
    /// drain stderr best-effort and then store the collected tail here.
    pub fn stderr_tail(&self) -> &[String] {
        &self.stderr_tail
    }

    /// Send app-server `initialize` and then the required `initialized` notification.
    ///
    /// The request advertises the experimental app-server API, disables
    /// attestation, and includes configured opt-out notification methods. The
    /// returned payload is the raw app-server initialization response.
    ///
    /// # Cancellation safety
    ///
    /// Dropping this future after it starts can interrupt either the initialize
    /// request or the subsequent `initialized` notification write. Do not resume
    /// JSON-RPC operations on the client; use [`Self::shutdown`] or
    /// [`Self::terminate`] to finish cleanup.
    pub async fn initialize(&mut self) -> Result<InitializeResponse, CodexAppServerError> {
        let mut capabilities = Map::new();
        capabilities.insert("experimentalApi".to_string(), Value::Bool(true));
        capabilities.insert("requestAttestation".to_string(), Value::Bool(false));
        if !self.opt_out_notification_methods.is_empty() {
            capabilities.insert(
                "optOutNotificationMethods".to_string(),
                Value::Array(
                    self.opt_out_notification_methods
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }

        let response = self
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "vm0-guest-agent",
                        "title": null,
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": capabilities
                }),
            )
            .await?;
        self.notify("initialized", Value::Null).await?;
        Ok(response)
    }

    /// Send a request and deserialize the JSON-RPC result into `T`.
    ///
    /// The client allows only one in-flight request. If the response id does
    /// not match the generated request id, or if the response shape does not
    /// deserialize into `T`, the stream is poisoned because request correlation
    /// can no longer be trusted.
    ///
    /// # Cancellation safety
    ///
    /// This method has the same cancellation contract as
    /// [`Self::request_value`]. Dropping it after it starts makes later protocol
    /// reuse unsafe; use [`Self::shutdown`] or [`Self::terminate`] for cleanup.
    pub async fn request<T>(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<T, CodexAppServerError>
    where
        T: DeserializeOwned,
    {
        let value = self.request_value(method, params).await?;
        serde_json::from_value(value).map_err(|_error| {
            self.poison_stream(format!(
                "app-server response for {method} had an unexpected shape"
            ))
        })
    }

    /// Send a request and return the raw JSON-RPC result value.
    ///
    /// Notifications received before the matching response are buffered up to
    /// 128 entries or 16 MiB of raw line data. Unsupported app-server requests
    /// received during the wait are rejected with JSON-RPC `METHOD_NOT_FOUND`,
    /// after which the client continues waiting for the original response.
    ///
    /// # Cancellation safety
    ///
    /// Dropping this future after it starts leaves the request correlation
    /// unresolved and can also leave its outbound write uncertain. A later
    /// protocol operation poisons the client, closes stdio, and terminates the
    /// owned child. Use [`Self::shutdown`] or [`Self::terminate`] for cleanup
    /// instead of resuming JSON-RPC operations.
    pub async fn request_value(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, CodexAppServerError> {
        self.ensure_stream_usable()?;
        let id = JsonRpcId::Number(self.next_request_id);
        self.next_request_id = self.next_request_id.checked_add(1).ok_or_else(|| {
            CodexAppServerError::Protocol("app-server request id counter overflow".to_string())
        })?;
        self.in_flight_request_id = Some(id.clone());
        if let Err(error) = self
            .write_message(&outgoing_request(&id, method, params))
            .await
        {
            self.in_flight_request_id = None;
            return Err(error);
        }

        loop {
            let message = match self.read_next_message(method).await {
                Ok(message) => message,
                Err(error) => {
                    self.in_flight_request_id = None;
                    return Err(error);
                }
            };
            match message {
                IncomingMessage::Success {
                    id: response_id,
                    result,
                } if response_id == id => {
                    self.in_flight_request_id = None;
                    return Ok(result);
                }
                IncomingMessage::Error {
                    id: response_id,
                    error,
                } if response_id == id => {
                    self.in_flight_request_id = None;
                    return Err(CodexAppServerError::Rpc {
                        method: method.to_string(),
                        id: response_id,
                        error: Box::new(error),
                    });
                }
                IncomingMessage::Success { .. } | IncomingMessage::Error { .. } => {
                    self.in_flight_request_id = None;
                    return Err(self.poison_stream(format!(
                        "received response for unknown id while waiting for {method}"
                    )));
                }
                IncomingMessage::Notification {
                    notification,
                    line_bytes,
                } => {
                    if let Err(error) = self.push_notification(notification, line_bytes) {
                        self.in_flight_request_id = None;
                        return Err(self.poison_error(error));
                    }
                }
                IncomingMessage::Request(request) => {
                    if let Err(error) = self.reject_server_request(&request).await {
                        self.in_flight_request_id = None;
                        return Err(error);
                    }
                }
            }
        }
    }

    /// Read the next app-server notification.
    ///
    /// Buffered notifications are returned first. If no notification is
    /// buffered, the client reads stdout until a notification arrives. This
    /// method cannot be used while a request is in flight because that would
    /// split response ownership across two callers.
    ///
    /// # Cancellation safety
    ///
    /// Dropping this future while it is waiting for stdout is safe. Partial line
    /// bytes remain buffered, so a later notification read or request can
    /// continue using the client. However, this method writes a
    /// `METHOD_NOT_FOUND` response when it receives an app-server request.
    /// Dropping the future during that rejection write leaves the outbound
    /// stream uncertain and makes later protocol reuse unsafe.
    pub async fn next_notification(
        &mut self,
        pending_method: &str,
    ) -> Result<ServerNotification, CodexAppServerError> {
        self.ensure_stream_usable()?;
        if self.in_flight_request_id.is_some() {
            return Err(self.poison_stream(
                "cannot wait for app-server notification while a request is in flight",
            ));
        }
        if let Some(notification) = self.pop_notification() {
            return Ok(notification);
        }

        loop {
            match self.read_next_message(pending_method).await? {
                IncomingMessage::Notification { notification, .. } => return Ok(notification),
                IncomingMessage::Request(request) => {
                    self.reject_server_request(&request).await?;
                }
                IncomingMessage::Success { .. } | IncomingMessage::Error { .. } => {
                    return Err(self.poison_stream(format!(
                        "received response while waiting for {pending_method}"
                    )));
                }
            }
        }
    }

    /// Send a JSON-RPC notification to app-server.
    ///
    /// `null` params are omitted from the wire message, matching app-server's
    /// notification shape. The stream must be usable and no other write may be
    /// in progress.
    ///
    /// # Cancellation safety
    ///
    /// Dropping this future after its wire write starts leaves the outbound
    /// stream uncertain. A later protocol operation poisons the client, closes
    /// stdio, and terminates the owned child. Use [`Self::shutdown`] or
    /// [`Self::terminate`] for cleanup instead of resuming JSON-RPC operations.
    pub async fn notify(&mut self, method: &str, params: Value) -> Result<(), CodexAppServerError> {
        self.ensure_stream_usable()?;
        self.write_message(&outgoing_notification(method, params))
            .await
    }

    /// Close stdin and complete app-server shutdown.
    ///
    /// This is the normal close path. When stdin is still open, the client
    /// closes stdio, yields once to let the child observe EOF, then performs
    /// process-group cleanup while the child is still owned and unreaped. Stderr
    /// is drained best-effort before the client is marked closed.
    ///
    /// # Cancellation safety
    ///
    /// If this future is dropped after it first returns `Pending`, protocol I/O
    /// has already been closed. Call `shutdown` again to finish child and stderr
    /// cleanup, but do not resume JSON-RPC operations.
    pub async fn shutdown(&mut self) -> Result<(), CodexAppServerError> {
        if self.closed {
            return Ok(());
        }

        let requested_graceful_shutdown = self.stdin.is_some();
        self.close_io_handles();
        if requested_graceful_shutdown {
            tokio::task::yield_now().await;
        }
        self.finish_close().await
    }

    /// Force app-server termination without the graceful stdin-EOF wait.
    ///
    /// This is used when higher-level runtime policy has already decided the
    /// app-server should stop promptly. It closes stdio, performs process-group
    /// cleanup while the child is still owned and unreaped, and then waits for
    /// the child. Stderr is still drained best-effort before close completes.
    ///
    /// # Cancellation safety
    ///
    /// If this future is dropped after it first returns `Pending`, protocol I/O
    /// has already been closed. Call `terminate` again to finish child and stderr
    /// cleanup, but do not resume JSON-RPC operations.
    pub async fn terminate(&mut self) -> Result<(), CodexAppServerError> {
        if self.closed {
            return Ok(());
        }

        self.close_io_handles();
        self.finish_close().await
    }

    /// Finish cleanup after protocol I/O closes, signaling the owned child before reaping it.
    async fn finish_close(&mut self) -> Result<(), CodexAppServerError> {
        if self.child.is_some() {
            self.sigterm_process_group();
            self.sigkill_process_group();
            if !self.wait_for_child(SHUTDOWN_SIGKILL_GRACE).await? {
                return Err(CodexAppServerError::ShutdownTimeout);
            }
        }

        self.drain_stderr().await;
        self.closed = true;
        Ok(())
    }

    async fn wait_for_child(&mut self, timeout: Duration) -> Result<bool, CodexAppServerError> {
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
    ) -> Result<ExitStatus, CodexAppServerError> {
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
                Err(CodexAppServerError::Io(error))
            }
        }
    }

    async fn read_next_message(
        &mut self,
        pending_method: &str,
    ) -> Result<IncomingMessage, CodexAppServerError> {
        loop {
            let has_exit_notifier = self.exit_notifier.is_some();
            let fallback_child_id = self.child.as_ref().and_then(Child::id);
            tokio::select! {
                biased;
                line = {
                    let Some(stdout_reader) = self.stdout_reader.as_mut() else {
                        return Err(self.poison_stream("app-server stdout is closed"));
                    };
                    read_stdout_line(stdout_reader, &mut self.stdout_partial_line)
                } => {
                    let line = match line {
                        Ok(Some(line)) => line,
                        Ok(None) => {
                            // Stdout stays first so buffered responses win. EOF
                            // may also be ready when the child has already exited;
                            // observe before poison_error sends our cleanup signal.
                            // Do not reap here: group cleanup still owns this PID.
                            if let Some(child_id) = fallback_child_id {
                                match child_exited_without_reaping(child_id) {
                                    Ok(true) => return Err(self.finish_observed_child_exit(pending_method).await),
                                    Ok(false) => {}
                                    Err(error) => return Err(self.poison_error(CodexAppServerError::Io(
                                        std::io::Error::new(error.kind(), format!(
                                            "observe child exit after stdout EOF while waiting for {pending_method}: {error}"
                                        )),
                                    ))),
                                }
                            }
                            return Err(self.poison_error(CodexAppServerError::Disconnected {
                                method: pending_method.to_string(),
                            }));
                        }
                        Err(error) => {
                            return Err(self.poison_error(error));
                        }
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    return parse_incoming_message(&line).map_err(|error| self.poison_error(error));
                }
                exit = async {
                    match self.exit_notifier.as_ref() {
                        Some(exit_notifier) => Some(exit_notifier.wait_for_exit().await),
                        None => None,
                    }
                }, if has_exit_notifier && self.child.is_some() => {
                    let Some(exit) = exit else {
                        return Err(self.poison_stream("app-server exit notifier disappeared"));
                    };
                    if let Err(error) = exit {
                        log_warn!(
                            LOG_TAG,
                            "Codex app-server pidfd exit notification failed; natural exit cleanup will use non-reaping wait fallback: {error}"
                        );
                        self.exit_notifier = None;
                        continue;
                    }
                    return Err(self.finish_observed_child_exit(pending_method).await);
                }
                exit = async {
                    match fallback_child_id {
                        Some(child_id) => {
                            Some(wait_for_child_exit_without_reaping(child_id).await)
                        }
                        None => None,
                    }
                }, if !has_exit_notifier && self.child.is_some() => {
                    let Some(exit) = exit else {
                        return Err(self.poison_stream("app-server child PID disappeared"));
                    };
                    if let Err(error) = exit {
                        return Err(self.poison_error(CodexAppServerError::Io(error)));
                    }
                    return Err(self.finish_observed_child_exit(pending_method).await);
                }
            }
        }
    }

    async fn finish_observed_child_exit(&mut self, pending_method: &str) -> CodexAppServerError {
        self.sigkill_process_group();
        let Some(child) = self.child.as_mut() else {
            return self.poison_stream("app-server child disappeared");
        };
        let result = child.wait().await;
        let status = match self.finish_child_wait(result) {
            Ok(status) => status,
            Err(error) => return self.poison_error(error),
        };
        self.poison_error(CodexAppServerError::ChildExited {
            method: pending_method.to_string(),
            status: status.to_string(),
        })
    }

    async fn reject_server_request(
        &mut self,
        request: &ServerRequest,
    ) -> Result<(), CodexAppServerError> {
        let method = bounded_method_name(&request.method);
        self.write_message(&json!({
            "id": request.id.clone(),
            "error": {
                "code": METHOD_NOT_FOUND,
                "message": format!("unsupported server request method {method}")
            }
        }))
        .await
    }

    fn push_notification(
        &mut self,
        notification: ServerNotification,
        line_bytes: usize,
    ) -> Result<(), CodexAppServerError> {
        if self.notifications.len() == NOTIFICATION_QUEUE_CAPACITY {
            return Err(CodexAppServerError::Protocol(format!(
                "server notification queue exceeded {NOTIFICATION_QUEUE_CAPACITY} entries"
            )));
        }
        let next_bytes = self
            .notification_queue_bytes
            .checked_add(line_bytes)
            .ok_or_else(|| {
                CodexAppServerError::Protocol(
                    "server notification queue byte count overflowed".to_string(),
                )
            })?;
        if next_bytes > NOTIFICATION_QUEUE_MAX_BYTES {
            return Err(CodexAppServerError::Protocol(format!(
                "server notification queue exceeded {NOTIFICATION_QUEUE_MAX_BYTES} bytes"
            )));
        }
        self.notification_queue_bytes = next_bytes;
        self.notifications.push_back(QueuedNotification {
            notification,
            bytes: line_bytes,
        });
        Ok(())
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), CodexAppServerError> {
        if let Some(message) = self.stream_unusable_reason.clone() {
            self.kill_unusable_stream_process_if_needed();
            return Err(CodexAppServerError::Protocol(message));
        }
        if self.outbound_write_in_progress {
            return Err(self.poison_stream("previous app-server write did not complete"));
        }
        if self.stdin.is_none() {
            return Err(CodexAppServerError::Protocol(
                "app-server stdin is closed".to_string(),
            ));
        }
        let mut bytes = serde_json::to_vec(message)?;
        bytes.push(b'\n');
        self.outbound_write_in_progress = true;
        let result = async {
            let stdin = self.stdin.as_mut().ok_or_else(|| {
                CodexAppServerError::Protocol("app-server stdin is closed".to_string())
            })?;
            stdin.write_all(&bytes).await?;
            stdin.flush().await?;
            Ok(())
        }
        .await;
        self.outbound_write_in_progress = false;
        result.map_err(|error| self.poison_error(error))
    }

    fn ensure_stream_usable(&mut self) -> Result<(), CodexAppServerError> {
        if let Some(message) = self.stream_unusable_reason.clone() {
            self.kill_unusable_stream_process_if_needed();
            return Err(CodexAppServerError::Protocol(message));
        }
        if self.outbound_write_in_progress {
            return Err(self.poison_stream("previous app-server write did not complete"));
        }
        if self.stdin.is_none() {
            return Err(self.poison_stream("app-server stdin is closed"));
        }
        if self.stdout_reader.is_none() {
            return Err(self.poison_stream("app-server stdout is closed"));
        }
        if self.in_flight_request_id.is_some() {
            return Err(self.poison_stream("previous app-server request did not complete"));
        }
        Ok(())
    }

    fn poison_error(&mut self, error: CodexAppServerError) -> CodexAppServerError {
        let message = match &error {
            CodexAppServerError::Protocol(message) => message.clone(),
            _ => error.to_string(),
        };
        self.mark_stream_unusable(message);
        self.close_io_handles();
        self.sigkill_process_group();
        error
    }

    fn poison_stream(&mut self, message: impl Into<String>) -> CodexAppServerError {
        let message = message.into();
        self.mark_stream_unusable(message.clone());
        self.close_io_handles();
        self.sigkill_process_group();
        CodexAppServerError::Protocol(message)
    }

    fn mark_stream_unusable(&mut self, message: String) {
        if self.stream_unusable_reason.is_none() {
            self.stream_unusable_reason = Some(message);
        }
    }

    async fn drain_stderr(&mut self) {
        let Some(stderr_handle) = self.stderr_handle.as_ref() else {
            return;
        };
        if !stderr_handle.is_finished() {
            tokio::task::yield_now().await;
        }

        let Some(stderr_handle) = self.stderr_handle.as_mut() else {
            return;
        };

        match tokio::time::timeout(STDERR_DRAIN_GRACE, stderr_handle).await {
            Ok(Ok(lines)) => {
                self.stderr_tail = lines;
                self.stderr_handle = None;
            }
            Ok(Err(_join_error)) => {
                self.stderr_handle = None;
            }
            Err(_elapsed) => {
                if let Some(stderr_handle) = self.stderr_handle.take() {
                    stderr_handle.abort();
                    let _ = stderr_handle.await;
                }
            }
        }
    }

    fn sigterm_process_group(&self) {
        if let Some(process_group) = self.child_process_group() {
            process_group.sigterm();
        }
    }

    fn sigkill_process_group(&self) {
        if let Some(process_group) = self.child_process_group() {
            process_group.sigkill();
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

    fn kill_unusable_stream_process_if_needed(&mut self) {
        self.sigkill_process_group();
    }
}

fn app_server_args(config_overrides: &[String]) -> Vec<String> {
    let mut args = Vec::with_capacity((config_overrides.len() * 2) + 3);
    for override_value in config_overrides {
        args.push("-c".to_string());
        args.push(override_value.clone());
    }
    args.push("app-server".to_string());
    args.push("--listen".to_string());
    args.push("stdio://".to_string());
    args
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        if !self.closed {
            self.close_io_handles();
            self.sigkill_process_group();
        }
        if let Some(stderr_handle) = self.stderr_handle.take() {
            stderr_handle.abort();
        }
    }
}

struct QueuedNotification {
    notification: ServerNotification,
    bytes: usize,
}

enum IncomingMessage {
    Success {
        id: JsonRpcId,
        result: Value,
    },
    Error {
        id: JsonRpcId,
        error: JsonRpcError,
    },
    Notification {
        notification: ServerNotification,
        line_bytes: usize,
    },
    Request(ServerRequest),
}

fn outgoing_request(id: &JsonRpcId, method: &str, params: Value) -> Value {
    json!({
        "id": id,
        "method": method,
        "params": params,
    })
}

fn outgoing_notification(method: &str, params: Value) -> Value {
    if params.is_null() {
        json!({ "method": method })
    } else {
        json!({
            "method": method,
            "params": params,
        })
    }
}

async fn read_stdout_line<R>(
    stdout_reader: &mut R,
    partial_line: &mut Vec<u8>,
) -> Result<Option<String>, CodexAppServerError>
where
    R: AsyncBufRead + Unpin,
{
    match line_reader::read_bounded_utf8_line(
        stdout_reader,
        partial_line,
        CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES,
    )
    .await
    {
        Ok(line) => Ok(line),
        Err(line_reader::BoundedLineError::Io(error)) => Err(CodexAppServerError::Io(error)),
        Err(line_reader::BoundedLineError::TooLong) => Err(stdout_line_too_large_error()),
        Err(line_reader::BoundedLineError::InvalidUtf8 {
            valid_up_to,
            error_len,
            line_bytes,
        }) => {
            let utf8_error = match error_len {
                Some(error_len) => {
                    format!("invalid utf-8 sequence of {error_len} bytes from index {valid_up_to}")
                }
                None => format!("incomplete utf-8 byte sequence from index {valid_up_to}"),
            };
            Err(CodexAppServerError::Protocol(format!(
                "app-server stdout line is not UTF-8: {utf8_error}; line_bytes={line_bytes}"
            )))
        }
    }
}

fn stdout_line_too_large_error() -> CodexAppServerError {
    CodexAppServerError::Protocol(format!(
        "app-server stdout line exceeded {CODEX_APP_SERVER_STDOUT_MAX_LINE_BYTES} bytes"
    ))
}

fn parse_incoming_message(line: &str) -> Result<IncomingMessage, CodexAppServerError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        CodexAppServerError::Protocol(format!(
            "malformed app-server stdout JSON: {error}; line_bytes={}",
            line.len()
        ))
    })?;
    let Value::Object(mut fields) = value else {
        return Err(missing_id_or_method_error());
    };

    if fields.contains_key("method") {
        if fields.contains_key("result") || fields.contains_key("error") {
            return Err(CodexAppServerError::Protocol(
                "request or notification contains response fields".to_string(),
            ));
        }
        let Some(Value::String(method)) = fields.remove("method") else {
            return Err(CodexAppServerError::Protocol(
                "method must be a string".to_string(),
            ));
        };
        let params = fields.remove("params");
        if let Some(id_value) = fields.remove("id") {
            return Ok(IncomingMessage::Request(ServerRequest {
                id: parse_id(id_value)?,
                method,
                params,
            }));
        }
        return Ok(IncomingMessage::Notification {
            notification: ServerNotification { method, params },
            line_bytes: line.len(),
        });
    }

    let Some(id_value) = fields.remove("id") else {
        return Err(missing_id_or_method_error());
    };
    let id = parse_id(id_value)?;

    match (fields.remove("result"), fields.remove("error")) {
        (Some(result), None) => Ok(IncomingMessage::Success { id, result }),
        (None, Some(error)) => Ok(IncomingMessage::Error {
            id,
            error: parse_error_object(error)?,
        }),
        (Some(_), Some(_)) => Err(CodexAppServerError::Protocol(
            "response contains both result and error".to_string(),
        )),
        (None, None) => Err(CodexAppServerError::Protocol(
            "response contains neither result nor error".to_string(),
        )),
    }
}

fn missing_id_or_method_error() -> CodexAppServerError {
    CodexAppServerError::Protocol("message has neither id nor method".to_string())
}

fn parse_id(value: Value) -> Result<JsonRpcId, CodexAppServerError> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(JsonRpcId::Number)
            .ok_or_else(invalid_id_error),
        Value::String(value) => Ok(JsonRpcId::String(value)),
        Value::Null => Ok(JsonRpcId::Null),
        _ => Err(invalid_id_error()),
    }
}

fn invalid_id_error() -> CodexAppServerError {
    CodexAppServerError::Protocol(
        "app-server message id must be an integer, string, or null".to_string(),
    )
}

fn parse_error_object(value: Value) -> Result<JsonRpcError, CodexAppServerError> {
    let Value::Object(mut fields) = value else {
        return Err(CodexAppServerError::Protocol(
            "error response must be an object".to_string(),
        ));
    };
    let code = fields
        .remove("code")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| {
            CodexAppServerError::Protocol("error response must contain an integer code".to_string())
        })?;
    let Some(Value::String(message)) = fields.remove("message") else {
        return Err(CodexAppServerError::Protocol(
            "error response must contain a string message".to_string(),
        ));
    };
    Ok(JsonRpcError {
        code,
        message,
        data: fields.remove("data"),
    })
}

fn bounded_method_name(method: &str) -> String {
    const MAX_CHARS: usize = 120;
    let mut chars = method.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}

fn bounded_error_message(message: &str) -> String {
    const MAX_CHARS: usize = 240;
    let mut chars = message.chars();
    let bounded = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}...")
    } else {
        bounded
    }
}

#[cfg(test)]
mod tests {
    use super::app_server_args;

    #[test]
    fn app_server_args_put_root_config_overrides_before_subcommand() {
        let args = app_server_args(&[
            r#"model_provider="deepseek""#.to_string(),
            r#"model_providers.deepseek.supports_websockets=false"#.to_string(),
            r#"web_search="disabled""#.to_string(),
        ]);

        let expected = [
            "-c",
            r#"model_provider="deepseek""#,
            "-c",
            r#"model_providers.deepseek.supports_websockets=false"#,
            "-c",
            r#"web_search="disabled""#,
            "app-server",
            "--listen",
            "stdio://",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(args, expected);
    }
}
