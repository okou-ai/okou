//! Environment-neutral regressions for observing large integration fixtures.
mod common;

use common::{RecordedHttpEvent, RecordedRequest, RecordingServer};
use serde_json::{Value, json};
use std::time::Duration;

#[test]
fn textual_json_observation_preserves_fixture_sentinel_checks() -> serde_json::Result<()> {
    let fixtures = [
        json!({"nested":[null,true,19,{"text":"你好\"\\\nbytes truncated for delivery"}]}),
        json!({"memoryCitation":null,"private-memory-key":[{"note":"private-note"}]}),
        json!([
            "delivery-secret-value",
            "[event content truncated for delivery]",
            "11111111-1111-4111-8111-111111111111"
        ]),
        json!([null, false, 19, {"plain":"no fixture markers"}]),
    ];
    for value in fixtures {
        let serialized = serde_json::to_string(&value)?;
        for needle in [
            "for delivery",
            "memoryCitation",
            "private-memory",
            "private-note",
            "delivery-secret-value",
            "[event content truncated for delivery]",
            "11111111-1111-4111-8111-111111111111",
            "absent-sentinel",
        ] {
            assert_eq!(
                common::contains_json_text(&value, needle),
                serialized.contains(needle),
                "fixture sentinel {needle}"
            );
        }
    }
    assert!(!common::contains_json_text(&Value::Bool(true), "true"));
    assert!(!common::contains_json_text(&json!(19), "19"));
    Ok(())
}

#[test]
fn sequence_observation_preserves_order_and_u32_boundaries()
-> Result<(), Box<dyn std::error::Error>> {
    let body = json!({
        "events": [
            {"sequenceNumber":0,"content":"你好\"\\\n".repeat(256 * 1024)},
            {"sequenceNumber":u32::MAX,"nested":{"sequenceNumber":99}},
            {"sequenceNumber":7,"content":[null,true,19,{"text":"tail"}]},
        ],
        "piMemoryCitationTransport":{"citations":[{"sequenceNumber":3}]}
    });
    let request = RecordedRequest {
        path: "/api/webhooks/agent/events".into(),
        authorization: None,
        content_type: None,
        client_request_id: None,
        body: serde_json::to_string(&body)?,
    };
    assert_eq!(common::event_request_sequences(&request)?, [0, u32::MAX, 7]);
    assert_eq!(serde_json::from_str::<Value>(&request.body)?, body);
    Ok(())
}

#[test]
fn sequence_observation_rejects_missing_malformed_and_out_of_range_metadata() {
    for body in [
        "not JSON",
        r#"{"events":[],"unused":[}"#,
        r#"{"events":[]} trailing"#,
        r#"{"events":[{"sequenceNumber":1,"unused":"bad\xescape"}]}"#,
        r#"[[]]"#,
        r#"{}"#,
        r#"{"events":null}"#,
        r#"{"events":{}}"#,
        r#"{"events":[null]}"#,
        r#"{"events":[[1]]}"#,
        r#"{"events":[{}]}"#,
        r#"{"events":[{"sequenceNumber":null}]}"#,
        r#"{"events":[{"sequenceNumber":"1"}]}"#,
        r#"{"events":[{"sequenceNumber":-1}]}"#,
        r#"{"events":[{"sequenceNumber":1.0}]}"#,
        r#"{"events":[{"sequenceNumber":4294967296}]}"#,
        r#"{"events":[{"sequenceNumber":1},{"content":"missing metadata"}]}"#,
    ] {
        let request = RecordedRequest {
            path: "/api/webhooks/agent/events".into(),
            authorization: None,
            content_type: None,
            client_request_id: None,
            body: body.into(),
        };
        assert!(common::event_request_sequences(&request).is_err(), "{body}");
    }
}

