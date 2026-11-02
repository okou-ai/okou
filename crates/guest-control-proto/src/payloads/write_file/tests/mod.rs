use super::*;
use crate::frame::encode;
use crate::wire::{HEADER_SIZE, MAX_MESSAGE_SIZE, MAX_PAYLOAD_SIZE};

fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
    assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
}

#[test]
fn write_file_payload_roundtrip() {
    let payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
    let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
    assert_eq!(path, "/tmp/test.txt");
    assert_eq!(content, b"content");
    assert!(!sudo);
    assert!(!append);
    assert!(!private);
}

#[test]
fn write_file_with_sudo() {
    let payload = encode_write_file("/etc/hosts", b"127.0.0.1", true, false).unwrap();
    let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
    assert_eq!(path, "/etc/hosts");
    assert_eq!(content, b"127.0.0.1");
    assert!(sudo);
    assert!(!append);
    assert!(!private);
}

#[test]
fn write_file_with_append() {
    let payload = encode_write_file("/tmp/out.log", b"more data", false, true).unwrap();
    let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
    assert_eq!(path, "/tmp/out.log");
    assert_eq!(content, b"more data");
    assert!(!sudo);
    assert!(append);
    assert!(!private);
}

#[test]
fn write_file_with_sudo_and_append() {
    let payload = encode_write_file("/etc/conf", b"line", true, true).unwrap();
    let (_, _, sudo, append, private) = decode_write_file(&payload).unwrap();
    assert!(sudo);
    assert!(append);
    assert!(!private);
}

#[test]
fn write_file_with_private() {
    let payload = encode_private_write_file("/tmp/private", b"secret", true).unwrap();
    let (path, content, sudo, append, private) = decode_write_file(&payload).unwrap();
    assert_eq!(path, "/tmp/private");
    assert_eq!(content, b"secret");
    assert!(!sudo);
    assert!(append);
    assert!(private);
}

#[test]
fn write_file_frame_matches_payload_plus_frame() {
    let payload = encode_write_file("/tmp/test.txt", b"content", true, true).unwrap();
    let expected = encode(MSG_WRITE_FILE, 42, &payload).unwrap();
    let mut frame = Vec::new();

    encode_write_file_frame_into(&mut frame, 42, "/tmp/test.txt", b"content", true, true).unwrap();

    assert_eq!(frame, expected);
}

#[test]
fn private_write_file_frame_matches_payload_plus_frame() {
    let payload = encode_private_write_file("/tmp/private", b"secret", true).unwrap();
    let expected = encode(MSG_WRITE_FILE, 43, &payload).unwrap();
    let mut frame = Vec::new();

    encode_private_write_file_frame_into(&mut frame, 43, "/tmp/private", b"secret", true).unwrap();

    assert_eq!(frame, expected);
}

#[test]
fn write_files_payload_roundtrip() {
    let files = [
        WriteFileBatchEntry {
            path: "/tmp/a.txt",
            content: b"alpha",
        },
        WriteFileBatchEntry {
            path: "/tmp/b.txt",
            content: b"beta",
        },
    ];

    let payload = encode_write_files(&files).unwrap();
    let decoded = decode_write_files(&payload).unwrap();

    assert_eq!(decoded, files);
}

#[test]
fn write_files_frame_matches_payload_plus_frame() {
    let files = [
        WriteFileBatchEntry {
            path: "/tmp/a.txt",
            content: b"alpha",
        },
        WriteFileBatchEntry {
            path: "/tmp/b.txt",
            content: b"beta",
        },
    ];
    let payload = encode_write_files(&files).unwrap();
    let expected = encode(MSG_WRITE_FILES, 44, &payload).unwrap();
    let mut frame = Vec::new();

    encode_write_files_frame_into(&mut frame, 44, &files).unwrap();

    assert_eq!(frame, expected);
}

