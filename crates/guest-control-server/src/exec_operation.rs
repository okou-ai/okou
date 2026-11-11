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
use std::io;
#[cfg(all(test, target_os = "linux"))]
use std::os::fd::OwnedFd;
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

use crate::agent_command::{GuestAgentProgram, spawn_agent_command_with_pipes};
use crate::drain::{BoundedDrainResult, DrainCancellation};
use crate::error::to_io_error;
use crate::exec_control::ExecControlGuard;
use crate::helper_output::captured_or_discarded;
use crate::log::log;
use crate::process::kill_and_reap_child;
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

mod output;
mod stdin;
mod terminal_log;

use output::{
    DrainWorker, ExecResultFrame, ExecStreamWriter, SharedExecStreamWriter,
    emit_exec_stream_truncation_markers, empty_output_for_policy, finalize_exec_drain_result,
    output_settings, send_exec_result_after_lock, spawn_exec_operation_drain,
    validate_output_policies,
};
#[cfg(test)]
use output::{THREAD_EXEC_OPERATION_STDERR, THREAD_EXEC_OPERATION_STDOUT};
use stdin::StdinWriter;
use terminal_log::log_exec_terminal_if_notable;
#[cfg(test)]
use terminal_log::{
    ExecTerminalLogMessageInput, exec_terminal_log_message,
    exec_terminal_log_message_for_diagnostic, exec_termination_is_notable,
};

const THREAD_EXEC_OPERATION_WORKER: &str = "gctl-exec";
const THREAD_EXEC_OPERATION_STDIN: &str = "gctl-exec-in";
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

enum ExecOperationProcess {
    Workload,
    Agent,
}

impl ExecOperationProcess {
    fn role(&self) -> ExecProcessRole {
        match self {
            Self::Workload => ExecProcessRole::Workload,
            Self::Agent => ExecProcessRole::Agent,
        }
    }
}

pub(crate) struct ExecOperationWorkerRequest {
    seq: u32,
    lifecycle: ExecOperationLifecycle,
    process: ExecOperationProcess,
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
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

impl ExecOperationWorkerRequest {
    fn process_class(&self) -> &'static str {
        self.process.role().process_class()
    }

