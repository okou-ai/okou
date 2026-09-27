use super::*;
use httpmock::MockServer;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// A one-shot-per-connection server: unlike static mocks, this can prove
/// which retry attempt received which response. The URL never leaves localhost.
async fn scripted_server(
    responses: Vec<impl Into<String>>,
) -> (Url, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let responses = responses
        .into_iter()
        .map(Into::into)
        .collect::<Vec<String>>();
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for response in responses {
            let (mut connection, _) =
                tokio::time::timeout(Duration::from_secs(5), listener.accept())
                    .await
                    .expect("retry attempt did not arrive")
                    .unwrap();
            let mut received = Vec::new();
            loop {
                let mut buf = [0u8; 4096];
                let n = connection.read(&mut buf).await.unwrap();
                assert!(n > 0, "request closed before headers");
                received.extend_from_slice(&buf[..n]);
                if received.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let header_end = received.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            let request = String::from_utf8(received[..header_end].to_vec()).unwrap();
            assert!(request.to_ascii_lowercase().contains("authorization:"));
            requests.push(request);
            connection.write_all(response.as_bytes()).await.unwrap();
            connection.shutdown().await.unwrap();
        }
        requests
    });
    (url, handle)
}

fn mock_reply(status: &str, body: &str, headers: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    )
}

fn signed_date(request: &str) -> chrono::DateTime<chrono::Utc> {
    let line = request
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("x-amz-date:"))
        .unwrap();
    chrono::NaiveDateTime::parse_from_str(line.split_once(':').unwrap().1.trim(), "%Y%m%dT%H%M%SZ")
        .unwrap()
        .and_utc()
}

fn client(server: &MockServer) -> R2HttpClient {
    R2HttpClient::with_endpoint(
        Url::parse(&server.base_url()).unwrap(),
        "test-bucket".into(),
        "AKIDEXAMPLE".into(),
        "not-a-real-secret".into(),
    )
    .unwrap()
}

#[tokio::test]
async fn head_signs_s3_request_and_treats_only_404_as_miss() {
    let server = MockServer::start_async().await;
    let head = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/hash.tar.zst")
                .header_exists("authorization")
                .header(
                    "x-amz-content-sha256",
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                );
            then.status(200);
        })
        .await;
    let missing = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/missing.tar.zst");
            then.status(404);
        })
        .await;
    let forbidden = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/forbidden.tar.zst");
            then.status(403);
        })
        .await;
    let c = client(&server);
    assert!(!format!("{c:?}").contains("not-a-real-secret"));
    assert!(c.head("runner-templates/hash.tar.zst").await.unwrap());
    assert!(!c.head("runner-templates/missing.tar.zst").await.unwrap());
    assert!(c.head("runner-templates/forbidden.tar.zst").await.is_err());
    head.assert_calls_async(1).await;
    missing.assert_calls_async(1).await;
    forbidden.assert_calls_async(1).await;
}

#[tokio::test]
async fn get_streams_body_and_only_nosuchkey_is_a_miss() {
    let server = MockServer::start_async().await;
    let body = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/hash.tar.zst")
                .header_exists("authorization");
            then.status(200)
                .header("content-length", "7")
                .body("content");
        })
        .await;
    let not_found = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/missing.tar.zst");
            then.status(404)
                .body("<Error><Code>NoSuchKey</Code></Error>");
        })
        .await;
    let bucket_error = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/bad.tar.zst");
            then.status(404)
                .body("<Error><Code>NoSuchBucket</Code></Error>");
        })
        .await;
    let c = client(&server);
    let mut download = c
        .get("runner-templates/hash.tar.zst")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(download.content_length, Some(7));
    let mut bytes = Vec::new();
    download.body.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"content");
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert!(c.get("runner-templates/bad.tar.zst").await.is_err());
    body.assert_calls_async(1).await;
    not_found.assert_calls_async(1).await;
    bucket_error.assert_calls_async(1).await;
}

