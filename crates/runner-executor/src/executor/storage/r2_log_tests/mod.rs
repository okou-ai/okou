use super::*;

#[test]
fn storage_sources_keep_original_readonly_and_memory_identity_without_urls() {
    let url = "https://example-bucket.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/prefix/archive.tar.gz?X-Amz-Signature=signature-secret";
    let manifest = serde_json::from_value(serde_json::json!({
            "storageMounts": [
                { "name": "skill", "storageId": "skill-id", "versionId": "skill-version", "mountPath": "/skills", "archiveUrl": url },
                { "name": "memory", "storageId": "memory-id", "versionId": "memory-version", "mountPath": "/memory", "archiveUrl": url, "writeback": true },
                { "name": "empty", "storageId": "empty-id", "versionId": "empty-version", "mountPath": "/empty", "writeback": true, "empty": true },
                { "name": "local", "storageId": "local-id", "versionId": "local-version", "mountPath": "/local", "archiveUrl": "file:///cache/hash/archive.tar.gz" }
            ]
        })).unwrap();
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
