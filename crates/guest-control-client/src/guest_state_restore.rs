use std::io;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, GuestStateRestoreTimezone, MSG_ERROR,
    MSG_GUEST_STATE_RESTORE_RESULT, decode_guest_state_restore_result,
    encode_guest_state_restore_request_frame_into,
};

use crate::{
    FrameWriteObserver, GuestControlClient,
    normal_request_on_shared_with_write_observer_frame_builder, validate_fixed_helper_response,
};

const TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_GUEST_STATE_RESTORE_RESULT];

/// Owned result of the fixed guest-state restore helper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestStateRestoreResult {
    /// Terminal process state.
    pub termination: ExecTermination,
    /// Guest-observed helper duration in milliseconds.
    pub duration_ms: u32,
    /// Retained helper stderr bytes.
    pub stderr: Vec<u8>,
    /// Whether stderr exceeded its fixed capture bound.
    pub stderr_truncated: bool,
    /// Bounded process or internal diagnostic.
    pub diagnostic: String,
}

impl GuestControlClient {
    /// Restore snapshot-sensitive clock, CRNG, and optional timezone state.
    ///
    /// The guest chooses the executable, argv shape, root identity,
    /// containment, and output bounds. `request_timeout` covers request
    /// encoding/write and the terminal-result wait. This is a tracked normal
    /// operation; abandoning it after the write boundary makes the connection
    /// non-parkable.
    pub async fn guest_state_restore(
        &self,
        unix_seconds: u64,
        unix_nanoseconds: u32,
        entropy: &[u8],
        timezone: GuestStateRestoreTimezone<'_>,
        process_timeout_ms: u32,
        request_timeout: Duration,
    ) -> io::Result<GuestStateRestoreResult> {
        let response = normal_request_on_shared_with_write_observer_frame_builder(
            &self.shared,
            TERMINAL_MSG_TYPES,
            request_timeout,
            FrameWriteObserver::noop(),
            |seq, frame| {
                encode_guest_state_restore_request_frame_into(
                    frame,
                    seq,
                    process_timeout_ms,
                    unix_seconds,
                    unix_nanoseconds,
                    entropy,
                    timezone,
                )
                .map_err(protocol_invalid_input)
            },
        )
        .await?;

        validate_fixed_helper_response(
            &response,
            MSG_GUEST_STATE_RESTORE_RESULT,
            "guest state restore",
        )?;

        let decoded =
            decode_guest_state_restore_result(&response.payload).map_err(protocol_invalid_data)?;
        let (stderr, stderr_truncated) = owned_capture(decoded.stderr)?;
        Ok(GuestStateRestoreResult {
            termination: decoded.termination,
            duration_ms: decoded.duration_ms,
            stderr,
            stderr_truncated,
            diagnostic: decoded.diagnostic.to_owned(),
        })
    }
}

fn owned_capture(output: ExecCapturedOutput<'_>) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecCapturedOutput::Captured { bytes, truncated } => Ok((bytes.to_vec(), truncated)),
        ExecCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "guest state restore result discarded stderr",
        )),
    }
}

fn protocol_invalid_input(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
