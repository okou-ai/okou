use std::path::Path;

use crate::ProtocolError;
use crate::frame::encode_into;
use crate::payloads::exec_operation::encode_exec_result_frame_into_with_prefix;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_len, ensure_u32_len,
    expect_consumed, read_slice, read_str, read_u16, read_u32,
};
use crate::wire::{MSG_GUEST_STORAGE_MANIFEST, MSG_GUEST_STORAGE_MANIFEST_RESULT};
use crate::{DecodedExecResult, ExecCapturedOutput, MAX_EXEC_STDIN_BYTES};

/// Maximum encoded run-id length accepted by the fixed storage operation.
pub const GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES: usize = 256;

/// Maximum encoded guest runtime-directory length accepted by the operation.
pub const GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES: usize = 4 * 1024;

/// Fixed stdout/stderr capture bound for the storage helper.
pub const GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;

/// Maximum optional JSON resource summary, separate from helper output/errors.
pub const GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES: usize = 4 * 1024;

/// Dedicated storage result with bounded optional resource evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestStorageManifestResult<'a> {
    /// Original terminal process metadata and captured helper output.
    pub result: DecodedExecResult<'a>,
    /// Optional resource JSON; empty means unavailable. Typed validation belongs
    /// to the host consumer and cannot change the core operation outcome.
    pub resource_summary: &'a [u8],
}

/// Decoded fixed guest storage-manifest request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedGuestStorageManifestRequest<'a> {
    /// Positive child-process timeout in milliseconds.
    pub timeout_ms: u32,
    /// Run identity exposed to the fixed helper.
    pub run_id: &'a str,
    /// Absolute guest runtime directory exposed to the fixed helper.
    pub runtime_dir: &'a str,
    /// Canonical JSON or explicitly framed decoded-files input for the fixed helper.
    pub manifest_json: &'a [u8],
}

/// Encode a fixed guest storage-manifest request payload.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `timeout_ms` is zero, `run_id` is empty,
/// contains a NUL byte, or exceeds [`GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES`]
/// bytes; if `runtime_dir` is empty, is not absolute, contains a NUL byte, or
/// exceeds [`GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES`] bytes; if
/// JSON exceeds [`MAX_EXEC_STDIN_BYTES`] bytes or a binary storage-files input
/// violates its separate bounded framing; if an encoded field
/// does not fit its wire length field; or if the encoded payload exceeds the
/// maximum protocol message size. String limits are measured in UTF-8 bytes,
/// not characters.
pub fn encode_guest_storage_manifest_request(
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let lengths = validate_request(timeout_ms, run_id, runtime_dir, manifest_json)?;
    let payload_len = request_payload_len(run_id, runtime_dir, manifest_json)?;
    let mut payload = Vec::with_capacity(payload_len);
    append_request_payload(
        &mut payload,
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
        lengths,
    );
    Ok(payload)
}

/// Encode a full fixed guest storage-manifest request frame into `frame`.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `timeout_ms` is zero, `run_id` is empty,
/// contains a NUL byte, or exceeds [`GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES`]
/// bytes; if `runtime_dir` is empty, is not absolute, contains a NUL byte, or
/// exceeds [`GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES`] bytes; if
/// JSON exceeds [`MAX_EXEC_STDIN_BYTES`] bytes or a binary storage-files input
/// violates its separate bounded framing; if an encoded field
/// does not fit its wire length field; or if the encoded payload exceeds the
/// maximum protocol message size. String limits are measured in UTF-8 bytes,
/// not characters.
///
/// Request validation runs before the shared frame encoder clears `frame`, so
/// validation errors leave the destination unchanged. After validation
/// succeeds, the shared frame encoder clears `frame` before checking the frame
/// size and writing the encoded bytes.
pub fn encode_guest_storage_manifest_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) -> Result<(), ProtocolError> {
    let lengths = validate_request(timeout_ms, run_id, runtime_dir, manifest_json)?;
    let payload_len = request_payload_len(run_id, runtime_dir, manifest_json)?;
    encode_into(
        frame,
        MSG_GUEST_STORAGE_MANIFEST,
        seq,
        payload_len,
        |frame| {
            append_request_payload(
                frame,
                timeout_ms,
                run_id,
                runtime_dir,
                manifest_json,
                lengths,
            )
        },
    )
}

