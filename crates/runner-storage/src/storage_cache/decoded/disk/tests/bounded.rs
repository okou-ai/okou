use super::*;

#[test]
fn index_writer_bounds_allocation_before_serialization_completes() {
    let mut writer = IndexWriter::new();
    // Non-power-of-two chunks must not cause an allocation beyond the envelope.
    writer.write_all(&vec![b'x'; 3301]).unwrap();
    writer.write_all(&vec![b'x'; INDEX_LIMIT - 3301]).unwrap();
    assert!(writer.write_all(b"x").is_err());
    assert_eq!(writer.0.len(), INDEX_LIMIT);
    assert!(writer.0.capacity() <= INDEX_LIMIT);

    let mut writer = IndexWriter::new();
    assert!(serde_json::to_writer(&mut writer, &"\"".repeat(INDEX_LIMIT)).is_err());
    assert!(writer.0.len() <= INDEX_LIMIT);
    assert!(writer.0.capacity() <= INDEX_LIMIT);
}

#[test]
fn valid_path_envelope_can_still_fail_bounded_index_publication_cleanly() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let files: Vec<_> = (0..512)
        .map(|index| StorageFile {
            path: format!("{index:04}{}", "\"".repeat(250)),
            mode: 0o640,
            mtime: 1,
            content: Vec::new(),
        })
        .collect();
    storage_files::validate_files(&files).unwrap();
    assert!(admitted_paths(&files));
    assert_eq!(
        publish(
            &home,
            "overflow",
            "v1",
            100,
            Some(&files),
            &CancellationToken::new()
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::InvalidData,
    );
    assert!(!paths(&home, "overflow", "v1").0.exists());
    assert!(
        fs::read_dir(home.storages_dir().join(short_digest("overflow")))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn content_budget_is_checked_before_opening_file_bodies() {
    let (_root, home, entry, _) = setup();
    fs::remove_file(entry.join("files/nested/file")).unwrap();
    assert!(
        read_with_budget(
            &home,
            "name",
            "v1",
            4,
            storage_files::MAX_FILES,
            &CancellationToken::new()
        )
        .unwrap()
        .is_none()
    );
    // When selected with sufficient budget, invalid positive content remains an error.
    assert!(read(&home, "name", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn file_budget_is_checked_before_bodies_but_does_not_hide_invalid_metadata() {
    let (_root, home, entry, _) = setup();
    fs::remove_file(entry.join("files/nested/file")).unwrap();
    let cancel = CancellationToken::new();
    assert!(
        read_with_budget(
            &home,
            "name",
            "v1",
            storage_files::MAX_STORAGE_BYTES,
            0,
            &cancel
        )
        .unwrap()
        .is_none()
    );
    assert!(
        read_with_budget(
            &home,
            "name",
            "v1",
            storage_files::MAX_STORAGE_BYTES,
            1,
            &cancel
        )
        .is_err()
    );
    let index_path = entry.join("index.json");
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    index["files"][0]["mode"] = serde_json::json!(0o1000);
    fs::write(index_path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert_eq!(
        read_with_budget(
            &home,
            "name",
            "v1",
            storage_files::MAX_STORAGE_BYTES,
            0,
            &cancel
        )
        .unwrap_err()
        .kind(),
        io::ErrorKind::InvalidData
    );
}

#[test]
fn existing_v1_positive_entry_is_reused_without_republication() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (entry, _) = persisted_paths(&home, "name", "v1", false);
    fs::create_dir_all(entry.join("files/nested")).unwrap();
    fs::write(entry.join("files/nested/file"), b"hello").unwrap();
    // Seed the existing v1 schema independently from the current publisher.
    let index = serde_json::to_vec(&serde_json::json!({
        "name": "name", "version": "v1", "compressed_bytes": 100,
        "files": [{
            "path": "nested/file", "mode": 0o751, "mtime": 1234,
            "size": 5, "sha256": hex::encode(Sha256::digest(b"hello"))
        }]
    }))
    .unwrap();
    fs::write(entry.join("index.json"), &index).unwrap();
    let cancel = CancellationToken::new();
    assert_eq!(
        read(&home, "name", "v1", &cancel)
            .unwrap()
            .flatten()
            .unwrap(),
        files()
    );
    let replacement = vec![StorageFile {
        path: "nested/file".into(),
        mode: 0o640,
        mtime: 4321,
        content: b"replacement".to_vec(),
    }];
    publish(&home, "name", "v1", 100, Some(&replacement), &cancel).unwrap();
    assert_eq!(fs::read(entry.join("index.json")).unwrap(), index);
    assert_eq!(fs::read(entry.join("files/nested/file")).unwrap(), b"hello");
    assert_eq!(
        read(&home, "name", "v1", &cancel)
            .unwrap()
            .flatten()
            .unwrap(),
        files()
    );
}

#[tokio::test]
async fn existing_v1_rejection_retains_optional_skip_without_rewriting_source() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    for number in 0..48 {
        let mut header = tar::Header::new_ustar();
        header.set_size(1);
        header.set_mode(0o640);
        header.set_cksum();
        archive
            .append_data(&mut header, format!("file-{number}"), &b"x"[..])
            .unwrap();
    }
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    assert!(bytes.len() <= MAX_COMPRESSED_BYTES);
    let source = home.storage_cache_dir("name", "v1");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("archive.tar.gz"), &bytes).unwrap();
    drop(lock::try_acquire_or_busy_blocking(&home.storage_lock("name", "v1")).unwrap());
    let (entry, _) = persisted_paths(&home, "name", "v1", true);
    fs::create_dir_all(&entry).unwrap();
    // This shape exceeded the former 32-file limit. The existing record has no
    // admission-policy field, so keeping v1 also keeps its optional skip.
    let index = serde_json::to_vec(&serde_json::json!({
        "name": "name", "version": "v1", "compressed_bytes": bytes.len(),
        "files": null
    }))
    .unwrap();
    fs::write(entry.join("index.json"), &index).unwrap();
    assert!(is_rejected(&home, "name", "v1", &CancellationToken::new()).unwrap());
    let cache = DecodedCache::new(home.clone());
    cache.warm_from_archive("name", "v1").await.unwrap();
    assert!(cache.get_ready("name", "v1").await.unwrap().is_none());
    cache.shutdown().await;
    assert_eq!(fs::read(entry.join("index.json")).unwrap(), index);
    assert_eq!(fs::read(source.join("archive.tar.gz")).unwrap(), bytes);
}
