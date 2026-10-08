use super::*;
use std::fs;
use std::os::unix::fs::MetadataExt;

fn fixture_files(count: usize, bytes: usize, long_paths: bool) -> Vec<StorageFile> {
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

fn archive_files(files: &[StorageFile]) -> Vec<u8> {
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
async fn memory_shaped_gnu_archive_survives_restart_and_full_guest_delivery() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().join("host"));
    let files = fixture_files(768, 3400, true);
    let gzip = archive_files(&files);
    assert!(gzip.len() > 1024 * 1024);
    assert!(gzip.len() <= MAX_COMPRESSED_BYTES);
    assert!(files.iter().map(|f| f.content.len()).sum::<usize>() > 2 * 1024 * 1024);
    let source = home.storage_cache_dir("memory-fixture", "v1");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("archive.tar.gz"), &gzip).unwrap();
    drop(
        runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock("memory-fixture", "v1"))
            .unwrap(),
    );
    let cache = DecodedCache::new(home.clone());
    cache
        .warm_from_archive("memory-fixture", "v1")
        .await
        .unwrap();
    cache.shutdown().await;
    fs::remove_file(source.join("archive.tar.gz")).unwrap();

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
    let files = fixture_files(storage_files::MAX_FILES, 64, false);
    assert_eq!(
        decode(&archive_files(&files), &cancel).unwrap().unwrap(),
        files
    );
    let too_many = fixture_files(storage_files::MAX_FILES + 1, 64, false);
    assert!(
        decode(&archive_files(&too_many), &cancel)
            .unwrap()
            .is_none()
    );

    let mut files = fixture_files(16, storage_files::MAX_FILE_BYTES, false);
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

fn extension_archive(records: &[(tar::EntryType, Vec<u8>)], regular: bool) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut builder = tar::Builder::new(encoder);
    for (kind, bytes) in records {
        let mut header = tar::Header::new_gnu();
        header.set_path("././@LongLink").unwrap();
        header.set_entry_type(*kind);
        header.set_size(bytes.len() as u64);
        header.set_mode(0o640);
        header.set_cksum();
        builder.append(&header, &bytes[..]).unwrap();
    }
    if regular {
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o640);
        header.set_cksum();
        builder
            .append_data(&mut header, "short", &b"x"[..])
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn gnu_longnames_are_bounded_and_do_not_admit_other_extensions() {
    let cancel = CancellationToken::new();
    for name in [
        vec![0],
        b"unterminated".to_vec(),
        b"a\0b\0".to_vec(),
        vec![0xff, 0],
        vec![b'a'; storage_files::MAX_PATH_BYTES + 2],
        b"../outside\0".to_vec(),
        b"/absolute\0".to_vec(),
    ] {
        let gzip = extension_archive(&[(tar::EntryType::GNULongName, name)], true);
        assert!(decode(&gzip, &cancel).unwrap().is_none());
    }
    let longname = (tar::EntryType::GNULongName, b"name\0".to_vec());
    assert!(
        decode(
            &extension_archive(std::slice::from_ref(&longname), false),
            &cancel
        )
        .unwrap()
        .is_none()
    );
    assert!(
        decode(
            &extension_archive(&[longname.clone(), longname], true),
            &cancel
        )
        .unwrap()
        .is_none()
    );
    for kind in [
        tar::EntryType::GNULongLink,
        tar::EntryType::XHeader,
        tar::EntryType::Directory,
    ] {
        assert!(
            decode(
                &extension_archive(&[(kind, b"name\0".to_vec())], true),
                &cancel
            )
            .unwrap()
            .is_none()
        );
    }
    let exact_path = std::iter::repeat_n("a".repeat(240), 17)
        .collect::<Vec<_>>()
        .join("/");
    assert_eq!(exact_path.len(), storage_files::MAX_PATH_BYTES);
    let mut name = exact_path.as_bytes().to_vec();
    name.push(0);
    let valid = extension_archive(&[(tar::EntryType::GNULongName, name)], true);
    assert_eq!(
        decode(&valid, &cancel).unwrap().unwrap()[0].path,
        exact_path
    );
    let duplicate = [
        (tar::EntryType::GNULongName, b"same\0".to_vec()),
        (tar::EntryType::Regular, b"a".to_vec()),
        (tar::EntryType::GNULongName, b"same\0".to_vec()),
        (tar::EntryType::Regular, b"b".to_vec()),
    ];
    assert!(
        decode(&extension_archive(&duplicate, false), &cancel)
            .unwrap()
            .is_none()
    );

    let mut many_paths = fixture_files(storage_files::MAX_FILES, 64, true);
    for file in &mut many_paths {
        file.path = file.path.replace(&"a".repeat(110), &"a".repeat(112));
    }
    assert!(
        many_paths.iter().map(|f| f.path.len()).sum::<usize>()
            > storage_files::MAX_TOTAL_PATH_BYTES
    );
    assert!(
        decode(&archive_files(&many_paths), &cancel)
            .unwrap()
            .is_none()
    );

    let files = fixture_files(48, 256, true);
    let gzip = archive_files(&files);
    for offset in [gzip.len() - 8, gzip.len() - 4] {
        let mut corrupt = gzip.clone();
        corrupt[offset] ^= 1;
        assert!(decode(&corrupt, &cancel).is_err());
    }
    assert!(decode(&gzip[..gzip.len() - 4], &cancel).is_err());
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
async fn compressed_source_limit_refuses_fill_without_creating_a_positive_entry() {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    let source = home.storage_cache_dir("large", "v1");
    fs::create_dir_all(&source).unwrap();
    fs::File::create(source.join("archive.tar.gz"))
        .unwrap()
        .set_len(MAX_COMPRESSED_BYTES as u64 + 1)
        .unwrap();
    drop(
        runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock("large", "v1")).unwrap(),
    );
    let cache = DecodedCache::new(home);
    cache.warm_from_archive("large", "v1").await.unwrap();
    assert!(cache.get_ready("large", "v1").await.unwrap().is_none());
    cache.shutdown().await;
}
