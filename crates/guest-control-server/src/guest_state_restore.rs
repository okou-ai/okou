use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES,
    GuestStateRestoreTimezone,
};

use crate::drain::{BoundedDrainHandle, BoundedDrainResult, DrainCancellation};
use crate::error::to_io_error;
use crate::helper_input::FixedInputWriter;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
pub(crate) use crate::worker_ownership::LazyConnectionWorkerSubmitError as GuestStateRestoreSubmitError;
use crate::worker_ownership::{LazyConnectionWorker, SingleActivePermit};
use crate::writer::GuestWriter;

const THREAD_WORKER: &str = "gctl-state";
const THREAD_STDIN: &str = "gctl-state-in";
const THREAD_STDERR: &str = "gctl-state-err";
const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

#[derive(Clone)]
pub(crate) enum GuestStateRestoreProgram {
    Production,
    Test(PathBuf),
}

impl GuestStateRestoreProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(guest_contracts::guest_binary::STATE_RESTORE_PATH),
            Self::Test(path) => path,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OwnedTimezone {
    None,
    BestEffort(String),
    Required(String),
}

impl OwnedTimezone {
    fn from_borrowed(timezone: GuestStateRestoreTimezone<'_>) -> Self {
        match timezone {
            GuestStateRestoreTimezone::None => Self::None,
            GuestStateRestoreTimezone::BestEffort(name) => Self::BestEffort(name.to_owned()),
            GuestStateRestoreTimezone::Required(name) => Self::Required(name.to_owned()),
        }
    }

    fn append_args(&self, command: &mut Command) {
        match self {
            Self::None => {
                command.arg("none");
            }
            Self::BestEffort(name) => {
                command.arg("best-effort").arg(name);
            }
            Self::Required(name) => {
                command.arg("required").arg(name);
            }
        }
    }
}

struct GuestStateRestoreRequest {
    seq: u32,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: Vec<u8>,
    timezone: OwnedTimezone,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

#[derive(Clone)]
struct GuestStateRestoreWorkerContext {
    program: GuestStateRestoreProgram,
    drain_deadline: Duration,
}

pub(crate) struct GuestStateRestoreWorker {
    inner: LazyConnectionWorker<GuestStateRestoreRequest, GuestStateRestoreWorkerContext>,
}

impl GuestStateRestoreWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: GuestStateRestoreProgram,
        drain_deadline: Duration,
    ) -> Self {
        Self {
            inner: LazyConnectionWorker::new(
                writer,
                connection_cancel,
                GuestStateRestoreWorkerContext {
                    program,
                    drain_deadline,
                },
                handle_worker_request,
                THREAD_WORKER,
                "guest state restore worker",
            ),
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.inner.try_admit()
    }

    pub(crate) fn submit(
        &self,
        submission: GuestStateRestoreSubmission<'_>,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), GuestStateRestoreSubmitError> {
        self.inner
            .try_submit_with(move || GuestStateRestoreRequest {
                seq: submission.seq,
                timeout_ms: submission.timeout_ms,
                unix_seconds: submission.unix_seconds,
                unix_nanoseconds: submission.unix_nanoseconds,
                entropy: submission.entropy.to_vec(),
                timezone: OwnedTimezone::from_borrowed(submission.timezone),
                operation_guard,
                admission,
            })
    }
}

pub(crate) struct GuestStateRestoreSubmission<'a> {
    pub(crate) seq: u32,
    pub(crate) timeout_ms: u32,
    pub(crate) unix_seconds: u64,
    pub(crate) unix_nanoseconds: u32,
    pub(crate) entropy: &'a [u8],
    pub(crate) timezone: GuestStateRestoreTimezone<'a>,
}

struct GuestStateRestoreOutput {
    termination: ExecTermination,
    duration_ms: u32,
    stderr: BoundedDrainResult,
    diagnostic: String,
}

