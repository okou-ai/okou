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
async fn head_accepts_all_sdk_success_statuses_but_not_304() {
    let server = MockServer::start_async().await;
    let statuses = [200u16, 201, 204, 206, 304];
    let mut mocks = Vec::new();
    for status in statuses {
        let key = format!("/test-bucket/runner-templates/status-{status}.tar.zst");
        mocks.push(
            server
                .mock_async(move |when, then| {
                    when.method("HEAD").path(&key);
                    then.status(status);
                })
                .await,
        );
    }
    let c = client(&server);
    for status in statuses {
        let result = c
            .head(&format!("runner-templates/status-{status}.tar.zst"))
            .await;
        if status == 304 {
            assert!(result.is_err(), "304 must not be treated as success");
        } else {
            assert!(result.unwrap(), "SDK treats HEAD {status} as a hit");
        }
    }
    for mock in mocks {
        mock.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn modeled_success_headers_fail_closed_like_the_sdk() {
    let server = MockServer::start_async().await;
    let headers = [
        ("parts", "x-amz-mp-parts-count", "not-a-number"),
        ("date", "last-modified", "not-a-date"),
        (
            "bool",
            "x-amz-server-side-encryption-bucket-key-enabled",
            "maybe",
        ),
    ];
    let mut mocks = Vec::new();
    for (suffix, header, value) in headers {
        for method in ["HEAD", "GET"] {
            let path = format!("/test-bucket/runner-templates/{method}-{suffix}.tar.zst");
            mocks.push(
                server
                    .mock_async(move |when, then| {
                        when.method(method).path(&path);
                        then.status(200).header(header, value).body("data");
                    })
                    .await,
            );
        }
    }
    let c = client(&server);
    for (suffix, ..) in headers {
        assert!(
            c.head(&format!("runner-templates/HEAD-{suffix}.tar.zst"))
                .await
                .is_err()
        );
        assert!(
            c.get(&format!("runner-templates/GET-{suffix}.tar.zst"))
                .await
                .is_err()
        );
    }
    let good = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/good.tar.zst");
            then.status(200)
                .header("x-amz-mp-parts-count", "2")
                .header("last-modified", "Sun, 06 Nov 1994 08:49:37 GMT")
                .header("x-amz-server-side-encryption-bucket-key-enabled", "false");
        })
        .await;
    assert!(c.head("runner-templates/good.tar.zst").await.unwrap());
    for mock in mocks {
        mock.assert_calls_async(1).await;
    }
    good.assert_calls_async(1).await;
}

#[test]
fn http_dates_use_pinned_smithy_parser_not_generic_httpdate() {
    let mut headers = HeaderMap::new();
    for value in [
        "Sunday, 06-Nov-94 08:49:37 GMT",
        "Sun Nov  6 08:49:37 1994",
        "invalid date",
    ] {
        headers.insert("last-modified", value.parse().unwrap());
        assert!(
            validate_date_header(&headers, "last-modified", SmithyDateFormat::HttpDate).is_err(),
            "{value}"
        );
    }
    for value in [
        "Sun, 06 Nov 1994 08:49:37 GMT",
        "Mon, 16 Dec 2019 23:48:18.123 GMT",
    ] {
        headers.insert("last-modified", value.parse().unwrap());
        assert!(
            validate_date_header(&headers, "last-modified", SmithyDateFormat::HttpDate).is_ok()
        );
    }
    headers.insert(
        "x-amz-object-lock-retain-until-date",
        "2026-09-27T01:00:00+01:00".parse().unwrap(),
    );
    assert!(
        validate_date_header(
            &headers,
            "x-amz-object-lock-retain-until-date",
            SmithyDateFormat::DateTimeWithOffset
        )
        .is_ok()
    );
}

#[tokio::test]
async fn duplicate_part_etag_and_invalid_create_abort_date_are_not_success() {
    let server = MockServer::start_async().await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path("/test-bucket/runner-templates/duplicate.tar.zst");
            then.status(200)
                .header("etag", "\"one\"")
                .header("etag", "\"two\"");
        })
        .await;
    let create = server.mock_async(|when, then| {
        when.method("POST").path("/test-bucket/runner-templates/create.tar.zst");
        then.status(200).header("x-amz-abort-date", "not-a-date")
            .body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let c = client(&server);
    let err = c
        .upload_part(
            "runner-templates/duplicate.tar.zst",
            "id",
            1,
            Bytes::from_static(b"data"),
        )
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("invalid R2 etag response header"),
        "{err}"
    );
    assert!(
        c.create_multipart("runner-templates/create.tar.zst")
            .await
            .is_err()
    );
    part.assert_calls_async(1).await;
    create.assert_calls_async(1).await;
}

