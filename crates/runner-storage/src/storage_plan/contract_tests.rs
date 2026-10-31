use std::collections::HashMap;
use std::fs;
use std::path::Path;

use flate2::{Compression, write::GzEncoder};

use super::build_storage_plan;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use runner_types::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

fn storage(mount_path: &Path, name: &str, version: &str, archive_url: String) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.to_string_lossy().into_owned(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        archive_url,
        archive_size: None,
    }
}

fn artifact(mount_path: &Path, name: &str, version: &str, archive_url: String) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.to_string_lossy().into_owned(),
        vas_storage_name: name.into(),
        vas_storage_id: format!("{name}-id"),
        vas_version_id: version.into(),
        archive_url: Some(archive_url),
        empty: None,
        missing_root_policy: None,
        archive_size: None,
    }
}

fn write_archive(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> String {
    let archive_path = dir.join(name);
    let archive = fs::File::create(&archive_path).unwrap();
    let encoder = GzEncoder::new(archive, Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (path, contents) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, *contents).unwrap();
    }
    let encoder = builder.into_inner().unwrap();
    encoder.finish().unwrap();
    format!("file://{}", archive_path.display())
}

fn run_plan(plan: super::StoragePlan) {
    let bytes = serde_json::to_vec(&plan.into_guest_manifest()).unwrap();
    assert!(guest_storage_apply::run_manifest_bytes(&bytes));
}

#[test]
fn canonical_home_state_roundtrip_rematerializes_changed_removed_tainted_and_empty_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let changed = dir.path().join("changed");
    let removed = dir.path().join("removed");
    let empty = dir.path().join("empty-artifact");
    let ordinary = dir.path().join("ordinary.txt");
    for path in [&changed, &removed, &empty] {
        fs::create_dir(path).unwrap();
        fs::write(path.join("stale.txt"), b"stale managed input").unwrap();
    }
    fs::write(&ordinary, b"ordinary user file").unwrap();
    let archive = write_archive(
        dir.path(),
        "current.tar.gz",
        &[("current.txt", b"captured current bytes")],
    );
    let mut empty_entry = artifact(&empty, "output", "empty", String::new());
    empty_entry.archive_url = None;
    empty_entry.empty = Some(true);
    let current = StorageManifest {
        storages: vec![storage(&changed, "current", "v2", archive)],
        artifacts: vec![empty_entry],
    };
    let previous = StorageFingerprints {
        storages: HashMap::from([
            (
                changed.to_string_lossy().into_owned(),
                StorageFingerprint::new("current", "v1"),
            ),
            (
                removed.to_string_lossy().into_owned(),
                StorageFingerprint::tainted(),
            ),
        ]),
        artifacts: HashMap::from([(
            empty.to_string_lossy().into_owned(),
            StorageFingerprint::new("output", "v1"),
        )]),
    };
    let captured = StorageFingerprints::from_manifest(&current);
    let tainted = captured.tainted_paths_including(Some(&previous));
    let canonical: StorageFingerprints =
        serde_json::from_slice(&serde_json::to_vec(&tainted).unwrap()).unwrap();
    assert_eq!(canonical, tainted);
    let plan = build_storage_plan(&current, Some(&canonical)).unwrap();
    run_plan(plan);
    assert!(!changed.join("stale.txt").exists());
    assert_eq!(
        fs::read(changed.join("current.txt")).unwrap(),
        b"captured current bytes"
    );
    assert!(!removed.exists());
    assert!(empty.is_dir());
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    assert_eq!(fs::read(&ordinary).unwrap(), b"ordinary user file");
}

#[test]
fn reused_empty_fingerprints_replace_stale_storage_contents() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("data");
    fs::create_dir_all(&mount).unwrap();
    fs::write(mount.join("stale.txt"), "stale").unwrap();
    let archive_url = write_archive(dir.path(), "storage.tar.gz", &[("current.txt", b"current")]);
    let manifest = StorageManifest {
        storages: vec![storage(&mount, "data", "v1", archive_url)],
        artifacts: Vec::new(),
    };

    let plan = build_storage_plan(&manifest, Some(&StorageFingerprints::default())).unwrap();
    run_plan(plan);

    assert!(!mount.join("stale.txt").exists());
    assert_eq!(
        fs::read_to_string(mount.join("current.txt")).unwrap(),
        "current"
    );
}

#[test]
fn cached_artifacts_preserve_existing_root_and_repair_missing_root() {
    let dir = tempfile::tempdir().unwrap();
    let existing_mount = dir.path().join("existing-workspace");
    let missing_mount = dir.path().join("missing-workspace");
    fs::create_dir_all(&existing_mount).unwrap();
    fs::write(existing_mount.join("preserved.txt"), "preserved").unwrap();
    let existing_url = write_archive(
        dir.path(),
        "existing-artifact.tar.gz",
        &[("unexpected.txt", b"unexpected")],
    );
    let missing_url = write_archive(
        dir.path(),
        "missing-artifact.tar.gz",
        &[("repaired.txt", b"repaired")],
    );
    let manifest = StorageManifest {
        storages: Vec::new(),
        artifacts: vec![
            artifact(&existing_mount, "existing", "v1", existing_url),
            artifact(&missing_mount, "missing", "v1", missing_url),
        ],
    };
    let previous = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: HashMap::from([
            (
                existing_mount.to_string_lossy().into_owned(),
                StorageFingerprint::new("existing", "v1"),
            ),
            (
                missing_mount.to_string_lossy().into_owned(),
                StorageFingerprint::new("missing", "v1"),
            ),
        ]),
    };

    let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();
    run_plan(plan);

    assert_eq!(
        fs::read_to_string(existing_mount.join("preserved.txt")).unwrap(),
        "preserved"
    );
    assert!(!existing_mount.join("unexpected.txt").exists());
    assert_eq!(
        fs::read_to_string(missing_mount.join("repaired.txt")).unwrap(),
        "repaired"
    );
}

#[test]
fn omitted_mount_prunes_managed_skill_and_preserves_nested_user_skills() {
    let dir = tempfile::tempdir().unwrap();
    let skills = dir.path().join(".claude/skills");
    let removed = skills.join("removed-skill");
    let retained = skills.join("workflow");
    fs::create_dir_all(&removed).unwrap();
    fs::create_dir_all(retained.join("custom/removed-skill")).unwrap();
    fs::write(removed.join("SKILL.md"), "managed skill").unwrap();
    fs::write(
        retained.join("custom/removed-skill/SKILL.md"),
        "user-owned nested skill",
    )
    .unwrap();
    let previous = StorageFingerprints {
        storages: HashMap::from([
            (
                removed.to_string_lossy().into_owned(),
                StorageFingerprint::new("removed-skill", "v1"),
            ),
            (
                retained.to_string_lossy().into_owned(),
                StorageFingerprint::new("workflow", "v1"),
            ),
        ]),
        artifacts: HashMap::new(),
    };
    let manifest = StorageManifest {
        storages: vec![storage(&retained, "workflow", "v1", String::new())],
        artifacts: Vec::new(),
    };
    let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();
    run_plan(plan);
    assert!(!removed.exists());
    assert_eq!(
        fs::read_to_string(retained.join("custom/removed-skill/SKILL.md")).unwrap(),
        "user-owned nested skill"
    );
}