/// Decode a fixed guest storage-manifest request payload.
pub fn decode_guest_storage_manifest_request(
    payload: &[u8],
) -> Result<DecodedGuestStorageManifestRequest<'_>, ProtocolError> {
    let mut offset = 0;
    let timeout_ms = read_u32(
        payload,
        &mut offset,
        "guest_storage_manifest timeout_ms truncated",
    )?;
    let run_id_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_storage_manifest run_id_len truncated",
    )?);
    let run_id = read_str(
        payload,
        &mut offset,
        run_id_len,
        "guest_storage_manifest run_id truncated",
        "guest_storage_manifest run_id invalid UTF-8",
    )?;
    let runtime_dir_len = usize::from(read_u16(
        payload,
        &mut offset,
        "guest_storage_manifest runtime_dir_len truncated",
    )?);
    let runtime_dir = read_str(
        payload,
        &mut offset,
        runtime_dir_len,
        "guest_storage_manifest runtime_dir truncated",
        "guest_storage_manifest runtime_dir invalid UTF-8",
    )?;
    let manifest_len = read_u32(
        payload,
        &mut offset,
        "guest_storage_manifest manifest_len truncated",
    )? as usize;
    let manifest_json = read_slice(
        payload,
        &mut offset,
        manifest_len,
        "guest_storage_manifest manifest truncated",
    )?;
    expect_consumed(payload, offset, "guest_storage_manifest trailing bytes")?;
    validate_request(timeout_ms, run_id, runtime_dir, manifest_json)?;
    Ok(DecodedGuestStorageManifestRequest {
        timeout_ms,
        run_id,
        runtime_dir,
        manifest_json,
    })
}

/// Encode a fixed guest storage-manifest terminal result payload.
pub fn encode_guest_storage_manifest_result(
    result: DecodedExecResult<'_>,
    resource_summary: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    validate_result_output(result.stdout, "stdout")?;
    validate_result_output(result.stderr, "stderr")?;
    let mut payload = resource_prefix(resource_summary)?;
    let output = crate::encode_exec_result(
        result.termination,
        result.duration_ms,
        result.stdout,
        result.stderr,
        result.diagnostic,
    )?;
    ensure_payload_fits_message(checked_payload_len_add(payload.len(), output.len())?)?;
    payload.extend_from_slice(&output);
    Ok(payload)
}

/// Encode a full fixed guest storage-manifest terminal result frame.
///
/// # Errors
///
/// Returns [`ProtocolError`] if stdout or stderr was discarded or exceeds
/// [`GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES`] bytes; if `diagnostic` cannot
/// fit its wire length field; if resources exceed
/// [`GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES`]; or if the encoded payload
/// exceeds the maximum message size.
///
/// Validation runs before the shared frame encoder clears `frame`, so a
/// validation error leaves the destination unchanged.
pub fn encode_guest_storage_manifest_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    result: DecodedExecResult<'_>,
    resource_summary: &[u8],
) -> Result<(), ProtocolError> {
    validate_result_output(result.stdout, "stdout")?;
    validate_result_output(result.stderr, "stderr")?;
    let prefix = resource_prefix(resource_summary)?;
    encode_exec_result_frame_into_with_prefix::<MSG_GUEST_STORAGE_MANIFEST_RESULT>(
        frame, seq, result, &prefix,
    )
}

fn resource_prefix(resources: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if resources.len() > GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "storage resources",
            resources.len(),
        ));
    }
    let length = ensure_u16_len("storage resources", resources.len())?;
    let mut prefix = Vec::with_capacity(2 + resources.len());
    prefix.extend_from_slice(&length.to_be_bytes());
    prefix.extend_from_slice(resources);
    Ok(prefix)
}

