use super::*;
use httpmock::MockServer;
use tokio::io::AsyncReadExt;

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
