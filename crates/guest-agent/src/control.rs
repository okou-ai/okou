//! Guest-agent process-control sink for active input and user cancellation.
//!
//! The `process-control-ipc` crate owns the local wire protocol and transport
//! framing. This module owns the guest-agent side of that channel: starting the
//! blocking control worker, dispatching control requests to
//! [`ActiveInputController`], and shutting the worker down with the rest of the
//! guest-agent background tasks.
//!
//! This is a guest-agent local runtime boundary. It is public because the
//! binary imports modules through the library crate boundary, while integration
//! tests exercise this runtime path through the spawned guest-agent process. It
//! is not a stable external API.

use std::io;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::active_input::{ActiveInputControlOutcome, ActiveInputController};
use guest_telemetry::{log_info, log_warn};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const USER_CANCELLATION_PAYLOAD_TYPE: &str = "user-cancellation";

#[derive(serde::Deserialize)]
struct ControlPayloadType {
    #[serde(rename = "type")]
    payload_type: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UserCancellationPayload {
    #[serde(rename = "type")]
    _payload_type: String,
}

/// Handle for the guest-agent process-control worker.
///
/// A handle owns one blocking worker thread for one guest-agent run. After the
/// worker connects to the host-provided process-control endpoint, it stores a
/// cloned connected stream so shutdown can wake the worker when it is blocked
/// waiting for a request.
///
/// The supplied cancellation token coordinates this worker with the normal
/// guest-agent shutdown path. Calling [`ControlHandle::join`] or dropping the
/// handle cancels the token, shuts down the stored stream clone when one exists,
/// and joins the worker thread. That shutdown path may block until the worker
/// observes cancellation or the stream shutdown and exits.
pub struct ControlHandle {
    join: Option<thread::JoinHandle<()>>,
    stream: Arc<Mutex<Option<UnixStream>>>,
    shutdown: CancellationToken,
}

struct StreamSlotCleanup {
    stream: Arc<Mutex<Option<UnixStream>>>,
}

impl Drop for StreamSlotCleanup {
    fn drop(&mut self) {
        let _ = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

impl ControlHandle {
    /// Starts the process-control worker when process control is bootstrapped.
    ///
    /// The bootstrap endpoint is supplied from the once-resolved canonical or
    /// legacy process environment. Missing or empty values mean this
    /// guest-agent run has no process-control endpoint, so this method returns
    /// `None`.
    ///
    /// This method also returns `None` if the worker thread cannot be spawned.
    /// A returned `Some(ControlHandle)` only means the worker thread was
    /// started. Socket connection, stream-clone storage, hello exchange, and
    /// request-loop failures happen inside that worker thread after this method
    /// returns.
    ///
    /// Incoming control requests are dispatched to the provided
    /// [`ActiveInputController`], and its outcome is mapped back to a local
    /// process-control response.
    pub fn spawn(
        endpoint: Option<&str>,
        shutdown: CancellationToken,
        active_input: ActiveInputController,
        cli_cancellation: CancellationToken,
    ) -> Option<Self> {
        let endpoint = endpoint.filter(|endpoint| !endpoint.is_empty())?.to_owned();
        Self::spawn_endpoint(endpoint, shutdown, active_input, cli_cancellation)
    }

    fn spawn_endpoint(
        endpoint: String,
        shutdown: CancellationToken,
        active_input: ActiveInputController,
        cli_cancellation: CancellationToken,
    ) -> Option<Self> {
        let stream = Arc::new(Mutex::new(None));
        let worker_stream = Arc::clone(&stream);
        let worker_shutdown = shutdown.clone();
        let join = thread::Builder::new()
            .name("guest-agent-process-control".to_owned())
            .spawn(move || {
                run(
                    endpoint,
                    worker_shutdown,
                    worker_stream,
                    active_input,
                    cli_cancellation,
                );
            })
            .map_err(|error| {
                log_warn!(LOG_TAG, "Process control task failed to start: {error}");
            })
            .ok()?;
        Some(Self {
            join: Some(join),
            stream,
            shutdown,
        })
    }

    /// Cancels and joins the process-control worker.
    ///
    /// This consumes the handle, cancels the shared shutdown token, shuts down
    /// the stored stream clone when present to wake a blocking read, and joins
    /// the worker thread. A worker panic is logged and is not propagated to the
    /// caller.
    ///
    /// Dropping [`ControlHandle`] runs the same shutdown and join path.
    pub fn join(mut self) {
        self.shutdown_and_join();
    }

    fn shutdown_and_join(&mut self) {
        self.shutdown.cancel();
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(stream) = stream {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(join) = self.join.take()
            && let Err(error) = join.join()
        {
            log_warn!(LOG_TAG, "Process control task panicked: {error:?}");
        }
    }
}

impl Drop for ControlHandle {
    fn drop(&mut self) {
        self.shutdown_and_join();
    }
}

fn run(
    endpoint: String,
    shutdown: CancellationToken,
    stream_slot: Arc<Mutex<Option<UnixStream>>>,
    active_input: ActiveInputController,
    cli_cancellation: CancellationToken,
) {
    match run_inner(
        &endpoint,
        shutdown,
        stream_slot,
        active_input,
        cli_cancellation,
    ) {
        Ok(()) => log_info!(LOG_TAG, "Process control task stopped"),
        Err(error) => log_warn!(LOG_TAG, "Process control task stopped: {error}"),
    }
}

fn run_inner(
    endpoint: &str,
    shutdown: CancellationToken,
    stream_slot: Arc<Mutex<Option<UnixStream>>>,
    active_input: ActiveInputController,
    cli_cancellation: CancellationToken,
) -> io::Result<()> {
    let mut stream = process_control_ipc::connect_abstract(endpoint)?;
    let shutdown_stream = stream.try_clone()?;
    *stream_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(shutdown_stream);
    let _stream_slot_cleanup = StreamSlotCleanup {
        stream: Arc::clone(&stream_slot),
    };
    stream.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT))?;
    process_control_ipc::write_hello(&mut stream)?;
    log_info!(LOG_TAG, "Process control task connected");

    while !shutdown.is_cancelled() {
        match process_control_ipc::read_request(&mut stream) {
            Ok(request) => {
                let (status, diagnostic) =
                    handle_control_payload(&request.payload, &active_input, &cli_cancellation);
                process_control_ipc::write_response(
                    &mut stream,
                    &process_control_ipc::ControlResponse {
                        message_id: request.message_id,
                        status,
                        diagnostic,
                    },
                )?;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

fn handle_control_payload(
    payload: &[u8],
    active_input: &ActiveInputController,
    cli_cancellation: &CancellationToken,
) -> (process_control_ipc::ControlResponseStatus, String) {
    if serde_json::from_slice::<ControlPayloadType>(payload)
        .is_ok_and(|payload| payload.payload_type == USER_CANCELLATION_PAYLOAD_TYPE)
    {
        return match serde_json::from_slice::<UserCancellationPayload>(payload) {
            Ok(_) => {
                active_input.close_terminal();
                cli_cancellation.cancel();
                (
                    process_control_ipc::ControlResponseStatus::Accepted,
                    String::new(),
                )
            }
            Err(error) => (
                process_control_ipc::ControlResponseStatus::Rejected,
                format!("user cancellation payload is invalid: {error}"),
            ),
        };
    }

    control_response_from_active_input(active_input.handle_control_payload(payload))
}

fn control_response_from_active_input(
    outcome: ActiveInputControlOutcome,
) -> (process_control_ipc::ControlResponseStatus, String) {
    match outcome {
        ActiveInputControlOutcome::Accepted => (
            process_control_ipc::ControlResponseStatus::Accepted,
            String::new(),
        ),
        ActiveInputControlOutcome::Rejected { diagnostic } => (
            process_control_ipc::ControlResponseStatus::Rejected,
            diagnostic.to_owned(),
        ),
        ActiveInputControlOutcome::QueueFull { diagnostic } => (
            process_control_ipc::ControlResponseStatus::QueueFull,
            diagnostic.to_owned(),
        ),
        ActiveInputControlOutcome::Error { diagnostic } => (
            process_control_ipc::ControlResponseStatus::Error,
            diagnostic.to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests;
