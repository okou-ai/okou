use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use guest_contracts::home_mount::{HOME_DRIVE_MOUNT_TIMEOUT_MS, HOME_MOUNT_PATH};
use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES,
};

use crate::drain::{BoundedDrainResult, DrainCancellation, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
pub(crate) use crate::worker_ownership::LazyConnectionWorkerSubmitError as HomeDriveMountSubmitError;
use crate::worker_ownership::{LazyConnectionWorker, SingleActivePermit};
use crate::writer::GuestWriter;

const THREAD_WORKER: &str = "gctl-mount";
const THREAD_STDOUT: &str = "gctl-mount-out";
const THREAD_STDERR: &str = "gctl-mount-err";
const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

#[derive(Clone)]
pub(crate) enum HomeDriveMountProgram {
    Production,
    Test { path: PathBuf, timeout_ms: u32 },
}

impl HomeDriveMountProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf, timeout_ms: u32) -> Self {
        Self::Test { path, timeout_ms }
    }

    fn timeout_ms(&self) -> u32 {
        match self {
            Self::Production => HOME_DRIVE_MOUNT_TIMEOUT_MS,
            Self::Test { timeout_ms, .. } => *timeout_ms,
        }
    }

    fn spawn(&self) -> io::Result<Child> {
        // This fixed-layout typed operation fixes every execution choice. An owned
        // process group keeps timeout, disconnect, and pre-reap descendant
        // cleanup without creating a generic workload cgroup for each mount.
        let mut command = match self {
            Self::Production => Command::new(HOME_MOUNT_PATH),
            Self::Test { path, .. } => Command::new(path),
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::user::apply_command_identity(&mut command, true)?;
        spawn_in_own_process_group(&mut command)
    }
}

struct HomeDriveMountRequest {
    seq: u32,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

#[derive(Clone)]
struct HomeDriveMountWorkerContext {
    program: HomeDriveMountProgram,
    drain_deadline: Duration,
}

pub(crate) struct HomeDriveMountWorker {
    inner: LazyConnectionWorker<HomeDriveMountRequest, HomeDriveMountWorkerContext>,
}

impl HomeDriveMountWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: HomeDriveMountProgram,
        drain_deadline: Duration,
    ) -> Self {
        Self {
            inner: LazyConnectionWorker::new(
                writer,
                connection_cancel,
                HomeDriveMountWorkerContext {
                    program,
                    drain_deadline,
                },
                handle_worker_request,
                THREAD_WORKER,
                "home drive mount worker",
            ),
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.inner.try_admit()
    }

    pub(crate) fn submit(
        &self,
        seq: u32,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), HomeDriveMountSubmitError> {
        self.inner.try_submit_with(move || HomeDriveMountRequest {
            seq,
            operation_guard,
            admission,
        })
    }
}

struct HomeDriveMountOutput {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: BoundedDrainResult,
    stderr: BoundedDrainResult,
    diagnostic: String,
}

fn handle_worker_request(
    request: HomeDriveMountRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    context: &HomeDriveMountWorkerContext,
) -> io::Result<()> {
    handle_request(
        request,
        writer,
        connection_cancel,
        &context.program,
        context.drain_deadline,
    )
}

fn handle_request(
    request: HomeDriveMountRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &HomeDriveMountProgram,
    drain_deadline: Duration,
) -> io::Result<()> {
    let HomeDriveMountRequest {
        seq,
        operation_guard,
        admission,
    } = request;
    let output = run_mount(RunMountInput {
        program,
        connection_cancel,
        drain_deadline,
    });
    let mut frame = Vec::new();
    guest_control_proto::encode_home_drive_mount_result_frame_into(
        &mut frame,
        seq,
        output.termination,
        output.duration_ms,
        captured_output(&output.stdout),
        captured_output(&output.stderr),
        &output.diagnostic,
    )
    .map_err(to_io_error)?;

    writer
        .write_frame_after_lock_unless_cancelled(&frame, connection_cancel, || {
            operation_guard.release();
            drop(admission);
        })
        .map(|_| ())
}

struct RunMountInput<'a> {
    program: &'a HomeDriveMountProgram,
    connection_cancel: &'a AtomicBool,
    drain_deadline: Duration,
}

