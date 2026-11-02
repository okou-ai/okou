use super::super::fs::allocated_bytes;
use super::super::metadata::{HomeCacheMetadata, HomeCacheState, HomeImageFileIdentity, HomeTrust};
use super::super::{CACHE_FORMAT_VERSION, HOME_DRIVE_LAYOUT, HomeCacheTerminalStatus};
use super::*;
use crate::storage_fingerprints::StorageFingerprints;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::ids::RunId;

const TEST_PROFILE_NAME: &str = "vm0/default";
const TEST_WORKING_DIR: &str = "/home/user/workspace";
const TEST_ROOTFS: &str = "test-rootfs";

async fn create_watch_limit_entries(cache: &HomeImageCache) {
    let root = cache.home_image_cache_dir().to_path_buf();
    // These fresh empty entries only fill the watch budget. Prepare them
    // before any watcher exists, without repeated recovery/path walks.
    tokio::task::spawn_blocking(move || {
        use runner_host::host_file::PRIVATE_DIR_MODE;
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        host_file::ensure_dir(&root, DirMode::Private, "watch-limit fixture root").unwrap();
        for index in 0..MAX_HELD_HOME_STATES {
            let entry = root.join(format!("{index:064x}"));
            std::fs::DirBuilder::new()
                .mode(PRIVATE_DIR_MODE)
                .create(&entry)
                .unwrap();
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(PRIVATE_DIR_MODE))
                .unwrap();
        }
    })
    .await
    .unwrap();
}

async fn commit_entry(cache: &HomeImageCache, reuse_key: &str) -> String {
    let image = format!("image-{reuse_key}");
    let cache_key = cache.scoped_cache_key(TEST_PROFILE_NAME, reuse_key, image.len() as u64);
    cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
    let run_id = RunId::new_v4();
    let current_image = cache
        .entry_paths(&cache_key)
        .image(&run_id.to_string())
        .unwrap();
    tokio::fs::write(&current_image, image).await.unwrap();
    let current_metadata = tokio::fs::metadata(&current_image).await.unwrap();
    cache
        .write_metadata(
            &cache_key,
            run_id,
            HomeCacheMetadata {
                format_version: CACHE_FORMAT_VERSION,
                cache_scope: cache.inner.cache_scope.clone(),
                profile_name: TEST_PROFILE_NAME.into(),
                rootfs_hash: TEST_ROOTFS.into(),
                fingerprint_scope: "/home/user".into(),
                image_generation: run_id.to_string(),
                history_proof: None,
                reuse_key: reuse_key.into(),
                working_dir: TEST_WORKING_DIR.into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                last_used_at: "2026-05-01T00:00:00.000Z".into(),
                last_terminal_status: HomeCacheTerminalStatus::Success,
                home_trust: HomeTrust::Clean,
                logical_image_size_bytes: current_metadata.len(),
                allocated_bytes: allocated_bytes(&current_metadata),
                current_image: HomeImageFileIdentity::from_metadata(&current_metadata),
                drive_layout: HOME_DRIVE_LAYOUT.into(),
                storage_fingerprints: StorageFingerprints::default(),
                state: HomeCacheState::Current,
            },
        )
        .await
        .unwrap();
    cache_key
}

#[tokio::test]
async fn entry_directory_attribute_changes_revalidate_the_known_key() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
    let key = commit_entry(&cache, "directory-attributes").await;
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    std::fs::set_permissions(
        cache.home_image_cache_entry_dir(&key),
        std::fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([key]));
    assert!(!change.requires_full_reconcile);
}

#[tokio::test]
async fn reports_metadata_commit_and_removal_from_existing_entry() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "existing-entry",
        b"image-existing-entry".len() as u64,
    );
    cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();

    assert_eq!(commit_entry(&cache, "existing-entry").await, cache_key);
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));

    tokio::fs::remove_file(cache.home_image_cache_metadata(&cache_key))
        .await
        .unwrap();
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
    assert!(!change.requires_full_reconcile);
}

