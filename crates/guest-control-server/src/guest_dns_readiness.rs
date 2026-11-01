use std::io;
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use guest_control_proto::{
    GUEST_DNS_READINESS_MAX_ANSWER_BYTES, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES,
    GuestDnsReadinessTermination, MSG_GUEST_DNS_READINESS_RESULT,
};

use crate::drain::{BoundedDrainHandle, DrainCancellation};
use crate::error::to_io_error;
use crate::process::{extract_exit_code, kill_and_reap_child, spawn_in_own_process_group};
use crate::quiesce::OperationGuard;
use crate::user::apply_command_identity;
use crate::wait::{
    WaitOutcome, collect_bounded_output, wait_with_kill_timeout_or_connection_cancelled,
};
pub(crate) use crate::worker_ownership::LazyConnectionWorkerSubmitError as GuestDnsReadinessSubmitError;
use crate::worker_ownership::{LazyConnectionWorker, SingleActivePermit};
use crate::writer::GuestWriter;

const PRODUCTION_PROGRAM: &str = "/usr/bin/getent";
const RESOLVER_DATABASE: &str = "ahostsv4";
const RESOLVER_OPTIONS: &str = "attempts:1 timeout:1";
const OUTPUT_DRAIN_DEADLINE: Duration = Duration::from_secs(1);
const THREAD_WORKER: &str = "gctl-dns-ready";
const THREAD_STDOUT: &str = "gctl-dns-stdout";
const THREAD_STDERR: &str = "gctl-dns-stderr";

#[derive(Clone)]
pub(crate) enum GuestDnsReadinessProgram {
    Production,
    Test {
        path: PathBuf,
        timeout_gate: Option<mpsc::SyncSender<u32>>,
    },
}

impl GuestDnsReadinessProgram {
    pub(crate) fn production() -> Self {
        Self::Production
    }

    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self::Test {
            path,
            timeout_gate: None,
        }
    }

    pub(crate) fn for_test_timeout(path: PathBuf, timeout_gate: mpsc::SyncSender<u32>) -> Self {
        Self::Test {
            path,
            timeout_gate: Some(timeout_gate),
        }
    }

    fn await_test_timeout_gate(&self, child_id: u32) {
        if let Self::Test {
            timeout_gate: Some(timeout_gate),
            ..
        } = self
        {
            // A zero-capacity channel lets the test establish helper readiness
            // before the real timeout starts. A dropped receiver permits cleanup.
            let _ = timeout_gate.send(child_id);
        }
    }

    fn path(&self) -> &Path {
        match self {
            Self::Production => Path::new(PRODUCTION_PROGRAM),
            Self::Test { path, .. } => path,
        }
    }
}

struct GuestDnsReadinessRequest {
    seq: u32,
    timeout_ms: u32,
    hostname: String,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
}

pub(crate) struct GuestDnsReadinessWorker {
    inner: LazyConnectionWorker<GuestDnsReadinessRequest, GuestDnsReadinessProgram>,
}

impl GuestDnsReadinessWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
        program: GuestDnsReadinessProgram,
    ) -> Self {
        Self {
            inner: LazyConnectionWorker::new(
                writer,
                connection_cancel,
                program,
                handle_request,
                THREAD_WORKER,
                "guest DNS readiness worker",
            ),
        }
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.inner.try_admit()
    }

    pub(crate) fn submit(
        &self,
        seq: u32,
        timeout_ms: u32,
        hostname: &str,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), GuestDnsReadinessSubmitError> {
        self.inner
            .try_submit_with(move || GuestDnsReadinessRequest {
                seq,
                timeout_ms,
                hostname: hostname.to_owned(),
                operation_guard,
                admission,
            })
    }
}

struct GuestDnsReadinessOutput {
    termination: GuestDnsReadinessTermination,
    duration_ms: u32,
    answer: Vec<u8>,
    output_truncated: bool,
    diagnostic: String,
}

fn handle_request(
    request: GuestDnsReadinessRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    program: &GuestDnsReadinessProgram,
) -> io::Result<()> {
    let GuestDnsReadinessRequest {
        seq,
        timeout_ms,
        hostname,
        operation_guard,
        admission,
    } = request;
    let output = run_probe(program, timeout_ms, &hostname, connection_cancel);
    let payload = guest_control_proto::encode_guest_dns_readiness_result(
        output.termination,
        output.duration_ms,
        &output.answer,
        output.output_truncated,
        &output.diagnostic,
    )
    .map_err(to_io_error)?;
    let frame = guest_control_proto::encode(MSG_GUEST_DNS_READINESS_RESULT, seq, &payload)
        .map_err(to_io_error)?;

    writer
        .write_frame_after_lock_unless_cancelled(&frame, connection_cancel, || {
            operation_guard.release();
            drop(admission);
        })
        .map(|_| ())
}

