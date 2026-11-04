use sandbox::EXEC_OUTPUT_LIMIT_7_MIB;

use super::super::protocol::MAX_FRAME_PAYLOAD_SIZE;
use super::*;

async fn round_trip(response: ExecResult) {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let write = tokio::spawn(async move {
        write_raw_exec_response(&mut writer, &response)
            .await
            .unwrap();
        response
    });

    let decoded = read_raw_exec_response(&mut reader).await.unwrap();
    let expected = write.await.unwrap();
    assert_eq!(decoded, expected);
}

async fn encoded_payload(response: ExecResult) -> Vec<u8> {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let write = tokio::spawn(async move {
        write_raw_exec_response(&mut writer, &response)
            .await
            .unwrap();
    });

    let len = reader.read_u32().await.unwrap() as usize;
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload).await.unwrap();
    write.await.unwrap();
    payload
}

async fn decode_payload(payload: &[u8]) -> io::Result<ExecResult> {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let payload = payload.to_vec();
    let write = tokio::spawn(async move {
        writer.write_u32(payload.len() as u32).await.unwrap();
        writer.write_all(&payload).await.unwrap();
    });

    let result = read_raw_exec_response(&mut reader).await;
    write.await.unwrap();
    result
}

fn success_payload() -> Vec<u8> {
    let mut payload = Vec::new();
    append_common_header(&mut payload, RAW_EXEC_KIND_SUCCESS);
    append_termination(&mut payload, ExecTermination::Exited { exit_code: 7 });
    payload.push(FLAG_STDOUT_TRUNCATED);
    payload.extend_from_slice(&3u32.to_be_bytes());
    payload.extend_from_slice(&2u32.to_be_bytes());
    payload.extend_from_slice(&4u32.to_be_bytes());
    payload.extend_from_slice(b"out");
    payload.extend_from_slice(b"er");
    payload.extend_from_slice(b"diag");
    payload
}

#[tokio::test]
async fn raw_exec_success_round_trips_all_terminal_shapes() {
    for termination in [
        ExecTermination::Exited { exit_code: -17 },
        ExecTermination::TimedOut,
        ExecTermination::Cancelled,
        ExecTermination::StartFailed,
        ExecTermination::WaitFailed,
    ] {
        round_trip(ExecResult::Success {
            termination,
            stdout: vec![0, 0xff, b'\n'],
            stderr: b"stderr".to_vec(),
            stdout_truncated: true,
            stderr_truncated: true,
            diagnostic: "diagnostic 边界".into(),
        })
        .await;
    }
}

#[tokio::test]
async fn raw_exec_error_round_trips() {
    round_trip(ExecResult::Error {
        error: "sandbox unavailable 边界".into(),
    })
    .await;
}

#[tokio::test]
async fn maximum_control_capture_avoids_base64_wire_expansion() {
    let stdout_len = EXEC_OUTPUT_LIMIT_7_MIB.stdout_limit_bytes as usize;
    let stderr_len = EXEC_OUTPUT_LIMIT_7_MIB.stderr_limit_bytes as usize;
    let payload = encoded_payload(ExecResult::Success {
        termination: ExecTermination::Exited { exit_code: 0 },
        stdout: vec![b'o'; stdout_len],
        stderr: vec![b'e'; stderr_len],
        stdout_truncated: true,
        stderr_truncated: true,
        diagnostic: String::new(),
    })
    .await;

    assert_eq!(payload.len(), 24 + stdout_len + stderr_len);
    let base64_len = stdout_len.div_ceil(3) * 4 + stderr_len.div_ceil(3) * 4;
    assert!(payload.len() < base64_len);
}

#[tokio::test]
async fn raw_exec_reader_rejects_invalid_header_fields() {
    let valid = success_payload();
    for (offset, value, expected) in [
        (0, b'X', "magic"),
        (4, RAW_EXEC_RESPONSE_VERSION + 1, "version"),
        (5, 0xff, "kind"),
        (6, 0xff, "termination"),
        (11, 0x80, "flags"),
    ] {
        let mut malformed = valid.clone();
        malformed[offset] = value;
        let error = decode_payload(&malformed).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains(expected), "{error}");
    }
}

#[tokio::test]
async fn raw_exec_reader_rejects_inconsistent_lengths_and_trailing_bytes() {
    let mut inconsistent = success_payload();
    inconsistent[12..16].copy_from_slice(&4u32.to_be_bytes());
    let error = decode_payload(&inconsistent).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("lengths declare"));

    let mut trailing = success_payload();
    trailing.push(0);
    let error = decode_payload(&trailing).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("lengths declare"));
}

#[tokio::test]
async fn raw_exec_reader_rejects_invalid_utf8() {
    let mut success = success_payload();
    *success.last_mut().unwrap() = 0xff;
    let error = decode_payload(&success).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("diagnostic is not UTF-8"));

    let mut error_payload = Vec::new();
    append_common_header(&mut error_payload, RAW_EXEC_KIND_ERROR);
    error_payload.extend_from_slice(&1u32.to_be_bytes());
    error_payload.push(0xff);
    let error = decode_payload(&error_payload).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("error is not UTF-8"));
}

#[tokio::test]
async fn raw_exec_reader_preserves_truncated_transport_error() {
    let payload = success_payload();
    let declared_len = payload.len();
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let write = tokio::spawn(async move {
        writer.write_u32(declared_len as u32).await.unwrap();
        writer
            .write_all(&payload[..payload.len() - 1])
            .await
            .unwrap();
    });

    let error = read_raw_exec_response(&mut reader).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    write.await.unwrap();
}

#[tokio::test]
async fn raw_exec_reader_rejects_oversized_frame_before_payload_read() {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    writer.write_u32(MAX_FRAME_PAYLOAD_SIZE + 1).await.unwrap();

    let error = read_raw_exec_response(&mut reader).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("frame too large"));
}