#[tokio::test]
async fn newly_created_entry_with_committed_metadata_is_not_lost() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    let cache_key = commit_entry(&cache, "new-entry").await;

    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
}

#[tokio::test]
async fn startup_reconciliation_preserves_matching_key_and_reports_missing_watch() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    let cache_key = commit_entry(&cache, "startup-reconciliation").await;

    let change = watcher
        .reconcile_initial_relevant_entries(&BTreeSet::from([cache_key.clone(), "a".repeat(64)]))
        .await
        .unwrap()
        .expect("newly classified startup entry should require reconciliation");

    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
    assert!(change.requires_full_reconcile);
}

#[tokio::test]
async fn startup_reconciliation_reports_eviction_at_the_watch_limit() {
    let temp = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
    create_watch_limit_entries(&cache).await;
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    let cache_key = commit_entry(&cache, "startup-at-limit").await;
    let change = watcher
        .reconcile_initial_relevant_entries(&BTreeSet::from([cache_key.clone()]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));
    assert!(
        change.requires_full_reconcile,
        "startup handoff must preserve actual watch-eviction completeness loss"
    );
    assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
    assert!(watcher.watch_by_cache_key.contains_key(&cache_key));
}

#[tokio::test]
async fn bounded_drain_preserves_readiness_for_remaining_events() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "bounded-drain",
        b"image-bounded-drain".len() as u64,
    );
    cache.ensure_home_cache_entry_dir(&cache_key).await.unwrap();
    let entry_dir = cache.home_image_cache_entry_dir(&cache_key);

    for index in 0..5_000 {
        tokio::fs::write(entry_dir.join(format!("noise-{index:04}")), b"")
            .await
            .unwrap();
    }
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    for index in 0..5_000 {
        tokio::fs::remove_file(entry_dir.join(format!("noise-{index:04}")))
            .await
            .unwrap();
    }
    assert_eq!(commit_entry(&cache, "bounded-drain").await, cache_key);

    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key]));
}

#[tokio::test]
async fn newly_created_entry_replaces_an_existing_watch_at_the_limit() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    create_watch_limit_entries(&cache).await;
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);

    let cache_key = commit_entry(&cache, "preferred-new-entry").await;

    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(change.dirty_cache_keys, BTreeSet::from([cache_key.clone()]));
    assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
    assert!(watcher.watch_by_cache_key.contains_key(&cache_key));
}

#[tokio::test]
async fn create_and_remove_in_one_batch_does_not_leave_a_stale_watch() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    let cache_key = "e".repeat(64);
    let entry_dir = cache.home_image_cache_entry_dir(&cache_key);

    tokio::fs::create_dir_all(&entry_dir).await.unwrap();
    tokio::fs::remove_dir(&entry_dir).await.unwrap();
    let relevant_cache_key = commit_entry(&cache, "post-create-remove").await;

    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change.dirty_cache_keys,
        BTreeSet::from([relevant_cache_key])
    );
    assert!(!watcher.watch_by_cache_key.contains_key(&cache_key));
}

#[tokio::test]
async fn foreign_scope_commit_and_removal_do_not_report_changes() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let observer_paths = RunnerPaths::new(temp.path().join("observer"));
    let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
    tokio::fs::create_dir_all(observer_paths.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
    let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
    let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();

    let foreign_cache_key = commit_entry(&publisher, "foreign-entry").await;
    let relevant_cache_key = commit_entry(&observer, "relevant-entry").await;

    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change.dirty_cache_keys,
        BTreeSet::from([relevant_cache_key])
    );
    assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));

    tokio::fs::remove_dir_all(publisher.home_image_cache_entry_dir(&foreign_cache_key))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), watcher.next_change())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn foreign_scope_commit_does_not_wake_observer() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let observer_paths = RunnerPaths::new(temp.path().join("observer"));
    let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
    tokio::fs::create_dir_all(observer_paths.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
    let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
    let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();

    let foreign_cache_key = commit_entry(&publisher, "foreign-only-entry").await;

    let mut next_change = Box::pin(watcher.next_change());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut next_change)
            .await
            .is_err()
    );
    let relevant_cache_key = commit_entry(&observer, "relevant-entry").await;
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), &mut next_change)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change.dirty_cache_keys,
        BTreeSet::from([relevant_cache_key])
    );
    drop(next_change);
    assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
}

