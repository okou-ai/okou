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
fn legacy_positive_and_rejection_entries_are_not_reinterpreted_or_removed() {
    let (_root, home, positive, positive_lock) = setup();
    let legacy_key = format!("decoded-v1-{}", short_digest("v1"));
    let legacy = home
        .storages_dir()
        .join(short_digest("name"))
        .join(&legacy_key);
    let old_index = fs::read(positive.join("index.json")).unwrap();
    fs::rename(positive, &legacy).unwrap();
    fs::rename(
        positive_lock,
        home.storage_lock_for_cache_key(&short_digest("name"), &legacy_key),
    )
    .unwrap();
    assert!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .is_none()
    );
    publish(
        &home,
        "name",
        "v1",
        100,
        Some(&files()),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .unwrap()
            .unwrap(),
        files()
    );
    assert_eq!(fs::read(legacy.join("index.json")).unwrap(), old_index);

    publish(
        &home,
        "rejected",
        "v1",
        100,
        None,
        &CancellationToken::new(),
    )
    .unwrap();
    let (rejected, rejected_lock) = entry_paths(&home, "rejected", "v1", true);
    let legacy_key = format!("decoded-v1-rejected-{}", short_digest("v1"));
    let legacy = home
        .storages_dir()
        .join(short_digest("rejected"))
        .join(&legacy_key);
    let old_index = fs::read(rejected.join("index.json")).unwrap();
    fs::rename(rejected, &legacy).unwrap();
    fs::rename(
        rejected_lock,
        home.storage_lock_for_cache_key(&short_digest("rejected"), &legacy_key),
    )
    .unwrap();
    assert!(!is_rejected(&home, "rejected", "v1", &CancellationToken::new()).unwrap());
    publish(
        &home,
        "rejected",
        "v1",
        100,
        Some(&files()),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(
        read(&home, "rejected", "v1", &CancellationToken::new())
            .unwrap()
            .unwrap()
            .unwrap(),
        files()
    );
    assert_eq!(fs::read(legacy.join("index.json")).unwrap(), old_index);
}