#[tokio::test]
async fn modeled_single_value_headers_reject_duplicates_across_operations() {
    let server = MockServer::start_async().await;
    let head = server
        .mock_async(|when, then| {
            when.method("HEAD")
                .path("/test-bucket/runner-templates/head.tar.zst");
            then.status(200)
                .header("x-amz-meta-example", "first")
                .header("x-amz-meta-example", "second");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/get.tar.zst");
            then.status(200)
                .header("x-amz-checksum-crc32", "first")
                .header("x-amz-checksum-crc32", "second")
                .body("object");
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST")
                .path("/test-bucket/runner-templates/complete.tar.zst")
                .query_param("uploadId", "id");
            then.status(200)
                .header("x-amz-version-id", "first")
                .header("x-amz-version-id", "second")
                .body("<CompleteMultipartUploadResult/>");
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path("/test-bucket/runner-templates/abort.tar.zst");
            then.status(204)
                .header("x-amz-request-charged", "first")
                .header("x-amz-request-charged", "second");
        })
        .await;
    let c = client(&server);
    let error = c.head("runner-templates/head.tar.zst").await.unwrap_err();
    assert!(error.to_string().contains("x-amz-meta-example"), "{error}");
    let error = c.get("runner-templates/get.tar.zst").await.err().unwrap();
    assert!(
        error.to_string().contains("x-amz-checksum-crc32"),
        "{error}"
    );
    let error = c
        .complete_multipart("runner-templates/complete.tar.zst", "id", &[])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("x-amz-version-id"), "{error}");
    let error = c
        .abort_multipart("runner-templates/abort.tar.zst", "id")
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("x-amz-request-charged"),
        "{error}"
    );
    head.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
    abort.assert_calls_async(1).await;
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
async fn get_models_nosuchkey_by_xml_code_even_on_non_404_status() {
    let server = MockServer::start_async().await;
    let bad_request = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/bad-request.tar.zst");
            then.status(400)
                .body("<Error><Code>NoSuchKey</Code></Error>");
        })
        .await;
    let forbidden = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/forbidden.tar.zst");
            then.status(403)
                .body("<Error><Code>NoSuchKey</Code></Error>");
        })
        .await;
    let missing_bucket = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/missing-bucket.tar.zst");
            then.status(403)
                .body("<Error><Code>NoSuchBucket</Code></Error>");
        })
        .await;
    let malformed = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/malformed.tar.zst");
            then.status(400).body("<Error><Code>NoSuchKey");
        })
        .await;
    let c = client(&server);
    for key in ["bad-request", "forbidden"] {
        assert!(
            c.get(&format!("runner-templates/{key}.tar.zst"))
                .await
                .unwrap()
                .is_none()
        );
    }
    for key in ["missing-bucket", "malformed"] {
        assert!(
            c.get(&format!("runner-templates/{key}.tar.zst"))
                .await
                .is_err()
        );
    }
    bad_request.assert_calls_async(1).await;
    forbidden.assert_calls_async(1).await;
    missing_bucket.assert_calls_async(1).await;
    malformed.assert_calls_async(1).await;
}

#[test]
fn signed_upload_part_has_no_whole_request_deadline() {
    let c = R2HttpClient::with_test_endpoint(
        Url::parse("http://127.0.0.1:1").unwrap(),
        "test-bucket".into(),
    )
    .unwrap();
    let url = c
        .url(
            "runner-templates/hash.tar.zst",
            &[("partNumber", "1"), ("uploadId", "id")],
        )
        .unwrap();
    let request = c
        .signed_request(Method::PUT, url, Bytes::from_static(b"part"), None)
        .unwrap();
    // The pinned SDK sets a 300s read timeout, not a total operation timeout.
    assert!(request.timeout().is_none());
    assert!(request.headers().contains_key("x-amz-checksum-crc32"));
}

