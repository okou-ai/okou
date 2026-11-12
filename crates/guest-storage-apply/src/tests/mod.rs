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

fn shared_workflow_archive(
    root: &std::path::Path,
    entries: &[(&str, &[u8])],
) -> std::path::PathBuf {
    use std::io::Write;
    let output = root.join("source.tar.gz");
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(gzip);
    for (path, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        archive.append_data(&mut header, path, *bytes).unwrap();
    }
    let bytes = archive.into_inner().unwrap().finish().unwrap();
    std::fs::File::create(&output)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    output
}

#[test]
fn shared_workflow_packages_materialize_independent_names_and_preserve_attachments() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let source = shared_workflow_archive(root.path(), &[
        ("SKILL.md", b"---\nname: source\ndescription: keep this description\n---\n\nOriginal instruction.\n"),
        ("scripts/run.sh", b"#!/bin/sh\necho hello\n"),
    ]);
    let before = std::fs::read(&source).unwrap();
    let mounts: Vec<_> = ["one--wf-source", "two--wf-source"]
        .iter()
        .map(|name| root.path().join("skills").join(name))
        .collect();
    let manifest = json!({"storageMounts": mounts.iter().map(|mount| json!({
        "mountPath": mount, "name": "workflow", "versionId": "same-shared-hash",
        "archiveUrl": format!("file://{}", source.display())
    })).collect::<Vec<_>>()});
    assert!(super::run_manifest_bytes(
        &serde_json::to_vec(&manifest).unwrap()
    ));
    for mount in &mounts {
        let skill = std::fs::read_to_string(mount.join("SKILL.md")).unwrap();
        assert!(skill.contains(&format!(
            "name: {}\n",
            mount.file_name().unwrap().to_str().unwrap()
        )));
        assert!(skill.contains("description: keep this description\n"));
        assert!(skill.ends_with("Original instruction.\n"));
        assert_eq!(
            std::fs::read(mount.join("scripts/run.sh")).unwrap(),
            b"#!/bin/sh\necho hello\n"
        );
        assert_eq!(
            std::fs::metadata(mount.join("scripts/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }
    assert_eq!(std::fs::read(&source).unwrap(), before);
}

#[test]
fn instruction_package_materializes_a_workflow_and_cached_reuse_preserves_it() {
    let root = tempfile::tempdir().unwrap();
    let source = shared_workflow_archive(
        root.path(),
        &[("instructions.md", b"Legacy **Instructions**.\n")],
    );
    let mount = root.path().join("agent--instruction");
    let mut manifest = json!({"storageMounts": [{
        "mountPath": mount, "name": "workflow", "versionId": "shared-instruction-hash",
        "archiveUrl": format!("file://{}", source.display())
    }]});
    assert!(super::run_manifest_bytes(
        &serde_json::to_vec(&manifest).unwrap()
    ));
    let document = std::fs::read_to_string(mount.join("SKILL.md")).unwrap();
    assert!(document.contains("name: agent--instruction\n"));
    assert!(document.ends_with("Legacy **Instructions**.\n"));
    manifest["storageMounts"][0]["cached"] = json!(true);
    assert!(super::run_manifest_bytes(
        &serde_json::to_vec(&manifest).unwrap()
    ));
    assert_eq!(
        std::fs::read_to_string(mount.join("SKILL.md")).unwrap(),
        document
    );
}
