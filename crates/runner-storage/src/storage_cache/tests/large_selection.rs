use super::*;
use guest_contracts::storage_files::StorageFile;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom, Write};

fn later_files(count: usize, bytes: usize) -> Vec<StorageFile> {
    (0..count)
        .map(|index| StorageFile {
            path: format!("file-{index}"),
            mode: 0o640,
            mtime: 1,
            content: vec![b'x'; bytes],
        })
        .collect()
}

fn seed_packed_writer(home: &HomePaths, name: &str, count: usize, bytes: usize) {
    let files = later_files(count, bytes);
    seed_packed_files(home, name, &files, flate2::Compression::none());
}

fn seed_packed_files(
    home: &HomePaths,
    name: &str,
    files: &[StorageFile],
    compression: flate2::Compression,
) {
    let entry = home
        .storages_dir()
        .join(short_digest(name))
        .join(format!("decoded-v2-{}", short_digest("v1")));
    std::fs::create_dir_all(&entry).unwrap();
    let mut payload = std::fs::File::create(entry.join("data.bin")).unwrap();
    let encoder = flate2::write::GzEncoder::new(Vec::new(), compression);
    let mut tar = tar::Builder::new(encoder);
    for file in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(file.content.len() as u64);
        header.set_mode(file.mode);
        header.set_mtime(file.mtime);
        header.set_cksum();
        tar.append_data(&mut header, &file.path, &file.content[..])
            .unwrap();
        payload.write_all(&file.content).unwrap();
    }
    let archive = tar.into_inner().unwrap().finish().unwrap();
    assert!(archive.len() <= 4 * 1024 * 1024);
    let index = serde_json::to_vec(&serde_json::json!({
        "name": name, "version": "v1", "compressed_bytes": archive.len(),
        "files": files.iter().map(|file| serde_json::json!({
            "path": file.path, "mode": file.mode, "mtime": file.mtime,
            "size": file.content.len(), "sha256": hex::encode(Sha256::digest(&file.content))
        })).collect::<Vec<_>>()
    }))
    .unwrap();
    std::fs::write(entry.join("index.json"), index).unwrap();
    write_cached_archive(home, name, "v1", &archive);
    write_storage_lock(home, name, "v1");
}

