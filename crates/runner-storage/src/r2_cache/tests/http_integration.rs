use std::time::Duration;

use super::{
    super::{R2DownloadError, R2ImageCache, http_transport::R2HttpClient},
    fixtures::{regular_template_archive, small_src_file},
};
use httpmock::MockServer;

fn cache(server: &MockServer) -> R2ImageCache {
    R2ImageCache::with_http_client(
        R2HttpClient::with_test_endpoint(server.base_url().parse().unwrap(), "test-bucket".into())
            .unwrap(),
        "test-bucket".into(),
    )
}

#[tokio::test]
async fn http_cache_streams_archive_and_uploads_through_existing_lifecycle() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/abc.tar.zst";
    let head = server
        .mock_async(|when, then| {
            when.method("HEAD").path(key);
            then.status(404);
        })
        .await;
    let create = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT")
                .path(key)
                .query_param("uploadId", "id")
                .query_param("partNumber", "1");
            then.status(200).header("etag", "\"part\"");
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST")
                .path(key)
                .query_param("uploadId", "id")
                .body_includes("<PartNumber>1</PartNumber>")
                .body_includes("<ETag>&quot;part&quot;</ETag>");
            then.status(200).body(
                "<CompleteMultipartUploadResult><ETag>whole</ETag></CompleteMultipartUploadResult>",
            );
        })
        .await;
    let archive = regular_template_archive(&vec![17; 1024]);
    let get = server
        .mock_async(move |when, then| {
            when.method("GET").path(key);
            then.status(200).body(archive);
        })
        .await;

    let cache = cache(&server);
    let (_dir, src) = small_src_file().await;
    cache.upload_template("abc", &src, false).await.unwrap();
    let dest_dir = tempfile::tempdir().unwrap();
    let dest = dest_dir.path().join("template.ext4");
    assert!(
        cache
            .try_download_template_to_file("abc", &dest, 1024)
            .await
            .unwrap()
    );
    assert_eq!(tokio::fs::read(dest).await.unwrap(), vec![17; 1024]);
    head.assert_calls_async(1).await;
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
    get.assert_calls_async(1).await;
}

#[tokio::test]
async fn complete_embedded_error_aborts_via_cache_guard() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/abc.tar.zst";
    let create = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT").path(key).query_param("uploadId", "id");
            then.status(200).header("etag", "\"part\"");
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST").path(key).query_param("uploadId", "id");
            then.status(200)
                .body("<Error><Code>InvalidPart</Code></Error>");
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path(key)
                .query_param("uploadId", "id");
            then.status(204);
        })
        .await;
    let (_dir, src) = small_src_file().await;
    let err = cache(&server)
        .upload_template("abc", &src, true)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("InvalidPart"), "{err}");
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(1).await;
    abort.assert_calls_async(1).await;
}

#[tokio::test]
async fn part_200_embedded_error_aborts_even_with_etag() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/abc.tar.zst";
    let create = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT").path(key).query_param("uploadId", "id");
            then.status(200)
                .header("etag", "\"misleading\"")
                .body("<Error><Code>InvalidPart</Code></Error>");
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST").path(key).query_param("uploadId", "id");
            then.status(200).body("<CompleteMultipartUploadResult/>");
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path(key)
                .query_param("uploadId", "id");
            then.status(204);
        })
        .await;
    let (_dir, src) = small_src_file().await;
    let error = cache(&server)
        .upload_template("abc", &src, true)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("InvalidPart"), "{error}");
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(0).await;
    abort.assert_calls_async(1).await;
}

