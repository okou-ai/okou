use super::*;
use crate::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageCache, HomeImageLease, HomeImageLeaseIdentity,
    HomeImageLeaseRequest,
};
use crate::idle_pool::{ParkResult, ParkedIdleCandidate};
use crate::reactor::tests::support::{
    seed_home_cache_state, seed_home_cache_state_for_run, seed_idle_pool_with_overrides,
    seed_idle_pool_with_overrides_and_source, wait_heartbeat_matching_after,
};
use runner_host::paths::RunnerPaths;
use sandbox::{HomeDriveSeedImage, SandboxId};
use sandbox_mock::{MockLifecycleGate, MockSandbox, MockSandboxFactory, MockSandboxOverrides};

const WAIT: Duration = Duration::from_secs(5);
const IMAGE_BYTES: u64 = 1024 * 1024;

#[tokio::test]
async fn preferred_dispatch_retries_after_cross_process_home_publication() {
    let execution = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 16384, 2, overrides.clone());
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let publisher = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache);
    let key = "thread:preferred-cross-process";
    let predecessor = RunId::new_v4();
    let publication = stage_home(&publisher, &paths, key, predecessor).await;

    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let cache_dir = config.paths.home.home_image_cache_dir();
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(&env._temp_dir.path().join("status.json"), "running", WAIT).await;

    let run_id = RunId::new_v4();
    let mut preferred = envelope(identity, run_id);
    preferred["executionContext"]["reuseKey"] = json!(key);
    preferred["preferredHomeCheckout"] = json!({
        "predecessorRunId": predecessor,
        "waitUntil": crate::ingress::dispatch::now_ms() + 1_000,
    });
    let body = preferred.to_string();
    let busy = client(&socket, identity, run_id, &body).await;
    assert_eq!(busy.0, 429);
    assert_eq!(busy.2["disposition"], "busy");
    assert!(env.cancel_tokens.handle(run_id).await.is_none());

    // A local predecessor alone is insufficient for a native sandbox handoff.
    let local_predecessor =
        env.active_runs
            .register(predecessor, Some(key.into()), "vm0/default".into());
    let busy = client(&socket, identity, run_id, &body).await;
    assert_eq!(busy.0, 429);
    assert_eq!(busy.2["disposition"], "busy");
    drop(local_predecessor);

    // Neither an ordinary offer nor an expired preference defers on this lock.
    for (start_count, other_key, expired) in
        [(1, "thread:ordinary", false), (2, "thread:expired", true)]
    {
        // Neither case should see a previously parked VM for this key.
        let other_publication = stage_home(&publisher, &paths, other_key, predecessor).await;
        let other_id = RunId::new_v4();
        let mut other = envelope(identity, other_id);
        other["executionContext"]["reuseKey"] = json!(other_key);
        if expired {
            other["preferredHomeCheckout"] = json!({
                "predecessorRunId": predecessor,
                "waitUntil": 0,
            });
        }
        assert_eq!(
            client(&socket, identity, other_id, &other.to_string())
                .await
                .2["disposition"],
            "accepted"
        );
        execution.wait_entered(start_count, WAIT).await.unwrap();
        execution.release_one();
        assert_eq!(
            env.handle
                .wait_completion(other_id, WAIT)
                .await
                .unwrap()
                .exit_code,
            0
        );
        wait_cancel_token_removed(&env.cancel_tokens, other_id, WAIT).await;
        drop(other_publication);
    }

    // Invalidate the receiver's directory watch before the independent publisher
    // commits. Inventory takes the checkout lock too, so its heartbeat cannot
    // establish that the successor's nonblocking checkout will acquire it.
    let moved = cache_dir.with_extension("moved");
    tokio::fs::rename(&cache_dir, &moved).await.unwrap();
    tokio::fs::rename(&moved, &cache_dir).await.unwrap();
    publish_staged_home(publication, predecessor).await;
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    execution.wait_entered(3, WAIT).await.unwrap();
    assert_eq!(
        client(&socket, identity, run_id, &body).await.2["disposition"],
        "accepted"
    );
    preferred["preferredHomeCheckout"]["predecessorRunId"] = json!(RunId::new_v4());
    assert_eq!(
        client(&socket, identity, run_id, &preferred.to_string())
            .await
            .2["disposition"],
        "conflict"
    );
    let draining_key = "thread:preferred-during-drain";
    let draining_publication = stage_home(&publisher, &paths, draining_key, predecessor).await;
    env.drain();
    wait_status_mode(&env._temp_dir.path().join("status.json"), "draining", WAIT).await;
    let draining_run = RunId::new_v4();
    let mut draining = envelope(identity, draining_run);
    draining["executionContext"]["reuseKey"] = json!(draining_key);
    draining["preferredHomeCheckout"] = json!({
        "predecessorRunId": predecessor,
        "waitUntil": crate::ingress::dispatch::now_ms() + 1_000,
    });
    assert_eq!(
        client(&socket, identity, draining_run, &draining.to_string())
            .await
            .2["disposition"],
        "rejected"
    );
    drop(draining_publication);
    execution.release_one();
    let completed = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(completed.exit_code, 0);
    let sandbox = overrides
        .create_configs()
        .into_iter()
        .find(|config| Some(config.id) == completed.sandbox_id)
        .expect("preferred run started in a fresh sandbox");
    assert!(
        sandbox
            .home_drive
            .and_then(|drive| drive.seed_image)
            .is_some()
    );
    peer.shutdown().await;
    shutdown(&env, runner).await;
}

