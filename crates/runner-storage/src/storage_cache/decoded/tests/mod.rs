use super::*;

mod gnu;
mod large;

#[tokio::test]
async fn lookup_skips_unselected_and_oversized_identities_without_io() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cache = DecodedCache::new(home.clone());
    cache
        .resolve("name", "v1", archive(b"hello"))
        .await
        .unwrap();
    let oversized = "x".repeat(4097);
    let ready = cache
        .get_ready_batch(&[
            None,
            Some((&oversized, "v1")),
            Some(("name", &oversized)),
            Some(("name", "v1")),
        ])
        .await
        .unwrap();
    assert_eq!(ready.len(), 4);
    assert!(ready[..3].iter().all(Option::is_none));
    assert_eq!(ready[3].as_ref().unwrap().files[0].content, b"hello");
    assert!(
        cache
            .get_ready_batch(&[None; LOOKUP_BATCH_SIZE + 1])
            .await
            .is_err()
    );
    let wide = cache
        .get_ready_batch(&[Some(("name", "v1")); LOOKUP_BATCH_SIZE])
        .await
        .unwrap();
    assert!(wide.iter().all(|files| {
        files
            .as_ref()
            .is_some_and(|files| files.files[0].content == b"hello")
    }));
    let long = "k".repeat(4096);
    let mut budget = vec![Some((long.as_str(), long.as_str())); 16];
    budget.push(Some(("name", "v1")));
    assert!(
        cache
            .get_ready_batch(&budget)
            .await
            .unwrap()
            .iter()
            .all(Option::is_none)
    );
    // A batch's key budget cannot make a later independent lookup miss.
    assert!(cache.get_ready("name", "v1").await.unwrap().is_some());
    // No selected identities need filesystem access or a worker.
    cache.shutdown().await;
    assert!(cache.get_ready_batch(&[None]).await.unwrap()[0].is_none());
}

#[tokio::test]
async fn wide_lookup_bounds_ready_read_ahead_even_when_all_keys_hit() {
    let root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(root.path().to_owned()));
    cache
        .resolve(
            "name",
            "v1",
            archive(&vec![42; storage_files::MAX_FILE_BYTES]),
        )
        .await
        .unwrap();
    let ready = cache
        .get_ready_batch(&[Some(("name", "v1")); LOOKUP_BATCH_SIZE])
        .await
        .unwrap();
    let admitted = storage_files::MAX_PAYLOAD_BYTES / storage_files::MAX_FILE_BYTES;
    assert!(ready[..admitted].iter().all(Option::is_some));
    assert!(ready[admitted..].iter().all(Option::is_none));
    let retained: usize = ready
        .iter()
        .flatten()
        .flat_map(|files| &files.files)
        .map(|file| file.content.len())
        .sum();
    assert_eq!(retained, storage_files::MAX_PAYLOAD_BYTES);
    drop(ready);
    assert!(cache.get_ready("name", "v1").await.unwrap().is_some());
    cache.shutdown().await;
}

#[tokio::test]
async fn abandoned_caller_does_not_detach_blocking_work_from_shutdown() {
    let root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(root.path().to_owned()));
    let (started, entered) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let operation_cache = cache.clone();
    let operation = tokio::spawn(async move {
        operation_cache
            .work(move |_, _memory| {
                started.send(()).unwrap();
                wait.recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(())
            })
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), entered)
        .await
        .unwrap()
        .unwrap();
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    let mut shutdown = Box::pin(cache.shutdown());
    assert!(futures_util::poll!(shutdown.as_mut()).is_pending());
    assert!(cache.get_ready("any", "v1").await.is_err());
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    assert_eq!(cache.0.workers.available_permits(), 2);
}

fn archive(content: &[u8]) -> Bytes {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(content.len() as u64);
    header.set_mode(0o751);
    header.set_mtime(1234);
    header.set_cksum();
    builder
        .append_data(&mut header, "nested/file", content)
        .unwrap();
    Bytes::from(builder.into_inner().unwrap().finish().unwrap())
}

