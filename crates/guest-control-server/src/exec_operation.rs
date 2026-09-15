//! Guest-side exec operation lifecycle.
//!
//! The connection admits an exec request by acquiring an [`OperationGuard`],
//! optionally registering an [`ExecControlGuard`], and adding an
//! [`ExecOperationRegistration`] whose cancellation token is addressed by the
//! request sequence. The worker then validates the request, spawns the child,
//! and advances through [`ExecSetup`], [`ExecSetupWithStdout`], and
//! [`RunningExec`]. These setup states record which process and I/O resources
//! must be recovered if the next worker cannot be started.
//!
//! # Protocol lifecycle
//!
//! One-shot operations do not send `exec_started`. Supervised operations send
//! it after the child is spawned and before the stdin or output workers start.
//! Only supervised operations may omit a timeout or enable exec control.
//! Both lifecycles normally finish by sending one `exec_result`, including
//! controlled start and wait failures. If the supervised `exec_started` write
//! fails, the child and containment are cleaned and operation ownership is
//! released without attempting `exec_result`, because the shared connection
//! can no longer deliver it reliably.
//!
//! # Cancellation and cleanup
//!
//! Running operations observe their timeout, explicit cancellation, and
//! connection cancellation; output delivery failures also request operation
//! cancellation. Setup failures kill and reap the child, stop placement, force
//! process containment cleanup, and cancel or join every I/O worker started so
//! far. Running completion coordinates stdin cancellation with child reaping,
//! then stops placement before cleaning containment, joins stdin, waits for and
//! joins both output drains, and only then resolves captured output and the
//! terminal result.
//!
//! # Completion boundary
//!
//! Normal worker result paths use [`GuestWriter::write_frame_after_lock`] to
//! release the exec-control, quiesce, and operation-registration ownership
//! while holding the shared writer lock immediately before `exec_result` is
//! written. A later lifecycle response therefore cannot overtake the terminal
//! frame. Encoding, write, and worker-start failures still release the
//! ownership they hold through explicit cleanup or the guards' drop fallbacks,
//! even when no terminal frame can be delivered.

use std::collections::HashMap;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::process::{ChildStderr, ChildStdin, ChildStdout};

use crate::contained_command::ContainedChild as Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(test)]
use guest_contracts::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use guest_contracts::process_containment::{
    CANONICAL_TOOL_CGROUP_PROCS_ENV, CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
};
use guest_control_proto::{
    self, ExecAgentReadyTiming, ExecCapturedOutput, ExecControlNonce, ExecControlPolicy,
    ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream, ExecProcessRole, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_AGENT_READY, MSG_EXEC_STARTED,
};

#[cfg(test)]
use guest_control_proto::MSG_EXEC_RESULT;

use crate::agent_command::{
    GuestAgentProgram, spawn_agent_command_with_pipes, spawn_codex_session_cleanup_with_pipes,
    spawn_session_history_identity_verifier_with_pipes,
};
use crate::drain::{
    BoundedDrainResult, BoundedStreamConfig, DrainCancellation, drain_bounded_cancellable,
};
use crate::error::to_io_error;
use crate::exec_control::ExecControlGuard;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::process_containment::{
    ExecProcessContainment, ProcessContainmentCleanupMode, ProcessContainmentError,
    ProcessContainmentMode, WorkloadPlacementBootstrap,
};
use crate::quiesce::OperationGuard;
use crate::shell_command::{
    SpawnedCommand, format_env_diagnostics, spawn_shell_command_with_pipes,
    truncate_command_preview,
};
use crate::threading::{SystemThreadSpawner, ThreadSpawner};
use crate::wait::{WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_cancelled_either};
use crate::writer::GuestWriter;

const THREAD_EXEC_OPERATION_WORKER: &str = "gctl-exec";
const THREAD_EXEC_OPERATION_STDIN: &str = "gctl-exec-in";
const THREAD_EXEC_OPERATION_STDOUT: &str = "gctl-exec-out";
const THREAD_EXEC_OPERATION_STDERR: &str = "gctl-exec-err";
const STDIN_WRITE_CANCELLED: &str = "stdin write cancelled";
const FRAME_BODY_HEADER_LEN: usize = 1 + 4; // message type + sequence
const EXEC_OUTPUT_PAYLOAD_OVERHEAD: usize = 1 + 4 + 1 + 4;
const EXEC_RESULT_EXITED_LEN: usize = 1 + 4;
const EXEC_RESULT_DURATION_LEN: usize = 4;
const EXEC_RESULT_DIAGNOSTIC_LEN_FIELD: usize = 2;
const EXEC_RESULT_MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;
const EXEC_CAPTURED_OUTPUT_OVERHEAD: usize = 1 + 1 + 4;
const EXEC_DISCARDED_OUTPUT_LEN: usize = 1;
const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const AGENT_READY_OBSERVATION_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Default)]
pub(crate) struct ExecOperationRegistry {
    inner: Arc<Mutex<HashMap<u32, ExecOperationRegistryEntry>>>,
}

#[derive(Clone)]
struct ExecOperationRegistryEntry {
    cancel: Arc<AtomicBool>,
    label_preview: String,
    process_class: &'static str,
    operation_kind: &'static str,
}

impl ExecOperationRegistry {
    pub(crate) fn register(
        &self,
        seq: u32,
        label: &str,
        process_class: &'static str,
        operation_kind: &'static str,
    ) -> Result<ExecOperationRegistration, ()> {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(&seq) {
            return Err(());
        }

        let cancel = Arc::new(AtomicBool::new(false));
        active.insert(
            seq,
            ExecOperationRegistryEntry {
                cancel: cancel.clone(),
                label_preview: truncate_command_preview(label),
                process_class,
                operation_kind,
            },
        );
        Ok(ExecOperationRegistration {
            registry: self.clone(),
            seq,
            cancel,
        })
    }

    pub(crate) fn cancel(&self, seq: u32) -> Option<(String, &'static str, &'static str)> {
        let active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let cancel = active.get(&seq)?;
        cancel.cancel.store(true, Ordering::Release);
        Some((
            cancel.label_preview.clone(),
            cancel.process_class,
            cancel.operation_kind,
        ))
    }

    fn remove_if_same(&self, seq: u32, cancel: &Arc<AtomicBool>) {
        let mut active = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if active
            .get(&seq)
            .is_some_and(|existing| Arc::ptr_eq(&existing.cancel, cancel))
        {
            active.remove(&seq);
        }
    }
}

pub(crate) struct ExecOperationRegistration {
    registry: ExecOperationRegistry,
    seq: u32,
    cancel: Arc<AtomicBool>,
}

impl ExecOperationRegistration {
    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    fn complete(&self) {
        self.registry.remove_if_same(self.seq, &self.cancel);
    }
}

impl Drop for ExecOperationRegistration {
    fn drop(&mut self) {
        self.complete();
    }
}

/// Borrowed coordinator for terminal results and operation-state release.
///
/// Start failures, wait failures, and normal completion all converge here.
/// Normal result paths release exec-control, quiesce, and operation-registry
/// ownership at the shared writer-lock boundary. If encoding or writing the
/// result fails, the remaining ownership is still released; the supervised
/// started-acknowledgement failure uses the explicit no-result release path.
#[derive(Clone, Copy)]
struct ExecCompletion<'a> {
    seq: u32,
    started: Instant,
    stdout_policy: ExecOutputPolicy,
    stderr_policy: ExecOutputPolicy,
    registration: &'a ExecOperationRegistration,
    writer: &'a GuestWriter,
    operation_guard: &'a OperationGuard,
    exec_control_guard: Option<&'a ExecControlGuard>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExecOperationLifecycle {
    OneShot,
    Supervised,
}

#[derive(Clone, Copy)]
enum ExecOperationTimeout {
    Duration { timeout_ms: u32 },
    None,
}

impl ExecOperationTimeout {
    fn wait_timeout_ms(self) -> u32 {
        match self {
            Self::Duration { timeout_ms } => timeout_ms,
            Self::None => 0,
        }
    }
}

pub(crate) struct ExecOperationWorkerRequest {
    seq: u32,
    lifecycle: ExecOperationLifecycle,
    role: ExecProcessRole,
    timeout: ExecOperationTimeout,
    command: String,
    env: Vec<(String, String)>,
    sudo: bool,
    label: String,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
    expected_exit_codes: Vec<i32>,
    stdin_bytes: Option<Vec<u8>>,
    control: ExecControlPolicy,
    exec_control_guard: Option<ExecControlGuard>,
    exec_control_bootstrap_endpoint: Option<String>,
    guest_agent_program: GuestAgentProgram,
    session_history_identity_verify_request:
        Option<guest_contracts::session_history_identity::SessionHistoryIdentityVerifyRequest>,
    codex_session_cleanup_request:
        Option<guest_contracts::codex_session_cleanup::CodexSessionCleanupRequest>,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

impl ExecOperationWorkerRequest {
    fn process_class(&self) -> &'static str {
        self.role.process_class()
    }

    fn operation_kind(&self) -> &'static str {
        let lifecycle = match self.lifecycle {
            ExecOperationLifecycle::OneShot => ExecLifecyclePolicy::OneShot,
            ExecOperationLifecycle::Supervised => ExecLifecyclePolicy::Supervised,
        };
        self.role.operation_kind(lifecycle)
    }

    pub(crate) fn from_decoded(
        seq: u32,
        decoded: guest_control_proto::DecodedExecStart<'_>,
        process_containment_mode: ProcessContainmentMode,
        drain_deadline: Duration,
        guest_agent_program: GuestAgentProgram,
    ) -> io::Result<Self> {
        guest_control_proto::validate_exec_process_contract(
            decoded.role,
            decoded.lifecycle,
            decoded.control,
        )
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        let lifecycle = match decoded.lifecycle {
            ExecLifecyclePolicy::OneShot => ExecOperationLifecycle::OneShot,
            ExecLifecyclePolicy::Supervised => ExecOperationLifecycle::Supervised,
        };
        let timeout = match decoded.timeout {
            ExecTimeoutPolicy::Duration { timeout_ms } => {
                if timeout_ms == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "exec timeout duration must be positive",
                    ));
                }
                ExecOperationTimeout::Duration { timeout_ms }
            }
            ExecTimeoutPolicy::None => {
                if lifecycle != ExecOperationLifecycle::Supervised {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "exec timeout policy none requires supervised lifecycle",
                    ));
                }
                ExecOperationTimeout::None
            }
        };
        if lifecycle == ExecOperationLifecycle::OneShot
            && decoded.control != ExecControlPolicy::Disabled
        {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "exec control policy requires supervised lifecycle",
            ));
        }
        let (session_history_identity_verify_request, codex_session_cleanup_request) =
            match decoded.role {
                ExecProcessRole::Agent => {
                    if !decoded.command.is_empty() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Agent process cannot select a command",
                        ));
                    }
                    if decoded.sudo {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Agent process cannot select sudo execution",
                        ));
                    }
                    if decoded.stdin_bytes.is_some() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Agent process cannot provide stdin",
                        ));
                    }
                    (None, None)
                }
                ExecProcessRole::SessionHistoryIdentityVerifier => {
                    validate_session_history_identity_verifier_contract(&decoded)?;
                    let request = serde_json::from_str::<
                    guest_contracts::session_history_identity::SessionHistoryIdentityVerifyRequest,
                >(decoded.command)
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "session history identity verifier payload is invalid",
                    )
                })?;
                    request.validate().map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "session history identity verifier payload is invalid",
                        )
                    })?;
                    (Some(request), None)
                }
                ExecProcessRole::CodexSessionCleanup => {
                    validate_codex_session_cleanup_contract(&decoded)?;
                    let request = serde_json::from_str::<
                        guest_contracts::codex_session_cleanup::CodexSessionCleanupRequest,
                    >(decoded.command)
                    .map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Codex session cleanup payload is invalid",
                        )
                    })?;
                    request.validate().map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Codex session cleanup payload is invalid",
                        )
                    })?;
                    (None, Some(request))
                }
                ExecProcessRole::Workload => (None, None),
            };

        Ok(Self {
            seq,
            lifecycle,
            role: decoded.role,
            timeout,
            command: decoded.command.to_owned(),
            env: decoded
                .env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            sudo: decoded.sudo,
            label: decoded.label.to_owned(),
            stdout: decoded.stdout,
            stderr: decoded.stderr,
            expected_exit_codes: decoded.expected_exit_codes,
            stdin_bytes: decoded.stdin_bytes.map(Vec::from),
            control: decoded.control,
            exec_control_guard: None,
            exec_control_bootstrap_endpoint: None,
            guest_agent_program,
            session_history_identity_verify_request,
            codex_session_cleanup_request,
            process_containment_mode,
            drain_deadline,
        })
    }

    pub(crate) fn exec_control_registration(&self) -> Option<(ExecControlNonce, bool)> {
        match self.control {
            ExecControlPolicy::Disabled => None,
            ExecControlPolicy::Enabled {
                control_nonce,
                sink,
            } => Some((control_nonce, sink)),
        }
    }

    pub(crate) fn attach_exec_control(
        &mut self,
        guard: ExecControlGuard,
        bootstrap_endpoint: Option<String>,
    ) {
        debug_assert!(matches!(self.control, ExecControlPolicy::Enabled { .. }));
        self.exec_control_guard = Some(guard);
        self.exec_control_bootstrap_endpoint = bootstrap_endpoint;
    }

    pub(crate) fn validate_control_attachment(&self) -> io::Result<()> {
        match (self.role, self.exec_control_bootstrap_endpoint.is_some()) {
            (ExecProcessRole::Workload, false)
            | (ExecProcessRole::Agent, true)
            | (ExecProcessRole::SessionHistoryIdentityVerifier, false)
            | (ExecProcessRole::CodexSessionCleanup, false) => Ok(()),
            (ExecProcessRole::Workload, true) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workload process received an Agent control bootstrap endpoint",
            )),
            (ExecProcessRole::Agent, false) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Agent process did not receive a control bootstrap endpoint",
            )),
            (ExecProcessRole::SessionHistoryIdentityVerifier, true) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "session history identity verifier received a control bootstrap endpoint",
            )),
            (ExecProcessRole::CodexSessionCleanup, true) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Codex session cleanup received a control bootstrap endpoint",
            )),
        }
    }
}

