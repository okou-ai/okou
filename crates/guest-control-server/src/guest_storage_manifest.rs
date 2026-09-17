use guest_contracts::storage_resources::StorageResourceUsage;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
};

use crate::contained_command::{
    CommandStdio, ContainedChild as Child, ContainedCommand as Command, ContainedCommandExt,
};
use crate::drain::{BoundedDrainResult, DrainCancellation, drain_bounded_cancellable};
use crate::error::to_io_error;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::process_containment::{
    ExecProcessContainment, ProcessContainmentCleanupMode, ProcessContainmentError,
    ProcessContainmentMode,
};
use crate::quiesce::OperationGuard;
use crate::wait::{
    WaitOutcome, await_drain_deadline, wait_with_kill_timeout_or_connection_cancelled,
};
pub(crate) use crate::worker_ownership::LazyConnectionWorkerSubmitError as GuestStorageManifestSubmitError;
use crate::worker_ownership::{LazyConnectionWorker, SingleActivePermit};
use crate::writer::GuestWriter;

const THREAD_WORKER: &str = "gctl-store";
const THREAD_STDIN: &str = "gctl-store-in";
const THREAD_STDOUT: &str = "gctl-store-out";
const THREAD_STDERR: &str = "gctl-store-err";
const MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;

#[derive(Clone)]
pub(crate) enum GuestStorageManifestProgram {
    Production,
    Test(PathBuf),
    TestResources {
        program: PathBuf,
        resource_path: PathBuf,
    },
    TestTimeout {
        program: PathBuf,
        resource_path: Option<PathBuf>,
        timeout_gate: mpsc::SyncSender<u32>,
    },
}

impl GuestStorageManifestProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(path)
    }

    pub(crate) fn for_test_resources(program: PathBuf, resource_path: PathBuf) -> Self {
        Self::TestResources {
            program,
            resource_path,
        }
    }

    pub(crate) fn for_test_timeout(
        program: PathBuf,
        resource_path: Option<PathBuf>,
        timeout_gate: mpsc::SyncSender<u32>,
    ) -> Self {
        Self::TestTimeout {
            program,
            resource_path,
            timeout_gate,
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(guest_contracts::guest_binary::STORAGE_APPLY_PATH),
            Self::Test(path) => path,
            Self::TestResources { program, .. } | Self::TestTimeout { program, .. } => program,
        }
    }

    fn await_test_timeout_gate(&self, child_id: u32) {
        if let Self::TestTimeout { timeout_gate, .. } = self {
            // The test receives on a zero-capacity channel after helper readiness.
            // If it panics and drops the receiver, continue into normal cleanup.
            let _ = timeout_gate.send(child_id);
        }
    }

    fn create_containment(
        &self,
        seq: u32,
        mode: ProcessContainmentMode,
        run_id: &str,
    ) -> Result<ExecProcessContainment, ProcessContainmentError> {
        if let Self::TestResources { resource_path, .. }
        | Self::TestTimeout {
            resource_path: Some(resource_path),
            ..
        } = self
        {
            return Ok(ExecProcessContainment::for_test_storage_resources(
                resource_path.clone(),
                run_id,
                seq,
            ));
        }
        ExecProcessContainment::create(seq, mode, guest_control_proto::ExecProcessRole::Workload)
            .map(|containment| containment.with_storage_resources(run_id, seq))
    }
}

struct GuestStorageManifestRequest {
    seq: u32,
    timeout_ms: u32,
    run_id: String,
    runtime_dir: String,
    manifest_json: Vec<u8>,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

#[derive(Clone)]
struct GuestStorageManifestWorkerContext {
    program: GuestStorageManifestProgram,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

pub(crate) struct GuestStorageManifestWorker {
    inner: LazyConnectionWorker<GuestStorageManifestRequest, GuestStorageManifestWorkerContext>,
}

impl GuestStorageManifestWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: GuestStorageManifestProgram,
        process_containment_mode: ProcessContainmentMode,
        drain_deadline: Duration,
    ) -> Self {
        Self {
            inner: LazyConnectionWorker::new(
                writer,
                connection_cancel,
                GuestStorageManifestWorkerContext {
                    program,
                    process_containment_mode,
                    drain_deadline,
                },
                handle_worker_request,
                THREAD_WORKER,
                "guest storage manifest worker",
            ),
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.inner.try_admit()
    }

    pub(crate) fn submit(
        &self,
        submission: GuestStorageManifestSubmission<'_>,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), GuestStorageManifestSubmitError> {
        self.inner
            .try_submit_with(move || GuestStorageManifestRequest {
                seq: submission.seq,
                timeout_ms: submission.timeout_ms,
                run_id: submission.run_id.to_owned(),
                runtime_dir: submission.runtime_dir.to_owned(),
                manifest_json: submission.manifest_json.to_vec(),
                operation_guard,
                admission,
            })
    }
}

pub(crate) struct GuestStorageManifestSubmission<'a> {
    pub(crate) seq: u32,
    pub(crate) timeout_ms: u32,
    pub(crate) run_id: &'a str,
    pub(crate) runtime_dir: &'a str,
    pub(crate) manifest_json: &'a [u8],
}

