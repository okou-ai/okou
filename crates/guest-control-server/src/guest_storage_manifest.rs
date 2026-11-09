use guest_contracts::agent_instructions::InstructionOperation;
use guest_contracts::storage_resources::StorageResourceUsage;
#[cfg(target_os = "linux")]
use guest_telemetry::storage_notifications::{self, NotificationOwner};
use serde::{Deserialize, Serialize, Serializer};
use std::io;
#[cfg(target_os = "linux")]
use std::os::{fd::OwnedFd, unix::net::UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use guest_control_proto::{ExecTermination, GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES};

use crate::contained_command::{
    CommandStdio, ContainedChild as Child, ContainedCommand as Command, ContainedCommandExt,
};
use crate::drain::{BoundedDrainHandle, BoundedDrainResult, DrainCancellation};
use crate::error::to_io_error;
use crate::helper_input::FixedInputWriter;
use crate::helper_output::{captured_or_empty, truncate_utf8};
use crate::helper_program::TestHelperProgram;
use crate::log::log;
use crate::process::kill_and_reap_child;
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
    Test(TestHelperProgram),
    TestResources {
        program: TestHelperProgram,
        resource_path: PathBuf,
    },
}

impl GuestStorageManifestProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test(TestHelperProgram::new(path))
    }

    pub(crate) fn for_test_resources(program: PathBuf, resource_path: PathBuf) -> Self {
        Self::TestResources {
            program: TestHelperProgram::new(program),
            resource_path,
        }
    }

    pub(crate) fn for_test_timeout(
        program: PathBuf,
        resource_path: Option<PathBuf>,
        timeout_gate: mpsc::SyncSender<u32>,
    ) -> Self {
        let program = TestHelperProgram::with_timeout_gate(program, timeout_gate);
        match resource_path {
            Some(resource_path) => Self::TestResources {
                program,
                resource_path,
            },
            None => Self::Test(program),
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(guest_contracts::guest_binary::STORAGE_APPLY_PATH),
            Self::Test(program) | Self::TestResources { program, .. } => program.path(),
        }
    }

    fn await_test_timeout_gate(&self, child_id: u32) {
        match self {
            Self::Production => {}
            Self::Test(program) | Self::TestResources { program, .. } => {
                program.await_timeout_gate(child_id);
            }
        }
    }

    fn create_containment(
        &self,
        seq: u32,
        mode: ProcessContainmentMode,
        run_id: &str,
        collect_resources: bool,
    ) -> Result<ExecProcessContainment, ProcessContainmentError> {
        if let Self::TestResources { resource_path, .. } = self {
            return Ok(ExecProcessContainment::for_test_storage_resources(
                resource_path.clone(),
                run_id,
                seq,
            ));
        }
        ExecProcessContainment::create(seq, mode, guest_control_proto::ExecProcessRole::Workload)
            .map(|containment| {
                if collect_resources {
                    containment.with_storage_resources(run_id, seq)
                } else {
                    containment
                }
            })
    }
}

struct GuestStorageManifestRequest {
    instruction_operation: Option<InstructionOperation>,
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
    #[cfg(target_os = "linux")]
    notifications: Arc<NotificationOwner>,
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
                    #[cfg(target_os = "linux")]
                    notifications: Arc::default(),
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
                instruction_operation: submission.instruction_operation,
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
    pub(crate) instruction_operation: Option<InstructionOperation>,
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
        #[cfg(target_os = "linux")]
        &context.notifications,
    )
}

fn handle_request(
    request: GuestStorageManifestRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestStorageManifestProgram,
    process_containment_mode: ProcessContainmentMode,
    drain_deadline: Duration,
    #[cfg(target_os = "linux")] notifications: &NotificationOwner,
) -> io::Result<()> {
    let worker_wait_us = microseconds(request.enqueue_ready.elapsed());
    let GuestStorageManifestRequest {
        instruction_operation,
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
        instruction_operation,
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
        #[cfg(target_os = "linux")]
        notifications,
    });
    let response_prepare_started = Instant::now();
    let stdout = captured_or_empty(&output.stdout);
    let stderr = captured_or_empty(&output.stderr);
    let resource_summary = if instruction_operation.is_none() {
        serde_json::to_vec(&TerminalEvidence {
            resources: resources.as_ref(),
            storage_resource_available: resources.is_some(),
            storage_control_timing: ResponseTiming {
                request_ownership_us,
                worker_wait_us,
                response_prepare_us: PreparationElapsed(response_prepare_started),
            },
        })
        .ok()
        .filter(|value| {
            value.len() <= guest_control_proto::GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES
        })
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut frame = Vec::new();
    let result = guest_control_proto::DecodedExecResult {
        termination: output.termination,
        duration_ms: output.duration_ms,
        stdout,
        stderr,
        diagnostic: &output.diagnostic,
    };
    if instruction_operation.is_some() {
        guest_control_proto::encode_guest_agent_instructions_result_frame_into(
            &mut frame, seq, result,
        )
    } else {
        guest_control_proto::encode_guest_storage_manifest_result_frame_into(
            &mut frame,
            seq,
            result,
            &resource_summary,
        )
    }
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
    instruction_operation: Option<InstructionOperation>,
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
    #[cfg(target_os = "linux")]
    notifications: &'a NotificationOwner,
}

