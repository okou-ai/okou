use guest_contracts::storage_resources::StorageResourceUsage;
use serde::{Serialize, Serializer};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
};

use crate::contained_command::{
    CommandStdio, ContainedChild as Child, ContainedCommand as Command, ContainedCommandExt,
};
use crate::drain::{BoundedDrainHandle, BoundedDrainResult, DrainCancellation};
use crate::error::to_io_error;
use crate::helper_input::FixedInputWriter;
use crate::log::log;
use crate::process::{extract_exit_code, kill_and_reap_child};
use crate::process_containment::{
    ExecProcessContainment, ProcessContainmentCleanupMode, ProcessContainmentError,
    ProcessContainmentMode,
};
use crate::quiesce::OperationGuard;
use crate::wait::{
    WaitOutcome, collect_bounded_output, wait_with_kill_timeout_or_connection_cancelled,
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
    request_ownership_us: Option<u64>,
    enqueue_ready: Instant,
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
        let ownership_started = Instant::now();
        self.inner.try_submit_with(move || {
            let mut request = GuestStorageManifestRequest {
                seq: submission.seq,
                timeout_ms: submission.timeout_ms,
                run_id: submission.run_id.to_owned(),
                runtime_dir: submission.runtime_dir.to_owned(),
                manifest_json: submission.manifest_json.to_vec(),
                operation_guard,
                admission,
                request_ownership_us: None,
                enqueue_ready: ownership_started,
            };
            // Install both observations before enqueue: the worker can run
            // before try_send returns. Lazy sender acquisition is included;
            // receive/decoding and try_send itself are not ownership work.
            let enqueue_ready = Instant::now();
            request.request_ownership_us = microseconds(enqueue_ready - ownership_started);
            request.enqueue_ready = enqueue_ready;
            request
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
    let worker_wait_us = microseconds(request.enqueue_ready.elapsed());
    let GuestStorageManifestRequest {
        seq,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        operation_guard,
        admission,
        request_ownership_us,
        enqueue_ready: _,
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
    let response_prepare_started = Instant::now();
    let stdout = captured_output(&output.stdout);
    let stderr = captured_output(&output.stderr);
    let resource_summary = serde_json::to_vec(&TerminalEvidence {
        resources: resources.as_ref(),
        storage_resource_available: resources.is_some(),
        storage_control_timing: ResponseTiming {
            request_ownership_us,
            worker_wait_us,
            response_prepare_us: PreparationElapsed(response_prepare_started),
        },
    })
    .ok()
    .filter(|value| value.len() <= guest_control_proto::GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES)
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

#[derive(Serialize)]
struct TerminalEvidence<'a> {
    // Field order deliberately serializes the existing resource snapshot before
    // sampling preparation. Legacy resource readers ignore the additive fields.
    #[serde(flatten)]
    resources: Option<&'a StorageResourceUsage>,
    storage_resource_available: bool,
    storage_control_timing: ResponseTiming,
}

#[derive(Serialize)]
struct ResponseTiming {
    request_ownership_us: Option<u64>,
    worker_wait_us: Option<u64>,
    response_prepare_us: PreparationElapsed,
}

struct PreparationElapsed(Instant);

impl Serialize for PreparationElapsed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // The measurement ends here. It cannot include its own encoded value,
        // JSON closing bytes, final frame encoding, writer wait/write, or Host
        // receive/wakeup work that has not happened yet.
        microseconds(self.0.elapsed()).serialize(serializer)
    }
}

fn microseconds(duration: Duration) -> Option<u64> {
    u64::try_from(duration.as_micros()).ok()
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
    let stdout_drain = match BoundedDrainHandle::spawn(
        stdout,
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
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
    let stderr_drain = match BoundedDrainHandle::spawn(
        stderr,
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES,
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
    let stdin_writer = match FixedInputWriter::spawn(stdin, manifest_json, THREAD_STDIN) {
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
    let cleanup_mode =
        ProcessContainmentCleanupMode::for_wait_outcome(&outcome, cancellation_observed);
    let containment_result =
        process_containment.cleanup_with_storage_resources(cleanup_mode, resources);
    let stdin_result = stdin_writer.join();
    if !matches!(outcome, WaitOutcome::Exited(_))
        || cancellation_observed
        || containment_result.is_err()
    {
        drain_cancel.cancel();
    }
    let (stdout, stderr) = collect_bounded_output(
        stdout_drain,
        stderr_drain,
        &drain_done_rx,
        &drain_cancel,
        drain_deadline,
    );

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
    let end = value.floor_char_boundary(limit);
    value.truncate(end);
    value
}
