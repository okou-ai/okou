use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sandbox::EXEC_OUTPUT_LIMIT_7_MIB;
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::CONTROL_SOCKET_OVERHEAD_MS;
use super::exec_response::{ExecResult, write_raw_exec_response};
use super::protocol::{
    ExecRequest, TerminateAction, TerminateRequest, TerminateResponse, TerminateStatus,
    read_frame_payload_len, write_frame,
};
use crate::exec_operation_result::{
    captured_exec_output_bytes, exec_termination_from_vsock_termination, reject_stream_overflow,
    validate_exec_capture_timeout,
};
use crate::guest_operations::{GuestOperationStartError, GuestOperationStartGate};
use crate::park_coordinator::{ParkCoordinator, RunControlMismatch, TerminateAdmission};
use crate::runtime_dirs::set_private_runtime_socket_mode;

const CONTROL_SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
const CONTROL_HANDLER_SHUTDOWN_GRACE: Duration = Duration::from_millis(250);
// Bound tasks and sockets independently of the declared request sizes.
const MAX_CONTROL_CONNECTIONS: usize = 32;
// Allow an existing maximum-size frame without retaining that much per client.
const CONTROL_REQUEST_BYTE_BUDGET: usize = 64 * 1024 * 1024;
// One deadline from accept through the entire prefix and body, excluding exec.
const CONTROL_REQUEST_RECEIVE_TIMEOUT: Duration = Duration::from_secs(5);
// One absolute budget for the entire completed exec response, excluding execution.
const CONTROL_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const RUN_CONTROL_MISMATCH_ERROR: &str = "run control target is no longer assigned to this sandbox";

/// Cloneable handle used by the control server to ask the process monitor to
/// terminate the sandbox process group.
#[derive(Clone)]
pub(crate) struct ProcessTerminationHandle {
    kill_tx: mpsc::Sender<ProcessTerminationRequest>,
    park_coordinator: ParkCoordinator,
}

impl ProcessTerminationHandle {
    #[cfg(test)]
    pub(crate) fn new(kill_tx: mpsc::Sender<ProcessTerminationRequest>) -> Self {
        Self::with_park_coordinator(kill_tx, ParkCoordinator::new())
    }

    pub(crate) fn with_park_coordinator(
        kill_tx: mpsc::Sender<ProcessTerminationRequest>,
        park_coordinator: ParkCoordinator,
    ) -> Self {
        Self {
            kill_tx,
            park_coordinator,
        }
    }

    async fn request_terminate(
        &self,
        expected_run_id: Option<&str>,
    ) -> Result<TerminateStatus, RunControlMismatch> {
        match self.park_coordinator.begin_terminate(expected_run_id) {
            TerminateAdmission::Accepted => {}
            TerminateAdmission::RefusedIdle => return Ok(TerminateStatus::RefusedIdle),
            TerminateAdmission::RunControlMismatch => return Err(RunControlMismatch),
        }

        let (ack_tx, ack_rx) = oneshot::channel();
        match self
            .kill_tx
            .send(ProcessTerminationRequest::with_ack(ack_tx))
            .await
        {
            Ok(()) => match ack_rx.await {
                Ok(()) => Ok(TerminateStatus::Accepted),
                Err(_) => Ok(TerminateStatus::AlreadyStopped),
            },
            Err(_) => Ok(TerminateStatus::AlreadyStopped),
        }
    }
}

pub(crate) struct ProcessTerminationRequest {
    ack: Option<oneshot::Sender<()>>,
}

impl ProcessTerminationRequest {
    pub(crate) fn fire_and_forget() -> Self {
        Self { ack: None }
    }

    fn with_ack(ack: oneshot::Sender<()>) -> Self {
        Self { ack: Some(ack) }
    }

    pub(crate) fn acknowledge(self) {
        if let Some(ack) = self.ack {
            let _ = ack.send(());
        }
    }
}

/// A control socket server whose listener has already been bound.
pub(crate) struct BoundControlServer {
    sock_path: Option<SocketPathGuard>,
    listener: Option<UnixListener>,
    guest_operations: GuestOperationStartGate,
    termination: ProcessTerminationHandle,
}

impl BoundControlServer {
    /// Spawn the accept loop for this pre-bound control socket.
    pub(crate) fn spawn(mut self, shutdown: CancellationToken) -> ControlServerHandle {
        let Some(listener) = self.listener.take() else {
            return ControlServerHandle::stopped(self.sock_path.take(), shutdown);
        };
        let Some(sock_path) = self.sock_path.take() else {
            drop(listener);
            return ControlServerHandle::stopped(None, shutdown);
        };

        let task = spawn_bound_server(
            listener,
            sock_path.clone(),
            self.guest_operations.clone(),
            self.termination.clone(),
            shutdown.clone(),
        );
        ControlServerHandle {
            sock_path: Some(sock_path),
            shutdown,
            task: Some(task),
        }
    }

