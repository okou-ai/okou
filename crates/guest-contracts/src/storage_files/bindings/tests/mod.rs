use super::{conflicting_mounts, validate_bindings};
use crate::storage_manifest::{ArtifactEntry, Manifest, StorageEntry};
use std::path::{Component, Path};

fn pairwise_conflicts(mounts: &[&str]) -> Vec<bool> {
    mounts
        .iter()
        .enumerate()
        .map(|(index, mount)| {
            mounts.iter().enumerate().any(|(other_index, other)| {
                if index == other_index {
                    return false;
                }
                let valid = |raw: &str| {
                    Path::new(raw).is_absolute()
                        && !raw.as_bytes().contains(&0)
                        && Path::new(raw)
                            .components()
                            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
                };
                !valid(mount)
                    || !valid(other)
                    || Path::new(mount).starts_with(other)
                    || Path::new(other).starts_with(mount)
            })
        })
        .collect()
}

fn indexed_conflicts(mounts: &[&str]) -> Vec<bool> {
    let conflicts = conflicting_mounts(mounts.iter().copied());
    mounts
        .iter()
        .map(|mount| conflicts.contains(mount))
        .collect()
}

fn storage(mount: &str) -> StorageEntry {
    StorageEntry {
        mount_path: mount.into(),
        archive_url: Some("file:///archive".into()),
        cached: false,
        vas_storage_name: Some("storage".into()),
        vas_version_id: Some("version".into()),
    }
}

fn artifact(mount: &str) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount.into(),
        archive_url: Some("file:///archive".into()),
        empty: false,
        cached: false,
        vas_storage_name: Some("artifact".into()),
        vas_storage_id: Some("artifact-id".into()),
        vas_version_id: Some("version".into()),
        missing_root_policy: None,
    }
}

fn manifest(storages: Vec<StorageEntry>, artifacts: Vec<ArtifactEntry>) -> Manifest {
    Manifest {
        storages,
        artifacts,
        cleanup_paths: Vec::new(),
        instruction_cleanups: Vec::new(),
    }
}

#[test]
fn classifies_all_descendants_and_component_aliases_in_original_order() {
    assert_eq!(
        indexed_conflicts(&["/a/b", "/z", "/a", "/a-b", "/a/c", "/a/b/deep"]),
        [true, false, true, false, true, true]
    );
    assert_eq!(
        indexed_conflicts(&["/a//b", "/a/./b/", "/ab", "/a/b", "/a/b/c"]),
        [true, true, false, true, true]
    );
}

#[test]
fn classification_matches_pairwise_ownership_for_ordered_path_sets() {
    let paths = [
        "", "/", "/a", "/a/b", "/a/c", "/a-b", "/a/./b", "/a//b/", "relative", "/a/../b", "/a\0b",
        "/雪/子",
    ];
    assert_eq!(indexed_conflicts(&[]), pairwise_conflicts(&[]));
    for first in paths {
        assert_eq!(indexed_conflicts(&[first]), pairwise_conflicts(&[first]));
        for second in paths {
            for third in paths {
                let mounts = [first, second, third];
                assert_eq!(
                    indexed_conflicts(&mounts),
                    pairwise_conflicts(&mounts),
                    "{mounts:?}"
                );
            }
        }
    }
}

#[test]
fn ordinary_overlap_does_not_reject_an_independent_selected_owner() {
    let source = manifest(
        vec![storage("/ordinary"), storage("/ordinary/child")],
        vec![artifact("/selected")],
    );
    validate_bindings(&source, ["/selected"]).unwrap();
    assert_eq!(
        validate_bindings(&source, ["/ordinary"])
            .unwrap_err()
            .to_string(),
        "decoded mount overlaps another mount"
    );
}

#[test]
fn binding_requires_exact_identity_even_when_paths_are_aliases() {
    let source = manifest(vec![storage("/selected")], Vec::new());
    assert_eq!(
        validate_bindings(&source, ["/selected/"])
            .unwrap_err()
            .to_string(),
        "decoded mount absent"
    );
    assert_eq!(
        validate_bindings(&source, ["/selected", "/selected"])
            .unwrap_err()
            .to_string(),
        "duplicate decoded mount"
    );
    let aliases = manifest(vec![storage("/selected/")], vec![artifact("/selected")]);
    assert_eq!(
        validate_bindings(&aliases, ["/selected"])
            .unwrap_err()
            .to_string(),
        "decoded mount overlaps another mount"
    );
}

#[test]
fn duplicate_manifest_and_selected_source_checks_keep_their_precedence() {
    let duplicates = manifest(vec![storage("/same")], vec![artifact("/same")]);
    assert_eq!(
        validate_bindings(&duplicates, []).unwrap_err().to_string(),
        "duplicate storage manifest mount"
    );
    let mut source = manifest(vec![storage("/selected"), storage("relative")], Vec::new());
    validate_bindings(&source, []).unwrap();
    source.storages[0].cached = true;
    assert_eq!(
        validate_bindings(&source, ["/selected"])
            .unwrap_err()
            .to_string(),
        "decoded storage source is not an ordinary download"
    );
    source.storages[0].cached = false;
    assert_eq!(
        validate_bindings(&source, ["/selected"])
            .unwrap_err()
            .to_string(),
        "decoded mount overlaps another mount"
    );
}
