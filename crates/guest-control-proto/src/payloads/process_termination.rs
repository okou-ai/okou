use crate::ProtocolError;
use crate::read::{read_i32, read_u8};

const TERMINATION_EXITED: u8 = 0x00;
const TERMINATION_TIMED_OUT: u8 = 0x01;
pub(super) const TERMINATION_CANCELLED: u8 = 0x02;
const TERMINATION_START_FAILED: u8 = 0x03;
const TERMINATION_WAIT_FAILED: u8 = 0x04;

/// Guest process terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTermination {
    /// Process exited with an exit status.
    Exited {
        /// Signed process exit code reported by the guest, with signals
        /// represented as `128 + signal`.
        exit_code: i32,
    },
    /// Operation timed out before completion.
    TimedOut,
    /// Operation was cancelled before completion.
    Cancelled,
    /// Guest failed to start the process.
    StartFailed,
    /// Guest failed while waiting for the process to finish.
    WaitFailed,
}

pub(super) struct TerminationDecodeErrors {
    pub(super) termination_truncated: &'static str,
    pub(super) exit_code_truncated: &'static str,
    pub(super) invalid_tag: &'static str,
}

pub(super) fn termination_encoded_len(termination: ExecTermination) -> usize {
    match termination {
        ExecTermination::Exited { .. } => 5,
        ExecTermination::TimedOut
        | ExecTermination::Cancelled
        | ExecTermination::StartFailed
        | ExecTermination::WaitFailed => 1,
    }
}

pub(super) fn append_termination(payload: &mut Vec<u8>, termination: ExecTermination) {
    match termination {
        ExecTermination::Exited { exit_code } => {
            payload.push(TERMINATION_EXITED);
            payload.extend_from_slice(&exit_code.to_be_bytes());
        }
        ExecTermination::TimedOut => payload.push(TERMINATION_TIMED_OUT),
        ExecTermination::Cancelled => payload.push(TERMINATION_CANCELLED),
        ExecTermination::StartFailed => payload.push(TERMINATION_START_FAILED),
        ExecTermination::WaitFailed => payload.push(TERMINATION_WAIT_FAILED),
    }
}

pub(super) fn decode_termination(
    payload: &[u8],
    offset: &mut usize,
    errors: TerminationDecodeErrors,
) -> Result<ExecTermination, ProtocolError> {
    match read_u8(payload, offset, errors.termination_truncated)? {
        TERMINATION_EXITED => Ok(ExecTermination::Exited {
            exit_code: read_i32(payload, offset, errors.exit_code_truncated)?,
        }),
        TERMINATION_TIMED_OUT => Ok(ExecTermination::TimedOut),
        TERMINATION_CANCELLED => Ok(ExecTermination::Cancelled),
        TERMINATION_START_FAILED => Ok(ExecTermination::StartFailed),
        TERMINATION_WAIT_FAILED => Ok(ExecTermination::WaitFailed),
        _ => Err(ProtocolError::InvalidPayload(errors.invalid_tag)),
    }
}

#[cfg(test)]
mod tests;
