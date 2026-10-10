use super::super::*;
use super::support::*;
use crate::storage_fingerprints::StorageFingerprints;

#[tokio::test]
async fn committed_proof_binds_generation_digest_and_lease_candidate() {
    let f = Fixture::new().await;
    let mut context = f
        .context(
            "thread",
            b"home-history",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    let proof = binding(&context.publication_generation());
    context.set_home_history_proof(Some(proof.clone())).unwrap();
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(context);
    let metadata = f.metadata("thread").await;
    assert_eq!(metadata.history_proof.as_ref(), Some(&proof));
    assert_eq!(metadata.image_generation, proof.proof.generation);
    let mut lease = f.lease("thread").await;
    assert_eq!(lease.history_proof_binding(), Some(&proof));
    // Candidate alone never calls the verifier and does not authorize a skip.
    lease.discard_cached_image();
    assert!(lease.history_proof_binding().is_none());
    assert!(lease.previous_storage().is_none());
    assert!(lease.source_image.is_none());
}

#[tokio::test]
async fn wrong_proof_generation_or_digest_clears_previous_candidate() {
    let f = Fixture::new().await;
    let mut context = f
        .context(
            "thread",
            b"home",
            "2026-10-09T09:00:00Z",
            HomeCacheTerminalStatus::Success,
            StorageFingerprints::default(),
        )
        .await;
    context
        .set_home_history_proof(Some(binding(&context.publication_generation())))
        .unwrap();
    for mut proof in [
        binding(&runner_types::ids::RunId::new_v4().to_string()),
        binding(&context.publication_generation()),
    ] {
        if proof.proof.generation == context.publication_generation() {
            proof.sha256 = "c".repeat(64);
        }
        assert!(context.set_home_history_proof(Some(proof)).is_err());
    }
    assert_eq!(
        context.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(context);
    assert!(f.metadata("thread").await.history_proof.is_none());
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
            _ => serde_json::json!("wrong"),
        };
        std::fs::write(
            f.cache.entry_paths(&f.key("thread")).metadata(),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let lease = f.lease("thread").await;
        assert!(!lease.is_cache_hit(), "{field}");
        assert!(lease.history_proof_binding().is_none());
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
