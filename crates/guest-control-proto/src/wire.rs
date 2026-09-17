/// Header size (4-byte length prefix).
pub const HEADER_SIZE: usize = 4;

/// Maximum message body size (16 MB).
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Minimum body size: type (1) + seq (4).
pub const MIN_BODY_SIZE: usize = 5;

// Connection lifecycle.

/// Guest-to-host ready notification with an empty payload.
pub const MSG_READY: u8 = 0x00;

/// Host-to-guest ping request with an empty payload.
pub const MSG_PING: u8 = 0x01;

/// Guest-to-host pong response with an empty payload.
pub const MSG_PONG: u8 = 0x02;

/// Host-to-guest shutdown request with an empty payload.
pub const MSG_SHUTDOWN: u8 = 0x03;

/// Guest-to-host shutdown acknowledgement with an empty payload.
pub const MSG_SHUTDOWN_ACK: u8 = 0x04;

// Operation gates.

/// Host-to-guest request to fence new guest operations.
pub const MSG_QUIESCE_OPERATIONS: u8 = 0x05;

/// Guest-to-host acknowledgement that operations are quiesced.
pub const MSG_OPERATIONS_QUIESCED: u8 = 0x06;

/// Host-to-guest request to resume guest operations.
pub const MSG_RESUME_OPERATIONS: u8 = 0x07;

/// Guest-to-host acknowledgement that operations resumed.
pub const MSG_OPERATIONS_RESUMED: u8 = 0x08;

// File operations.

/// Host-to-guest write-file request.
pub const MSG_WRITE_FILE: u8 = 0x09;

/// Guest-to-host write-file completion response.
pub const MSG_WRITE_FILE_RESULT: u8 = 0x0A;

// Exec operations.

/// Host-to-guest exec operation start request.
pub const MSG_EXEC_START: u8 = 0x0B;

/// Guest-to-host exec operation start acknowledgement.
pub const MSG_EXEC_STARTED: u8 = 0x0C;

/// Guest-to-host exec operation output chunk.
pub const MSG_EXEC_OUTPUT: u8 = 0x0D;

/// Guest-to-host exec operation terminal result.
pub const MSG_EXEC_RESULT: u8 = 0x0E;

/// Host-to-guest exec operation cancellation request.
pub const MSG_EXEC_CANCEL: u8 = 0x0F;

/// Host-to-guest control message for an active exec operation.
pub const MSG_EXEC_CONTROL: u8 = 0x10;

/// Guest-to-host exec control delivery result.
pub const MSG_EXEC_CONTROL_RESULT: u8 = 0x11;

// Batched file operations.

/// Host-to-guest multi-file write request.
pub const MSG_WRITE_FILES: u8 = 0x12;

/// Guest-to-host multi-file write completion response.
pub const MSG_WRITE_FILES_RESULT: u8 = 0x13;

/// Host-to-guest request for aggregate memory counters while fully quiesced.
pub const MSG_MEMORY_SNAPSHOT: u8 = 0x14;

/// Guest-to-host fixed-width aggregate memory snapshot response.
pub const MSG_MEMORY_SNAPSHOT_RESULT: u8 = 0x15;

/// Host-to-guest request for the fixed guest DNS readiness operation.
pub const MSG_GUEST_DNS_READINESS: u8 = 0x16;

/// Guest-to-host result of the fixed guest DNS readiness operation.
pub const MSG_GUEST_DNS_READINESS_RESULT: u8 = 0x17;

/// Host-to-guest request to apply a bounded storage manifest.
pub const MSG_GUEST_STORAGE_MANIFEST: u8 = 0x18;

/// Guest-to-host result of applying a bounded storage manifest.
pub const MSG_GUEST_STORAGE_MANIFEST_RESULT: u8 = 0x19;

/// Host-to-guest request to restore bounded snapshot-sensitive guest state.
pub const MSG_GUEST_STATE_RESTORE: u8 = 0x1A;

/// Guest-to-host result of restoring snapshot-sensitive guest state.
pub const MSG_GUEST_STATE_RESTORE_RESULT: u8 = 0x1B;

/// Guest-to-host acknowledgement that an Agent adopted runtime placement.
pub const MSG_EXEC_AGENT_READY: u8 = 0x1C;

/// Host-to-guest private multi-file write request.
pub const MSG_WRITE_PRIVATE_FILES: u8 = 0x1D;

/// Host-to-guest request to mount the fixed workspace drive.
pub const MSG_WORKSPACE_DRIVE_MOUNT: u8 = 0x1E;

/// Guest-to-host result of mounting the fixed workspace drive.
pub const MSG_WORKSPACE_DRIVE_MOUNT_RESULT: u8 = 0x1F;

/// Host-to-guest read-only file-write status query with an empty payload.
pub const MSG_FILE_WRITE_STATUS: u8 = 0x20;

/// Guest-to-host snapshot of the latest admitted file-write lifecycle stage.
pub const MSG_FILE_WRITE_STATUS_RESULT: u8 = 0x21;

/// Host-to-guest zstd request: codec tag (1), raw length (u32 BE), write-file metadata.
pub const MSG_WRITE_FILE_STREAM_BEGIN: u8 = 0x22;
/// Host-to-guest encoded data, at most 64 KiB and within granted credit.
pub const MSG_WRITE_FILE_STREAM_DATA: u8 = 0x23;
/// Host-to-guest explicit end of this request's encoded input; empty payload.
pub const MSG_WRITE_FILE_STREAM_END: u8 = 0x24;
/// Guest-to-host data-frame credit grant, one byte in 1..=4.
pub const MSG_WRITE_FILE_STREAM_CREDIT: u8 = 0x25;