#[tokio::test]
async fn multipart_wire_protocol_preserves_query_body_and_etag() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/h.tar.zst";
    let create = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads")
            .header_exists("authorization");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id+/&amp;=</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path(key)
                .query_param("uploadId", "id+/&=")
                .query_param("partNumber", "1")
                .body("payload")
                .header("x-amz-sdk-checksum-algorithm", "CRC32")
                .header("x-amz-checksum-crc32", "QixqFQ==")
                .header_exists("authorization");
            then.status(200).header("etag", "\"etag<&\"");
        })
        .await;
    let complete = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param("uploadId", "id+/&=")
            .body_includes("<ETag>&quot;etag&lt;&amp;&quot;</ETag>")
            .body_includes("<PartNumber>1</PartNumber>");
        then.status(200).body("<CompleteMultipartUploadResult><ETag>\"whole\"</ETag></CompleteMultipartUploadResult>");
    }).await;
    let c = client(&server);
    let id = c
        .create_multipart("runner-templates/h.tar.zst")
        .await
        .unwrap();
    assert_eq!(id, "id+/&=");
    let part_result = c
        .upload_part(
            "runner-templates/h.tar.zst",
            &id,
            1,
            Bytes::from_static(b"payload"),
        )
        .await
        .unwrap();
    assert_eq!(
        part_result,
        Part {
            number: 1,
            etag: "\"etag<&\"".into()
        }
    );
    c.complete_multipart("runner-templates/h.tar.zst", &id, &[part_result])
        .await
        .unwrap();
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
}

#[tokio::test]
async fn complete_http_200_embedded_error_fails_and_caller_can_abort() {
    let server = MockServer::start_async().await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "x");
            then.status(200)
                .body("  <Error><Code>InvalidPart</Code><Message>bad part</Message></Error>");
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "x");
            then.status(204);
        })
        .await;
    let c = client(&server);
    let result = c
        .complete_multipart(
            "runner-templates/h.tar.zst",
            "x",
            &[Part {
                number: 1,
                etag: "e".into(),
            }],
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("InvalidPart"));
    c.abort_multipart("runner-templates/h.tar.zst", "x")
        .await
        .unwrap();
    complete.assert_calls_async(1).await;
    abort.assert_calls_async(1).await;
}

