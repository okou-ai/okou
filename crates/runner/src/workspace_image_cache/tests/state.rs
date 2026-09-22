use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use tokio::fs;

use super::super::fs::{allocated_bytes, local_timestamp};
use super::super::lifecycle::cap_held_workspace_states;
use super::super::metadata::{
    WorkspaceCacheMetadata, WorkspaceCacheState, WorkspaceImageFileIdentity, WorkspaceTrust,
};
use super::super::path_safety::{
    filter_storage_fingerprints_for_working_dir, is_safe_guest_working_dir,
    normalize_safe_guest_working_dir,
};
use super::super::{
    CACHE_FORMAT_VERSION, WORKSPACE_DRIVE_LAYOUT, WorkspaceCacheCheckoutResult,
    WorkspaceCacheTerminalStatus, WorkspaceImageCache, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};
use super::support::{
    TEST_PROFILE_NAME, local_cache, timestamp_for_index, write_current_cache_entry_for_profile,
};
use crate::paths::{
    HomePaths, RunnerPaths, scoped_workspace_image_cache_key, workspace_image_cache_key,
};
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use runner_types::ids::RunId;
use runner_types::types::{
    HeldWorkspaceState, MAX_HELD_WORKSPACE_STATES, MAX_WORKSPACE_CACHES_PER_HEARTBEAT,
    MAX_WORKSPACE_CACHES_PER_REUSE_KEY, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheCapability,
};

#[test]
fn cache_key_has_stable_current_format() {
    assert_eq!(
        scoped_workspace_image_cache_key(
            "vm0/test",
            "vm0/default",
            "thread:thread-1",
            "/workspace",
            5,
        ),
        "fb89abd2f9a7b7784f27cdd974db105a35cc86a135a6a499e42904ba61e30bc7"
    );
}

#[test]
fn cache_key_separates_profile_and_image_size() {
    let base =
        scoped_workspace_image_cache_key("vm0/test", "vm0/default", "sess-1", "/workspace", 5);

    assert_ne!(
        base,
        scoped_workspace_image_cache_key("vm0/test", "vm0/browser", "sess-1", "/workspace", 5,)
    );
    assert_ne!(
        base,
        scoped_workspace_image_cache_key("vm0/test", "vm0/default", "sess-1", "/workspace", 6,)
    );
}

#[test]
fn workspace_scoped_fingerprints_do_not_match_prefix_traps() {
    let fingerprints = StorageFingerprints {
        storages: HashMap::from([
            ("/workspace".into(), StorageFingerprint::new("repo", "v1")),
            (
                "/workspace/sub".into(),
                StorageFingerprint::new("sub", "v1"),
            ),
            (
                "/workspace//sub2".into(),
                StorageFingerprint::new("sub2", "v1"),
            ),
            ("/workspace2".into(), StorageFingerprint::new("trap", "v1")),
            (
                "/workspace/../outside".into(),
                StorageFingerprint::new("escape", "v1"),
            ),
            ("/tmp/cache".into(), StorageFingerprint::new("tmp", "v1")),
        ]),
        artifacts: HashMap::from([
            (
                "/workspace/art".into(),
                StorageFingerprint::new("art", "v1"),
            ),
            (
                "/home/user/.codex".into(),
                StorageFingerprint::new("codex", "v1"),
            ),
        ]),
    };

    let filtered = filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace");

    assert!(filtered.storages.contains_key("/workspace"));
    assert!(filtered.storages.contains_key("/workspace/sub"));
    assert!(filtered.storages.contains_key("/workspace//sub2"));
    assert!(!filtered.storages.contains_key("/workspace2"));
    assert!(!filtered.storages.contains_key("/workspace/../outside"));
    assert!(!filtered.storages.contains_key("/tmp/cache"));
    assert!(filtered.artifacts.contains_key("/workspace/art"));
    assert!(!filtered.artifacts.contains_key("/home/user/.codex"));

    let trailing_slash_filtered =
        filter_storage_fingerprints_for_working_dir(&fingerprints, "/workspace/");
    assert!(trailing_slash_filtered.storages.contains_key("/workspace"));
    assert!(
        trailing_slash_filtered
            .storages
            .contains_key("/workspace/sub")
    );
    assert!(!trailing_slash_filtered.storages.contains_key("/workspace2"));
}