#[test]
fn periodic_png_fixture_preserves_dimensions_crc_and_every_uncompressed_pixel()
-> Result<(), Box<dyn std::error::Error>> {
    use base64::Engine as _;
    use std::io::Read as _;

    for (width, height) in [
        (1_u32, 1_u32),
        (255, 255),
        (256, 256),
        (257, 257),
        (1024, 512),
        (1024, 1024),
    ] {
        let png = base64::engine::general_purpose::STANDARD
            .decode(common::delivery_image::png_base64(width, height)?)?;
        let mut input = std::io::Cursor::new(&png);
        let mut signature = [0; 8];
        input.read_exact(&mut signature)?;
        assert_eq!(&signature, b"\x89PNG\r\n\x1a\n");
        let mut compressed = Vec::new();
        let mut kinds = Vec::new();
        while input.position() < png.len() as u64 {
            let mut length = [0; 4];
            let mut kind = [0; 4];
            input.read_exact(&mut length)?;
            input.read_exact(&mut kind)?;
            let length = u32::from_be_bytes(length) as usize;
            assert!(length <= png.len(), "chunk cannot exceed the fixture");
            let mut data = vec![0; length];
            input.read_exact(&mut data)?;
            let mut checksum = [0; 4];
            input.read_exact(&mut checksum)?;
            let mut crc = flate2::Crc::new();
            crc.update(&kind);
            crc.update(&data);
            assert_eq!(checksum, crc.sum().to_be_bytes());
            match &kind {
                b"IHDR" => {
                    assert_eq!(data.len(), 13);
                    let mut header = std::io::Cursor::new(&data);
                    let mut actual_width = [0; 4];
                    let mut actual_height = [0; 4];
                    let mut format = [0; 5];
                    header.read_exact(&mut actual_width)?;
                    header.read_exact(&mut actual_height)?;
                    header.read_exact(&mut format)?;
                    assert_eq!(actual_width, width.to_be_bytes());
                    assert_eq!(actual_height, height.to_be_bytes());
                    assert_eq!(format, [8, 2, 0, 0, 0]);
                }
                b"IDAT" => compressed.extend_from_slice(&data),
                b"IEND" => assert!(data.is_empty()),
                _ => panic!("unexpected PNG chunk"),
            }
            kinds.push(kind);
        }
        assert_eq!(input.position(), png.len() as u64);
        assert_eq!(kinds, [*b"IHDR", *b"IDAT", *b"IEND"]);
        let mut actual = Vec::new();
        flate2::read::ZlibDecoder::new(compressed.as_slice()).read_to_end(&mut actual)?;
        let expected = (0..height)
            .flat_map(|row| {
                std::iter::once(0).chain(
                    (0..width)
                        .flat_map(move |column| [(row % 256) as u8, (column % 256) as u8, 128]),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{width}x{height}");
    }
    Ok(())
}

#[tokio::test]
async fn raw_http_recording_preserves_headers_and_lossy_body()
-> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let server = RecordingServer::start(503, Duration::ZERO).await?;
    let addr = server
        .base_url
        .strip_prefix("http://")
        .ok_or("missing address")?;
    let mut expected = Vec::new();
    for (path, body, status) in [
        ("/empty", Vec::new(), 200),
        (
            "/channels/raw",
            b"head\r\n\r\n\0\xff\xce\xb1\xfe-tail".to_vec(),
            503,
        ),
    ] {
        let headers = format!(
            "POST {path} HTTP/1.1\r\naUthorization: Bearer fixture-token\r\ncOntent-Type: application/octet-stream\r\nx-client-request-id: fixture-id\r\ncOntent-Length: {}\r\n\r\n",
            body.len()
        );
        let mut wire = headers.into_bytes();
        wire.extend_from_slice(&body);
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut socket = tokio::net::TcpStream::connect(addr).await?;
            for chunk in wire.chunks(3) {
                socket.write_all(chunk).await?;
            }
            socket.shutdown().await?;
            let mut response = Vec::new();
            socket.read_to_end(&mut response).await?;
            assert!(response.starts_with(format!("HTTP/1.1 {status} ").as_bytes()));
            Ok::<_, std::io::Error>(())
        })
        .await??;
        expected.extend([
            RecordedHttpEvent::Request(RecordedRequest {
                path: path.into(),
                authorization: Some("Bearer fixture-token".into()),
                content_type: Some("application/octet-stream".into()),
                client_request_id: Some("fixture-id".into()),
                body: String::from_utf8_lossy(&body).into_owned(),
            }),
            RecordedHttpEvent::Response {
                path: path.into(),
                status,
            },
        ]);
    }
    assert_eq!(server.events()?, expected);
    Ok(())
}

