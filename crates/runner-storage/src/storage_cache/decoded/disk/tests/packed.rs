use super::*;

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
