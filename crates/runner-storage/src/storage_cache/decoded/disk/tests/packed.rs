use super::*;

fn seed_legacy(home: &HomePaths) -> (PathBuf, PathBuf) {
    let (entry, lock) = persisted_paths(home, "name", "v1", false);
    fs::create_dir_all(entry.join("files/nested")).unwrap();
    fs::write(entry.join("files/nested/file"), b"hello").unwrap();
    fs::write(
        entry.join("index.json"),
        serde_json::to_vec(&serde_json::json!({
            "name":"name", "version":"v1", "compressed_bytes":100,
            "files":[{"path":"nested/file", "mode":0o751, "mtime":1234,
                "size":5, "sha256":hex::encode(Sha256::digest(b"hello"))}]
        }))
        .unwrap(),
    )
    .unwrap();
    drop(lock::try_acquire_or_busy_blocking(&lock).unwrap());
    (entry, lock)
}

#[test]
fn packed_members_round_trip_in_index_order_with_one_payload_inode() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let files = vec![
        StorageFile {
            path: "z/last".into(),
            mode: 0o751,
            mtime: 1234,
            content: b"last".to_vec(),
        },
        StorageFile {
            path: "a/empty".into(),
            mode: 0o600,
            mtime: 0,
            content: Vec::new(),
        },
        StorageFile {
            path: "a/first".into(),
            mode: 0o640,
            mtime: 4321,
            content: b"first".to_vec(),
        },
    ];
    let cancel = CancellationToken::new();
    publish(&home, "name", "v1", 100, Some(&files), &cancel).unwrap();
    let name_hash = short_digest("name");
    let key = format!("decoded-v2-{}", short_digest("v1"));
    let entry = home.storages_dir().join(&name_hash).join(&key);
    assert_eq!(fs::read(entry.join("data.bin")).unwrap(), b"lastfirst");
    assert_eq!(fs::read_dir(&entry).unwrap().count(), 2);
    assert_eq!(
        fs::metadata(entry.join("data.bin")).unwrap().mode() & 0o777,
        0o600
    );
    let writer = lock::try_acquire_or_busy_blocking(
        &home
            .locks_dir()
            .join(format!("storage-{name_hash}-{key}.lock")),
    )
    .unwrap();
    assert!(matches!(writer, TryLock::Acquired(_)));
    assert!(read(&home, "name", "v1", &cancel).unwrap().is_none());
    drop(writer);
    assert_eq!(read(&home, "name", "v1", &cancel).unwrap().unwrap(), files);
}

