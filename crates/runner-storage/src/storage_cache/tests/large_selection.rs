use super::*;

#[tokio::test]
async fn alias_group_retains_archive_delivery_if_whole_input_file_count_does_not_fit() {
    let root = tempfile::tempdir().unwrap();
    let home = home_at(&root);
    let cache = decoded::DecodedCache::new(home.clone());
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    for index in 0..guest_contracts::storage_files::MAX_FILES {
        let mut header = tar::Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o640);
        header.set_cksum();
        tar.append_data(&mut header, format!("file-{index}"), &b"x"[..])
            .unwrap();
    }
    let archive = tar.into_inner().unwrap().finish().unwrap();
    write_cached_archive(&home, "name", "v1", &archive);
    write_storage_lock(&home, "name", "v1");
    cache.warm_from_archive("name", "v1").await.unwrap();
    let ready = cache.get_ready("name", "v1").await.unwrap().unwrap();
    for count in [32, 33] {
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
            targets: (0..count)
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
            count == 32
        );
        if count == 32 {
            assert_eq!(
                plan.decoded_file_count(),
                guest_contracts::storage_files::MAX_TOTAL_FILES
            );
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
