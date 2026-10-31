use std::collections::{HashMap, HashSet};

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

use super::{ArchiveSource, ArtifactAction, StorageAction, build_storage_plan};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use runner_types::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

fn storage(mount_path: &str, name: &str, version: &str) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        archive_url: format!("https://example.com/{name}/{version}.tar.gz"),
        archive_size: None,
    }
}

fn artifact(mount_path: &str, name: &str, version: &str, empty: bool) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.into(),
        vas_storage_name: name.into(),
        vas_storage_id: format!("{name}-id"),
        vas_version_id: version.into(),
        archive_url: (!empty).then(|| format!("https://example.com/{name}/{version}.tar.gz")),
        empty: empty.then_some(true),
        missing_root_policy: Some(ArtifactEntryMissingRootPolicy::PreserveParentVersion),
        archive_size: None,
    }
}

fn manifest(storages: Vec<StorageEntry>, artifacts: Vec<ArtifactEntry>) -> StorageManifest {
    StorageManifest {
        storages,
        artifacts,
    }
}

#[test]
fn fresh_and_reused_empty_have_distinct_cleanup_semantics() {
    let manifest = manifest(vec![storage("/data", "data", "v1")], Vec::new());

    let fresh = build_storage_plan(&manifest, None).unwrap();
    let reused = build_storage_plan(&manifest, Some(&StorageFingerprints::default())).unwrap();

    assert!(fresh.cleanup_paths.is_empty());
    assert_eq!(reused.cleanup_paths, ["/data"]);
    assert!(matches!(
        fresh.storages[0].action,
        StorageAction::Download { .. }
    ));
    assert!(matches!(
        reused.storages[0].action,
        StorageAction::Download { .. }
    ));
}

#[test]
fn unchanged_storage_reuses_without_guest_work() {
    let manifest = manifest(vec![storage("/data", "data", "v1")], Vec::new());
    let previous = StorageFingerprints {
        storages: HashMap::from([("/data".into(), StorageFingerprint::new("data", "v1"))]),
        artifacts: HashMap::new(),
    };

    let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();

    assert!(matches!(
        plan.storages[0].action,
        StorageAction::ReuseExisting
    ));
    assert!(!plan.requires_guest_work());
    assert!(plan.cache_candidates().is_empty());
    let wire = plan.into_guest_manifest();
    assert!(wire.storages[0].cached);
    assert_eq!(wire.storages[0].archive_url, None);
}

#[test]
fn decoded_admission_selects_non_overlapping_storage_and_artifact_downloads() {
    let source = manifest(
        vec![storage("/ordinary", "ordinary", "v1")],
        vec![artifact("/artifact", "artifact", "v1", false)],
    );
    let plan = build_storage_plan(&source, None).unwrap();
    let selected: Vec<_> = plan
        .cache_candidates()
        .iter()
        .filter_map(|candidate| plan.decoded_mount(candidate.handle))
        .collect();
    assert_eq!(selected, ["/ordinary", "/artifact"]);
    for overlap in ["/ordinary/child", "/ordinary/child/../nested", "/"] {
        let source = manifest(
            vec![storage("/ordinary", "ordinary", "v1")],
            vec![artifact(overlap, "artifact", "v1", false)],
        );
        let plan = build_storage_plan(&source, None).unwrap();
        assert!(
            plan.cache_candidates()
                .iter()
                .all(|candidate| plan.decoded_mount(candidate.handle).is_none())
        );
    }
}

#[test]
fn decoded_artifact_admission_requires_complete_fresh_identity() {
    for missing in ["name", "storage-id", "version"] {
        let mut entry = artifact("/artifact", "artifact", "v1", false);
        if missing == "name" {
            entry.vas_storage_name.clear();
        } else if missing == "storage-id" {
            entry.vas_storage_id.clear();
        } else {
            entry.vas_version_id.clear();
        }
        let plan = build_storage_plan(&manifest(Vec::new(), vec![entry]), None).unwrap();
        assert!(
            plan.cache_candidates()
                .iter()
                .all(|candidate| plan.decoded_mount(candidate.handle).is_none()),
            "{missing}"
        );
    }

    let fresh = artifact("/artifact", "artifact", "v1", false);
    let previous = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: HashMap::from([(
            "/artifact".into(),
            StorageFingerprint::new("artifact", "v1"),
        )]),
    };
    let plan = build_storage_plan(&manifest(Vec::new(), vec![fresh]), Some(&previous)).unwrap();
    assert!(plan.cache_candidates().is_empty());

    let mut oversized = artifact("/artifact", "artifact", "v1", false);
    oversized.archive_url = Some(format!("https://example.com/{}", "x".repeat(70_000)));
    let plan = build_storage_plan(&manifest(Vec::new(), vec![oversized]), None).unwrap();
    let candidate = plan.cache_candidates().pop().unwrap();
    assert!(!plan.decoded_entry_fits(candidate.handle).unwrap());
}

