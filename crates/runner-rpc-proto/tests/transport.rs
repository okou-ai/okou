#![cfg(test)]

use std::io;
use std::time::Duration;

use runner_rpc_proto::*;
use serde_json::{json, value::RawValue};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

fn request_json(method: &str, params: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"version": 1, "method": method, "params": params})).unwrap()
}

fn raw_frame(value: serde_json::Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend(bytes);
    frame
}

fn event(data: &str) -> Response {
    Response::Event {
        data: RawValue::from_string(data.into()).unwrap(),
    }
}

fn result(data: &str) -> Response {
    Response::Result {
        data: RawValue::from_string(data.into()).unwrap(),
    }
}

#[tokio::test]
async fn unrelated_methods_round_trip_opaque_objects_and_large_escaped_input() {
    for (method, params) in [
        (
            "fixture.echo",
            json!({"message": "\0".repeat(64 * 1024), "nested": [1, null, {"ok": true}]}),
        ),
        (
            "fixture.metrics-snapshot_v2",
            json!({"windows": [10, 20], "units": "bytes"}),
        ),
    ] {
        let request = parse_request(&request_json(method, params.clone())).unwrap();
        let (mut sender, mut receiver) = UnixStream::pair().unwrap();
        let send = async {
            write_request(&mut sender, &request).await.unwrap();
        };
        // Keep the peer open: Firecracker does not forward guest send-half EOF.
        let ((), received) = tokio::join!(
            send,
            timeout(Duration::from_secs(1), read_request(&mut receiver))
        );
        let received = received.expect("a complete frame must not wait for peer EOF");
        let received = received.unwrap();
        assert_eq!(received.method, method);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(received.params.get()).unwrap(),
            params
        );
    }
}

#[tokio::test]
async fn strict_envelopes_reject_invalid_method_types_and_unknown_top_level_fields() {
    for (field, value) in [
        ("version", json!(2)),
        ("version", json!("1")),
        ("method", json!("")),
        ("method", json!("x".repeat(MAX_METHOD_BYTES + 1))),
        ("method", json!("a/b")),
        ("method", json!("a b")),
        ("method", json!("é")),
        ("method", json!("x\n")),
        ("method", json!(1)),
        ("params", json!(null)),
        ("params", json!([])),
        ("params", json!("secret")),
        ("host", json!("secret")),
        ("runId", json!("other")),
    ] {
        let mut request: serde_json::Value =
            serde_json::from_slice(&request_json("fixture.echo", json!({}))).unwrap();
        request[field] = value;
        let error = parse_request(&serde_json::to_vec(&request).unwrap())
            .err()
            .unwrap();
        assert!(!error.to_string().contains("secret"));
    }
    for bytes in [
        br#"[1,"fixture.echo",{}]"#.as_slice(),
        br#"{"version":1,"method":"a","method":"b","params":{}}"#.as_slice(),
        br#"{"version":1,"method":"a","params":{},"params":{}}"#,
        br#"{"version":1,"method":"a"}"#,
        br#"{"version":1,"method":"a","params":{}} {}"#,
    ] {
        assert!(parse_request(bytes).is_err());
    }
    assert!(parse_request(&request_json(&"a".repeat(MAX_METHOD_BYTES), json!({}))).is_ok());
}