struct GuestStorageManifestOutput {
    termination: ExecTermination,
    duration_ms: u32,
    stdout: BoundedDrainResult,
    stderr: BoundedDrainResult,
    diagnostic: String,
}

fn handle_worker_request(
    request: GuestStorageManifestRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    context: &GuestStorageManifestWorkerContext,
) -> io::Result<()> {
    handle_request(
        request,
        writer,
        connection_cancel,
        &context.program,
        context.process_containment_mode,
        context.drain_deadline,
    )
}

fn handle_request(
    request: GuestStorageManifestRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestStorageManifestProgram,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
) -> io::Result<()> {
    let GuestStorageManifestRequest {
        seq,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        operation_guard,
        admission,
    } = request;
    let mut resources = None;
    let output = run_manifest(RunManifestInput {
        seq,
        program,
        timeout_ms,
        run_id: &run_id,
        runtime_dir: &runtime_dir,
        manifest_json,
        connection_cancel,
        process_containment_mode,
        drain_deadline,
        resources: &mut resources,
    });
    let stdout = captured_output(&output.stdout);
    let stderr = captured_output(&output.stderr);
    let resource_summary = resources
        .as_ref()
        .and_then(|value| serde_json::to_vec(value).ok())
        .filter(|value| {
            value.len() <= guest_control_proto::GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES
        })
        .unwrap_or_default();
    let mut frame = Vec::new();
    guest_control_proto::encode_guest_storage_manifest_result_frame_into(
        &mut frame,
        seq,
        guest_control_proto::DecodedExecResult {
            termination: output.termination,
            duration_ms: output.duration_ms,
            stdout,
            stderr,
            diagnostic: &output.diagnostic,
        },
        &resource_summary,
    )
    .map_err(to_io_error)?;

    writer
        .write_frame_after_lock_unless_cancelled(&frame, connection_cancel, || {
            operation_guard.release();
            drop(admission);
        })
        .map(|_| ())
}

struct RunManifestInput<'a> {
    resources: &'a mut Option<StorageResourceUsage>,
    seq: u32,
    program: &'a GuestStorageManifestProgram,
    timeout_ms: u32,
    run_id: &'a str,
    runtime_dir: &'a str,
    manifest_json: Vec<u8>,
    connection_cancel: &'a AtomicBool,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
}