#[tokio::test]
async fn decoded_cache_rejects_invalid_gzip_trailers_after_tar_end() {
    use std::io::Write;

    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(7);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, "file", &b"content"[..])
        .unwrap();
    let mut encoder = builder.into_inner().unwrap();
    // Tar finishes before gzip. Padding forces its trailer beyond reads
    // needed for the tar entries, matching the normal archive contract.
    encoder.write_all(&vec![0; 64 * 1024]).unwrap();
    let valid = encoder.finish().unwrap();
    let mut bad_crc = valid.clone();
    let trailer = bad_crc.len() - 8;
    bad_crc[trailer] ^= 1;
    let mut bad_size = valid.clone();
    bad_size[trailer + 4] ^= 1;
    let truncated = valid[..trailer].to_vec();
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    for (version, bytes) in [
        ("crc", bad_crc),
        ("size", bad_size),
        ("truncated", truncated),
    ] {
        assert!(
            cache
                .resolve("integrity", version, Bytes::from(bytes))
                .await
                .is_err(),
            "decoded cache accepted invalid {version} trailer"
        );
        assert!(
            cache
                .get_ready("integrity", version)
                .await
                .unwrap()
                .is_none()
        );
    }
    let files = cache
        .resolve("integrity", "valid", Bytes::from(valid))
        .await
        .unwrap()
        .unwrap();
    let destination = tempfile::tempdir().unwrap();
    let mount = destination.path().to_str().unwrap();
    let manifest = serde_json::to_vec(&serde_json::json!({
        "storageMounts": [{"mountPath": mount, "archiveUrl": "file:///not-staged"}]
    }))
    .unwrap();
    let input = storage_files::encode_input(&manifest, &[(mount, &files.files)]).unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(&input));
    assert_eq!(
        std::fs::read(destination.path().join("file")).unwrap(),
        b"content"
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn decoded_cache_does_not_accept_reader_limit_as_valid_gzip_eof() {
    use std::io::Write;

    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let mut builder = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_size(7);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, "file", &b"content"[..])
        .unwrap();
    let mut encoder = builder.into_inner().unwrap();
    encoder
        .write_all(&vec![0; 2 * MAX_ADMITTED_STORAGE_BYTES])
        .unwrap();
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    assert!(
        cache
            .resolve("padding", "v1", Bytes::from(encoder.finish().unwrap()))
            .await
            .unwrap()
            .is_none()
    );
    assert!(cache.get_ready("padding", "v1").await.unwrap().is_none());
    cache.shutdown().await;
}

#[tokio::test]
async fn cached_versions_materialize_the_selected_content() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    for (name, version, content) in [
        ("first", "v1", &b"one"[..]),
        ("other", "v1", &b"two"[..]),
        ("first", "v2", &b"three"[..]),
        ("first", "v1", &b"one"[..]),
    ] {
        let files = cache
            .resolve(name, version, archive(content))
            .await
            .unwrap()
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        let mount = root.path().join("mount");
        let manifest = serde_json::to_vec(&serde_json::json!({"storageMounts":[{"mountPath":mount,"archiveUrl":"file:///not-staged"}]})).unwrap();
        let input =
            storage_files::encode_input(&manifest, &[(mount.to_str().unwrap(), &files.files)])
                .unwrap();
        assert!(guest_storage_apply::run_storage_files_bytes(&input));
        assert_eq!(std::fs::read(mount.join("nested/file")).unwrap(), content);
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn concurrent_fills_publish_once_and_shutdown_closes_admission() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    let bytes = archive(&vec![b'a'; 200_000]);
    let (first, second) = tokio::join!(
        cache.resolve("name", "v1", bytes.clone()),
        cache.resolve("name", "v1", bytes.clone())
    );
    let first = first.unwrap().unwrap();
    let second = second.unwrap().unwrap();
    assert_eq!(first.files, second.files);
    let persisted = cache.get_ready("name", "v1").await.unwrap().unwrap();
    assert_eq!(persisted.files, first.files);
    cache.shutdown().await;
    assert!(cache.resolve("name", "v1", bytes).await.is_err());
    assert_eq!(
        cache.get_ready("name", "v1").await.unwrap_err().kind(),
        io::ErrorKind::Interrupted
    );
    assert_eq!(first.files[0].content.len(), 200_000);
}

#[tokio::test]
async fn unsupported_shapes_are_not_ready_file_sets_and_corruption_is_an_error() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let mut builder = tar::Builder::new(&mut gzip);
    let mut header = tar::Header::new_ustar();
    header.set_size(200_000);
    header.set_mode(0o644);
    header.set_cksum();
    builder
        .append_data(&mut header, "file", &vec![0; 200_000][..])
        .unwrap();
    builder.finish().unwrap();
    drop(builder);
    let compressed = Bytes::from(gzip.finish().unwrap());
    assert!(
        cache
            .resolve("large-ratio", "v1", compressed)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        cache
            .resolve("corrupt", "v1", Bytes::from_static(b"bad"))
            .await
            .is_err()
    );
    assert!(
        cache
            .resolve("corrupt", "v1", archive(b"valid"))
            .await
            .unwrap()
            .is_some()
    );
    cache.shutdown().await;
}