fn run_probe(
    program: &GuestDnsReadinessProgram,
    timeout_ms: u32,
    hostname: &str,
    connection_cancel: &AtomicBool,
) -> GuestDnsReadinessOutput {
    let started = Instant::now();
    let drain_cancel = match DrainCancellation::new() {
        Ok(cancel) => Arc::new(cancel),
        Err(error) => {
            return failed_output(
                GuestDnsReadinessTermination::StartFailed,
                started,
                format!("failed to initialize guest DNS output drain cancellation: {error}"),
            );
        }
    };
    let mut command = Command::new(program.path());
    command
        .arg(RESOLVER_DATABASE)
        .arg(hostname)
        .env("RES_OPTIONS", RESOLVER_OPTIONS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Err(error) = apply_command_identity(&mut command, false) {
        return failed_output(
            GuestDnsReadinessTermination::StartFailed,
            started,
            format!("failed to select sandbox user: {error}"),
        );
    }
    let mut child = match spawn_in_own_process_group(&mut command) {
        Ok(child) => child,
        Err(error) => {
            return failed_output(
                GuestDnsReadinessTermination::StartFailed,
                started,
                format!("failed to start guest DNS readiness process: {error}"),
            );
        }
    };
    let Some(stdout) = child.stdout.take() else {
        kill_and_reap_child(child);
        return failed_output(
            GuestDnsReadinessTermination::WaitFailed,
            started,
            "guest DNS readiness stdout pipe missing".to_string(),
        );
    };
    let Some(stderr) = child.stderr.take() else {
        drop(stdout);
        kill_and_reap_child(child);
        return failed_output(
            GuestDnsReadinessTermination::WaitFailed,
            started,
            "guest DNS readiness stderr pipe missing".to_string(),
        );
    };

    let (drain_done_tx, drain_done_rx) = mpsc::channel();
    let stdout_drain = match BoundedDrainHandle::spawn(
        OwnedFd::from(stdout),
        GUEST_DNS_READINESS_MAX_ANSWER_BYTES,
        Arc::clone(&drain_cancel),
        drain_done_tx.clone(),
        THREAD_STDOUT,
    ) {
        Ok(drain) => drain,
        Err(error) => {
            drop(stderr);
            kill_and_reap_child(child);
            return failed_output(
                GuestDnsReadinessTermination::WaitFailed,
                started,
                format!("failed to start guest DNS stdout drain: {error}"),
            );
        }
    };
    let stderr_drain = match BoundedDrainHandle::spawn(
        OwnedFd::from(stderr),
        GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES,
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
                GuestDnsReadinessTermination::WaitFailed,
                started,
                format!("failed to start guest DNS stderr drain: {error}"),
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
        // identity, so an NSS helper cannot outlive the readiness operation.
        || true,
    );
    if !matches!(outcome, WaitOutcome::Exited(_)) {
        drain_cancel.cancel();
    }
    let (stdout_result, stderr_result) = collect_bounded_output(
        stdout_drain,
        stderr_drain,
        &drain_done_rx,
        &drain_cancel,
        OUTPUT_DRAIN_DEADLINE,
    );

    let (termination, wait_diagnostic) = match outcome {
        WaitOutcome::Exited(status) => (
            GuestDnsReadinessTermination::Exited {
                exit_code: extract_exit_code(status),
            },
            None,
        ),
        WaitOutcome::TimedOut => (GuestDnsReadinessTermination::TimedOut, None),
        WaitOutcome::Cancelled => (GuestDnsReadinessTermination::Cancelled, None),
        WaitOutcome::WaitFailed(message) => (
            GuestDnsReadinessTermination::WaitFailed,
            Some(format!(
                "failed to wait for guest DNS readiness process: {message}"
            )),
        ),
    };
    let answer = stdout_result.captured.unwrap_or_default();
    let diagnostic = wait_diagnostic.unwrap_or_else(|| {
        String::from_utf8_lossy(&stderr_result.captured.unwrap_or_default()).into_owned()
    });
    GuestDnsReadinessOutput {
        termination,
        duration_ms: elapsed_ms(started),
        answer,
        output_truncated: stdout_result.capture_truncated || stderr_result.capture_truncated,
        diagnostic: truncate_utf8(diagnostic, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES),
    }
}

fn failed_output(
    termination: GuestDnsReadinessTermination,
    started: Instant,
    diagnostic: String,
) -> GuestDnsReadinessOutput {
    GuestDnsReadinessOutput {
        termination,
        duration_ms: elapsed_ms(started),
        answer: Vec::new(),
        output_truncated: false,
        diagnostic: truncate_utf8(diagnostic, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES),
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