#[tokio::test]
async fn raw_json_preserves_numbers_duplicate_fields_and_safe_single_line_output() {
    let data = r#"{
        "huge": 1234567890123456789012345678901234567890,
        "decimal": 1.23456789012345678901234567890,
        "exponent": 1e9999,
        "duplicate": 1, "duplicate": 2,
        "nested": [{"text": "line\n\\\" quote"}]
    }"#;
    let bytes = format!(r#"{{"version":1,"method":"fixture.echo","params":{data}}}"#);
    let request = parse_request(bytes.as_bytes()).unwrap();
    let mut wire = Vec::new();
    write_request(&mut wire, &request).await.unwrap();
    let received = read_request(&mut wire.as_slice()).await.unwrap();
    assert_eq!(received.params.get(), data);

    let response = result(data);
    let mut wire = Vec::new();
    ResponseWriter::new(&mut wire)
        .send(&response)
        .await
        .unwrap();
    let mut reader = ResponseReader::new(wire.as_slice());
    let Some(Response::Result { data: received }) = reader.next().await.unwrap() else {
        panic!("missing result")
    };
    assert_eq!(received.get(), data);
    assert!(reader.next().await.unwrap().is_none());
    let line = response.to_ndjson().unwrap();
    assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1);
    let text = String::from_utf8(line.clone()).unwrap();
    assert!(text.contains("1234567890123456789012345678901234567890"));
    assert!(text.contains("1.23456789012345678901234567890"));
    assert!(text.contains("1e9999"));
    assert!(text.contains(r#""duplicate":1,"duplicate":2"#));
    let decoded: Response = serde_json::from_slice(&line).unwrap();
    assert_eq!(decoded.to_ndjson().unwrap(), line);
}

#[tokio::test]
async fn advertised_oversize_is_rejected_before_waiting_for_a_body() {
    let (mut peer, mut host) = UnixStream::pair().unwrap();
    peer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    let error = timeout(Duration::from_secs(1), read_request(&mut host))
        .await
        .unwrap()
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    let (mut peer, host) = UnixStream::pair().unwrap();
    peer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(1), ResponseReader::new(host).next())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
}

#[tokio::test]
async fn partial_and_malformed_requests_fail_closed() {
    for bytes in [
        vec![],
        vec![0, 0],
        vec![0, 0, 0, 10, b'{'],
        raw_frame(json!({"version": 1})),
    ] {
        let (mut peer, mut host) = UnixStream::pair().unwrap();
        peer.write_all(&bytes).await.unwrap();
        peer.shutdown().await.unwrap();
        assert!(read_request(&mut host).await.is_err());
    }
}

#[tokio::test]
async fn a_request_consumes_only_its_complete_frame() {
    let frame = raw_frame(json!({"version":1,"method":"fixture.echo","params":{}}));
    for trailing in [vec![255], frame.clone()] {
        let (mut peer, mut host) = UnixStream::pair().unwrap();
        peer.write_all(&[frame.clone(), trailing.clone()].concat())
            .await
            .unwrap();
        let request = timeout(Duration::from_secs(1), read_request(&mut host))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request.method, "fixture.echo");
        let mut unread = vec![0; trailing.len()];
        host.read_exact(&mut unread).await.unwrap();
        assert_eq!(unread, trailing);
    }
}