#[tokio::test]
async fn create_deserializes_all_modeled_fields_and_last_upload_id_wins() {
    let server = MockServer::start_async().await;
    let bad_bucket = server.mock_async(|when, then| {
        when.method("POST").path("/test-bucket/runner-templates/bad-bucket.tar.zst");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId><Bucket><nested/></Bucket></InitiateMultipartUploadResult>");
    }).await;
    let bad_key = server.mock_async(|when, then| {
        when.method("POST").path("/test-bucket/runner-templates/bad-key.tar.zst");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId><Key><nested/></Key></InitiateMultipartUploadResult>");
    }).await;
    let repeated = server.mock_async(|when, then| {
        when.method("POST").path("/test-bucket/runner-templates/repeated.tar.zst");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>first</UploadId><UploadId>second</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let mut c = client(&server);
    c.retry_quota = Arc::new(Semaphore::new(499));
    c.retry_quota_capacity = 500;
    let err = c
        .create_multipart("runner-templates/bad-bucket.tar.zst")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("invalid Bucket field"), "{err}");
    let err = c
        .create_multipart("runner-templates/bad-key.tar.zst")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("invalid Key field"), "{err}");
    assert_eq!(
        c.retry_quota.available_permits(),
        499,
        "deserialization failures cannot earn retry quota"
    );
    assert_eq!(
        c.create_multipart("runner-templates/repeated.tar.zst")
            .await
            .unwrap(),
        "second"
    );
    assert_eq!(c.retry_quota.available_permits(), 500);
    bad_bucket.assert_calls_async(1).await;
    bad_key.assert_calls_async(1).await;
    repeated.assert_calls_async(1).await;
}

