//! Binary protocol for Runner-to-Guest control operations.
//!
//! ## Wire Format
//!
//! ```text
//! [4-byte length][1-byte type][4-byte seq][payload]
//! ```
//!
//! - **length**: big-endian u32, size of (type + seq + payload)
//! - **type**: u8 message type
//! - **seq**: big-endian u32, sequence number. Request-scoped replies and
//!   lifecycle frames use the original request sequence; 0 is reserved for
//!   unsolicited frames.
//! - **payload**: type-specific binary data
//!
//! Unless noted otherwise, multi-byte integer fields are big-endian. `*_len`
//! fields count bytes, not characters. Length-prefixed string fields are UTF-8
//! byte sequences; fields named bytes, chunk, content, payload, or stdin_bytes
//! are raw bytes.
//!
//! ## Message Types
//!
//! Non-error message types currently occupy the contiguous range `0x00..=0x21`
//! in allocation order; `0x22` is the next available non-error assignment.
//! Existing values are stable wire assignments: do not renumber or reuse them.
//! Allocate new non-error messages at the next unused value below `0xFF`, even
//! when related operations are not adjacent. `0xFF` is
//! reserved for generic protocol errors. Changing an existing assignment
//! requires an explicit, versioned host/guest protocol migration.
//!
//! | Type | Direction | Name              | Payload |
//! |------|-----------|-------------------|---------|
//! | 0x00 | G→H       | ready             | (empty) |
//! | 0x01 | H→G       | ping              | (empty) |
//! | 0x02 | G→H       | pong              | (empty) |
//! | 0x03 | H→G       | shutdown          | (empty) |
//! | 0x04 | G→H       | shutdown_ack      | (empty) |
//! | 0x05 | H→G       | quiesce_operations  | (empty) |
//! | 0x06 | G→H       | operations_quiesced    | (empty) |
//! | 0x07 | H→G       | resume_operations | (empty) |
//! | 0x08 | G→H       | operations_resumed | (empty) |
//! | 0x09 | H→G       | write_file        | `[2B path_len][path][1B flags][4B content_len][content]` (flags: `SUDO=0x01`, `APPEND=0x02`, `PRIVATE=0x04`; `PRIVATE` and `SUDO` are mutually exclusive) |
//! | 0x0A | G→H       | write_file_result | `[1B success][2B error_len][error]` |
//! | 0x0B | H→G       | exec_start     | see payload schema below |
//! | 0x0C | G→H       | exec_started | `[4B pid]` |
//! | 0x0D | G→H       | exec_output    | `[1B stream][4B output_seq][1B flags][4B chunk_len][chunk]` |
//! | 0x0E | G→H       | exec_result    | see payload schema below |
//! | 0x0F | H→G       | exec_cancel    | (empty) |
//! | 0x10 | H→G       | exec_control | `[4B target_seq][4B request_timeout_ms][16B nonce][2B message_id_len][message_id][4B payload_len][payload]` |
//! | 0x11 | G→H       | exec_control_result | `[4B target_seq][16B nonce][2B message_id_len][message_id][1B status][2B diagnostic_len][diagnostic]` |
//! | 0x12 | H→G       | write_files       | `[2B file_count][file_entry]...`, where each file entry is `[2B path_len][path][4B content_len][content]` |
//! | 0x13 | G→H       | write_files_result | `[1B success][2B error_len][error]` |
//! | 0x14 | H→G       | memory_snapshot | (empty) |
//! | 0x15 | G→H       | memory_snapshot_result | eighteen big-endian `[8B counter_bytes]` fields; see [`MemorySnapshot`] |
//! | 0x16 | H→G       | guest_dns_readiness | `[4B positive timeout_ms][2B hostname_len][hostname]` |
//! | 0x17 | G→H       | guest_dns_readiness_result | `[termination][4B duration_ms][1B flags][2B answer_len][answer][2B diagnostic_len][diagnostic]` |
//! | 0x18 | H→G       | guest_storage_manifest | `[4B positive timeout_ms][2B run_id_len][run_id][2B runtime_dir_len][runtime_dir][4B manifest_len][manifest]` |
//! | 0x19 | G→H       | guest_storage_manifest_result | `[2B resource_json_len][resource_json][exec_result]`; optional resources bounded to 4 KiB, both streams captured and bounded to 1 MiB each |
//! | 0x1A | H→G       | guest_state_restore | `[4B positive timeout_ms][8B unix_seconds][4B unix_nanoseconds][1B timezone_mode][2B timezone_len][timezone][256B entropy]` |
//! | 0x1B | G→H       | guest_state_restore_result | same payload as `exec_result`, with empty stdout and stderr bounded to 64 KiB |
//! | 0x1C | G→H       | exec_agent_ready | `[4B containment_create_us][4B placement_broker_setup_us][4B shell_spawn_us][4B bootstrap_ready_wait_us]` |
//! | 0x1D | H→G       | write_private_files | same payload as `write_files`; result is `write_files_result` with the request sequence |
//! | 0x1E | H→G       | workspace_drive_mount | (empty) |
//! | 0x1F | G→H       | workspace_drive_mount_result | same payload as `exec_result`, with both streams captured and bounded to 64 KiB each |
//! | 0x20 | H→G       | file_write_status | (empty); read-only, available while quiescing |
//! | 0x21 | G→H       | file_write_status_result | `[4B latest_write_seq][1B stage]`; see [`FileWriteStatus`] |
//! | 0xFF | G→H       | error             | `[2B error_len][error]` |
//!
//! Request-scoped operation messages must use non-zero sequence numbers. This
//! covers `write_file`, `write_files`, `write_private_files`, `exec_start`, `exec_cancel`,
//! `exec_control`, `guest_dns_readiness`, `guest_storage_manifest`, and
//! `guest_state_restore`, `workspace_drive_mount`, and `file_write_status`; replies reuse
//! the original non-zero request sequence. `exec_output.output_seq` is per exec
//! operation and starts at 0, incrementing by 1 for each output frame across
//! stdout and stderr.
//! `write_file_result.success` / `write_files_result.success` use 0=false and
//! 1=true.
//! `exec_control_result.status` is an [`ExecControlStatus`] wire value.
//! `exec_control.request_timeout_ms` is the caller-visible budget, counted
//! from guest receipt through local sink connection, request write, and response
//! read. Host encoders round non-zero sub-millisecond durations up to 1ms and
//! saturate values that do not fit in `u32`.
//!
//! ## Payload Schemas
//!
//! ### `exec_start`
//!
//! ```text
//! [1B lifecycle]
//! [1B process_role]
//! [timeout_policy]
//! [1B flags]
//! [4B cmd_len][command]
//! [4B env_count][env_entry]...
//! [2B label_len][label]
//! [stdout_policy]
//! [stderr_policy]
//! [2B expected_exit_count][4B expected_exit_code]...
//! [control_policy]
//! [stdin_policy]
//! ```
//!
//! `lifecycle` values:
//!
//! - `0x00`: one-shot.
//! - `0x01`: supervised.
//!
//! `process_role` values:
//!
//! - `0x00`: ordinary contained workload.
//! - `0x01`: controlled Agent operation.
//!
//! `lifecycle`, `process_role`, and `control_policy` are validated as one
//! process contract. See [`ExecStartEncodeRequest`] for the complete matrix;
//! [`validate_exec_process_contract`] is applied by both
//! [`encode_exec_start_with_expected_exit_codes`] and [`decode_exec_start`].
//!
//! `timeout_policy` values:
//!
//! - `0x00`: `[4B positive timeout_ms]`.
//! - `0x01`: no timeout.
//!
//! `flags` currently uses `SUDO=0x01`.
//!
//! Each `env_entry` is `[4B key_len][key][4B value_len][value]`.
//!
//! `stdout_policy` and `stderr_policy` use the same tagged output-policy
//! payload:
//!
//! - `0x00`: discard, no payload.
//! - `0x01`: capture, followed by `[4B limit_bytes]`.
//! - `0x02`: stream, followed by `[4B limit_bytes][4B chunk_limit_bytes]`.
//! - `0x03`: capture-and-stream, followed by
//!   `[4B capture_limit_bytes][4B stream_limit_bytes][4B chunk_limit_bytes]`.
//!
//! `chunk_limit_bytes` must be non-zero for stream and capture-and-stream
//! policies.
//!
//! `expected_exit_count` may be zero, but the count field is always present.
//! Each `expected_exit_code` is a signed `i32`.
//!
//! `control_policy` values:
//!
//! - `0x00`: disabled.
//! - `0x01`: enabled, followed by `[1B control_flags][16B nonce]`.
//!
//! `control_flags` currently uses `SINK=0x01`.
//!
//! `stdin_policy` values:
//!
//! - `0x00`: no explicit stdin.
//! - `0x01`: stdin bytes, followed by `[4B stdin_len][stdin_bytes]`.
//!
//! Present stdin is bounded by `MAX_EXEC_STDIN_BYTES`.
//!
//! ### Process termination
//!
//! Exec, guest DNS readiness, and guest storage-manifest results share the same
//! process termination encoding:
//!
//! - `0x00`: exited, followed by signed `[4B exit_code]`.
//! - `0x01`: timed out.
//! - `0x02`: cancelled.
//! - `0x03`: start failed.
//! - `0x04`: wait failed.
//!
//! ### `exec_result`
//!
//! ```text
//! [termination]
//! [4B duration_ms]
//! [stdout]
//! [stderr]
//! [2B diagnostic_len][diagnostic]
//! ```
//!
//! `termination` uses the shared process termination encoding above.
//!
//! `stdout` and `stderr` use the same tagged captured-output payload:
//!
//! - `0x00`: discarded, no payload.
//! - `0x01`: captured, followed by `[1B flags][4B bytes_len][bytes]`.
//!
//! Captured-output `flags` currently uses `TRUNCATED=0x01`.
//!
//! ### `guest_dns_readiness_result`
//!
//! ```text
//! [termination]
//! [4B duration_ms]
//! [1B flags]
//! [2B answer_len][answer]
//! [2B diagnostic_len][diagnostic]
//! ```
//!
//! `termination` uses the shared process termination encoding above. For DNS
//! readiness, `cancelled` means cancellation by connection teardown.
//!
//! Result `flags` currently uses `OUTPUT_TRUNCATED=0x01`. `answer` is raw
//! resolver stdout bounded by [`GUEST_DNS_READINESS_MAX_ANSWER_BYTES`], while
//! `diagnostic` is UTF-8 bounded by
//! [`GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES`].