enum Available {
    Retained,
    BlankAndHome,
    BlankAndHomeLateRetained,
    LateHome,
    UnadvertisedHomeOnBlank,
    UnadvertisedHomeOnFresh,
    DifferentPreferredHomeSource,
    DifferentPreferredHomeSourceAfterHandoff,
    ReplacedHome,
    Blank,
    Home,
    Neither,
}

#[tokio::test]
async fn supplied_fallback_reuses_retained_sandbox_before_blank_and_home() {
    assert_fallback(Available::Retained).await;
}

#[tokio::test]
async fn supplied_fallback_combines_available_blank_and_home() {
    assert_fallback(Available::BlankAndHome).await;
}

#[tokio::test]
async fn supplied_fallback_reuses_home_published_after_intake_without_an_inventory_hint() {
    assert_fallback(Available::LateHome).await;
}

#[tokio::test]
async fn supplied_blank_reuses_unadvertised_home_without_a_live_producer() {
    assert_fallback(Available::UnadvertisedHomeOnBlank).await;
}

#[tokio::test]
async fn supplied_fresh_vm_reuses_unadvertised_home_without_a_live_producer() {
    assert_fallback(Available::UnadvertisedHomeOnFresh).await;
}

#[tokio::test]
async fn supplied_expired_preference_still_requires_its_exact_home_source() {
    assert_fallback(Available::DifferentPreferredHomeSource).await;
}

#[tokio::test]
async fn supplied_preference_fences_blank_home_after_local_handoff_falls_back() {
    assert_fallback(Available::DifferentPreferredHomeSourceAfterHandoff).await;
}

#[tokio::test]
async fn supplied_fallback_keeps_selected_home_source_through_blank_activation() {
    assert_fallback(Available::ReplacedHome).await;
}

#[tokio::test]
async fn supplied_blank_keeps_its_selected_home_when_another_vm_parks_before_activation() {
    assert_fallback(Available::BlankAndHomeLateRetained).await;
}

#[tokio::test]
async fn supplied_fallback_reuses_blank_when_home_is_unavailable() {
    assert_fallback(Available::Blank).await;
}

#[tokio::test]
async fn supplied_fallback_uses_home_for_new_vm_when_no_sandbox_is_available() {
    assert_fallback(Available::Home).await;
}

#[tokio::test]
async fn supplied_fallback_creates_cold_vm_when_sandbox_and_home_are_unavailable() {
    assert_fallback(Available::Neither).await;
}

