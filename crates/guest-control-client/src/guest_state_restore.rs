use std::io;
use std::time::Duration;

use guest_control_proto::{
    DecodedGuestStateRestoreRequest, ExecTermination, GuestStateRestoreTimezone, MSG_ERROR,
    MSG_GUEST_STATE_RESTORE_RESULT, decode_guest_state_restore_result,
    encode_guest_state_restore_frame,
};

use crate::helper_output::owned_capture;
use crate::protocol_error;
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
        self.guest_state_restore_request(
            DecodedGuestStateRestoreRequest {
                timeout_ms: process_timeout_ms,
                unix_seconds,
                unix_nanoseconds,
                entropy,
                timezone,
                instruction_check: None,
            },
            request_timeout,
        )
        .await
    }

    /// Restore state and optionally check the prepared Home's Instructions.
    pub async fn guest_state_restore_request(
        &self,
        request: DecodedGuestStateRestoreRequest<'_>,
        request_timeout: Duration,
    ) -> io::Result<GuestStateRestoreResult> {
        let response = normal_request_on_shared_with_write_observer_frame_builder(
            &self.shared,
            TERMINAL_MSG_TYPES,
            request_timeout,
            FrameWriteObserver::noop(),
            |seq, frame| {
                encode_guest_state_restore_frame(frame, seq, request)
                    .map_err(protocol_error::invalid_input)
            },
        )
        .await?;

        validate_fixed_helper_response(
            &response,
            MSG_GUEST_STATE_RESTORE_RESULT,
            "guest state restore",
        )?;

        let decoded = decode_guest_state_restore_result(&response.payload)
            .map_err(protocol_error::invalid_data)?;
        let (stderr, stderr_truncated) =
            owned_capture(decoded.stderr, "guest state restore", "stderr")?;
        Ok(GuestStateRestoreResult {
            termination: decoded.termination,
            duration_ms: decoded.duration_ms,
            stderr,
            stderr_truncated,
            diagnostic: decoded.diagnostic.to_owned(),
        })
    }
}