    pub(crate) fn close(mut self) {
        self.close_inner();
    }

    fn close_inner(&mut self) {
        drop(self.listener.take());
        if let Some(sock_path) = self.sock_path.take() {
            sock_path.unlink_once();
        }
    }
}

impl Drop for BoundControlServer {
    fn drop(&mut self) {
        self.close_inner();
    }
}

/// Runtime handle for an active control socket server.
pub(crate) struct ControlServerHandle {
    sock_path: Option<SocketPathGuard>,
    shutdown: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl ControlServerHandle {
    fn stopped(sock_path: Option<SocketPathGuard>, shutdown: CancellationToken) -> Self {
        Self {
            sock_path,
            shutdown,
            task: None,
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        self.shutdown.cancel();
        self.unlink_socket();

        let Some(mut task) = self.task.take() else {
            return;
        };

        let timeout = tokio::time::sleep(CONTROL_SERVER_SHUTDOWN_TIMEOUT);
        tokio::pin!(timeout);
        tokio::select! {
            result = &mut task => {
                log_server_join(result);
            }
            () = &mut timeout => {
                task.abort();
                log_server_join(task.await);
            }
        }
    }

    fn unlink_socket(&mut self) {
        if let Some(sock_path) = self.sock_path.take() {
            sock_path.unlink_once();
        }
    }

    pub(crate) fn abort(&mut self) {
        self.shutdown.cancel();
        self.unlink_socket();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for ControlServerHandle {
    fn drop(&mut self) {
        self.abort();
    }
}

#[derive(Clone)]
struct SocketPathGuard {
    inner: Arc<SocketPathGuardInner>,
}

/// Shared ownership of a Unix socket pathname unlink.
///
/// The listener task and lifecycle handle can both observe shutdown. Unlinking
/// exactly once avoids a later drop removing a socket that has been recreated at
/// the same path.
struct SocketPathGuardInner {
    path: PathBuf,
    unlinked: AtomicBool,
}

impl SocketPathGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            inner: Arc::new(SocketPathGuardInner {
                path,
                unlinked: AtomicBool::new(false),
            }),
        }
    }

    fn path(&self) -> &Path {
        &self.inner.path
    }

    fn unlink_once(&self) {
        if self.inner.unlinked.swap(true, Ordering::AcqRel) {
            return;
        }
        remove_socket_path(&self.inner.path);
    }
}

/// Bind the control socket before spawning the accept loop.
pub(crate) fn bind_server(
    sock_path: PathBuf,
    guest_operations: GuestOperationStartGate,
    termination: ProcessTerminationHandle,
) -> io::Result<BoundControlServer> {
    let listener = bind_unix_listener(&sock_path)?;
    let sock_path = SocketPathGuard::new(sock_path);
    Ok(BoundControlServer {
        sock_path: Some(sock_path),
        listener: Some(listener),
        guest_operations,
        termination,
    })
}

fn bind_unix_listener(sock_path: &Path) -> io::Result<UnixListener> {
    let listener = std::os::unix::net::UnixListener::bind(sock_path)?;
    if let Err(e) = set_private_runtime_socket_mode(sock_path) {
        remove_socket_path(sock_path);
        return Err(e);
    }
    if let Err(e) = listener.set_nonblocking(true) {
        remove_socket_path(sock_path);
        return Err(e);
    }
    UnixListener::from_std(listener).inspect_err(|_| remove_socket_path(sock_path))
}

fn remove_socket_path(sock_path: &Path) {
    match std::fs::remove_file(sock_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => warn!(path = %sock_path.display(), error = %e, "remove control socket"),
    }
}

fn spawn_bound_server(
    listener: UnixListener,
    sock_path: SocketPathGuard,
    guest_operations: GuestOperationStartGate,
    termination: ProcessTerminationHandle,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        info!(path = %sock_path.path().display(), "control socket listening");

        let mut handlers = JoinSet::new();
        let request_bytes = Arc::new(Semaphore::new(CONTROL_REQUEST_BYTE_BUDGET));

        loop {
            tokio::select! {
                biased;

                () = shutdown.cancelled() => {
                    break;
                }

                joined = handlers.join_next(), if !handlers.is_empty() => {
                    log_handler_join(joined);
                }

                accepted = listener.accept() => {
                    let (stream, _) = match accepted {
                        Ok(conn) => conn,
                        Err(e) => {
                            warn!(error = %e, "control socket accept error");
                            continue;
                        }
                    };

                    if handlers.len() >= MAX_CONTROL_CONNECTIONS {
                        warn!(limit = MAX_CONTROL_CONNECTIONS, "control connection limit reached");
                        drop(stream);
                        continue;
                    }

                    let request_deadline = Instant::now() + CONTROL_REQUEST_RECEIVE_TIMEOUT;
                    let request_bytes = Arc::clone(&request_bytes);
                    let guest_operations = guest_operations.clone();
                    let termination = termination.clone();
                    let handler_shutdown = shutdown.clone();
                    handlers.spawn(async move {
                        if let Err(e) = handle_connection(
                            stream, guest_operations, termination, handler_shutdown,
                            request_bytes, request_deadline,
                        ).await {
                            warn!(error = %e, "control connection handler error");
                        }
                    });
                }
            }
        }

        drop(listener);
        sock_path.unlink_once();
        shutdown_handlers(&mut handlers).await;
    })
}