#[tokio::test]
async fn transient_failure_retries_signed_head_and_upload_part() {
    let (url, server) = scripted_server(vec![
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(c.head("runner-templates/h.tar.zst").await.unwrap());
    assert_eq!(server.await.unwrap().len(), 2);

    let (url, server) = scripted_server(vec![
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nETag: \"part\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let part = c
        .upload_part(
            "runner-templates/h.tar.zst",
            "upload",
            1,
            Bytes::from_static(b"\xff\x00payload"),
        )
        .await
        .unwrap();
    assert_eq!(part.etag, "\"part\"");
    assert_eq!(server.await.unwrap().len(), 2);
}

#[tokio::test]
async fn retryable_status_does_not_depend_on_bounded_error_body() {
    let (url, server) = scripted_server(vec![
        mock_reply(
            "503 Service Unavailable",
            &"x".repeat(MAX_ERROR_BYTES + 616),
            "",
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(server.await.unwrap().len(), 2);
}

#[tokio::test]
async fn sdk_style_clock_skew_retry_requires_trustworthy_date_and_persists() {
    let future = chrono::Utc::now() + chrono::Duration::minutes(10);
    let date = future.format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let (url, server) = scripted_server(vec![
        mock_reply(
            "403 Forbidden",
            "<Error><Code>RequestTimeTooSkewed</Code></Error>",
            &format!("Date: {date}\r\n"),
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
        mock_reply("404 Not Found", "", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert!(!c.head("runner-templates/another.tar.zst").await.unwrap());
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    for request in &requests[1..] {
        assert!(
            (570..=630).contains(&(signed_date(request) - signed_date(&requests[0])).num_seconds())
        );
    }

    let server = MockServer::start_async().await;
    let cached = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(403)
                .header("date", &date)
                .header("age", "0")
                .body("<Error><Code>RequestTimeTooSkewed</Code></Error>");
        })
        .await;
    assert!(
        client(&server)
            .get("runner-templates/h.tar.zst")
            .await
            .is_err()
    );
    cached.assert_calls_async(1).await;

    let near_date = (chrono::Utc::now() + chrono::Duration::minutes(2))
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string();
    let server = MockServer::start_async().await;
    let near = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(403)
                .header("date", &near_date)
                .body("<Error><Code>RequestTimeTooSkewed</Code></Error>");
        })
        .await;
    assert!(
        client(&server)
            .get("runner-templates/h.tar.zst")
            .await
            .is_err()
    );
    near.assert_calls_async(1).await;
}

#[tokio::test]
async fn sdk_style_retry_quota_blocks_extra_attempts_and_recovers_on_success() {
    let server = MockServer::start_async().await;
    let unavailable = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(503);
        })
        .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(
        Url::parse(&server.base_url()).unwrap(),
        "test-bucket".into(),
        0,
    )
    .unwrap();
    assert!(c.get("runner-templates/h.tar.zst").await.is_err());
    unavailable.assert_calls_async(1).await;

    let (url, attempts) = scripted_server(vec![
        mock_reply(
            "400 Bad Request",
            "<Error><Code>LimitExceededException</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("200 OK", "", ""),
        mock_reply(
            "400 Bad Request",
            "<Error><Code>LimitExceededException</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("200 OK", "", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(url, "test-bucket".into(), 5).unwrap();
    for _ in 0..2 {
        assert!(c.get("runner-templates/h.tar.zst").await.unwrap().is_some());
        assert_eq!(c.retry_quota.available_permits(), 5);
    }
    assert_eq!(attempts.await.unwrap().len(), 4);

    let server = MockServer::start_async().await;
    let transient = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(503)
                .body("<Error><Code>InternalError</Code></Error>");
        })
        .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(
        Url::parse(&server.base_url()).unwrap(),
        "test-bucket".into(),
        5,
    )
    .unwrap();
    assert!(c.get("runner-templates/h.tar.zst").await.is_err());
    transient.assert_calls_async(1).await;
}

#[tokio::test]
async fn pinned_sdk_retries_limit_exceeded_and_404_slowdown_but_not_head_404() {
    let (url, requests) = scripted_server(vec![
        mock_reply(
            "400 Bad Request",
            "<Error><Code>LimitExceededException</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(requests.await.unwrap().len(), 2);

    let (url, requests) = scripted_server(vec![
        mock_reply(
            "404 Not Found",
            "<Error><Code>SlowDown</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(requests.await.unwrap().len(), 2);

    let server = MockServer::start_async().await;
    let head = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/missing.tar.zst");
            then.status(404)
                .body("<Error><Code>SlowDown</Code></Error>");
        })
        .await;
    assert!(
        !client(&server)
            .head("runner-templates/missing.tar.zst")
            .await
            .unwrap()
    );
    head.assert_calls_async(1).await;
}

#[tokio::test]
async fn sdk_status_costs_and_throttling_override_share_retry_quota() {
    let server = MockServer::start_async().await;
    let unavailable = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(503);
        })
        .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(
        server.base_url().parse().unwrap(),
        "test-bucket".into(),
        5,
    )
    .unwrap();
    assert!(c.get("runner-templates/h.tar.zst").await.is_err());
    unavailable.assert_calls_async(1).await;

    let (url, attempts) = scripted_server(vec![
        mock_reply("503 Service Unavailable", "", "x-amz-retry-after: 0\r\n"),
        mock_reply("200 OK", "", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(url, "test-bucket".into(), 10).unwrap();
    assert!(c.get("runner-templates/h.tar.zst").await.unwrap().is_some());
    assert_eq!(attempts.await.unwrap().len(), 2);

    let (url, attempts) = scripted_server(vec![
        mock_reply(
            "503 Service Unavailable",
            "<Error><Code>SlowDown</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("200 OK", "", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(url, "test-bucket".into(), 5).unwrap();
    assert!(c.get("runner-templates/h.tar.zst").await.unwrap().is_some());
    assert_eq!(attempts.await.unwrap().len(), 2);
}

#[tokio::test]
async fn multipart_operations_classify_404_error_codes_before_failing() {
    let throttled = || {
        mock_reply(
            "404 Not Found",
            "<Error><Code>SlowDown</Code></Error>",
            "x-amz-retry-after: 0\r\n",
        )
    };
    let (url, attempts) = scripted_server(vec![
        throttled(),
        mock_reply("200 OK", "<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>", ""),
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert_eq!(
        c.create_multipart("runner-templates/h.tar.zst")
            .await
            .unwrap(),
        "id"
    );
    assert_eq!(attempts.await.unwrap().len(), 2);

    let (url, attempts) = scripted_server(vec![
        throttled(),
        mock_reply("200 OK", "", "ETag: \"part\"\r\n"),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let part = c
        .upload_part(
            "runner-templates/h.tar.zst",
            "id",
            1,
            Bytes::from_static(b"part"),
        )
        .await
        .unwrap();
    assert_eq!(part.etag, "\"part\"");
    assert_eq!(attempts.await.unwrap().len(), 2);

    let (url, attempts) = scripted_server(vec![
        throttled(),
        mock_reply("200 OK", "<CompleteMultipartUploadResult/>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    c.complete_multipart("runner-templates/h.tar.zst", "id", &[])
        .await
        .unwrap();
    assert_eq!(attempts.await.unwrap().len(), 2);

    let (url, attempts) =
        scripted_server(vec![throttled(), mock_reply("204 No Content", "", "")]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    c.abort_multipart("runner-templates/h.tar.zst", "id")
        .await
        .unwrap();
    assert_eq!(attempts.await.unwrap().len(), 2);
}

#[tokio::test]
async fn complete_retries_embedded_internal_error_but_not_invalid_part() {
    let (url, server) = scripted_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 41\r\nConnection: close\r\n\r\n<Error><Code>InternalError</Code></Error>",
        "HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\n<CompleteMultipartUploadResult/>",
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    c.complete_multipart("runner-templates/h.tar.zst", "upload", &[])
        .await
        .unwrap();
    assert_eq!(server.await.unwrap().len(), 2);
}

#[tokio::test]
async fn xml_body_read_failures_retry_within_the_same_attempt_budget() {
    let (url, server) = scripted_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>",
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert_eq!(
        c.create_multipart("runner-templates/h.tar.zst")
            .await
            .unwrap(),
        "id"
    );
    assert_eq!(server.await.unwrap().len(), 2);

    let (url, server) = scripted_server(vec![
        "HTTP/1.1 404 Not Found\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n<Error><Code>NoSuchKey</Code></Error>",
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/missing.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(server.await.unwrap().len(), 2);
}

#[tokio::test]
async fn lost_complete_response_retries_but_does_not_infer_success_from_nosuchupload() {
    let (url, server) = scripted_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 404 Not Found\r\nContent-Length: 40\r\nConnection: close\r\n\r\n<Error><Code>NoSuchUpload</Code></Error>",
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let error = c
        .complete_multipart("runner-templates/h.tar.zst", "upload", &[])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("NoSuchUpload"), "{error}");
    assert_eq!(server.await.unwrap().len(), 2);
}

#[tokio::test]
async fn upload_part_requires_etag_and_validates_key_segments() {
    let server = MockServer::start_async().await;
    let no_etag = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(200);
        })
        .await;
    let c = client(&server);
    assert!(
        c.upload_part("runner-templates/h.tar.zst", "id", 1, Bytes::new())
            .await
            .unwrap_err()
            .to_string()
            .contains("missing e_tag")
    );
    assert!(c.head("runner-templates/../h.tar.zst").await.is_err());
    no_etag.assert_calls_async(1).await;
}