#[tokio::test]
async fn raw_http_recording_rejects_early_close_without_recording_partial_requests()
-> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let server = RecordingServer::start(200, Duration::ZERO).await?;
    let addr = server
        .base_url
        .strip_prefix("http://")
        .ok_or("missing address")?;
    for wire in [
        "POST /partial HTTP/1.1\r\nContent-Length: 5\r\n".to_string(),
        "POST /partial HTTP/1.1\r\nContent-Length: 5\r\n\r\nab".to_string(),
        format!(
            "POST /partial HTTP/1.1\r\nContent-Length: {}\r\n\r\nab",
            usize::MAX / 2
        ),
    ] {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut socket = tokio::net::TcpStream::connect(addr).await?;
            socket.write_all(wire.as_bytes()).await?;
            socket.shutdown().await?;
            let mut response = Vec::new();
            socket.read_to_end(&mut response).await?;
            assert!(response.starts_with(b"HTTP/1.1 400 Bad Request\r\n"));
            Ok::<_, std::io::Error>(())
        })
        .await??;
        assert!(server.events()?.is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn quiet_recording_returns_complete_independent_http_snapshots()
-> Result<(), Box<dyn std::error::Error>> {
    let server = RecordingServer::start(200, Duration::ZERO).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let body = format!("large-fixture-head-{}-tail", "α".repeat(1024 * 1024));
    let waiting = server.wait_for_quiet(Duration::from_millis(20), Duration::from_secs(5));
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    for path in ["/first", "/second"] {
        assert_eq!(
            client
                .post(format!("{}{path}", server.base_url))
                .header("Authorization", "Bearer fixture-token")
                .header("Content-Type", "text/plain")
                .body(body.clone())
                .send()
                .await?
                .status(),
            reqwest::StatusCode::OK
        );
    }
    let snapshot = waiting.await?;
    let expected = ["/first", "/second"]
        .into_iter()
        .flat_map(|path| {
            [
                RecordedHttpEvent::Request(RecordedRequest {
                    path: path.into(),
                    authorization: Some("Bearer fixture-token".into()),
                    content_type: Some("text/plain".into()),
                    client_request_id: None,
                    body: body.clone(),
                }),
                RecordedHttpEvent::Response {
                    path: path.into(),
                    status: 200,
                },
            ]
        })
        .collect::<Vec<_>>();
    assert_eq!(snapshot, expected);
    assert_eq!(server.events()?, expected);
    assert_eq!(server.requests()?.len(), 2);
    assert_eq!(
        client
            .post(format!("{}/third", server.base_url))
            .body("third-body")
            .send()
            .await?
            .status(),
        reqwest::StatusCode::OK
    );
    let next = server
        .wait_for_quiet(Duration::from_millis(20), Duration::from_secs(5))
        .await?;
    assert_eq!(next.len(), 6);
    assert_eq!(snapshot, expected);
    Ok(())
}

#[tokio::test]
async fn quiet_recording_preserves_timeout_error() -> Result<(), String> {
    let server = RecordingServer::start(200, Duration::ZERO).await?;
    let error = server
        .wait_for_quiet(Duration::from_secs(60), Duration::ZERO)
        .await
        .expect_err("a zero timeout cannot establish a nonzero quiet period");
    assert_eq!(
        error,
        "recording server did not become quiet within 0ns; observed 0 events"
    );
    Ok(())
}