#[test]
fn packed_payload_requires_exact_regular_unlinked_content() {
    for mutation in ["truncated", "extended", "directory", "fifo"] {
        let (_root, home, entry, _) = setup();
        let path = entry.join("data.bin");
        match mutation {
            "truncated" => fs::write(&path, b"hell").unwrap(),
            "extended" => fs::write(&path, b"hello!").unwrap(),
            "directory" => {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }
            "fifo" => {
                fs::remove_file(&path).unwrap();
                nix::unistd::mkfifo(&path, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
            }
            _ => panic!("unexpected payload mutation: {mutation}"),
        }
        assert!(
            read(&home, "name", "v1", &CancellationToken::new()).is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn legacy_data_stays_readable_without_archive_and_retirement_holds_its_lock() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (_entry, legacy_lock) = seed_legacy(&home);
    let cancel = CancellationToken::new();
    assert_eq!(
        read(&home, "name", "v1", &cancel).unwrap().unwrap(),
        files()
    );
    let archive = seed_retirement_archive(&home);
    let writer = lock::try_acquire_or_busy_blocking(&legacy_lock).unwrap();
    assert!(!retire_archive(&home, "name", "v1", &cancel).unwrap());
    assert!(archive.is_file());
    drop(writer);
    assert!(retire_archive(&home, "name", "v1", &cancel).unwrap());
    assert_eq!(
        read(&home, "name", "v1", &cancel).unwrap().unwrap(),
        files()
    );
}

#[test]
fn corrupt_packed_data_is_not_hidden_by_a_valid_legacy_entry() {
    let (_root, home, entry, _) = setup();
    seed_legacy(&home);
    let archive = seed_retirement_archive(&home);
    fs::write(entry.join("data.bin"), b"world").unwrap();
    let cancel = CancellationToken::new();
    assert!(read(&home, "name", "v1", &cancel).is_err());
    assert!(retire_archive(&home, "name", "v1", &cancel).is_err());
    assert_eq!(fs::read(archive).unwrap(), b"retained compressed source");
}

#[test]
fn legacy_reader_preserves_parent_leaf_and_integrity_checks() {
    for mutation in ["parent-link", "leaf-link", "hardlink", "content"] {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().to_owned());
        let (entry, _) = seed_legacy(&home);
        let leaf = entry.join("files/nested/file");
        let outside = root.path().join("outside");
        match mutation {
            "parent-link" => {
                let parent = entry.join("files/nested");
                fs::rename(&parent, &outside).unwrap();
                std::os::unix::fs::symlink(&outside, &parent).unwrap();
            }
            "leaf-link" => {
                fs::rename(&leaf, &outside).unwrap();
                std::os::unix::fs::symlink(&outside, &leaf).unwrap();
            }
            "hardlink" => fs::hard_link(&leaf, &outside).unwrap(),
            "content" => fs::write(&leaf, b"world").unwrap(),
            _ => panic!("unexpected legacy mutation: {mutation}"),
        }
        assert!(
            read(&home, "name", "v1", &CancellationToken::new()).is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn migration_persists_verified_payload_and_metadata_without_an_archive() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (legacy, _) = seed_legacy(&home);
    let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(123);
    File::open(&legacy)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    let cancel = CancellationToken::new();
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Converted
    ));
    let (packed, _) = paths(&home, "name", "v1");
    assert!(!legacy.exists());
    assert_eq!(fs::read(packed.join("data.bin")).unwrap(), b"hello");
    assert_eq!(fs::metadata(&packed).unwrap().modified().unwrap(), old_time);
    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(packed.join("index.json")).unwrap()).unwrap();
    assert_eq!(index["compressed_bytes"], 100);
    assert_eq!(
        read(&home, "name", "v1", &cancel).unwrap().unwrap(),
        files()
    );
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Gone
    ));
}

#[test]
fn migration_finishes_partial_source_cleanup_using_existing_verified_v2() {
    let (_root, home, packed, _) = setup();
    let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(123);
    File::open(&packed)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    let (legacy, _) = seed_legacy(&home);
    fs::remove_file(legacy.join("index.json")).unwrap();
    fs::remove_file(legacy.join("files/nested/file")).unwrap();
    assert!(matches!(
        migrate_legacy(
            &home,
            &short_digest("name"),
            &short_digest("v1"),
            &CancellationToken::new()
        )
        .unwrap(),
        MigrationOutcome::Converted
    ));
    assert!(!legacy.exists());
    assert_eq!(fs::metadata(&packed).unwrap().modified().unwrap(), old_time);
    assert_eq!(fs::read(packed.join("data.bin")).unwrap(), b"hello");
}

#[test]
fn unavailable_packed_entry_does_not_probe_a_partially_retired_legacy_source() {
    for reason in ["content-budget", "file-budget", "busy"] {
        let (_root, home, packed, packed_lock) = setup();
        let (legacy, _) = seed_legacy(&home);
        // A previous migration durably published v2, then stopped during v1 cleanup.
        fs::remove_file(legacy.join("index.json")).unwrap();
        let writer =
            (reason == "busy").then(|| lock::try_acquire_or_busy_blocking(&packed_lock).unwrap());
        let result = read_with_budget(
            &home,
            "name",
            "v1",
            if reason == "content-budget" {
                0
            } else {
                storage_files::MAX_STORAGE_BYTES
            },
            if reason == "file-budget" {
                0
            } else {
                storage_files::MAX_FILES
            },
            &CancellationToken::new(),
        );
        assert!(matches!(result, Ok(None)), "{reason}: {result:?}");
        drop(writer);
        assert_eq!(fs::read(packed.join("data.bin")).unwrap(), b"hello");
        assert_eq!(
            read(&home, "name", "v1", &CancellationToken::new())
                .unwrap()
                .unwrap(),
            files()
        );
    }
}