#[tokio::test]
async fn foreign_scope_commit_does_not_request_reconciliation_at_the_watch_limit() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let observer_paths = RunnerPaths::new(temp.path().join("observer"));
    let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
    tokio::fs::create_dir_all(observer_paths.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
    let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
    create_watch_limit_entries(&observer).await;
    let mut watcher = HomeCacheWatcher::new(observer.clone()).await.unwrap();
    assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
    let foreign_cache_key = commit_entry(&publisher, "foreign-at-limit").await;

    let mut next_change = Box::pin(watcher.next_change());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut next_change)
            .await
            .is_err(),
        "a classified foreign entry does not lose relevant tracking completeness"
    );
    let relevant_cache_key = commit_entry(&observer, "relevant-at-limit").await;
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), &mut next_change)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change.dirty_cache_keys,
        BTreeSet::from([relevant_cache_key])
    );
    assert!(
        change.requires_full_reconcile,
        "a relevant entry replacing an existing watch still loses completeness"
    );
    drop(next_change);
    assert_eq!(watcher.watch_by_cache_key.len(), MAX_HELD_HOME_STATES);
    assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
}

#[tokio::test]
async fn existing_foreign_entries_do_not_consume_watch_budget() {
    let temp = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(temp.path().join("home"));
    let observer_paths = RunnerPaths::new(temp.path().join("observer"));
    let publisher_paths = RunnerPaths::new(temp.path().join("publisher"));
    tokio::fs::create_dir_all(observer_paths.base_dir())
        .await
        .unwrap();
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let observer = HomeImageCache::shared(observer_paths, &home, "group-a");
    let publisher = HomeImageCache::shared(publisher_paths, &home, "group-b");
    let foreign_cache_key = commit_entry(&publisher, "existing-foreign-entry").await;

    let watcher = HomeCacheWatcher::new(observer).await.unwrap();

    assert!(!watcher.watch_by_cache_key.contains_key(&foreign_cache_key));
    assert!(watcher.watch_by_cache_key.is_empty());
}

#[tokio::test]
async fn reconciliation_scans_past_irrelevant_raw_entry_limit() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();

    for index in 0..MAX_HELD_HOME_STATES {
        std::fs::create_dir(
            cache
                .home_image_cache_dir()
                .join(format!("irrelevant-{index:04}")),
        )
        .unwrap();
    }
    let relevant_cache_key = cache.scoped_cache_key(
        TEST_PROFILE_NAME,
        "relevant-after-raw-limit",
        b"image-relevant-after-raw-limit".len() as u64,
    );
    cache
        .ensure_home_cache_entry_dir(&relevant_cache_key)
        .await
        .unwrap();

    let mut entries = std::fs::read_dir(cache.home_image_cache_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    entries.sort_by_key(|entry| entry.file_name() == OsStr::new(&relevant_cache_key));
    assert_eq!(entries.len(), MAX_HELD_HOME_STATES + 1);
    assert_eq!(
        entries.last().unwrap().file_name(),
        OsStr::new(&relevant_cache_key)
    );

    watcher
        .reconcile_entry_watches(entries.into_iter().map(Ok), &mut BTreeSet::new())
        .await
        .unwrap();

    assert!(watcher.watch_by_cache_key.contains_key(&relevant_cache_key));
    assert_eq!(watcher.watch_by_cache_key.len(), 1);

    assert_eq!(
        commit_entry(&cache, "relevant-after-raw-limit").await,
        relevant_cache_key
    );
    let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        change.dirty_cache_keys,
        BTreeSet::from([relevant_cache_key])
    );
}

