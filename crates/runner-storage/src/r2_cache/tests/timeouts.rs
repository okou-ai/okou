use std::time::Duration;

use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, retry::RetryConfig, timeout::TimeoutConfig,
};
use raw_http_test_support::{
    clock::advance_timer_phase,
    raw_http::{http_response, join_raw_http_task},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use tokio_util::task::AbortOnDropHandle;

use super::super::R2ImageCache;
use super::fixtures::small_src_file;

async fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
    let mut reader = BufReader::new(socket);
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 64 * 1024, "S3 fixture headers exceed limit");
        bytes.push(reader.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(bytes).unwrap();
    let mut length = None;
    for (name, value) in headers.lines().filter_map(|line| line.split_once(':')) {
        assert!(
            !name.eq_ignore_ascii_case("transfer-encoding"),
            "S3 fixture requires fixed-length request framing"
        );
        if name.eq_ignore_ascii_case("content-length") {
            assert!(
                length
                    .replace(value.trim().parse::<usize>().unwrap())
                    .is_none()
            );
        }
    }
    let length = length.unwrap_or(0);
    assert!(length <= 64 * 1024);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.unwrap();
    (headers, body)
}

fn request_url(headers: &str, method: &str) -> url::Url {
    let mut words = headers.lines().next().unwrap().split_whitespace();
    assert_eq!(words.next(), Some(method));
    let url = url::Url::parse(&format!("http://fixture{}", words.next().unwrap())).unwrap();
    assert_eq!(url.path(), "/test-bucket/runner-templates/hash.tar.zst");
    url
}

#[tokio::test]
async fn upload_parts_allow_slow_responses_without_relaxing_control_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (part_entered, part_ready) = oneshot::channel();
    let server = AbortOnDropHandle::new(tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, _) = read_request(&mut socket).await;
        let create = request_url(&headers, "POST");
        assert!(create.query_pairs().any(|(name, _)| name == "uploads"));
        socket.write_all(&http_response("200 OK", b"<InitiateMultipartUploadResult><UploadId>upload-id</UploadId></InitiateMultipartUploadResult>")).await.unwrap();
        drop(socket);

        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, body) = read_request(&mut socket).await;
        assert!(
            !body.is_empty(),
            "complete archive body must precede the timer gate"
        );
        let part = request_url(&headers, "PUT");
        assert!(
            part.query_pairs()
                .any(|(name, value)| name == "uploadId" && value == "upload-id")
        );
        assert!(
            part.query_pairs()
                .any(|(name, value)| name == "partNumber" && value == "1")
        );
        // Let the timer driver release the response, rather than making it
        // immediately ready before an expired SDK timeout can be polled.
        let response_delay = tokio::time::sleep(Duration::from_secs(2));
        tokio::pin!(response_delay);
        assert!(futures_util::poll!(&mut response_delay).is_pending());
        part_entered.send(()).unwrap();
        response_delay.await;
        socket.write_all(b"HTTP/1.1 200 OK\r\nETag: \"part-etag\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        drop(socket);

        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, body) = read_request(&mut socket).await;
        let complete = request_url(&headers, "POST");
        assert!(
            complete
                .query_pairs()
                .any(|(name, value)| name == "uploadId" && value == "upload-id")
        );
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains("<PartNumber>1</PartNumber>"));
        assert!(body.contains("part-etag"));
        socket.write_all(&http_response("200 OK", b"<CompleteMultipartUploadResult><ETag>\"object-etag\"</ETag></CompleteMultipartUploadResult>")).await.unwrap();
        drop(socket);

        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, _) = read_request(&mut socket).await;
        request_url(&headers, "HEAD");
        // Keep the original real two-second control response. A correctly
        // scoped one-second client timeout closes the socket first.
        let mut byte = [0];
        tokio::select! {
            result = socket.read(&mut byte) => match result {
                Ok(0) => {},
                Err(error) if matches!(error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ) => {},
                result => panic!("unexpected bytes or error after HEAD: {result:?}"),
            },
            () = tokio::time::sleep(Duration::from_secs(2)) => {
                socket.write_all(&http_response("200 OK", b"")).await.unwrap();
            }
        }
    }));

    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new("auto"))
        .endpoint_url(endpoint)
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

    let upload = tokio::time::timeout(
        Duration::from_secs(10),
        cache.upload_template("hash", &source, true),
    );
    tokio::pin!(upload);
    tokio::select! {
        result = &mut upload => panic!("upload finished before the complete part request: {result:?}"),
        ready = part_ready => ready.unwrap(),
    }
    // The complete body arrived over real TCP and the peer delay is Pending.
    // Advance only this response phase; the timer driver wakes the peer and SDK
    // deadlines after the helper resumes, before any more transport runs.
    advance_timer_phase(Duration::from_secs(2)).await;
    upload
        .await
        .expect("upload should complete after the delayed part response")
        .expect("parts must not inherit the shorter control timeout");

    // The same client must still reject a control response over its budget.
    let error = cache.template_exists("hash").await.unwrap_err();
    assert!(
        error.to_string().to_ascii_lowercase().contains("timeout"),
        "{error}"
    );
    join_raw_http_task(server.detach(), "S3 timeout peer").await;
}