#[test]
fn migration_keeps_index_order_empty_members_and_distinct_metadata() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (legacy, _) = persisted_paths(&home, "name", "v1", false);
    let members = vec![
        StorageFile {
            path: "z/last".into(),
            mode: 0o751,
            mtime: 1234,
            content: b"last".to_vec(),
        },
        StorageFile {
            path: "a/empty".into(),
            mode: 0o600,
            mtime: 0,
            content: Vec::new(),
        },
        StorageFile {
            path: "a/first".into(),
            mode: 0o640,
            mtime: 4321,
            content: b"first".to_vec(),
        },
    ];
    for member in &members {
        let path = legacy.join("files").join(&member.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &member.content).unwrap();
    }
    fs::write(
        legacy.join("index.json"),
        encode_index("name", "v1", 100, Some(&members)).unwrap(),
    )
    .unwrap();
    let cancel = CancellationToken::new();
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Converted
    ));
    let (packed, _) = paths(&home, "name", "v1");
    assert_eq!(fs::read(packed.join("data.bin")).unwrap(), b"lastfirst");
    assert_eq!(
        read(&home, "name", "v1", &cancel).unwrap().unwrap(),
        members
    );
}

#[test]
fn migration_preserves_sources_on_corruption_publication_failure_and_cancellation() {
    for failure in ["source", "replacement", "identity", "staging", "cancel"] {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().to_owned());
        let (legacy, _) = seed_legacy(&home);
        let (packed, _) = paths(&home, "name", "v1");
        let cancel = CancellationToken::new();
        match failure {
            "source" => fs::write(legacy.join("files/nested/file"), b"wrong").unwrap(),
            "replacement" => {
                publish_locked(
                    &home,
                    "name",
                    "v1",
                    100,
                    Some(&files()),
                    EntryKind::Positive,
                    &cancel,
                )
                .unwrap();
                fs::write(packed.join("data.bin"), b"wrong").unwrap();
            }
            "identity" => fs::write(
                legacy.join("index.json"),
                encode_index("other", "v1", 100, Some(&files())).unwrap(),
            )
            .unwrap(),
            "staging" => fs::write(packed.with_extension("tmp"), b"occupied").unwrap(),
            "cancel" => cancel.cancel(),
            _ => panic!("unexpected migration failure case"),
        }
        assert!(
            migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).is_err(),
            "{failure}"
        );
        assert!(legacy.join("index.json").exists(), "{failure}");
        if failure != "source" {
            assert_eq!(
                fs::read(legacy.join("files/nested/file")).unwrap(),
                b"hello"
            );
        }
    }
}

#[test]
fn migration_keeps_shared_readers_and_actual_destination_gc_locks_protected() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (legacy, legacy_lock) = seed_legacy(&home);
    let (packed, packed_lock) = paths(&home, "name", "v1");
    let cancel = CancellationToken::new();
    let destination = lock::try_acquire_or_busy_blocking(&packed_lock).unwrap();
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Busy
    ));
    assert!(!packed.exists());
    drop(destination);
    let reader = lock::try_acquire_existing_shared_or_missing_blocking(&legacy_lock).unwrap();
    assert!(matches!(reader, ExistingTryLock::Acquired(_)));
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Busy
    ));
    assert!(legacy.exists());
    assert_eq!(
        read(&home, "name", "v1", &cancel).unwrap().unwrap(),
        files()
    );
    drop(reader);
    assert!(matches!(
        migrate_legacy(&home, &short_digest("name"), &short_digest("v1"), &cancel).unwrap(),
        MigrationOutcome::Converted
    ));
    assert!(!legacy.exists());
}
