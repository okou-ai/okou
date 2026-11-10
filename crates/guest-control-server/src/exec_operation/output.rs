//! Exec output policy, framing and bounded pipe delivery.
//!
//! The parent lifecycle retains process/drain handles and chooses cancellation,
//! physical join and ownership-release phases. Output callbacks never replace them.

use std::io;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;

use guest_control_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination,
};

use crate::drain::{
    BoundedDrainResult, BoundedStreamConfig, DrainCancellation, drain_bounded_cancellable,
};
use crate::error::to_io_error;
use crate::log::log;
use crate::threading::ThreadSpawner;
use crate::writer::GuestWriter;

pub(super) const THREAD_EXEC_OPERATION_STDOUT: &str = "gctl-exec-out";
pub(super) const THREAD_EXEC_OPERATION_STDERR: &str = "gctl-exec-err";
const FRAME_BODY_HEADER_LEN: usize = 1 + 4; // message type + sequence
const EXEC_OUTPUT_PAYLOAD_OVERHEAD: usize = 1 + 4 + 1 + 4;
const EXEC_RESULT_EXITED_LEN: usize = 1 + 4;
const EXEC_RESULT_DURATION_LEN: usize = 4;
const EXEC_RESULT_DIAGNOSTIC_LEN_FIELD: usize = 2;
const EXEC_RESULT_MAX_DIAGNOSTIC_BYTES: usize = u16::MAX as usize;
const EXEC_CAPTURED_OUTPUT_OVERHEAD: usize = 1 + 1 + 4;
const EXEC_DISCARDED_OUTPUT_LEN: usize = 1;

pub(super) struct DrainWorker {
    pub(super) stream: ExecOutputStream,
    pub(super) policy: OutputSettings,
    pub(super) stream_writer: Option<SharedExecStreamWriter>,
    pub(super) drain_cancel: Arc<DrainCancellation>,
    pub(super) exec_cancel: Arc<AtomicBool>,
    pub(super) drain_done_tx: mpsc::Sender<()>,
}

pub(super) type SharedExecStreamWriter = Arc<Mutex<ExecStreamWriter>>;

pub(super) struct ExecStreamWriter {
    seq: u32,
    label_preview: String,
    writer: GuestWriter,
    output_seq: u32,
    frame: Vec<u8>,
    process_class: &'static str,
    operation_kind: &'static str,
}

impl ExecStreamWriter {
    pub(super) fn new(
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

#[derive(Clone, Copy)]
pub(super) struct OutputSettings {
    capture_limit_bytes: Option<usize>,
    pub(super) stream: Option<BoundedStreamConfig>,
}

pub(super) struct ExecResultFrame<'a> {
    pub(super) seq: u32,
    pub(super) termination: ExecTermination,
    pub(super) duration_ms: u32,
    pub(super) stdout: ExecCapturedOutput<'a>,
    pub(super) stderr: ExecCapturedOutput<'a>,
    pub(super) diagnostic: &'a str,
}

pub(super) fn finalize_exec_drain_result(
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

pub(super) fn emit_exec_stream_truncation_markers(
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

pub(super) fn validate_output_policies(
    stdout_policy: ExecOutputPolicy,
    stderr_policy: ExecOutputPolicy,
) -> Result<(), String> {
    let stdout_capture = capture_limit_bytes(stdout_policy);
    let stderr_capture = capture_limit_bytes(stderr_policy);
    let capture_total = stdout_capture
        .unwrap_or(0)
        .checked_add(stderr_capture.unwrap_or(0))
        .ok_or_else(|| "exec capture limits overflow".to_string())?;
    let capture_budget = exec_result_capture_budget(stdout_policy, stderr_policy);
    if capture_total > capture_budget {
        return Err(format!(
            "exec capture limits exceed protocol result frame budget: {capture_total} > {capture_budget}"
        ));
    }

    let max_chunk = guest_control_proto::MAX_MESSAGE_SIZE
        .saturating_sub(FRAME_BODY_HEADER_LEN)
        .saturating_sub(EXEC_OUTPUT_PAYLOAD_OVERHEAD);
    for (name, policy) in [("stdout", stdout_policy), ("stderr", stderr_policy)] {
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

pub(super) fn output_settings(policy: ExecOutputPolicy) -> OutputSettings {
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

pub(super) fn spawn_exec_operation_drain<R, S>(
    pipe: R,
    worker: DrainWorker,
    spawner: S,
) -> io::Result<JoinHandle<BoundedDrainResult>>
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
    let thread_name = match stream {
        ExecOutputStream::Stdout => THREAD_EXEC_OPERATION_STDOUT,
        ExecOutputStream::Stderr => THREAD_EXEC_OPERATION_STDERR,
    };
    spawner.spawn(
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
            let _ = drain_done_tx.send(());
            result
        }),
    )
}

pub(super) fn send_exec_result_after_lock<F>(
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

pub(super) fn empty_output_for_policy(policy: ExecOutputPolicy) -> ExecCapturedOutput<'static> {
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