#[tokio::test]
async fn malformed_error_message_is_not_a_get_miss_and_last_code_wins() {
    let server = MockServer::start_async().await;
    let malformed = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/malformed.tar.zst");
            then.status(404)
                .body("<Error><Code>NoSuchKey</Code><Message><nested/></Message></Error>");
        })
        .await;
    let repeated = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/repeated.tar.zst");
            then.status(404)
                .body("<Error><Code>SlowDown</Code><Code>NoSuchKey</Code></Error>");
        })
        .await;
    let c = client(&server);
    assert!(c.get("runner-templates/malformed.tar.zst").await.is_err());
    assert!(
        c.get("runner-templates/repeated.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    malformed.assert_calls_async(1).await;
    repeated.assert_calls_async(1).await;
}

#[tokio::test]
async fn unwrapped_error_metadata_retries_even_without_error_root_but_is_not_a_modeled_miss() {
    let (url, server) = scripted_server(vec![
        mock_reply(
            "404 Not Found",
            "<ErrorResponse><Code>SlowDown</Code></ErrorResponse>",
            "x-amz-retry-after: 0\r\n",
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/retry.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(server.await.unwrap().len(), 2);

    let mock_server = MockServer::start_async().await;
    let wrong_root = mock_server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/wrong-root.tar.zst");
            then.status(404)
                .body("<ErrorResponse><Code>NoSuchKey</Code></ErrorResponse>");
        })
        .await;
    let c = client(&mock_server);
    assert!(c.get("runner-templates/wrong-root.tar.zst").await.is_err());
    wrong_root.assert_calls_async(1).await;
}

/// Capture every byte of each small synthetic request before replying, so
/// PUT and Complete cannot accidentally pass by racing an early server close.
async fn six_operation_wire_server() -> (Url, tokio::task::JoinHandle<Vec<(String, String)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let replies = [
        mock_reply("404 Not Found", "", ""),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
        mock_reply(
            "200 OK",
            "<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>",
            "",
        ),
        mock_reply("200 OK", "", "ETag: tag\r\n"),
        mock_reply(
            "200 OK",
            "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>",
            "",
        ),
        mock_reply("204 No Content", "", ""),
    ];
    let handle = tokio::spawn(async move {
        let mut requests = Vec::new();
        for reply in replies {
            let (mut connection, _) =
                tokio::time::timeout(Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut received = Vec::new();
            let header_end = loop {
                let mut buf = [0u8; 4096];
                let n = connection.read(&mut buf).await.unwrap();
                assert!(n > 0);
                received.extend_from_slice(&buf[..n]);
                if let Some(i) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8(received[..header_end].to_vec()).unwrap();
            let len = headers
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|line| line.split_once(':'))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while received.len() - header_end < len {
                let mut buf = [0u8; 4096];
                let n = connection.read(&mut buf).await.unwrap();
                assert!(n > 0);
                received.extend_from_slice(&buf[..n]);
            }
            assert!(headers.to_ascii_lowercase().contains("authorization:"));
            let body = String::from_utf8(received[header_end..header_end + len].to_vec()).unwrap();
            requests.push((headers, body));
            connection.write_all(reply.as_bytes()).await.unwrap();
            connection.shutdown().await.unwrap();
        }
        requests
    });
    (url, handle)
}

#[tokio::test]
async fn all_six_operations_match_pinned_sdk_request_lines_and_content_types() {
    let (url, server) = six_operation_wire_server().await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let key = "runner-templates/x.tar.zst";
    assert!(!c.head(key).await.unwrap());
    assert!(c.get(key).await.unwrap().is_none());
    assert_eq!(c.create_multipart(key).await.unwrap(), "id");
    assert_eq!(
        c.upload_part(key, "id", 1, Bytes::from_static(b"abc"))
            .await
            .unwrap()
            .etag,
        "tag"
    );
    c.complete_multipart(
        key,
        "id",
        &[Part {
            number: 1,
            etag: "tag".into(),
        }],
    )
    .await
    .unwrap();
    c.abort_multipart(key, "id").await.unwrap();
    let requests = server.await.unwrap();
    let lines: Vec<_> = requests
        .iter()
        .map(|(headers, _)| headers.lines().next().unwrap())
        .collect();
    assert_eq!(
        lines,
        [
            "HEAD /test-bucket/runner-templates/x.tar.zst HTTP/1.1",
            "GET /test-bucket/runner-templates/x.tar.zst?x-id=GetObject HTTP/1.1",
            "POST /test-bucket/runner-templates/x.tar.zst?uploads HTTP/1.1",
            "PUT /test-bucket/runner-templates/x.tar.zst?x-id=UploadPart&partNumber=1&uploadId=id HTTP/1.1",
            "POST /test-bucket/runner-templates/x.tar.zst?uploadId=id HTTP/1.1",
            "DELETE /test-bucket/runner-templates/x.tar.zst?x-id=AbortMultipartUpload&uploadId=id HTTP/1.1",
        ]
    );
    for (i, (headers, _)) in requests.iter().enumerate() {
        let headers = headers.to_ascii_lowercase();
        match i {
            3 => assert!(headers.contains("\r\ncontent-type: application/octet-stream\r\n")),
            4 => assert!(headers.contains("\r\ncontent-type: application/xml\r\n")),
            _ => assert!(!headers.contains("\r\ncontent-type:")),
        }
    }
    for (headers, body) in [&requests[3], &requests[4]] {
        let headers = headers.to_ascii_lowercase();
        let authorization = headers
            .lines()
            .find(|line| line.starts_with("authorization:"))
            .unwrap();
        assert!(
            authorization.contains("signedheaders=content-length;content-type;host;"),
            "{authorization}"
        );
        assert!(headers.contains(&format!("\r\ncontent-length: {}\r\n", body.len())));
    }
    assert_eq!(requests[3].1, "abc");
    assert_eq!(
        requests[4].1,
        "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Part><ETag>tag</ETag><PartNumber>1</PartNumber></Part></CompleteMultipartUpload>"
    );
}

#[tokio::test]
async fn zero_length_part_signs_its_content_length_like_the_sdk() {
    let (url, server) = scripted_server(vec![mock_reply("200 OK", "", "ETag: tag\r\n")]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    c.upload_part("runner-templates/h.tar.zst", "id", 1, Bytes::new())
        .await
        .unwrap();
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 1);
    let headers = requests[0].to_ascii_lowercase();
    assert!(headers.contains("\r\ncontent-length: 0\r\n"));
    let authorization = headers
        .lines()
        .find(|line| line.starts_with("authorization:"))
        .unwrap();
    assert!(
        authorization.contains("signedheaders=content-length;content-type;host;"),
        "{authorization}"
    );
}

#[tokio::test]
async fn opaque_upload_id_uses_the_sdk_query_encoding_for_each_multipart_request() {
    // The SDK uses Smithy's percent encoding, not HTML form encoding. The
    // upload ID is an opaque response value; it need not be base64-only.
    let (url, server) = scripted_server(vec![
        mock_reply("200 OK", "", "ETag: tag\r\n"),
        mock_reply("200 OK", "<CompleteMultipartUploadResult/>", ""),
        mock_reply("204 No Content", "", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let key = "runner-templates/h.tar.zst";
    let id = "a+b/c== a~!*'()";
    let part = c
        .upload_part(key, id, 1, Bytes::from_static(b"part"))
        .await
        .unwrap();
    c.complete_multipart(key, id, &[part]).await.unwrap();
    c.abort_multipart(key, id).await.unwrap();
    let requests = server.await.unwrap();
    let suffix = "uploadId=a%2Bb%2Fc%3D%3D%20a~%21%2A%27%28%29 HTTP/1.1";
    assert_eq!(requests.len(), 3);
    for request in requests {
        assert!(
            request.lines().next().unwrap().ends_with(suffix),
            "{request}"
        );
    }
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
async fn clock_skew_uses_the_pinned_smithy_http_date_parser() {
    let later = chrono::Utc::now() + chrono::Duration::minutes(10);
    let prefix = later.format("%a, %d %b %Y %H:%M:%S").to_string();
    // Chrono's RFC 2822 parser would accept this numeric offset and retry;
    // the SDK's HttpDate parser does not trust it as an HTTP Date.
    let server = MockServer::start_async().await;
    let invalid = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/offset.tar.zst");
            then.status(403)
                .header("date", format!("{prefix} +0000"))
                .body("<Error><Code>RequestTimeTooSkewed</Code></Error>");
        })
        .await;
    let c = client(&server);
    assert!(c.get("runner-templates/offset.tar.zst").await.is_err());
    invalid.assert_calls_async(1).await;
    assert_eq!(c.clock_skew_ms.load(Ordering::Relaxed), 0);

    // Smithy accepts milliseconds before GMT even though Chrono's RFC 2822
    // parser rejected this response. The follow-up request must be re-signed.
    let (url, server) = scripted_server(vec![
        mock_reply(
            "403 Forbidden",
            "<Error><Code>RequestTimeTooSkewed</Code></Error>",
            &format!("Date: {prefix}.123 GMT\r\n"),
        ),
        mock_reply("404 Not Found", "<Error><Code>NoSuchKey</Code></Error>", ""),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert!(
        c.get("runner-templates/millisecond.tar.zst")
            .await
            .unwrap()
            .is_none()
    );
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        (570..=630)
            .contains(&(signed_date(&requests[1]) - signed_date(&requests[0])).num_seconds())
    );
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
async fn nonstreaming_200_embedded_errors_retry_across_sdk_operations() {
    let failed = || {
        mock_reply(
            "200 OK",
            "<Error><Code>InternalError</Code></Error>",
            "x-amz-retry-after: 0\r\nETag: \"bad\"\r\n",
        )
    };
    let (url, requests) = scripted_server(vec![
        failed(),
        mock_reply("200 OK", "<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>", ""),
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert_eq!(
        c.create_multipart("runner-templates/h.tar.zst")
            .await
            .unwrap(),
        "id"
    );
    assert_eq!(requests.await.unwrap().len(), 2);

    let (url, requests) = scripted_server(vec![
        failed(),
        mock_reply("200 OK", "", "ETag: \"good\"\r\n"),
    ])
    .await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert_eq!(
        c.upload_part(
            "runner-templates/h.tar.zst",
            "id",
            1,
            Bytes::from_static(b"part")
        )
        .await
        .unwrap()
        .etag,
        "\"good\""
    );
    assert_eq!(requests.await.unwrap().len(), 2);

    let (url, requests) =
        scripted_server(vec![failed(), mock_reply("204 No Content", "", "")]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    c.abort_multipart("runner-templates/h.tar.zst", "id")
        .await
        .unwrap();
    assert_eq!(requests.await.unwrap().len(), 2);

    let server = MockServer::start_async().await;
    let invalid_part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(200)
                .header("etag", "\"bad\"")
                .body("<Error><Code>InvalidPart</Code></Error>");
        })
        .await;
    let c = client(&server);
    let error = c
        .upload_part(
            "runner-templates/h.tar.zst",
            "id",
            1,
            Bytes::from_static(b"part"),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("InvalidPart"), "{error}");
    invalid_part.assert_calls_async(1).await;

    let server = MockServer::start_async().await;
    let no_code = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(200).body("<Error/>");
        })
        .await;
    let c = client(&server);
    assert!(
        c.abort_multipart("runner-templates/h.tar.zst", "id")
            .await
            .is_err()
    );
    no_code.assert_calls_async(1).await;
}

#[tokio::test]
async fn cdata_error_code_cannot_authorize_retry_or_a_get_miss() {
    // Smithy's try_data skips CDATA when reading Code. The tree parser merges
    // it into text, which must not manufacture InternalError or NoSuchKey.
    let server = MockServer::start_async().await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(200)
                .header("etag", "tag")
                .body("<Error><Code><![CDATA[InternalError]]></Code></Error>");
        })
        .await;
    let spaced_end_tag = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path("/test-bucket/runner-templates/space.tar.zst");
            then.status(200)
                .header("etag", "tag")
                .body("<Error><Code><![CDATA[InternalError]]></Code ></Error>");
        })
        .await;
    let get = server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/h.tar.zst");
            then.status(400)
                .body("<Error><Code><![CDATA[NoSuchKey]]></Code></Error>");
        })
        .await;
    let c = client(&server);
    assert!(
        c.upload_part("runner-templates/h.tar.zst", "id", 1, Bytes::new())
            .await
            .is_err()
    );
    assert!(
        c.upload_part("runner-templates/space.tar.zst", "id", 1, Bytes::new())
            .await
            .is_err()
    );
    assert!(c.get("runner-templates/h.tar.zst").await.is_err());
    part.assert_calls_async(1).await;
    spaced_end_tag.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
}