#[tokio::test]
async fn duplicate_part_etag_aborts_before_complete() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/abc.tar.zst";
    let create = server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT").path(key).query_param("uploadId", "id");
            then.status(200)
                .header("etag", "\"one\"")
                .header("etag", "\"two\"");
        })
        .await;
    let complete = server
        .mock_async(|when, then| {
            when.method("POST").path(key).query_param("uploadId", "id");
            then.status(200).body("<CompleteMultipartUploadResult/>");
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path(key)
                .query_param("uploadId", "id");
            then.status(204);
        })
        .await;
    let (_dir, src) = small_src_file().await;
    let error = cache(&server)
        .upload_template("abc", &src, true)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("invalid R2 etag response header"),
        "{error}"
    );
    create.assert_calls_async(1).await;
    part.assert_calls_async(1).await;
    complete.assert_calls_async(0).await;
    abort.assert_calls_async(1).await;
}

#[tokio::test]
async fn cancelling_live_http_part_schedules_detached_abort() {
    let server = MockServer::start_async().await;
    let key = "/test-bucket/runner-templates/abc.tar.zst";
    server.mock_async(|when, then| {
        when.method("POST").path(key).query_param_exists("uploads");
        then.status(200).body("<InitiateMultipartUploadResult><UploadId>id</UploadId></InitiateMultipartUploadResult>");
    }).await;
    let part = server
        .mock_async(|when, then| {
            when.method("PUT").path(key).query_param("uploadId", "id");
            then.status(200)
                .header("etag", "\"part\"")
                .delay(Duration::from_secs(4));
        })
        .await;
    let abort = server
        .mock_async(|when, then| {
            when.method("DELETE")
                .path(key)
                .query_param("uploadId", "id");
            then.status(204);
        })
        .await;
    let (_dir, src) = small_src_file().await;
    let cache = cache(&server);
    let task = tokio::spawn(async move { cache.upload_template("abc", &src, true).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while part.calls_async().await == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("part request did not start");
    task.abort();
    let _ = task.await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while abort.calls_async().await == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("detached abort was not requested");
    abort.assert_calls_async(1).await;
}

#[tokio::test]
async fn truncated_http_body_preserves_request_failure_classification_and_staging_cleanup() {
    // An invalid archive is an object error, not a network error; it must
    // never publish the destination or leave a staging directory behind.
    let server = MockServer::start_async().await;
    server
        .mock_async(|when, then| {
            when.method("GET")
                .path("/test-bucket/runner-templates/bad.tar.zst");
            then.status(200).body("not a zstd tar archive");
        })
        .await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("template.ext4");
    let error = cache(&server)
        .try_download_template_to_file("bad", &dest, 1024)
        .await
        .unwrap_err();
    assert!(
        matches!(error, R2DownloadError::InvalidObject(_)),
        "{error:?}"
    );
    assert!(!dest.exists());
    assert!(!dir.path().join("template.ext4.download.tmp").exists());
}

#[tokio::test]
async fn interrupted_http_body_is_request_error_and_never_publishes_file() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let archive = regular_template_archive(&vec![17; 1024]);
    let response = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut chunk = [0u8; 1024];
        while !received.windows(4).any(|s| s == b"\r\n\r\n") {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            received.extend_from_slice(&chunk[..n]);
            assert!(received.len() < 16 * 1024);
        }
        assert!(received.starts_with(b"GET /test-bucket/runner-templates/broken.tar.zst"));
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            archive.len() + 1
        );
        socket.write_all(headers.as_bytes()).await.unwrap();
        socket.write_all(&archive).await.unwrap();
        socket.shutdown().await.unwrap();
    });
    let http =
        R2HttpClient::with_test_endpoint(endpoint.parse().unwrap(), "test-bucket".into()).unwrap();
    let cache = R2ImageCache::with_http_client(http, "test-bucket".into());
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("template.ext4");
    let error = tokio::time::timeout(
        Duration::from_secs(3),
        cache.try_download_template_to_file("broken", &dest, 1024),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(matches!(error, R2DownloadError::Request(_)), "{error:?}");
    assert!(!dest.exists());
    assert!(!dir.path().join("template.ext4.download.tmp").exists());
    response.await.unwrap();
}
