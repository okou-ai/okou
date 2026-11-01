use serde_json::json;

#[test]
fn empty_artifact_reset_preserves_directory_identity_and_permissions() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("workspace");
    std::fs::create_dir(&mount).unwrap();
    std::fs::set_permissions(&mount, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(mount.join("stale"), b"previous failed run data").unwrap();
    std::fs::create_dir(mount.join("lost+found")).unwrap();
    let before = mount.metadata().unwrap();
    let manifest = json!({
        "cleanupPaths": [dir.path()],
        "storageMounts": [{"mountPath": mount, "empty": true,
            "name": "workspace", "versionId": "empty-v1", "writeback": true}]
    });
    assert!(super::run_manifest_bytes(
        &serde_json::to_vec(&manifest).unwrap()
    ));
    let after = mount.metadata().unwrap();
    assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
    assert_eq!(
        (after.uid(), after.gid(), after.mode()),
        (before.uid(), before.gid(), before.mode())
    );
    assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
}

#[test]
fn run_manifest_prepares_explicit_empty_artifact_without_opening_archive() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("memory");
    let missing_archive = dir.path().join("missing-empty.tar.gz");
    let manifest = json!({
        "storageMounts": [{
            "mountPath": mount,
            "archiveUrl": format!("file://{}", missing_archive.display()),
            "empty": true,
            "name": "memory",
            "versionId": "empty-v1",
            "writeback": true
        }]
    });

    let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

    assert!(success);
    assert!(mount.is_dir());
}

#[test]
fn run_manifest_prepares_explicit_empty_artifact_without_archive_url() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("memory");
    let manifest = json!({
        "storageMounts": [{
            "mountPath": mount,
            "empty": true,
            "name": "memory",
            "versionId": "empty-v1",
            "writeback": true
        }]
    });

    let success = super::run_manifest_bytes(&serde_json::to_vec(&manifest).unwrap());

    assert!(success);
    assert!(mount.is_dir());
}
