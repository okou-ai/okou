use super::*;
use rustls::pki_types::PrivatePkcs8KeyDer;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn cold_retry_concurrent_hash_reuse_and_corrupt_local_repair() {
    let temp = tempfile::tempdir().unwrap();
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )
    .unwrap();
    let tls = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "https://localhost:{}/package?signature=private",
        listener.local_addr().unwrap().port()
    );
    let http = reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_der(cert.cert.der()).unwrap())
        .build()
        .unwrap();
    let cache = ContentBundleCache {
        root: temp.path().join("cache"),
        http,
        downloads: Arc::new(Semaphore::new(4)),
    };
    let body = b"immutable bytes".to_vec();
    let reference = BundleReference {
        sha256: hex::encode(Sha256::digest(&body)),
        archive_bytes: body.len() as u64,
        download_url: url.clone(),
    };
    let cancel = CancellationToken::new();
    let (requests, mut received) = tokio::sync::mpsc::unbounded_channel();
    let server_body = body.clone();
    let server = tokio::spawn(async move {
        for attempt in 0..4 {
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = tls.accept(socket).await.unwrap();
            let mut headers = Vec::new();
            loop {
                let byte = stream.read_u8().await.unwrap();
                headers.push(byte);
                if headers.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            requests.send(attempt).unwrap();
            if attempt == 0 {
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\nshort",
                    )
                    .await
                    .unwrap();
            } else {
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            server_body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.write_all(&server_body).await.unwrap();
            }
            stream.shutdown().await.unwrap();
        }
    });
    let (first, second) = tokio::join!(
        cache.get(&reference, &cancel),
        cache.get(&reference, &cancel)
    );
    assert_eq!(first.unwrap(), body);
    assert_eq!(second.unwrap(), body);
    assert_eq!(received.recv().await, Some(0));
    assert_eq!(received.recv().await, Some(1));
    let expired = BundleReference {
        download_url: "https://unreachable.invalid/expired".into(),
        ..reference
    };
    assert_eq!(cache.get(&expired, &cancel).await.unwrap(), body);
    fs::write(
        cache.root.join(format!("{}.tar.gz", expired.sha256)),
        "corrupt",
    )
    .await
    .unwrap();
    let repaired = BundleReference {
        download_url: url.clone(),
        ..expired
    };
    assert_eq!(cache.get(&repaired, &cancel).await.unwrap(), body);
    assert_eq!(received.recv().await, Some(2));
    let rejected = BundleReference {
        sha256: "a".repeat(64),
        download_url: url,
        ..repaired
    };
    let failure = cache.get(&rejected, &cancel).await.unwrap_err().to_string();
    assert!(failure.contains("integrity mismatch"));
    assert!(!failure.contains("signature"));
    assert!(!failure.contains("private"));
    assert!(
        !cache
            .root
            .join(format!("{}.tar.gz", rejected.sha256))
            .exists()
    );
    assert!(!cache.root.join(format!("{}.tmp", rejected.sha256)).exists());
    assert_eq!(received.recv().await, Some(3));
    server.await.unwrap();
}

#[tokio::test]
async fn cancelled_request_does_not_start_cache_work() {
    let temp = tempfile::tempdir().unwrap();
    let cache = ContentBundleCache::new(temp.path().to_path_buf()).unwrap();
    let reference = BundleReference {
        sha256: "a".repeat(64),
        archive_bytes: 1,
        download_url: "https://unreachable.invalid/package".into(),
    };
    let _held = runner_host::lock::acquire(temp.path().join(format!("{}.lock", reference.sha256)))
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        cache.get(&reference, &cancel).await,
        Err(StorageError::Cancelled)
    ));
}

#[tokio::test]
async fn eviction_preserves_active_hashes_and_reclaims_orphan_temporary_archives() {
    let directory = tempfile::tempdir().unwrap();
    let cache = ContentBundleCache::new(directory.path().to_path_buf()).unwrap();
    let protected = format!("{:064x}", 0);
    for index in 0..1025 {
        let path = directory.path().join(format!("{index:064x}.tar.gz"));
        fs::write(&path, b"x").await.unwrap();
        std::fs::File::open(path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(index)),
            )
            .unwrap();
    }
    let _active = runner_host::lock::acquire(directory.path().join(format!("{protected}.lock")))
        .await
        .unwrap();
    let orphan = directory.path().join(format!("{:064x}.tmp", 1026));
    fs::write(&orphan, b"unpublished").await.unwrap();
    cache.evict().await.unwrap();
    assert!(
        directory
            .path()
            .join(format!("{protected}.tar.gz"))
            .exists()
    );
    assert!(!orphan.exists());
    let archives = std::fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "gz")
        })
        .count();
    assert!(archives <= 1024);
}
