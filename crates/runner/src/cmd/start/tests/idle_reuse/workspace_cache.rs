use super::super::super::*;
use super::super::support::{
    WorkspacePromotionSeedSpec, assert_run_exits_within, context_with_session, minimal_context,
    mock_run_config, mock_run_config_with_overrides, push_job, seed_idle_pool_with_overrides,
    seed_idle_pool_with_workspace_promotion, seed_workspace_cache_state, shutdown, test_profiles,
    wait_budget_count, wait_cancel_token, wait_discover_entered, wait_idle_pool_reuse_keys,
    wait_status_mode,
};

use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use crate::workspace_image_cache::WorkspaceImageCache;
use runner_host::paths::{HomePaths, RunnerPaths};
use runner_types::types::{
    HeartbeatState, SandboxReuseResult, WORKSPACE_AFFINITY_VERSION, WorkspaceCacheCapability,
};

fn reusable_candidate(
    run_id: RunId,
    profile_name: &str,
    reuse_key: &str,
) -> runner_provider::JobCandidate {
    runner_provider::JobCandidate::new(run_id, profile_name.to_string())
        .with_reuse_key(Some(reuse_key.to_string()))
}

async fn wait_heartbeat_matching_after(
    handle: &crate::provider_test_support::MockProviderHandle,
    mut cursor: usize,
    timeout: Duration,
    matches: impl Fn(&HeartbeatState) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let heartbeats = handle.heartbeats.lock().unwrap_or_else(|e| e.into_inner());
            if heartbeats[cursor..].iter().any(&matches) {
                return true;
            }
            cursor = heartbeats.len();
        }

        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() || !handle.wait_heartbeat_past(cursor, remaining).await {
            return false;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn external_workspace_cache_publication_and_removal_trigger_immediate_heartbeats() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let home = config.paths.home.clone();
    let group = config.runner.group.clone();
    let observer_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let observer_cache = WorkspaceImageCache::shared(observer_paths, &home, &group);
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(observer_cache);

    let publisher_paths = RunnerPaths::new(env._temp_dir.path().join("publisher"));
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let publisher_cache = WorkspaceImageCache::shared(publisher_paths.clone(), &home, &group);
    let foreign_publisher_paths = RunnerPaths::new(env._temp_dir.path().join("foreign-publisher"));
    tokio::fs::create_dir_all(foreign_publisher_paths.base_dir())
        .await
        .unwrap();
    let foreign_publisher_cache =
        WorkspaceImageCache::shared(foreign_publisher_paths.clone(), &home, "foreign-group");
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let before_publication = env.handle.heartbeat_count();
    env.handle.block_heartbeats();
    let watcher_cursor = env.start_observer.cursor();

    let invalid_cache_key = "d".repeat(64);
    let invalid_staging = home
        .workspace_image_cache_dir()
        .with_file_name("invalid-workspace-cache-staging");
    tokio::fs::create_dir_all(&invalid_staging).await.unwrap();
    tokio::fs::write(invalid_staging.join("metadata.json"), b"{}")
        .await
        .unwrap();
    tokio::fs::rename(
        &invalid_staging,
        home.workspace_image_cache_dir().join(invalid_cache_key),
    )
    .await
    .unwrap();
    seed_workspace_cache_state(
        &foreign_publisher_cache,
        &foreign_publisher_paths,
        "thread:foreign-workspace-cache",
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    seed_workspace_cache_state(
        &publisher_cache,
        &publisher_paths,
        "thread:cancel-safe-workspace-cache",
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    let watcher_cursor = env
        .start_observer
        .wait_workspace_cache_change_observed_after(watcher_cursor, Duration::from_secs(5))
        .await;
    assert!(
        env.handle
            .wait_heartbeat_in_flight(1, Duration::from_secs(5))
            .await,
        "the first relevant cache heartbeat should remain blocked",
    );

    let reuse_key = "thread:external-workspace-cache";
    let expected_workspace = WorkspaceCacheCapability {
        profile: "vm0/default".to_string(),
        workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
    };
    seed_workspace_cache_state(
        &publisher_cache,
        &publisher_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    env.start_observer
        .wait_workspace_cache_change_observed_after(watcher_cursor, Duration::from_secs(5))
        .await;
    assert_eq!(
        env.handle.heartbeat_count(),
        before_publication + 1,
        "the watcher must consume a second event without overlapping the blocked heartbeat",
    );
    assert_eq!(env.handle.max_heartbeat_in_flight(), 1);
    env.handle.unblock_heartbeats();

    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            before_publication,
            Duration::from_secs(5),
            |heartbeat| {
                heartbeat.held_workspace_states.iter().any(|state| {
                    state.reuse_key == reuse_key
                        && state.workspace_caches.contains(&expected_workspace)
                }) && heartbeat.held_workspace_states.iter().any(|state| {
                    state.reuse_key == "thread:cancel-safe-workspace-cache"
                        && state.workspace_caches.contains(&expected_workspace)
                })
            },
        )
        .await,
        "external publication should be advertised without the routine heartbeat tick",
    );
    assert_eq!(
        env.handle.heartbeat_count(),
        before_publication + 2,
        "two relevant publications should produce only the active and coalesced heartbeats",
    );

    let before_removal = env.handle.heartbeat_count();
    let cache_key = runner_host::paths::scoped_workspace_image_cache_key(
        &group,
        "vm0/default",
        reuse_key,
        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
        16 * 1024 * 1024,
    );
    let metadata = home
        .workspace_image_cache_dir()
        .join(cache_key)
        .join("metadata.json");
    let duplicate_metadata = metadata.with_extension("duplicate");
    tokio::fs::write(
        &duplicate_metadata,
        tokio::fs::read(&metadata).await.unwrap(),
    )
    .await
    .unwrap();
    tokio::fs::rename(&duplicate_metadata, &metadata)
        .await
        .unwrap();
    tokio::fs::remove_file(&metadata).await.unwrap();

    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            before_removal,
            Duration::from_secs(5),
            |heartbeat| {
                heartbeat
                    .held_workspace_states
                    .iter()
                    .all(|state| state.reuse_key != reuse_key)
            },
        )
        .await,
        "external removal should promptly withdraw the advertised capability",
    );
    assert_eq!(
        env.handle.heartbeat_count(),
        before_removal + 1,
        "duplicate unchanged publication must coalesce with the effective removal",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn workspace_cache_change_while_draining_is_preserved_after_resume() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config_with_overrides(profiles, 8, 32768, 4, overrides);
    let (heartbeat_trigger, heartbeat_trigger_rx) = tokio::sync::mpsc::unbounded_channel();
    config.test_hooks.manual_routine_heartbeat_rx = Some(heartbeat_trigger_rx);
    let status_path = env._temp_dir.path().join("status.json");
    let home = config.paths.home.clone();
    let group = config.runner.group.clone();
    let observer_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let observer_cache = WorkspaceImageCache::shared(observer_paths, &home, &group);
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(observer_cache.clone());

    let publisher_paths = RunnerPaths::new(env._temp_dir.path().join("draining-publisher"));
    tokio::fs::create_dir_all(publisher_paths.base_dir())
        .await
        .unwrap();
    let publisher_home = HomePaths::with_root(env._temp_dir.path().join("draining-publisher-home"));
    let publisher_cache =
        WorkspaceImageCache::shared(publisher_paths.clone(), &publisher_home, &group);
    let reuse_key = "thread:draining-watcher-change";
    seed_workspace_cache_state(
        &publisher_cache,
        &publisher_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    let cache_key = runner_host::paths::scoped_workspace_image_cache_key(
        &group,
        "vm0/default",
        reuse_key,
        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
        16 * 1024 * 1024,
    );
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("active job should enter wait_process before draining");
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    observer_cache.reset_held_state_root_scan_count();
    let before_change = env.handle.heartbeat_count();
    let watcher_cursor = env.start_observer.cursor();
    // Publish a complete entry in one watched operation. Creating the directory
    // and committing metadata in place can be observed in separate batches,
    // legitimately requesting two scans even though the snapshot is unchanged.
    tokio::fs::rename(
        publisher_home.workspace_image_cache_dir().join(&cache_key),
        home.workspace_image_cache_dir().join(&cache_key),
    )
    .await
    .unwrap();
    env.start_observer
        .wait_workspace_cache_change_observed_after(watcher_cursor, Duration::from_secs(5))
        .await;
    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            before_change,
            Duration::from_secs(5),
            |heartbeat| {
                heartbeat.mode == "draining"
                    && heartbeat
                        .held_workspace_states
                        .iter()
                        .any(|state| state.reuse_key == reuse_key)
            },
        )
        .await,
        "a cache change consumed while draining should refresh the published snapshot",
    );
    assert_eq!(observer_cache.held_state_root_scan_count(), 1);

    env.resume();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    let before_routine = env.handle.heartbeat_count();
    let heartbeat_cursor = env.start_observer.cursor();
    // Trigger only the routine heartbeat: advancing paused time can also fire
    // periodic cache reconciliation and legitimately add another root scan.
    heartbeat_trigger
        .send(())
        .expect("manual routine heartbeat receiver should remain open");
    env.start_observer
        .wait_routine_heartbeat_requested_after(
            heartbeat_cursor,
            RunnerMode::Running,
            Duration::from_secs(5),
        )
        .await;
    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            before_routine,
            Duration::from_secs(5),
            |heartbeat| {
                heartbeat.mode == "running"
                    && heartbeat
                        .held_workspace_states
                        .iter()
                        .any(|state| state.reuse_key == reuse_key)
            },
        )
        .await,
        "the snapshot refreshed while draining should remain current after resume",
    );
    assert_eq!(
        observer_cache.held_state_root_scan_count(),
        1,
        "the post-resume routine heartbeat should reuse the refreshed snapshot",
    );

    wait_gate.release_one();
    assert!(
        env.handle
            .wait_completion(run_id, Duration::from_secs(5))
            .await
            .is_some(),
        "the gated run should complete after resume",
    );
    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn non_empty_initial_workspace_cache_is_heartbeated_before_the_routine_tick() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        "thread:initial-workspace-cache",
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());

    let run_handle = tokio::spawn(run(config));
    assert!(
        wait_heartbeat_matching_after(&env.handle, 0, Duration::from_secs(5), |heartbeat| {
            heartbeat
                .held_workspace_states
                .iter()
                .any(|state| state.reuse_key == "thread:initial-workspace-cache")
        })
        .await,
        "non-empty initial cache should be published before the deferred routine tick",
    );

    workspace_cache.reset_held_state_root_scan_count();
    let mut heartbeat_cursor = env.start_observer.cursor();
    for _ in 0..2 {
        let before = env.handle.heartbeat_count();
        tokio::time::advance(HEARTBEAT_PERIOD).await;
        heartbeat_cursor = env
            .start_observer
            .wait_routine_heartbeat_requested_after(
                heartbeat_cursor,
                RunnerMode::Running,
                Duration::from_secs(5),
            )
            .await;
        assert!(
            env.handle
                .wait_heartbeat_past(before, Duration::from_secs(5))
                .await,
            "routine heartbeat should still reach the provider",
        );
    }
    assert_eq!(
        workspace_cache.held_state_root_scan_count(),
        0,
        "healthy routine heartbeats should reuse the committed cache snapshot",
    );
    {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(
            heartbeats.last().is_some_and(|heartbeat| {
                heartbeat
                    .held_workspace_states
                    .iter()
                    .any(|state| state.reuse_key == "thread:initial-workspace-cache")
            }),
            "snapshot-only routine heartbeats should retain the initial cache capability",
        );
    }

    tokio::time::advance(WORKSPACE_CACHE_RECONCILIATION_INITIAL_DELAY - HEARTBEAT_PERIOD * 2).await;
    assert_eq!(
        workspace_cache
            .wait_for_held_state_root_scan_after(0, Duration::from_secs(5))
            .await,
        1,
        "independent reconciliation should scan once while the watcher remains healthy",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn drain_during_initial_cache_reconciliation_does_not_send_running_heartbeat() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        "thread:startup-drain-cache",
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let after_scan = StartLoopTestGate::default();
    config.test_hooks.after_initial_workspace_cache_scan = Some(after_scan.clone());

    let run_handle = tokio::spawn(run(config));
    after_scan
        .wait_entered(
            Duration::from_secs(5),
            "initial workspace-cache scan before lifecycle refresh",
        )
        .await;
    env.drain();
    after_scan.release();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "startup cache reconciliation should honor the live draining mode",
    )
    .await;
    let heartbeats = env
        .handle
        .heartbeats
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(
        heartbeats
            .iter()
            .all(|heartbeat| heartbeat.mode != "running"),
        "draining during startup cache reconciliation must not publish a stale running snapshot: {heartbeats:#?}",
    );
}