fn run_manifest(input: RunManifestInput<'_>) -> GuestStorageManifestOutput {
    let RunManifestInput {
        seq,
        program,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        connection_cancel,
        process_containment_mode,
        drain_deadline,
        resources,
    } = input;
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize storage output drain cancellation: {error}"),
            );
        }
    };
    let process_containment =
        match program.create_containment(seq, process_containment_mode, run_id) {
            Ok(process_containment) => process_containment,
            Err(error) => {
                return failed_output(
                    ExecTermination::StartFailed,
                    started,
                    format!("Failed to initialize storage helper process containment: {error}"),
                );
            }
        };
    let mut command = Command::new(program.path());
    command
        .arg(
            if manifest_json.starts_with(guest_contracts::storage_files::INPUT_MAGIC) {
                "--storage-files-stdin"
            } else {
                "--manifest-stdin"
            },
        )
        .env(guest_contracts::env::RUN_ID_ENV, run_id)
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        )
        .stdin(CommandStdio::Piped)
        .stdout(CommandStdio::Piped)
        .stderr(CommandStdio::Piped);
    let mut child = match command.spawn(false, &process_containment) {
        Ok(child) => child,
        Err(error) => {
            let _ = process_containment
                .cleanup_with_storage_resources(ProcessContainmentCleanupMode::Forced, resources);
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to start storage helper: {error}"),
            );
        }
    };

    let Some(stdin) = child.stdin.take() else {
        return abort_spawned(
            child,
            process_containment,
            resources,
            started,
            "storage helper stdin pipe missing",
        );
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        return abort_spawned(
            child,
            process_containment,
            resources,
            started,
            "storage helper stdout pipe missing",
        );
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdin);
        drop(stdout);
        return abort_spawned(
            child,
            process_containment,
            resources,
            started,
            "storage helper stderr pipe missing",
        );
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
            drop(stdin);
            drop(stderr);
            kill_and_reap_child(child);
            let cleanup = process_containment
                .cleanup_with_storage_resources(ProcessContainmentCleanupMode::Forced, resources);
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stdout drain: {error}"),
                    cleanup.err().as_ref(),
                ),
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
            drop(stdin);
            kill_and_reap_child(child);
            let cleanup = process_containment
                .cleanup_with_storage_resources(ProcessContainmentCleanupMode::Forced, resources);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stderr drain: {error}"),
                    cleanup.err().as_ref(),
                ),
            );
        }
    };
    let stdin_writer = match spawn_stdin(stdin, manifest_json) {
        Ok(writer) => writer,
        Err(error) => {
            drain_cancel.cancel();
            kill_and_reap_child(child);
            let cleanup = process_containment
                .cleanup_with_storage_resources(ProcessContainmentCleanupMode::Forced, resources);
            drop(drain_done_tx);
            let _ = stdout_drain.join();
            let _ = stderr_drain.join();
            return failed_output(
                ExecTermination::WaitFailed,
                started,
                append_cleanup_failure(
                    format!("Failed to start storage helper stdin writer: {error}"),
                    cleanup.err().as_ref(),
                ),
            );
        }
    };
    drop(drain_done_tx);

    program.await_test_timeout_gate(child.id());
    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        timeout_ms,
        connection_cancel,
        // Reap the group before the exited leader can release its process-group
        // identity, so helper descendants cannot outlive this fixed operation.
        || true,
    );
    let cancellation_observed = connection_cancel.load(Ordering::Acquire);
    let cleanup_mode = cleanup_mode_for_wait_outcome(&outcome, cancellation_observed);
    let containment_result =
        process_containment.cleanup_with_storage_resources(cleanup_mode, resources);
    let stdin_result = stdin_writer.join();
    if !matches!(outcome, WaitOutcome::Exited(_))
        || cancellation_observed
        || containment_result.is_err()
    {
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

    let (mut termination, mut diagnostic) = match outcome {
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
            format!("Failed to wait for storage helper: {message}"),
        ),
    };
    if let Err(error) = stdin_result
        && matches!(termination, ExecTermination::Exited { .. })
    {
        log(
            "WARN",
            &format!("storage helper stdin writer finished with error: {error}"),
        );
    }
    if let Err(error) = containment_result {
        termination = ExecTermination::WaitFailed;
        diagnostic = append_cleanup_failure(diagnostic, Some(&error));
    }

    GuestStorageManifestOutput {
        termination,
        duration_ms: elapsed_ms(started),
        stdout,
        stderr,
        diagnostic: truncate_utf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
    }
}

fn abort_spawned(
    child: Child,
    process_containment: ExecProcessContainment,
    resources: &mut Option<StorageResourceUsage>,
    started: Instant,
    diagnostic: &str,
) -> GuestStorageManifestOutput {
    kill_and_reap_child(child);
    let cleanup = process_containment
        .cleanup_with_storage_resources(ProcessContainmentCleanupMode::Forced, resources);
    failed_output(
        ExecTermination::WaitFailed,
        started,
        append_cleanup_failure(diagnostic.to_string(), cleanup.err().as_ref()),
    )
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

fn append_cleanup_failure(diagnostic: String, error: Option<&ProcessContainmentError>) -> String {
    let Some(error) = error else {
        return diagnostic;
    };
    if diagnostic.is_empty() {
        format!("Failed to clean storage helper process containment: {error}")
    } else {
        format!("{diagnostic}; failed to clean storage helper process containment: {error}")
    }
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
                Some(GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES),
                None,
                |_, _| true,
            );
            let _ = result_tx.send(result);
            let _ = done_tx.send(());
        })?;
    Ok(DrainHandle { handle, result_rx })
}

struct StdinWriter {
    handle: JoinHandle<io::Result<()>>,
}

impl StdinWriter {
    fn join(self) -> io::Result<()> {
        self.handle
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }
}

fn spawn_stdin(mut stdin: ChildStdin, manifest_json: Vec<u8>) -> io::Result<StdinWriter> {
    let handle = thread::Builder::new()
        .name(THREAD_STDIN.to_string())
        .spawn(move || {
            let result = stdin.write_all(&manifest_json);
            drop(stdin);
            result
        })?;
    Ok(StdinWriter { handle })
}

fn failed_output(
    termination: ExecTermination,
    started: Instant,
    diagnostic: String,
) -> GuestStorageManifestOutput {
    GuestStorageManifestOutput {
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
