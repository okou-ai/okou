use super::local_home::publish_home;
use super::*;
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(10);

#[tokio::test]
async fn selected_exact_advice_consumes_ready_predecessor_home() {
    assert_source_continuity(true, false, false).await;
}

#[tokio::test]
async fn selected_exact_candidate_retries_after_predecessor_home_publication() {
    assert_source_continuity(false, false, false).await;
}

#[tokio::test]
async fn selected_exact_candidate_retries_on_capacity_after_home_ready() {
    assert_source_continuity(true, true, false).await;
}

#[tokio::test]
async fn selected_exact_candidate_rechecks_home_after_watcher_loss() {
    assert_source_continuity(false, false, true).await;
}

#[tokio::test]
async fn selected_exact_candidate_rechecks_busy_home_after_unlock_without_event() {
    use crate::home_image_cache::{
        HomeCacheTerminalStatus, HomeImageLeaseIdentity, HomeImageLeaseRequest,
        HomeImagePromotionOutcome, HomeImagePromotionRequest,
    };
    use crate::storage_fingerprints::StorageFingerprints;

    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 2, 8192, 1, overrides.clone());
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
    let budget = config.capacity.budget.clone();
    let cache_dir = config.paths.home.home_image_cache_dir();
    let rootfs_hash = config.runner.profiles["vm0/default"].rootfs_hash.clone();
    let publisher = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let source = RunId::new_v4();
    let successor = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = "thread:exact-busy-home";
    let lease = publisher
        .lease_active(HomeImageLeaseRequest {
            identity: HomeImageLeaseIdentity {
                run_id: source,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: &rootfs_hash,
                reuse_key: Some(key),
                working_dir: "/home/user/workspace",
                image_size_bytes: 1024 * 1024,
            },
            home_drive_available: true,
        })
        .await;
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, vec![0x5a; 1024 * 1024])
        .await
        .unwrap();
    let publication = lease
        .into_promotion_context(HomeImagePromotionRequest {
            run_id: source,
            sandbox_id,
            restored_session_identity: None,
            terminal_status: HomeCacheTerminalStatus::Success,
            completed_at: "2026-10-27T10:00:00Z".into(),
            storage_fingerprints: StorageFingerprints::default(),
        })
        .unwrap();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let moved = cache_dir.with_extension("moved");
    tokio::fs::rename(&cache_dir, &moved).await.unwrap();
    tokio::fs::rename(&moved, &cache_dir).await.unwrap();
    assert_eq!(
        publication.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    env.provider
        .set_claim_result(successor, Some(context_with_reuse_key(successor, key)));
    let candidate = exact_source_preference_candidate(successor, key, source);
    let deadline = candidate.runner_preference().unwrap().deadline();
    env.handle.discover_tx.send(candidate).unwrap();
    assert!(env.handle.wait_deferred_poll_count(1, WAIT).await);
    assert!(env.handle.claim_candidates().is_empty());
    assert_eq!(budget.allocated(), (0, 0, 0));
    // flock unlock emits no filesystem event, and the directory watch was lost.
    drop(publication);
    execution.wait_entered(1, WAIT).await.unwrap();
    let claims = env.handle.claim_candidates();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].runner_preference().unwrap().deadline(), deadline);
    let replacements = overrides.home_drive_replacements();
    assert_eq!(replacements.len(), 1);
    let seed = replacements[0].seed_image.as_ref().unwrap();
    let seed_path = match seed {
        sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => path,
    };
    assert_eq!(
        tokio::fs::read(seed_path).await.unwrap(),
        vec![0x5a; 1024 * 1024]
    );
    execution.release_one();
    assert_eq!(
        env.handle
            .wait_completion(successor, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn multiple_exact_candidates_wait_without_blocking_unrelated_work() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 8, 32768, 4, overrides);
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let sources = [RunId::new_v4(), RunId::new_v4()];
    let peers = [RunId::new_v4(), RunId::new_v4()];
    let keys = ["thread:first-transition", "thread:second-transition"];
    for index in 0..2 {
        env.provider.set_claim_result(
            peers[index],
            Some(context_with_reuse_key(peers[index], keys[index])),
        );
        env.handle
            .discover_tx
            .send(exact_source_preference_candidate(
                peers[index],
                keys[index],
                sources[index],
            ))
            .unwrap();
    }
    let unrelated = RunId::new_v4();
    push_job(
        &env,
        unrelated,
        "vm0/default",
        Some(minimal_context(unrelated)),
    );
    execution.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(env.handle.claim_candidates().len(), 1);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    for index in 0..2 {
        publish_home(&cache, &paths, keys[index], sources[index]).await;
        execution
            .wait_entered((index + 2).try_into().unwrap(), WAIT)
            .await
            .unwrap();
    }
    assert!(peers.iter().all(|run_id| {
        env.handle
            .claim_candidates()
            .iter()
            .any(|candidate| candidate.run_id() == *run_id)
    }));
    execution.release_many(3);
    for run_id in peers.into_iter().chain([unrelated]) {
        assert_eq!(
            env.handle
                .wait_completion(run_id, WAIT)
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn selected_exact_wait_cannot_consume_a_different_predecessor_home() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let (mut config, env) = mock_run_config(profiles, 2, 8192, 1);
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let key = "thread:other-predecessor";
    publish_home(&cache, &paths, key, RunId::new_v4()).await;
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    env.handle
        .discover_tx
        .send(exact_source_preference_candidate(
            RunId::new_v4(),
            key,
            RunId::new_v4(),
        ))
        .unwrap();
    assert!(env.handle.wait_deferred_poll_count(1, WAIT).await);
    assert!(env.handle.claim_candidates().is_empty());
    shutdown(&env, runner).await;
}

async fn assert_source_continuity(published: bool, capacity_blocked: bool, lose_watcher: bool) {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 2, 8192, 1, overrides.clone());
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let budget = config.capacity.budget.clone();
    let cache_dir = config.paths.home.home_image_cache_dir();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    if lose_watcher {
        let moved = cache_dir.with_extension("moved");
        tokio::fs::rename(&cache_dir, &moved).await.unwrap();
        tokio::fs::rename(&moved, &cache_dir).await.unwrap();
    }
    let blocker = RunId::new_v4();
    if capacity_blocked {
        push_job(
            &env,
            blocker,
            "vm0/default",
            Some(context_with_reuse_key(blocker, "thread:other-owner")),
        );
        execution.wait_entered(1, WAIT).await.unwrap();
    }
    let key = "thread:exact-source-transition";
    let source = RunId::new_v4();
    let successor = RunId::new_v4();
    if published {
        publish_home(&cache, &paths, key, source).await;
    }
    env.provider
        .set_claim_result(successor, Some(context_with_reuse_key(successor, key)));
    let candidate = exact_source_preference_candidate(successor, key, source);
    let original_deadline = candidate.runner_preference().unwrap().deadline();
    env.handle.discover_tx.send(candidate).unwrap();
    if !published || capacity_blocked {
        assert!(env.handle.wait_deferred_poll_count(1, WAIT).await);
        assert!(
            !env.handle
                .claim_candidates()
                .iter()
                .any(|candidate| candidate.run_id() == successor)
        );
    }
    if !published {
        publish_home(&cache, &paths, key, source).await;
    }
    if capacity_blocked {
        assert_eq!(budget.allocated(), (2, 4096, 1));
        execution.release_one();
        assert_eq!(
            env.handle
                .wait_completion(blocker, WAIT)
                .await
                .unwrap()
                .exit_code,
            0
        );
    }
    execution
        .wait_entered(if capacity_blocked { 2 } else { 1 }, WAIT)
        .await
        .unwrap();
    let claims = env.handle.claim_candidates();
    let claimed = claims
        .iter()
        .find(|candidate| candidate.run_id() == successor)
        .unwrap();
    assert_eq!(
        claimed.runner_preference().unwrap().deadline(),
        original_deadline
    );
    let replacements = overrides.home_drive_replacements();
    assert_eq!(replacements.len(), 1);
    let home = &replacements[0];
    let seed = match home
        .seed_image
        .as_ref()
        .expect("the exact predecessor must supply Home bytes")
    {
        sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => path,
    };
    assert_eq!(
        tokio::fs::read(seed).await.unwrap(),
        vec![0x5a; 1024 * 1024]
    );
    execution.release_one();
    assert_eq!(
        env.handle
            .wait_completion(successor, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}