#[tokio::test]
async fn create_upload_id_uses_only_ordinary_xml_text() {
    // The pinned Smithy scalar reader skips CDATA tokens. Never initiate a
    // multipart upload with an ID that it could not obtain from the response.
    for (content, expected) in [
        ("<![CDATA[id]]>", None),
        ("id<![CDATA[ignored]]>", Some("id")),
        ("<![CDATA[ignored]]>id", Some("id")),
    ] {
        let server = MockServer::start_async().await;
        let response = server
            .mock_async(|when, then| {
                when.method("POST").path("/test-bucket/runner-templates/h.tar.zst");
                then.status(200).body(format!(
                    "<InitiateMultipartUploadResult><UploadId>{content}</UploadId></InitiateMultipartUploadResult>"
                ));
            })
            .await;
        let actual = client(&server)
            .create_multipart("runner-templates/h.tar.zst")
            .await;
        match expected {
            Some(id) => assert_eq!(actual.unwrap(), id),
            None => assert!(actual.is_err(), "{content}"),
        }
        response.assert_calls_async(1).await;
    }
}

#[tokio::test]
async fn fake_code_in_comment_or_unknown_child_cannot_retry_writes() {
    // Only the root's direct Code field is modeled by Smithy. A raw XML
    // search used to pick up the CDATA in either fake nested tag and then
    // replay Create, UploadPart, Complete and Abort after InvalidPart.
    for body in [
        "<Error><Code>InvalidPart</Code><!-- <Code>InternalError<![CDATA[ignored]]></Code> --></Error>",
        "<Error><Code>InvalidPart</Code><Unknown><Code>InternalError<![CDATA[ignored]]></Code></Unknown></Error>",
    ] {
        for operation in ["create", "part", "complete", "abort"] {
            let server = MockServer::start_async().await;
            let response = server
                .mock_async(|when, then| {
                    when.path("/test-bucket/runner-templates/h.tar.zst");
                    then.status(200).header("etag", "tag").body(body);
                })
                .await;
            let c = client(&server);
            let key = "runner-templates/h.tar.zst";
            let result = match operation {
                "create" => c.create_multipart(key).await.map(|_| ()),
                "part" => c
                    .upload_part(key, "id", 1, Bytes::from_static(b"part"))
                    .await
                    .map(|_| ()),
                "complete" => c.complete_multipart(key, "id", &[]).await,
                _ => c.abort_multipart(key, "id").await,
            };
            assert!(result.is_err(), "{operation}: {body}");
            response.assert_calls_async(1).await;
        }
    }
}