enum StorageStdin {
    Pipe(std::process::ChildStdin),
    #[cfg(target_os = "linux")]
    Notification {
        stream: UnixStream,
        events: OwnedFd,
    },
}

impl StorageStdin {
    fn write(self, input: Vec<u8>) -> io::Result<FixedInputWriter> {
        match self {
            Self::Pipe(stdin) => FixedInputWriter::spawn(stdin, input, THREAD_STDIN),
            #[cfg(target_os = "linux")]
            Self::Notification { mut stream, events } => {
                FixedInputWriter::spawn_task(THREAD_STDIN, move || {
                    use std::io::Write;
                    use std::os::fd::AsFd;
                    storage_notifications::send(&stream, events.as_fd())?;
                    stream.write_all(&input)
                })
            }
        }
    }
}

#[derive(Deserialize)]
struct ManifestMode {
    #[serde(default, rename = "archiveReadiness")]
    readiness: Option<ReadinessMode>,
}

#[derive(Deserialize)]
struct ReadinessMode {
    #[serde(default, rename = "checkOnly")]
    check_only: bool,
}

fn eligibility_query(
    bytes: &[u8],
    runtime: &Path,
    timeout_ms: u32,
    cancelled: &AtomicBool,
    started: Instant,
) -> Option<GuestStorageManifestOutput> {
    if !serde_json::from_slice::<ManifestMode>(bytes)
        .ok()
        .and_then(|mode| mode.readiness)
        .is_some_and(|mode| mode.check_only)
    {
        return None;
    }
    let control = || {
        if cancelled.load(Ordering::Acquire) {
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "storage query cancelled",
            ))
        } else if started.elapsed() >= Duration::from_millis(u64::from(timeout_ms)) {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "storage query deadline",
            ))
        } else {
            Ok(())
        }
    };
    let result = (|| {
        control()?;
        let manifest = serde_json::from_slice::<guest_contracts::storage_manifest::Manifest>(bytes)
            .map_err(|error| {
                // Serde messages can quote sensitive manifest values. Preserve
                // only the same bounded metadata as the ordinary helper parser.
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "category={:?} line={} column={}",
                        error.classify(),
                        error.line(),
                        error.column()
                    ),
                )
            })?;
        guest_telemetry::storage_eligibility::eligible(&manifest, Some(runtime), control)
    })();
    Some(match result {
        Ok(eligible) => GuestStorageManifestOutput {
            termination: ExecTermination::Exited { exit_code: 0 },
            duration_ms: elapsed_ms(started),
            stdout: BoundedDrainResult {
                captured: Some(if eligible {
                    b"true\n".to_vec()
                } else {
                    b"false\n".to_vec()
                }),
                capture_truncated: false,
                stream_truncated: false,
            },
            stderr: BoundedDrainResult {
                captured: Some(Vec::new()),
                capture_truncated: false,
                stream_truncated: false,
            },
            diagnostic: String::new(),
        },
        Err(error) => failed_output(
            match error.kind() {
                io::ErrorKind::Interrupted => ExecTermination::Cancelled,
                io::ErrorKind::TimedOut => ExecTermination::TimedOut,
                _ => ExecTermination::Exited { exit_code: 1 },
            },
            started,
            format!("Guest archive eligibility check failed: {error}"),
        ),
    })
}

