use crate::support::*;
use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use bytes::Bytes;
use httpmock::prelude::*;

// =========================================================================
// put_presigned
// =========================================================================

#[tokio::test]
async fn put_presigned_success() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-success")
            .header("Content-Type", "application/octet-stream");
        then.status(200);
    });

    let url = api.url("/test/put-success");
    let data = Bytes::from_static(b"test data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn transport_only_client_can_send_presigned_upload_without_api_config()
-> Result<(), Box<dyn std::error::Error>> {
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-transport-only");
        then.respond_with(|req| upload_validation_response(req, b"transport-only upload", "21"));
    });

    let url = format!("{}/test/put-transport-only", server.base_url());
    let http = guest_agent::http::HttpClient::new()?;
    http.put_presigned(
        &url,
        Bytes::from_static(b"transport-only upload"),
        "application/octet-stream",
    )
    .await?;

    mock.assert_calls_async(1).await;
    mock.delete_async().await;
    Ok(())
}

#[tokio::test]
async fn put_presigned_does_not_send_api_headers() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-no-api-headers");
        then.respond_with(|req| {
            if request_header_absent(req, "authorization")
                && request_header_absent(req, "x-vercel-protection-bypass")
                && request_header_absent(req, CLIENT_VERSION_HEADER)
                && request_header_absent(req, CLIENT_TYPE_HEADER)
                && request_header_absent(req, CLIENT_SESSION_ID_HEADER)
                && request_header_absent(req, CLIENT_REQUEST_ID_HEADER)
            {
                http_status(200)
            } else {
                http_status(400)
            }
        });
    });

    let url = api.url("/test/put-no-api-headers");
    let data = Bytes::from_static(b"test data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

// =========================================================================
// put_presigned 4xx handling
// =========================================================================

#[tokio::test]
async fn put_presigned_reports_http_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-403");
        then.status(403);
    });

    let url = api.url("/test/put-403");
    let data = Bytes::from_static(b"forbidden data");
    let result = http_client!()
        .put_presigned(&url, data, "application/octet-stream")
        .await;

    // Should fail immediately — only 1 call, no retries.
    mock.assert_calls_async(1).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn put_presigned_connect_error_does_not_log_presigned_url() {
    let _api = SharedApiMock::new().await;

    let tmp = tempfile::tempdir().unwrap();
    let system_log_path = tmp.path().join("system.log");
    std::fs::write(&system_log_path, "").unwrap();
    let _system_log_guard = SystemLogOverrideGuard::set(&system_log_path);

    let signature = "super-secret-signature";
    let url =
        format!("http://127.0.0.1:0/upload?X-Amz-Signature={signature}&X-Amz-Credential=test");
    let result = http_client!()
        .put_presigned(
            &url,
            Bytes::from_static(b"secret upload"),
            "application/octet-stream",
        )
        .await;

    let error = result.unwrap_err().to_string();
    assert!(error.starts_with("http: PUT presigned:"));
    let system_log = std::fs::read_to_string(&system_log_path).unwrap();
    assert!(
        !system_log.contains(&url),
        "system log leaked full presigned URL: {system_log}"
    );
    assert!(
        !system_log.contains("X-Amz-Signature"),
        "system log leaked presigned query key: {system_log}"
    );
    assert!(
        !system_log.contains(signature),
        "system log leaked presigned signature: {system_log}"
    );
    assert!(
        !error.contains(&url),
        "returned error leaked full presigned URL: {error}"
    );
    assert!(
        !error.contains("X-Amz-Signature"),
        "returned error leaked presigned query key: {error}"
    );
    assert!(
        !error.contains(signature),
        "returned error leaked presigned signature: {error}"
    );
}

// =========================================================================
// put_presigned_file (streaming upload)
// =========================================================================

#[tokio::test]
async fn put_presigned_file_success() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("test.bin");
    std::fs::write(&file_path, b"streaming test data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-success")
            .header("Content-Type", "application/gzip")
            .body("streaming test data");
        then.status(200);
    });

    let url = api.url("/test/put-file-success");
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn put_presigned_file_sets_content_length() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("sized.bin");
    let data = vec![0xABu8; 1024];
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-content-length")
            .header("Content-Length", "1024");
        then.status(200);
    });

    let url = api.url("/test/put-file-content-length");
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn put_presigned_file_large_multi_chunk() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("large.bin");
    // 600000 bytes — spans multiple 256 KiB streaming chunks.
    let data: Vec<u8> = (0..600000).map(|i| (i % 251) as u8).collect();
    std::fs::write(&file_path, &data).unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT)
            .path("/test/put-file-large")
            .header("Content-Length", "600000");
        then.respond_with(move |req| upload_validation_response(req, &data, "600000"));
    });

    let url = api.url("/test/put-file-large");
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn put_presigned_file_reports_http_error() {
    let api = SharedApiMock::new().await;
    let server = api.server();

    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("forbidden.bin");
    std::fs::write(&file_path, b"forbidden data").unwrap();

    let mock = server.mock(|when, then| {
        when.method(PUT).path("/test/put-file-403");
        then.status(403);
    });

    let url = api.url("/test/put-file-403");
    let result = http_client!()
        .put_presigned_file(&url, &file_path, "application/gzip")
        .await;

    mock.assert_calls_async(1).await;
    assert!(result.is_err());
}

// =========================================================================
// Edge cases
// =========================================================================
