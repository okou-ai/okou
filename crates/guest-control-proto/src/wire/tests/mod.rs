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
        ("MSG_HOME_DRIVE_MOUNT", MSG_HOME_DRIVE_MOUNT, 0x1E),
        (
            "MSG_HOME_DRIVE_MOUNT_RESULT",
            MSG_HOME_DRIVE_MOUNT_RESULT,
            0x1F,
        ),
        ("MSG_ERROR", MSG_ERROR, 0xFF),
        ("MSG_FILE_WRITE_STATUS", MSG_FILE_WRITE_STATUS, 0x20),
        (
            "MSG_FILE_WRITE_STATUS_RESULT",
            MSG_FILE_WRITE_STATUS_RESULT,
            0x21,
        ),
        (
            "MSG_WRITE_FILE_STREAM_BEGIN",
            MSG_WRITE_FILE_STREAM_BEGIN,
            0x22,
        ),
        (
            "MSG_WRITE_FILE_STREAM_DATA",
            MSG_WRITE_FILE_STREAM_DATA,
            0x23,
        ),
        ("MSG_WRITE_FILE_STREAM_END", MSG_WRITE_FILE_STREAM_END, 0x24),
        (
            "MSG_WRITE_FILE_STREAM_CREDIT",
            MSG_WRITE_FILE_STREAM_CREDIT,
            0x25,
        ),
    ];

    for (name, actual, expected) in message_types {
        assert_eq!(actual, expected, "{name} wire value changed");
    }
}
