use super::super::super::support::MockRunEnv;
use super::*;
use crate::reactor::claim_tasks::MAX_IN_FLIGHT_CLAIMS;
use sandbox_mock::{MockLifecycleGate, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(10);

fn source_home_candidate(
    run_id: RunId,
    key: &str,
    source_run_id: RunId,
) -> runner_provider::JobCandidate {
    // Exercise the activated API/Ably wire reader before entering the actual
    // two-reactor claim/publication/locked-checkout lifecycle below.
    let preference = runner_provider::parse_runner_preference(Some(serde_json::json!({
        "kind": "preference",
        "tier": "sourceHome",
        "sourceRunId": source_run_id,
        "home": {
            "evidence": "expected",
            "homeWaitUntil": (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339(),
        },
        "runnerIdentity": {
            "runnerId": TEST_RUNNER_ID,
            "heartbeatGeneration": TEST_HEARTBEAT_GENERATION,
        },
        "expiresAt": (chrono::Utc::now() + chrono::Duration::seconds(2)).to_rfc3339(),
    })))
    .unwrap();
    runner_provider::JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(key.into()))
        .with_parsed_runner_preference_context(preference)
}

async fn wait_owned_home(env: &MockRunEnv, run_id: RunId) {
    let owned = tokio::time::timeout(WAIT, async {
        loop {
            let cursor = env.handle.heartbeat_count();
            // This is emitted only after successful provider ownership and the
            // claimed activation guard's registration, not pre-claim admission.
            if env
                .handle
                .heartbeats
                .lock()
                .unwrap()
                .iter()
                .any(|heartbeat| {
                    heartbeat
                        .active_reuse_producers
                        .iter()
                        .any(|p| p.run_id == run_id)
                })
            {
                return;
            }
            assert!(env.handle.wait_heartbeat_past(cursor, WAIT).await);
        }
    })
    .await;
    assert!(
        owned.is_ok(),
        "claimed peer {run_id} must become owned work before publication: claims={:?}, active={}, heartbeat={:?}",
        env.handle
            .claim_candidates()
            .iter()
            .map(|candidate| candidate.run_id())
            .collect::<Vec<_>>(),
        env.active_runs.contains(run_id),
        env.handle.heartbeats.lock().unwrap().last(),
    );
}

fn enable_cache(config: &mut RunConfig) -> (HomeImageCache, RunnerPaths) {
    config.capacity.max_idle = 0;
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let executor = Arc::get_mut(&mut config.exec_config).unwrap();
    executor.home_cache = Some(cache.clone());
    executor.runner_hostname = Some("shared-peer-host.example.test".into());
    (cache, paths)
}

#[tokio::test]
async fn peer_claims_before_draining_producer_publication_and_consumes_seed_bytes() {
    assert_late_draining_publication(false, false).await;
}

#[tokio::test]
async fn soft_draining_receiver_keeps_claimed_wait_and_consumes_peer_publication() {
    assert_late_draining_publication(true, false).await;
}

#[tokio::test]
async fn peer_claim_revalidates_source_home_when_watcher_is_lost() {
    assert_late_draining_publication(false, true).await;
}

#[tokio::test]
async fn soft_draining_receiver_revalidates_peer_home_when_watcher_is_lost() {
    assert_late_draining_publication(true, true).await;
}

#[tokio::test]
async fn peer_rechecks_a_busy_publication_after_unlock_without_another_watch_event() {
    assert_busy_publication_rechecked(HomeClaimTiming::Expected).await;
}

#[tokio::test]
async fn source_home_location_waits_for_a_busy_home_and_consumes_it_after_unlock() {
    assert_busy_publication_rechecked(HomeClaimTiming::Location).await;
}

#[tokio::test]
async fn claimed_home_wait_outlives_routing_expiry_and_consumes_late_publication() {
    assert_busy_publication_rechecked(HomeClaimTiming::PublicationAfterRoutingExpiry).await;
}

#[tokio::test]
async fn claim_response_after_routing_expiry_retains_publication_allowance() {
    assert_busy_publication_rechecked(HomeClaimTiming::ClaimAfterRoutingExpiry).await;
}

#[derive(Clone, Copy)]
enum HomeClaimTiming {
    Expected,
    Location,
    PublicationAfterRoutingExpiry,
    ClaimAfterRoutingExpiry,
}

async fn advance_past_routing_expiry() {
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3)).await;
    tokio::time::resume();
}