fn validate_session_history_identity_verifier_contract(
    decoded: &guest_control_proto::DecodedExecStart<'_>,
) -> io::Result<()> {
    use guest_contracts::session_history_identity::{
        SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL,
        SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
    };

    let fixed_capture = ExecOutputPolicy::Capture {
        limit_bytes: SESSION_HISTORY_IDENTITY_VERIFY_OUTPUT_LIMIT_BYTES,
    };
    let valid = decoded.lifecycle == ExecLifecyclePolicy::OneShot
        && decoded.control == ExecControlPolicy::Disabled
        && !decoded.command.is_empty()
        && decoded.env.is_empty()
        && !decoded.sudo
        && decoded.label == SESSION_HISTORY_IDENTITY_VERIFY_DIAGNOSTIC_LABEL
        && decoded.stdout == fixed_capture
        && decoded.stderr == fixed_capture
        && decoded.expected_exit_codes.is_empty()
        && decoded.stdin_bytes.is_none();
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "session history identity verifier process contract is invalid",
        ))
    }
}

fn validate_codex_session_cleanup_contract(
    decoded: &guest_control_proto::DecodedExecStart<'_>,
) -> io::Result<()> {
    use guest_contracts::codex_session_cleanup::{
        CODEX_SESSION_CLEANUP_DIAGNOSTIC_LABEL, CODEX_SESSION_CLEANUP_OUTPUT_LIMIT_BYTES,
    };

    let fixed_capture = ExecOutputPolicy::Capture {
        limit_bytes: CODEX_SESSION_CLEANUP_OUTPUT_LIMIT_BYTES,
    };
    let valid = decoded.lifecycle == ExecLifecyclePolicy::OneShot
        && decoded.control == ExecControlPolicy::Disabled
        && !decoded.command.is_empty()
        && decoded.env.is_empty()
        && !decoded.sudo
        && decoded.label == CODEX_SESSION_CLEANUP_DIAGNOSTIC_LABEL
        && decoded.stdout == fixed_capture
        && decoded.stderr == fixed_capture
        && decoded.expected_exit_codes.is_empty()
        && decoded.stdin_bytes.is_none();
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Codex session cleanup process contract is invalid",
        ))
    }
}

struct DrainWorker {
    stream: ExecOutputStream,
    policy: OutputSettings,
    stream_writer: Option<SharedExecStreamWriter>,
    drain_cancel: Arc<DrainCancellation>,
    exec_cancel: Arc<AtomicBool>,
    drain_done_tx: mpsc::Sender<()>,
}

type SharedExecStreamWriter = Arc<Mutex<ExecStreamWriter>>;

struct ExecStreamWriter {
    seq: u32,
    label_preview: String,
    writer: GuestWriter,
    output_seq: u32,
    frame: Vec<u8>,
    process_class: &'static str,
    operation_kind: &'static str,
}

impl ExecStreamWriter {
    fn new(
        seq: u32,
        label_preview: String,
        writer: GuestWriter,
        process_class: &'static str,
        operation_kind: &'static str,
    ) -> Self {
        Self {
            seq,
            label_preview,
            writer,
            output_seq: 0,
            frame: Vec::new(),
            process_class,
            operation_kind,
        }
    }

    fn write_output(
        &mut self,
        stream: ExecOutputStream,
        chunk: &[u8],
        truncated: bool,
    ) -> Result<(), ExecStreamWriteError> {
        guest_control_proto::encode_exec_output_frame_into(
            &mut self.frame,
            self.seq,
            stream,
            self.output_seq,
            chunk,
            truncated,
        )
        .map_err(ExecStreamWriteError::Encode)?;
        self.output_seq = self.output_seq.wrapping_add(1);
        self.writer
            .write_frame(&self.frame)
            .map_err(ExecStreamWriteError::Write)
    }
}

enum ExecStreamWriteError {
    Encode(guest_control_proto::ProtocolError),
    Write(io::Error),
}

struct StdinWriter {
    handle: JoinHandle<()>,
    done_rx: mpsc::Receiver<()>,
    result_rx: mpsc::Receiver<io::Result<()>>,
    cancel: Arc<AtomicBool>,
    cancel_wake_writer: OwnedFd,
}

#[derive(Clone, Copy)]
struct OutputSettings {
    capture_limit_bytes: Option<usize>,
    stream: Option<BoundedStreamConfig>,
}

struct ExecResultFrame<'a> {
    seq: u32,
    termination: ExecTermination,
    duration_ms: u32,
    stdout: ExecCapturedOutput<'a>,
    stderr: ExecCapturedOutput<'a>,
    diagnostic: &'a str,
}

impl ExecCompletion<'_> {
    fn start_failed(&self, diagnostic: &str) {
        self.send_result(
            ExecTermination::StartFailed,
            empty_output_for_policy(self.stdout_policy),
            empty_output_for_policy(self.stderr_policy),
            diagnostic,
        );
    }

    fn wait_failed(&self, diagnostic: &str) {
        self.send_result(
            ExecTermination::WaitFailed,
            empty_output_for_policy(self.stdout_policy),
            empty_output_for_policy(self.stderr_policy),
            diagnostic,
        );
    }

    fn finish<'a>(
        &self,
        termination: ExecTermination,
        stdout: ExecCapturedOutput<'a>,
        stderr: ExecCapturedOutput<'a>,
        diagnostic: &'a str,
    ) {
        self.send_result(termination, stdout, stderr, diagnostic);
    }

    fn release_without_result(&self) {
        release_exec_control_guard(self.exec_control_guard);
        self.operation_guard.release();
        self.registration.complete();
    }

    fn send_result<'a>(
        &self,
        termination: ExecTermination,
        stdout: ExecCapturedOutput<'a>,
        stderr: ExecCapturedOutput<'a>,
        diagnostic: &'a str,
    ) {
        send_final_and_complete(
            self.registration,
            ExecResultFrame {
                seq: self.seq,
                termination,
                duration_ms: duration_ms(self.started),
                stdout,
                stderr,
                diagnostic,
            },
            self.writer,
            self.operation_guard,
            self.exec_control_guard,
        );
    }
}

/// Setup state after the child is spawned but before both output drains exist.
///
/// This state owns the child, process containment, optional stdin writer, and
/// drain coordination accumulated so far. A consuming setup-failure path
/// cancels pending work, kills and reaps the child, force-cleans containment,
/// and joins every worker already started before reporting `WaitFailed`. The
/// supervised started-acknowledgement failure occurs before I/O workers start
/// and releases the operation without attempting a terminal result.
struct ExecSetup {
    child: Child,
    process_containment: ExecProcessContainment,
    placement_bootstrap: Option<WorkloadPlacementBootstrap>,
    stdin_writer: Option<StdinWriter>,
    drain_cancel: Arc<DrainCancellation>,
    drain_done_tx: mpsc::Sender<()>,
    drain_done_rx: mpsc::Receiver<()>,
}

impl ExecSetup {
    fn new(
        child: Child,
        process_containment: ExecProcessContainment,
        placement_bootstrap: Option<WorkloadPlacementBootstrap>,
        drain_cancel: Arc<DrainCancellation>,
    ) -> Self {
        let (drain_done_tx, drain_done_rx) = mpsc::channel::<()>();
        Self {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer: None,
            drain_cancel,
            drain_done_tx,
            drain_done_rx,
        }
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    fn set_stdin_writer(&mut self, writer: StdinWriter) {
        self.stdin_writer = Some(writer);
    }

    fn drain_cancel(&self) -> Arc<DrainCancellation> {
        self.drain_cancel.clone()
    }

    fn drain_done_tx(&self) -> mpsc::Sender<()> {
        self.drain_done_tx.clone()
    }

    fn into_stdout_started(
        self,
        stdout_handle: JoinHandle<()>,
        stdout_result_rx: mpsc::Receiver<BoundedDrainResult>,
    ) -> ExecSetupWithStdout {
        ExecSetupWithStdout {
            setup: self,
            stdout_handle,
            stdout_result_rx,
        }
    }

    fn abort_wait_failed(
        self,
        exec_cancel: &AtomicBool,
        completion: &ExecCompletion<'_>,
        diagnostic: &str,
    ) {
        let ExecSetup {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer,
            drain_cancel,
            drain_done_tx: _,
            drain_done_rx: _,
        } = self;
        exec_cancel.store(true, Ordering::Release);
        drain_cancel.cancel();
        kill_and_reap_child(child);
        drop(placement_bootstrap);
        let containment_result =
            cleanup_process_containment(process_containment, ProcessContainmentCleanupMode::Forced);
        join_stdin_writer_after_kill(stdin_writer);
        let containment_error = containment_result.as_ref().err().map(ToString::to_string);
        let diagnostic =
            append_containment_cleanup_failure(diagnostic, containment_error.as_deref());
        completion.wait_failed(&diagnostic);
    }

    fn abort_exec_started_send_failed(self, completion: &ExecCompletion<'_>) {
        debug_assert!(self.stdin_writer.is_none());
        let ExecSetup {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer: _,
            drain_cancel: _,
            drain_done_tx: _,
            drain_done_rx: _,
        } = self;
        kill_and_reap_child(child);
        drop(placement_bootstrap);
        let _ =
            cleanup_process_containment(process_containment, ProcessContainmentCleanupMode::Forced);
        completion.release_without_result();
    }
}

/// Partial setup state in which the stdout drain is running but stderr is not.
///
/// Keeping the stdout handle in a distinct state ensures a stderr startup
/// failure also cleans the base setup resources and joins stdout. Successful
/// stderr startup consumes this state and transfers both drains to
/// [`RunningExec`].
struct ExecSetupWithStdout {
    setup: ExecSetup,
    stdout_handle: JoinHandle<()>,
    stdout_result_rx: mpsc::Receiver<BoundedDrainResult>,
}

impl ExecSetupWithStdout {
    fn drain_cancel(&self) -> Arc<DrainCancellation> {
        self.setup.drain_cancel()
    }

    fn drain_done_tx(&self) -> mpsc::Sender<()> {
        self.setup.drain_done_tx()
    }