#[test]
fn private_write_files_frame_reuses_batch_payload() {
    let files = [
        WriteFileBatchEntry {
            path: "/tmp/a.txt",
            content: b"alpha",
        },
        WriteFileBatchEntry {
            path: "/tmp/b.txt",
            content: b"beta",
        },
    ];
    let payload = encode_write_files(&files).unwrap();
    let expected = encode(MSG_WRITE_PRIVATE_FILES, 45, &payload).unwrap();
    let mut frame = Vec::new();

    encode_private_write_files_frame_into(&mut frame, 45, &files).unwrap();

    assert_eq!(frame, expected);
}

#[test]
fn write_files_rejects_empty_batch() {
    let err = encode_write_files(&[]).unwrap_err();

    assert_invalid_payload(err, "write_files file count must be positive");
}

#[test]
fn write_files_frame_rejects_empty_batch() {
    let mut frame = vec![0xFF];
    let err = encode_write_files_frame_into(&mut frame, 1, &[]).unwrap_err();

    assert_invalid_payload(err, "write_files file count must be positive");
    assert!(frame.is_empty());
}

#[test]
fn private_write_files_frame_rejects_empty_batch() {
    let mut frame = vec![0xFF];
    let err = encode_private_write_files_frame_into(&mut frame, 1, &[]).unwrap_err();

    assert_invalid_payload(err, "write_files file count must be positive");
    assert!(frame.is_empty());
}

#[test]
fn write_files_rejects_count_above_wire_limit() {
    let files = vec![
        WriteFileBatchEntry {
            path: "/tmp/f",
            content: b"",
        };
        usize::from(u16::MAX) + 1
    ];
    let err = encode_write_files(&files).unwrap_err();

    assert!(matches!(
        err,
        ProtocolError::PayloadCountTooLarge("file_count", count)
            if count == usize::from(u16::MAX) + 1
    ));
}

#[test]
fn write_files_content_too_large() {
    let path = "/tmp/f";
    let payload_overhead = 2 + 2 + path.len() + 4;
    let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];

    let err = encode_write_files(&[WriteFileBatchEntry {
        path,
        content: &big,
    }])
    .unwrap_err();

    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
}

#[test]
fn write_files_frame_content_too_large() {
    let path = "/tmp/f";
    let payload_overhead = 2 + 2 + path.len() + 4;
    let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];
    let mut frame = vec![0xFF];

    let err = encode_write_files_frame_into(
        &mut frame,
        1,
        &[WriteFileBatchEntry {
            path,
            content: &big,
        }],
    )
    .unwrap_err();

    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    assert!(frame.is_empty());
}

#[test]
fn write_files_content_at_payload_limit() {
    let path = "/tmp/f";
    let payload_overhead = 2 + 2 + path.len() + 4;
    let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];

    let payload = encode_write_files(&[WriteFileBatchEntry {
        path,
        content: &content,
    }])
    .unwrap();

    assert_eq!(payload.len(), MAX_PAYLOAD_SIZE);
    let decoded = decode_write_files(&payload).unwrap();
    assert_eq!(decoded.len(), 1);
    assert_eq!(decoded[0].path, path);
    assert_eq!(decoded[0].content, content.as_slice());
}

#[test]
fn write_files_frame_content_at_message_limit() {
    let path = "/tmp/f";
    let payload_overhead = 2 + 2 + path.len() + 4;
    let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];
    let mut frame = Vec::new();

    encode_write_files_frame_into(
        &mut frame,
        1,
        &[WriteFileBatchEntry {
            path,
            content: &content,
        }],
    )
    .unwrap();

    assert_eq!(frame.len(), HEADER_SIZE + MAX_MESSAGE_SIZE);
}

#[test]
fn write_file_path_too_long() {
    let long_path = "a".repeat(65536);
    let err = encode_write_file(&long_path, b"", false, false).unwrap_err();
    assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
}

