use std::io;
use std::time::Duration;

use guest_control_proto::ExecTermination;

use crate::{
    ExecCaptureRequest, ExecOperationResult, ExecOwnedCapturedOutput, FrameWriteObserver,
    GuestControlClient, exec_operation,
};

use super::{
    MISSING_FILE_EXIT_CODE, normalize_file_exec_stderr, read_regular_file_command,
    validate_guest_file_path,
};

fn read_exec_output(
    path: &str,
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("read_file result for {path} discarded {name} capture"),
        )),
    }
}

fn read_terminal_error_message(prefix: String, stderr: &[u8], diagnostic: &str) -> String {
    let mut details = Vec::new();
    if !stderr.is_empty() {
        details.push(format!("stderr: {}", String::from_utf8_lossy(stderr)));
    }
    if !diagnostic.is_empty() {
        details.push(format!("diagnostic: {diagnostic}"));
    }
    if details.is_empty() {
        prefix
    } else {
        format!("{prefix}: {}", details.join("; "))
    }
}

fn validate_read_exec_result(
    path: &str,
    max_bytes: u64,
    result: ExecOperationResult,
) -> io::Result<Option<Vec<u8>>> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "read_file exec operation unexpectedly overflowed a stream queue",
        ));
    }

    let ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;
    let (stdout, stdout_truncated) = read_exec_output(path, "stdout", stdout)?;
    let (stderr, stderr_truncated) = read_exec_output(path, "stderr", stderr)?;

    let stderr = normalize_file_exec_stderr(stderr, stderr_truncated);
    match termination {
        ExecTermination::Exited {
            exit_code: MISSING_FILE_EXIT_CODE,
        } => {
            if stdout_truncated || !stdout.is_empty() {
                let stdout_detail = if stdout_truncated {
                    "stdout truncated"
                } else {
                    "stdout"
                };
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("read_file missing result for {path} included {stdout_detail}"),
                ));
            }
            if !stderr.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "read_file missing result for {path} included stderr: {}",
                        String::from_utf8_lossy(&stderr)
                    ),
                ));
            }
            Ok(None)
        }
        ExecTermination::Exited { exit_code: 0 } => {
            if stdout_truncated {
                return Err(io::Error::other(format!(
                    "file {path} exceeded {max_bytes} bytes"
                )));
            }
            if !stderr.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "read_file result for {path} included stderr: {}",
                        String::from_utf8_lossy(&stderr)
                    ),
                ));
            }
            Ok(Some(stdout))
        }
        ExecTermination::Exited { exit_code: _ } => Err(io::Error::other(format!(
            "failed to read file {path}: {}",
            String::from_utf8_lossy(&stderr)
        ))),
        ExecTermination::TimedOut => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            read_terminal_error_message(
                format!("read_file timed out for {path}"),
                &stderr,
                &diagnostic,
            ),
        )),
        ExecTermination::Cancelled => Err(io::Error::other(read_terminal_error_message(
            format!("read_file was cancelled for {path}"),
            &stderr,
            &diagnostic,
        ))),
        ExecTermination::StartFailed => Err(io::Error::other(read_terminal_error_message(
            format!("read_file exec start failed for {path}"),
            &stderr,
            &diagnostic,
        ))),
        ExecTermination::WaitFailed => Err(io::Error::other(read_terminal_error_message(
            format!("read_file exec wait failed for {path}"),
            &stderr,
            &diagnostic,
        ))),
    }
}

impl GuestControlClient {
    /// Read a small file from the guest through exec capture.
    ///
    /// The guest path must be non-empty and must not contain NUL bytes.
    /// `max_bytes` must be positive and fit within the exec capture limit.
    /// `timeout_ms` must be positive.
    ///
    /// Returns `Ok(None)` when the guest-side check cannot establish that the
    /// path resolves to a regular file. This includes missing paths, paths to
    /// non-regular filesystem objects, broken symlinks, and paths whose
    /// filesystem metadata cannot be inspected. Symlinks that resolve to
    /// regular files are followed and read.
    ///
    /// A failed read is checked again and can return `Ok(None)` if
    /// regular-file status can no longer be established. Invalid input, exec
    /// or capture failures, and read failures for a path still established as
    /// regular return an error. Files larger than `max_bytes` return an error
    /// instead of silently returning truncated bytes. The helper reads at most
    /// `max_bytes + 1` bytes to detect oversized files without reading to EOF.
    pub async fn read_file(
        &self,
        path: &str,
        max_bytes: u64,
        timeout_ms: u32,
    ) -> io::Result<Option<Vec<u8>>> {
        self.read_file_with_write_observer(
            path,
            max_bytes,
            timeout_ms,
            FrameWriteObserver::default(),
        )
        .await
    }

    /// Read a small file and report when the helper exec frame is about to be
    /// written to the guest.
    ///
    /// This has the same path classification, read, and input validation
    /// semantics as [`read_file`](Self::read_file).
    pub async fn read_file_with_write_observer(
        &self,
        path: &str,
        max_bytes: u64,
        timeout_ms: u32,
        write_observer: FrameWriteObserver,
    ) -> io::Result<Option<Vec<u8>>> {
        validate_guest_file_path(path)?;
        let stdout_limit_bytes = u32::try_from(max_bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "read_file max_bytes exceeds exec capture limit",
            )
        })?;
        if stdout_limit_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "read_file max_bytes must be positive",
            ));
        }

        let command =
            read_regular_file_command(path, MISSING_FILE_EXIT_CODE, Some(stdout_limit_bytes));
        let result = exec_operation::exec_operation_capture_on_shared_with_write_observer(
            &self.shared,
            ExecCaptureRequest {
                timeout_ms,
                command: &command,
                env: &[],
                sudo: false,
                label: "read-file",
                stdout_limit_bytes,
                stderr_limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
                expected_exit_codes: &[MISSING_FILE_EXIT_CODE],
                stdin_bytes: None,
                wait_timeout: Duration::from_millis(timeout_ms as u64 + 5000),
            },
            write_observer,
        )
        .await?;
        validate_read_exec_result(path, max_bytes, result)
    }
}
