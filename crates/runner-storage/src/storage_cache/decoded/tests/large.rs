use super::*;
use std::fs;
use std::os::unix::fs::MetadataExt;

pub(super) fn fixture_files(count: usize, bytes: usize, long_paths: bool) -> Vec<StorageFile> {
    (0..count)
        .map(|index| {
            let mut content = vec![b'x'; bytes];
            let mut state = index as u64 + 1;
            for byte in content.iter_mut().take(bytes / 2) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *byte = state as u8;
            }
            StorageFile {
                path: if long_paths {
                    format!("rollouts/{}/{index:04}.md", "a".repeat(110))
                } else {
                    format!("file-{index:04}")
                },
                mode: 0o640,
                mtime: 1234567890,
                content,
            }
        })
        .collect()
}

pub(super) fn archive_files(files: &[StorageFile]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for file in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(file.content.len() as u64);
        header.set_mode(file.mode);
        header.set_mtime(file.mtime);
        header.set_cksum();
        builder
            .append_data(&mut header, &file.path, &file.content[..])
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[tokio::test]
async fn enlarged_v1_positive_survives_restart_and_full_guest_delivery() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().join("host"));
    let files = fixture_files(768, 3400, true);
    use sha2::{Digest, Sha256};

    assert!(files.iter().map(|f| f.content.len()).sum::<usize>() > 2 * 1024 * 1024);
    // Model a later writer independently of this release's archive admission.
    let entry = disk::paths(&home, "memory-fixture", "v1").0;
    for file in &files {
        let path = entry.join("files").join(&file.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &file.content).unwrap();
    }
    let index = serde_json::to_vec(&serde_json::json!({
        "name": "memory-fixture", "version": "v1", "compressed_bytes": MAX_COMPRESSED_BYTES,
        "files": files.iter().map(|file| serde_json::json!({
            "path": file.path, "mode": file.mode, "mtime": file.mtime,
            "size": file.content.len(), "sha256": hex::encode(Sha256::digest(&file.content))
        })).collect::<Vec<_>>()
    }))
    .unwrap();
    fs::write(entry.join("index.json"), &index).unwrap();
    let cache = DecodedCache::new(home.clone());
    assert_eq!(
        cache
            .get_ready("memory-fixture", "v1")
            .await
            .unwrap()
            .unwrap()
            .files,
        files
    );
    cache.shutdown().await;
    assert_eq!(fs::read(entry.join("index.json")).unwrap(), index);

    let restarted = DecodedCache::new(home);
    let ready = restarted
        .get_ready("memory-fixture", "v1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ready.files, files);
    let target = root.path().join("guest-memory");
    let manifest = serde_json::to_vec(&serde_json::json!({
        "storageMounts": [{"mountPath": target, "archiveUrl": "file:///must-not-be-opened"}]
    }))
    .unwrap();
    let input = storage_files::encode_input(&manifest, &[(target.to_str().unwrap(), &ready.files)])
        .unwrap();
    assert!(guest_storage_apply::run_storage_files_bytes(&input));
    for file in &files {
        let path = target.join(&file.path);
        assert_eq!(fs::read(&path).unwrap(), file.content);
        let metadata = fs::metadata(path).unwrap();
        assert_eq!(metadata.mode() & 0o777, file.mode);
        assert_eq!(metadata.mtime() as u64, file.mtime);
    }
    drop(ready);
    restarted.shutdown().await;
    assert_eq!(restarted.0.memory.available_permits(), CAPACITY);
}

