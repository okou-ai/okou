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
fn binary_storage_applies_one_inline_archive_to_storage_and_artifact() {
    use guest_contracts::storage_files::{STAGED_ARCHIVE_DIR, inline_archives};
    use std::os::unix::fs::MetadataExt;

    let root = tempfile::tempdir().unwrap();
    let fixture = shared_workflow_archive(root.path(), &[("nested/file", b"shared archive data")]);
    let content = std::fs::read(fixture).unwrap();
    let source = format!("{STAGED_ARCHIVE_DIR}/test-only-inline.tar.gz");
    let mounts = [root.path().join("first"), root.path().join("second")];
    let manifest = json!({"storageMounts": [
        {"mountPath": mounts[0], "archiveUrl": format!("file://{source}")},
        {
            "mountPath": mounts[1], "archiveUrl": format!("file://{source}"),
            "writeback": true, "storageId": "artifact-storage", "versionId": "v1"
        }
    ]});
    let input = inline_archives::encode_input(
        &serde_json::to_vec(&manifest).unwrap(),
        &[(&source, &content)],
    )
    .unwrap();
    assert!(super::run_storage_files_bytes(&input));
    for mount in &mounts {
        let file = mount.join("nested/file");
        assert_eq!(std::fs::read(&file).unwrap(), b"shared archive data");
        let metadata = file.metadata().unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o755);
        assert_eq!(metadata.mtime(), 1);
    }
    std::fs::write(mounts[1].join("nested/file"), b"artifact update").unwrap();
    assert_eq!(
        std::fs::read(mounts[0].join("nested/file")).unwrap(),
        b"shared archive data"
    );
}

#[test]
fn binary_storage_rejects_an_inline_archive_with_a_corrupt_crc() {
    use guest_contracts::storage_files::{STAGED_ARCHIVE_DIR, inline_archives};

    let root = tempfile::tempdir().unwrap();
    let fixture = shared_workflow_archive(root.path(), &[("file", b"archive data")]);
    let mut content = std::fs::read(fixture).unwrap();
    let crc_offset = content.len() - 8;
    content[crc_offset] ^= 1;
    let source = format!("{STAGED_ARCHIVE_DIR}/test-inline-crc.tar.gz");
    let manifest = json!({"storageMounts": [{
        "mountPath": root.path().join("mount"),
        "archiveUrl": format!("file://{source}")
    }]});
    let input = inline_archives::encode_input(
        &serde_json::to_vec(&manifest).unwrap(),
        &[(&source, &content)],
    )
    .unwrap();

    assert!(!super::run_storage_files_bytes(&input));
}

#[test]
fn binary_storage_rejects_an_unbound_inline_source_before_cleanup() {
    use guest_contracts::storage_files::{STAGED_ARCHIVE_DIR, inline_archives};

    let root = tempfile::tempdir().unwrap();
    let keep = root.path().join("keep");
    std::fs::write(&keep, b"before apply").unwrap();
    let manifest = json!({
        "storageMounts": [],
        "cleanupPaths": [root.path()]
    });
    let source = format!("{STAGED_ARCHIVE_DIR}/unbound.tar.gz");
    let input = inline_archives::encode_input(
        &serde_json::to_vec(&manifest).unwrap(),
        &[(&source, b"unused bytes")],
    )
    .unwrap();
    assert!(!super::run_storage_files_bytes(&input));
    assert_eq!(std::fs::read(keep).unwrap(), b"before apply");
}

#[test]
fn wide_decoded_input_finishes_other_mounts_after_a_write_failure() {
    use guest_contracts::storage_files::{StorageFile, encode_input};
    use std::fs;
    use std::os::unix::fs::MetadataExt;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().canonicalize().unwrap();
    let mounts = (0..20)
        .map(|index| {
            path.join(format!("skill-{index}"))
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    let blocked = std::path::Path::new(&mounts[0]).join("SKILL.md");
    fs::create_dir_all(&blocked).unwrap();
    let mut manifest = json!({"storageMounts": mounts.iter().map(|mount| json!({
        "mountPath": mount, "archiveUrl": "decoded://"
    })).collect::<Vec<_>>()});
    let files = (0..mounts.len())
        .map(|index| {
            [StorageFile {
                path: "SKILL.md".into(),
                mode: 0o640,
                mtime: 1234,
                content: format!("skill-{index}").into_bytes(),
            }]
        })
        .collect::<Vec<_>>();
    let groups = mounts
        .iter()
        .zip(&files)
        .map(|(mount, files)| (mount.as_str(), files.as_slice()))
        .collect::<Vec<_>>();
    let apply = |manifest: &serde_json::Value| {
        let input = encode_input(&serde_json::to_vec(manifest).unwrap(), &groups).unwrap();
        super::run_storage_files_bytes_in_runtime(&input, root.path())
    };
    assert_eq!(
        apply(&manifest),
        Err(super::ApplyFailure::TargetUnavailable)
    );
    assert!(blocked.is_dir());
    for (index, mount) in mounts.iter().enumerate().skip(1) {
        let file = std::path::Path::new(mount).join("SKILL.md");
        assert_eq!(fs::read(&file).unwrap(), files[index][0].content);
        let metadata = file.metadata().unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o640);
        assert_eq!(metadata.mtime(), 1234);
        assert_eq!(metadata.uid(), path.metadata().unwrap().uid());
    }

    // A different mount's source error cannot be treated as a recoverable
    // target conflict when Runner decides whether to continue on reused Home.
    manifest["storageMounts"][1]["templateGuidance"] = json!({
        "sha256": "0".repeat(64), "archiveBytes": 1
    });
    assert_eq!(apply(&manifest), Err(super::ApplyFailure::Failed));
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
