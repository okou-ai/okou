use super::*;
use http_body::Body as _;
use std::future::poll_fn;

#[test]
fn completed_http_failures_preserve_diagnostic_wire_facts() {
    let cases = [
        (
            RetryableFailure::HttpStatus(503),
            serde_json::json!({ "failureKind": "http_status", "httpStatus": 503 }),
        ),
        (
            RetryableFailure::Timeout {
                connect_observed: false,
            },
            serde_json::json!({
                "failureKind": "timeout",
                "timeoutObserved": true,
                "connectObserved": false
            }),
        ),
        (
            RetryableFailure::Timeout {
                connect_observed: true,
            },
            serde_json::json!({
                "failureKind": "timeout",
                "timeoutObserved": true,
                "connectObserved": true
            }),
        ),
        (
            RetryableFailure::Connect,
            serde_json::json!({
                "failureKind": "connect",
                "timeoutObserved": false,
                "connectObserved": true
            }),
        ),
        (
            RetryableFailure::Transport,
            serde_json::json!({
                "failureKind": "transport",
                "timeoutObserved": false,
                "connectObserved": false
            }),
        ),
    ];

    for (failure, mut expected) in cases {
        let diagnostic = HttpAttemptFinished {
            attempt: 3,
            client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
            elapsed_ms: 12_345,
            outcome: failure.attempt_outcome(),
        }
        .into_failure_diagnostic()
        .expect("failed attempt should retain its diagnostic");

        expected["attempt"] = serde_json::json!(3);
        expected["clientRequestId"] = serde_json::json!("11111111-1111-4111-8111-111111111111");
        expected["elapsedMs"] = serde_json::json!(12_345);
        assert_eq!(diagnostic.failure_kind.as_str(), expected["failureKind"]);
        assert_eq!(serde_json::to_value(&diagnostic).unwrap(), expected);
    }
}

#[test]
fn completed_http_success_has_no_failure_diagnostic() {
    let attempt = HttpAttemptFinished {
        attempt: 2,
        client_request_id: "22222222-2222-4222-8222-222222222222".to_string(),
        elapsed_ms: 17,
        outcome: HttpAttemptOutcome::Success,
    };

    assert_eq!(attempt.into_failure_diagnostic(), None);
}

async fn sized_body_from_bytes(data: &[u8]) -> (tempfile::TempDir, SizedBody) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("body.bin");
    tokio::fs::write(&path, data).await.unwrap();
    let file = tokio::fs::File::open(&path).await.unwrap();
    let file_len = file.metadata().await.unwrap().len();
    (dir, SizedBody::new(file, file_len))
}

async fn next_data(body: &mut SizedBody) -> Option<Bytes> {
    let frame = poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx))
        .await
        .transpose()
        .unwrap()?;
    match frame.into_data() {
        Ok(data) => Some(data),
        Err(_) => panic!("expected data frame"),
    }
}

#[tokio::test]
async fn disabled_client_fails_before_request_build() {
    let client = HttpClient {
        inner: None,
        retry_delay: DEFAULT_RETRY_DELAY,
        api: None,
    };
    let result = client
        .post_json("http://127.0.0.1:1/test", &serde_json::json!({}), 1)
        .await;

    let Err(AgentError::Http(message)) = result else {
        panic!("expected disabled HTTP client error");
    };
    assert!(message.contains("HTTP client is disabled"));
}

#[tokio::test]
async fn disabled_client_raw_upload_fails_before_request_build() {
    let client = HttpClient {
        inner: None,
        retry_delay: DEFAULT_RETRY_DELAY,
        api: None,
    };
    let result = client
        .put_presigned(
            "http://127.0.0.1:1/upload",
            Bytes::from_static(b"manifest"),
            "application/json",
        )
        .await;

    let Err(AgentError::Http(message)) = result else {
        panic!("expected disabled HTTP client error");
    };
    assert!(message.contains("HTTP client is disabled"));
}

#[tokio::test]
async fn disabled_client_stream_upload_fails_before_file_open() {
    let client = HttpClient {
        inner: None,
        retry_delay: DEFAULT_RETRY_DELAY,
        api: None,
    };
    let result = client
        .put_presigned_file(
            "http://127.0.0.1:1/upload",
            Path::new("/definitely/missing/source.bin"),
            "application/octet-stream",
        )
        .await;

    let Err(AgentError::Http(message)) = result else {
        panic!("expected disabled HTTP client error");
    };
    assert!(message.contains("HTTP client is disabled"));
}