fn log_server_join(joined: Result<(), tokio::task::JoinError>) {
    if let Err(e) = joined
        && !e.is_cancelled()
    {
        warn!(error = %e, "control socket server task failed");
    }
}

fn log_handler_join(joined: Option<Result<(), tokio::task::JoinError>>) {
    if let Some(Err(e)) = joined
        && !e.is_cancelled()
    {
        warn!(error = %e, "control connection task failed");
    }
}

async fn shutdown_handlers(handlers: &mut JoinSet<()>) {
    let drain = async {
        while let Some(joined) = handlers.join_next().await {
            log_handler_join(Some(joined));
        }
    };

    if tokio::time::timeout(CONTROL_HANDLER_SHUTDOWN_GRACE, drain)
        .await
        .is_ok()
    {
        return;
    }

    handlers.abort_all();
    while let Some(joined) = handlers.join_next().await {
        log_handler_join(Some(joined));
    }
}

struct RequestFrame {
    // Field order drops the allocation before making its byte budget available.
    payload: Vec<u8>,
    _byte_permit: OwnedSemaphorePermit,
}

async fn read_request_frame(
    stream: &mut UnixStream,
    request_bytes: Arc<Semaphore>,
) -> io::Result<RequestFrame> {
    let len = read_frame_payload_len(stream).await?;
    // The validated frame length fits u32. Never queue a waiter or allocate a
    // declared body until its entire size has been admitted.
    let byte_permit = request_bytes
        .try_acquire_many_owned(len as u32)
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("control request byte budget unavailable: {error}"),
            )
        })?;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).await?;
    Ok(RequestFrame {
        payload,
        _byte_permit: byte_permit,
    })
}

/// Handle a single control socket connection.
async fn handle_connection(
    mut stream: UnixStream,
    guest_operations: GuestOperationStartGate,
    termination: ProcessTerminationHandle,
    shutdown: CancellationToken,
    request_bytes: Arc<Semaphore>,
    request_deadline: Instant,
) -> io::Result<()> {
    let frame = tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        () = tokio::time::sleep_until(request_deadline) => {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "control request receive timed out"));
        }
        result = read_request_frame(&mut stream, request_bytes) => result?,
    };

    if let Ok(request) = serde_json::from_slice::<TerminateRequest>(&frame.payload) {
        drop(frame);
        let response = terminate(request, &termination).await;
        return write_json_frame(&mut stream, &response).await;
    }

    let request = serde_json::from_slice::<ExecRequest>(&frame.payload);
    drop(frame);
    let response = match request {
        Ok(request) => tokio::select! {
            biased;
            () = shutdown.cancelled() => return Ok(()),
            response = execute(request, &guest_operations) => response,
        },
        Err(e) => ExecResult::Error {
            error: format!("invalid request: {e}"),
        },
    };

    let response_deadline = Instant::now() + CONTROL_RESPONSE_WRITE_TIMEOUT;
    tokio::select! {
        biased;
        () = shutdown.cancelled() => return Ok(()),
        () = tokio::time::sleep_until(response_deadline) => {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "control exec response write timed out"));
        }
        result = write_raw_exec_response(&mut stream, &response) => result?,
    }

    Ok(())
}

