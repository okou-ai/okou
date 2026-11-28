use super::super::*;
use super::support::*;

#[tokio::test]
async fn metadata_tolerates_legacy_history_proof_on_read_and_omits_it_on_write() {
    let f = Fixture::new().await;
    let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
    let mut value = serde_json::to_value(&metadata).unwrap();
    assert!(
        value.get("historyProof").is_none(),
        "new metadata must not emit historyProof"
    );
    value["historyProof"] = serde_json::json!({
        "proof": {"formatVersion": 1},
        "sha256": "a".repeat(64)
    });
    std::fs::write(
        f.cache.entry_paths(&f.key("thread")).metadata(),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let lease = f.lease("thread").await;
    assert!(lease.is_cache_hit());
}

#[tokio::test]
async fn malformed_layout_rootfs_scope_state_shape_and_image_identity_are_not_hits() {
    for field in [
        "formatVersion",
        "driveLayout",
        "rootfsHash",
        "fingerprintScope",
        "logicalImageSizeBytes",
        "state",
        "imageGeneration",
        "currentImage",
    ] {
        let f = Fixture::new().await;
        let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
        let mut value = serde_json::to_value(metadata).unwrap();
        value[field] = match field {
            "formatVersion" => serde_json::json!(2),
            "logicalImageSizeBytes" => serde_json::json!(SIZE * 2),
            "state" => serde_json::json!("dirty"),
            "currentImage" => {
                serde_json::json!({"dev":0,"ino":0,"len":SIZE,"modifiedSeconds":0,"modifiedNanoseconds":0})
            }
            "imageGeneration" => serde_json::json!("../../escape"),
            "rootfsHash" => serde_json::json!(""),
            _ => serde_json::json!("wrong"),
        };
        std::fs::write(
            f.cache.entry_paths(&f.key("thread")).metadata(),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let lease = f.lease("thread").await;
        assert!(!lease.is_cache_hit(), "{field}");
    }
}

#[tokio::test]
async fn symlink_hardlink_and_same_size_image_replacements_fail_identity() {
    for mode in ["symlink", "hardlink", "replacement"] {
        let f = Fixture::new().await;
        let metadata = f.commit("thread", b"home", "2026-10-09T09:00:00Z").await;
        let image = f.image("thread", &metadata);
        let held = f.dir.path().join("held.ext4");
        match mode {
            "symlink" => {
                std::fs::rename(&image, &held).unwrap();
                std::os::unix::fs::symlink(&held, &image).unwrap();
            }
            "hardlink" => {
                std::fs::hard_link(&image, &held).unwrap();
            }
            _ => {
                std::fs::rename(&image, &held).unwrap();
                write_image(&image, b"other", SIZE);
            }
        }
        assert!(!f.lease("thread").await.is_cache_hit());
        assert!(held.exists());
        assert_eq!(&std::fs::read(&held).unwrap()[4096..4100], b"home");
    }
}

#[test]
fn generation_paths_accept_only_canonical_uuid_and_never_traverse() {
    let paths = CacheEntryPaths::new(std::path::Path::new("/cache"), &"a".repeat(64));
    for generation in [
        "../escape",
        "/absolute",
        "",
        "x",
        "00000000-0000-0000-0000-000000000000/child",
    ] {
        assert!(paths.image(generation).is_none());
    }
    let generation = uuid::Uuid::new_v4().to_string();
    let image = paths.image(&generation).unwrap();
    assert_eq!(image.parent(), Some(paths.entry_dir()));
    assert_eq!(
        image.file_name().unwrap(),
        format!("image-{generation}.ext4").as_str()
    );
}
