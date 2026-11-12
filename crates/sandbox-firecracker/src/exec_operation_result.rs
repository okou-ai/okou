use std::io;

use guest_control_client::{ExecOperationResult, ExecOwnedCapturedOutput};

/// Owned buffered output after the complete exec capture contract is validated.
pub(crate) struct CapturedExecResult {
    pub(crate) termination: guest_control_proto::ExecTermination,
    pub(crate) duration_ms: u32,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) diagnostic: String,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

pub(crate) fn captured_exec_result(result: ExecOperationResult) -> io::Result<CapturedExecResult> {
    reject_stream_overflow(&result)?;
    let (stdout, stdout_truncated) = captured_exec_output_bytes("stdout", result.stdout)?;
    let (stderr, stderr_truncated) = captured_exec_output_bytes("stderr", result.stderr)?;

    Ok(CapturedExecResult {
        termination: result.termination,
        duration_ms: result.duration_ms,
        stdout,
        stderr,
        diagnostic: result.diagnostic,
        stdout_truncated,
        stderr_truncated,
    })
}

pub(crate) fn validate_exec_capture_timeout(timeout_ms: u32) -> io::Result<()> {
    if timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec requires a positive timeout; use supervised exec for unbounded commands",
        ));
    }

    Ok(())
}

fn reject_stream_overflow(result: &ExecOperationResult) -> io::Result<()> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec capture unexpectedly overflowed a stream queue",
        ));
    }

    Ok(())
}

fn captured_exec_output_bytes(
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("exec result discarded {name} for capture request"),
        )),
    }
}

pub(crate) fn exec_termination_from_vsock_termination(
    termination: guest_control_proto::ExecTermination,
) -> sandbox::ExecTermination {
    match termination {
        guest_control_proto::ExecTermination::Exited { exit_code } => {
            sandbox::ExecTermination::Exited { exit_code }
        }
        guest_control_proto::ExecTermination::TimedOut => sandbox::ExecTermination::TimedOut,
        guest_control_proto::ExecTermination::Cancelled => sandbox::ExecTermination::Cancelled,
        guest_control_proto::ExecTermination::StartFailed => sandbox::ExecTermination::StartFailed,
        guest_control_proto::ExecTermination::WaitFailed => sandbox::ExecTermination::WaitFailed,
    }
}