#[test]
fn decoded_selection_retains_mount_ownership_after_cloning_and_source_staging() {
    let source = manifest(
        vec![
            storage("/ordinary", "ordinary", "v1"),
            storage("/blocked", "blocked", "v1"),
        ],
        vec![artifact("/blocked/child", "artifact", "v1", false)],
    );
    let plan = build_storage_plan(&source, None).unwrap();
    let candidates = plan.cache_candidates();
    let selected: Vec<_> = candidates
        .iter()
        .map(|candidate| plan.decoded_mount(candidate.handle))
        .collect();
    assert_eq!(selected, [Some("/ordinary"), None, None]);
    let mut cloned = plan.clone();
    let candidate = &candidates[0];
    assert!(cloned.stage_archive(
        candidate.handle,
        &candidate.name,
        &candidate.version,
        &candidate.archive_url,
        "file:///staged-ordinary.tar.gz".into(),
    ));
    for candidate in &candidates {
        assert_eq!(
            cloned.decoded_mount(candidate.handle),
            plan.decoded_mount(candidate.handle)
        );
    }
}

#[test]
fn decoded_selection_matches_pairwise_conflicts_for_mixed_entries() {
    use std::path::{Component, Path};
    let paths = [
        "/a", "/a/b", "/a/c", "/a-b", "/a/./b", "/a//b/", "/", "relative", "/a/../b",
    ];
    let valid = |raw: &str| {
        Path::new(raw).is_absolute()
            && !raw.as_bytes().contains(&0)
            && Path::new(raw)
                .components()
                .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
    };
    for first in paths {
        for second in paths {
            for third in paths {
                let mounts = [first, second, third];
                let source = manifest(
                    vec![
                        storage(first, "first", "v1"),
                        storage(second, "second", "v1"),
                    ],
                    vec![artifact(third, "artifact", "v1", false)],
                );
                let plan = build_storage_plan(&source, None).unwrap();
                for (index, candidate) in plan.cache_candidates().iter().enumerate() {
                    let conflict = mounts.iter().enumerate().any(|(other_index, other)| {
                        index != other_index
                            && (!valid(mounts[index])
                                || !valid(other)
                                || Path::new(mounts[index]).starts_with(other)
                                || Path::new(other).starts_with(mounts[index]))
                    });
                    let expected = (valid(mounts[index]) && !conflict).then_some(mounts[index]);
                    assert_eq!(plan.decoded_mount(candidate.handle), expected, "{mounts:?}");
                }
            }
        }
    }
}

#[test]
fn changed_storage_name_or_version_requires_replacement() {
    let manifest = manifest(vec![storage("/data", "data", "v2")], Vec::new());

    for previous_fingerprint in [
        StorageFingerprint::new("old-name", "v2"),
        StorageFingerprint::new("data", "v1"),
    ] {
        let previous = StorageFingerprints {
            storages: HashMap::from([("/data".into(), previous_fingerprint)]),
            artifacts: HashMap::new(),
        };
        let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();

        assert!(matches!(
            plan.storages[0].action,
            StorageAction::Download { .. }
        ));
        assert_eq!(plan.cleanup_paths, ["/data"]);
    }
}

#[test]
fn tainted_storage_and_changed_artifact_use_replacement_actions() {
    let manifest = manifest(
        vec![storage("/tainted", "tainted", "v1")],
        vec![artifact("/artifact", "artifact", "v2", false)],
    );
    let previous = StorageFingerprints {
        storages: HashMap::from([("/tainted".into(), StorageFingerprint::tainted())]),
        artifacts: HashMap::from([(
            "/artifact".into(),
            StorageFingerprint::new("artifact", "v1"),
        )]),
    };

    let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();
    let cleanup_paths = plan
        .cleanup_paths
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();

    assert!(
        plan.storages
            .iter()
            .all(|entry| matches!(entry.action, StorageAction::Download { .. }))
    );
    assert!(matches!(
        plan.artifacts[0].action,
        ArtifactAction::Download { .. }
    ));
    assert_eq!(cleanup_paths, HashSet::from(["/tainted", "/artifact"]));
}