    fn abort_wait_failed(
        self,
        exec_cancel: &AtomicBool,
        completion: &ExecCompletion<'_>,
        diagnostic: &str,
    ) {
        let ExecSetupWithStdout {
            setup,
            stdout_handle,
            stdout_result_rx: _,
        } = self;
        let ExecSetup {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer,
            drain_cancel,
            drain_done_tx: _,
            drain_done_rx: _,
        } = setup;
        exec_cancel.store(true, Ordering::Release);
        drain_cancel.cancel();
        kill_and_reap_child(child);
        drop(placement_bootstrap);
        let containment_result =
            cleanup_process_containment(process_containment, ProcessContainmentCleanupMode::Forced);
        join_stdin_writer_after_kill(stdin_writer);
        let _ = stdout_handle.join();
        let containment_error = containment_result.as_ref().err().map(ToString::to_string);
        let diagnostic =
            append_containment_cleanup_failure(diagnostic, containment_error.as_deref());
        completion.wait_failed(&diagnostic);
    }

    fn into_running(
        self,
        stderr_handle: JoinHandle<()>,
        stderr_result_rx: mpsc::Receiver<BoundedDrainResult>,
        stream_writer: Option<SharedExecStreamWriter>,
    ) -> RunningExec {
        let ExecSetupWithStdout {
            setup,
            stdout_handle,
            stdout_result_rx,
        } = self;
        let ExecSetup {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer,
            drain_cancel,
            drain_done_tx,
            drain_done_rx,
        } = setup;
        drop(drain_done_tx);

        RunningExec {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer,
            stdout_handle,
            stdout_result_rx,
            stderr_handle,
            stderr_result_rx,
            stream_writer,
            drain_cancel,
            drain_done_rx,
        }
    }
}

/// Fully started exec operation that owns terminal process and I/O cleanup.
///
/// `finish` consumes this state while it waits for normal exit, timeout, or
/// cancellation. It coordinates stdin cancellation with child reaping so a
/// blocked writer cannot strand completion, cleans process containment, joins
/// stdin, waits for and joins both output drains, and then delegates the
/// resolved output and termination to [`ExecCompletion`].
struct RunningExec {
    child: Child,
    process_containment: ExecProcessContainment,
    placement_bootstrap: Option<WorkloadPlacementBootstrap>,
    stdin_writer: Option<StdinWriter>,
    stdout_handle: JoinHandle<()>,
    stdout_result_rx: mpsc::Receiver<BoundedDrainResult>,
    stderr_handle: JoinHandle<()>,
    stderr_result_rx: mpsc::Receiver<BoundedDrainResult>,
    stream_writer: Option<SharedExecStreamWriter>,
    drain_cancel: Arc<DrainCancellation>,
    drain_done_rx: mpsc::Receiver<()>,
}

#[derive(Clone, Copy)]
struct AgentStartStages {
    containment_create: Duration,
    placement_broker_setup: Duration,
    shell_spawn: Duration,
    shell_spawned_at: Instant,
}

enum AgentReadyWaitOutcome {
    Ready(ExecAgentReadyTiming),
    Terminal,
    Failed(String),
}

impl RunningExec {
    fn wait_for_agent_ready(
        &mut self,
        stages: AgentStartStages,
        connection_cancel: &AtomicBool,
        exec_cancel: &AtomicBool,
    ) -> AgentReadyWaitOutcome {
        loop {
            if connection_cancel.load(Ordering::Acquire) || exec_cancel.load(Ordering::Acquire) {
                return AgentReadyWaitOutcome::Terminal;
            }

            let bootstrap_ready = match self.placement_bootstrap.as_ref() {
                Some(bootstrap) => {
                    match bootstrap.recv_ready_timeout(AGENT_READY_OBSERVATION_INTERVAL) {
                        Ok(Ok(())) => true,
                        Ok(Err(error)) => {
                            return AgentReadyWaitOutcome::Failed(format!(
                                "workload placement bootstrap failed: {error}"
                            ));
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => false,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return AgentReadyWaitOutcome::Failed(
                                "workload placement bootstrap stopped before confirmation"
                                    .to_owned(),
                            );
                        }
                    }
                }
                None => true,
            };
            if bootstrap_ready {
                return match exec_agent_ready_timing(stages) {
                    Ok(timing) => AgentReadyWaitOutcome::Ready(timing),
                    Err(error) => AgentReadyWaitOutcome::Failed(error.to_string()),
                };
            }

            match crate::wait::child_has_exited_without_reap(self.child.id()) {
                Ok(true) => return AgentReadyWaitOutcome::Terminal,
                Ok(false) => {}
                Err(error) => {
                    return AgentReadyWaitOutcome::Failed(format!(
                        "failed to observe Agent before readiness: {error}"
                    ));
                }
            }
        }
    }

    fn finish(
        self,
        request: &ExecOperationWorkerRequest,
        completion: &ExecCompletion<'_>,
        connection_cancel: &AtomicBool,
        exec_cancel: &AtomicBool,
        startup_failure: Option<&str>,
    ) {
        let RunningExec {
            child,
            process_containment,
            placement_bootstrap,
            stdin_writer,
            stdout_handle,
            stdout_result_rx,
            stderr_handle,
            stderr_result_rx,
            stream_writer,
            drain_cancel,
            drain_done_rx,
        } = self;

        let cleanup_process_group_before_reap =
            process_containment.requires_pre_reap_process_group_cleanup();
        let prepare_stdin_writer_for_pre_reap = || {
            let Some(writer) = stdin_writer.as_ref() else {
                return false;
            };
            if matches!(writer.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                request_stdin_writer_cancel(writer);
                true
            } else {
                false
            }
        };
        let prepare_for_pre_reap = || {
            let stdin_writer_cancelled = prepare_stdin_writer_for_pre_reap();
            cleanup_process_group_before_reap || stdin_writer_cancelled
        };
        let outcome = wait_with_kill_timeout_or_cancelled_either(
            child,
            request.timeout.wait_timeout_ms(),
            connection_cancel,
            exec_cancel,
            prepare_for_pre_reap,
        );
        if let Some(writer) = stdin_writer.as_ref()
            && matches!(writer.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty))
        {
            request_stdin_writer_cancel(writer);
        }
        let cancellation_observed =
            connection_cancel.load(Ordering::Acquire) || exec_cancel.load(Ordering::Acquire);
        let cleanup_mode = cleanup_mode_for_wait_outcome(&outcome, cancellation_observed);
        drop(placement_bootstrap);
        if !matches!(&outcome, WaitOutcome::Exited(status) if status.success()) {
            process_containment.capture_error();
        }
        let containment_result = cleanup_process_containment(process_containment, cleanup_mode);
        join_stdin_writer_after_wait(stdin_writer, request.seq, &request.label);
        if matches!(outcome, WaitOutcome::Cancelled | WaitOutcome::TimedOut)
            || connection_cancel.load(Ordering::Acquire)
            || exec_cancel.load(Ordering::Acquire)
            || containment_result.is_err()
        {
            exec_cancel.store(true, Ordering::Release);
            drain_cancel.cancel();
        }

        let completed =
            await_drain_deadline(&drain_done_rx, 2, &drain_cancel, request.drain_deadline);
        if completed < 2 {
            log(
                "WARN",
                &format!(
                    "exec operation: drain deadline reached seq={} label={} process_class={} operation_kind={} after {:?}",
                    request.seq,
                    truncate_command_preview(&request.label),
                    request.process_class(),
                    request.operation_kind(),
                    request.drain_deadline,
                ),
            );
        }

        let stdout_join_failed = stdout_handle.join().is_err();
        let stderr_join_failed = stderr_handle.join().is_err();
        let stdout_result = stdout_result_rx.recv().ok();
        let stderr_result = stderr_result_rx.recv().ok();
        let drains_incomplete = completed < 2
            || stdout_join_failed
            || stderr_join_failed
            || stdout_result.is_none()
            || stderr_result.is_none();
        let stdout_settings = output_settings(request.stdout);
        let stderr_settings = output_settings(request.stderr);
        let stdout_result =
            finalize_exec_drain_result(stdout_result, stdout_settings, drains_incomplete);
        let stderr_result =
            finalize_exec_drain_result(stderr_result, stderr_settings, drains_incomplete);
        if drains_incomplete {
            emit_exec_stream_truncation_markers(
                stream_writer.as_ref(),
                [
                    (
                        ExecOutputStream::Stdout,
                        stdout_settings,
                        stdout_result.stream_truncated,
                    ),
                    (
                        ExecOutputStream::Stderr,
                        stderr_settings,
                        stderr_result.stream_truncated,
                    ),
                ],
            );
        }

        let containment_error = containment_result.as_ref().err().map(ToString::to_string);
        let (termination, diagnostic) = match startup_failure {
            Some(diagnostic) => (
                ExecTermination::StartFailed,
                append_containment_cleanup_failure(diagnostic, containment_error.as_deref()),
            ),
            None => resolve_exec_result(outcome, request.lifecycle, containment_error.as_deref()),
        };
        let containment_evidence = containment_result
            .as_ref()
            .ok()
            .and_then(|evidence| evidence.as_deref());
        let diagnostic = successful_containment_evidence_diagnostic(
            request.lifecycle,
            &request.label,
            termination,
            diagnostic,
            containment_evidence,
        );

        log_exec_terminal_if_notable(
            request,
            completion.started,
            termination,
            &stdout_result,
            &stderr_result,
            &diagnostic,
        );

        completion.finish(
            termination,
            captured_output(&stdout_result),
            captured_output(&stderr_result),
            &diagnostic,
        );
    }
}

fn finalize_exec_drain_result(
    result: Option<BoundedDrainResult>,
    settings: OutputSettings,
    drains_incomplete: bool,
) -> BoundedDrainResult {
    let mut result = result.unwrap_or_else(|| BoundedDrainResult {
        captured: settings.capture_limit_bytes.map(|_| Vec::new()),
        capture_truncated: false,
        stream_truncated: false,
    });
    if drains_incomplete && result.captured.is_some() {
        result.capture_truncated = true;
    }
    result
}

fn emit_exec_stream_truncation_markers(
    stream_writer: Option<&SharedExecStreamWriter>,
    streams: [(ExecOutputStream, OutputSettings, bool); 2],
) {
    let Some(stream_writer) = stream_writer else {
        return;
    };
    let mut writer = match stream_writer.lock() {
        Ok(writer) => writer,
        Err(_) => {
            log(
                "ERROR",
                "exec operation: terminal stream writer mutex poisoned",
            );
            return;
        }
    };
    for (stream, settings, stream_truncated) in streams {
        if settings.stream.is_none() || stream_truncated {
            continue;
        }
        match writer.write_output(stream, &[], true) {
            Ok(()) => {}
            Err(ExecStreamWriteError::Encode(e)) => {
                log(
                    "ERROR",
                    &format!(
                        "exec operation: failed to encode terminal output truncation seq={} label={} process_class={} operation_kind={}: {e}",
                        writer.seq,
                        writer.label_preview,
                        writer.process_class,
                        writer.operation_kind,
                    ),
                );
                return;
            }
            Err(ExecStreamWriteError::Write(e)) => {
                log(
                    "WARN",
                    &format!(
                        "exec operation: failed to send terminal output truncation seq={} label={} process_class={} operation_kind={}: {e}",
                        writer.seq,
                        writer.label_preview,
                        writer.process_class,
                        writer.operation_kind,
                    ),
                );
                return;
            }
        }
    }
}

fn cleanup_mode_for_wait_outcome(
    outcome: &WaitOutcome,
    cancellation_observed: bool,
) -> ProcessContainmentCleanupMode {
    if cancellation_observed {
        return ProcessContainmentCleanupMode::Forced;
    }
    match outcome {
        WaitOutcome::Exited(_) => ProcessContainmentCleanupMode::Graceful,
        WaitOutcome::TimedOut | WaitOutcome::Cancelled | WaitOutcome::WaitFailed(_) => {
            ProcessContainmentCleanupMode::Forced
        }
    }
}