/// Decode a fixed guest storage-manifest terminal result payload.
pub fn decode_guest_storage_manifest_result(
    payload: &[u8],
) -> Result<DecodedGuestStorageManifestResult<'_>, ProtocolError> {
    let mut offset = 0;
    let length = usize::from(read_u16(
        payload,
        &mut offset,
        "storage resources length truncated",
    )?);
    if length > GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES {
        return Err(ProtocolError::PayloadTooLarge("storage resources", length));
    }
    let resource_summary = read_slice(payload, &mut offset, length, "storage resources truncated")?;
    let result = payload
        .get(offset..)
        .ok_or(ProtocolError::InvalidPayload("storage result truncated"))?;
    let decoded = crate::decode_exec_result(result)?;
    validate_result_output(decoded.stdout, "stdout")?;
    validate_result_output(decoded.stderr, "stderr")?;
    Ok(DecodedGuestStorageManifestResult {
        result: decoded,
        resource_summary,
    })
}

#[derive(Clone, Copy)]
struct RequestLengths {
    run_id: u16,
    runtime_dir: u16,
    manifest: u32,
}

fn validate_request(
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) -> Result<RequestLengths, ProtocolError> {
    if timeout_ms == 0 {
        return Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest timeout_ms must be positive",
        ));
    }
    if run_id.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest run_id must not be empty",
        ));
    }
    if run_id.len() > GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES {
        return Err(ProtocolError::PayloadTooLarge("run_id", run_id.len()));
    }
    if run_id.as_bytes().contains(&0) {
        return Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest run_id contains NUL",
        ));
    }
    if runtime_dir.is_empty() || !Path::new(runtime_dir).is_absolute() {
        return Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest runtime_dir must be absolute",
        ));
    }
    if runtime_dir.len() > GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "runtime_dir",
            runtime_dir.len(),
        ));
    }
    if runtime_dir.as_bytes().contains(&0) {
        return Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest runtime_dir contains NUL",
        ));
    }
    if manifest_json.starts_with(guest_contracts::storage_files::INPUT_MAGIC) {
        guest_contracts::storage_files::split_input(manifest_json)
            .map_err(|_| ProtocolError::InvalidPayload("invalid storage files input framing"))?;
    } else if manifest_json.len() > MAX_EXEC_STDIN_BYTES {
        return Err(ProtocolError::PayloadTooLarge(
            "manifest_json",
            manifest_json.len(),
        ));
    }

    let lengths = RequestLengths {
        run_id: ensure_u16_len("run_id", run_id.len())?,
        runtime_dir: ensure_u16_len("runtime_dir", runtime_dir.len())?,
        manifest: ensure_u32_len("manifest_json", manifest_json.len())?,
    };
    ensure_payload_fits_message(request_payload_len(run_id, runtime_dir, manifest_json)?)?;
    Ok(lengths)
}

fn request_payload_len(
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
) -> Result<usize, ProtocolError> {
    let mut len = 4usize;
    len = checked_payload_len_add(len, 2 + run_id.len())?;
    len = checked_payload_len_add(len, 2 + runtime_dir.len())?;
    checked_payload_len_add(len, 4 + manifest_json.len())
}

fn append_request_payload(
    payload: &mut Vec<u8>,
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    manifest_json: &[u8],
    lengths: RequestLengths,
) {
    payload.extend_from_slice(&timeout_ms.to_be_bytes());
    payload.extend_from_slice(&lengths.run_id.to_be_bytes());
    payload.extend_from_slice(run_id.as_bytes());
    payload.extend_from_slice(&lengths.runtime_dir.to_be_bytes());
    payload.extend_from_slice(runtime_dir.as_bytes());
    payload.extend_from_slice(&lengths.manifest.to_be_bytes());
    payload.extend_from_slice(manifest_json);
}

fn validate_result_output(
    output: ExecCapturedOutput<'_>,
    field: &'static str,
) -> Result<(), ProtocolError> {
    match output {
        ExecCapturedOutput::Captured { bytes, .. }
            if bytes.len() <= GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES =>
        {
            Ok(())
        }
        ExecCapturedOutput::Captured { bytes, .. } => {
            Err(ProtocolError::PayloadTooLarge(field, bytes.len()))
        }
        ExecCapturedOutput::Discarded => Err(ProtocolError::InvalidPayload(
            "guest_storage_manifest_result output must be captured",
        )),
    }
}