#[tokio::test]
async fn cdata_message_does_not_hide_a_plain_retryable_code() {
    // Smithy reads the first ordinary text token, skipping CDATA before it
    // and ignoring CDATA after it. All three responses have InternalError.
    for body in [
        "<Error><Code>InternalError</Code><Message><![CDATA[retry]]></Message></Error>",
        "<Error><Code>InternalError<![CDATA[ignored]]></Code></Error>",
        "<Error><Code><![CDATA[ignored]]>InternalError</Code></Error>",
        "<Error><Code><![CDATA[</Code>]]>InternalError</Code></Error>",
    ] {
        let (url, server) = scripted_server(vec![
            mock_reply("200 OK", body, "x-amz-retry-after: 0\r\n"),
            mock_reply("200 OK", "", "ETag: tag\r\n"),
        ])
        .await;
        let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
        c.upload_part(
            "runner-templates/h.tar.zst",
            "id",
            1,
            Bytes::from_static(b"part"),
        )
        .await
        .unwrap();
        assert_eq!(server.await.unwrap().len(), 2, "{body}");
    }
}

#[tokio::test]
async fn malformed_embedded_error_retries_all_four_nonstreaming_operations() {
    // Smithy's Error-root probe succeeds before its full XML decoder fails;
    // that response error is transient, unlike an unrelated malformed body.
    #[derive(Debug, Clone, Copy)]
    enum Operation {
        Create,
        Part,
        Complete,
        Abort,
    }
    for operation in [
        Operation::Create,
        Operation::Part,
        Operation::Complete,
        Operation::Abort,
    ] {
        let successful = match operation {
            Operation::Create => mock_reply(
                "200 OK",
                "<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>",
                "",
            ),
            Operation::Part => mock_reply("200 OK", "", "ETag: tag\r\n"),
            Operation::Complete => mock_reply("200 OK", "<CompleteMultipartUploadResult/>", ""),
            Operation::Abort => mock_reply("200 OK", "", ""),
        };
        let (url, server) = scripted_server(vec![
            mock_reply(
                "200 OK",
                "<Error><Code>InternalError",
                "x-amz-retry-after: 0\r\n",
            ),
            successful,
        ])
        .await;
        let c =
            R2HttpClient::with_test_endpoint_retry_quota(url, "test-bucket".into(), 10).unwrap();
        let key = "runner-templates/h.tar.zst";
        match operation {
            Operation::Create => assert_eq!(c.create_multipart(key).await.unwrap(), "id"),
            Operation::Part => {
                assert_eq!(
                    c.upload_part(key, "id", 1, Bytes::from_static(b"part"))
                        .await
                        .unwrap()
                        .etag,
                    "tag"
                );
            }
            Operation::Complete => c.complete_multipart(key, "id", &[]).await.unwrap(),
            Operation::Abort => c.abort_multipart(key, "id").await.unwrap(),
        }
        assert_eq!(server.await.unwrap().len(), 2, "{operation:?}");
    }
}