fn resolve_exec_result(
    outcome: WaitOutcome,
    lifecycle: ExecOperationLifecycle,
    containment_error: Option<&str>,
) -> (ExecTermination, String) {
    let (termination, diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            ExecTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            String::new(),
        ),
        WaitOutcome::TimedOut => (ExecTermination::TimedOut, String::new()),
        WaitOutcome::Cancelled => (ExecTermination::Cancelled, String::new()),
        WaitOutcome::WaitFailed(msg) => (
            ExecTermination::WaitFailed,
            format!("Failed to wait: {msg}"),
        ),
    };
    if lifecycle == ExecOperationLifecycle::OneShot && containment_error.is_some() {
        return (
            ExecTermination::WaitFailed,
            append_containment_cleanup_failure(&diagnostic, containment_error),
        );
    }
    (termination, diagnostic)
}

fn successful_containment_evidence_diagnostic(
    lifecycle: ExecOperationLifecycle,
    label: &str,
    termination: ExecTermination,
    diagnostic: String,
    containment_evidence: Option<&str>,
) -> String {
    if let Some(evidence) = containment_evidence
        && evidence.starts_with(guest_contracts::oom_evidence::EVIDENCE_PREFIX)
    {
        // The existing diagnostic frame transports metadata independently of
        // outcome. Runner and Guest ship as one artifact. Never let optional
        // evidence exhaust the existing u16 diagnostic length field.
        if diagnostic
            .len()
            .saturating_add(evidence.len())
            .saturating_add(1)
            > u16::MAX as usize
        {
            // Dropping evidence keeps the real diagnostic intact, but the loss
            // itself must be observable rather than inferred from its absence.
            log(
                "WARN",
                &format!(
                    "exec operation: oom evidence omitted from terminal envelope label={} diagnostic_len={} evidence_len={}",
                    truncate_command_preview(label),
                    diagnostic.len(),
                    evidence.len(),
                ),
            );
            return diagnostic;
        }
        return if diagnostic.is_empty() {
            evidence.to_owned()
        } else {
            format!("{diagnostic}\n{evidence}")
        };
    }
    if lifecycle != ExecOperationLifecycle::OneShot
        || label != "runner-exec"
        || !diagnostic.is_empty()
        || !matches!(termination, ExecTermination::Exited { .. })
    {
        return diagnostic;
    }
    containment_evidence.unwrap_or_default().to_owned()
}

fn append_containment_cleanup_failure(diagnostic: &str, containment_error: Option<&str>) -> String {
    let Some(error) = containment_error else {
        return diagnostic.to_string();
    };
    if diagnostic.is_empty() {
        format!("Failed to clean process containment: {error}")
    } else {
        format!("{diagnostic}; failed to clean process containment: {error}")
    }
}

fn cleanup_process_containment(
    process_containment: ExecProcessContainment,
    mode: ProcessContainmentCleanupMode,
) -> Result<Option<String>, ProcessContainmentError> {
    process_containment.cleanup_with_evidence(mode)
}

pub(crate) fn start_exec_operation(
    request: ExecOperationWorkerRequest,
    operation_guard: OperationGuard,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: ExecOperationRegistry,
) -> io::Result<()> {
    start_exec_operation_with_spawner(
        request,
        operation_guard,
        writer,
        connection_cancel,
        registry,
        SystemThreadSpawner,
    )
}

fn start_exec_operation_with_spawner<S>(
    request: ExecOperationWorkerRequest,
    operation_guard: OperationGuard,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    registry: ExecOperationRegistry,
    spawner: S,
) -> io::Result<()>
where
    S: ThreadSpawner,
{
    let seq = request.seq;
    let process_class = request.process_class();
    let operation_kind = request.operation_kind();
    let registration = match registry.register(seq, &request.label, process_class, operation_kind) {
        Ok(registration) => registration,
        Err(()) => {
            return send_error_response(seq, "exec operation already active", &writer);
        }
    };
    let exec_cancel = registration.cancel_token();
    let stdout_policy = request.stdout;
    let stderr_policy = request.stderr;
    let worker_writer = writer.clone();
    let worker_spawner = spawner.clone();
    let worker_operation_guard = operation_guard.clone();
    let result = spawner.spawn_unit(
        THREAD_EXEC_OPERATION_WORKER,
        Box::new(move || {
            run_exec_operation_worker(
                request,
                worker_writer,
                connection_cancel,
                exec_cancel,
                registration,
                worker_operation_guard,
                worker_spawner,
            );
        }),
    );

    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let diagnostic = format!("Failed to spawn exec operation worker thread: {e}");
            log(
                "ERROR",
                &format!(
                    "exec operation: worker spawn failed seq={seq} process_class={process_class} operation_kind={operation_kind}: {e}"
                ),
            );
            send_exec_result_after_lock(
                ExecResultFrame {
                    seq,
                    termination: ExecTermination::StartFailed,
                    duration_ms: 0,
                    stdout: empty_output_for_policy(stdout_policy),
                    stderr: empty_output_for_policy(stderr_policy),
                    diagnostic: &diagnostic,
                },
                &writer,
                || operation_guard.release(),
            )
        }
    }
}

pub(crate) fn cancel_exec_operation(registry: &ExecOperationRegistry, seq: u32) {
    if let Some((label_preview, process_class, operation_kind)) = registry.cancel(seq) {
        log(
            "INFO",
            &format!(
                "exec operation: cancel requested seq={seq} label={label_preview} process_class={process_class} operation_kind={operation_kind}"
            ),
        );
    }
}

pub(crate) fn send_error_response(seq: u32, message: &str, writer: &GuestWriter) -> io::Result<()> {
    let payload = guest_control_proto::encode_error(message);
    let response = guest_control_proto::encode(MSG_ERROR, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&response)
}

fn run_exec_operation_worker<S>(
    mut request: ExecOperationWorkerRequest,
    writer: GuestWriter,
    connection_cancel: Arc<AtomicBool>,
    exec_cancel: Arc<AtomicBool>,
    registration: ExecOperationRegistration,
    operation_guard: OperationGuard,
    spawner: S,
) where
    S: ThreadSpawner,
{
    let started = Instant::now();
    let completion = ExecCompletion {
        seq: request.seq,
        started,
        stdout_policy: request.stdout,
        stderr_policy: request.stderr,
        registration: &registration,
        writer: &writer,
        operation_guard: &operation_guard,
        exec_control_guard: request.exec_control_guard.as_ref(),
    };
    if let Err(diagnostic) = validate_request(&request) {
        completion.start_failed(&diagnostic);
        return;
    }
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            completion.start_failed(&format!(
                "Failed to initialize output drain cancellation: {error}"
            ));
            return;
        }
    };
    let stdin_bytes = request.stdin_bytes.take();
    let pipe_stdin = stdin_bytes.is_some();

    let process_containment = match ExecProcessContainment::create(
        request.seq,
        request.process_containment_mode,
        request.role,
    ) {
        Ok(process_containment) => process_containment,
        Err(error) => {
            completion.start_failed(&format!(
                "Failed to initialize exec process containment: {error}"
            ));
            return;
        }
    };
    let containment_create = process_containment.create_elapsed();
    let workload_bootstrap =
        if let Some(endpoint) = request.exec_control_bootstrap_endpoint.as_deref() {
            let expected_uid = match crate::user::shell_command_uid(request.sudo) {
                Ok(uid) => uid,
                Err(error) => {
                    let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
                    completion.start_failed(&format!(
                        "Failed to resolve workload placement bootstrap identity: {error}"
                    ));
                    return;
                }
            };
            match process_containment.start_workload_placement_bootstrap(endpoint, expected_uid) {
                Ok(bootstrap) => bootstrap,
                Err(error) => {
                    let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
                    completion.start_failed(&format!(
                        "Failed to initialize workload placement bootstrap: {error}"
                    ));
                    return;
                }
            }
        } else {
            None
        };
    let placement_broker_setup = workload_bootstrap
        .as_ref()
        .map_or(Duration::ZERO, WorkloadPlacementBootstrap::setup_elapsed);
    let env_refs = env_refs(&request.env);
    let mut env_with_control;
    let effective_env = if let Some(endpoint) = request.exec_control_bootstrap_endpoint.as_deref() {
        env_with_control = Vec::with_capacity(env_refs.len() + 3);
        env_with_control.extend_from_slice(&env_refs);
        append_exec_control_environment(
            &mut env_with_control,
            endpoint,
            workload_bootstrap
                .as_ref()
                .map(|bootstrap| (bootstrap.endpoint(), bootstrap.tool_endpoint())),
        );
        env_with_control.as_slice()
    } else {
        env_refs.as_slice()
    };
    let shell_spawn_started = Instant::now();
    let spawn_result = match request.role {
        ExecProcessRole::Workload => spawn_shell_command_with_pipes(
            &request.command,
            effective_env,
            request.sudo,
            pipe_stdin,
            process_containment,
        ),
        ExecProcessRole::Agent => spawn_agent_command_with_pipes(
            effective_env,
            process_containment,
            &request.guest_agent_program,
        ),
        ExecProcessRole::SessionHistoryIdentityVerifier => {
            let Some(verify_request) = request.session_history_identity_verify_request.as_ref()
            else {
                let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
                completion.start_failed("session history identity verifier payload is missing");
                return;
            };
            spawn_session_history_identity_verifier_with_pipes(
                verify_request,
                process_containment,
                &request.guest_agent_program,
            )
        }
        ExecProcessRole::CodexSessionCleanup => {
            let Some(cleanup_request) = request.codex_session_cleanup_request.as_ref() else {
                let _ = process_containment.cleanup(ProcessContainmentCleanupMode::Forced);
                completion.start_failed("Codex session cleanup payload is missing");
                return;
            };
            spawn_codex_session_cleanup_with_pipes(
                cleanup_request,
                process_containment,
                &request.guest_agent_program,
            )
        }
    };
    let spawned = match spawn_result {
        Ok(spawned) => spawned,
        Err(e) => {
            let diagnostic = match request.role {
                ExecProcessRole::Workload => format!(
                    "Failed to execute: {e} ({})",
                    format_env_diagnostics(&request.command, &env_refs)
                ),
                ExecProcessRole::Agent => format!("Failed to execute controlled Agent: {e}"),
                ExecProcessRole::SessionHistoryIdentityVerifier => {
                    format!("Failed to execute session history identity verifier: {e}")
                }
                ExecProcessRole::CodexSessionCleanup => {
                    format!("Failed to execute Codex session cleanup: {e}")
                }
            };
            completion.start_failed(&diagnostic);
            return;
        }
    };
    let shell_spawn = shell_spawn_started.elapsed();
    let shell_spawned_at = Instant::now();
    let SpawnedCommand {
        child,
        env_script,
        process_containment,
    } = spawned;
    let _env_script = env_script;
    let mut setup = ExecSetup::new(child, process_containment, workload_bootstrap, drain_cancel);

    if request.lifecycle == ExecOperationLifecycle::Supervised
        && let Err(e) = send_exec_started(request.seq, setup.child.id(), &writer)
    {
        log(
            "WARN",
            &format!(
                "exec operation: failed to send exec_started seq={} label={} process_class={} operation_kind={}: {e}",
                request.seq,
                truncate_command_preview(&request.label),
                request.process_class(),
                request.operation_kind(),
            ),
        );
        setup.abort_exec_started_send_failed(&completion);
        return;
    }

    let stdout = match setup.take_stdout() {
        Some(stdout) => stdout,
        None => {
            setup.abort_wait_failed(&exec_cancel, &completion, "missing stdout pipe");
            return;
        }
    };
    let stderr = match setup.take_stderr() {
        Some(stderr) => stderr,
        None => {
            setup.abort_wait_failed(&exec_cancel, &completion, "missing stderr pipe");
            return;
        }
    };
    if let Some(stdin_bytes) = stdin_bytes {
        let Some(stdin) = setup.take_stdin() else {
            setup.abort_wait_failed(&exec_cancel, &completion, "missing stdin pipe");
            return;
        };
        match spawn_exec_operation_stdin(stdin, stdin_bytes, spawner.clone()) {
            Ok(writer) => setup.set_stdin_writer(writer),
            Err(e) => {
                setup.abort_wait_failed(
                    &exec_cancel,
                    &completion,
                    &format!("failed to spawn stdin writer thread: {e}"),
                );
                return;
            }
        }
    }

    let stdout_settings = output_settings(request.stdout);
    let stderr_settings = output_settings(request.stderr);
    let needs_stream = stdout_settings.stream.is_some() || stderr_settings.stream.is_some();
    let stream_writer = needs_stream.then(|| {
        Arc::new(Mutex::new(ExecStreamWriter::new(
            request.seq,
            truncate_command_preview(&request.label),
            writer.clone(),
            request.process_class(),
            request.operation_kind(),
        )))
    });

    let stdout_spawn = spawn_exec_operation_drain(
        stdout,
        DrainWorker {
            stream: ExecOutputStream::Stdout,
            policy: stdout_settings,
            stream_writer: stream_writer.clone(),
            drain_cancel: setup.drain_cancel(),
            exec_cancel: exec_cancel.clone(),
            drain_done_tx: setup.drain_done_tx(),
        },
        spawner.clone(),
    );
    let setup = match stdout_spawn {
        Ok((stdout_handle, stdout_result_rx)) => {
            setup.into_stdout_started(stdout_handle, stdout_result_rx)
        }
        Err(e) => {
            setup.abort_wait_failed(
                &exec_cancel,
                &completion,
                &format!("failed to spawn stdout drain thread: {e}"),
            );
            return;
        }
    };

    let stderr_spawn = spawn_exec_operation_drain(
        stderr,
        DrainWorker {
            stream: ExecOutputStream::Stderr,
            policy: stderr_settings,
            stream_writer: stream_writer.clone(),
            drain_cancel: setup.drain_cancel(),
            exec_cancel: exec_cancel.clone(),
            drain_done_tx: setup.drain_done_tx(),
        },
        spawner.clone(),
    );
    let mut running = match stderr_spawn {
        Ok((stderr_handle, stderr_result_rx)) => {
            setup.into_running(stderr_handle, stderr_result_rx, stream_writer)
        }
        Err(e) => {
            setup.abort_wait_failed(
                &exec_cancel,
                &completion,
                &format!("failed to spawn stderr drain thread: {e}"),
            );
            return;
        }
    };

    if request.role == ExecProcessRole::Agent {
        let stages = AgentStartStages {
            containment_create,
            placement_broker_setup,
            shell_spawn,
            shell_spawned_at,
        };
        match running.wait_for_agent_ready(stages, &connection_cancel, &exec_cancel) {
            AgentReadyWaitOutcome::Ready(timing) => {
                if let Err(error) = send_exec_agent_ready(request.seq, timing, &writer) {
                    log(
                        "WARN",
                        &format!(
                            "exec operation: failed to send exec_agent_ready seq={} label={} process_class={} operation_kind={}: {error}",
                            request.seq,
                            truncate_command_preview(&request.label),
                            request.process_class(),
                            request.operation_kind(),
                        ),
                    );
                    exec_cancel.store(true, Ordering::Release);
                    running.finish(
                        &request,
                        &completion,
                        &connection_cancel,
                        &exec_cancel,
                        None,
                    );
                    return;
                }
            }
            AgentReadyWaitOutcome::Terminal => {
                running.finish(
                    &request,
                    &completion,
                    &connection_cancel,
                    &exec_cancel,
                    None,
                );
                return;
            }
            AgentReadyWaitOutcome::Failed(diagnostic) => {
                exec_cancel.store(true, Ordering::Release);
                running.finish(
                    &request,
                    &completion,
                    &connection_cancel,
                    &exec_cancel,
                    Some(&diagnostic),
                );
                return;
            }
        }
    }

    running.finish(
        &request,
        &completion,
        &connection_cancel,
        &exec_cancel,
        None,
    );
}