#[tokio::test]
async fn events_results_and_transport_errors_round_trip_without_business_interpretation() {
    for responses in [
        vec![result("null")],
        vec![result(r#"{"businessSuccess":false,"exitCode":42}"#)],
        vec![event("[1,2,3]"), event(r#""not base64?""#), result("false")],
        vec![Response::error(
            ErrorCode::UnknownMethod,
            Delivery::NotDispatched,
        )],
        vec![
            event("{}"),
            Response::error(ErrorCode::ResourceExhausted, Delivery::Unknown),
        ],
    ] {
        let (host, peer) = UnixStream::pair().unwrap();
        let send = async {
            let mut writer = ResponseWriter::new(host);
            for response in &responses {
                writer.send(response).await.unwrap();
            }
            assert!(writer.send(&result("null")).await.is_err());
        };
        let receive = async {
            let mut reader = ResponseReader::new(peer);
            for expected in &responses {
                let actual = reader.next().await.unwrap().unwrap();
                assert_eq!(actual.to_ndjson().unwrap(), expected.to_ndjson().unwrap());
            }
            assert!(reader.next().await.unwrap().is_none());
        };
        tokio::join!(send, receive);
    }
}

#[tokio::test]
async fn response_shapes_order_and_missing_or_duplicate_terminals_fail_closed() {
    let event = json!({"type": "event", "data": {}});
    let error = json!({"type": "error", "code": "unavailable", "delivery": "not_dispatched"});
    for frames in [
        vec![],
        vec![json!(["result", {}])],
        vec![event.clone()],
        vec![event.clone(), error.clone()],
        vec![error.clone(), error],
        vec![json!({"type": "event", "data": {}, "host": "secret"})],
        vec![json!({"type": "result"})],
        vec![json!({"type": "result", "data": null, "code": null})],
        vec![json!({"type": "result", "data": null, "delivery": "unknown"})],
        vec![json!({"type": "error", "code": "unavailable", "delivery": "unknown", "data": null})],
        vec![json!({"type": "error", "code": "secret", "delivery": "unknown"})],
        vec![json!({"type": "error", "code": "transport", "delivery": "not_started"})],
        vec![json!({"type": "error", "code": "transport"})],
        vec![json!({"type": "unexpected"})],
    ] {
        let bytes: Vec<_> = frames.into_iter().flat_map(raw_frame).collect();
        let mut reader = ResponseReader::new(bytes.as_slice());
        loop {
            match reader.next().await {
                Ok(Some(_)) => {}
                Ok(None) => panic!("invalid response unexpectedly succeeded"),
                Err(error) => {
                    assert!(!error.to_string().contains("secret"));
                    break;
                }
            }
        }
        assert!(reader.next().await.is_err());
    }
    let mut bytes = Vec::new();
    let mut writer = ResponseWriter::new(&mut bytes);
    writer.send(&self::event("{}")).await.unwrap();
    assert!(
        writer
            .send(&Response::error(
                ErrorCode::Unavailable,
                Delivery::NotDispatched
            ))
            .await
            .is_err()
    );
    writer
        .send(&Response::error(ErrorCode::Transport, Delivery::Unknown))
        .await
        .unwrap();
}

#[tokio::test]
async fn cumulative_limit_reserves_a_terminal_and_invalid_outgoing_frames_leave_the_wire_untouched()
{
    let payload = format!("\"{}\"", "x".repeat(MAX_RESPONSE_BYTES - 26));
    let chunk = event(&payload);
    assert_eq!(
        serde_json::to_vec(&chunk).unwrap().len(),
        MAX_RESPONSE_BYTES
    );
    let terminal = result(&format!("\"{}\"", "x".repeat(MAX_RESPONSE_BYTES - 27)));
    assert_eq!(
        serde_json::to_vec(&terminal).unwrap().len(),
        MAX_RESPONSE_BYTES
    );
    let mut bytes = Vec::new();
    let mut writer = ResponseWriter::new(&mut bytes);
    assert!(
        writer
            .send(&event(&format!("\"{}\"", "x".repeat(MAX_RESPONSE_BYTES))))
            .await
            .is_err()
    );
    let mut events = 0;
    while writer.send(&chunk).await.is_ok() {
        events += 1;
        assert!(events < MAX_RESPONSE_STREAM_BYTES / MAX_RESPONSE_BYTES);
    }
    assert!(events > 1);
    writer.send(&terminal).await.unwrap();
    assert!(bytes.len() <= MAX_RESPONSE_STREAM_BYTES);
    // The next advertised body is below the per-frame cap but exceeds the
    // aggregate remainder. Reject its header without trying to read its body.
    let remaining = MAX_RESPONSE_STREAM_BYTES - bytes.len();
    assert!(remaining < MAX_RESPONSE_BYTES);
    bytes.extend(((remaining.saturating_sub(4) + 1) as u32).to_be_bytes());
    let mut reader = ResponseReader::new(bytes.as_slice());
    for _ in 0..events {
        assert!(matches!(
            reader.next().await.unwrap(),
            Some(Response::Event { .. })
        ));
    }
    assert!(matches!(
        reader.next().await.unwrap(),
        Some(Response::Result { .. })
    ));
    assert_eq!(
        reader.next().await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
}

#[tokio::test]
async fn cancelled_partial_reader_and_writer_cannot_resume_mid_frame() {
    let (mut peer, host) = UnixStream::pair().unwrap();
    peer.write_all(&[0, 0]).await.unwrap();
    let mut reader = ResponseReader::new(host);
    assert!(
        timeout(Duration::from_millis(10), reader.next())
            .await
            .is_err()
    );
    assert!(reader.next().await.is_err());

    let (host, _peer) = tokio::io::duplex(5);
    let mut writer = ResponseWriter::new(host);
    assert!(
        timeout(Duration::from_millis(10), writer.send(&event("{}")))
            .await
            .is_err()
    );
    assert!(writer.send(&result("null")).await.is_err());
}
