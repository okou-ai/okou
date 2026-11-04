use super::*;
use std::fs;

#[test]
fn is_valid_url_none() {
    assert!(!is_valid_url(&None));
}

#[test]
fn is_valid_url_null_string() {
    assert!(!is_valid_url(&Some("null".to_string())));
}

#[test]
fn is_valid_url_valid() {
    assert!(is_valid_url(&Some(
        "https://example.com/archive.tar.gz".to_string()
    )));
}

#[test]
fn is_valid_url_file_scheme() {
    assert!(is_valid_url(&Some(
        "file:///tmp/vm0-storage-cache/abc.tar.gz".to_string()
    )));
}

#[test]
fn manifest_entries_yield_storage_and_artifact_tasks() {
    let json = r#"{
            "storageMounts": [
                {
                    "mountPath": "/data",
                    "archiveUrl": "https://s3/storage.tar.gz",
                    "name": "data",
                    "versionId": "storage-v1"
                },
                {
                    "mountPath": "/workspace/a",
                    "archiveUrl": "https://s3/a.tar.gz",
                    "name": "workspace-a",
                    "versionId": "artifact-v1",
                    "missingRootPolicy": "preserveParentVersion",
                    "writeback": true
                },
                {
                    "mountPath": "/workspace/b",
                    "archiveUrl": "file:///tmp/vm0-storage-cache/b.tar.gz",
                    "name": "workspace-b",
                    "versionId": "artifact-v2",
                    "writeback": true
                }
            ]
        }"#;
    let manifest: Manifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.storages.len(), 1);
    assert_eq!(manifest.artifacts.len(), 2);

    let plan = RunPlan::from_manifest(&manifest);

    assert_eq!(plan.download_tasks.len(), 3);
    assert_eq!(
            plan.download_tasks[0],
            DownloadTask::storage(
                "storage 1 mountPath=/data vasStorageName=data vasVersionId=storage-v1 urlScheme=https cached=false".into(),
                "https://s3/storage.tar.gz".into(),
                "/data".into(),
                false,
            )
        );
    assert_eq!(
            plan.download_tasks[1],
            DownloadTask::artifact(
                "artifact 1 mountPath=/workspace/a vasStorageName=workspace-a vasVersionId=artifact-v1 urlScheme=https cached=false missingRootPolicy=preserveParentVersion".into(),
                "https://s3/a.tar.gz".into(),
                "/workspace/a".into(),
            )
        );
    assert_eq!(
            plan.download_tasks[2],
            DownloadTask::artifact(
                "artifact 2 mountPath=/workspace/b vasStorageName=workspace-b vasVersionId=artifact-v2 urlScheme=file cached=false missingRootPolicy=fail".into(),
                "file:///tmp/vm0-storage-cache/b.tar.gz".into(),
                "/workspace/b".into(),
            )
        );
}

#[test]
fn run_plan_prepares_explicit_empty_artifact_without_download_task() {
    let json = r#"{
            "storageMounts": [{
                "mountPath": "/workspace",
                "archiveUrl": "https://s3/compat-empty-artifact.tar.gz",
                "empty": true,
                "name": "memory",
                "versionId": "empty-v1",
                "missingRootPolicy": "preserveParentVersion",
                "writeback": true
            }]
        }"#;
    let manifest: Manifest = serde_json::from_str(json).unwrap();

    let plan = RunPlan::from_manifest(&manifest);

    assert!(plan.download_tasks.is_empty());
    assert_eq!(
            plan.empty_artifacts,
            [EmptyArtifactPreparation {
                label: "artifact 1 mountPath=/workspace vasStorageName=memory vasVersionId=empty-v1 empty=true cached=false missingRootPolicy=preserveParentVersion".into(),
                mount_path: "/workspace".into(),
            }]
        );
}

#[test]
fn run_plan_skips_cached_artifact_when_mount_root_exists() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("workspace");
    fs::create_dir_all(&mount).unwrap();
    let mount_path = mount.to_string_lossy().into_owned();
    let manifest = Manifest {
        storages: vec![],
        artifacts: vec![ArtifactEntry {
            mount_path: mount_path.clone(),
            archive_url: Some("https://s3/artifact.tar.gz".into()),
            cached: true,
            empty: false,
            vas_storage_name: Some("artifact".into()),
            vas_storage_id: None,
            vas_version_id: Some("artifact-v1".into()),
            missing_root_policy: None,
        }],
        cleanup_paths: vec![],
        instruction_cleanups: Vec::new(),
    };

    let plan = RunPlan::from_manifest(&manifest);

    assert_eq!(plan.preserved_paths, [mount_path]);
    assert!(plan.download_tasks.is_empty());
}

#[test]
fn run_plan_downloads_cached_storage_when_mount_root_exists() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("storage");
    fs::create_dir_all(&mount).unwrap();
    let mount_path = mount.to_string_lossy().into_owned();
    let manifest = Manifest {
        storages: vec![StorageEntry {
            mount_path: mount_path.clone(),
            archive_url: Some("https://s3/storage.tar.gz".into()),
            cached: true,
            vas_storage_name: Some("storage".into()),
            vas_version_id: Some("storage-v1".into()),
        }],
        artifacts: vec![],
        cleanup_paths: vec![],
        instruction_cleanups: Vec::new(),
    };

    let plan = RunPlan::from_manifest(&manifest);

    assert_eq!(plan.preserved_paths, std::slice::from_ref(&mount_path));
    assert_eq!(
        plan.download_tasks,
        [DownloadTask::storage(
            format!(
                "storage 1 mountPath={mount_path} vasStorageName=storage vasVersionId=storage-v1 urlScheme=https cached=true"
            ),
            "https://s3/storage.tar.gz".into(),
            mount_path,
            false,
        )],
    );
}

#[test]
fn run_plan_downloads_cached_artifact_when_mount_root_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let mount_path = dir
        .path()
        .join("missing-workspace")
        .to_string_lossy()
        .into_owned();
    let manifest = Manifest {
        storages: vec![],
        artifacts: vec![ArtifactEntry {
            mount_path: mount_path.clone(),
            archive_url: Some("https://s3/artifact.tar.gz".into()),
            cached: true,
            empty: false,
            vas_storage_name: Some("artifact".into()),
            vas_storage_id: None,
            vas_version_id: Some("artifact-v1".into()),
            missing_root_policy: None,
        }],
        cleanup_paths: vec![],
        instruction_cleanups: Vec::new(),
    };

    let plan = RunPlan::from_manifest(&manifest);

    assert_eq!(plan.preserved_paths, std::slice::from_ref(&mount_path));
    assert_eq!(
        plan.download_tasks,
        [DownloadTask::artifact(
            format!(
                "artifact 1 mountPath={mount_path} vasStorageName=artifact vasVersionId=artifact-v1 urlScheme=https cached=true missingRootPolicy=fail"
            ),
            "https://s3/artifact.tar.gz".into(),
            mount_path,
        )],
    );
}
