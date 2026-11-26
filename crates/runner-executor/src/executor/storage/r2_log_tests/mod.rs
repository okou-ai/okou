use super::*;
use runner_types::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

#[test]
fn storage_sources_keep_original_readonly_and_memory_identity_without_urls() {
    let url = "https://example-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/prefix/archive.tar.gz?X-Amz-Signature=signature-secret";
    let manifest = StorageManifest {
        storages: vec![
            StorageEntry {
                template_guidance: None,
                name: "skill".into(),
                mount_path: "/skills".into(),
                vas_storage_name: "skill".into(),
                vas_version_id: "skill-version".into(),
                archive_url: url.into(),
                archive_size: None,
            },
            StorageEntry {
                template_guidance: None,
                name: "local".into(),
                mount_path: "/local".into(),
                vas_storage_name: "local".into(),
                vas_version_id: "local-version".into(),
                archive_url: "file:///cache/hash/archive.tar.gz".into(),
                archive_size: None,
            },
        ],
        artifacts: vec![
            ArtifactEntry {
                mount_path: "/memory".into(),
                vas_storage_name: "memory".into(),
                vas_storage_id: "memory-id".into(),
                vas_version_id: "memory-version".into(),
                archive_url: Some(url.into()),
                archive_size: None,
                empty: None,
                missing_root_policy: None,
            },
            ArtifactEntry {
                mount_path: "/empty".into(),
                vas_storage_name: "empty".into(),
                vas_storage_id: "empty-id".into(),
                vas_version_id: "empty-version".into(),
                archive_url: None,
                archive_size: None,
                empty: Some(true),
                missing_root_policy: None,
            },
        ],
    };
    let sources = r2_storage_sources(Some(&manifest));
    assert_eq!(
        sources,
        serde_json::json!([
            { "name": "skill", "version_id": "skill-version", "mount_path": "/skills", "r2_key": "prefix/archive.tar.gz" },
            { "name": "memory", "version_id": "memory-version", "mount_path": "/memory", "r2_key": "prefix/archive.tar.gz" }
        ])
    );
    assert!(!sources.to_string().contains("X-Amz"));
    assert!(!sources.to_string().contains("signature-secret"));
    assert_eq!(r2_storage_sources(None), serde_json::json!([]));
}
