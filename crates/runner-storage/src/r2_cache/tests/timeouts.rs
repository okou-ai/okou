use std::time::Duration;

use httpmock::MockServer;

use super::super::{R2ImageCache, http_transport::R2HttpClient};
use super::fixtures::small_src_file;

#[tokio::test]
async fn upload_parts_allow_slow_responses_without_relaxing_control_requests() {
    let server = MockServer::start_async().await;
    let key_path = "/test-bucket/runner-templates/hash.tar.zst";
    let create = server
        .mock_async(|when, then| {
            when.method("POST")
                .path(key_path)
                .query_param_exists("uploads");
            then.status(200).body(
                "<InitiateMultipartUploadResult><UploadId>upload-id</UploadId></InitiateMultipartUploadResult>",
            );
        })
        .await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path(key_path)
                .query_param("uploadId", "upload-id")
                .query_param("partNumber", "1");
            // Exercise the real HTTP timeout with a tiny file, not a large
            // bandwidth-throttled fixture. This exceeds the control budget.
            then.status(200)
                .header("etag", "\"part-etag\"")
                .delay(Duration::from_secs(2));
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST")
                .path(key_path)
                .query_param("uploadId", "upload-id")
                .body_includes("<PartNumber>1</PartNumber>")
                .body_includes("part-etag");
            then.status(200).body(
                "<CompleteMultipartUploadResult><ETag>\"object-etag\"</ETag></CompleteMultipartUploadResult>",
            );
        })
        .await;
    let head = server
        .mock_async(|when, then| {
            when.method("HEAD").path(key_path);
            then.status(200).delay(Duration::from_secs(2));
        })
        .await;

    let client = R2HttpClient::with_test_endpoint_timeouts(
        server.base_url().parse().unwrap(),
        "test-bucket".to_string(),
        Duration::from_secs(1),
        Duration::from_secs(3),
    )
    .unwrap();
    let cache = R2ImageCache::with_http_client(client, "test-bucket".to_string());
    let (_source_dir, source) = small_src_file().await;

    tokio::time::timeout(
        Duration::from_secs(10),
        cache.upload_template("hash", &source, true),
    )
    .await
    .expect("upload should complete after the delayed part response")
    .expect("parts must not inherit the shorter control timeout");
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;

    // The same client must still reject a control response over its budget.
    let error = cache.template_exists("hash").await.unwrap_err();
    assert!(
        error.to_string().to_ascii_lowercase().contains("timeout"),
        "{error}"
    );
    head.assert_calls_async(1).await;
}