#[tokio::test]
async fn sized_body_streams_large_file_in_bounded_chunks() {
    let data: Vec<u8> = (0..(STREAM_CHUNK_SIZE * 2 + 37))
        .map(|i| (i % 251) as u8)
        .collect();
    for read_size in [STREAM_CHUNK_SIZE, 8192] {
        for retain_frames in [false, true] {
            let (_dir, mut body) = sized_body_from_bytes(&data).await;
            // Force legal short reads through the real file reader.
            body.reader.set_max_buf_size(read_size);

            let mut remaining = data.len() as u64;
            assert_eq!(body.size_hint().exact(), Some(remaining));
            assert!(!body.is_end_stream());

            let mut chunks = 0;
            let mut uploaded = Vec::with_capacity(data.len());
            let mut retained = Vec::new();
            while let Some(chunk) = next_data(&mut body).await {
                assert!(!chunk.is_empty());
                assert!(chunk.len() <= read_size);
                chunks += 1;
                remaining -= chunk.len() as u64;
                assert_eq!(body.size_hint().exact(), Some(remaining));
                assert_eq!(body.is_end_stream(), remaining == 0);
                uploaded.extend_from_slice(&chunk);
                if retain_frames {
                    retained.push(chunk);
                }
            }

            assert!(chunks > 1);
            assert_eq!(uploaded, data);
            if retain_frames {
                assert_eq!(retained.concat(), data);
            }
            assert_eq!(body.size_hint().exact(), Some(0));
            assert!(body.is_end_stream());
            assert!(next_data(&mut body).await.is_none());
        }
    }
}

#[tokio::test]
async fn sized_body_streams_small_file_once() {
    let data = b"streaming body";
    let (_dir, mut body) = sized_body_from_bytes(data).await;

    assert_eq!(body.size_hint().exact(), Some(data.len() as u64));
    let chunk = next_data(&mut body).await.unwrap();

    assert_eq!(&chunk[..], data);
    assert_eq!(body.size_hint().exact(), Some(0));
    assert!(next_data(&mut body).await.is_none());
}

#[tokio::test]
async fn sized_body_streams_exact_chunk_once() {
    let data = vec![0x5Au8; STREAM_CHUNK_SIZE];
    let (_dir, mut body) = sized_body_from_bytes(&data).await;

    assert_eq!(body.size_hint().exact(), Some(STREAM_CHUNK_SIZE as u64));
    let chunk = next_data(&mut body).await.unwrap();

    assert_eq!(chunk.len(), STREAM_CHUNK_SIZE);
    assert_eq!(&chunk[..], &data[..]);
    assert_eq!(body.size_hint().exact(), Some(0));
    assert!(body.is_end_stream());
    assert!(next_data(&mut body).await.is_none());
}

#[tokio::test]
async fn sized_body_empty_file_has_no_frames() {
    let (_dir, mut body) = sized_body_from_bytes(&[]).await;

    assert_eq!(body.size_hint().exact(), Some(0));
    assert!(next_data(&mut body).await.is_none());
    assert!(body.is_end_stream());
}

#[tokio::test]
async fn sized_body_does_not_stream_bytes_added_after_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("body.bin");
    tokio::fs::write(&path, b"initial").await.unwrap();
    let file = tokio::fs::File::open(&path).await.unwrap();
    let file_len = file.metadata().await.unwrap().len();
    let mut body = SizedBody::new(file, file_len);

    tokio::fs::write(&path, b"initial-extra").await.unwrap();

    let chunk = next_data(&mut body).await.unwrap();
    assert_eq!(&chunk[..], b"initial");
    assert_eq!(body.size_hint().exact(), Some(0));
    assert!(next_data(&mut body).await.is_none());
}

#[tokio::test]
async fn sized_body_errors_when_file_is_shorter_than_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("body.bin");
    tokio::fs::write(&path, b"initial-extra").await.unwrap();
    let file = tokio::fs::File::open(&path).await.unwrap();
    let file_len = file.metadata().await.unwrap().len();
    let mut body = SizedBody::new(file, file_len);

    tokio::fs::write(&path, b"initial").await.unwrap();

    let chunk = next_data(&mut body).await.unwrap();
    assert_eq!(&chunk[..], b"initial");
    let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .expect("expected a frame")
        .expect_err("expected early EOF error");

    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    assert_eq!(body.size_hint().exact(), Some(0));
}

#[tokio::test]
async fn sized_body_errors_when_file_is_truncated_before_first_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("body.bin");
    tokio::fs::write(&path, b"initial").await.unwrap();
    let file = tokio::fs::File::open(&path).await.unwrap();
    let file_len = file.metadata().await.unwrap().len();
    let mut body = SizedBody::new(file, file_len);

    tokio::fs::write(&path, &[]).await.unwrap();

    let error = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
        .await
        .expect("expected a frame")
        .expect_err("expected early EOF error");

    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    assert_eq!(body.size_hint().exact(), Some(0));
    assert!(body.is_end_stream());
}