#[test]
fn cap_held_workspace_states_dedupes_and_keeps_newest() {
    let mut states: Vec<HeldWorkspaceState> = (0..=MAX_HELD_WORKSPACE_STATES)
        .map(|index| HeldWorkspaceState {
            reuse_key: format!("sess-{index:04}"),
            last_completed_at: timestamp_for_index(index),
            workspace_caches: vec![WorkspaceCacheCapability {
                profile: TEST_PROFILE_NAME.to_owned(),
                workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
            }],
        })
        .collect();
    states.push(HeldWorkspaceState {
        reuse_key: "sess-0001".into(),
        last_completed_at: timestamp_for_index(MAX_HELD_WORKSPACE_STATES + 1),
        workspace_caches: vec![WorkspaceCacheCapability {
            profile: TEST_PROFILE_NAME.to_owned(),
            workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
        }],
    });

    let capped = cap_held_workspace_states(states);

    assert_eq!(capped.len(), MAX_HELD_WORKSPACE_STATES);
    assert!(
        !capped.iter().any(|state| state.reuse_key == "sess-0000"),
        "oldest advertised cache state should be dropped"
    );
    assert!(capped.iter().any(|state| {
        state.reuse_key == "sess-0001"
            && state.last_completed_at == timestamp_for_index(MAX_HELD_WORKSPACE_STATES + 1)
    }));
    assert!(
        capped
            .iter()
            .any(|state| state.reuse_key == format!("sess-{MAX_HELD_WORKSPACE_STATES:04}"))
    );
}

#[test]
fn cap_held_workspace_states_bounds_nested_resources() {
    let per_reuse_key = (0..=MAX_WORKSPACE_CACHES_PER_REUSE_KEY)
        .map(|index| HeldWorkspaceState {
            reuse_key: "sess-multi".into(),
            last_completed_at: timestamp_for_index(index),
            workspace_caches: vec![WorkspaceCacheCapability {
                profile: format!("vm0/profile-{index:02}"),
                workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
            }],
        })
        .collect();

    let capped = cap_held_workspace_states(per_reuse_key);

    assert_eq!(capped.len(), 1);
    assert_eq!(
        capped[0].workspace_caches.len(),
        MAX_WORKSPACE_CACHES_PER_REUSE_KEY
    );
    assert_eq!(capped[0].workspace_caches[0].profile, "vm0/profile-00");
    assert_eq!(capped[0].last_completed_at, timestamp_for_index(8));

    let global = (0..=MAX_WORKSPACE_CACHES_PER_HEARTBEAT / 8)
        .map(|index| HeldWorkspaceState {
            reuse_key: format!("sess-{index:04}"),
            last_completed_at: timestamp_for_index(index),
            workspace_caches: (0..8)
                .map(|profile| WorkspaceCacheCapability {
                    profile: format!("vm0/profile-{profile}"),
                    workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
                })
                .collect(),
        })
        .collect();

    let capped = cap_held_workspace_states(global);

    assert_eq!(
        capped
            .iter()
            .map(|state| state.workspace_caches.len())
            .sum::<usize>(),
        MAX_WORKSPACE_CACHES_PER_HEARTBEAT
    );
    assert!(
        !capped.iter().any(|state| state.reuse_key == "sess-0000"),
        "oldest reuse key should be dropped at the global workspace cap"
    );
}