fn run_manifest(input: RunManifestInput<'_>) -> GuestStorageManifestOutput {
    let RunManifestInput {
        instruction_operation,
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
        #[cfg(target_os = "linux")]
        notifications,
    } = input;
    let started = Instant::now();
    // The fixed query is pure admission and stays on this single-active worker.
    // Application, instruction and external programs retain their process owner.
    if instruction_operation.is_none()
        && matches!(program, GuestStorageManifestProgram::Production)
        && !manifest_json.starts_with(guest_contracts::storage_files::INPUT_MAGIC)
        && let Some(output) = eligibility_query(
            &manifest_json,
            Path::new(runtime_dir),
            timeout_ms,
            connection_cancel,
            started,
        )
    {
        return output;
    }
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
    let mut command = Command::new(program.path());
    let argument = match instruction_operation {
        Some(operation) => operation.helper_argument(),
        None if manifest_json.starts_with(guest_contracts::storage_files::INPUT_MAGIC) => {
            "--storage-files-stdin"
        }
        None => "--manifest-stdin",
    };
    let output_limit = if instruction_operation.is_some() {
        guest_control_proto::GUEST_AGENT_INSTRUCTIONS_OUTPUT_LIMIT_BYTES
    } else {
        GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES
    };
    command
        .arg(argument)
        .env(guest_contracts::env::RUN_ID_ENV, run_id)
        .env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            runtime_dir,
        )
        .stdin(CommandStdio::Piped)
        .stdout(CommandStdio::Piped)
        .stderr(CommandStdio::Piped);
    // Only the fixed production storage helper understands this private stdin
    // bootstrap. Instruction and external test programs retain their pipe input.
    #[cfg(target_os = "linux")]
    let notification_lease = if instruction_operation.is_none()
        && matches!(program, GuestStorageManifestProgram::Production)
    {
        match notifications.lease() {
            Ok(lease) => Some(lease),
            Err(error) => {
                return failed_output(
                    ExecTermination::StartFailed,
                    started,
                    format!("Failed to acquire storage notifications: {error}"),
                );
            }
        }
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    let notification_stdin = if let Some(lease) = &notification_lease {
        let mut prepare = || -> io::Result<_> {
            let (stream, helper) = UnixStream::pair()?;
            stream.set_write_timeout(Some(Duration::from_millis(u64::from(timeout_ms.max(1)))))?;
            let events = lease.descriptor().try_clone_to_owned()?;
            command.stdin(CommandStdio::Owned(helper.into()));
            Ok(StorageStdin::Notification { stream, events })
        };
        match prepare() {
            Ok(stdin) => Some(stdin),
            Err(error) => {
                return failed_output(
                    ExecTermination::StartFailed,
                    started,
                    format!("Failed to prepare storage notification stdin: {error}"),
                );
            }
        }
    } else {
        None
    };
    command.env(guest_contracts::env::STORAGE_NOTIFICATION_STDIN_ENV, "0");
    #[cfg(target_os = "linux")]
    if notification_stdin.is_some() {
        command.env(guest_contracts::env::STORAGE_NOTIFICATION_STDIN_ENV, "1");
    }
    let process_containment = match program.create_containment(
        seq,
        process_containment_mode,
        run_id,
        instruction_operation.is_none(),
    ) {
        Ok(process_containment) => process_containment,
        Err(error) => {
            return failed_output(
                ExecTermination::StartFailed,
                started,
                format!("Failed to initialize storage helper process containment: {error}"),
            );
        }
    };
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

    let stdin = child.stdin.take().map(StorageStdin::Pipe);
    #[cfg(target_os = "linux")]
    let stdin = notification_stdin.or(stdin);
    let Some(stdin) = stdin else {
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
        output_limit,
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
        output_limit,
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
    let stdin_writer = match stdin.write(manifest_json) {
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

    let (mut termination, mut diagnostic) =
        outcome.into_exec_result("Failed to wait for storage helper");
    if let Err(error) = stdin_result
        && matches!(termination, ExecTermination::Exited { .. })
    {
        log(
            "WARN",
            &format!("storage helper stdin writer finished with error: {error}"),
        );
    }
    #[cfg(target_os = "linux")]
    let containment_settled = containment_result.is_ok();
    if let Err(error) = containment_result {
        termination = ExecTermination::WaitFailed;
        diagnostic = append_cleanup_failure(diagnostic, Some(&error));
    }
    #[cfg(target_os = "linux")]
    if let Some(lease) = notification_lease
        && containment_settled
        && let Err(error) = lease.finish()
    {
        termination = ExecTermination::WaitFailed;
        let reset = format!("Failed to reset storage notifications: {error}");
        diagnostic = if diagnostic.is_empty() {
            reset
        } else {
            format!("{diagnostic}; {reset}")
        };
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

fn elapsed_ms(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