#[tokio::test]
async fn admitted_packed_entries_are_selected_for_delivery() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let cache = decoded::DecodedCache::new(home.clone());
    let mut content = later_files(17, 256 * 1024);
    for (index, file) in content.iter_mut().enumerate() {
        let mut state = index as u64 + 1;
        for byte in &mut file.content[..64 * 1024] {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = state as u8;
        }
    }
    let mut paths = later_files(768, 1);
    for (index, file) in paths.iter_mut().enumerate() {
        file.path = format!("{index:04}-{}", "a".repeat(170));
    }
    let mut index_files = later_files(512, 1);
    for (index, file) in index_files.iter_mut().enumerate() {
        file.path = format!("{index:04}{}", "\"".repeat(250));
    }
    let uncompressed = flate2::Compression::none();
    for (name, files, compression) in [
        ("retained", later_files(1024, 1), uncompressed),
        ("expanded-count", later_files(1025, 1), uncompressed),
        ("expanded-content", content, flate2::Compression::fast()),
        ("expanded-gzip", later_files(16, 128 * 1024), uncompressed),
        ("expanded-paths", paths, uncompressed),
        ("expanded-index", index_files, uncompressed),
    ] {
        seed_packed_files(&home, name, &files, compression);
        let ready = cache.get_ready(name, "v1").await.unwrap().unwrap();
        assert_eq!(ready.files, files);
        drop(ready);
        for fresh in [false, true] {
            let mut plan = plan_from_entries(
                vec![storage_entry(
                    "/mnt/storage".into(),
                    "https://storage.example/retained".into(),
                    name,
                    "v1",
                )],
                vec![artifact_entry(
                    "/mnt/artifact".into(),
                    "https://storage.example/retained".into(),
                    name,
                    "v1",
                )],
                None,
            );
            let mut telemetry = new_telemetry();
            let mut delivery = if fresh {
                Some(
                    prepare_fresh_archive_delivery(
                        &mut plan,
                        &home,
                        &FreshArchiveDeliveryAdmission::new(),
                        &CancellationToken::new(),
                        &mut telemetry,
                        Some(&cache),
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &MockSandbox::new("prepared-reader"),
                &home,
                &mut telemetry,
                delivery.as_mut(),
                Some(&cache),
            )
            .await
            .unwrap();
            assert_eq!(plan.decoded_mount_count(), 2);
            for (_, ready) in plan.take_decoded() {
                assert_eq!(ready.files, files);
            }
            drop(deferred);
        }
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn alias_group_retains_archive_delivery_when_decoded_files_do_not_fit() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let files = later_files(decoded::MAX_ADMITTED_FILES, 1);
    seed_packed_files(&home, "name", &files, flate2::Compression::fast());
    let cache = decoded::DecodedCache::new(home.clone());
    let ready = cache.get_ready("name", "v1").await.unwrap().unwrap();
    let fitting_groups = guest_contracts::storage_files::MAX_TOTAL_FILES / files.len();
    for count in [fitting_groups, fitting_groups + 1] {
        let entries = (0..count)
            .map(|index| {
                storage_entry(
                    format!("/mount-{index}"),
                    "https://storage.example/retained".into(),
                    "name",
                    "v1",
                )
            })
            .collect();
        let mut plan = plan_from_entries(entries, Vec::new(), None);
        let group = CacheTargetGroup {
            representative: CacheTarget {
                handle: ArchiveHandle::storage(0),
                name: "name".into(),
                version: "v1".into(),
                archive_url: "https://storage.example/retained".into(),
                archive_size: None,
            },
            additional_targets: (1..count)
                .map(|index| CacheTarget {
                    handle: ArchiveHandle::storage(index),
                    name: "name".into(),
                    version: "v1".into(),
                    archive_url: "https://storage.example/retained".into(),
                    archive_size: None,
                })
                .collect(),
            archive_size: None,
            decoded_ready_observed: true,
        };
        assert_eq!(
            reuse_decoded(&mut plan, &group, Some(Arc::clone(&ready))).unwrap(),
            count == fitting_groups
        );
        if count == fitting_groups {
            assert_eq!(
                plan.decoded_file_count(),
                guest_contracts::storage_files::MAX_TOTAL_FILES
            );
            assert_eq!(plan.decoded_mount_count(), count);
        } else {
            assert_eq!(plan.decoded_mount_count(), 0);
            for index in 0..count {
                assert_eq!(
                    storage_archive_url(&plan, index),
                    Some("https://storage.example/retained")
                );
            }
        }
    }
    drop(ready);
    cache.shutdown().await;
}

#[tokio::test]
async fn preparation_selects_valid_packed_entries_within_the_active_policy() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let cache = decoded::DecodedCache::new(home.clone());
    for (name, count, bytes) in [
        ("small", 32, 64),
        ("count", 33, 64),
        ("small-content", 3, 256 * 1024),
        ("gzip-overflow", 4, 256 * 1024),
        ("larger-content", 5, 256 * 1024),
    ] {
        seed_packed_writer(&home, name, count, bytes);
        for fresh in [false, true] {
            let mut plan = plan_from_entries(
                vec![storage_entry(
                    "/mnt/storage".into(),
                    "https://storage.example/retained".into(),
                    name,
                    "v1",
                )],
                vec![artifact_entry(
                    "/mnt/artifact".into(),
                    "https://storage.example/retained".into(),
                    name,
                    "v1",
                )],
                None,
            );
            let mut telemetry = new_telemetry();
            let mut delivery = if fresh {
                Some(
                    prepare_fresh_archive_delivery(
                        &mut plan,
                        &home,
                        &FreshArchiveDeliveryAdmission::new(),
                        &CancellationToken::new(),
                        &mut telemetry,
                        Some(&cache),
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let deferred = populate_cache_with_fresh_delivery(
                &mut plan,
                &MockSandbox::new("reader-policy"),
                &home,
                &mut telemetry,
                delivery.as_mut(),
                Some(&cache),
            )
            .await
            .unwrap();
            assert_eq!(plan.decoded_mount_count(), 2);
            for (_, files) in plan.take_decoded() {
                assert_eq!(files.files.len(), count);
                assert!(files.files.iter().all(|file| file.content.len() == bytes
                    && file.content.iter().all(|byte| *byte == b'x')));
            }
            drop(deferred);
        }
    }
    cache.shutdown().await;
}

#[tokio::test]
async fn positive_corruption_is_not_replaced_by_archive_delivery() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let count = decoded::MAX_ADMITTED_FILES / 2;
    seed_packed_writer(&home, "corrupt", count, 64);
    let file = home
        .storages_dir()
        .join(short_digest("corrupt"))
        .join(format!("decoded-v2-{}", short_digest("v1")))
        .join("data.bin");
    let mut payload = std::fs::OpenOptions::new().write(true).open(file).unwrap();
    payload.seek(SeekFrom::End(-64)).unwrap();
    payload.write_all(&[b'z'; 64]).unwrap();
    let cache = decoded::DecodedCache::new(home.clone());
    let mut plan = plan_from_entries(
        vec![storage_entry(
            "/mnt/storage".into(),
            "https://storage.example/retained".into(),
            "corrupt",
            "v1",
        )],
        Vec::new(),
        None,
    );
    let result = populate_cache_with_fresh_delivery(
        &mut plan,
        &MockSandbox::new("corrupt-reader-policy"),
        &home,
        &mut new_telemetry(),
        None,
        Some(&cache),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(plan.decoded_mount_count(), 0);
    assert_eq!(
        storage_archive_url(&plan, 0),
        Some("https://storage.example/retained")
    );
    cache.shutdown().await;
}