#![deny(missing_docs)]

mod error;
mod frame;
mod payloads;
mod read;
mod wire;

pub use error::ProtocolError;
pub use frame::{BorrowedRawMessage, DecodeWithError, Decoder, RawMessage, encode};
pub use payloads::empty::decode_empty_payload;
pub use payloads::error::{decode_error, encode_error};
pub use payloads::exec_operation::{
    DecodedExecControl, DecodedExecControlResult, DecodedExecOutput, DecodedExecResult,
    DecodedExecStart, DecodedExecStarted, EXEC_CONTROL_MAX_PAYLOAD_BYTES, EXEC_CONTROL_NONCE_LEN,
    ExecAgentReadyTiming, ExecCapturedOutput, ExecControlNonce, ExecControlPolicy,
    ExecControlStatus, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream, ExecProcessRole,
    ExecStartEncodeRequest, ExecTermination, ExecTimeoutPolicy, MAX_EXEC_STDIN_BYTES,
    decode_exec_agent_ready, decode_exec_cancel, decode_exec_control, decode_exec_control_result,
    decode_exec_output, decode_exec_result, decode_exec_start, decode_exec_started,
    encode_exec_agent_ready, encode_exec_cancel, encode_exec_control,
    encode_exec_control_frame_into, encode_exec_control_result, encode_exec_output,
    encode_exec_output_frame_into, encode_exec_result, encode_exec_result_frame_into,
    encode_exec_start, encode_exec_start_with_expected_exit_codes, encode_exec_started,
    validate_exec_control, validate_exec_process_contract,
};
pub use payloads::file_write_status::{FileWriteStage, FileWriteStatus};
pub use payloads::guest_dns_readiness::{
    DecodedGuestDnsReadinessRequest, DecodedGuestDnsReadinessResult,
    GUEST_DNS_READINESS_MAX_ANSWER_BYTES, GUEST_DNS_READINESS_MAX_DIAGNOSTIC_BYTES,
    GUEST_DNS_READINESS_MAX_HOSTNAME_BYTES, GuestDnsReadinessTermination,
    decode_guest_dns_readiness_request, decode_guest_dns_readiness_result,
    encode_guest_dns_readiness_request, encode_guest_dns_readiness_request_frame_into,
    encode_guest_dns_readiness_result,
};
pub use payloads::guest_state_restore::{
    DecodedGuestStateRestoreRequest, GUEST_STATE_RESTORE_ENTROPY_BYTES,
    GUEST_STATE_RESTORE_MAX_TIMEZONE_BYTES, GUEST_STATE_RESTORE_OUTPUT_LIMIT_BYTES,
    GuestStateRestoreTimezone, decode_guest_state_restore_request,
    decode_guest_state_restore_result, encode_guest_state_restore_request,
    encode_guest_state_restore_request_frame_into, encode_guest_state_restore_result,
    encode_guest_state_restore_result_frame_into,
};
pub use payloads::guest_storage_manifest::{
    DecodedGuestStorageManifestRequest, DecodedGuestStorageManifestResult,
    GUEST_STORAGE_MANIFEST_MAX_RUN_ID_BYTES, GUEST_STORAGE_MANIFEST_MAX_RUNTIME_DIR_BYTES,
    GUEST_STORAGE_MANIFEST_OUTPUT_LIMIT_BYTES, GUEST_STORAGE_RESOURCE_SUMMARY_LIMIT_BYTES,
    decode_guest_storage_manifest_request, decode_guest_storage_manifest_result,
    encode_guest_storage_manifest_request, encode_guest_storage_manifest_request_frame_into,
    encode_guest_storage_manifest_result, encode_guest_storage_manifest_result_frame_into,
};
pub use payloads::memory_snapshot::{
    MEMORY_SNAPSHOT_PAYLOAD_SIZE, MemorySnapshot, decode_memory_snapshot,
};
pub use payloads::workspace_drive_mount::{
    WORKSPACE_DRIVE_MOUNT_OUTPUT_LIMIT_BYTES, decode_workspace_drive_mount_request,
    decode_workspace_drive_mount_result, encode_workspace_drive_mount_request_frame_into,
    encode_workspace_drive_mount_result, encode_workspace_drive_mount_result_frame_into,
};
pub use payloads::write_file::{
    WriteFileBatchEntry, decode_write_file, decode_write_file_result, decode_write_files,
    decode_write_files_result, encode_private_write_file, encode_private_write_file_frame_into,
    encode_private_write_files_frame_into, encode_write_file, encode_write_file_frame_into,
    encode_write_file_result, encode_write_files, encode_write_files_frame_into,
    encode_write_files_result, validate_private_write_file, validate_write_file,
    validate_write_files,
};
pub use wire::{
    EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED, EXEC_FLAG_SUDO, EXEC_OUTPUT_FLAG_TRUNCATED, HEADER_SIZE,
    MAX_MESSAGE_SIZE, MIN_BODY_SIZE, MSG_ERROR, MSG_EXEC_AGENT_READY, MSG_EXEC_CANCEL,
    MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT, MSG_EXEC_RESULT, MSG_EXEC_START,
    MSG_EXEC_STARTED, MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT, MSG_GUEST_DNS_READINESS,
    MSG_GUEST_DNS_READINESS_RESULT, MSG_GUEST_STATE_RESTORE, MSG_GUEST_STATE_RESTORE_RESULT,
    MSG_GUEST_STORAGE_MANIFEST, MSG_GUEST_STORAGE_MANIFEST_RESULT, MSG_MEMORY_SNAPSHOT,
    MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PING,
    MSG_PONG, MSG_QUIESCE_OPERATIONS, MSG_READY, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MSG_WORKSPACE_DRIVE_MOUNT, MSG_WORKSPACE_DRIVE_MOUNT_RESULT, MSG_WRITE_FILE,
    MSG_WRITE_FILE_RESULT, MSG_WRITE_FILE_STREAM_BEGIN, MSG_WRITE_FILE_STREAM_CREDIT,
    MSG_WRITE_FILE_STREAM_DATA, MSG_WRITE_FILE_STREAM_END, MSG_WRITE_FILES, MSG_WRITE_FILES_RESULT,
    MSG_WRITE_PRIVATE_FILES, VSOCK_PORT, WRITE_FILE_FLAG_APPEND, WRITE_FILE_FLAG_PRIVATE,
    WRITE_FILE_FLAG_SUDO,
};