#[tokio::test]
async fn pinned_content_remains_charged_and_admission_resumes_after_release() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    let pinned = cache
        .resolve("pinned", "v1", archive(b"keep"))
        .await
        .unwrap()
        .unwrap();
    let pressure = Arc::clone(&cache.0.memory)
        .try_acquire_many_owned(cache.0.memory.available_permits() as u32)
        .unwrap();
    assert!(
        cache
            .resolve("next", "v1", archive(b"next"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(cache.get_ready("pinned", "v1").await.unwrap().is_none());
    drop(pressure);
    let next = cache
        .resolve("next", "v1", archive(b"next"))
        .await
        .unwrap()
        .unwrap();
    cache.shutdown().await;
    assert!(cache.0.memory.available_permits() < CAPACITY);
    assert_eq!(pinned.files[0].content, b"keep");
    drop(next);
    drop(pinned);
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
}

#[tokio::test]
async fn background_fill_reuses_persistent_rejection_without_decoding_again() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    drop(
        runner_host::lock::acquire(home.storage_lock("name", "v1"))
            .await
            .unwrap(),
    );
    let source = home.storage_cache_dir("name", "v1").join("archive.tar.gz");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(
        &source,
        archive(&vec![1; storage_files::MAX_FILE_BYTES + 1]),
    )
    .unwrap();
    let cache = DecodedCache::new(home.clone());
    cache.warm_from_archive("name", "v1").await.unwrap();
    cache.shutdown().await;
    assert!(disk::is_rejected(&home, "name", "v1", &CancellationToken::new()).unwrap());
    std::fs::write(source, b"must not decode this source").unwrap();
    let cache = DecodedCache::new(home);
    cache.warm_from_archive("name", "v1").await.unwrap();
    assert!(cache.get_ready("name", "v1").await.unwrap().is_none());
    cache.shutdown().await;
}

#[tokio::test]
async fn negative_admission_survives_restart_without_retaining_memory() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    for index in 0..4 {
        assert!(
            cache
                .resolve(&format!("empty-{index}"), "v1", Bytes::new())
                .await
                .unwrap()
                .is_none()
        );
    }
    cache.shutdown().await;
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    let home = HomePaths::with_root(cache_root.path().to_owned());
    for index in 0..4 {
        assert!(
            disk::is_rejected(
                &home,
                &format!("empty-{index}"),
                "v1",
                &CancellationToken::new()
            )
            .unwrap()
        );
    }
}

#[tokio::test]
async fn busy_decoders_select_archive_without_queueing_more_work() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    let workers = Arc::clone(&cache.0.workers)
        .try_acquire_many_owned(2)
        .unwrap();
    assert!(
        cache
            .resolve("name", "v1", archive(b"data"))
            .await
            .unwrap()
            .is_none()
    );
    assert!(!disk::paths(&cache.0.home, "name", "v1").0.exists());
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    drop(workers);
    assert!(
        cache
            .resolve("name", "v1", archive(b"data"))
            .await
            .unwrap()
            .is_some()
    );
    cache.shutdown().await;
}

#[test]
fn cancelled_decode_does_not_return_a_ready_file_set() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        decode(&archive(b"data"), &cancel).unwrap_err().kind(),
        io::ErrorKind::Interrupted
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_tiny_cache_lookups_allow_other_ready_work_to_progress() {
    let cache_root = tempfile::tempdir().unwrap();
    let cache = DecodedCache::new(HomePaths::with_root(cache_root.path().to_owned()));
    assert!(
        cache
            .resolve("empty", "v1", Bytes::new())
            .await
            .unwrap()
            .is_none()
    );
    let completed = std::cell::Cell::new(0);
    let lookups = async {
        for _ in 0..4096 {
            assert!(
                cache
                    .resolve("empty", "v1", Bytes::new())
                    .await
                    .unwrap()
                    .is_none()
            );
            completed.set(completed.get() + 1);
        }
    };
    let peer = async {
        assert!(
            completed.get() < 4096,
            "cache lookup loop starved other ready work"
        );
    };
    tokio::join!(biased; lookups, peer);
    cache.shutdown().await;
}