#[tokio::test]
async fn malformed_http_header_is_not_a_retryable_request_error() {
    // The pinned SDK does not replay an operation after a syntactically bad
    // HTTP header. reqwest calls this a request error, just like a premature
    // connection close, so keep the listener alive to detect an extra send.
    for operation in ["head", "complete"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let header_end = loop {
                let mut chunk = [0u8; 4096];
                let n = connection.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                received.extend_from_slice(&chunk[..n]);
                if let Some(i) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&received[..header_end]);
            let length = headers
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|line| line.split_once(':'))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while received.len() - header_end < length {
                let mut chunk = [0u8; 4096];
                let n = connection.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                received.extend_from_slice(&chunk[..n]);
            }
            connection
                .write_all(b"HTTP/1.1 200 OK\r\nBad Header\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            connection.shutdown().await.unwrap();
            match tokio::time::timeout(Duration::from_millis(1500), listener.accept()).await {
                Ok(Ok((mut retry, _))) => {
                    retry
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await
                        .unwrap();
                    2
                }
                _ => 1,
            }
        });
        let c =
            R2HttpClient::with_test_endpoint_retry_quota(url, "test-bucket".into(), 500).unwrap();
        if operation == "head" {
            assert!(c.head("runner-templates/h.tar.zst").await.is_err());
        } else {
            assert!(
                c.complete_multipart("runner-templates/h.tar.zst", "id", &[])
                    .await
                    .is_err()
            );
        }
        assert_eq!(server.await.unwrap(), 1, "{operation}");
    }
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
async fn upload_part_200_body_read_failure_retries_within_attempt_budget() {
    let (url, requests) = scripted_server(vec![
        "HTTP/1.1 200 OK\r\nETag: \"misleading\"\r\nContent-Length: 100\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nETag: \"real\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    assert_eq!(
        c.upload_part(
            "runner-templates/h.tar.zst",
            "id",
            1,
            Bytes::from_static(b"part")
        )
        .await
        .unwrap()
        .etag,
        "\"real\""
    );
    assert_eq!(requests.await.unwrap().len(), 2);
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

#[tokio::test]
async fn abort_rejects_malformed_error_root_but_not_unrelated_raw_body() {
    // The pinned SDK recognizes the Error start tag before trying to parse
    // the full body. A truncated error must not turn Abort into success.
    let server = MockServer::start_async().await;
    let malformed = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "malformed");
            then.status(200)
                .body("<?xml version=\"1.0\"?><Error><Code>InvalidPart");
        })
        .await;
    let unrelated = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "other");
            then.status(200).body("<Other><broken");
        })
        .await;
    let c = R2HttpClient::with_test_endpoint_retry_quota(
        Url::parse(&server.base_url()).unwrap(),
        "test-bucket".into(),
        0,
    )
    .unwrap();
    let error = c
        .abort_multipart("runner-templates/h.tar.zst", "malformed")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("embedded error"), "{error}");
    c.abort_multipart("runner-templates/h.tar.zst", "other")
        .await
        .unwrap();
    malformed.assert_calls_async(1).await;
    unrelated.assert_calls_async(1).await;
}

