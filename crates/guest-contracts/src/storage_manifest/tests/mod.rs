use serde_json::json;

use super::{ArtifactEntry, InstructionCleanupEntry, Manifest, StorageEntry};

#[test]
fn canonical_manifest_preserves_wire_shape() {
    let manifest = Manifest {
        storages: vec![StorageEntry {
            mount_path: "/home/user/.codex".into(),
            archive_url: Some("https://example.com/storage.tar.gz".into()),
            cached: false,
            vas_storage_name: Some("instructions".into()),
            vas_version_id: Some("storage-v1".into()),
        }],
        artifacts: vec![ArtifactEntry {
            mount_path: "/workspace".into(),
            archive_url: None,
            empty: true,
            cached: true,
            vas_storage_name: Some("artifact".into()),
            vas_storage_id: Some("artifact-id".into()),
            vas_version_id: Some("artifact-v1".into()),
            missing_root_policy: Some("preserveParentVersion".into()),
        }],
        cleanup_paths: vec!["/data".into()],
        instruction_cleanups: vec![InstructionCleanupEntry {
            mount_path: "/home/user/.codex".into(),
            target_filename: Some("AGENTS.md".into()),
        }],
    };

    assert_eq!(
        serde_json::to_value(manifest).unwrap(),
        json!({
            "storageMounts": [
                {
                    "name": "instructions",
                    "versionId": "storage-v1",
                    "mountPath": "/home/user/.codex",
                    "archiveUrl": "https://example.com/storage.tar.gz",
                    "cached": false,
                    "writeback": false
                },
                {
                    "name": "artifact",
                    "storageId": "artifact-id",
                    "versionId": "artifact-v1",
                    "mountPath": "/workspace",
                    "cached": true,
                    "empty": true,
                    "missingRootPolicy": "preserveParentVersion",
                    "writeback": true
                }
            ],
            "cleanupPaths": ["/data"],
            "instructionCleanups": [{
                "mountPath": "/home/user/.codex",
                "targetFilename": "AGENTS.md"
            }]
        })
    );
}

#[test]
fn canonical_manifest_deserializes_to_execution_projection() {
    let manifest: Manifest = serde_json::from_value(json!({
        "storageMounts": [
            {
                "name": "instructions",
                "versionId": "storage-v1",
                "mountPath": "/home/user/.codex",
                "archiveUrl": "https://example.com/storage.tar.gz",
                "cached": false,
                "writeback": false,
                "futureMountField": true
            },
            {
                "name": "memory",
                "storageId": "memory-id",
                "versionId": "memory-v1",
                "mountPath": "/memory",
                "empty": true,
                "cached": true,
                "writeback": true
            }
        ],
        "cleanupPaths": ["/stale"],
        "futureManifestField": true
    }))
    .unwrap();

    assert_eq!(manifest.storages.len(), 1);
    assert_eq!(
        manifest.storages[0].vas_storage_name.as_deref(),
        Some("instructions")
    );
    assert_eq!(manifest.artifacts.len(), 1);
    assert_eq!(
        manifest.artifacts[0].vas_storage_id.as_deref(),
        Some("memory-id")
    );
    assert!(manifest.artifacts[0].empty);
    assert_eq!(manifest.cleanup_paths, ["/stale"]);
}

#[test]
fn manifest_rejects_fields_for_wrong_mount_category() {
    for (name, invalid_mount, expected_error, valid_mount) in [
        (
            "read-only empty",
            json!({
                "mountPath": "/data",
                "empty": true
            }),
            "read-only storage mount cannot be empty",
            json!({
                "mountPath": "/workspace",
                "empty": true,
                "writeback": true
            }),
        ),
        (
            "read-only missingRootPolicy",
            json!({
                "mountPath": "/data",
                "missingRootPolicy": "preserveParentVersion"
            }),
            "read-only storage mount cannot contain missingRootPolicy",
            json!({
                "mountPath": "/workspace",
                "missingRootPolicy": "preserveParentVersion",
                "writeback": true
            }),
        ),
    ] {
        let result = serde_json::from_value::<Manifest>(json!({
            "storageMounts": [invalid_mount]
        }));
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains(expected_error),
            "{name}: expected {expected_error:?} in {error:?}"
        );

        let result = serde_json::from_value::<Manifest>(json!({
            "storageMounts": [valid_mount]
        }));
        assert!(result.is_ok(), "{name}: valid control failed: {result:?}");
    }
}

#[test]
fn manifest_rejects_legacy_representations() {
    for value in [
        json!({ "storages": [], "artifacts": [] }),
        json!({ "storages": [] }),
        json!({ "artifacts": [] }),
        json!({}),
    ] {
        assert!(serde_json::from_value::<Manifest>(value).is_err());
    }
}

#[test]
fn manifest_rejects_duplicate_storage_mount_paths() {
    let result = serde_json::from_value::<Manifest>(json!({
        "storageMounts": [
            {
                "mountPath": "/workspace"
            },
            {
                "mountPath": "/workspace",
                "writeback": true
            }
        ]
    }));

    let error = result.unwrap_err().to_string();
    assert!(error.contains("duplicate mountPath \"/workspace\""));
}