#[tokio::test]
async fn startup_unclassified_cache_invalidated_after_scan_is_reconciled() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let home = config.paths.home.clone();
    let group = config.runner.group.clone();
    let workspace_cache = WorkspaceImageCache::shared(runner_paths.clone(), &home, &group);
    let reuse_key = "thread:startup-cache-invalidation";
    let cache_key = runner_host::paths::scoped_workspace_image_cache_key(
        &group,
        "vm0/default",
        reuse_key,
        api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR,
        16 * 1024 * 1024,
    );
    let cache_entry = home.workspace_image_cache_dir().join(cache_key);
    tokio::fs::create_dir_all(&cache_entry).await.unwrap();
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let before_scan = StartLoopTestGate::default();
    let after_scan = StartLoopTestGate::default();
    config.test_hooks.before_initial_workspace_cache_scan = Some(before_scan.clone());
    config.test_hooks.after_initial_workspace_cache_scan = Some(after_scan.clone());

    let run_handle = tokio::spawn(run(config));
    before_scan
        .wait_entered(
            Duration::from_secs(5),
            "workspace-cache watcher setup before the initial scan",
        )
        .await;
    seed_workspace_cache_state(
        &workspace_cache,
        &runner_paths,
        reuse_key,
        "vm0/default",
        16 * 1024 * 1024,
    )
    .await;
    before_scan.release();

    after_scan
        .wait_entered(
            Duration::from_secs(5),
            "initial workspace-cache scan before watcher reconciliation",
        )
        .await;
    tokio::fs::remove_file(cache_entry.join("metadata.json"))
        .await
        .unwrap();
    after_scan.release();

    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(5))
            .await,
        "startup reconciliation should publish the refreshed cache state",
    );
    let first_heartbeat = env
        .handle
        .heartbeats
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .first()
        .cloned()
        .unwrap();
    assert!(
        first_heartbeat
            .held_workspace_states
            .iter()
            .all(|state| state.reuse_key != reuse_key),
        "the first heartbeat must not advertise a cache invalidated after the initial scan",
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn unavailable_workspace_cache_watcher_uses_periodic_reconciliation() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 8, 32768, 4);
    let home = config.paths.home.clone();
    let group = config.runner.group.clone();
    let cache_root = home.workspace_image_cache_dir();
    tokio::fs::write(&cache_root, b"not a directory")
        .await
        .unwrap();
    let workspace_cache = WorkspaceImageCache::shared(
        RunnerPaths::new(config.paths.base_dir.clone()),
        &home,
        &group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());

    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    workspace_cache.reset_held_state_root_scan_count();

    tokio::fs::remove_file(cache_root).await.unwrap();
    let runner_paths = RunnerPaths::new(env._temp_dir.path().join("fallback-publisher"));
    tokio::fs::create_dir_all(runner_paths.base_dir())
        .await
        .unwrap();
    let publisher_cache = WorkspaceImageCache::shared(runner_paths.clone(), &home, &group);
    seed_workspace_cache_state(
        &publisher_cache,
        &runner_paths,
        "thread:routine-fallback",
        "vm0/default",
        1024 * 1024,
    )
    .await;
    let before = env.handle.heartbeat_count();
    let mut heartbeat_cursor = env.start_observer.cursor();
    for _ in 0..2 {
        tokio::time::advance(HEARTBEAT_PERIOD).await;
        heartbeat_cursor = env
            .start_observer
            .wait_routine_heartbeat_requested_after(
                heartbeat_cursor,
                RunnerMode::Running,
                Duration::from_secs(5),
            )
            .await;
    }
    assert_eq!(
        workspace_cache.held_state_root_scan_count(),
        0,
        "ordinary heartbeats should not provide failed-watcher reconciliation",
    );

    tokio::time::advance(WORKSPACE_CACHE_RECONCILIATION_INITIAL_DELAY - HEARTBEAT_PERIOD * 2).await;
    assert!(
        wait_heartbeat_matching_after(&env.handle, before, Duration::from_secs(5), |heartbeat| {
            heartbeat
                .held_workspace_states
                .iter()
                .any(|state| state.reuse_key == "thread:routine-fallback")
        })
        .await,
        "periodic reconciliation must converge after watcher setup failure",
    );
    assert_eq!(workspace_cache.held_state_root_scan_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn workspace_cache_promotion_triggers_immediate_heartbeat_without_park() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let runner_paths = runner_host::paths::RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = crate::workspace_image_cache::WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    let run_id = RunId::new_v4();
    let provider_session_id = "provider-session-cache-heartbeat";
    let reuse_key = "thread:cache-heartbeat";
    let expected_workspace = WorkspaceCacheCapability {
        profile: "vm0/default".to_string(),
        workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
    };
    let mut ctx = context_with_session(run_id, provider_session_id);
    ctx.reuse_key = Some(reuse_key.into());
    push_job(&env, run_id, "vm0/default", Some(ctx));

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before test writes active workspace image");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    assert!(env.parking_gate.soft_drain());
    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    let completion = completion.expect("job should complete");
    assert_eq!(completion.exit_code, 1);
    assert_eq!(
        env.idle_pool.lock().await.len(),
        0,
        "soft-drained parking gate should prevent sandbox parking",
    );

    assert!(
        wait_heartbeat_matching_after(&env.handle, before, Duration::from_secs(5), |heartbeat| {
            heartbeat.held_workspace_states.iter().any(|state| {
                state.reuse_key == reuse_key && state.workspace_caches.contains(&expected_workspace)
            })
        },)
        .await,
        "immediate heartbeat should advertise the promoted workspace cache",
    );
    assert!(env.parking_gate.open_after_soft_drain());

    let second_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(second_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let second_before = env.handle.heartbeat_count();
    let second_run_id = RunId::new_v4();
    let mut second_context = context_with_session(second_run_id, provider_session_id);
    second_context.reuse_key = Some(reuse_key.into());
    push_job(&env, second_run_id, "vm0/default", Some(second_context));
    second_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("second wait_process should enter before heartbeat assertion");
    let omitted_active_workspace = wait_heartbeat_matching_after(
        &env.handle,
        second_before,
        Duration::from_secs(5),
        |heartbeat| {
            heartbeat
                .held_workspace_states
                .iter()
                .all(|state| state.reuse_key != reuse_key)
        },
    )
    .await;
    let post_claim_heartbeats = {
        let heartbeats = env
            .handle
            .heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        heartbeats[second_before..].to_vec()
    };
    assert!(
        omitted_active_workspace,
        "post-claim heartbeat should stop advertising the active workspace cache; heartbeats: {post_claim_heartbeats:?}",
    );
    overrides.clear_wait_process_lifecycle_gate();
    second_gate.release_one();
    let second_completion = env
        .handle
        .wait_completion(second_run_id, Duration::from_secs(5))
        .await
        .expect("second job should complete");
    assert_eq!(second_completion.exit_code, 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn workspace_promotion_mismatch_destroys_stale_idle_sandbox_and_fresh_creates() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());
    let provider_session_id = "sess-workspace-promotion-mismatch";
    let reuse_key = "thread:workspace-promotion-mismatch";
    let stale_sandbox_id = seed_idle_pool_with_workspace_promotion(
        &idle_pool,
        &budget,
        &workspace_cache,
        &runner_paths,
        WorkspacePromotionSeedSpec {
            reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            image_size_bytes: 16 * 1024 * 1024,
        },
    )
    .await;

    let run_handle = tokio::spawn(run(config));
    let run_id = RunId::new_v4();
    let mut context = context_with_session(run_id, provider_session_id);
    context.reuse_key = Some(reuse_key.into());
    env.provider.set_claim_result(run_id, Some(context));
    env.handle
        .discover_tx
        .send(reusable_candidate(run_id, "vm0/default", reuse_key))
        .unwrap();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::PoolMiss));
    assert_ne!(
        completion.sandbox_id,
        Some(stale_sandbox_id),
        "workspace promotion mismatch should force a fresh sandbox"
    );
    wait_idle_pool_reuse_keys(&idle_pool, &[reuse_key], Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert!(
        workspace_cache.held_workspace_states().await.is_empty(),
        "mismatched stale idle sandbox must be destroyed without publishing its workspace image"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn reuse_take_preserves_cached_workspace_snapshot_state() {
    let wait_gate = sandbox_mock::MockLifecycleGate::new();
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(wait_gate.clone());
    overrides.push_wait_process_exit(sandbox::ProcessExit::new(1, 1, Vec::new(), Vec::new()));
    let reuse_wait_gate = sandbox_mock::MockLifecycleGate::new();
    let reuse_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&reuse_overrides);
    reuse_overrides.set_wait_process_lifecycle_gate(reuse_wait_gate.clone());

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().workspace_disk_mb = 16;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 32768, 4, Arc::clone(&overrides));
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let runner_paths = RunnerPaths::new(config.paths.base_dir.clone());
    let workspace_cache = WorkspaceImageCache::shared(
        runner_paths.clone(),
        &config.paths.home,
        &config.runner.group,
    );
    Arc::get_mut(&mut config.exec_config)
        .unwrap()
        .workspace_cache = Some(workspace_cache.clone());

    seed_idle_pool_with_overrides(
        &idle_pool,
        &budget,
        &reuse_overrides,
        "sess-refresh",
        "vm0/default",
        2,
        4096,
    )
    .await;

    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    let promotion_heartbeat_count = env.handle.heartbeat_count();
    let expected_workspace = WorkspaceCacheCapability {
        profile: "vm0/default".to_string(),
        workspace_affinity_version: WORKSPACE_AFFINITY_VERSION,
    };

    let cache_run_id = RunId::new_v4();
    push_job(
        &env,
        cache_run_id,
        "vm0/default",
        Some(context_with_session(cache_run_id, "sess-cached")),
    );

    wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("wait_process should enter before test writes active workspace image");
    let sandbox_id = overrides
        .create_configs()
        .into_iter()
        .next()
        .expect("sandbox create config should be recorded before wait_process entry")
        .id;
    let active_image = runner_paths.active_workspace_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    let file = tokio::fs::File::create(&active_image).await.unwrap();
    file.set_len(16 * 1024 * 1024).await.unwrap();
    drop(file);

    assert!(env.parking_gate.soft_drain());
    overrides.clear_wait_process_lifecycle_gate();
    wait_gate.release_one();
    let cache_completion = env
        .handle
        .wait_completion(cache_run_id, Duration::from_secs(5))
        .await
        .expect("cache seed job should complete");
    assert_eq!(cache_completion.exit_code, 1);
    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            promotion_heartbeat_count,
            Duration::from_secs(5),
            |heartbeat| {
                heartbeat.held_workspace_states.iter().any(|state| {
                    state.reuse_key == "sess-cached"
                        && state.workspace_caches.contains(&expected_workspace)
                })
            },
        )
        .await,
        "workspace cache promotion should advertise the expected workspace before claim"
    );
    assert!(env.parking_gate.open_after_soft_drain());
    let reuse_heartbeat_count = env.handle.heartbeat_count();
    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-refresh")),
    );
    reuse_wait_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .expect("reused wait_process should enter before the post-take heartbeat assertion");
    assert!(
        wait_heartbeat_matching_after(
            &env.handle,
            reuse_heartbeat_count,
            Duration::from_secs(5),
            |heartbeat| {
                let has_expected_workspace = heartbeat.held_workspace_states.iter().any(|state| {
                    state.reuse_key == "sess-cached"
                        && state.workspace_caches.contains(&expected_workspace)
                });
                let omits_claimed_sandbox = heartbeat
                    .held_sandbox_states
                    .iter()
                    .all(|state| state.reuse_key != "sess-refresh");
                has_expected_workspace && omits_claimed_sandbox
            },
        )
        .await,
        "idle take should preserve the unrelated cached workspace in the immediate heartbeat"
    );
    reuse_overrides.clear_wait_process_lifecycle_gate();
    reuse_wait_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("job should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    wait_idle_pool_reuse_keys(&idle_pool, &["sess-refresh"], Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}
