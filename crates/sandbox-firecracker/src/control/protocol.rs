use std::io;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// Request from a `runner exec` client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExecRequest {
    /// Full run identity that must still own the sandbox at guest admission.
    ///
    /// Missing means the caller intentionally selected sandbox scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) expected_run_id: Option<String>,
    /// Command text to execute inside the guest.
    pub(super) command: String,
    /// Command timeout in seconds.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// 30 seconds.
    #[serde(default = "default_timeout")]
    pub(super) timeout_secs: u32,
    /// Whether to request sudo execution inside the guest.
    ///
    /// When this field is omitted during JSON deserialization, it defaults to
    /// `false`. The guest command runner decides how sudo is applied.
    #[serde(default)]
    pub(super) sudo: bool,
}

fn default_timeout() -> u32 {
    30
}

/// Host-side control action requested over the local control socket.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateAction {
    /// Request host-side sandbox termination.
    ///
    /// This variant serializes as `"terminate"` in the request action field.
    Terminate,
}

/// Request from a host-side termination client.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminateRequest {
    /// Requested host-side control action.
    ///
    /// Sandbox-scoped termination clients send `{"action":"terminate"}`.
    pub action: TerminateAction,
    /// Full run identity that must still own the sandbox at termination
    /// admission. Missing means intentionally sandbox-scoped termination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<String>,
}

/// Result status for a host-side termination request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminateStatus {
    /// The sandbox owner accepted and acknowledged the termination request.
    ///
    /// This status serializes as `"accepted"`.
    Accepted,
    /// The sandbox owner or termination path is already stopped or unavailable.
    ///
    /// Callers may treat this as an idempotent stopped outcome. This status
    /// serializes as `"already_stopped"`.
    AlreadyStopped,
    /// The sandbox is parked in idle ownership; direct process termination
    /// would leave runner-owned idle resources retained.
    ///
    /// This status serializes as `"refused_idle"`.
    RefusedIdle,
}

/// Response to a host-side termination client.
///
/// This enum is serialized without a tag. Clients should distinguish variants
/// by shape: a status response contains a `status` field, while an error
/// response contains only an `error` string.
/// Unknown fields are rejected so mixed status/error shapes fail closed.
#[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum TerminateResponse {
    /// Termination request completed with a status result.
    ///
    /// This variant serializes as `{"status":"..."}`, for example
    /// `{"status":"accepted"}`.
    Status {
        /// Status describing how the termination request was handled.
        status: TerminateStatus,
    },
    /// Request failed before a termination status could be returned.
    ///
    /// This variant serializes as `{"error":"..."}`.
    Error {
        /// Human-readable error message for operators and clients.
        error: String,
    },
}

/// Maximum frame payload size: 64 MiB, excluding the 4-byte length prefix.
pub(super) const MAX_FRAME_PAYLOAD_SIZE: u32 = 64 * 1024 * 1024;

fn frame_payload_len_error(len: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("frame too large: {len} bytes"),
    )
}

pub(super) fn validate_frame_payload_len(len: usize) -> io::Result<u32> {
    if len > MAX_FRAME_PAYLOAD_SIZE as usize {
        return Err(frame_payload_len_error(len));
    }

    Ok(len as u32)
}

/// Read a length-prefixed frame from the stream.
pub(super) async fn read_frame(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    let len = read_frame_payload_len(stream).await?;
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Read and validate a frame payload length without allocating its payload.
pub(super) async fn read_frame_payload_len(stream: &mut UnixStream) -> io::Result<usize> {
    let len = stream.read_u32().await? as usize;
    validate_frame_payload_len(len)?;
    Ok(len)
}

/// Write a length-prefixed frame to the stream.
pub(super) async fn write_frame(stream: &mut UnixStream, data: &[u8]) -> io::Result<()> {
    write_frame_payload_len(stream, data.len()).await?;
    stream.write_all(data).await?;
    stream.flush().await?;
    Ok(())
}

/// Validate and write a frame payload length without requiring a contiguous payload.
pub(super) async fn write_frame_payload_len(stream: &mut UnixStream, len: usize) -> io::Result<()> {
    stream.write_u32(validate_frame_payload_len(len)?).await
}

#[cfg(test)]
mod tests;
