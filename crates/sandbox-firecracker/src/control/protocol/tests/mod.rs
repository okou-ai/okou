use super::*;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

#[tokio::test]
async fn frame_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("test.sock");

    let listener = UnixListener::bind(&sock_path).unwrap();

    let payload = b"hello world";
    let sock = sock_path.clone();
    let client = tokio::spawn(async move {
        let mut stream = UnixStream::connect(&sock).await.unwrap();
        write_frame(&mut stream, payload).await.unwrap();
        read_frame(&mut stream).await.unwrap()
    });

    let (mut stream, _) = listener.accept().await.unwrap();
    let received = read_frame(&mut stream).await.unwrap();
    assert_eq!(received, payload);

    write_frame(&mut stream, b"reply").await.unwrap();
    let reply = client.await.unwrap();
    assert_eq!(reply, b"reply");
}

#[tokio::test]
async fn read_frame_rejects_frames_larger_than_max_size() {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();

    writer.write_u32(MAX_FRAME_PAYLOAD_SIZE + 1).await.unwrap();
    drop(writer);

    let err = read_frame(&mut reader).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("frame too large"));
}

#[tokio::test]
async fn write_frame_rejects_frames_larger_than_max_size_without_writing_prefix() {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let payload = vec![0u8; MAX_FRAME_PAYLOAD_SIZE as usize + 1];

    let err = write_frame(&mut writer, &payload).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("frame too large"));

    drop(writer);
    let err = reader.read_u32().await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
}

#[tokio::test]
async fn exec_request_round_trip() {
    let request = ExecRequest {
        expected_run_id: None,
        command: "echo hello".into(),
        timeout_secs: 10,
        sudo: false,
    };
    let request_json = serde_json::to_vec(&request).unwrap();

    // Verify request deserializes correctly.
    let decoded: ExecRequest = serde_json::from_slice(&request_json).unwrap();
    assert_eq!(decoded.expected_run_id, None);
    assert_eq!(decoded.command, "echo hello");
    assert_eq!(decoded.timeout_secs, 10);
    assert!(!decoded.sudo);
    assert!(
        serde_json::from_slice::<serde_json::Value>(&request_json)
            .unwrap()
            .get("expected_run_id")
            .is_none()
    );
}

#[test]
fn guarded_exec_request_round_trips_run_identity() {
    let request = ExecRequest {
        expected_run_id: Some("run-full-id".into()),
        command: "true".into(),
        timeout_secs: 30,
        sudo: false,
    };

    let request_json = serde_json::to_value(&request).unwrap();
    assert_eq!(request_json["expected_run_id"], "run-full-id");
    let decoded: ExecRequest = serde_json::from_value(request_json).unwrap();
    assert_eq!(decoded.expected_run_id.as_deref(), Some("run-full-id"));
}

#[test]
fn exec_request_default_timeout() {
    // timeout_secs has a serde default of 30
    let json = r#"{"command":"echo hi"}"#;
    let req: ExecRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.expected_run_id, None);
    assert_eq!(req.command, "echo hi");
    assert_eq!(req.timeout_secs, 30);
    assert!(!req.sudo);
}

#[test]
fn exec_request_with_sudo() {
    let json = r#"{"command":"apt install curl","timeout_secs":60,"sudo":true}"#;
    let req: ExecRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.command, "apt install curl");
    assert_eq!(req.timeout_secs, 60);
    assert!(req.sudo);
}

#[test]
fn terminate_protocol_round_trip() {
    let request = TerminateRequest {
        action: TerminateAction::Terminate,
        expected_run_id: None,
    };
    let request_json = serde_json::to_value(&request).unwrap();
    assert_eq!(
        request_json,
        serde_json::json!({
            "action": "terminate",
        })
    );

    let decoded: TerminateRequest = serde_json::from_value(request_json).unwrap();
    assert!(matches!(decoded.action, TerminateAction::Terminate));
    assert_eq!(decoded.expected_run_id, None);

    for (status, status_json) in [
        (TerminateStatus::Accepted, "accepted"),
        (TerminateStatus::AlreadyStopped, "already_stopped"),
        (TerminateStatus::RefusedIdle, "refused_idle"),
    ] {
        let response = TerminateResponse::Status { status };
        let response_json = serde_json::to_value(&response).unwrap();
        assert_eq!(
            response_json,
            serde_json::json!({
                "status": status_json,
            })
        );

        let decoded: TerminateResponse = serde_json::from_value(response_json).unwrap();
        assert_eq!(decoded, TerminateResponse::Status { status });
    }

    let response = TerminateResponse::Error {
        error: "sandbox not running".into(),
    };
    let response_json = serde_json::to_value(&response).unwrap();
    assert_eq!(
        response_json,
        serde_json::json!({
            "error": "sandbox not running",
        })
    );

    let decoded: TerminateResponse = serde_json::from_value(response_json).unwrap();
    assert_eq!(
        decoded,
        TerminateResponse::Error {
            error: "sandbox not running".into()
        }
    );
}

#[test]
fn guarded_terminate_request_round_trips_run_identity() {
    let request = TerminateRequest {
        action: TerminateAction::Terminate,
        expected_run_id: Some("run-full-id".into()),
    };

    let request_json = serde_json::to_value(&request).unwrap();
    assert_eq!(request_json["expected_run_id"], "run-full-id");
    let decoded: TerminateRequest = serde_json::from_value(request_json).unwrap();
    assert_eq!(decoded.expected_run_id.as_deref(), Some("run-full-id"));
}

#[test]
fn terminate_response_rejects_mixed_status_error_shape() {
    let mixed = serde_json::json!({
        "status": "accepted",
        "error": "sandbox not running",
    });

    let result = serde_json::from_value::<TerminateResponse>(mixed);
    assert!(result.is_err());
}

#[test]
fn terminate_request_does_not_decode_as_exec_request() {
    let request = TerminateRequest {
        action: TerminateAction::Terminate,
        expected_run_id: None,
    };
    let request_json = serde_json::to_vec(&request).unwrap();

    assert!(serde_json::from_slice::<ExecRequest>(&request_json).is_err());
}

#[test]
fn terminate_request_rejects_exec_fields() {
    let request_json = serde_json::json!({
        "action": "terminate",
        "command": "true",
        "timeout_secs": 1,
    });

    assert!(serde_json::from_value::<TerminateRequest>(request_json).is_err());
}

#[test]
fn exec_request_rejects_terminate_fields() {
    let request_json = serde_json::json!({
        "command": "true",
        "timeout_secs": 1,
        "action": "terminate",
    });

    assert!(serde_json::from_value::<ExecRequest>(request_json).is_err());
}