    fn operation_kind(&self) -> &'static str {
        let lifecycle = match self.lifecycle {
            ExecOperationLifecycle::OneShot => ExecLifecyclePolicy::OneShot,
            ExecOperationLifecycle::Supervised => ExecLifecyclePolicy::Supervised,
        };
        self.process.role().operation_kind(lifecycle)
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
        let process = match decoded.role {
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
                ExecOperationProcess::Agent
            }
            ExecProcessRole::Workload => ExecOperationProcess::Workload,
        };

        Ok(Self {
            seq,
            lifecycle,
            process,
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
        match (
            self.process.role(),
            self.exec_control_bootstrap_endpoint.is_some(),
        ) {
            (ExecProcessRole::Workload, false) | (ExecProcessRole::Agent, true) => Ok(()),
            (ExecProcessRole::Workload, true) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workload process received an Agent control bootstrap endpoint",
            )),
            (ExecProcessRole::Agent, false) => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Agent process did not receive a control bootstrap endpoint",
            )),
        }
    }
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
        stdout_handle: JoinHandle<BoundedDrainResult>,
    ) -> ExecSetupWithStdout {
        ExecSetupWithStdout {
            setup: self,
            stdout_handle,
        }
    }

    fn abort_wait_failed(
        self,
        exec_cancel: &AtomicBool,
        completion: &ExecCompletion<'_>,
        diagnostic: &str,
    ) {
        self.abort_wait_failed_with_stdout(exec_cancel, completion, diagnostic, None);
    }

    fn abort_wait_failed_with_stdout(
        self,
        exec_cancel: &AtomicBool,
        completion: &ExecCompletion<'_>,
        diagnostic: &str,
        stdout_handle: Option<JoinHandle<BoundedDrainResult>>,
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
        let containment_result = cleanup_process_containment(
            process_containment,
            ProcessContainmentCleanupMode::Forced,
            false,
        );
        if let Some(writer) = stdin_writer {
            writer.join_after_kill();
        }
        if let Some(stdout_handle) = stdout_handle {
            let _ = stdout_handle.join();
        }
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
        let _ = cleanup_process_containment(
            process_containment,
            ProcessContainmentCleanupMode::Forced,
            false,
        );
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
    stdout_handle: JoinHandle<BoundedDrainResult>,
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
        } = self;
        setup.abort_wait_failed_with_stdout(
            exec_cancel,
            completion,
            diagnostic,
            Some(stdout_handle),
        );
    }

    fn into_running(
        self,
        stderr_handle: JoinHandle<BoundedDrainResult>,
        stream_writer: Option<SharedExecStreamWriter>,
    ) -> RunningExec {
        let ExecSetupWithStdout {
            setup,
            stdout_handle,
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
            stderr_handle,
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
    stdout_handle: JoinHandle<BoundedDrainResult>,
    stderr_handle: JoinHandle<BoundedDrainResult>,
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
            stderr_handle,
            stream_writer,
            drain_cancel,
            drain_done_rx,
        } = self;

        let prepare_for_pre_reap = || {
            stdin_writer
                .as_ref()
                .is_some_and(StdinWriter::cancel_if_running)
        };
        let outcome = wait_with_kill_timeout_or_cancelled_either(
            child,
            request.timeout.wait_timeout_ms(),
            connection_cancel,
            exec_cancel,
            prepare_for_pre_reap,
        );
        if let Some(writer) = stdin_writer.as_ref() {
            writer.cancel_if_running();
        }
        let cancellation_observed =
            connection_cancel.load(Ordering::Acquire) || exec_cancel.load(Ordering::Acquire);
        let cleanup_mode =
            ProcessContainmentCleanupMode::for_wait_outcome(&outcome, cancellation_observed);
        drop(placement_bootstrap);
        if !matches!(&outcome, WaitOutcome::Exited(status) if status.success()) {
            process_containment.capture_error();
        }
        let process_completed = !cancellation_observed
            && startup_failure.is_none()
            && matches!(&outcome, WaitOutcome::Exited(status) if status.success());
        let containment_result =
            cleanup_process_containment(process_containment, cleanup_mode, process_completed);
        if let Some(writer) = stdin_writer {
            writer.join_after_wait(request.seq, &request.label);
        }
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

        let stdout_result = stdout_handle.join();
        let stderr_result = stderr_handle.join();
        let drains_incomplete = completed < 2 || stdout_result.is_err() || stderr_result.is_err();
        let stdout_settings = output_settings(request.stdout);
        let stderr_settings = output_settings(request.stderr);
        let stdout_result =
            finalize_exec_drain_result(stdout_result.ok(), stdout_settings, drains_incomplete);
        let stderr_result =
            finalize_exec_drain_result(stderr_result.ok(), stderr_settings, drains_incomplete);
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
            captured_or_discarded(&stdout_result),
            captured_or_discarded(&stderr_result),
            &diagnostic,
        );
    }
}

fn resolve_exec_result(
    outcome: WaitOutcome,
    lifecycle: ExecOperationLifecycle,
    containment_error: Option<&str>,
) -> (ExecTermination, String) {
    let (termination, diagnostic) = outcome.into_exec_result("Failed to wait");
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
    process_completed: bool,
) -> Result<Option<String>, ProcessContainmentError> {
    process_containment.cleanup_with_evidence(mode, process_completed)
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
    let result = spawner.spawn(
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
    if let Err(diagnostic) = validate_output_policies(request.stdout, request.stderr) {
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
        request.process.role(),
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
    let spawn_result = match &request.process {
        ExecOperationProcess::Workload => spawn_shell_command_with_pipes(
            &request.command,
            effective_env,
            request.sudo,
            pipe_stdin,
            process_containment,
        ),
        ExecOperationProcess::Agent => spawn_agent_command_with_pipes(
            effective_env,
            process_containment,
            &request.guest_agent_program,
        ),
    };
    let spawned = match spawn_result {
        Ok(spawned) => spawned,
        Err(e) => {
            let diagnostic = match request.process.role() {
                ExecProcessRole::Workload => format!(
                    "Failed to execute: {e} ({})",
                    format_env_diagnostics(&request.command, &env_refs)
                ),
                ExecProcessRole::Agent => format!("Failed to execute controlled Agent: {e}"),
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
        match StdinWriter::spawn(stdin, stdin_bytes, spawner.clone()) {
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
        Ok(stdout_handle) => setup.into_stdout_started(stdout_handle),
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
        Ok(stderr_handle) => setup.into_running(stderr_handle, stream_writer),
        Err(e) => {
            setup.abort_wait_failed(
                &exec_cancel,
                &completion,
                &format!("failed to spawn stderr drain thread: {e}"),
            );
            return;
        }
    };

    if request.process.role() == ExecProcessRole::Agent {
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

#[cfg(test)]
mod tests;