#[test]
fn write_file_frame_path_too_long() {
    let long_path = "a".repeat(65536);
    let mut frame = vec![0xFF];
    let err =
        encode_write_file_frame_into(&mut frame, 1, &long_path, b"", false, false).unwrap_err();

    assert!(matches!(err, ProtocolError::PayloadTooLarge("path", 65536)));
    assert!(frame.is_empty());
}

#[test]
fn write_file_content_too_large() {
    let path = "/tmp/f";
    let payload_overhead = 2 + path.len() + 1 + 4;
    let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];
    let err = encode_write_file(path, &big, false, false).unwrap_err();

    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
}

#[test]
fn write_file_frame_content_too_large() {
    let path = "/tmp/f";
    let payload_overhead = 2 + path.len() + 1 + 4;
    let big = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead + 1];
    let mut frame = vec![0xFF];
    let err = encode_write_file_frame_into(&mut frame, 1, path, &big, false, false).unwrap_err();

    assert!(matches!(err, ProtocolError::MessageTooLarge(_)));
    assert!(frame.is_empty());
}

#[test]
fn write_file_content_at_payload_limit() {
    let path = "/tmp/f";
    let payload_overhead = 2 + path.len() + 1 + 4;
    let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];

    let payload = encode_write_file(path, &content, false, false).unwrap();

    assert_eq!(payload.len(), MAX_PAYLOAD_SIZE);
    let (decoded_path, decoded_content, sudo, append, private) =
        decode_write_file(&payload).unwrap();
    assert_eq!(decoded_path, path);
    assert_eq!(decoded_content, content.as_slice());
    assert!(!sudo);
    assert!(!append);
    assert!(!private);
}

#[test]
fn write_file_frame_content_at_message_limit() {
    let path = "/tmp/f";
    let payload_overhead = 2 + path.len() + 1 + 4;
    let content = vec![0u8; MAX_PAYLOAD_SIZE - payload_overhead];
    let mut frame = Vec::new();

    encode_write_file_frame_into(&mut frame, 1, path, &content, false, false).unwrap();

    assert_eq!(frame.len(), HEADER_SIZE + MAX_MESSAGE_SIZE);
}

#[test]
fn write_file_result_roundtrip() {
    let payload = encode_write_file_result(true, "");
    let (success, error) = decode_write_file_result(&payload).unwrap();
    assert!(success);
    assert!(error.is_empty());

    let payload = encode_write_file_result(false, "permission denied");
    let (success, error) = decode_write_file_result(&payload).unwrap();
    assert!(!success);
    assert_eq!(error, "permission denied");
}

#[test]
fn write_file_result_truncates_oversized_utf8_at_character_boundary() {
    let prefix = "A".repeat(u16::MAX as usize - 1);
    let error = format!("{prefix}é");
    let payload = encode_write_file_result(false, &error);

    assert_eq!(payload.first(), Some(&0));
    let declared_len = u16::from_be_bytes(payload.get(1..3).unwrap().try_into().unwrap());
    assert_eq!(declared_len as usize, prefix.len());
    assert_eq!(payload.len(), 3 + prefix.len());

    let (success, decoded_error) = decode_write_file_result(&payload).unwrap();
    assert!(!success);
    assert_eq!(decoded_error, prefix);
}

#[test]
fn decode_write_file_too_short() {
    assert!(decode_write_file(&[0; 3]).is_err());
}

#[test]
fn decode_write_file_rejects_truncated_fields() {
    for (payload, expected) in [
        (b"".as_slice(), "write_file too short"),
        (&[0], "write_file too short"),
        (&[0, 1], "write_file path truncated"),
        (&[0, 0], "write_file too short"),
        (&[0, 0, 0], "write_file too short"),
        (&[0, 0, 0, 0, 0, 0, 1], "write_file content truncated"),
    ] {
        let err = decode_write_file(payload).unwrap_err();
        assert_invalid_payload(err, expected);
    }
}

