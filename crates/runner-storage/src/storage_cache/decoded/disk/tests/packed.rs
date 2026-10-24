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
