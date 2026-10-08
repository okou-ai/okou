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
mod tests {
    use super::*;

    const CONTROL_TEST_READ_TIMEOUT: Duration = Duration::from_secs(3);

    fn active_input_payload(sequence: u64) -> Vec<u8> {
        let event_id = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_OID,
            format!("vm0:control-test:active-input:{sequence}").as_bytes(),
        );
        guest_contracts::active_input::encode_active_input(&event_id.to_string(), "hello")
            .expect("active-input control payload should serialize")
    }

    fn accept_control_stream_and_read_hello(
        listener: &std::os::unix::net::UnixListener,
    ) -> UnixStream {
        let mut stream = process_control_ipc::accept_with_timeout(listener, Duration::from_secs(1))
            .expect("control task should connect");
        stream
            .set_read_timeout(Some(CONTROL_TEST_READ_TIMEOUT))
            .expect("control test stream should set read timeout");
        process_control_ipc::read_hello(&mut stream).expect("control task should send hello");
        stream
    }

    #[test]
    fn control_task_accepts_request_until_shutdown() {
        let nonce = *b"0123456789abcdef";
        let endpoint = process_control_ipc::endpoint_name(42, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let stream_slot = Arc::new(Mutex::new(None));
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                run_inner(
                    &endpoint,
                    worker_shutdown,
                    stream_slot,
                    active_input,
                    CancellationToken::new(),
                )
            }
        });

        let mut stream = accept_control_stream_and_read_hello(&listener);
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: "msg-1".to_owned(),
                payload: active_input_payload(0),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, "msg-1");
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Accepted
        );

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn control_task_accepts_duplicate_user_cancellation_and_rejects_extra_fields() {
        let nonce = *b"cancel-repeat-01";
        let endpoint = process_control_ipc::endpoint_name(48, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let stream_slot = Arc::new(Mutex::new(None));
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let cli_cancellation = CancellationToken::new();
        let worker_cli_cancellation = cli_cancellation.clone();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                run_inner(
                    &endpoint,
                    worker_shutdown,
                    stream_slot,
                    active_input,
                    worker_cli_cancellation,
                )
            }
        });

        let mut stream = accept_control_stream_and_read_hello(&listener);
        for message_id in ["cancel-1", "cancel-2"] {
            process_control_ipc::write_request(
                &mut stream,
                &process_control_ipc::ControlRequest {
                    message_id: message_id.to_string(),
                    payload: br#"{"type":"user-cancellation"}"#.to_vec(),
                },
            )
            .unwrap();
            let response = process_control_ipc::read_response(&mut stream)
                .expect("control task should send response");
            assert_eq!(response.message_id, message_id);
            assert_eq!(
                response.status,
                process_control_ipc::ControlResponseStatus::Accepted
            );
        }
        assert!(cli_cancellation.is_cancelled());

        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: "cancel-invalid".to_string(),
                payload: br#"{"type":"user-cancellation","extra":true}"#.to_vec(),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, "cancel-invalid");
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Rejected
        );
        assert!(
            response
                .diagnostic
                .starts_with("user cancellation payload is invalid:")
        );

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn control_task_rejects_invalid_active_input_payload() {
        let nonce = *b"0123456789abcdee";
        let endpoint = process_control_ipc::endpoint_name(46, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let stream_slot = Arc::new(Mutex::new(None));
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                run_inner(
                    &endpoint,
                    worker_shutdown,
                    stream_slot,
                    active_input,
                    CancellationToken::new(),
                )
            }
        });

        let mut stream = accept_control_stream_and_read_hello(&listener);
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: "bad-1".to_owned(),
                payload: br#"{"type":"other","eventId":"00000000-0000-4000-8000-000000000001","text":"hello"}"#.to_vec(),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream)
            .expect("control task should send response");
        assert_eq!(response.message_id, "bad-1");
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Rejected
        );
        assert_eq!(
            response.diagnostic,
            "active input payload type is unsupported"
        );

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn control_task_reports_queue_full_when_active_input_backlog_is_full() {
        let nonce = *b"1122334455667788";
        let endpoint = process_control_ipc::endpoint_name(47, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let stream_slot = Arc::new(Mutex::new(None));
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                run_inner(
                    &endpoint,
                    worker_shutdown,
                    stream_slot,
                    active_input,
                    CancellationToken::new(),
                )
            }
        });

        let mut stream = accept_control_stream_and_read_hello(&listener);

        let mut accepted_count = 0;
        let mut queue_full_response = None;
        let mut unexpected_status = None;
        for index in 0..32 {
            let message_id = format!("msg-{index}");
            process_control_ipc::write_request(
                &mut stream,
                &process_control_ipc::ControlRequest {
                    message_id: message_id.clone(),
                    payload: active_input_payload(index),
                },
            )
            .unwrap();

            let response = process_control_ipc::read_response(&mut stream)
                .expect("control task should send response");
            assert_eq!(response.message_id, message_id);
            match response.status {
                process_control_ipc::ControlResponseStatus::Accepted => {
                    accepted_count += 1;
                }
                process_control_ipc::ControlResponseStatus::QueueFull => {
                    queue_full_response = Some(response);
                    break;
                }
                status => {
                    unexpected_status = Some(status);
                    break;
                }
            }
        }

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();

        if let Some(status) = unexpected_status {
            panic!("unexpected control response status: {status:?}");
        }
        let response = queue_full_response.expect("active input backlog should become full");
        assert!(accepted_count > 0);
        assert_eq!(response.diagnostic, "active input queue is full");
    }

    #[test]
    fn control_handle_join_wakes_idle_reader() {
        let nonce = *b"fedcba9876543210";
        let endpoint = process_control_ipc::endpoint_name(43, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let handle = ControlHandle::spawn_endpoint(
            endpoint,
            shutdown,
            active_input,
            CancellationToken::new(),
        )
        .unwrap();

        let stream = accept_control_stream_and_read_hello(&listener);

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let joiner = thread::spawn(move || {
            handle.join();
            done_tx.send(()).unwrap();
        });

        if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
            drop(stream);
            joiner.join().unwrap();
            panic!("control handle join should wake idle reader: {error}");
        }
        joiner.join().unwrap();
    }

    #[test]
    fn control_handle_drop_wakes_idle_reader() {
        let nonce = *b"0011223344556677";
        let endpoint = process_control_ipc::endpoint_name(45, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let handle = ControlHandle::spawn_endpoint(
            endpoint,
            shutdown,
            active_input,
            CancellationToken::new(),
        )
        .unwrap();

        let stream = accept_control_stream_and_read_hello(&listener);

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let dropper = thread::spawn(move || {
            drop(handle);
            done_tx.send(()).unwrap();
        });

        if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
            drop(stream);
            dropper.join().unwrap();
            panic!("control handle drop should wake idle reader: {error}");
        }
        dropper.join().unwrap();
    }

    #[test]
    fn control_task_clears_shutdown_stream_when_reader_exits() {
        let nonce = *b"8899aabbccddeeff";
        let endpoint = process_control_ipc::endpoint_name(44, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let stream_slot = Arc::new(Mutex::new(None));
        let worker_slot = Arc::clone(&stream_slot);
        let active_runtime =
            crate::active_input::ActiveInputRuntime::new_for_test("control-test", "initial");
        let active_input = active_runtime.controller();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                run_inner(
                    &endpoint,
                    shutdown,
                    worker_slot,
                    active_input,
                    CancellationToken::new(),
                )
            }
        });

        let stream = accept_control_stream_and_read_hello(&listener);
        drop(stream);

        worker.join().unwrap().unwrap();
        assert!(
            stream_slot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none()
        );
    }
}