#[tokio::test]
async fn held_workspace_states_for_profiles_filters_and_aggregates_current_identities() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);
    let run_id = RunId::new_v4();
    let reuse_key = "thread:multi-profile";
    let image_size = format!("image-{reuse_key}").len() as u64;
    write_current_cache_entry_for_profile(
        &cache,
        run_id,
        "vm0/default",
        reuse_key,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:01.000Z",
    )
    .await;
    write_current_cache_entry_for_profile(
        &cache,
        run_id,
        "vm0/large",
        reuse_key,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:02.000Z",
        "2026-05-01T00:00:02.000Z",
    )
    .await;
    write_current_cache_entry_for_profile(
        &cache,
        run_id,
        "vm0/noncanonical",
        reuse_key,
        "/workspace",
        "2026-05-01T00:00:03.000Z",
        "2026-05-01T00:00:03.000Z",
    )
    .await;

    let configured = BTreeMap::from([
        ("vm0/default", image_size),
        ("vm0/large", image_size),
        ("vm0/noncanonical", image_size),
    ]);
    let states = cache.held_workspace_states_for_profiles(&configured).await;

    assert_eq!(
        states,
        vec![HeldWorkspaceState {
            reuse_key: reuse_key.into(),
            last_completed_at: "2026-05-01T00:00:02.000Z".into(),
            workspace_caches: vec![
                WorkspaceCacheCapability {
                    profile: "vm0/default".into(),
                    workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
                },
                WorkspaceCacheCapability {
                    profile: "vm0/large".into(),
                    workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
                },
            ],
        }]
    );

    let default_only = BTreeMap::from([("vm0/default", image_size)]);
    let states = cache
        .held_workspace_states_for_profiles(&default_only)
        .await;
    assert_eq!(states[0].workspace_caches.len(), 1);
    assert_eq!(states[0].workspace_caches[0].profile, "vm0/default");

    let wrong_size = BTreeMap::from([("vm0/default", image_size + 1)]);
    assert!(
        cache
            .held_workspace_states_for_profiles(&wrong_size)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn commit_reconciliation_waits_for_entry_lock_before_validating() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);
    let reuse_key = "thread:commit-lock";
    let cache_key = write_current_cache_entry_for_profile(
        &cache,
        RunId::new_v4(),
        TEST_PROFILE_NAME,
        reuse_key,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:01.000Z",
    )
    .await;
    let image_size = format!("image-{reuse_key}").len() as u64;
    let configured = BTreeMap::from([(TEST_PROFILE_NAME, image_size)]);
    let committed = BTreeSet::from([cache_key.clone()]);
    let held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let cache_for_refresh = cache.clone();
    let refresh = tokio::spawn(async move {
        cache_for_refresh
            .held_workspace_states_for_profiles_after_commits(
                &configured,
                &committed,
                tokio::time::Instant::now() + Duration::from_secs(2),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !refresh.is_finished(),
        "commit reconciliation must wait while the publisher owns the entry lock",
    );

    drop(held_lock);
    let states = tokio::time::timeout(Duration::from_secs(2), refresh)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].reuse_key, reuse_key);
}

#[tokio::test]
async fn initial_scan_returns_committed_entry_skipped_for_locking() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);
    let reuse_key = "thread:initial-commit-lock";
    let cache_key = write_current_cache_entry_for_profile(
        &cache,
        RunId::new_v4(),
        TEST_PROFILE_NAME,
        reuse_key,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:01.000Z",
    )
    .await;
    let image_size = format!("image-{reuse_key}").len() as u64;
    let configured = BTreeMap::from([(TEST_PROFILE_NAME, image_size)]);
    let held_lock = crate::lock::acquire(cache.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let (states, locked_commit_keys, _) = cache
        .initial_held_workspace_states_for_profiles(&configured)
        .await;

    assert!(states.is_empty());
    assert_eq!(locked_commit_keys, BTreeSet::from([cache_key]));
    drop(held_lock);
}

#[tokio::test]
async fn initial_scan_ignores_locked_foreign_scope_commit() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let observer_paths = RunnerPaths::new(dir.path().join("observer"));
    let publisher_paths = RunnerPaths::new(dir.path().join("publisher"));
    fs::create_dir_all(observer_paths.base_dir()).await.unwrap();
    fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let observer = WorkspaceImageCache::shared(observer_paths, &home, "group-a");
    let publisher = WorkspaceImageCache::shared(publisher_paths, &home, "group-b");
    let reuse_key = "thread:foreign-initial-commit-lock";
    let cache_key = write_current_cache_entry_for_profile(
        &publisher,
        RunId::new_v4(),
        TEST_PROFILE_NAME,
        reuse_key,
        CANONICAL_WORKING_DIR,
        "2026-05-01T00:00:01.000Z",
        "2026-05-01T00:00:01.000Z",
    )
    .await;
    let image_size = format!("image-{reuse_key}").len() as u64;
    let configured = BTreeMap::from([(TEST_PROFILE_NAME, image_size)]);
    let held_lock = crate::lock::acquire(publisher.entry_lock_path(&cache_key))
        .await
        .unwrap();

    let (states, locked_commit_keys, _) = observer
        .initial_held_workspace_states_for_profiles(&configured)
        .await;

    assert!(states.is_empty());
    assert!(locked_commit_keys.is_empty());
    drop(held_lock);
}

