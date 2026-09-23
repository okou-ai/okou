use std::time::Duration;

use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, retry::RetryConfig, timeout::TimeoutConfig,
};
use httpmock::MockServer;

use super::super::R2ImageCache;
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

    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("auto"))
        .endpoint_url(server.base_url())
        .force_path_style(true)
        .credentials_provider(Credentials::new("test", "test", None, None, "test"))
        .retry_config(RetryConfig::standard().with_max_attempts(1))
        .timeout_config(
            TimeoutConfig::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(1))
                .build(),
        )
        .build();
    let cache = R2ImageCache::with_client(
        aws_sdk_s3::Client::from_conf(config),
        "test-bucket".to_string(),
    );
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