#[test]
fn count_and_content_boundaries_are_independent_of_gzip_size() {
    let cancel = CancellationToken::new();
    let files = fixture_files(MAX_ADMITTED_FILES, 64, false);
    assert_eq!(
        decode(&archive_files(&files), &cancel).unwrap().unwrap(),
        files
    );
    let too_many = fixture_files(MAX_ADMITTED_FILES + 1, 64, false);
    assert!(
        decode(&archive_files(&too_many), &cancel)
            .unwrap()
            .is_none()
    );

    let mut files = fixture_files(
        MAX_ADMITTED_STORAGE_BYTES / storage_files::MAX_FILE_BYTES,
        storage_files::MAX_FILE_BYTES,
        false,
    );
    for file in &mut files {
        file.content[storage_files::MAX_FILE_BYTES / 3..].fill(b'x');
    }
    assert!(archive_files(&files).len() <= MAX_COMPRESSED_BYTES);
    assert_eq!(
        decode(&archive_files(&files), &cancel).unwrap().unwrap(),
        files
    );
    let mut overflow = files;
    overflow.push(StorageFile {
        path: "extra".into(),
        mode: 0o640,
        mtime: 1,
        content: vec![1],
    });
    assert!(
        decode(&archive_files(&overflow), &cancel)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn production_warming_enforces_activated_count_content_and_longname_admission() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cache = DecodedCache::new(home.clone());
    for (name, count, bytes, long_paths, admitted) in [
        ("small", MAX_ADMITTED_FILES, 64, false, true),
        ("count", MAX_ADMITTED_FILES + 1, 64, false, false),
        (
            "content",
            MAX_ADMITTED_STORAGE_BYTES / storage_files::MAX_FILE_BYTES + 1,
            storage_files::MAX_FILE_BYTES,
            false,
            false,
        ),
        ("longnames", 1, 256, true, true),
    ] {
        let mut files = fixture_files(count, bytes, long_paths);
        if name == "content" {
            for file in &mut files {
                file.content[storage_files::MAX_FILE_BYTES / 3..].fill(b'x');
            }
        }
        let gzip = archive_files(&files);
        assert!(gzip.len() <= MAX_ADMITTED_COMPRESSED_BYTES);
        let source = home.storage_cache_dir(name, "v1");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("archive.tar.gz"), &gzip).unwrap();
        drop(
            runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock(name, "v1"))
                .unwrap(),
        );
        cache.warm_from_archive(name, "v1").await.unwrap();
        assert_eq!(
            cache.get_ready(name, "v1").await.unwrap().is_some(),
            admitted
        );
        assert_eq!(fs::read(source.join("archive.tar.gz")).unwrap(), gzip);
    }
    cache.shutdown().await;
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
}

#[test]
fn gzip_optional_metadata_retains_the_locked_decoder_field_bounds() {
    let cancel = CancellationToken::new();
    for extra in [0, 1] {
        let encoder = flate2::GzBuilder::new()
            .extra(vec![b'c'; u16::MAX as usize])
            .filename(vec![b'a'; u16::MAX as usize])
            .comment(vec![b'b'; u16::MAX as usize + extra])
            .write(Vec::new(), flate2::Compression::none());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o640);
        header.set_cksum();
        builder.append_data(&mut header, "file", &b"x"[..]).unwrap();
        let gzip = builder.into_inner().unwrap().finish().unwrap();
        assert!(gzip.len() <= MAX_COMPRESSED_BYTES);
        let result = decode(&gzip, &cancel);
        if extra == 0 {
            assert!(result.unwrap().is_some());
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }
}

#[tokio::test]
async fn large_ready_read_ahead_skips_a_body_that_does_not_fit_but_keeps_small_hits() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cancel = CancellationToken::new();
    for (name, count) in [("big", 16), ("medium", 10), ("small", 1)] {
        disk::publish(
            &home,
            name,
            "v1",
            MAX_COMPRESSED_BYTES,
            Some(&fixture_files(count, storage_files::MAX_FILE_BYTES, false)),
            &cancel,
        )
        .unwrap();
    }
    let cache = DecodedCache::new(home);
    let keys = ["big", "big", "big", "medium", "big", "small"];
    let ready = cache
        .get_ready_batch(&keys.map(|name| Some((name, "v1"))))
        .await
        .unwrap();
    assert_eq!(
        ready.iter().map(Option::is_some).collect::<Vec<_>>(),
        [true, true, true, true, false, true]
    );
    let bytes: usize = ready
        .iter()
        .flatten()
        .flat_map(|f| &f.files)
        .map(|f| f.content.len())
        .sum();
    assert_eq!(bytes, 59 * storage_files::MAX_FILE_BYTES);
    assert!(bytes < READ_AHEAD_BYTES);
    drop(ready);
    cache.shutdown().await;
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
}