fn validate_request(request: &ExecOperationWorkerRequest) -> Result<(), String> {
    let stdout_capture = capture_limit_bytes(request.stdout);
    let stderr_capture = capture_limit_bytes(request.stderr);
    let capture_total = stdout_capture
        .unwrap_or(0)
        .checked_add(stderr_capture.unwrap_or(0))
        .ok_or_else(|| "exec capture limits overflow".to_string())?;
    let capture_budget = exec_result_capture_budget(request.stdout, request.stderr);
    if capture_total > capture_budget {
        return Err(format!(
            "exec capture limits exceed protocol result frame budget: {capture_total} > {capture_budget}"
        ));
    }

    let max_chunk = guest_control_proto::MAX_MESSAGE_SIZE
        .saturating_sub(FRAME_BODY_HEADER_LEN)
        .saturating_sub(EXEC_OUTPUT_PAYLOAD_OVERHEAD);
    for (name, policy) in [("stdout", request.stdout), ("stderr", request.stderr)] {
        if let Some(stream) = stream_config(policy)
            && stream.chunk_limit_bytes > max_chunk
        {
            return Err(format!(
                "exec {name} stream chunk limit exceeds protocol frame budget: {} > {max_chunk}",
                stream.chunk_limit_bytes
            ));
        }
    }

    Ok(())
}

fn exec_result_capture_budget(
    stdout_policy: ExecOutputPolicy,
    stderr_policy: ExecOutputPolicy,
) -> usize {
    let fixed = FRAME_BODY_HEADER_LEN
        + EXEC_RESULT_EXITED_LEN
        + EXEC_RESULT_DURATION_LEN
        + exec_result_output_overhead(stdout_policy)
        + exec_result_output_overhead(stderr_policy)
        + EXEC_RESULT_DIAGNOSTIC_LEN_FIELD
        + EXEC_RESULT_MAX_DIAGNOSTIC_BYTES;
    guest_control_proto::MAX_MESSAGE_SIZE.saturating_sub(fixed)
}

fn exec_result_output_overhead(policy: ExecOutputPolicy) -> usize {
    if capture_limit_bytes(policy).is_some() {
        EXEC_CAPTURED_OUTPUT_OVERHEAD
    } else {
        EXEC_DISCARDED_OUTPUT_LEN
    }
}

fn output_settings(policy: ExecOutputPolicy) -> OutputSettings {
    OutputSettings {
        capture_limit_bytes: capture_limit_bytes(policy),
        stream: stream_config(policy),
    }
}

fn capture_limit_bytes(policy: ExecOutputPolicy) -> Option<usize> {
    match policy {
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => None,
        ExecOutputPolicy::Capture { limit_bytes } => Some(limit_bytes as usize),
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            ..
        } => Some(capture_limit_bytes as usize),
    }
}

fn stream_config(policy: ExecOutputPolicy) -> Option<BoundedStreamConfig> {
    match policy {
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        }
        | ExecOutputPolicy::CaptureAndStream {
            stream_limit_bytes: limit_bytes,
            chunk_limit_bytes,
            ..
        } => Some(BoundedStreamConfig {
            chunk_limit_bytes: chunk_limit_bytes as usize,
            stream_limit_bytes: limit_bytes as usize,
        }),
        ExecOutputPolicy::Discard | ExecOutputPolicy::Capture { .. } => None,
    }
}

fn spawn_exec_operation_drain<R, S>(
    pipe: R,
    worker: DrainWorker,
    spawner: S,
) -> io::Result<(JoinHandle<()>, mpsc::Receiver<BoundedDrainResult>)>
where
    R: Into<OwnedFd> + Send + 'static,
    S: ThreadSpawner,
{
    let DrainWorker {
        stream,
        policy,
        stream_writer,
        drain_cancel,
        exec_cancel,
        drain_done_tx,
    } = worker;
    let (result_tx, result_rx) = mpsc::channel();
    let thread_name = match stream {
        ExecOutputStream::Stdout => THREAD_EXEC_OPERATION_STDOUT,
        ExecOutputStream::Stderr => THREAD_EXEC_OPERATION_STDERR,
    };
    let handle = spawner.spawn_unit(
        thread_name,
        Box::new(move || {
            let result = drain_bounded_cancellable(
                pipe,
                &drain_cancel,
                policy.capture_limit_bytes,
                policy.stream,
                |chunk, truncated| {
                    let Some(stream_writer) = &stream_writer else {
                        return true;
                    };
                    if exec_cancel.load(Ordering::Acquire) || drain_cancel.is_cancelled() {
                        return false;
                    }
                    let mut writer = match stream_writer.lock() {
                        Ok(writer) => writer,
                        Err(_) => {
                            log("ERROR", "exec operation: stream writer mutex poisoned");
                            exec_cancel.store(true, Ordering::Release);
                            drain_cancel.cancel();
                            return false;
                        }
                    };
                    if exec_cancel.load(Ordering::Acquire) || drain_cancel.is_cancelled() {
                        return false;
                    }
                    match writer.write_output(stream, chunk, truncated) {
                        Ok(()) => true,
                        Err(ExecStreamWriteError::Encode(e)) => {
                            log(
                                "ERROR",
                                &format!(
                                    "exec operation: failed to encode output seq={} label={} process_class={} operation_kind={}: {e}",
                                    writer.seq,
                                    writer.label_preview,
                                    writer.process_class,
                                    writer.operation_kind,
                                ),
                            );
                            exec_cancel.store(true, Ordering::Release);
                            drain_cancel.cancel();
                            false
                        }
                        Err(ExecStreamWriteError::Write(e)) => {
                            log(
                                "WARN",
                                &format!(
                                    "exec operation: failed to send output chunk seq={} label={} process_class={} operation_kind={}: {e}",
                                    writer.seq,
                                    writer.label_preview,
                                    writer.process_class,
                                    writer.operation_kind,
                                ),
                            );
                            exec_cancel.store(true, Ordering::Release);
                            drain_cancel.cancel();
                            false
                        }
                    }
                },
            );
            let _ = result_tx.send(result);
            let _ = drain_done_tx.send(());
        }),
    )?;
    Ok((handle, result_rx))
}