async fn assert_fallback(available: Available) {
    let without_live_producer = matches!(
        available,
        Available::UnadvertisedHomeOnBlank
            | Available::UnadvertisedHomeOnFresh
            | Available::DifferentPreferredHomeSource
    );
    let different_preferred_home_source = matches!(
        available,
        Available::DifferentPreferredHomeSource
            | Available::DifferentPreferredHomeSourceAfterHandoff
    );
    let execution = MockLifecycleGate::new();
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.set_wait_process_lifecycle_gate(execution.clone());
    let unpark = MockLifecycleGate::new();
    if matches!(available, Available::ReplacedHome) {
        overrides.set_unpark_lifecycle_gate(unpark.clone());
    }
    let mut profiles = test_profiles();
    profiles.get_mut("vm0/default").unwrap().home_disk_mb = 1;
    let rootfs_hash = profiles["vm0/default"].rootfs_hash.clone();
    let (mut config, env) =
        mock_run_config_with_overrides(profiles, 8, 16384, 2, overrides.clone());
    config.provider.provider = Arc::new(SuppliedProvider(config.provider.provider.clone(), None));
    let budget = config.capacity.budget.clone();
    let paths = RunnerPaths::new(config.paths.base_dir.clone());
    let cache = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    // An independent producer does not share receiver notifications.
    let publisher = HomeImageCache::shared(paths.clone(), &config.paths.home, &config.runner.group);
    let key = "thread:supplied-home-fallback";
    let cached_home = matches!(
        available,
        Available::Retained
            | Available::BlankAndHome
            | Available::BlankAndHomeLateRetained
            | Available::DifferentPreferredHomeSourceAfterHandoff
            | Available::ReplacedHome
            | Available::Home
    );
    // Publish real home bytes and control the finalizing producer transition
    // while the successor enters by HTTP.
    let source = if cached_home {
        seed_home_cache_state(&cache, &paths, key, "vm0/default", IMAGE_BYTES).await
    } else {
        RunId::new_v4()
    };
    Arc::get_mut(&mut config.exec_config).unwrap().home_cache = Some(cache.clone());
    let cache_dir = config.paths.home.home_image_cache_dir();
    let producer = (!without_live_producer).then(|| {
        env.active_runs
            .register(source, Some(key.into()), "vm0/default".into())
    });
    let retained = if matches!(available, Available::Retained) {
        Some(
            seed_idle_pool_with_overrides_and_source(
                &env.idle_pool,
                &budget,
                &overrides,
                key,
                "vm0/default",
                2,
                4096,
                Some(source),
            )
            .await,
        )
    } else {
        None
    };
    let blank = if matches!(
        available,
        Available::Retained
            | Available::BlankAndHome
            | Available::BlankAndHomeLateRetained
            | Available::LateHome
            | Available::UnadvertisedHomeOnBlank
            | Available::DifferentPreferredHomeSourceAfterHandoff
            | Available::ReplacedHome
            | Available::Blank
    ) {
        let id = SandboxId::new_v4();
        let candidate = ParkedIdleCandidate::blank(
            Box::new(MockSandbox::with_overrides(
                id.to_string(),
                overrides.clone(),
            )),
            Arc::new(Box::new(MockSandboxFactory::with_overrides(
                overrides.clone(),
            ))),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            id,
            "vm0/default".into(),
            rootfs_hash,
            None,
        );
        assert!(matches!(
            env.idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        Some(id)
    } else {
        None
    };
    let peer = super::super::startup::configure_public_ingress(&mut config).await;
    let identity = config.runner.identity;
    let socket = config
        .paths
        .home
        .ingress_dir()
        .join(format!("{}.sock", identity.runner_id()));
    let runner = tokio::spawn(run(config));
    peer.wait_connected().await;
    peer.allow_health();
    wait_status_mode(&env._temp_dir.path().join("status.json"), "running", WAIT).await;
    if without_live_producer {
        // Publication remains on disk after its producer exits and the
        // receiver's advisory watcher loses its directory.
        let moved = cache_dir.with_extension("moved");
        tokio::fs::rename(&cache_dir, &moved).await.unwrap();
        tokio::fs::rename(&moved, &cache_dir).await.unwrap();
        seed_home_cache_state_for_run(&publisher, &paths, key, "vm0/default", IMAGE_BYTES, source)
            .await;
    }
    let run_id = RunId::new_v4();
    let mut body = envelope(identity, run_id);
    body["executionContext"]["reuseKey"] = json!(key);
    body["executionContext"]["sessionContinuation"] = json!({
        "continueNative": true, "expectedSourceRunId": source, "recoveryPrompt": null
    });
    if different_preferred_home_source {
        body["preferredHomeCheckout"] = json!({
            "predecessorRunId": RunId::new_v4(),
            "waitUntil": 0,
        });
    }
    assert_eq!(
        client(&socket, identity, run_id, &body.to_string()).await.2["disposition"],
        "accepted"
    );
    if !without_live_producer {
        env.start_observer
            .wait_finalizing_handoff_requested(source, run_id, WAIT)
            .await;
    }
    if matches!(available, Available::LateHome) {
        // Publish on disk after the advisory watcher loses its directory.
        let moved = cache_dir.with_extension("moved");
        tokio::fs::rename(&cache_dir, &moved).await.unwrap();
        tokio::fs::rename(&moved, &cache_dir).await.unwrap();
        seed_home_cache_state_for_run(&cache, &paths, key, "vm0/default", IMAGE_BYTES, source)
            .await;
    }
    let transfer_guard = if matches!(available, Available::BlankAndHomeLateRetained) {
        Some(
            env.cancel_tokens
                .handle(run_id)
                .await
                .unwrap()
                .transfer_guard()
                .await,
        )
    } else {
        None
    };
    let mut inventory_changes = env.idle_pool.lock().await.subscribe_changes();
    if let Some(producer) = &producer {
        assert!(producer.reuse_publisher().publish_no_exact_sandbox());
    }
    if transfer_guard.is_some() {
        // The finalizing task reserves the blank before acquiring this transfer
        // guard. Observe that ownership transition, then publish competing reuse.
        tokio::time::timeout(WAIT, async {
            loop {
                if env.idle_pool.lock().await.is_empty() {
                    break;
                }
                inventory_changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        seed_idle_pool_with_overrides(
            &env.idle_pool,
            &budget,
            &overrides,
            key,
            "vm0/default",
            2,
            4096,
        )
        .await;
    }
    drop(transfer_guard);
    if matches!(available, Available::ReplacedHome) {
        unpark.wait_entered(1, WAIT).await.unwrap();
        let before = env.handle.heartbeat_count();
        publish_replacement_home(&cache, &paths, key).await;
        // The sentinel heartbeat is a causal barrier after cache replacement
        // has refreshed inventory, without relying on elapsed time.
        let sentinel = "thread:source-binding-refresh-barrier";
        let sentinel_source =
            seed_home_cache_state(&cache, &paths, sentinel, "vm0/default", IMAGE_BYTES).await;
        assert!(
            wait_heartbeat_matching_after(&env.handle, before, WAIT, |heartbeat| {
                heartbeat.held_home_states.iter().any(|state| {
                    state.reuse_key == sentinel
                        && state
                            .home_caches
                            .iter()
                            .any(|home| home.source_run_id == sentinel_source)
                })
            })
            .await,
            "inventory must observe publication before blank activation resumes"
        );
        // Terminal cleanup also unparks this VM after the controlled race.
        unpark.release_many(usize::MAX);
    }
    execution.wait_entered(1, WAIT).await.unwrap();
    if different_preferred_home_source {
        let other_source_unused = if blank.is_some() {
            overrides.home_drive_replacements().is_empty()
        } else {
            overrides.create_configs()[0]
                .home_drive
                .as_ref()
                .unwrap()
                .seed_image
                .is_none()
        };
        assert!(
            other_source_unused,
            "checkout must use only the preferred source even after deferral expires"
        );
    } else if matches!(available, Available::ReplacedHome) {
        assert!(
            overrides.home_drive_replacements().is_empty(),
            "a selected source must not silently accept another producer's home"
        );
    } else if (cached_home || without_live_producer || matches!(available, Available::LateHome))
        && retained.is_none()
    {
        let drive = if blank.is_some() {
            overrides.home_drive_replacements().last().cloned()
        } else {
            overrides
                .create_configs()
                .last()
                .and_then(|config| config.home_drive.clone())
        };
        // Check the selected bytes as well as VM identity; a blank with a
        // pristine home is not a successful cached-home fallback.
        let drive = drive.expect("cached home must be attached to the selected VM");
        let seed = match drive.seed_image.as_ref().unwrap() {
            HomeDriveSeedImage::Move(path) | HomeDriveSeedImage::Copy(path) => path,
        };
        assert_eq!(tokio::fs::metadata(seed).await.unwrap().len(), IMAGE_BYTES);
    }
    execution.release_one();
    let completion = env.handle.wait_completion(run_id, WAIT).await.unwrap();
    assert_eq!(completion.exit_code, 0);
    let expected = retained
        .or(blank)
        .unwrap_or_else(|| overrides.create_configs().last().unwrap().id);
    assert_eq!(
        completion.sandbox_id,
        Some(expected),
        "available VM capacity must be reused before creating a fresh VM"
    );
    drop(producer);
    peer.shutdown().await;
    shutdown(&env, runner).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, WAIT).await;
    wait_budget_count(&budget, 0, WAIT).await;
}

async fn publish_replacement_home(cache: &HomeImageCache, paths: &RunnerPaths, key: &str) {
    let source = RunId::new_v4();
    publish_staged_home(stage_home(cache, paths, key, source).await, source).await;
}

async fn stage_home(
    cache: &HomeImageCache,
    paths: &RunnerPaths,
    key: &str,
    source: RunId,
) -> HomeImageLease {
    let sandbox_id = SandboxId::new_v4();
    // Use the executor's real lease/publication path for the competing home.
    let lease = cache
        .lease_active(HomeImageLeaseRequest {
            identity: HomeImageLeaseIdentity {
                run_id: source,
                sandbox_id,
                profile_name: "vm0/default",
                rootfs_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                reuse_key: Some(key),
                working_dir: "/home/user/workspace",
                image_size_bytes: IMAGE_BYTES,
            },
            home_drive_available: true,
        })
        .await;
    let image = paths.active_home_image(&sandbox_id);
    tokio::fs::create_dir_all(image.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&image, vec![0x5a; IMAGE_BYTES as usize])
        .await
        .unwrap();
    lease
}

async fn publish_staged_home(lease: HomeImageLease, source: RunId) {
    assert!(
        lease
            .promote(
                source,
                HomeCacheTerminalStatus::Success,
                "2026-11-13T15:20:00Z".into(),
                &crate::storage_fingerprints::StorageFingerprints::default(),
            )
            .await
            .unwrap()
    );
}