#[tokio::test]
async fn empty_files_preserve_ready_file_read_ahead_and_allow_later_small_hits() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cancel = CancellationToken::new();
    for (name, count) in [
        ("wide", 1024),
        ("medium", 1000),
        ("small", 24),
        ("single", 1),
    ] {
        disk::publish(
            &home,
            name,
            "v1",
            MAX_COMPRESSED_BYTES,
            Some(&fixture_files(count, 0, false)),
            &cancel,
        )
        .unwrap();
    }
    let cache = DecodedCache::new(home);
    let keys = ["wide", "wide", "wide", "medium", "wide", "small", "single"];
    let ready = cache
        .get_ready_batch(&keys.map(|name| Some((name, "v1"))))
        .await
        .unwrap();
    assert_eq!(
        ready.iter().map(Option::is_some).collect::<Vec<_>>(),
        [true, true, true, true, false, true, false]
    );
    let mut files = ready.iter().flatten().flat_map(|entry| &entry.files);
    assert_eq!(files.clone().count(), 4096);
    assert!(files.all(|file| file.content.is_empty()));
    drop(ready);
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    // This is a per-batch optional budget, not persistent rejection of a valid entry.
    assert!(cache.get_ready("wide", "v1").await.unwrap().is_some());
    cache.shutdown().await;
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
}

#[tokio::test]
async fn exhausted_file_read_ahead_does_not_hide_later_invalid_metadata() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cancel = CancellationToken::new();
    for (name, count) in [
        ("first", 1024),
        ("second", 1024),
        ("third", 1024),
        ("fourth", 1024),
        ("invalid", 1),
    ] {
        disk::publish(
            &home,
            name,
            "v1",
            MAX_COMPRESSED_BYTES,
            Some(&fixture_files(count, 0, false)),
            &cancel,
        )
        .unwrap();
    }
    let index_path = disk::paths(&home, "invalid", "v1").0.join("index.json");
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    index["files"][0]["mode"] = serde_json::json!(0o1000);
    fs::write(index_path, serde_json::to_vec(&index).unwrap()).unwrap();

    let cache = DecodedCache::new(home);
    let keys = ["first", "second", "third", "fourth", "invalid"];
    let error = cache
        .get_ready_batch(&keys.map(|name| Some((name, "v1"))))
        .await
        .expect_err("invalid metadata must not be skipped when the file budget is full");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    cache.shutdown().await;
}

#[tokio::test]
async fn retained_large_hits_exhaust_optional_budget_without_leaking_permits() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let cancel = CancellationToken::new();
    let files = fixture_files(16, storage_files::MAX_FILE_BYTES, false);
    disk::publish(
        &home,
        "large",
        "v1",
        MAX_COMPRESSED_BYTES,
        Some(&files),
        &cancel,
    )
    .unwrap();
    disk::publish(
        &home,
        "tiny",
        "v1",
        1024,
        Some(&fixture_files(1, 64, false)),
        &cancel,
    )
    .unwrap();
    let cache = DecodedCache::new(home);
    let mut held = Vec::new();
    for _ in 0..=CAPACITY / storage_files::MAX_STORAGE_BYTES {
        let Some(ready) = cache.get_ready("large", "v1").await.unwrap() else {
            break;
        };
        assert_eq!(ready.files, files);
        held.push(ready);
    }
    assert!(!held.is_empty());
    assert!(cache.0.memory.available_permits() < FILL_RESERVATION as usize);
    assert!(cache.get_ready("large", "v1").await.unwrap().is_none());
    // Uniform reservation deliberately makes even a valid tiny entry optional
    // under pressure; budget exhaustion must not corrupt it or queue work.
    assert!(cache.get_ready("tiny", "v1").await.unwrap().is_none());
    drop(held);
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    let ready = cache.get_ready("large", "v1").await.unwrap().unwrap();
    assert_eq!(ready.files, files);
    drop(ready);
    let tiny = cache.get_ready("tiny", "v1").await.unwrap().unwrap();
    assert_eq!(tiny.files[0].content.len(), 64);
    drop(tiny);
    cache.shutdown().await;
    assert_eq!(cache.0.memory.available_permits(), CAPACITY);
}

#[tokio::test]
async fn compressed_source_limit_refuses_fill_without_creating_a_positive_entry() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let source = home.storage_cache_dir("large", "v1");
    fs::create_dir_all(&source).unwrap();
    fs::File::create(source.join("archive.tar.gz"))
        .unwrap()
        .set_len(MAX_ADMITTED_COMPRESSED_BYTES as u64 + 1)
        .unwrap();
    drop(
        runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock("large", "v1")).unwrap(),
    );
    let cache = DecodedCache::new(home);
    cache.warm_from_archive("large", "v1").await.unwrap();
    assert!(cache.get_ready("large", "v1").await.unwrap().is_none());
    cache.shutdown().await;
}