#[tokio::test]
async fn setup_error_does_not_expose_cache_path() {
    let temp = tempfile::tempdir().unwrap();
    let paths = RunnerPaths::new(temp.path().join("runner"));
    let cache = HomeImageCache::new(paths);
    let cache_root = cache.home_image_cache_dir().to_path_buf();
    std::fs::create_dir_all(cache_root.parent().unwrap()).unwrap();
    std::fs::write(&cache_root, b"not a directory").unwrap();

    let error = match HomeCacheWatcher::new(cache).await {
        Ok(_) => panic!("watcher setup should reject a non-directory cache root"),
        Err(error) => error,
    };
    let message = error.to_string();

    assert!(message.contains("home cache watcher prepare root"));
    assert!(!message.contains(&cache_root.display().to_string()));
}

#[tokio::test]
async fn unused_release_overflow_requests_full_reconciliation_with_bounded_hints() {
    let temp = tempfile::tempdir().unwrap();
    let cache = HomeImageCache::new(RunnerPaths::new(temp.path().join("runner")));
    let mut watcher = HomeCacheWatcher::new(cache.clone()).await.unwrap();
    for key in 0..=MAX_HELD_HOME_STATES {
        cache.inner.record_selection_release(&format!("{key:064x}"));
    }
    let change = watcher.next_change().await.unwrap();
    assert!(change.requires_full_reconcile);
    assert_eq!(change.dirty_cache_keys.len(), MAX_HELD_HOME_STATES);
    // Hints never advertise nonexistent commits, even after saturation.
    let updates = cache
        .revalidate_home_cache_keys(
            &BTreeMap::from([(TEST_PROFILE_NAME, 1024 * 1024)]),
            &change.dirty_cache_keys,
        )
        .await;
    assert!(updates.entries.values().all(Option::is_none));
    let oversized = (0..=MAX_HELD_HOME_STATES)
        .map(|key| format!("{key:064x}"))
        .collect();
    let updates = cache
        .revalidate_home_cache_keys(
            &BTreeMap::from([(TEST_PROFILE_NAME, 1024 * 1024)]),
            &oversized,
        )
        .await;
    assert!(
        updates.incomplete,
        "a capped validation cannot claim complete coverage"
    );
    assert!(updates.entries.is_empty());
    let snapshot = super::super::snapshot::HomeCacheStateSnapshot::new();
    let token = snapshot.begin_home_cache_refresh();
    assert!(
        snapshot
            .finish_home_cache_key_updates(token, updates)
            .needs_reconcile
    );
}

#[test]
fn coalesced_batches_keep_first_observation_and_report_key_saturation() {
    let first_observation = tokio::time::Instant::now();
    let mut change = HomeCacheChange {
        observed_at: first_observation,
        dirty_cache_keys: (0..MAX_HELD_HOME_STATES)
            .map(|key| format!("{key:064x}"))
            .collect(),
        requires_full_reconcile: false,
    };
    change.merge(HomeCacheChange {
        observed_at: first_observation + std::time::Duration::from_secs(1),
        dirty_cache_keys: BTreeSet::from([format!("{:064x}", 0)]),
        requires_full_reconcile: false,
    });
    assert!(
        !change.requires_full_reconcile,
        "a duplicate does not lose completeness"
    );
    change.merge(HomeCacheChange {
        observed_at: first_observation + std::time::Duration::from_secs(3),
        dirty_cache_keys: BTreeSet::from([format!("{MAX_HELD_HOME_STATES:064x}")]),
        requires_full_reconcile: false,
    });
    assert_eq!(
        change.observed_at, first_observation,
        "coalescing must preserve the original observation for latency attribution"
    );
    assert!(change.requires_full_reconcile);
    assert_eq!(change.dirty_cache_keys.len(), MAX_HELD_HOME_STATES);
}
