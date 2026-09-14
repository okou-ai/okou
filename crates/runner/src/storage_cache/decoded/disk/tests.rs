use super::*;

fn files() -> Vec<StorageFile> {
    vec![StorageFile {
        path: "nested/file".into(),
        mode: 0o751,
        mtime: 1234,
        content: b"hello".to_vec(),
    }]
}

fn setup() -> (tempfile::TempDir, HomePaths, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    publish(
        &home,
        "name",
        "v1",
        100,
        Some(&files()),
        &CancellationToken::new(),
    )
    .unwrap();
    let (entry, lock) = paths(&home, "name", "v1");
    (root, home, entry, lock)
}

#[test]
fn real_files_survive_new_home_owner_without_an_archive() {
    let (root, _, entry, _) = setup();
    assert_eq!(fs::read(entry.join("files/nested/file")).unwrap(), b"hello");
    assert!(!entry.join("archive.tar.gz").exists());
    let home = HomePaths::with_root(root.path().to_owned());
    assert_eq!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .unwrap()
            .unwrap(),
        files()
    );
}

#[test]
fn admission_rejections_have_no_foreground_entry_and_are_validated_only_for_fill() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    publish(&home, "name", "v1", 100, None, &CancellationToken::new()).unwrap();
    assert!(!paths(&home, "name", "v1").0.exists());
    assert!(is_rejected(&home, "name", "v1", &CancellationToken::new()).unwrap());
    let (rejected, _) = entry_paths(&home, "name", "v1", true);
    fs::write(rejected.join("index.json"), b"{").unwrap();
    // Ordinary Guest delivery does not depend on unrelated admission metadata.
    assert!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .is_none()
    );
    assert!(is_rejected(&home, "name", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn entry_kind_cannot_be_swapped_between_positive_and_rejected_keys() {
    let (_root, home, positive, _) = setup();
    let (rejected, _) = entry_paths(&home, "name", "v1", true);
    fs::rename(&positive, &rejected).unwrap();
    assert!(is_rejected(&home, "name", "v1", &CancellationToken::new()).is_err());
    publish(&home, "other", "v1", 100, None, &CancellationToken::new()).unwrap();
    let (positive, _) = paths(&home, "other", "v1");
    let (rejected, _) = entry_paths(&home, "other", "v1", true);
    fs::rename(rejected, positive).unwrap();
    assert!(read(&home, "other", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn orphaned_lock_collection_does_not_make_persistent_files_unreachable() {
    let (_root, home, _, lock_path) = setup();
    fs::remove_file(&lock_path).unwrap();
    assert_eq!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .unwrap()
            .unwrap(),
        files()
    );
    assert!(lock_path.is_file());
    let (missing, missing_lock) = paths(&home, "missing", "v1");
    assert!(
        read(&home, "missing", "v1", &CancellationToken::new())
            .unwrap()
            .is_none()
    );
    assert!(!missing.exists());
    assert!(!missing_lock.exists());
}

#[test]
fn rejects_corrupt_content_and_index_without_returning_partial_files() {
    for target in [
        "content",
        "size",
        "identity",
        "truncated-index",
        "path",
        "mode",
        "mtime",
        "count",
        "expansion",
    ] {
        let (_root, home, entry, _) = setup();
        let index_path = entry.join("index.json");
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        match target {
            "content" => fs::write(entry.join("files/nested/file"), b"world").unwrap(),
            "truncated-index" => fs::write(&index_path, b"{").unwrap(),
            mutation => {
                match mutation {
                    "size" => index["files"][0]["size"] = 4.into(),
                    "identity" => index["version"] = "v2".into(),
                    "path" => index["files"][0]["path"] = "../outside".into(),
                    "mode" => index["files"][0]["mode"] = 0o4755.into(),
                    "mtime" => index["files"][0]["mtime"] = u64::MAX.into(),
                    "count" => index["files"] = serde_json::json!([]),
                    "expansion" => index["compressed_bytes"] = 1.into(),
                    _ => panic!("unexpected cache mutation fixture: {mutation}"),
                }
                fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
            }
        }
        assert!(
            read(&home, "name", "v1", &CancellationToken::new()).is_err(),
            "accepted {target}"
        );
    }
}

#[test]
fn positive_entry_cannot_claim_an_empty_compressed_source() {
    let (_root, home, entry, _) = setup();
    let index_path = entry.join("index.json");
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    index["compressed_bytes"] = 0.into();
    index["files"][0]["size"] = 0.into();
    index["files"][0]["sha256"] = hex::encode(Sha256::digest([])).into();
    fs::write(entry.join("files/nested/file"), []).unwrap();
    fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert!(read(&home, "name", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn refuses_file_directory_and_index_symlinks_and_hardlinks() {
    for target in ["files/nested/file", "files/nested", "files", "index.json"] {
        let (root, home, entry, _) = setup();
        let path = entry.join(target);
        let outside = root.path().join("outside");
        fs::rename(&path, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(
            read(&home, "name", "v1", &CancellationToken::new()).is_err(),
            "followed {target}"
        );
    }
    let (root, home, entry, _) = setup();
    fs::hard_link(entry.join("files/nested/file"), root.path().join("link")).unwrap();
    assert!(read(&home, "name", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn rejects_symlinks_in_the_storage_cache_namespace() {
    for component in ["storages", "name", "version"] {
        let (root, home, entry, _) = setup();
        let target = match component {
            "storages" => home.storages_dir(),
            "name" => entry.parent().unwrap().to_path_buf(),
            "version" => entry,
            _ => panic!("unexpected namespace fixture: {component}"),
        };
        let moved = root.path().join("moved-cache");
        fs::rename(&target, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &target).unwrap();
        assert!(
            read(&home, "name", "v1", &CancellationToken::new()).is_err(),
            "followed {component}"
        );
    }
}

#[test]
fn oversized_index_and_missing_file_are_errors_not_cache_misses() {
    let (_root, home, entry, _) = setup();
    let file = OpenOptions::new()
        .write(true)
        .open(entry.join("index.json"))
        .unwrap();
    file.set_len(INDEX_LIMIT as u64 + 1).unwrap();
    assert!(read(&home, "name", "v1", &CancellationToken::new()).is_err());
    let (_root, home, entry, _) = setup();
    fs::remove_file(entry.join("files/nested/file")).unwrap();
    assert!(read(&home, "name", "v1", &CancellationToken::new()).is_err());
}

#[test]
fn writer_lock_prevents_reads_and_publication_and_readers_can_share() {
    let (_root, home, entry, lock_path) = setup();
    let writer = lock::try_acquire_or_busy_blocking(&lock_path).unwrap();
    assert!(matches!(writer, TryLock::Acquired(_)));
    assert!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .is_none()
    );
    // A busy cache writer is optional, with no staging side effects.
    publish(
        &home,
        "name",
        "v1",
        100,
        Some(&files()),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(!entry.with_extension("tmp").exists());
    drop(writer);
    let reader = lock::try_acquire_existing_shared_or_missing_blocking(&lock_path).unwrap();
    assert!(matches!(reader, ExistingTryLock::Acquired(_)));
    assert!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        lock::try_acquire_or_busy_blocking(&lock_path).unwrap(),
        TryLock::Busy
    ));
}

#[test]
fn cancelled_and_failed_publications_leave_no_ready_entry() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (entry, _) = paths(&home, "name", "v1");
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        publish(&home, "name", "v1", 100, Some(&files()), &cancel)
            .unwrap_err()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(!entry.exists());
    let mut invalid = files();
    invalid[0].path = "../escape".into();
    assert!(
        publish(
            &home,
            "name",
            "v1",
            100,
            Some(&invalid),
            &CancellationToken::new()
        )
        .is_err()
    );
    assert!(!entry.exists());
    assert!(!entry.with_extension("tmp").exists());
    publish(
        &home,
        "name",
        "v1",
        100,
        Some(&files()),
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .is_some()
    );
}

#[test]
fn incomplete_staging_is_not_readable_and_next_fill_replaces_it() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let (entry, lock_path) = paths(&home, "name", "v1");
    drop(lock::try_acquire_or_busy_blocking(&lock_path).unwrap());
    let staging = entry.with_extension("tmp");
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("partial"), b"unfinished").unwrap();
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
    assert!(!staging.exists());
    assert!(!entry.join("partial").exists());
    assert_eq!(
        read(&home, "name", "v1", &CancellationToken::new())
            .unwrap()
            .unwrap()
            .unwrap(),
        files()
    );
}

#[test]
fn directory_and_component_limits_bound_real_disk_inodes() {
    let mut files = files();
    files[0].path = format!("{}file", "d/".repeat(64));
    assert!(admitted_paths(&files));
    files[0].path = format!("{}file", "d/".repeat(65));
    assert!(!admitted_paths(&files));
    files[0].path = "a".repeat(256);
    assert!(!admitted_paths(&files));
}