/// Guest-to-host protocol error response.
pub const MSG_ERROR: u8 = 0xFF;

/// Default vsock port for host-guest communication.
pub const VSOCK_PORT: u32 = 1000;

/// Exec-start payload flag requesting sudo execution.
pub const EXEC_FLAG_SUDO: u8 = 0x01;

/// Exec-output payload flag indicating the emitted chunk was truncated.
pub const EXEC_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

/// Exec-result captured-output flag indicating retained bytes were truncated.
pub const EXEC_CAPTURED_OUTPUT_FLAG_TRUNCATED: u8 = 0x01;

/// Write-file payload flag requesting sudo file access.
pub const WRITE_FILE_FLAG_SUDO: u8 = 0x01;

/// Write-file payload flag requesting append instead of overwrite.
pub const WRITE_FILE_FLAG_APPEND: u8 = 0x02;

/// Write-file payload flag requesting private runtime-file semantics.
pub const WRITE_FILE_FLAG_PRIVATE: u8 = 0x04;

pub(crate) const MAX_PAYLOAD_SIZE: usize = MAX_MESSAGE_SIZE - MIN_BODY_SIZE;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_type_wire_values_are_stable() {
        let message_types = [
            ("MSG_READY", MSG_READY, 0x00),
            ("MSG_PING", MSG_PING, 0x01),
            ("MSG_PONG", MSG_PONG, 0x02),
            ("MSG_SHUTDOWN", MSG_SHUTDOWN, 0x03),
            ("MSG_SHUTDOWN_ACK", MSG_SHUTDOWN_ACK, 0x04),
            ("MSG_QUIESCE_OPERATIONS", MSG_QUIESCE_OPERATIONS, 0x05),
            ("MSG_OPERATIONS_QUIESCED", MSG_OPERATIONS_QUIESCED, 0x06),
            ("MSG_RESUME_OPERATIONS", MSG_RESUME_OPERATIONS, 0x07),
            ("MSG_OPERATIONS_RESUMED", MSG_OPERATIONS_RESUMED, 0x08),
            ("MSG_WRITE_FILE", MSG_WRITE_FILE, 0x09),
            ("MSG_WRITE_FILE_RESULT", MSG_WRITE_FILE_RESULT, 0x0A),
            ("MSG_EXEC_START", MSG_EXEC_START, 0x0B),
            ("MSG_EXEC_STARTED", MSG_EXEC_STARTED, 0x0C),
            ("MSG_EXEC_OUTPUT", MSG_EXEC_OUTPUT, 0x0D),
            ("MSG_EXEC_RESULT", MSG_EXEC_RESULT, 0x0E),
            ("MSG_EXEC_CANCEL", MSG_EXEC_CANCEL, 0x0F),
            ("MSG_EXEC_CONTROL", MSG_EXEC_CONTROL, 0x10),
            ("MSG_EXEC_CONTROL_RESULT", MSG_EXEC_CONTROL_RESULT, 0x11),
            ("MSG_WRITE_FILES", MSG_WRITE_FILES, 0x12),
            ("MSG_WRITE_FILES_RESULT", MSG_WRITE_FILES_RESULT, 0x13),
            ("MSG_MEMORY_SNAPSHOT", MSG_MEMORY_SNAPSHOT, 0x14),
            (
                "MSG_MEMORY_SNAPSHOT_RESULT",
                MSG_MEMORY_SNAPSHOT_RESULT,
                0x15,
            ),
            ("MSG_GUEST_DNS_READINESS", MSG_GUEST_DNS_READINESS, 0x16),
            (
                "MSG_GUEST_DNS_READINESS_RESULT",
                MSG_GUEST_DNS_READINESS_RESULT,
                0x17,
            ),
            (
                "MSG_GUEST_STORAGE_MANIFEST",
                MSG_GUEST_STORAGE_MANIFEST,
                0x18,
            ),
            (
                "MSG_GUEST_STORAGE_MANIFEST_RESULT",
                MSG_GUEST_STORAGE_MANIFEST_RESULT,
                0x19,
            ),
            ("MSG_GUEST_STATE_RESTORE", MSG_GUEST_STATE_RESTORE, 0x1A),
            (
                "MSG_GUEST_STATE_RESTORE_RESULT",
                MSG_GUEST_STATE_RESTORE_RESULT,
                0x1B,
            ),
            ("MSG_EXEC_AGENT_READY", MSG_EXEC_AGENT_READY, 0x1C),
            ("MSG_WRITE_PRIVATE_FILES", MSG_WRITE_PRIVATE_FILES, 0x1D),
            ("MSG_WORKSPACE_DRIVE_MOUNT", MSG_WORKSPACE_DRIVE_MOUNT, 0x1E),
            (
                "MSG_WORKSPACE_DRIVE_MOUNT_RESULT",
                MSG_WORKSPACE_DRIVE_MOUNT_RESULT,
                0x1F,
            ),
            ("MSG_ERROR", MSG_ERROR, 0xFF),
            ("MSG_FILE_WRITE_STATUS", MSG_FILE_WRITE_STATUS, 0x20),
            (
                "MSG_FILE_WRITE_STATUS_RESULT",
                MSG_FILE_WRITE_STATUS_RESULT,
                0x21,
            ),
        ];

        for (name, actual, expected) in message_types {
            assert_eq!(actual, expected, "{name} wire value changed");
        }
    }
}
