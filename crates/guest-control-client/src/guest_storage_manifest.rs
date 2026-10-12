use guest_contracts::storage_resources::StorageResourceUsage;
use sandbox::StorageManifestRequestTiming;
use std::io;
use std::time::{Duration, Instant};

use guest_control_proto::{
    ExecCapturedOutput, ExecTermination, MSG_ERROR, MSG_GUEST_STORAGE_MANIFEST_RESULT, RawMessage,
    decode_guest_storage_manifest_result, encode_guest_storage_manifest_request_frame_into,
};

use crate::{
    FrameWriteObserver, GuestControlClient, normal_request_on_shared_with_timing_frame_builder,
};

const TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_GUEST_STORAGE_MANIFEST_RESULT];

/// Owned result of the fixed guest storage-manifest helper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestStorageManifestResult {
    /// Validated optional resource evidence, never helper output or an error.
    pub resources: Option<StorageResourceUsage>,
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

impl GuestStorageManifestResult {
    /// Record validated resource evidence with its host-owned sandbox identity.
    /// Missing terminal evidence produces no fabricated zero-usage event.
    pub fn log_resources(&self, sandbox_id: &str) {
        if let Some(resources) = &self.resources
            && let Ok(resources) = serde_json::to_string(resources)
        {
            tracing::info!(
                id = %sandbox_id,
                resources = %resources,
                "storage apply resources"
            );
        }
    }
}

impl GuestControlClient {
    /// Apply canonical manifest bytes through the fixed guest storage helper.
    ///
    /// The guest chooses the executable, argument, identity, containment, and
    /// output bounds. `request_timeout` covers request encoding/write and the
    /// terminal-result wait. This is a tracked normal operation; abandoning it
    /// after the write boundary makes the connection non-parkable.
    pub async fn guest_storage_manifest(
        &self,
        manifest_json: &[u8],
        run_id: &str,
        runtime_dir: &str,
        process_timeout_ms: u32,
        request_timeout: Duration,
    ) -> io::Result<GuestStorageManifestResult> {
        self.guest_storage_manifest_inner(
            manifest_json,
            run_id,
            runtime_dir,
            process_timeout_ms,
            request_timeout,
            None,
        )
        .await
    }

    /// Apply the same request while retaining fixed, content-free Host phases.
    ///
    /// The record is reset at entry. Completed attempts survive returned errors;
    /// unobserved phases remain absent. Observations do not change the deadline,
    /// normal-operation ownership, result, or partial-write cancellation policy.
    pub async fn guest_storage_manifest_with_timing(
        &self,
        manifest_json: &[u8],
        run_id: &str,
        runtime_dir: &str,
        process_timeout_ms: u32,
        request_timeout: Duration,
        timing: &mut StorageManifestRequestTiming,
    ) -> io::Result<GuestStorageManifestResult> {
        *timing = StorageManifestRequestTiming::default();
        self.guest_storage_manifest_inner(
            manifest_json,
            run_id,
            runtime_dir,
            process_timeout_ms,
            request_timeout,
            Some(timing),
        )
        .await
    }

    async fn guest_storage_manifest_inner(
        &self,
        manifest_json: &[u8],
        run_id: &str,
        runtime_dir: &str,
        process_timeout_ms: u32,
        request_timeout: Duration,
        mut timing: Option<&mut StorageManifestRequestTiming>,
    ) -> io::Result<GuestStorageManifestResult> {
        let response = normal_request_on_shared_with_timing_frame_builder(
            &self.shared,
            TERMINAL_MSG_TYPES,
            request_timeout,
            FrameWriteObserver::noop(),
            |seq, frame| {
                encode_guest_storage_manifest_request_frame_into(
                    frame,
                    seq,
                    process_timeout_ms,
                    run_id,
                    runtime_dir,
                    manifest_json,
                )
                .map_err(protocol_invalid_input)
            },
            timing.as_deref_mut(),
        )
        .await?;

        let decode_started = timing.as_ref().map(|_| Instant::now());
        let result = decode_storage_manifest_response(response, run_id);
        if let (Some(timing), Some(started)) = (timing, decode_started) {
            timing.result_decode = Some(started.elapsed());
        }
        result
    }
}

fn decode_storage_manifest_response(
    response: RawMessage,
    run_id: &str,
) -> io::Result<GuestStorageManifestResult> {
    if response.msg_type == MSG_ERROR {
        let message =
            guest_control_proto::decode_error(&response.payload).map_err(protocol_invalid_data)?;
        return Err(io::Error::other(message.to_owned()));
    }
    if response.msg_type != MSG_GUEST_STORAGE_MANIFEST_RESULT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unexpected guest storage manifest response type: 0x{:02X}",
                response.msg_type
            ),
        ));
    }

    let decoded =
        decode_guest_storage_manifest_result(&response.payload).map_err(protocol_invalid_data)?;
    let resources = if decoded.resource_summary.is_empty() {
        None
    } else {
        match serde_json::from_slice::<StorageResourceUsage>(decoded.resource_summary) {
            Ok(resources) if resources.matches_request(run_id, response.seq) => Some(resources),
            _ => {
                // Optional evidence cannot fail a valid core result. Never
                // log raw peer bytes or parser errors containing those bytes.
                tracing::warn!(
                    request_seq = response.seq,
                    "storage resource summary unavailable: invalid metadata"
                );
                None
            }
        }
    };
    let decoded = decoded.result;
    let (stdout, stdout_truncated) = owned_capture(decoded.stdout, "stdout")?;
    let (stderr, stderr_truncated) = owned_capture(decoded.stderr, "stderr")?;
    Ok(GuestStorageManifestResult {
        resources,
        termination: decoded.termination,
        duration_ms: decoded.duration_ms,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        diagnostic: decoded.diagnostic.to_owned(),
    })
}

fn owned_capture(output: ExecCapturedOutput<'_>, name: &str) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecCapturedOutput::Captured { bytes, truncated } => Ok((bytes.to_vec(), truncated)),
        ExecCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("guest storage manifest result discarded {name}"),
        )),
    }
}

fn protocol_invalid_input(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