#[test]
fn decode_write_file_rejects_trailing_bytes() {
    let mut payload = encode_write_file("/tmp/test.txt", b"content", false, false).unwrap();
    payload.push(0);

    let err = decode_write_file(&payload).unwrap_err();

    assert_invalid_payload(err, "write_file trailing bytes");
}

#[test]
fn decode_write_file_rejects_unknown_flags() {
    let payload = [0, 0, 0x80, 0, 0, 0, 0];

    let err = decode_write_file(&payload).unwrap_err();

    assert_invalid_payload(err, "write_file unknown flags");
}

#[test]
fn decode_write_file_rejects_private_with_sudo() {
    let payload = [
        0,
        0,
        WRITE_FILE_FLAG_PRIVATE | WRITE_FILE_FLAG_SUDO,
        0,
        0,
        0,
        0,
    ];

    let err = decode_write_file(&payload).unwrap_err();

    assert_invalid_payload(err, "write_file private flag cannot be combined with sudo");
}

#[test]
fn decode_write_file_rejects_invalid_utf8_path() {
    let payload = [0, 1, 0xC3, 0, 0, 0, 0, 0];

    let err = decode_write_file(&payload).unwrap_err();

    assert_invalid_payload(err, "invalid UTF-8 in path");
}

#[test]
fn decode_write_files_rejects_zero_count() {
    let err = decode_write_files(&[0, 0]).unwrap_err();

    assert_invalid_payload(err, "write_files file count must be positive");
}

#[test]
fn decode_write_files_rejects_truncated_fields() {
    for (payload, expected) in [
        (b"".as_slice(), "write_files too short"),
        (&[0], "write_files too short"),
        (&[0, 1], "write_files path_len truncated"),
        (&[0, 1, 0, 1], "write_files path truncated"),
        (&[0, 1, 0, 0], "write_files content_len truncated"),
        (&[0, 1, 0, 0, 0, 0, 0, 1], "write_files content truncated"),
    ] {
        let err = decode_write_files(payload).unwrap_err();
        assert_invalid_payload(err, expected);
    }
}

#[test]
fn decode_write_files_rejects_trailing_bytes() {
    let mut payload = encode_write_files(&[WriteFileBatchEntry {
        path: "/tmp/test.txt",
        content: b"content",
    }])
    .unwrap();
    payload.push(0);

    let err = decode_write_files(&payload).unwrap_err();

    assert_invalid_payload(err, "write_files trailing bytes");
}

#[test]
fn decode_write_files_rejects_invalid_utf8_path() {
    let payload = [0, 1, 0, 1, 0xC3, 0, 0, 0, 0];

    let err = decode_write_files(&payload).unwrap_err();

    assert_invalid_payload(err, "invalid UTF-8 in write_files path");
}

#[test]
fn decode_write_file_result_rejects_trailing_bytes() {
    let mut payload = encode_write_file_result(false, "permission denied");
    payload.push(0);

    let err = decode_write_file_result(&payload).unwrap_err();

    assert_invalid_payload(err, "write_file_result trailing bytes");
}

#[test]
fn decode_write_file_result_rejects_invalid_success() {
    let payload = [2, 0, 0];

    let err = decode_write_file_result(&payload).unwrap_err();

    assert_invalid_payload(err, "write_file_result invalid success");
}

#[test]
fn decode_write_file_result_rejects_truncated_fields() {
    for (payload, expected) in [
        (b"".as_slice(), "write_file_result too short"),
        (&[0], "write_file_result too short"),
        (&[0, 0, 1], "write_file_result error truncated"),
    ] {
        let err = decode_write_file_result(payload).unwrap_err();
        assert_invalid_payload(err, expected);
    }
}

#[test]
fn decode_write_file_result_rejects_invalid_utf8() {
    let payload = [0, 0, 1, 0xC3];

    let err = decode_write_file_result(&payload).unwrap_err();

    assert_invalid_payload(err, "invalid UTF-8 in error");
}