#[tokio::test]
async fn get_204_with_advertised_bytes_fails_as_a_request() {
    // A contradictory 204/Content-Length makes the SDK's GET body fail on
    // read. reqwest discards that body, so reject it before archive parsing.
    let (url, server) = scripted_server(vec![mock_reply("204 No Content", "hello", "")]).await;
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let error = match c.get("runner-templates/h.tar.zst").await {
        Ok(_) => panic!("204 with a nonzero body length must fail"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("204 advertised"), "{error}");
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn complete_rejects_unparseable_modeled_scalar_fields() {
    // On the pinned SDK, the first response fails deserialization rather than
    // returning success. Mixed text/nested markup is accepted by its parser.
    let server = MockServer::start_async().await;
    let invalid = server
        .mock_async(|when, then| {
            when.method("POST")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "invalid");
            then.status(200).body("<CompleteMultipartUploadResult><ETag><nested/></ETag></CompleteMultipartUploadResult>");
        })
        .await;
    let mixed = server
        .mock_async(|when, then| {
            when.method("POST")
                .path("/test-bucket/runner-templates/h.tar.zst")
                .query_param("uploadId", "mixed");
            then.status(200).body("<CompleteMultipartUploadResult><ETag>okay<nested/></ETag></CompleteMultipartUploadResult>");
        })
        .await;
    let c = client(&server);
    assert!(
        c.complete_multipart("runner-templates/h.tar.zst", "invalid", &[])
            .await
            .is_err()
    );
    c.complete_multipart("runner-templates/h.tar.zst", "mixed", &[])
        .await
        .unwrap();
    invalid.assert_calls_async(1).await;
    mixed.assert_calls_async(1).await;
}

#[tokio::test]
async fn get_stalled_body_fails_before_request_read_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        loop {
            let mut block = [0u8; 2048];
            let n = socket.read(&mut block).await.unwrap();
            assert!(n > 0);
            headers.extend_from_slice(&block[..n]);
            if headers.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\na")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(15)).await;
    });
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let mut download = c.get("runner-templates/h.tar.zst").await.unwrap().unwrap();
    let mut first = [0u8; 1];
    download.body.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"a");
    let error = tokio::time::timeout(
        Duration::from_secs(12),
        download.body.read_exact(&mut first),
    )
    .await
    .expect("stalled GET did not fail within the SDK window")
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    server.abort();
}

#[tokio::test]
async fn get_wait_for_first_response_keeps_original_budget() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        loop {
            let mut block = [0u8; 2048];
            let n = socket.read(&mut block).await.unwrap();
            assert!(n > 0);
            headers.extend_from_slice(&block[..n]);
            if headers.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(7)).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: close\r\n\r\na")
            .await
            .unwrap();
    });
    let c = R2HttpClient::with_test_endpoint(url, "test-bucket".into()).unwrap();
    let mut download = c.get("runner-templates/h.tar.zst").await.unwrap().unwrap();
    let mut bytes = Vec::new();
    download.body.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"a");
    server.await.unwrap();
}
