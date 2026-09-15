use std::collections::{HashMap, HashSet};

use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;

use super::{ArchiveSource, ArtifactAction, StorageAction, build_storage_plan};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

fn storage(
    mount_path: &str,
    name: &str,
    version: &str,
    instructions_target_filename: Option<&str>,
) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.into(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        baseline_candidate: false,
        instructions_target_filename: instructions_target_filename.map(str::to_string),
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
    let manifest = manifest(vec![storage("/data", "data", "v1", None)], Vec::new());

    let fresh = build_storage_plan(&manifest, "/run", None).unwrap();
    let reused =
        build_storage_plan(&manifest, "/run", Some(&StorageFingerprints::default())).unwrap();

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
    let manifest = manifest(vec![storage("/data", "data", "v1", None)], Vec::new());
    let previous = StorageFingerprints {
        storages: HashMap::from([("/data".into(), StorageFingerprint::new("data", "v1"))]),
        artifacts: HashMap::new(),
    };

    let plan = build_storage_plan(&manifest, "/run", Some(&previous)).unwrap();

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
fn decoded_admission_only_selects_non_overlapping_ordinary_downloads() {
    let source = manifest(
        vec![
            storage("/ordinary", "ordinary", "v1", None),
            storage("/instructions", "instructions", "v1", Some("AGENTS.md")),
        ],
        vec![artifact("/artifact", "artifact", "v1", false)],
    );
    let plan = build_storage_plan(&source, "/run", None).unwrap();
    let selected: Vec<_> = plan
        .cache_candidates()
        .iter()
        .filter_map(|candidate| plan.decoded_mount(candidate.handle))
        .collect();
    assert_eq!(selected, ["/ordinary"]);
    for overlap in ["/ordinary/child", "/ordinary/child/../nested", "/"] {
        let source = manifest(
            vec![storage("/ordinary", "ordinary", "v1", None)],
            vec![artifact(overlap, "artifact", "v1", false)],
        );
        let plan = build_storage_plan(&source, "/run", None).unwrap();
        assert!(
            plan.cache_candidates()
                .iter()
                .all(|candidate| plan.decoded_mount(candidate.handle).is_none())
        );
    }
}

#[test]
fn unchanged_instructions_normalize_in_place() {
    let manifest = manifest(
        vec![storage(
            "/home/user/.codex",
            "agent-instructions@test",
            "v1",
            Some("AGENTS.md"),
        )],
        Vec::new(),
    );
    let previous = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("agent-instructions@test", "v1"),
        )]),
        artifacts: HashMap::new(),
    };

    let plan = build_storage_plan(&manifest, "/run/test", Some(&previous)).unwrap();

    assert!(matches!(
        plan.storages[0].action,
        StorageAction::NormalizeInPlace
    ));
    assert!(plan.requires_guest_work());
    assert!(plan.instruction_cleanups.is_empty());
    let wire = plan.into_guest_manifest();
    assert_eq!(wire.storages[0].archive_url, None);
    assert_eq!(
        wire.storages[0].extract_path.as_deref(),
        Some("/run/test/storage-instructions/0")
    );
    assert_eq!(
        wire.storages[0].instructions_target_filename.as_deref(),
        Some("AGENTS.md")
    );
}

#[test]
fn fresh_and_changed_instructions_share_staging_but_not_cleanup() {
    let manifest = manifest(
        vec![storage(
            "/home/user/.claude",
            "agent-instructions@test",
            "v2",
            Some("CLAUDE.md"),
        )],
        Vec::new(),
    );
    let previous = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.claude".into(),
            StorageFingerprint::new("agent-instructions@test", "v1"),
        )]),
        artifacts: HashMap::new(),
    };

    let fresh = build_storage_plan(&manifest, "/run/test", None).unwrap();
    let changed = build_storage_plan(&manifest, "/run/test", Some(&previous)).unwrap();

    assert!(matches!(
        fresh.storages[0].action,
        StorageAction::DownloadAndNormalize { .. }
    ));
    assert!(fresh.cleanup_paths.is_empty());
    assert!(fresh.instruction_cleanups.is_empty());
    assert!(matches!(
        changed.storages[0].action,
        StorageAction::DownloadAndNormalize { .. }
    ));
    assert!(changed.cleanup_paths.is_empty());
    assert_eq!(changed.instruction_cleanups.len(), 1);
    assert_eq!(
        changed.instruction_cleanups[0].mount_path,
        "/home/user/.claude"
    );
    assert_eq!(
        changed.instruction_cleanups[0].target_filename.as_deref(),
        Some("CLAUDE.md")
    );
}

#[test]
fn changed_storage_name_or_version_requires_replacement() {
    let manifest = manifest(vec![storage("/data", "data", "v2", None)], Vec::new());

    for previous_fingerprint in [
        StorageFingerprint::new("old-name", "v2"),
        StorageFingerprint::new("data", "v1"),
    ] {
        let previous = StorageFingerprints {
            storages: HashMap::from([("/data".into(), previous_fingerprint)]),
            artifacts: HashMap::new(),
        };
        let plan = build_storage_plan(&manifest, "/run", Some(&previous)).unwrap();

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
        vec![storage("/tainted", "tainted", "v1", None)],
        vec![artifact("/artifact", "artifact", "v2", false)],
    );
    let previous = StorageFingerprints {
        storages: HashMap::from([("/tainted".into(), StorageFingerprint::tainted())]),
        artifacts: HashMap::from([(
            "/artifact".into(),
            StorageFingerprint::new("artifact", "v1"),
        )]),
    };

    let plan = build_storage_plan(&manifest, "/run", Some(&previous)).unwrap();
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

    let plan = build_storage_plan(&manifest, "/run", Some(&previous)).unwrap();

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

    let error =
        build_storage_plan(&manifest(Vec::new(), vec![artifact]), "/run", None).unwrap_err();

    assert_eq!(
        error.to_string(),
        "internal error: storage manifest artifact workspace version v1 is missing archiveUrl"
    );
}

#[test]
fn removed_framework_instruction_uses_narrow_cleanup() {
    let previous = StorageFingerprints {
        storages: HashMap::from([(
            "/home/user/.codex".into(),
            StorageFingerprint::new("agent-instructions@test", "v1"),
        )]),
        artifacts: HashMap::new(),
    };

    let plan =
        build_storage_plan(&manifest(Vec::new(), Vec::new()), "/run", Some(&previous)).unwrap();

    assert!(plan.cleanup_paths.is_empty());
    assert_eq!(plan.instruction_cleanups.len(), 1);
    assert_eq!(plan.instruction_cleanups[0].mount_path, "/home/user/.codex");
    assert_eq!(plan.instruction_cleanups[0].target_filename, None);
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

    let plan =
        build_storage_plan(&manifest(Vec::new(), Vec::new()), "/run", Some(&previous)).unwrap();
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
    let previous = StorageFingerprints {
        storages: HashMap::from([("/home/user/.claude".into(), StorageFingerprint::tainted())]),
        artifacts: HashMap::new(),
    };

    let plan =
        build_storage_plan(&manifest(Vec::new(), Vec::new()), "/run", Some(&previous)).unwrap();

    assert!(plan.cleanup_paths.is_empty());
    assert_eq!(plan.instruction_cleanups.len(), 1);
}

#[test]
fn cache_staging_changes_only_archive_source() {
    let manifest = manifest(vec![storage("/data", "data", "v1", None)], Vec::new());
    let mut plan = build_storage_plan(&manifest, "/run", None).unwrap();
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
    let mut plan = build_storage_plan(&manifest, "/run", None).unwrap();
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