fn spawn_exec_operation_stdin<W, S>(
    mut stdin: W,
    stdin_bytes: Vec<u8>,
    spawner: S,
) -> io::Result<StdinWriter>
where
    W: AsRawFd + Write + Send + 'static,
    S: ThreadSpawner,
{
    set_nonblocking(stdin.as_raw_fd())?;
    let (cancel_wake_reader, cancel_wake_writer) = stdin_cancel_pipe()?;
    let cancel = Arc::new(AtomicBool::new(false));
    let writer_cancel = Arc::clone(&cancel);
    let (done_tx, done_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let handle = spawner.spawn_unit(
        THREAD_EXEC_OPERATION_STDIN,
        Box::new(move || {
            let result = write_stdin_cancellable(
                &mut stdin,
                &stdin_bytes,
                &writer_cancel,
                cancel_wake_reader.as_raw_fd(),
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        }),
    )?;
    Ok(StdinWriter {
        handle,
        done_rx,
        result_rx,
        cancel,
        cancel_wake_writer,
    })
}

fn stdin_cancel_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `pipe2` initializes two file descriptors in `fds` on success.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: both descriptors were freshly returned by `pipe`.
    let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((read_fd, write_fd))
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fcntl` reads flags for an open file descriptor owned by the caller.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        return Ok(());
    }
    // SAFETY: `fcntl` updates flags for the same open file descriptor.
    let ret = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn write_stdin_cancellable<W>(
    stdin: &mut W,
    stdin_bytes: &[u8],
    cancel: &AtomicBool,
    cancel_fd: RawFd,
) -> io::Result<()>
where
    W: AsRawFd + Write,
{
    let mut written = 0usize;
    while written < stdin_bytes.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let remaining = stdin_bytes
            .get(written..)
            .ok_or_else(|| io::Error::other("stdin write offset out of range"))?;
        match stdin.write(remaining) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "write stdin")),
            Ok(n) => written += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                wait_stdin_writable_or_cancelled(stdin.as_raw_fd(), cancel_fd, cancel)?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn wait_stdin_writable_or_cancelled(
    fd: RawFd,
    cancel_fd: RawFd,
    cancel: &AtomicBool,
) -> io::Result<()> {
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(stdin_write_cancelled());
        }
        let mut pollfds = [
            libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            },
            libc::pollfd {
                fd: cancel_fd,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // Observe readiness only after the final cancellation check. Even if
        // cancellation arrives before poll starts, the wake pipe must be ready.
        #[cfg(test)]
        tests::STDIN_POLL_READY.with(|ready| {
            if let Some(ready) = ready.take() {
                let _ = ready.send(());
            }
        });
        // SAFETY: `pollfds` points to two initialized descriptor entries.
        let result = unsafe { libc::poll(pollfds.as_mut_ptr(), pollfds.len() as libc::nfds_t, -1) };
        if result > 0 {
            let stdin_revents = pollfds[0].revents;
            let cancel_revents = pollfds[1].revents;
            if cancel.load(Ordering::Acquire)
                || cancel_revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)
                    != 0
            {
                return Err(stdin_write_cancelled());
            }
            if stdin_revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "stdin pipe fd invalid",
                ));
            }
            if stdin_revents & (libc::POLLOUT | libc::POLLHUP | libc::POLLERR) != 0 {
                return Ok(());
            }
            continue;
        }
        if result == 0 {
            continue;
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

fn request_stdin_writer_cancel(writer: &StdinWriter) {
    writer.cancel.store(true, Ordering::Release);
    let byte = [1u8];
    loop {
        // SAFETY: `cancel_wake_writer` is an open nonblocking pipe descriptor
        // owned by `writer`; the byte buffer is valid for this call.
        let result = unsafe {
            libc::write(
                writer.cancel_wake_writer.as_raw_fd(),
                byte.as_ptr().cast(),
                byte.len(),
            )
        };
        if result >= 0 {
            return;
        }
        let err = io::Error::last_os_error();
        match err.kind() {
            io::ErrorKind::Interrupted => {}
            io::ErrorKind::WouldBlock | io::ErrorKind::BrokenPipe => return,
            _ => {
                log(
                    "WARN",
                    &format!("exec operation: failed to wake stdin writer cancel: {err}"),
                );
                return;
            }
        }
    }
}

fn stdin_write_cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, STDIN_WRITE_CANCELLED)
}

fn is_stdin_write_cancelled(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Interrupted && error.to_string() == STDIN_WRITE_CANCELLED
}

fn join_stdin_writer_after_wait(writer: Option<StdinWriter>, seq: u32, label: &str) {
    let Some(writer) = writer else {
        return;
    };
    if matches!(writer.done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        // The direct shell is no longer running, but a descendant can still
        // keep stdin open. Stop the writer before joining it so bounded stdin
        // cannot strand this worker thread.
        request_stdin_writer_cancel(&writer);
    }
    join_stdin_writer(writer, seq, label);
}

fn join_stdin_writer_after_kill(writer: Option<StdinWriter>) {
    if let Some(writer) = writer {
        request_stdin_writer_cancel(&writer);
        join_stdin_writer(writer, 0, "");
    }
}

fn join_stdin_writer(writer: StdinWriter, seq: u32, label: &str) {
    match writer.handle.join() {
        Ok(()) => {}
        Err(panic) => std::panic::resume_unwind(panic),
    }
    match writer.result_rx.recv() {
        Ok(Ok(())) | Err(_) => {}
        Ok(Err(e)) if is_stdin_write_cancelled(&e) => {}
        Ok(Err(e)) => {
            let label_preview = truncate_command_preview(label);
            log(
                "WARN",
                &format!(
                    "exec operation: stdin writer finished with error seq={seq} label={label_preview}: {e}"
                ),
            );
        }
    }
}

fn send_final_and_complete(
    registration: &ExecOperationRegistration,
    frame: ExecResultFrame<'_>,
    writer: &GuestWriter,
    operation_guard: &OperationGuard,
    exec_control_guard: Option<&ExecControlGuard>,
) {
    let result = send_exec_result_after_lock(frame, writer, || {
        release_exec_control_guard(exec_control_guard);
        operation_guard.release();
        registration.complete();
    });
    if result.is_err() {
        release_exec_control_guard(exec_control_guard);
        operation_guard.release();
        registration.complete();
    }
    if let Err(e) = result {
        log("ERROR", &format!("Failed to send exec_result: {e}"));
    }
}

fn release_exec_control_guard(guard: Option<&ExecControlGuard>) {
    if let Some(guard) = guard {
        guard.release();
    }
}

fn send_exec_started(seq: u32, pid: u32, writer: &GuestWriter) -> io::Result<()> {
    let payload = guest_control_proto::encode_exec_started(pid).map_err(to_io_error)?;
    let encoded =
        guest_control_proto::encode(MSG_EXEC_STARTED, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&encoded)
}

fn send_exec_agent_ready(
    seq: u32,
    timing: ExecAgentReadyTiming,
    writer: &GuestWriter,
) -> io::Result<()> {
    let payload = guest_control_proto::encode_exec_agent_ready(timing);
    let encoded =
        guest_control_proto::encode(MSG_EXEC_AGENT_READY, seq, &payload).map_err(to_io_error)?;
    writer.write_frame(&encoded)
}

fn exec_agent_ready_timing(stages: AgentStartStages) -> io::Result<ExecAgentReadyTiming> {
    Ok(ExecAgentReadyTiming {
        containment_create_us: duration_micros_u32(
            stages.containment_create,
            "containment creation",
        )?,
        placement_broker_setup_us: duration_micros_u32(
            stages.placement_broker_setup,
            "placement broker setup",
        )?,
        shell_spawn_us: duration_micros_u32(stages.shell_spawn, "shell spawn")?,
        bootstrap_ready_wait_us: duration_micros_u32(
            stages.shell_spawned_at.elapsed(),
            "bootstrap ready wait",
        )?,
    })
}

fn duration_micros_u32(duration: Duration, stage: &str) -> io::Result<u32> {
    u32::try_from(duration.as_micros()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Agent startup {stage} duration exceeds the wire limit"),
        )
    })
}

fn send_exec_result_after_lock<F>(
    frame: ExecResultFrame<'_>,
    writer: &GuestWriter,
    after_lock: F,
) -> io::Result<()>
where
    F: FnOnce(),
{
    let mut encoded = Vec::new();
    guest_control_proto::encode_exec_result_frame_into(
        &mut encoded,
        frame.seq,
        frame.termination,
        frame.duration_ms,
        frame.stdout,
        frame.stderr,
        frame.diagnostic,
    )
    .map_err(to_io_error)?;
    writer.write_frame_after_lock(&encoded, after_lock)
}

fn captured_output(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    match result.captured.as_deref() {
        Some(bytes) => ExecCapturedOutput::Captured {
            bytes,
            truncated: result.capture_truncated,
        },
        None => ExecCapturedOutput::Discarded,
    }
}

fn empty_output_for_policy(policy: ExecOutputPolicy) -> ExecCapturedOutput<'static> {
    match policy {
        ExecOutputPolicy::Capture { .. } | ExecOutputPolicy::CaptureAndStream { .. } => {
            ExecCapturedOutput::Captured {
                bytes: &[],
                truncated: false,
            }
        }
        ExecOutputPolicy::Discard | ExecOutputPolicy::Stream { .. } => {
            ExecCapturedOutput::Discarded
        }
    }
}

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn append_exec_control_environment<'a>(
    env: &mut Vec<(&'a str, &'a str)>,
    process_control_endpoint: &'a str,
    workload_endpoints: Option<(&'a str, &'a str)>,
) {
    env.retain(|(key, _)| {
        *key != process_control_ipc::CANONICAL_BOOTSTRAP_ENV
            && *key != CANONICAL_WORKLOAD_CGROUP_PROCS_ENV
            && *key != CANONICAL_TOOL_CGROUP_PROCS_ENV
    });
    env.push((
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        process_control_endpoint,
    ));
    if let Some((workload_endpoint, tool_endpoint)) = workload_endpoints {
        env.push((CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, workload_endpoint));
        env.push((CANONICAL_TOOL_CGROUP_PROCS_ENV, tool_endpoint));
    }
}

fn duration_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn exec_termination_is_notable(termination: ExecTermination, expected_exit_codes: &[i32]) -> bool {
    !matches!(
        termination,
        ExecTermination::Exited { exit_code }
            if exit_code == 0 || expected_exit_codes.contains(&exit_code)
    )
}

fn exec_terminal_log_reason(
    slow: bool,
    notable: bool,
    oom_evidence_proof: bool,
) -> Option<&'static str> {
    if notable {
        return Some("notable");
    }
    if oom_evidence_proof {
        return Some("oom_evidence");
    }
    if slow {
        return Some("slow");
    }
    None
}

struct ExecTerminalLogMessageInput<'a> {
    request: &'a ExecOperationWorkerRequest,
    elapsed_ms: u128,
    termination: ExecTermination,
    stdout_result: &'a BoundedDrainResult,
    stderr_result: &'a BoundedDrainResult,
    diagnostic_present: bool,
    oom_evidence: bool,
    oom_evidence_proof: bool,
    slow: bool,
    notable: bool,
}

fn exec_terminal_log_message(input: ExecTerminalLogMessageInput<'_>) -> Option<String> {
    let terminal_reason =
        exec_terminal_log_reason(input.slow, input.notable, input.oom_evidence_proof)?;
    Some(format!(
        "exec result: seq={} label={} process_class={} operation_kind={} elapsed_ms={} slow={} notable={} terminal_reason={} termination={:?} stdout_len={} stderr_len={} stdout_truncated={} stderr_truncated={} diagnostic_present={} oom_evidence={} oom_evidence_proof={}",
        input.request.seq,
        truncate_command_preview(&input.request.label),
        input.request.process_class(),
        input.request.operation_kind(),
        input.elapsed_ms,
        input.slow,
        input.notable,
        terminal_reason,
        input.termination,
        input.stdout_result.captured.as_ref().map_or(0, Vec::len),
        input.stderr_result.captured.as_ref().map_or(0, Vec::len),
        input.stdout_result.capture_truncated,
        input.stderr_result.capture_truncated,
        input.diagnostic_present,
        input.oom_evidence,
        input.oom_evidence_proof,
    ))
}

fn exec_terminal_log_message_for_diagnostic(
    request: &ExecOperationWorkerRequest,
    elapsed: Duration,
    termination: ExecTermination,
    stdout_result: &BoundedDrainResult,
    stderr_result: &BoundedDrainResult,
    diagnostic: &str,
) -> Option<String> {
    let slow = elapsed >= EXEC_OPERATION_STAGE_SLOW_THRESHOLD;
    // The terminal frame also transports bounded OOM metadata. Classify on the
    // residual so an inspected-and-empty capture candidate is not reported as a
    // diagnostic, and keep a broken envelope loud.
    let split = guest_contracts::oom_evidence::split_diagnostic(diagnostic);
    let notable = exec_termination_is_notable(termination, &request.expected_exit_codes)
        || stdout_result.capture_truncated
        || stderr_result.capture_truncated
        || split.is_actionable()
        || split.malformed_lines > 0;

    exec_terminal_log_message(ExecTerminalLogMessageInput {
        request,
        elapsed_ms: elapsed.as_millis(),
        termination,
        stdout_result,
        stderr_result,
        diagnostic_present: split.is_actionable(),
        oom_evidence: split.evidence.is_some(),
        oom_evidence_proof: split.has_proof(),
        slow,
        notable,
    })
}

fn log_exec_terminal_if_notable(
    request: &ExecOperationWorkerRequest,
    started: Instant,
    termination: ExecTermination,
    stdout_result: &BoundedDrainResult,
    stderr_result: &BoundedDrainResult,
    diagnostic: &str,
) {
    if let Some(message) = exec_terminal_log_message_for_diagnostic(
        request,
        started.elapsed(),
        termination,
        stdout_result,
        stderr_result,
        diagnostic,
    ) {
        log("WARN", &message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use crate::threading::{UnitTask, VecTask};
    use std::cell::Cell;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::net::Shutdown;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::process::Command;
    use std::time::Duration;

    thread_local! {
        pub(super) static STDIN_POLL_READY: Cell<Option<mpsc::Sender<()>>> = const { Cell::new(None) };
    }

    #[derive(Clone)]
    struct StdinPollReadySpawner {
        ready: mpsc::Sender<()>,
    }

    impl ThreadSpawner for StdinPollReadySpawner {
        fn spawn_unit(&self, name: &'static str, task: UnitTask) -> io::Result<JoinHandle<()>> {
            let ready = self.ready.clone();
            SystemThreadSpawner.spawn_unit(
                name,
                Box::new(move || {
                    STDIN_POLL_READY.set(Some(ready));
                    task();
                }),
            )
        }

        fn spawn_vec(&self, name: &'static str, task: VecTask) -> io::Result<JoinHandle<Vec<u8>>> {
            SystemThreadSpawner.spawn_vec(name, task)
        }
    }

    fn read_message(stream: &mut UnixStream) -> guest_control_proto::RawMessage {
        let mut hdr = [0u8; 4];
        stream.read_exact(&mut hdr).unwrap();
        let body_len = u32::from_be_bytes(hdr) as usize;
        let mut body = vec![0u8; body_len];
        stream.read_exact(&mut body).unwrap();

        let mut full = Vec::with_capacity(4 + body_len);
        full.extend_from_slice(&hdr);
        full.extend_from_slice(&body);
        let mut decoder = guest_control_proto::Decoder::new();
        let mut messages = decoder.decode(&full).unwrap();
        assert_eq!(messages.len(), 1);
        messages.remove(0)
    }

    fn request(seq: u32, command: &str) -> ExecOperationWorkerRequest {
        ExecOperationWorkerRequest {
            seq,
            lifecycle: ExecOperationLifecycle::OneShot,
            role: ExecProcessRole::Workload,
            timeout: ExecOperationTimeout::Duration { timeout_ms: 0 },
            command: command.to_string(),
            env: Vec::new(),
            sudo: false,
            label: "test".to_string(),
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: Vec::new(),
            stdin_bytes: None,
            control: ExecControlPolicy::Disabled,
            exec_control_guard: None,
            exec_control_bootstrap_endpoint: None,
            guest_agent_program: GuestAgentProgram::production(),
            session_history_identity_verify_request: None,
            codex_session_cleanup_request: None,
            process_containment_mode: ProcessContainmentMode::BuildConfigured,
            drain_deadline: EXEC_OUTPUT_DRAIN_DEADLINE,
        }
    }

    fn decoded_request(
        role: ExecProcessRole,
        lifecycle: ExecLifecyclePolicy,
        control: ExecControlPolicy,
    ) -> guest_control_proto::DecodedExecStart<'static> {
        guest_control_proto::DecodedExecStart {
            lifecycle,
            role,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 1 },
            command: "true",
            env: Vec::new(),
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: Vec::new(),
            control,
            stdin_bytes: None,
        }
    }

    fn operation_guard() -> OperationGuard {
        crate::quiesce::OperationState::default().acquire().unwrap()
    }

    #[test]
    fn worker_boundary_rejects_invalid_process_contracts() {
        for decoded in [
            decoded_request(
                ExecProcessRole::Agent,
                ExecLifecyclePolicy::OneShot,
                ExecControlPolicy::Disabled,
            ),
            decoded_request(
                ExecProcessRole::Workload,
                ExecLifecyclePolicy::Supervised,
                ExecControlPolicy::Enabled {
                    control_nonce: [1; guest_control_proto::EXEC_CONTROL_NONCE_LEN],
                    sink: true,
                },
            ),
        ] {
            let error = match ExecOperationWorkerRequest::from_decoded(
                1,
                decoded,
                ProcessContainmentMode::TestNoop,
                EXEC_OUTPUT_DRAIN_DEADLINE,
                GuestAgentProgram::production(),
            ) {
                Ok(_) => panic!("worker accepted invalid process contract"),
                Err(error) => error,
            };
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn worker_boundary_rejects_role_and_control_endpoint_mismatches() {
        let mut workload = request(1, "true");
        workload.exec_control_bootstrap_endpoint = Some("endpoint".to_string());
        assert_eq!(
            workload.validate_control_attachment().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );

        let mut agent = request(2, "true");
        agent.role = ExecProcessRole::Agent;
        agent.lifecycle = ExecOperationLifecycle::Supervised;
        agent.control = ExecControlPolicy::Enabled {
            control_nonce: [2; guest_control_proto::EXEC_CONTROL_NONCE_LEN],
            sink: true,
        };
        assert_eq!(
            agent.validate_control_attachment().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    fn register_test_operation(
        registry: &ExecOperationRegistry,
        seq: u32,
        label: &str,
    ) -> Result<ExecOperationRegistration, ()> {
        registry.register(seq, label, "contained_workload", "exec")
    }

    fn assert_registry_released(registry: &ExecOperationRegistry, seq: u32) {
        let registration = register_test_operation(registry, seq, "test");
        assert!(
            registration.is_ok(),
            "exec operation registry entry for seq={seq} was not released"
        );
    }

    #[test]
    fn control_bootstrap_environment_uses_trusted_canonical_values_once() {
        let mut env = vec![
            ("FIRST_USER_KEY", "first-user-value"),
            ("SECOND_USER_KEY", "second-user-value"),
            (
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                "stale-canonical-workload-endpoint",
            ),
            (
                CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                "duplicate-canonical-workload-endpoint",
            ),
            (
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                "stale-canonical-process-control-endpoint",
            ),
            ("THIRD_USER_KEY", "third-user-value"),
            (
                process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                "duplicate-canonical-process-control-endpoint",
            ),
            (
                CANONICAL_TOOL_CGROUP_PROCS_ENV,
                "stale-canonical-tool-endpoint",
            ),
            (
                CANONICAL_TOOL_CGROUP_PROCS_ENV,
                "duplicate-canonical-tool-endpoint",
            ),
        ];

        append_exec_control_environment(
            &mut env,
            "process-control-endpoint",
            Some(("workload-endpoint", "tool-endpoint")),
        );

        assert_eq!(
            env,
            [
                ("FIRST_USER_KEY", "first-user-value"),
                ("SECOND_USER_KEY", "second-user-value"),
                ("THIRD_USER_KEY", "third-user-value"),
                (
                    process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
                    "process-control-endpoint"
                ),
                (CANONICAL_WORKLOAD_CGROUP_PROCS_ENV, "workload-endpoint"),
                (CANONICAL_TOOL_CGROUP_PROCS_ENV, "tool-endpoint"),
            ]
        );
        for canonical_key in [
            process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
            CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
            CANONICAL_TOOL_CGROUP_PROCS_ENV,
        ] {
            assert_eq!(
                env.iter().filter(|(key, _)| *key == canonical_key).count(),
                1
            );
        }
    }

    #[test]
    fn exec_termination_notable_tracks_nonzero_exit() {
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 0 },
            &[]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 1 },
            &[]
        ));
        assert!(!exec_termination_is_notable(
            ExecTermination::Exited { exit_code: 66 },
            &[66]
        ));
        assert!(exec_termination_is_notable(
            ExecTermination::TimedOut,
            &[124]
        ));
    }

    #[test]
    fn wait_outcome_selects_containment_cleanup_mode() {
        let status = Command::new("true").status().unwrap();
        assert_eq!(
            cleanup_mode_for_wait_outcome(&WaitOutcome::Exited(status), false),
            ProcessContainmentCleanupMode::Graceful
        );
        assert_eq!(
            cleanup_mode_for_wait_outcome(&WaitOutcome::TimedOut, false),
            ProcessContainmentCleanupMode::Forced
        );
        assert_eq!(
            cleanup_mode_for_wait_outcome(&WaitOutcome::Cancelled, false),
            ProcessContainmentCleanupMode::Forced
        );
        assert_eq!(
            cleanup_mode_for_wait_outcome(
                &WaitOutcome::WaitFailed("wait failed".to_string()),
                false,
            ),
            ProcessContainmentCleanupMode::Forced
        );
        let status = Command::new("true").status().unwrap();
        assert_eq!(
            cleanup_mode_for_wait_outcome(&WaitOutcome::Exited(status), true),
            ProcessContainmentCleanupMode::Forced
        );
    }

    #[test]
    fn one_shot_containment_failure_overrides_terminal_result() {
        let (termination, diagnostic) = resolve_exec_result(
            WaitOutcome::TimedOut,
            ExecOperationLifecycle::OneShot,
            Some("wait for cgroup.kill: timed out"),
        );

        assert_eq!(termination, ExecTermination::WaitFailed);
        assert!(diagnostic.contains("Failed to clean process containment"));
        assert!(diagnostic.contains("wait for cgroup.kill"));
    }

    #[test]
    fn terminal_oom_evidence_cannot_overflow_diagnostic() {
        let evidence = format!("{}{{}}", guest_contracts::oom_evidence::EVIDENCE_PREFIX);
        let diagnostic = "x".repeat(u16::MAX as usize);
        assert_eq!(
            successful_containment_evidence_diagnostic(
                ExecOperationLifecycle::Supervised,
                "guest-agent",
                ExecTermination::TimedOut,
                diagnostic.clone(),
                Some(&evidence)
            ),
            diagnostic
        );
    }

    #[test]
    fn one_shot_containment_failure_preserves_wait_diagnostic() {
        let (termination, diagnostic) = resolve_exec_result(
            WaitOutcome::WaitFailed("wait observer failed".to_string()),
            ExecOperationLifecycle::OneShot,
            Some("wait for cgroup.kill: timed out"),
        );

        assert_eq!(termination, ExecTermination::WaitFailed);
        assert!(diagnostic.contains("Failed to wait: wait observer failed"));
        assert!(diagnostic.contains("failed to clean process containment"));
        assert!(diagnostic.contains("wait for cgroup.kill"));
    }

    #[test]
    fn supervised_containment_failure_preserves_terminal_result() {
        let (termination, diagnostic) = resolve_exec_result(
            WaitOutcome::TimedOut,
            ExecOperationLifecycle::Supervised,
            Some("wait for cgroup.kill: timed out"),
        );

        assert_eq!(termination, ExecTermination::TimedOut);
        assert!(diagnostic.is_empty());
    }

    #[test]
    fn successful_exec_result_carries_containment_evidence() {
        let evidence = "exec process containment cleaned cgroup_kill_used=true";

        assert_eq!(
            successful_containment_evidence_diagnostic(
                ExecOperationLifecycle::OneShot,
                "runner-exec",
                ExecTermination::Exited { exit_code: 0 },
                String::new(),
                Some(evidence),
            ),
            evidence
        );
    }

    #[test]
    fn containment_evidence_does_not_replace_terminal_failure_diagnostic() {
        assert_eq!(
            successful_containment_evidence_diagnostic(
                ExecOperationLifecycle::OneShot,
                "runner-exec",
                ExecTermination::WaitFailed,
                "wait failed".to_owned(),
                Some("cleanup evidence"),
            ),
            "wait failed"
        );
    }

    #[test]
    fn containment_evidence_is_only_attached_to_one_shot_runner_exec_results() {
        let evidence = Some("cleanup evidence");

        assert_eq!(
            successful_containment_evidence_diagnostic(
                ExecOperationLifecycle::Supervised,
                "runner-exec",
                ExecTermination::Exited { exit_code: 0 },
                String::new(),
                evidence,
            ),
            ""
        );
        assert_eq!(
            successful_containment_evidence_diagnostic(
                ExecOperationLifecycle::OneShot,
                "benchmark-exec",
                ExecTermination::Exited { exit_code: 0 },
                String::new(),
                evidence,
            ),
            ""
        );
    }

    #[test]
    fn exec_terminal_log_message_marks_slow_only_result_as_latency_only() {
        let stdout = BoundedDrainResult::default();
        let stderr = BoundedDrainResult::default();

        for (lifecycle, operation_kind) in [
            (ExecLifecyclePolicy::OneShot, "exec"),
            (ExecLifecyclePolicy::Supervised, "start_process"),
        ] {
            let request = ExecOperationWorkerRequest::from_decoded(
                7,
                decoded_request(
                    ExecProcessRole::Workload,
                    lifecycle,
                    ExecControlPolicy::Disabled,
                ),
                ProcessContainmentMode::TestNoop,
                EXEC_OUTPUT_DRAIN_DEADLINE,
                GuestAgentProgram::production(),
            )
            .unwrap();
            let message = exec_terminal_log_message(ExecTerminalLogMessageInput {
                request: &request,
                elapsed_ms: 6000,
                termination: ExecTermination::Exited { exit_code: 0 },
                stdout_result: &stdout,
                stderr_result: &stderr,
                diagnostic_present: false,
                oom_evidence: false,
                oom_evidence_proof: false,
                slow: true,
                notable: false,
            })
            .unwrap();

            assert!(message.contains("seq=7"), "message={message}");
            assert!(message.contains("label=test"), "message={message}");
            assert!(
                message.contains("process_class=contained_workload "),
                "message={message}"
            );
            assert!(
                message.contains(&format!("operation_kind={operation_kind} ")),
                "message={message}"
            );
            assert!(message.contains("slow=true"), "message={message}");
            assert!(message.contains("notable=false"), "message={message}");
            assert!(
                message.contains("terminal_reason=slow"),
                "message={message}"
            );
            assert!(
                message.contains("diagnostic_present=false"),
                "message={message}"
            );
        }
    }

    #[test]
    fn exec_terminal_log_message_marks_notable_result() {
        let request = request(8, "false");
        let stdout = BoundedDrainResult::default();
        let stderr = BoundedDrainResult {
            captured: Some(b"stderr".to_vec()),
            capture_truncated: true,
            stream_truncated: false,
        };

        let message = exec_terminal_log_message(ExecTerminalLogMessageInput {
            request: &request,
            elapsed_ms: 10,
            termination: ExecTermination::Exited { exit_code: 1 },
            stdout_result: &stdout,
            stderr_result: &stderr,
            diagnostic_present: true,
            oom_evidence: false,
            oom_evidence_proof: false,
            slow: false,
            notable: true,
        })
        .unwrap();

        assert!(message.contains("slow=false"), "message={message}");
        assert!(message.contains("notable=true"), "message={message}");
        assert!(
            message.contains("terminal_reason=notable"),
            "message={message}"
        );
        assert!(
            message.contains("stderr_truncated=true"),
            "message={message}"
        );
        assert!(
            message.contains("diagnostic_present=true"),
            "message={message}"
        );
    }

    #[test]
    fn exec_terminal_log_message_suppresses_fast_clean_result() {
        let request = request(9, "true");
        let stdout = BoundedDrainResult::default();
        let stderr = BoundedDrainResult::default();

        assert!(
            exec_terminal_log_message(ExecTerminalLogMessageInput {
                request: &request,
                elapsed_ms: 10,
                termination: ExecTermination::Exited { exit_code: 0 },
                stdout_result: &stdout,
                stderr_result: &stderr,
                diagnostic_present: false,
                oom_evidence: false,
                oom_evidence_proof: false,
                slow: false,
                notable: false,
            })
            .is_none()
        );
    }

    #[test]
    fn exec_terminal_log_message_separates_oom_metadata_from_diagnostics() {
        let request = request(10, "true");
        let stdout = BoundedDrainResult::default();
        let stderr = BoundedDrainResult::default();
        let evidence: guest_contracts::oom_evidence::OomEvidence = serde_json::from_str(
            include_str!("../../guest-contracts/tests/fixtures/oom-evidence-v1.json"),
        )
        .unwrap();
        let evidence_line = |evidence: &guest_contracts::oom_evidence::OomEvidence| {
            format!(
                "{}{}",
                guest_contracts::oom_evidence::EVIDENCE_PREFIX,
                serde_json::to_string(evidence).unwrap()
            )
        };
        let message_for = |diagnostic: &str| {
            exec_terminal_log_message_for_diagnostic(
                &request,
                Duration::from_millis(10),
                ExecTermination::Exited { exit_code: 0 },
                &stdout,
                &stderr,
                diagnostic,
            )
        };

        let proof_message = message_for(&evidence_line(&evidence)).unwrap();
        assert!(
            proof_message.contains("terminal_reason=oom_evidence"),
            "message={proof_message}"
        );
        assert!(proof_message.contains("diagnostic_present=false"));
        assert!(proof_message.contains("oom_evidence=true"));
        assert!(proof_message.contains("oom_evidence_proof=true"));
        assert!(!proof_message.contains("OKOU_OOM_EVIDENCE_V1"));

        let mut candidate = evidence.clone();
        for incident in &mut candidate.incidents {
            incident.kernel_events.clear();
            for group in &mut incident.groups {
                group.delta = guest_contracts::oom_evidence::MemoryEvents::default();
                group.local_delta = guest_contracts::oom_evidence::MemoryEvents::default();
            }
        }
        assert!(
            message_for(&evidence_line(&candidate)).is_none(),
            "an inspected-empty candidate is not a terminal warning"
        );

        let diagnostic_message = message_for(&format!(
            "Failed to wait: no child processes\n{}",
            evidence_line(&candidate)
        ))
        .unwrap();
        assert!(diagnostic_message.contains("terminal_reason=notable"));
        assert!(diagnostic_message.contains("diagnostic_present=true"));

        let malformed_message = message_for(&format!(
            "{}not json",
            guest_contracts::oom_evidence::EVIDENCE_PREFIX
        ))
        .unwrap();
        assert!(malformed_message.contains("terminal_reason=notable"));
        assert!(malformed_message.contains("diagnostic_present=false"));
        assert!(malformed_message.contains("oom_evidence=false"));
    }

    #[test]
    fn registry_rejects_duplicate_active_sequence_and_cleans_on_drop() {
        let registry = ExecOperationRegistry::default();
        let first = register_test_operation(&registry, 7, "first").unwrap();
        assert!(register_test_operation(&registry, 7, "duplicate").is_err());
        drop(first);
        assert!(register_test_operation(&registry, 7, "second").is_ok());
    }

    #[test]
    fn registry_cancel_sets_token_and_unknown_cancel_is_noop() {
        let registry = ExecOperationRegistry::default();
        let registration = register_test_operation(&registry, 8, "cancel-me").unwrap();
        assert_eq!(
            registry.cancel(8),
            Some(("cancel-me".to_string(), "contained_workload", "exec"))
        );
        assert!(registration.cancel.load(Ordering::Acquire));
        assert!(registry.cancel(9).is_none());
    }

    #[test]
    fn registry_cancel_returns_truncated_label_preview() {
        let registry = ExecOperationRegistry::default();
        let long_label = format!("{}🔥tail", "a".repeat(99));
        let registration = register_test_operation(&registry, 10, &long_label).unwrap();

        let (preview, process_class, operation_kind) = registry.cancel(10).unwrap();
        assert_eq!(preview, truncate_command_preview(&long_label));
        assert_eq!(process_class, "contained_workload");
        assert_eq!(operation_kind, "exec");
        assert!(preview.ends_with("..."));
        assert!(preview.len() < long_label.len());
        assert!(!preview.contains('🔥'));
        assert!(registration.cancel.load(Ordering::Acquire));
    }

    #[test]
    fn exec_operation_worker_spawn_failure_returns_start_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(42, "echo should-not-run"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_WORKER),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 42);
        let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::StartFailed);
        assert!(result.diagnostic.contains("exec operation worker thread"));
        assert_registry_released(&registry, 42);
    }

    #[test]
    fn duplicate_active_exec_operation_returns_error() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let _registration = register_test_operation(&registry, 11, "duplicate").unwrap();

        start_exec_operation_with_spawner(
            request(11, "echo duplicate"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry,
            SystemThreadSpawner,
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_ERROR);
        let error = guest_control_proto::decode_error(&msg.payload).unwrap();
        assert!(error.contains("already active"));
    }

    #[test]
    fn supervised_exec_started_send_failure_releases_without_result() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        guest.shutdown(Shutdown::Write).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let mut request = request(47, "sleep 60");
        request.lifecycle = ExecOperationLifecycle::Supervised;
        let registration = register_test_operation(&registry, request.seq, &request.label).unwrap();
        let exec_cancel = registration.cancel_token();

        run_exec_operation_worker(
            request,
            writer,
            Arc::new(AtomicBool::new(false)),
            exec_cancel,
            registration,
            operation_guard(),
            SystemThreadSpawner,
        );

        assert_registry_released(&registry, 47);
        let mut bytes = Vec::new();
        host.read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
    }

    #[test]
    fn stdout_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(43, "sleep 60"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDOUT),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 43);
        let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stdout drain thread"));
        assert_registry_released(&registry, 43);
    }

    #[test]
    fn stdin_writer_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let mut request = request(46, "sleep 60");
        request.stdin_bytes = Some(b"stdin".to_vec());

        start_exec_operation_with_spawner(
            request,
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDIN),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 46);
        let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stdin writer thread"));
        assert_registry_released(&registry, 46);
    }

    #[test]
    fn stdin_writer_cancel_unblocks_full_pipe() {
        // The exec protocol cannot synchronize on this private worker's final
        // pre-poll check, and child cleanup can independently release stdin.
        // Keep the actual writer, full pipe, poll, and cancellation wakeup here.
        let mut fds = [0; 2];
        // SAFETY: `pipe` initializes two file descriptors in `fds` on success.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY: both descriptors were freshly returned by `pipe`.
        let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        // SAFETY: both descriptors were freshly returned by `pipe`.
        let mut write_file = unsafe { File::from_raw_fd(fds[1]) };
        set_nonblocking(write_file.as_raw_fd()).unwrap();

        let fill = [0u8; 4096];
        loop {
            match write_file.write(&fill) {
                Ok(0) => panic!("pipe write returned zero while filling"),
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("failed to fill pipe: {e}"),
            }
        }

        let (ready_tx, ready_rx) = mpsc::channel();
        let writer = spawn_exec_operation_stdin(
            write_file,
            b"blocked".to_vec(),
            StdinPollReadySpawner { ready: ready_tx },
        )
        .unwrap();
        let ready = ready_rx.recv_timeout(Duration::from_secs(5));
        request_stdin_writer_cancel(&writer);
        let completed = writer.done_rx.recv_timeout(Duration::from_secs(5));
        let result = writer.result_rx.try_recv();

        // Record completion while the peer is still open and undrained. Release
        // it and join before asserting, including readiness and wakeup failures.
        drop(read_fd);
        join_stdin_writer(writer, 0, "");
        ready.expect("stdin writer did not reach its blocking poll");
        completed.expect("stdin writer cancel did not wake blocked writer");
        assert!(is_stdin_write_cancelled(&result.unwrap().unwrap_err()));
    }

    #[test]
    fn write_stdin_rejects_pre_cancelled_input() {
        let mut stdin = tempfile::tempfile().unwrap();
        let (cancel_reader, _cancel_writer) = stdin_cancel_pipe().unwrap();
        let cancel = AtomicBool::new(true);

        let result =
            write_stdin_cancellable(&mut stdin, b"input", &cancel, cancel_reader.as_raw_fd());

        assert!(is_stdin_write_cancelled(&result.unwrap_err()));
        assert_eq!(stdin.metadata().unwrap().len(), 0);
    }

    #[test]
    fn stdin_cancel_pipe_is_nonblocking_and_close_on_exec() {
        let (read_fd, write_fd) = stdin_cancel_pipe().unwrap();

        for fd in [read_fd.as_raw_fd(), write_fd.as_raw_fd()] {
            // SAFETY: fd is open for the duration of this assertion.
            let status_flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert!(status_flags >= 0);
            assert_ne!(status_flags & libc::O_NONBLOCK, 0);

            // SAFETY: fd is open for the duration of this assertion.
            let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(descriptor_flags >= 0);
            assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        }
    }

    #[test]
    fn stderr_drain_spawn_failure_returns_wait_failed_and_cleans_registry() {
        let (guest, mut host) = UnixStream::pair().unwrap();
        host.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();

        start_exec_operation_with_spawner(
            request(45, "sleep 60"),
            operation_guard(),
            writer,
            Arc::new(AtomicBool::new(false)),
            registry.clone(),
            FailingThreadSpawner::fail_once(THREAD_EXEC_OPERATION_STDERR),
        )
        .unwrap();

        let msg = read_message(&mut host);
        assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
        assert_eq!(msg.seq, 45);
        let result = guest_control_proto::decode_exec_result(&msg.payload).unwrap();
        assert_eq!(result.termination, ExecTermination::WaitFailed);
        assert!(result.diagnostic.contains("stderr drain thread"));
        assert_registry_released(&registry, 45);
    }

    #[test]
    fn stream_write_failure_cleans_registry() {
        let (guest, host) = UnixStream::pair().unwrap();
        drop(host);
        let writer = GuestWriter::new(guest);
        let registry = ExecOperationRegistry::default();
        let mut request = request(44, "printf output");
        request.stdout = ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        };
        let seq = request.seq;
        let registration = register_test_operation(&registry, request.seq, &request.label).unwrap();
        let exec_cancel = registration.cancel_token();

        run_exec_operation_worker(
            request,
            writer,
            Arc::new(AtomicBool::new(false)),
            exec_cancel.clone(),
            registration,
            operation_guard(),
            SystemThreadSpawner,
        );

        assert!(exec_cancel.load(Ordering::Acquire));
        assert_registry_released(&registry, seq);
    }
}