fn handle_worker_request(
    request: GuestStateRestoreRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    context: &GuestStateRestoreWorkerContext,
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
    request: GuestStateRestoreRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestStateRestoreProgram,
    drain_deadline: Duration,
) -> io::Result<()> {
    let GuestStateRestoreRequest {
        seq,
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
        operation_guard,
        admission,
    } = request;
    let output = run_restore(RunRestoreInput {
        program: program.path(),
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
        connection_cancel,
        drain_deadline,
    });
    let stderr = captured_output(&output.stderr);
    let mut frame = Vec::new();
    guest_control_proto::encode_guest_state_restore_result_frame_into(
        &mut frame,
        seq,
        output.termination,
        output.duration_ms,
        stderr,
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

struct RunRestoreInput<'a> {
    program: &'a Path,
    timeout_ms: u32,
    unix_seconds: u64,
    unix_nanoseconds: u32,
    entropy: Vec<u8>,
    timezone: OwnedTimezone,
    connection_cancel: &'a AtomicBool,
    drain_deadline: Duration,
}

fn run_restore(input: RunRestoreInput<'_>) -> GuestStateRestoreOutput {
    let RunRestoreInput {
        program,
        timeout_ms,
        unix_seconds,
        unix_nanoseconds,
        entropy,
        timezone,
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
                format!("failed to initialize guest state stderr cancellation: {error}"),
            );
        }
    };
    let mut command = Command::new(program);
    // This is a bundled fixed-purpose root helper, not caller-supplied
    // workload. A dedicated process group preserves timeout, disconnect, and
    // descendant cleanup without paying generic workload-cgroup setup on every
    // sandbox restore.
    command
        .arg("--restore-state")
        .arg(unix_seconds.to_string())
        .arg(unix_nanoseconds.to_string());
    timezone.append_args(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Err(error) = crate::user::apply_command_identity(&mut command, true) {
        return failed_output(
            ExecTermination::StartFailed,
            started,
            format!("failed to select root identity for guest state helper: {error}"),
        );
    }
    let mut child = match spawn_in_own_process_group(&mut command) {
        Ok(child) => child,
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("failed to start guest state helper: {error}"),
            );
        }
    };

    let Some(stdin) = child.stdin.take() else {
        return abort_spawned(child, started, "guest state helper stdin pipe missing");
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdin);
        return abort_spawned(child, started, "guest state helper stderr pipe missing");
    };

    let (drain_done_tx, drain_done_rx) = mpsc::channel();
    let stderr_drain = match BoundedDrainHandle::spawn(
        stderr,
        GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES,
        Arc::clone(&drain_cancel),
        drain_done_tx,
        THREAD_STDERR,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drop(stdin);
            kill_and_reap_child(child);
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("failed to start guest state stderr drain: {error}"),
            );
        }
    };
    let stdin_writer = match FixedInputWriter::spawn(stdin, entropy, THREAD_STDIN) {
        Ok(writer) => writer,
        Err(error) => {
            drain_cancel.cancel();
            kill_and_reap_child(child);
            let _ = stderr_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                format!("failed to start guest state stdin writer: {error}"),
            );
        }
    };

    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        timeout_ms,
        connection_cancel,
        // Reap the full group before an exited leader can release its process
        // group identity, so helper descendants cannot outlive restore.
        || true,
    );
    let cancellation_observed = connection_cancel.load(Ordering::Acquire);
    let stdin_result = stdin_writer.join();
    if !matches!(outcome, WaitOutcome::Exited(_)) || cancellation_observed {
        drain_cancel.cancel();
    }
    let completed = await_drain_deadline(&drain_done_rx, 1, &drain_cancel, drain_deadline);
    let stderr_result = stderr_drain.join();
    let drains_incomplete = completed < 1 || stderr_result.is_err();
    let mut stderr = stderr_result.unwrap_or_default();
    if drains_incomplete {
        stderr.capture_truncated = true;
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
            format!("failed to wait for guest state helper: {message}"),
        ),
    };
    if let Err(error) = stdin_result
        && matches!(termination, ExecTermination::Exited { .. })
    {
        log(
            "WARN",
            &format!("guest state helper stdin writer finished with error: {error}"),
        );
    }
    GuestStateRestoreOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stderr,
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn abort_spawned(child: Child, started: Instant, diagnostic: &str) -> GuestStateRestoreOutput {
    kill_and_reap_child(child);
    failed_output(ExecTermination::WaitFailed, started, diagnostic.to_string())
}

fn failed_output(
    termination: ExecTermination,
    started: Instant,
    diagnostic: String,
) -> GuestStateRestoreOutput {
    GuestStateRestoreOutput {
        termination,
        duration_ms: elapsed_ms(started),
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
    let end = value.floor_char_boundary(limit);
    value.truncate(end);
    value
}
