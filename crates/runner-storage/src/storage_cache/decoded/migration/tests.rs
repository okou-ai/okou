use super::*;
use runner_host::paths::short_digest;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn seed(home: &HomePaths, name: &str, version: &str) -> PathBuf {
    let directory = home
        .storages_dir()
        .join(short_digest(name))
        .join(format!("decoded-v1-{}", short_digest(version)));
    fs::create_dir_all(directory.join("files/nested")).unwrap();
    fs::write(directory.join("files/nested/file"), b"hello").unwrap();
    fs::write(
        directory.join("index.json"),
        serde_json::to_vec(&serde_json::json!({
            "name":name,"version":version,"compressed_bytes":100,
            "files":[{"path":"nested/file","mode":0o751,"mtime":1234,
                "size":5,"sha256":hex::encode(Sha256::digest(b"hello"))}]
        }))
        .unwrap(),
    )
    .unwrap();
    directory
}

#[test]
fn sweep_finds_cold_entries_progresses_past_busy_keys_and_excludes_negative_records() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let first = seed(&home, "first", "v1");
    let second = seed(&home, "second", "v1");
    let negative = home
        .storages_dir()
        .join(short_digest("first"))
        .join(format!("decoded-v1-rejected-{}", short_digest("v1")));
    fs::create_dir(&negative).unwrap();
    fs::write(negative.join("index.json"), b"negative marker").unwrap();
    let held = runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock_for_cache_key(
        &short_digest("first"),
        &format!("decoded-v1-{}", short_digest("v1")),
    ))
    .unwrap();
    let mut cursor = Cursor::default();
    let cancel = CancellationToken::new();
    while !cursor.batch(&home, &cancel).unwrap() {}
    assert_eq!(cursor.report.scanned, 2);
    assert_eq!(cursor.report.converted, 1);
    assert_eq!(cursor.report.remaining, 1);
    assert!(first.exists());
    assert!(!second.exists());
    assert_eq!(
        fs::read(negative.join("index.json")).unwrap(),
        b"negative marker"
    );
    drop(held);
    let mut retry = Cursor::default();
    while !retry.batch(&home, &cancel).unwrap() {}
    assert_eq!(retry.report.converted, 1);
    assert_eq!(retry.report.remaining, 0);
    assert!(!first.exists());
    let expected = vec![StorageFile {
        path: "nested/file".into(),
        mode: 0o751,
        mtime: 1234,
        content: b"hello".to_vec(),
    }];
    for name in ["first", "second"] {
        assert_eq!(
            disk::read(&home, name, "v1", &cancel).unwrap().unwrap(),
            expected
        );
    }
}

#[test]
fn scan_is_bounded_and_reports_corruption_and_unavailable_roots() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let legacy = seed(&home, "name", "v1");
    fs::write(legacy.join("files/nested/file"), b"wrong").unwrap();
    for index in 0..SCAN_BATCH * 2 {
        fs::create_dir(home.storages_dir().join(format!("unrelated-{index}"))).unwrap();
    }
    let cancel = CancellationToken::new();
    let mut cursor = Cursor::default();
    assert!(!cursor.batch(&home, &cancel).unwrap());
    while !cursor.batch(&home, &cancel).unwrap() {}
    assert_eq!(cursor.report.failed, 1);
    assert_eq!(cursor.report.remaining, 1);
    assert!(legacy.exists());
    let linked_root = root.path().join("linked-root");
    fs::create_dir(&linked_root).unwrap();
    std::os::unix::fs::symlink(home.storages_dir(), linked_root.join("storages")).unwrap();
    assert!(
        Cursor::default()
            .batch(&HomePaths::with_root(linked_root), &cancel)
            .is_err()
    );
}

#[tokio::test]
async fn background_owner_migrates_cold_data_and_shutdown_joins_accepted_work() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let legacy = seed(&home, "cold", "v1");
    let cache = DecodedCache::new(home.clone());
    cache.start_migration();
    cache.start_migration();
    let packed = home
        .storages_dir()
        .join(short_digest("cold"))
        .join(format!("decoded-v2-{}", short_digest("v1")));
    tokio::time::timeout(Duration::from_secs(5), async {
        while legacy.exists() || !packed.join("data.bin").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cache.shutdown().await;
    assert_eq!(fs::read(packed.join("data.bin")).unwrap(), b"hello");
    // No tracked scan or blocking IO survives the owner's normal shutdown.
    assert!(cache.0.tasks.is_empty());
    cache.start_migration();
    assert!(cache.0.tasks.is_empty());
}

#[tokio::test]
async fn dropping_the_last_owner_cancels_the_scanner_without_a_self_reference() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let legacy = seed(&home, "cold", "v1");
    let cache = DecodedCache::new(home);
    let owner = Arc::downgrade(&cache.0);
    let tasks = cache.0.tasks.clone();
    cache.start_migration();
    drop(cache);
    tasks.close();
    tokio::time::timeout(Duration::from_secs(5), tasks.wait())
        .await
        .unwrap();
    assert!(owner.upgrade().is_none());
    assert_eq!(
        fs::read(legacy.join("files/nested/file")).unwrap(),
        b"hello"
    );
}