async fn terminate(
    request: TerminateRequest,
    termination: &ProcessTerminationHandle,
) -> TerminateResponse {
    match request.action {
        TerminateAction::Terminate => match termination
            .request_terminate(request.expected_run_id.as_deref())
            .await
        {
            Ok(status) => TerminateResponse::Status { status },
            Err(RunControlMismatch) => TerminateResponse::Error {
                error: RUN_CONTROL_MISMATCH_ERROR.into(),
            },
        },
    }
}

async fn write_json_frame<Response: Serialize>(
    stream: &mut UnixStream,
    response: &Response,
) -> io::Result<()> {
    let response_json = encode_json_frame(response)?;
    write_frame(stream, &response_json).await
}

fn encode_json_frame<Response: Serialize>(response: &Response) -> io::Result<Vec<u8>> {
    serde_json::to_vec(response).map_err(|e| io::Error::other(format!("serialize response: {e}")))
}

/// Execute an [`ExecRequest`] through the sandbox operation start gate.
async fn execute(request: ExecRequest, guest_operations: &GuestOperationStartGate) -> ExecResult {
    let vsock = match guest_operations.begin_control_operation().await {
        Ok(vsock) => vsock,
        Err(error) => {
            return ExecResult::Error {
                error: control_start_error(error),
            };
        }
    };

    let ExecRequest {
        expected_run_id,
        command,
        timeout_secs,
        sudo,
    } = request;
    let timeout_ms = timeout_secs.saturating_mul(1000);
    let env: &[(&str, &str)] = &[];

    if let Err(e) = validate_exec_capture_timeout(timeout_ms) {
        return ExecResult::Error {
            error: format!("exec failed: {e}"),
        };
    }

    let write_admission = control_write_admission(guest_operations, expected_run_id);

    let result = vsock
        .exec_operation_capture_with_write_admission(
            guest_control_client::ExecCaptureRequest {
                command: &command,
                timeout_ms,
                env,
                sudo,
                label: "runner-exec",
                stdout_limit_bytes: EXEC_OUTPUT_LIMIT_7_MIB.stdout_limit_bytes,
                stderr_limit_bytes: EXEC_OUTPUT_LIMIT_7_MIB.stderr_limit_bytes,
                expected_exit_codes: &[],
                stdin_bytes: None,
                wait_timeout: Duration::from_millis(timeout_ms as u64 + CONTROL_SOCKET_OVERHEAD_MS),
            },
            write_admission,
        )
        .await
        .and_then(exec_result_from_operation_result);

    match result {
        Ok(response) => response,
        Err(e) => ExecResult::Error {
            error: format!("exec failed: {e}"),
        },
    }
}

fn control_write_admission(
    guest_operations: &GuestOperationStartGate,
    expected_run_id: Option<String>,
) -> guest_control_client::FrameWriteObserver {
    let guest_operations = guest_operations.clone();
    guest_control_client::FrameWriteObserver::new(move || {
        // Terminal recovery releases the Guest fence while policy stays Dirty.
        // Recheck after reserving the normal-operation token so an older control
        // observation cannot cross that fence, including sandbox-scoped exec.
        guest_operations.ensure_policy_open().map_err(|error| {
            io::Error::new(io::ErrorKind::NotConnected, control_start_error(error))
        })?;
        if let Some(expected_run_id) = &expected_run_id {
            guest_operations
                .ensure_run_control_matches(expected_run_id)
                .map_err(|RunControlMismatch| {
                    io::Error::new(io::ErrorKind::PermissionDenied, RUN_CONTROL_MISMATCH_ERROR)
                })?;
        }
        Ok(())
    })
}

fn exec_result_from_operation_result(
    result: guest_control_client::ExecOperationResult,
) -> io::Result<ExecResult> {
    reject_stream_overflow(&result)?;

    let guest_control_client::ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;

    let (stdout, stdout_truncated) = captured_exec_output_bytes("stdout", stdout)?;
    let (stderr, stderr_truncated) = captured_exec_output_bytes("stderr", stderr)?;

    Ok(ExecResult::Success {
        termination: exec_termination_from_vsock_termination(termination),
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic,
    })
}

fn control_start_error(error: GuestOperationStartError) -> String {
    match error {
        GuestOperationStartError::BackendCrashed => "sandbox backend crashed".into(),
        GuestOperationStartError::NotRunning { state } => {
            format!("sandbox not running (state={state})")
        }
        GuestOperationStartError::NoGuest => "sandbox not running".into(),
        GuestOperationStartError::GateClosed { state } => {
            format!("sandbox operation gate closed: {state:?}")
        }
    }
}

#[cfg(test)]
mod tests;