fn run_mount(input: RunMountInput<'_>) -> HomeDriveMountOutput {
    let RunMountInput {
        program,
        connection_cancel,
        drain_deadline,
    } = input;
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize home mount output drain cancellation: {error}"),
            );
        }
    };
    let mut child = match program.spawn() {
        Ok(spawned) => spawned,
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to start home mount helper: {error}"),
            );
        }
    };
    let Some(stdout) = child.stdout.take() else {
        return abort_spawned(child, started, "home mount helper stdout pipe missing");
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdout);
        return abort_spawned(child, started, "home mount helper stderr pipe missing");
    };

    let (drain_done_tx, drain_done_rx) = mpsc::channel();
    let stdout_drain = match spawn_drain(
        stdout,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDOUT,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drop(stderr);
            kill_and_reap_child(child);
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("Failed to start home mount stdout drain: {error}"),
            );
        }
    };
    let stderr_drain = match spawn_drain(
        stderr,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDERR,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drain_cancel.cancel();
            kill_and_reap_child(child);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("Failed to start home mount stderr drain: {error}"),
            );
        }
    };
    drop(drain_done_tx);

    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        program.timeout_ms(),
        connection_cancel,
        || true,
    );
    let cancellation_observed = connection_cancel.load(Ordering::Acquire);
    if !matches!(outcome, WaitOutcome::Exited(_)) || cancellation_observed {
        drain_cancel.cancel();
    }
    let completed = await_drain_deadline(&drain_done_rx, 2, &drain_cancel, drain_deadline);
    let stdout_result = stdout_drain.join();
    let stderr_result = stderr_drain.join();
    let drains_incomplete = completed < 2 || stdout_result.is_err() || stderr_result.is_err();
    let mut stdout = stdout_result.unwrap_or_default();
    let mut stderr = stderr_result.unwrap_or_default();
    if drains_incomplete {
        stdout.capture_truncated = true;
        stderr.capture_truncated = true;
    }
    if stdout.captured.is_none() {
        stdout.captured = Some(Vec::new());
    }
    if stderr.captured.is_none() {
        stderr.captured = Some(Vec::new());
    }

    let (termination, diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            ExecTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            String::new(),
        ),
        WaitOutcome::TimedOut => (ExecTermination::TimedOut, String::new()),
        WaitOutcome::Cancelled => (ExecTermination::Cancelled, String::new()),
        WaitOutcome::WaitFailed(message) => (
            ExecTermination::WaitFailed,
            format!("Failed to wait for home mount helper: {message}"),
        ),
    };
    HomeDriveMountOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout,
        stderr,
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn abort_spawned(child: Child, started: Instant, diagnostic: &str) -> HomeDriveMountOutput {
    kill_and_reap_child(child);
    failed_output(ExecTermination::WaitFailed, started, diagnostic.to_string())
}

struct DrainHandle {
    handle: JoinHandle<()>,
    result_rx: mpsc::Receiver<BoundedDrainResult>,
}

impl DrainHandle {
    fn join(self) -> Result<BoundedDrainResult, ()> {
        if self.handle.join().is_err() {
            return Err(());
        }
        self.result_rx.recv().map_err(|_| ())
    }
}

fn spawn_drain(
    pipe: impl Into<std::os::fd::OwnedFd> + Send + 'static,
    cancel: Arc<DrainCancellation>,
    done_tx: mpsc::Sender<()>,
    thread_name: &'static str,
) -> io::Result<DrainHandle> {
    let (result_tx, result_rx) = mpsc::channel();
    let handle = thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let result = drain_bounded_cancellable(
                pipe,
                &cancel,
                Some(HOME_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES),
                None,
                |_, _| true,
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        })?;
    Ok(DrainHandle { handle, result_rx })
}

fn failed_output(
    termination: ExecTermination,
    started: Instant,
    diagnostic: String,
) -> HomeDriveMountOutput {
    HomeDriveMountOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout: BoundedDrainResult {
            captured: Some(Vec::new()),
            capture_truncated: false,
            stream_truncated: false,
        },
        stderr: BoundedDrainResult {
            captured: Some(Vec::new()),
            capture_truncated: false,
            stream_truncated: false,
        },
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn captured_output(result: &BoundedDrainResult) -> ExecCapturedOutput<'_> {
    ExecCapturedOutput::Captured {
        bytes: result.captured.as_deref().unwrap_or_default(),
        truncated: result.capture_truncated,
    }
}

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn truncate_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}