async fn assert_busy_publication_rechecked(timing: HomeClaimTiming) {
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
    let (cache, paths) = enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let cache_dir = config.paths.home.home_image_cache_dir();
    let rootfs_hash = config.runner.profiles["vm0/default"].rootfs_hash.clone();
    // Independent cache ownership matches the other process's local wakeups.
    let publisher = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let source = RunId::new_v4();
    let sandbox_id = sandbox::SandboxId::new_v4();
    let key = "thread:peer-unlocked-without-event";
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
    let image = vec![0x5a; 1024 * 1024];
    let active_image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, &image).await.unwrap();
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
    let successor = RunId::new_v4();
    env.provider
        .set_claim_result(successor, Some(context_with_reuse_key(successor, key)));
    if matches!(timing, HomeClaimTiming::ClaimAfterRoutingExpiry) {
        env.handle.block_claim(successor);
    }
    env.handle
        .discover_tx
        .send(if matches!(timing, HomeClaimTiming::Location) {
            ranked_candidate(
                successor,
                Some(key),
                runner_provider::RunnerPreferenceTarget::SourceHome(
                    source,
                    runner_provider::SourceHomeObservation::Location,
                ),
                TEST_RUNNER_ID,
                TEST_HEARTBEAT_GENERATION,
            )
        } else {
            source_home_candidate(successor, key, source)
        })
        .unwrap();
    if matches!(timing, HomeClaimTiming::ClaimAfterRoutingExpiry) {
        assert!(env.handle.wait_run_claim_in_flight(successor, WAIT).await);
        advance_past_routing_expiry().await;
        env.handle.unblock_claim(successor);
    }
    wait_owned_home(&env, successor).await;
    if matches!(timing, HomeClaimTiming::PublicationAfterRoutingExpiry) {
        advance_past_routing_expiry().await;
    }
    let scans = cache.held_state_root_scan_count();
    assert_eq!(
        publication.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    let cursor = env.start_observer.cursor();
    env.start_observer.wait_after(cursor, WAIT, "busy peer source validation", &mut |event| {
        matches!(event, crate::reactor::StartLoopEvent::SourceHomeRecheckCompleted { run_id, ready: false } if *run_id == successor).then_some(())
    }).await;
    assert!(
        overrides.create_configs().is_empty(),
        "published bytes remain exclusively owned until unlock"
    );
    drop(publication);
    execution.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(
        cache.held_state_root_scan_count(),
        scans,
        "the claimed recheck must not require another full inventory scan"
    );
    let created = overrides.create_configs();
    let seed = created[0]
        .home_drive
        .as_ref()
        .unwrap()
        .seed_image
        .as_ref()
        .unwrap();
    let seed_path = match seed {
        sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => path,
    };
    assert_eq!(tokio::fs::read(seed_path).await.unwrap(), image);
    assert_eq!(env.handle.claim_candidates().len(), 1);
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

async fn assert_late_draining_publication(drain_receiver: bool, lose_watcher: bool) {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let source_overrides = Arc::new(MockSandboxOverrides::new());
    let source_execution = MockLifecycleGate::new();
    source_overrides.set_wait_process_lifecycle_gate(source_execution.clone());
    let (mut source, source_env) =
        mock_run_config_with_overrides(profiles.clone(), 4, 16384, 2, source_overrides.clone());
    source.runner.identity = RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 19).unwrap();
    let shared_home = source.paths.home.clone();
    let shared_cache_dir = shared_home.home_image_cache_dir();
    let (source_cache, source_paths) = enable_cache(&mut source);
    let source_task = tokio::spawn(run(source));
    wait_discover_entered(&source_env, WAIT).await;
    let key = "thread:draining-peer-publication";
    let predecessor = RunId::new_v4();
    push_job(
        &source_env,
        predecessor,
        "vm0/default",
        Some(context_with_reuse_key(predecessor, key)),
    );
    source_execution.wait_entered(1, WAIT).await.unwrap();
    let source_sandbox = source_overrides.create_configs()[0].id;
    let mut image = vec![0; 1024 * 1024];
    let marker = b"published by the other draining runner";
    image[..marker.len()].copy_from_slice(marker);
    let active_image = source_paths.active_home_image(&source_sandbox);
    tokio::fs::create_dir_all(active_image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&active_image, &image).await.unwrap();

    // Hold the external Guest preparation boundary after execution, keeping
    // the actual source finalization alive with no committed home yet.
    let publication = MockLifecycleGate::new();
    source_overrides.set_exec_lifecycle_gate(publication.clone());
    source_env.drain();
    source_execution.release_one();
    publication.wait_entered(1, WAIT).await.unwrap();
    assert_eq!(
        source_env
            .handle
            .wait_completion(predecessor, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert!(source_cache.held_home_states().await.is_empty());

    let receiver_overrides = Arc::new(MockSandboxOverrides::new());
    let receiver_execution = MockLifecycleGate::new();
    receiver_overrides.set_wait_process_lifecycle_gate(receiver_execution.clone());
    let (mut receiver, receiver_env) =
        mock_run_config_with_overrides(profiles, 4, 16384, 2, receiver_overrides.clone());
    receiver.paths.home = shared_home.clone();
    Arc::get_mut(&mut receiver.exec_config).unwrap().home = shared_home;
    enable_cache(&mut receiver);
    let budget = receiver.capacity.budget.clone();
    let receiver_status = receiver_env._temp_dir.path().join("status.json");
    let receiver_task = tokio::spawn(run(receiver));
    wait_discover_entered(&receiver_env, WAIT).await;
    let successor = RunId::new_v4();
    receiver_env
        .provider
        .set_claim_result(successor, Some(context_with_reuse_key(successor, key)));
    receiver_env
        .handle
        .discover_tx
        .send(source_home_candidate(successor, key, predecessor))
        .unwrap();
    wait_owned_home(&receiver_env, successor).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(
        receiver_overrides.create_configs().is_empty(),
        "claim must precede home readiness and sandbox creation"
    );
    assert!(source_cache.held_home_states().await.is_empty());
    if drain_receiver {
        receiver_env.drain();
        wait_status_mode(&receiver_status, "draining", WAIT).await;
    }
    if lose_watcher {
        // Moving the real watched directory invalidates inotify's root watch.
        // Restore the same inode before publishing: authoritative cache bytes
        // stay available, but the receiver cannot rely on a later watch event.
        let moved_cache_dir = shared_cache_dir.with_extension("moved");
        tokio::fs::rename(&shared_cache_dir, &moved_cache_dir)
            .await
            .unwrap();
        tokio::fs::rename(&moved_cache_dir, &shared_cache_dir)
            .await
            .unwrap();
    }
    publication.release_many(usize::MAX);
    receiver_execution
        .wait_entered(1, WAIT)
        .await
        .expect("publication must wake the claimed receiver, including during drain");
    let created = receiver_overrides.create_configs();
    assert_eq!(created.len(), 1);
    let seed = created[0]
        .home_drive
        .as_ref()
        .unwrap()
        .seed_image
        .as_ref()
        .expect("actual cached seed required");
    let seed_path = match seed {
        sandbox::HomeDriveSeedImage::Move(path) | sandbox::HomeDriveSeedImage::Copy(path) => path,
    };
    assert_eq!(
        tokio::fs::read(seed_path).await.unwrap(),
        image,
        "the locked checkout must preserve the source's real bytes"
    );
    assert_eq!(receiver_env.handle.claim_candidates().len(), 1);
    receiver_execution.release_one();
    assert_eq!(
        receiver_env
            .handle
            .wait_completion(successor, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&receiver_env, receiver_task).await;
    assert_run_exits_within(
        source_task,
        WAIT,
        "draining source must finish after publication",
    )
    .await;
    source_env.shutdown_startup_api().await;
    for env in [&source_env, &receiver_env] {
        assert!(env.handle.heartbeats.lock().unwrap().iter().all(|state| {
            state.runner_hostname.as_deref() == Some("shared-peer-host.example.test")
        }));
    }
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test(start_paused = true)]
async fn peer_wait_expiry_keeps_the_claim_and_reserved_fallback_capacity() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 2, 8192, 1, overrides.clone());
    let (cache, paths) = enable_cache(&mut config);
    let key = "thread:peer-expiry";
    seed_home_cache_state(&cache, &paths, key, "vm0/default", 1024 * 1024).await;
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, RunId::new_v4()))
        .unwrap();
    wait_owned_home(&env, run_id).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(overrides.create_configs().is_empty());
    tokio::time::advance(Duration::from_secs(31)).await;
    let completion = env
        .handle
        .wait_completion(run_id, WAIT)
        .await
        .expect("expiry must start ordinarily on the owning runner");
    assert_eq!(completion.exit_code, 0);
    assert_eq!(env.handle.claim_candidates().len(), 1);
    assert_eq!(overrides.create_configs().len(), 1);
    assert!(
        overrides.create_configs()[0]
            .home_drive
            .as_ref()
            .unwrap()
            .seed_image
            .is_some(),
        "expiry must preserve compatible-home fallback when its producer differs"
    );
    shutdown(&env, runner).await;
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[tokio::test]
async fn peer_waits_release_rpc_slots_and_cancellation_settles_every_owned_run() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 32, 131072, 16, overrides.clone());
    enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let mut runs = Vec::new();
    for i in 0..MAX_IN_FLIGHT_CLAIMS + 2 {
        let run_id = RunId::new_v4();
        let key = format!("thread:peer-wait-{i}");
        env.provider
            .set_claim_result(run_id, Some(context_with_reuse_key(run_id, &key)));
        let candidate = source_home_candidate(run_id, &key, RunId::new_v4());
        env.handle.discover_tx.send(candidate.clone()).unwrap();
        wait_owned_home(&env, run_id).await;
        env.handle.discover_tx.send(candidate).unwrap();
        runs.push(run_id);
    }
    // A large host also funds background blank inventory. Every peer must keep
    // ordinary admitted capacity while no waiting peer starts an agent process.
    assert!(budget.allocated().2 >= runs.len());
    assert!(budget.allocated().2 <= 16);
    assert!(overrides.start_agent_process_calls().is_empty());
    let ordinary = RunId::new_v4();
    push_job(
        &env,
        ordinary,
        "vm0/default",
        Some(minimal_context(ordinary)),
    );
    assert_eq!(
        env.handle
            .wait_completion(ordinary, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    for run_id in &runs {
        assert_eq!(
            env.handle
                .claim_candidates()
                .iter()
                .filter(|c| c.run_id() == *run_id)
                .count(),
            1
        );
        wait_cancel_handle(&env.cancel_tokens, *run_id, WAIT)
            .await
            .request_hard_cancellation()
            .await;
        let done = env.handle.wait_completion(*run_id, WAIT).await.unwrap();
        assert_eq!(done.exit_code, 137);
        assert!(done.sandbox_id.is_none());
    }
    shutdown(&env, runner).await;
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(budget.allocated(), (0, 0, 0));
    assert_eq!(env.handle.completions.lock().unwrap().len(), runs.len() + 1);
}

#[tokio::test(start_paused = true)]
async fn peer_activation_panic_recovers_the_claim_and_waiting_capacity() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    let (mut config, env) =
        mock_run_config_with_overrides(test_profiles(), 2, 8192, 1, overrides.clone());
    enable_cache(&mut config);
    config.test_hooks.outer_job_panic = Some(OuterJobPanicPoint::ClaimedActivation);
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let run_id = RunId::new_v4();
    let key = "thread:peer-activation-panic";
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, RunId::new_v4()))
        .unwrap();
    wait_owned_home(&env, run_id).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    tokio::time::advance(Duration::from_secs(31)).await;
    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(
        completion.error.as_deref(),
        Some("source Home activation panicked")
    );
    assert!(completion.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
    assert!(!env.active_runs.contains(run_id));
    assert!(overrides.create_configs().is_empty());
    shutdown(&env, runner).await;
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn rejected_peer_claim_releases_its_ordinary_resource_and_never_waits() {
    let (mut config, env) = mock_run_config(test_profiles(), 2, 8192, 1);
    enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let rejected = RunId::new_v4();
    env.handle.block_claim(rejected);
    env.provider.set_claim_result(rejected, None);
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    env.handle
        .discover_tx
        .send(source_home_candidate(
            rejected,
            "thread:rejected-peer",
            RunId::new_v4(),
        ))
        .unwrap();
    assert!(env.handle.wait_run_claim_in_flight(rejected, WAIT).await);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    env.handle.unblock_claim(rejected);
    wait_cancel_token_removed(&env.cancel_tokens, rejected, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
    let ordinary = RunId::new_v4();
    push_job(
        &env,
        ordinary,
        "vm0/default",
        Some(minimal_context(ordinary)),
    );
    assert_eq!(
        env.handle
            .wait_completion(ordinary, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert!(
        env.handle
            .wait_completion(rejected, Duration::ZERO)
            .await
            .is_none()
    );
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn unconsumed_peer_claim_result_completes_and_releases_capacity_when_reactor_drops() {
    let (mut config, env) = mock_run_config(test_profiles(), 4, 16384, 2);
    enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let run_id = RunId::new_v4();
    let key = "thread:unconsumed-peer-result";
    env.handle.block_claim(run_id);
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, RunId::new_v4()))
        .unwrap();
    let mut reactor = Box::pin(run(config));
    tokio::select! {
        result = &mut reactor => panic!("reactor exited before claim: {result:?}"),
        entered = env.handle.wait_run_claim_in_flight(run_id, WAIT) => assert!(entered),
    }
    // Do not poll Reactor again: the independent RPC task must still produce
    // guarded custody, and dropping its unconsumed result must settle it.
    env.handle.unblock_claim(run_id);
    assert!(env.handle.wait_claim_in_flight(0, WAIT).await);
    assert!(env.active_runs.contains(run_id));
    assert_eq!(budget.allocated(), (2, 4096, 1));
    drop(reactor);
    let done = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_ne!(done.exit_code, 0);
    assert!(done.sandbox_id.is_none());
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
    assert!(!env.active_runs.contains(run_id));
    assert_eq!(env.handle.completions.lock().unwrap().len(), 1);
    env.shutdown_startup_api().await;
}

#[tokio::test]
async fn hard_stop_cancels_and_joins_a_claimed_peer_wait_before_shutdown() {
    let (mut config, env) = mock_run_config(test_profiles(), 4, 16384, 2);
    enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let run_id = RunId::new_v4();
    let key = "thread:hard-stop-peer-wait";
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, RunId::new_v4()))
        .unwrap();
    wait_owned_home(&env, run_id).await;
    env.trigger_stopping().await;
    let done = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(done.exit_code, 137);
    assert!(done.sandbox_id.is_none());
    assert_run_exits_within(runner, WAIT, "hard stop must join the claimed cache waiter").await;
    env.shutdown_startup_api().await;
    wait_budget_count(&budget, 0, WAIT).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
}

#[tokio::test]
async fn peer_preference_cannot_claim_against_another_runs_full_local_capacity() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let executing = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(executing.clone());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 2, 8192, 1, overrides);
    enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let blocker = RunId::new_v4();
    push_job(
        &env,
        blocker,
        "vm0/default",
        Some(context_with_reuse_key(
            blocker,
            "thread:unrelated-capacity-owner",
        )),
    );
    executing.wait_entered(1, WAIT).await.unwrap();
    let peer = RunId::new_v4();
    let key = "thread:capacity-gated-peer";
    env.provider
        .set_claim_result(peer, Some(context_with_reuse_key(peer, key)));
    env.handle
        .discover_tx
        .send(source_home_candidate(peer, key, RunId::new_v4()))
        .unwrap();
    assert!(env.handle.wait_deferred_poll_count(1, WAIT).await);
    assert_eq!(
        env.handle.claim_candidates().len(),
        1,
        "the peer needs its own lease even when an unrelated ActiveRun proof exists"
    );
    assert_eq!(budget.allocated(), (2, 4096, 1));
    executing.release_one();
    assert_eq!(
        env.handle
            .wait_completion(blocker, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    wait_owned_home(&env, peer).await;
    assert_eq!(env.handle.claim_candidates().len(), 2);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    wait_cancel_handle(&env.cancel_tokens, peer, WAIT)
        .await
        .request_hard_cancellation()
        .await;
    assert_eq!(
        env.handle
            .wait_completion(peer, WAIT)
            .await
            .unwrap()
            .exit_code,
        137
    );
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn peer_consumer_without_a_local_home_backend_claims_and_starts_ordinarily() {
    let (config, env) = mock_run_config(test_profiles(), 2, 8192, 1);
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let run_id = RunId::new_v4();
    let key = "thread:no-local-home-backend";
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, RunId::new_v4()))
        .unwrap();
    assert_eq!(
        env.handle
            .wait_completion(run_id, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(env.handle.claim_candidates().len(), 1);
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn home_published_before_claim_response_is_consumed_without_a_lost_wakeup() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let (mut config, env) = mock_run_config_with_overrides(profiles, 2, 8192, 1, overrides.clone());
    let (cache, paths) = enable_cache(&mut config);
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let run_id = RunId::new_v4();
    let key = "thread:publication-during-claim";
    let source = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
    env.handle.block_claim(run_id);
    env.handle
        .discover_tx
        .send(source_home_candidate(run_id, key, source))
        .unwrap();
    assert!(env.handle.wait_run_claim_in_flight(run_id, WAIT).await);
    seed_home_cache_state_for_run(&cache, &paths, key, "vm0/default", 1024 * 1024, source).await;
    env.handle.unblock_claim(run_id);
    execution.wait_entered(1, WAIT).await.unwrap();
    assert!(
        overrides.create_configs()[0]
            .home_drive
            .as_ref()
            .unwrap()
            .seed_image
            .is_some()
    );
    execution.release_one();
    assert_eq!(
        env.handle
            .wait_completion(run_id, WAIT)
            .await
            .unwrap()
            .exit_code,
        0
    );
    shutdown(&env, runner).await;
}

#[tokio::test]
async fn committed_peer_homes_wake_multiple_claimed_waiters() {
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let overrides = Arc::new(MockSandboxOverrides::new());
    let execution = MockLifecycleGate::new();
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    // Five host CPUs leave four admitted guest vCPU after host reservation.
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 5, 16384, 2, overrides.clone());
    let (cache, paths) = enable_cache(&mut config);
    let budget = config.capacity.budget.clone();
    assert_eq!(budget.effective_vcpu(), 4);
    let runner = tokio::spawn(run(config));
    wait_discover_entered(&env, WAIT).await;
    let runs = [RunId::new_v4(), RunId::new_v4()];
    let keys = ["thread:peer-fanout-a", "thread:peer-fanout-b"];
    let sources = [RunId::new_v4(), RunId::new_v4()];
    for ((run_id, key), source) in runs.into_iter().zip(keys).zip(sources) {
        env.provider
            .set_claim_result(run_id, Some(context_with_reuse_key(run_id, key)));
        env.handle
            .discover_tx
            .send(source_home_candidate(run_id, key, source))
            .unwrap();
        wait_owned_home(&env, run_id).await;
    }
    assert_eq!(budget.allocated(), (4, 8192, 2));
    assert!(overrides.start_agent_process_calls().is_empty());
    for (key, source) in keys.into_iter().zip(sources) {
        seed_home_cache_state_for_run(&cache, &paths, key, "vm0/default", 1024 * 1024, source)
            .await;
    }
    execution.wait_entered(2, WAIT).await.unwrap();
    let created = overrides.create_configs();
    assert_eq!(
        created
            .iter()
            .filter(|config| config
                .home_drive
                .as_ref()
                .is_some_and(|drive| drive.seed_image.is_some()))
            .count(),
        2,
        "both claimed jobs must consume their distinct committed homes"
    );
    assert_eq!(env.handle.claim_candidates().len(), 2);
    execution.release_many(2);
    for run_id in runs {
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