#[test]
fn safe_guest_working_dir_rejects_root_relative_and_parent() {
    assert!(is_safe_guest_working_dir("/home/user/workspace"));
    assert_eq!(
        normalize_safe_guest_working_dir("/home//user/workspace/").as_deref(),
        Some("/home/user/workspace"),
    );
    assert!(!is_safe_guest_working_dir("/"));
    assert!(!is_safe_guest_working_dir("//"));
    assert!(!is_safe_guest_working_dir("///"));
    assert!(!is_safe_guest_working_dir("/."));
    assert!(!is_safe_guest_working_dir("/./"));
    assert!(!is_safe_guest_working_dir("/workspace/."));
    assert!(!is_safe_guest_working_dir("workspace"));
    assert!(!is_safe_guest_working_dir("/home/../workspace"));
    assert!(!is_safe_guest_working_dir("/home/user/work\0space"));
}

#[tokio::test]
async fn invalid_working_dir_allocates_only_required_workspace_drive() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().join("runner"));
    tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
    let cache = WorkspaceImageCache::new(paths);

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/",
                image_size_bytes: 1024,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(lease.workspace_drive_config().is_none());

    let no_reuse_key_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: None,
                working_dir: "/",
                image_size_bytes: 1024,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(
        no_reuse_key_lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(no_reuse_key_lease.workspace_drive_config().is_none());

    let snapshot_restore_lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: RunId::new_v4(),
                sandbox_id: sandbox::SandboxId::new_v4(),
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/",
                image_size_bytes: 1024,
            },
            workspace_drive_required: true,
        })
        .await;

    assert_eq!(
        snapshot_restore_lease.result(),
        WorkspaceCacheCheckoutResult::InvalidWorkingDir
    );
    assert!(snapshot_restore_lease.workspace_drive_config().is_some());
    assert!(
        !snapshot_restore_lease
            .promote(
                RunId::new_v4(),
                WorkspaceCacheTerminalStatus::Success,
                local_timestamp(),
                &StorageFingerprints::default(),
            )
            .await
            .unwrap(),
        "unsafe working dirs may require an attached drive for snapshot restore but must not be cached",
    );
}

#[tokio::test]
async fn prepare_normalizes_working_dir_for_cache_identity() {
    let (_dir, _paths, cache) = local_cache().await;
    let run_id = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id,
                sandbox_id,
                profile_name: TEST_PROFILE_NAME,
                reuse_key: Some("sess-1"),
                working_dir: "/workspace//repo/",
                image_size_bytes: 1024,
            },
            workspace_drive_required: false,
        })
        .await;

    assert_eq!(lease.working_dir(), "/workspace/repo");
    let expected_key = cache.scoped_cache_key(TEST_PROFILE_NAME, "sess-1", "/workspace/repo", 1024);
    assert_eq!(lease.cache_key.as_deref(), Some(expected_key.as_str()));
}

#[tokio::test]
async fn held_workspace_states_reject_metadata_under_wrong_cache_key() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "sess-1",
        "/workspace",
        b"old image".len() as u64,
    );
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-other".into(),
                working_dir: "/workspace".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    assert!(
        cache.held_workspace_states().await.is_empty(),
        "metadata must not be advertised from a cache key derived from another reuse key"
    );
}

#[tokio::test]
async fn held_workspace_states_reject_unsafe_working_dir_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(dir.path().to_path_buf());
    let cache = WorkspaceImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let key = workspace_image_cache_key("sess-1", "/");
    fs::create_dir_all(cache.entry_paths(&key).entry_dir().to_path_buf())
        .await
        .unwrap();
    let current = cache.entry_paths(&key).current_image().to_path_buf();
    fs::write(&current, b"image").await.unwrap();
    let current_metadata = fs::metadata(&current).await.unwrap();
    cache
        .write_metadata(
            &key,
            run_id,
            WorkspaceCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: String::new(),
                profile_name: TEST_PROFILE_NAME.into(),
                reuse_key: "sess-1".into(),
                working_dir: "/".into(),
                last_completed_at: local_timestamp(),
                last_used_at: local_timestamp(),
                last_terminal_status: WorkspaceCacheTerminalStatus::Success,
                workspace_trust: WorkspaceTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: WorkspaceImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: WORKSPACE_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: WorkspaceCacheState::Current,
            },
        )
        .await
        .unwrap();

    assert!(
        cache.held_workspace_states().await.is_empty(),
        "unsafe working dirs must not be advertised as reusable workspace caches",
    );
}
