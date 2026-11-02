use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::thread;

use super::*;

#[test]
fn request_response_roundtrip() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let request = ControlRequest {
        message_id: "msg-1".to_string(),
        payload: b"hello".to_vec(),
    };
    write_request(&mut a, &request).unwrap();
    assert_eq!(read_request(&mut b).unwrap(), request);

    let response = ControlResponse {
        message_id: "msg-1".to_string(),
        status: ControlResponseStatus::Rejected,
        diagnostic: "no".to_string(),
    };
    write_response(&mut b, &response).unwrap();
    assert_eq!(read_response(&mut a).unwrap(), response);
}

#[test]
fn response_status_roundtrip() {
    for status in [
        ControlResponseStatus::Accepted,
        ControlResponseStatus::Rejected,
        ControlResponseStatus::QueueFull,
        ControlResponseStatus::Error,
    ] {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        let response = ControlResponse {
            message_id: "msg-1".to_string(),
            status,
            diagnostic: format!("{status:?}"),
        };

        write_response(&mut a, &response).unwrap();

        assert_eq!(read_response(&mut b).unwrap(), response);
    }
}

#[test]
fn response_roundtrip_at_max_diagnostic_size() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let response = ControlResponse {
        message_id: "msg-1".to_string(),
        status: ControlResponseStatus::Error,
        diagnostic: "x".repeat(MAX_DIAGNOSTIC_BYTES),
    };

    write_response(&mut a, &response).unwrap();

    assert_eq!(read_response(&mut b).unwrap(), response);
}

#[test]
fn hello_roundtrip() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    write_hello(&mut a).unwrap();
    read_hello(&mut b).unwrap();
}

#[test]
fn request_rejects_too_large_payload() {
    let (mut a, _b) = UnixStream::pair().unwrap();
    let request = ControlRequest {
        message_id: "msg-1".to_string(),
        payload: vec![0; MAX_CONTROL_PAYLOAD_BYTES + 1],
    };
    assert!(write_request(&mut a, &request).is_err());
}

#[test]
fn request_roundtrip_at_max_frame_size() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let request = ControlRequest {
        message_id: "m".repeat(MAX_MESSAGE_ID_BYTES),
        payload: vec![0xA5; MAX_CONTROL_PAYLOAD_BYTES],
    };
    let reader = thread::spawn(move || read_request(&mut b).unwrap());

    write_request(&mut a, &request).unwrap();

    assert_eq!(reader.join().unwrap(), request);
}

#[test]
fn request_rejects_invalid_message_id_lengths() {
    let (mut stream, _peer) = UnixStream::pair().unwrap();

    for message_id in ["".to_owned(), "x".repeat(MAX_MESSAGE_ID_BYTES + 1)] {
        let err = write_request(
            &mut stream,
            &ControlRequest {
                message_id,
                payload: Vec::new(),
            },
        )
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "invalid control message id length");
    }
}

#[test]
fn response_rejects_invalid_message_id_and_large_diagnostic() {
    let (mut stream, _peer) = UnixStream::pair().unwrap();

    for message_id in ["".to_owned(), "x".repeat(MAX_MESSAGE_ID_BYTES + 1)] {
        let err = write_response(
            &mut stream,
            &ControlResponse {
                message_id,
                status: ControlResponseStatus::Accepted,
                diagnostic: String::new(),
            },
        )
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(err.to_string(), "invalid control message id length");
    }

    let err = write_response(
        &mut stream,
        &ControlResponse {
            message_id: "msg-1".to_owned(),
            status: ControlResponseStatus::Error,
            diagnostic: "x".repeat(MAX_DIAGNOSTIC_BYTES + 1),
        },
    )
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(err.to_string(), "control diagnostic too large");
}

#[test]
fn read_request_rejects_oversized_frame_before_body() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    a.write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
        .unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "invalid control frame length");
}

#[test]
fn read_request_rejects_wrong_frame_kind() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    write_frame(&mut a, FRAME_RESPONSE, &[]).unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "expected control request frame");
}

#[test]
fn read_request_rejects_wrong_frame_version() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let body = [FRAME_VERSION + 1, FRAME_REQUEST];
    a.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
    a.write_all(&body).unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "invalid control frame version");
}

#[test]
fn read_request_rejects_trailing_bytes() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&5u16.to_be_bytes());
    payload.extend_from_slice(b"msg-1");
    payload.extend_from_slice(&0u32.to_be_bytes());
    payload.push(0);
    write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "control frame trailing bytes");
}

#[test]
fn read_request_rejects_empty_and_invalid_utf8_message_id() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&0u16.to_be_bytes());
    payload.extend_from_slice(&0u32.to_be_bytes());
    write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "control request message id empty");

    let (mut a, mut b) = UnixStream::pair().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&1u16.to_be_bytes());
    payload.push(0xFF);
    payload.extend_from_slice(&0u32.to_be_bytes());
    write_frame(&mut a, FRAME_REQUEST, &payload).unwrap();

    let err = read_request(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "control request message id invalid utf-8");
}

#[test]
fn read_response_rejects_unknown_status() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&5u16.to_be_bytes());
    payload.extend_from_slice(b"msg-1");
    payload.push(0xFF);
    payload.extend_from_slice(&0u16.to_be_bytes());
    write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

    let err = read_response(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "invalid control response status");
}

#[test]
fn read_response_rejects_large_and_invalid_utf8_diagnostic() {
    let (mut a, mut b) = UnixStream::pair().unwrap();
    let diagnostic = "x".repeat(MAX_DIAGNOSTIC_BYTES + 1);
    let mut payload = Vec::new();
    payload.extend_from_slice(&5u16.to_be_bytes());
    payload.extend_from_slice(b"msg-1");
    payload.push(RESPONSE_ERROR);
    payload.extend_from_slice(&(diagnostic.len() as u16).to_be_bytes());
    payload.extend_from_slice(diagnostic.as_bytes());
    write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

    let err = read_response(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "control response diagnostic too large");

    let (mut a, mut b) = UnixStream::pair().unwrap();
    let mut payload = Vec::new();
    payload.extend_from_slice(&5u16.to_be_bytes());
    payload.extend_from_slice(b"msg-1");
    payload.push(RESPONSE_ERROR);
    payload.extend_from_slice(&1u16.to_be_bytes());
    payload.push(0xFF);
    write_frame(&mut a, FRAME_RESPONSE, &payload).unwrap();

    let err = read_response(&mut b).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(err.to_string(), "control response diagnostic invalid utf-8");
}
