use crate::support::{
    TarEntry, create_tar_gz, create_tar_gz_entries, run_guest_storage_apply, write_manifest,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// file:// scheme — runner-staged local archives (epic #10800)
// ---------------------------------------------------------------------------

// Successful file:// extraction: the local tarball is read and its contents are
// extracted into the mount path. The staged tarball is intentionally left in
// place — /tmp is wiped on VM teardown, and deleting it early breaks runs where
// two manifest entries share the same staged path.
#[test]
fn file_scheme_extraction_success() {
    let tar_gz = create_tar_gz(&[("hello.txt", b"hello from file")]).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("hello.txt")).unwrap(),
        "hello from file"
    );
    // Staged tarball is preserved — runner cleans /tmp on VM teardown.
    assert!(staged.exists());
}

#[test]
fn failed_parent_archive_does_not_skip_pending_children() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let staged = dir.path().join("valid.tar.gz");
    let archive = create_tar_gz(&[("value.txt", b"required child contents")]).unwrap();
    std::fs::write(&staged, &archive).unwrap();
    let mut mounts = vec![json!({
        "mountPath": parent,
        "archiveUrl": format!("file://{}", dir.path().join("missing.tar.gz").display())
    })];
    for index in 0..9 {
        mounts.push(json!({
            "mountPath": parent.join(format!("child-{index}")),
            "archiveUrl": format!("file://{}", staged.display())
        }));
    }
    let manifest = dir.path().join("manifest.json");
    std::fs::write(
        &manifest,
        serde_json::to_vec(&json!({"storageMounts": mounts})).unwrap(),
    )
    .unwrap();

    assert!(!run_guest_storage_apply(manifest.to_str().unwrap()));
    for index in 0..9 {
        assert_eq!(
            std::fs::read(parent.join(format!("child-{index}/value.txt"))).unwrap(),
            b"required child contents"
        );
    }
    assert_eq!(std::fs::read(staged).unwrap(), archive);
}

// Security regression: file:// archives use the same extraction path as HTTP,
// but this is the production path for runner-staged storage cache tarballs.
#[test]
fn file_scheme_malicious_entries_are_skipped_while_safe_entries_extract() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::Symlink("evil_symlink", "../outside.txt"),
        TarEntry::Hardlink("evil_hardlink", "../outside.txt"),
        TarEntry::Raw {
            path: b"../path_escape.txt",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escaped",
        },
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();

    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
    assert!(!dir.path().join("path_escape.txt").exists());
    assert!(mount.join("evil_symlink").symlink_metadata().is_err());
    assert!(!mount.join("evil_hardlink").exists());
}

// Security regression: this exercises the ancestor symlink guard directly. The
// archive does not create the symlink; it is already present in the target.
#[test]
fn file_scheme_preexisting_symlink_ancestor_blocks_nested_entry() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::File("escape/payload.txt", b"malicious"),
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&mount).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, mount.join("escape")).unwrap();

    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert!(!outside.join("payload.txt").exists());
    assert!(
        mount
            .join("escape")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

// Storage with a missing file:// target fails the run. The runner only rewrites
// archive_url to file:// after vsock-staging succeeds, so a missing file means a
// broken runner contract: a terminal error.
#[test]
fn file_scheme_missing_storage_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());
    assert!(!result);
}

// Artifact downloads require a real archive. Explicit empty artifacts use the
// empty marker instead of a file:// archive, so a missing staged file is fatal.
#[test]
fn file_scheme_missing_artifact_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("artifact_mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_storage_apply(manifest.to_str().unwrap());
    assert!(!result);
}
