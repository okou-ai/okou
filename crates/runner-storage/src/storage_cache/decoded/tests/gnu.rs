use super::large::{archive_files, fixture_files};
use super::*;

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

#[tokio::test]
async fn longname_admission_matches_guest_header_recognition() {
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    for (kind, mut longname, admitted, expected_path) in [
        ("old", tar::Header::new_old(), false, "short"),
        ("gnu", tar::Header::new_gnu(), true, "renamed"),
        ("ustar", tar::Header::new_ustar(), true, "renamed"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(root.path().join("host"));
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        longname.set_path("././@LongLink").unwrap();
        longname.set_entry_type(tar::EntryType::GNULongName);
        longname.set_size(8);
        longname.set_mode(0o640);
        longname.set_cksum();
        builder.append(&longname, &b"renamed\0"[..]).unwrap();
        let mut regular = tar::Header::new_gnu();
        regular.set_entry_type(tar::EntryType::Regular);
        regular.set_size(1);
        regular.set_mode(0o640);
        regular.set_mtime(7);
        regular.set_cksum();
        builder
            .append_data(&mut regular, "short", &b"x"[..])
            .unwrap();
        let gzip = builder.into_inner().unwrap().finish().unwrap();
        let source = home.storage_cache_dir(kind, "v1");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("archive.tar.gz"), &gzip).unwrap();
        drop(
            runner_host::lock::try_acquire_or_busy_blocking(&home.storage_lock(kind, "v1"))
                .unwrap(),
        );

        // Guest's real archive entry point only applies extension names from
        // recognized GNU/USTAR headers, not a V7 header with the same typeflag.
        let ordinary_target = root.path().join("ordinary");
        let ordinary_manifest = serde_json::to_vec(&serde_json::json!({
            "storageMounts": [{
                "mountPath": ordinary_target,
                "archiveUrl": format!("file://{}", source.join("archive.tar.gz").display())
            }]
        }))
        .unwrap();
        assert!(guest_storage_apply::run_manifest_bytes(&ordinary_manifest));
        assert_eq!(fs::read(ordinary_target.join(expected_path)).unwrap(), b"x");
        assert!(
            !ordinary_target
                .join(if admitted { "short" } else { "renamed" })
                .exists()
        );

        let cache = DecodedCache::new(home);
        cache.warm_from_archive(kind, "v1").await.unwrap();
        let ready = cache.get_ready(kind, "v1").await.unwrap();
        assert_eq!(ready.is_some(), admitted, "{kind}");
        if let Some(ready) = ready {
            let decoded_target = root.path().join("decoded");
            let manifest = serde_json::to_vec(&serde_json::json!({
                "storageMounts": [{"mountPath": decoded_target, "archiveUrl": "file:///must-not-be-opened"}]
            }))
            .unwrap();
            let input = storage_files::encode_input(
                &manifest,
                &[(decoded_target.to_str().unwrap(), &ready.files)],
            )
            .unwrap();
            assert!(guest_storage_apply::run_storage_files_bytes(&input));
            assert_eq!(fs::read(decoded_target.join(expected_path)).unwrap(), b"x");
            assert!(!decoded_target.join("short").exists());
            for target in [ordinary_target, decoded_target] {
                let metadata = fs::metadata(target.join(expected_path)).unwrap();
                assert_eq!(metadata.mode() & 0o777, 0o640);
                assert_eq!(metadata.mtime(), 7);
            }
        }
        cache.shutdown().await;
        assert_eq!(cache.0.memory.available_permits(), CAPACITY);
    }
}

#[tokio::test]
async fn activated_memory_shaped_archive_survives_restart_and_full_guest_delivery() {
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().join("host"));
    let files = fixture_files(768, 3400, true);
    let gzip = archive_files(&files);
    assert!(gzip.len() > 1024 * 1024);
    assert!(gzip.len() <= MAX_ADMITTED_COMPRESSED_BYTES);
    assert!(files.iter().map(|f| f.content.len()).sum::<usize>() > 2 * 1024 * 1024);
    let source = home.storage_cache_dir("produced-memory", "v1");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("archive.tar.gz"), &gzip).unwrap();
    drop(
        runner_host::lock::try_acquire_or_busy_blocking(
            &home.storage_lock("produced-memory", "v1"),
        )
        .unwrap(),
    );
    let cache = DecodedCache::new(home.clone());
    cache
        .warm_from_archive("produced-memory", "v1")
        .await
        .unwrap();
    cache.shutdown().await;
    fs::remove_file(source.join("archive.tar.gz")).unwrap();
    let restarted = DecodedCache::new(home);
    let ready = restarted
        .get_ready("produced-memory", "v1")
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
