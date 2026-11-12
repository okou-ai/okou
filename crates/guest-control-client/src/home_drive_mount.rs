use std::io;
use std::time::Duration;

use guest_control_proto::{
    ExecTermination, MSG_ERROR, MSG_HOME_DRIVE_MOUNT_RESULT, decode_home_drive_mount_result,
    encode_home_drive_mount_request_frame_into,
};

use crate::helper_output::owned_capture;
use crate::{
    FrameWriteObserver, GuestControlClient,
    normal_request_on_shared_with_write_observer_frame_builder, validate_fixed_helper_response,
};

const TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_HOME_DRIVE_MOUNT_RESULT];

/// Owned result of the fixed home-drive mount helper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HomeDriveMountResult {
    /// Terminal process state.
    pub termination: ExecTermination,
    /// Guest-observed helper duration in milliseconds.
    pub duration_ms: u32,
    /// Retained helper stdout bytes.
    pub stdout: Vec<u8>,
    /// Retained helper stderr bytes.
    pub stderr: Vec<u8>,
    /// Whether stdout exceeded its fixed capture bound.
    pub stdout_truncated: bool,
    /// Whether stderr exceeded its fixed capture bound.
    pub stderr_truncated: bool,
    /// Bounded process or internal diagnostic.
    pub diagnostic: String,
}

impl GuestControlClient {
    /// Mount the fixed home drive through the guest-owned helper.
    ///
    /// The request contains no caller input. The guest selects the program,
    /// command, root identity, paths, timeout, output bounds, containment, and
    /// cleanup. `request_timeout` bounds request write and terminal-result wait.
    ///
    /// This is a tracked normal operation. Timing out or dropping the request
    /// after its possible guest-write boundary abandons terminal proof, and any
    /// late terminal result is ignored. The connection is then not safe to park
    /// or reuse for future normal operations; callers must close or discard it
    /// instead of retrying parking or normal operations. Closing the connection
    /// cancels and reaps the guest-owned mount helper process group.
    pub async fn mount_home_drive(
        &self,
        request_timeout: Duration,
    ) -> io::Result<HomeDriveMountResult> {
        let response = normal_request_on_shared_with_write_observer_frame_builder(
            &self.shared,
            TERMINAL_MSG_TYPES,
            request_timeout,
            FrameWriteObserver::noop(),
            |seq, frame| {
                encode_home_drive_mount_request_frame_into(frame, seq)
                    .map_err(protocol_invalid_input)
            },
        )
        .await?;

        decode_result(response)
    }

    /// Run only a fixed Home filesystem operation while retaining exclusive
    /// normal-operation admission. The fence must belong to this connection.
    pub async fn home_drive_operation_with_fence(
        &self,
        fence: &crate::NormalOperationFence,
        operation: guest_control_proto::HomeDriveOperation,
        request_timeout: Duration,
    ) -> io::Result<HomeDriveMountResult> {
        let token = self
            .shared
            .normal_operations
            .reserve_under_fence(&fence._inner)
            .map_err(|error| {
                io::Error::other(format!("home operation fence rejected: {error:?}"))
            })?;
        let mut tracked = crate::CompositeNormalOperation::from_token(token);
        let response =
            crate::request_on_shared_with_composite_operation_and_observer_frame_builder(
                &self.shared,
                TERMINAL_MSG_TYPES,
                request_timeout,
                &mut tracked,
                FrameWriteObserver::noop(),
                |seq, frame| {
                    guest_control_proto::encode_home_drive_operation_frame_into(
                        frame, seq, operation,
                    )
                    .map_err(protocol_invalid_input)
                },
            )
            .await?;
        tracked.complete()?;
        decode_result(response)
    }
}

fn decode_result(response: guest_control_proto::RawMessage) -> io::Result<HomeDriveMountResult> {
    validate_fixed_helper_response(&response, MSG_HOME_DRIVE_MOUNT_RESULT, "home drive mount")?;

    let decoded =
        decode_home_drive_mount_result(&response.payload).map_err(protocol_invalid_data)?;
    let (stdout, stdout_truncated) = owned_capture(decoded.stdout, "home drive mount", "stdout")?;
    let (stderr, stderr_truncated) = owned_capture(decoded.stderr, "home drive mount", "stderr")?;
    Ok(HomeDriveMountResult {
        termination: decoded.termination,
        duration_ms: decoded.duration_ms,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    })
}

fn protocol_invalid_input(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