#[test]
fn artifact_actions_preserve_repair_and_empty_semantics() {
    let manifest = manifest(
        Vec::new(),
        vec![
            artifact("/workspace", "workspace", "v1", false),
            artifact("/memory", "memory", "v1", true),
        ],
    );
    let previous = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: HashMap::from([
            (
                "/workspace".into(),
                StorageFingerprint::new("workspace", "v1"),
            ),
            ("/memory".into(), StorageFingerprint::new("memory", "v1")),
        ]),
    };

    let plan = build_storage_plan(&manifest, Some(&previous)).unwrap();

    assert!(matches!(
        plan.artifacts[0].action,
        ArtifactAction::ReuseOrRepair { .. }
    ));
    assert!(matches!(
        plan.artifacts[1].action,
        ArtifactAction::PrepareEmpty { cached: true }
    ));
    assert!(plan.cache_candidates().is_empty());
    assert!(plan.requires_guest_work());
    let wire = plan.into_guest_manifest();
    assert!(wire.artifacts[0].cached);
    assert!(wire.artifacts[0].archive_url.is_some());
    assert_eq!(
        wire.artifacts[0].missing_root_policy.as_deref(),
        Some("preserveParentVersion")
    );
    assert_eq!(
        wire.artifacts[0].vas_storage_id.as_deref(),
        Some("workspace-id")
    );
    assert!(wire.artifacts[1].cached);
    assert!(wire.artifacts[1].empty);
    assert_eq!(wire.artifacts[1].archive_url, None);
}

#[test]
fn non_empty_artifact_requires_archive_source() {
    let mut artifact = artifact("/workspace", "workspace", "v1", false);
    artifact.archive_url = None;

    let error = build_storage_plan(&manifest(Vec::new(), vec![artifact]), None).unwrap_err();

    assert_eq!(
        error.to_string(),
        "internal error: storage manifest artifact workspace version v1 is missing archiveUrl"
    );
}

#[test]
fn cache_staging_changes_only_archive_source() {
    let manifest = manifest(vec![storage("/data", "data", "v1")], Vec::new());
    let mut plan = build_storage_plan(&manifest, None).unwrap();
    let candidate = plan.cache_candidates().pop().unwrap();

    assert!(!plan.stage_archive(
        candidate.handle,
        "wrong-name",
        &candidate.version,
        &candidate.archive_url,
        "file:///tmp/wrong.tar.gz".into(),
    ));
    assert!(plan.stage_archive(
        candidate.handle,
        &candidate.name,
        &candidate.version,
        &candidate.archive_url,
        "file:///tmp/cached.tar.gz".into(),
    ));

    assert!(matches!(
        plan.storages[0].action,
        StorageAction::Download {
            source: ArchiveSource::GuestStaged(ref url)
        } if url == "file:///tmp/cached.tar.gz"
    ));
    let wire = plan.into_guest_manifest();
    assert!(!wire.storages[0].cached);
    assert_eq!(
        wire.storages[0].archive_url.as_deref(),
        Some("file:///tmp/cached.tar.gz")
    );
}

#[test]
fn fresh_artifact_is_cache_eligible_without_changing_repair_semantics() {
    let manifest = manifest(
        Vec::new(),
        vec![artifact("/workspace", "workspace", "v1", false)],
    );
    let mut plan = build_storage_plan(&manifest, None).unwrap();
    let candidate = plan.cache_candidates().pop().unwrap();

    assert!(plan.stage_archive(
        candidate.handle,
        &candidate.name,
        &candidate.version,
        &candidate.archive_url,
        "file:///tmp/artifact.tar.gz".into(),
    ));

    assert!(matches!(
        plan.artifacts[0].action,
        ArtifactAction::Download {
            source: ArchiveSource::GuestStaged(ref url)
        } if url == "file:///tmp/artifact.tar.gz"
    ));
}

#[test]
fn canonical_framework_home_is_not_enough_for_narrow_cleanup() {
    let previous = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.claude".into(),
            StorageFingerprint::new("ordinary-storage", "v1"),
        )]),
        artifacts: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("artifact", "v1"),
        )]),
    };

    let plan = build_storage_plan(&manifest(Vec::new(), Vec::new()), Some(&previous)).unwrap();
    let cleanup_paths = plan
        .cleanup_paths
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();

    assert_eq!(
        cleanup_paths,
        HashSet::from(["/home/user/.claude", "/home/user/.codex"])
    );
    assert!(plan.instruction_cleanups.is_empty());
}

#[test]
fn tainted_framework_home_uses_narrow_cleanup() {
    for home in [
        "/home/user/.codex",
        "/home/user/.claude",
        "/home/user/.pi/agent",
    ] {
        let previous = StorageFingerprints {
            storages: HashMap::from([(home.into(), StorageFingerprint::tainted())]),
            artifacts: HashMap::new(),
        };

        let plan = build_storage_plan(&manifest(Vec::new(), Vec::new()), Some(&previous)).unwrap();

        assert!(plan.cleanup_paths.is_empty(), "{home}");
        assert_eq!(plan.instruction_cleanups.len(), 1);
        assert_eq!(plan.instruction_cleanups[0].mount_path, home);
    }
}
